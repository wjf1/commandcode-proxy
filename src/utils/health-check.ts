// =============================================================================
// 通道健康检查（纯旁路观察，绝不拦截/熔断/影响任何请求路径）
// -----------------------------------------------------------------------------
// 产品决策：默认开启但**仅告警**——连续失败只打日志，不改变任何 API 的行为、
// 不参与重试/路由决策。这样"上游昨晚就挂了"能在第一时间从日志看到，而探活
// 本身的故障（误报、超时、URL 配错）最坏也只是多一条日志。
//
// 探活目标：loadConfig().ccApiBase（上游 API 根路径）。代码中已知的上游端点
// （/alpha/whoami、/alpha/billing/credits 等）全部需要 Authorization，无凭据
// 探活只会稳定得到 401——没有把握时最诚实的探法就是 GET base 路径本身：
// 只要 HTTP 栈有响应（含 404/401 这类 4xx）就说明服务活着；5xx 与网络层
// 失败（超时/DNS/拒连）才记为不健康。
//
// 主入口 index.ts 需调用 startHealthChecks()（无返回值消费方，定时器已 unref，
// 不阻止进程自然退出；startHealthChecks({ intervalMs: 0 }) 或
// HEALTH_CHECK_INTERVAL_MS=0 可整体关闭）。
// =============================================================================
import { loadConfig, assertSafeUpstreamUrl, getActiveApiKey } from './config.js';
import { logger } from './logger.js';

/** 内存最多保留的最近探活样本数（默认 5 分钟间隔 ≈ 5 小时窗口）。 */
const MAX_SAMPLES = 60;
/** 连续失败达到该次数才开始告警（单次网络抖动不值得刷 warn）。 */
const WARN_AFTER_CONSECUTIVE_FAILURES = 2;
/** 协议形态探针单次请求超时（毫秒），可用 PROTOCOL_CHECK_TIMEOUT_MS 覆盖。 */
const PROTOCOL_CHECK_TIMEOUT_MS = 15_000;

export interface HealthProbeResult {
  /** 探活时刻（ISO） */
  at: string;
  ok: boolean;
  /** 本轮探活耗时（毫秒，从发起 fetch 前起算） */
  durationMs: number;
  /** HTTP 状态码；网络层失败（超时/DNS/拒连）时缺省 */
  status?: number;
  /** 失败原因摘要（日志展示用） */
  error?: string;
}

export interface ChannelHealth {
  lastResult: HealthProbeResult | null;
  consecutiveFailures: number;
  /** 最近样本中探活成功的比例（0-100，一位小数；无样本时为 100）。 */
  uptimePercent: number;
  /** 协议形态探针（/alpha/whoami）最近一次结果；未执行时为 skipped。 */
  protocolCheck: ProtocolCheckState;
}

// ─── 协议形态探针（/alpha/whoami，带凭据）────────────────────────────────────
// 与上面的无凭据 HTTP 探活互补：根路径探活只能证明"HTTP 栈活着"（401 也算存活），
// 证明不了"协议还是我们认识的协议、凭据还有效"。probeProtocol 用活动凭据 GET
// /alpha/whoami，把结果分成四类：ok / protocol-changed / credential-invalid /
// unreachable。依然是纯旁路：失败不重试、只记录与日志，绝不影响请求路径。

/** 协议探针的判定结论。 */
export type ProtocolCheckKind = 'ok' | 'protocol-changed' | 'credential-invalid' | 'unreachable';

/** 协议探针的一次执行结果（keySuffix 只存尾 4 位，绝不存全量密钥）。 */
export interface ProtocolProbeResult {
  /** 判别字段：已执行的结果恒为 false（与 ProtocolProbeSkipped 组成可窄化 union）。 */
  skipped: false;
  ok: boolean;
  /** 探测时刻（ISO） */
  checkedAt: string;
  kind: ProtocolCheckKind;
  /** 活动凭据尾 4 位（与 audit-log.ts 的掩码惯例一致） */
  keySuffix?: string;
  /** HTTP 状态码（网络层失败 / URL 不安全时缺省） */
  status?: number;
  /** 失败原因摘要（日志/面板展示用） */
  error?: string;
}

/** 未执行状态：无活动凭据（no-key）或进程启动后尚未到首次探测（pending）。 */
export interface ProtocolProbeSkipped {
  skipped: true;
  reason: 'no-key' | 'pending';
}

export type ProtocolCheckState = ProtocolProbeResult | ProtocolProbeSkipped;

const samples: HealthProbeResult[] = [];
let consecutiveFailures = 0;
/** 是否已处于"告警中"的不健康状态（用于恢复时只 info 一次）。 */
let wasUnhealthy = false;
/** 协议探针最近一次结果（内存态；getChannelHealth 带出，前端/告警消费）。 */
let lastProtocolCheck: ProtocolCheckState = { skipped: true, reason: 'pending' };

/** 测试用：清空全部内存状态。 */
export function resetHealthState(): void {
  samples.length = 0;
  consecutiveFailures = 0;
  wasUnhealthy = false;
  lastProtocolCheck = { skipped: true, reason: 'pending' };
}

/** 读取非负整数 env；未设置/非法回退默认值。 */
function readEnvInt(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 聚合当前通道健康状态（只读，供面板/调试/webhook 告警用）。 */
export function getChannelHealth(): ChannelHealth {
  const okCount = samples.filter(s => s.ok).length;
  const uptimePercent = samples.length === 0
    ? 100
    : Math.round((okCount / samples.length) * 1000) / 10;
  return {
    lastResult: samples.length > 0 ? samples[samples.length - 1] : null,
    consecutiveFailures,
    uptimePercent,
    protocolCheck: lastProtocolCheck,
  };
}

/** 记录一轮结果并维护告警/恢复日志（所有日志都是旁路，不反馈到请求路径）。 */
function record(result: HealthProbeResult): void {
  samples.push(result);
  if (samples.length > MAX_SAMPLES) samples.shift();

  if (result.ok) {
    consecutiveFailures = 0;
    if (wasUnhealthy) {
      wasUnhealthy = false;
      logger.info(`[HEALTH] 通道已恢复：HTTP ${result.status ?? '-'}（${result.durationMs}ms）`);
    }
    return;
  }

  consecutiveFailures += 1;
  if (consecutiveFailures >= WARN_AFTER_CONSECUTIVE_FAILURES) {
    wasUnhealthy = true;
    logger.warn(
      `[HEALTH] 上游探活连续失败 ${consecutiveFailures} 次` +
      `${result.status !== undefined ? `（HTTP ${result.status}）` : ''}：${result.error ?? 'unknown'}` +
      ' —— 仅告警，不影响请求路径',
    );
  }
}

/**
 * 执行一次探活。任何失败都只会被记录，绝不抛出（旁路安全）。
 *
 * env（HEALTH_CHECK_TIMEOUT_MS）与 loadConfig() 均在每次执行时读取而非模块
 * 加载时固化，方便测试与运行期热变更。
 */
export async function probeOnce(): Promise<HealthProbeResult> {
  const timeoutMs = readEnvInt('HEALTH_CHECK_TIMEOUT_MS', 15_000);

  // 与数据面同一条 fail-closed 规则：URL 不安全时不发请求，直接记为不健康。
  let url: URL;
  try {
    url = assertSafeUpstreamUrl(loadConfig().ccApiBase);
  } catch (err: any) {
    const result: HealthProbeResult = {
      at: new Date().toISOString(),
      ok: false,
      durationMs: 0,
      error: `unsafe upstream URL: ${err?.message || err}`,
    };
    record(result);
    return result;
  }

  const started = Date.now();
  try {
    // redirect:'manual'：探活不跟随重定向（与数据面 Wave 3 规则一致），
    // 3xx 说明 HTTP 栈有响应，按"存活"计入。
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' } as RequestInit);
    // 4xx（404/401 等）也算通道存活：无凭据探活，重要的是服务在响应而非路径存在。
    const ok = res.status < 500;
    const result: HealthProbeResult = {
      at: new Date().toISOString(),
      ok,
      durationMs: Date.now() - started,
      status: res.status,
      error: ok ? undefined : `HTTP ${res.status}`,
    };
    record(result);
    return result;
  } catch (err: any) {
    const result: HealthProbeResult = {
      at: new Date().toISOString(),
      ok: false,
      durationMs: Date.now() - started,
      error: err?.message || String(err),
    };
    record(result);
    return result;
  }
}

/**
 * 启动周期探活定时器。
 *
 * 间隔取 opts.intervalMs，否则读 env HEALTH_CHECK_INTERVAL_MS（默认 300000 =
 * 5 分钟；设 0 表示不启动，返回 null）。定时器已 unref，不阻止进程退出。
 *
 * 主入口 index.ts 需调用 startHealthChecks()。
 */
export function startHealthChecks(opts?: { intervalMs?: number }): NodeJS.Timeout | null {
  const intervalMs = opts?.intervalMs ?? readEnvInt('HEALTH_CHECK_INTERVAL_MS', 300_000);
  if (!(intervalMs > 0)) return null;
  const timer = setInterval(() => {
    // probeOnce 自身绝不抛错；这里再兜一层，保证定时器永不中断。
    probeOnce().catch(err => logger.warn(`[HEALTH] probe dispatch failed: ${err?.message || err}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * 执行一次协议形态探针（带凭据 GET /alpha/whoami）。任何失败都只会被记录，
 * 绝不抛出（旁路安全）；失败不重试，等下一个周期。
 *
 * 判定依据（读码自 src/utils/config.ts 对 whoami 响应的实际消费）：
 *   - fetchLiveUsageStats 取 `whoami?.org?.id || whoami?.data?.org?.id`
 *     —— 响应存在顶层与 `data` 包装两种形态的先例；
 *   - loginNewAccount / enrichDefaultAccountName 取 `stats.whoami?.user`，
 *     消费 `user.id / user.name / user.userName / user.email`。
 * 因此"结构符合预期"= user 对象存在（顶层或 data 包装）且上述字段任一非空。
 *
 * 状态映射：401 → credential-invalid（凭据失效，不是上游故障）；2xx 且结构
 * 符合 → ok；2xx 但结构不符（含 JSON 解析失败）→ protocol-changed（上游协议
 * 变更信号）；其余（5xx / 3xx 不跟随 / 其他 4xx / 网络层失败）→ unreachable。
 *
 * env（PROTOCOL_CHECK_TIMEOUT_MS）与 loadConfig()/getActiveApiKey() 均在每次
 * 执行时读取而非模块加载时固化，方便测试与运行期热变更。
 */
export async function probeProtocol(opts?: { apiKey?: string | null }): Promise<ProtocolCheckState> {
  const apiKey = opts && 'apiKey' in opts ? opts.apiKey : getActiveApiKey();
  if (!apiKey) {
    lastProtocolCheck = { skipped: true, reason: 'no-key' };
    return lastProtocolCheck;
  }

  const timeoutMs = readEnvInt('PROTOCOL_CHECK_TIMEOUT_MS', PROTOCOL_CHECK_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  const keySuffix = apiKey.slice(-4);

  // 与 probeOnce 同一条 fail-closed 规则：URL 不安全时不发请求（含凭据请求
  // 也不发给未过 allowlist 的目标）。DNS rebinding 防护未在此重复——探针与
  // probeOnce 同级旁路，URL 级校验（私网/协议/allowlist）已覆盖其主要面。
  let base: string;
  let ccVersion: string;
  try {
    const cfg = loadConfig();
    base = String(assertSafeUpstreamUrl(cfg.ccApiBase)).replace(/\/+$/, '');
    ccVersion = cfg.ccVersion;
  } catch (err: any) {
    lastProtocolCheck = {
      skipped: false,
      ok: false,
      checkedAt,
      kind: 'unreachable',
      keySuffix,
      error: `unsafe upstream URL: ${err?.message || err}`,
    };
    return lastProtocolCheck;
  }

  try {
    // 请求头照 config.ts fetchLiveUsageStats 的既有惯例拼装（cli UA + 版本头）。
    const res = await fetch(`${base}/alpha/whoami`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'cli',
        'x-cli-environment': 'cli',
        'x-command-code-version': ccVersion,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    } as RequestInit);

    if (res.status === 401) {
      lastProtocolCheck = {
        skipped: false,
        ok: false,
        checkedAt,
        kind: 'credential-invalid',
        keySuffix,
        status: res.status,
        error: 'HTTP 401',
      };
    } else if (res.status >= 200 && res.status < 300) {
      let shapeOk = false;
      try {
        const body: any = await res.json();
        const user = body?.user ?? body?.data?.user;
        shapeOk = !!user && [user.id, user.name, user.userName, user.email]
          .some(v => v !== undefined && v !== null && v !== '');
      } catch {
        shapeOk = false;
      }
      lastProtocolCheck = shapeOk
        ? { skipped: false, ok: true, checkedAt, kind: 'ok', keySuffix, status: res.status }
        : { skipped: false, ok: false, checkedAt, kind: 'protocol-changed', keySuffix, status: res.status, error: 'unexpected /alpha/whoami shape' };
    } else {
      lastProtocolCheck = {
        skipped: false,
        ok: false,
        checkedAt,
        kind: 'unreachable',
        keySuffix,
        status: res.status,
        error: `HTTP ${res.status}`,
      };
    }
  } catch (err: any) {
    lastProtocolCheck = {
      skipped: false,
      ok: false,
      checkedAt,
      kind: 'unreachable',
      keySuffix,
      error: err?.message || String(err),
    };
  }

  // 仅告警：kind 非 ok 时打一条 warn（不重试、不影响请求路径），恢复不额外 info。
  const r = lastProtocolCheck;
  if (!r.skipped && !r.ok) {
    logger.warn(
      `[HEALTH][PROTOCOL] 协议探针异常（kind=${r.kind}${r.status !== undefined ? ` HTTP ${r.status}` : ''}）：${r.error ?? 'unknown'}` +
      ' —— 仅告警，不影响请求路径',
    );
  }
  return lastProtocolCheck;
}

/**
 * 启动周期协议探针定时器（与 startHealthChecks 相互独立的 interval，互不影响
 * 各自的间隔与测试断言）。
 *
 * 间隔取 opts.intervalMs，否则读 env PROTOCOL_CHECK_INTERVAL_MS（默认 600000 =
 * 10 分钟；设 0 表示不启动，返回 null）。无活动凭据时定时器照常运转——每轮
 * probeProtocol 读一次 getActiveApiKey，账号热配置后下一轮自动生效。定时器已
 * unref，不阻止进程退出。
 *
 * 主入口 index.ts 需调用 startProtocolChecks()。
 */
export function startProtocolChecks(opts?: { intervalMs?: number }): NodeJS.Timeout | null {
  const intervalMs = opts?.intervalMs ?? readEnvInt('PROTOCOL_CHECK_INTERVAL_MS', 600_000);
  if (!(intervalMs > 0)) return null;
  const timer = setInterval(() => {
    // probeProtocol 自身绝不抛错；这里再兜一层，保证定时器永不中断。
    probeProtocol().catch(err => logger.warn(`[HEALTH] protocol probe dispatch failed: ${err?.message || err}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
