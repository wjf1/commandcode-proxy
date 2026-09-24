// =============================================================================
// Webhook 告警（纯旁路通知，失败不重试、绝不影响请求路径）
// -----------------------------------------------------------------------------
// 定时把 usage-store 的当日统计与两类阈值比对，超阈值时向用户自配的
// WEBHOOK_URL POST 一条 JSON（飞书/钉钉/Slack 群机器人等均可接）：
//   a) 当日累计成本 ≥ WEBHOOK_COST_USD（event: daily-cost）
//   b) 当日错误率 ≥ WEBHOOK_ERROR_RATE（0-1；FAILED 请求数 / 当日总请求数，
//      event: daily-error-rate）
// 设计约束：
//   - WEBHOOK_URL 未设置时整个功能为关闭状态（不启动、不发任何请求）；
//   - 每个阈值每自然日最多告警一次（先占坑再发送，发送失败当天也不重试）；
//   - POST fire-and-forget + WEBHOOK_TIMEOUT_MS 硬超时，任何失败只 logger.warn，
//     绝不抛错、绝不重试；
//   - WEBHOOK_URL 是用户显式配置的出站目标（第三方机器人域名不在上游
//     allowlist 内），因此只做 http(s) 协议基础校验，不走 assertSafeUpstreamUrl
//     （那会把飞书/钉钉等合法目标全部拒掉）；
//   - 错误率口径与 getUsageStats 的 today 一致（服务器本地自然日）。today 桶
//     没有 failures 字段（total.failures 是全期口径），因此按同一日期边界从
//     getUsageHistory() 自算。
//
// 主入口 index.ts 需调用 startWebhookAlerts()（定时器已 unref，不阻止进程退出；
// WEBHOOK_URL 未设置时返回 null，功能整体关闭）。
// =============================================================================
import { getUsageStats, getUsageHistory } from './usage-store.js';
import { logger } from './logger.js';

/** 当日已发标记：event -> 'YYYY-MM-DD'。 */
const sentOn = new Map<string, string>();

/** 测试用：清空当日已发标记。 */
export function resetWebhookState(): void {
  sentOn.clear();
}

/** 功能总开关：配置了 WEBHOOK_URL 才启用。 */
export function webhookEnabled(): boolean {
  return (process.env.WEBHOOK_URL || '').trim().length > 0;
}

/** 读取浮点 env；未设置/非法返回 NaN（调用方以 Number.isFinite 判断该维度是否启用）。 */
function readEnvFloat(name: string): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** 读取非负整数 env；未设置/非法回退默认值。 */
function readEnvInt(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 服务器本地自然日键（与 usage-store 的 today 口径一致：setHours(0,0,0,0)）。 */
function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 当日错误率（本地自然日口径）。总请求数为 0 时返回 0（由调用方决定是否触发，
 * 0/0 不构成"错误率高"）。
 */
export function todayErrorRate(now: Date = new Date()): { rate: number; failed: number; total: number } {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  let total = 0;
  let failed = 0;
  for (const r of getUsageHistory()) {
    const t = new Date(r.timestamp).getTime();
    if (!Number.isFinite(t) || t < dayStart.getTime()) continue;
    total += 1;
    if (r.status === 'FAILED') failed += 1;
  }
  return { rate: total > 0 ? failed / total : 0, failed, total };
}

/**
 * 通用 Webhook 通知 API：向 WEBHOOK_URL POST 一条 JSON。
 *
 * 未配置 WEBHOOK_URL 时直接返回 false（不发任何请求）。fire-and-forget +
 * WEBHOOK_TIMEOUT_MS（默认 5000）硬超时；失败只 warn，不抛错、不重试。
 * 供未来其他模块调用（本轮仅 webhook 告警自用）。
 */
export async function notifyWebhook(event: string, payload: object): Promise<boolean> {
  const raw = (process.env.WEBHOOK_URL || '').trim();
  if (!raw) return false;
  let target: URL;
  try {
    target = new URL(raw);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error(`unsupported protocol '${target.protocol}'`);
    }
  } catch (err: any) {
    logger.warn(`[WEBHOOK] Invalid WEBHOOK_URL, notification dropped: ${err?.message || err}`);
    return false;
  }

  const body = JSON.stringify({ event, ...payload, timestamp: new Date().toISOString() });
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(readEnvInt('WEBHOOK_TIMEOUT_MS', 5000)),
    } as RequestInit);
    if (!res.ok) {
      logger.warn(`[WEBHOOK] POST ${target.host} -> HTTP ${res.status}（不重试）`);
      return false;
    }
    return true;
  } catch (err: any) {
    logger.warn(`[WEBHOOK] POST failed: ${err?.message || err}（不重试）`);
    return false;
  }
}

/** 每个事件每自然日最多发送一次：先占坑再发送，发送失败当天也不重试。 */
async function fireOncePerDay(event: string, value: number, threshold: number, summary: string): Promise<void> {
  const today = localDateKey(new Date());
  if (sentOn.get(event) === today) return;
  sentOn.set(event, today);
  logger.warn(`[WEBHOOK] ${summary} —— 已发送 ${event} 通知`);
  await notifyWebhook(event, { value, threshold, summary });
}

/**
 * 执行一轮阈值检查（定时器 tick 与手动调用共用）。
 * WEBHOOK_URL 未设置时直接返回（零网络请求）；两个阈值 env 均未设置时同样无事可做。
 */
export async function checkThresholds(now: Date = new Date()): Promise<void> {
  if (!webhookEnabled()) return;
  const costThreshold = readEnvFloat('WEBHOOK_COST_USD');
  const rateThreshold = readEnvFloat('WEBHOOK_ERROR_RATE');
  if (!Number.isFinite(costThreshold) && !Number.isFinite(rateThreshold)) return;

  try {
    if (Number.isFinite(costThreshold)) {
      const cost = Number(getUsageStats().today?.cost ?? 0);
      if (cost >= costThreshold) {
        await fireOncePerDay(
          'daily-cost',
          cost,
          costThreshold,
          `今日累计成本 $${cost.toFixed(2)} ≥ 阈值 $${costThreshold.toFixed(2)}`,
        );
      }
    }
    if (Number.isFinite(rateThreshold)) {
      const { rate, failed, total } = todayErrorRate(now);
      if (total > 0 && rate >= rateThreshold) {
        await fireOncePerDay(
          'daily-error-rate',
          rate,
          rateThreshold,
          `当日错误率 ${(rate * 100).toFixed(1)}%（${failed}/${total}）≥ 阈值 ${(rateThreshold * 100).toFixed(0)}%`,
        );
      }
    }
  } catch (err: any) {
    // 统计读取失败等一切异常都不得外泄（旁路安全）。
    logger.warn(`[WEBHOOK] Threshold check failed: ${err?.message || err}`);
  }
}

/**
 * 启动周期阈值检查定时器。
 *
 * WEBHOOK_URL 未设置 → 功能关闭，返回 null（不发任何请求、不占资源）。
 * 间隔取 opts.intervalMs，否则读 env WEBHOOK_CHECK_INTERVAL_MS（默认 600000 =
 * 10 分钟；设 0 表示不启动，返回 null）。
 *
 * 主入口 index.ts 需调用 startWebhookAlerts()。
 */
export function startWebhookAlerts(opts?: { intervalMs?: number }): NodeJS.Timeout | null {
  if (!webhookEnabled()) {
    logger.info('[WEBHOOK] WEBHOOK_URL 未配置，Webhook 告警未启动');
    return null;
  }
  const intervalMs = opts?.intervalMs ?? readEnvInt('WEBHOOK_CHECK_INTERVAL_MS', 600_000);
  if (!(intervalMs > 0)) return null;
  const timer = setInterval(() => {
    // checkThresholds 自身绝不抛错；这里再兜一层，保证定时器永不中断。
    checkThresholds().catch(err => logger.warn(`[WEBHOOK] alert dispatch failed: ${err?.message || err}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
