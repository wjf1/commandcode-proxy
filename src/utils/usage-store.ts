// =============================================================================
// 会话用量历史存储（usage-history.jsonl）
// -----------------------------------------------------------------------------
// - 把每次经过网关流转的 chat 补全请求（流式/非流式）记入 JSONL 文件，
//   每行一条完整的会话记录，重启不丢（持久化追加写）。
// - 记录字段：时间戳、模型、input/output token（由上游 finish 的 totalUsage
//   回填、真实值优先）、缓存命中量、耗时、成本、状态、traceId、模式。
// - 成本口径：**优先采用上游 provider-metadata 的权威账单金额（gateway.cost）**，
//   上游未给出时才本地估算。本地估算按缓存读/写单价拆分，并按峰谷时段选档
//   （官方对部分模型设峰时价），公式：
//     noCache×input + cacheRead×cacheRead + cacheWrite×cacheWrite + output×output
//   —— 早期版本把含缓存命中的 inputTokens 整段按 input 全价计，且只用谷时价，
//   对高缓存命中（agent 场景常见 90%+）的请求会虚高约 7 倍。
// - 读取时按天、按模型、按总计做聚合，供面板趋势图/分布图/成本卡片使用。
// =============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getCachedModels } from './models.js';
import { logger } from './logger.js';
import { ModelItem, ModelPricing } from '../types/index.js';

export interface UsageRecord {
  /** ISO 时间戳 */
  timestamp: string;
  /** 模型 id（与 /v1/models 一致） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存的输入 token。旧记录缺此字段，视为 0。 */
  cacheReadTokens?: number;
  /** 写入缓存的输入 token。旧记录缺此字段，视为 0。 */
  cacheWriteTokens?: number;
  /** 耗时，单位毫秒 */
  timingMs: number;
  /** 本次请求计入的成本，单位 USD */
  costUsd: number;
  /** 成本来源：official = 上游权威金额；estimated = 本地按定价估算。 */
  costSource?: 'official' | 'estimated';
  /** 本地估算值，便于与 official 对照排查定价偏差。 */
  estimatedCostUsd?: number;
  /** 是否命中定价（无官方定价时 costUsd=0 且此标记为 false） */
  hasPricing: boolean;
  status: 'COMPLETED' | 'FAILED';
  traceId?: string;
  mode: 'chat' | 'messages';
}

const USAGE_FILE_PATH = process.env.USAGE_HISTORY_PATH
  ? path.resolve(process.env.USAGE_HISTORY_PATH)
  : path.join(os.homedir(), '.commandcode', 'usage-history.jsonl');

/** 从 /v1/models 缓存中取模型的完整条目（定价 + 峰谷分时价）。 */
function getModelForPricing(modelId: string): ModelItem | undefined {
  try {
    return getCachedModels().find(x => x.id === modelId);
  } catch {
    return undefined;
  }
}

/**
 * 判定给定时刻是否处于官方"峰时"计费窗口。
 *
 * 官方 windows 为 "01–04 & 06–10 UTC, Mon–Fri"，即 UTC 周一至周五的
 * [01,04) 与 [06,10) 两个区间（合计 7h/day，与官方 peakHoursPerDay 一致）。
 * 纯函数便于测试。
 */
export function isPeakBillingTime(at: Date = new Date()): boolean {
  const day = at.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** 按时刻选出应使用的费率档（无分时价时回落到静态定价）。 */
function selectRates(model: ModelItem | undefined, at: Date): ModelPricing | undefined {
  const tod = model?.timeOfDay;
  if (tod && (tod.peak || tod.offPeak)) {
    const chosen = isPeakBillingTime(at) ? tod.peak : tod.offPeak;
    if (chosen) return chosen;
    return tod.offPeak ?? tod.peak ?? model?.pricing;
  }
  return model?.pricing;
}

/**
 * 估算单次会话成本（USD）。
 * 价格单位：USD / 1M tokens —— 与 /v1/models 的 model.pricing 一致。
 * 输入按缓存读/写与未命中量分别计价，并按请求时刻选择峰谷费率。
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  opts?: { cacheReadTokens?: number; cacheWriteTokens?: number; at?: Date }
): { costUsd: number; hasPricing: boolean } {
  const model = getModelForPricing(modelId);
  const rates = selectRates(model, opts?.at ?? new Date());
  if (!rates || (rates.input === undefined && rates.output === undefined)) {
    return { costUsd: 0, hasPricing: false };
  }

  const cacheRead = Math.max(0, opts?.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, opts?.cacheWriteTokens ?? 0);
  // 未命中量按"总量减去缓存部分"推导，避免上游只给总量时把缓存算成全价。
  const noCache = Math.max(0, (inputTokens || 0) - cacheRead - cacheWrite);

  const inRate = rates.input ?? 0;
  const cacheReadRate = rates.cacheRead ?? inRate;
  const cacheWriteRate = rates.cacheWrite ?? inRate;

  const cost =
    (noCache / 1_000_000) * inRate +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    ((outputTokens || 0) / 1_000_000) * (rates.output ?? 0);

  return { costUsd: cost, hasPricing: true };
}

let writeQueue: Promise<void> = Promise.resolve();
let lastFlush = 0;

/** 追加一条记录到 JSONL（串行写，避免并发交错）。 */
export function recordCompletion(entry: UsageRecord): void {
  const line = JSON.stringify(entry);
  // 串行化写入：避免并发请求同时写同一行而交错。
  writeQueue = writeQueue.then(() => {
    try {
      const dir = path.dirname(USAGE_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(USAGE_FILE_PATH, line + '\n', 'utf-8');
      // 每 2s 最多 flush 一次（appendFileSync 本身立即落盘，此为保守节流说明）
      lastFlush = Date.now();
    } catch (err: any) {
      logger.warn(`[USAGE] Failed to append usage history: ${err.message}`);
    }
  });
}

/** 清空全部历史。 */
export function clearUsageHistory(): void {
  try {
    if (fs.existsSync(USAGE_FILE_PATH)) {
      fs.writeFileSync(USAGE_FILE_PATH, '', 'utf-8');
      logger.info('[USAGE] Usage history file cleared.');
    }
  } catch (err: any) {
    logger.error(`[USAGE] Error clearing usage history: ${err.message}`);
  }
}

/** 读取全部会话历史（JSONL 逐行解析，容错跳过损坏行）。 */
export function getUsageHistory(): UsageRecord[] {
  try {
    if (!fs.existsSync(USAGE_FILE_PATH)) return [];
    const raw = fs.readFileSync(USAGE_FILE_PATH, 'utf-8');
    const out: UsageRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && typeof obj.timestamp === 'string') {
          out.push(obj as UsageRecord);
        }
      } catch {
        // 跳过损坏行
      }
    }
    return out;
  } catch (err: any) {
    logger.warn(`[USAGE] Error reading usage history: ${err.message}`);
    return [];
  }
}

interface DayBucket {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  runs: number;
}

interface ModelBucket {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  runs: number;
}

/** 把时间戳归一到本地日期（YYYY-MM-DD）。 */
function dayKey(ts: string): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 汇总统计：按天趋势、按模型分布、总计、今日/本周/本月。 */
export function getUsageStats() {
  const records = getUsageHistory();
  const byDay = new Map<string, DayBucket>();
  const byModel = new Map<string, ModelBucket>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let totalRuns = records.length;
  let failures = 0;

  for (const r of records) {
    const cacheRead = r.cacheReadTokens || 0;
    const dk = dayKey(r.timestamp);
    const db = byDay.get(dk) || { date: dk, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, runs: 0 };
    db.inputTokens += r.inputTokens || 0;
    db.outputTokens += r.outputTokens || 0;
    db.cacheReadTokens += cacheRead;
    db.costUsd += r.costUsd || 0;
    db.runs += 1;
    byDay.set(dk, db);

    const mb = byModel.get(r.model) || { model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, runs: 0 };
    mb.inputTokens += r.inputTokens || 0;
    mb.outputTokens += r.outputTokens || 0;
    mb.cacheReadTokens += cacheRead;
    mb.costUsd += r.costUsd || 0;
    mb.runs += 1;
    byModel.set(r.model, mb);

    totalInput += r.inputTokens || 0;
    totalOutput += r.outputTokens || 0;
    totalCacheRead += cacheRead;
    totalCost += r.costUsd || 0;
    if (r.status === 'FAILED') failures += 1;
  }

  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const inSpan = (ts: string, from: number) => new Date(ts).getTime() >= from;

  const today = records.filter(r => inSpan(r.timestamp, dayStart.getTime()));
  const week = records.filter(r => inSpan(r.timestamp, weekStart.getTime()));
  const month = records.filter(r => inSpan(r.timestamp, monthStart.getTime()));

  const sum = (arr: UsageRecord[]) =>
    arr.reduce(
      (a, r) => ({
        input: a.input + (r.inputTokens || 0),
        output: a.output + (r.outputTokens || 0),
        cacheRead: a.cacheRead + (r.cacheReadTokens || 0),
        cost: a.cost + (r.costUsd || 0),
        runs: a.runs + 1,
      }),
      { input: 0, output: 0, cacheRead: 0, cost: 0, runs: 0 }
    );

  return {
    total: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      costUsd: totalCost,
      runs: totalRuns,
      failures,
      /** 缓存命中占输入的比例，便于一眼看出计费为何远低于"输入×输入价"。 */
      cacheHitRate: totalInput > 0 ? totalCacheRead / totalInput : 0,
    },
    today: sum(today),
    week: sum(week),
    month: sum(month),
    byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd),
  };
}
