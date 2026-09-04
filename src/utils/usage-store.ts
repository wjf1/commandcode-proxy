// =============================================================================
// 会话用量历史存储（usage-history.jsonl）
// -----------------------------------------------------------------------------
// - 把每次经过网关流转的 chat 补全请求（流式/非流式）记入 JSONL 文件，
//   每行一条完整的会话记录，重启不丢（持久化追加写）。
// - 记录字段：时间戳、模型、input/output token（由上游 finish 的 totalUsage
//   回填、真实值优先）、耗时、成本（按模型官方定价估算）、状态、traceId、模式。
// - 成本口径：与 /v1/models 的 model.pricing 一致（单位 USD / 1M tokens），
//   即 cost = input/1e6 * pricing.input + output/1e6 * pricing.output。
// - 读取时按天、按模型、按总计做聚合，供面板趋势图/分布图/成本卡片使用。
// =============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getCachedModels } from './models.js';
import { logger } from './logger.js';
import { ModelPricing } from '../types/index.js';

export interface UsageRecord {
  /** ISO 时间戳 */
  timestamp: string;
  /** 模型 id（与 /v1/models 一致） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 耗时，单位毫秒 */
  timingMs: number;
  /** 成本估算，单位 USD */
  costUsd: number;
  /** 是否命中定价（无官方定价时 costUsd=0 且此标记为 false） */
  hasPricing: boolean;
  status: 'COMPLETED' | 'FAILED';
  traceId?: string;
  mode: 'chat' | 'messages';
}

const USAGE_FILE_PATH = process.env.USAGE_HISTORY_PATH
  ? path.resolve(process.env.USAGE_HISTORY_PATH)
  : path.join(os.homedir(), '.commandcode', 'usage-history.jsonl');

/** 从 /v1/models 缓存中取模型的官方定价（USD / 1M tokens）。 */
function getPricingForModel(modelId: string): ModelPricing | undefined {
  try {
    const m = getCachedModels().find(x => x.id === modelId);
    return m?.pricing;
  } catch {
    return undefined;
  }
}

/**
 * 估算单次会话成本（USD）。
 * 价格单位：USD / 1M tokens —— 与 /v1/models 的 model.pricing 一致。
 * 输入 + 输出分别计价；cacheRead/cacheWrite 暂不计入（当前无独立字段）。
 */
export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): { costUsd: number; hasPricing: boolean } {
  const pricing = getPricingForModel(modelId);
  if (!pricing || (pricing.input === undefined && pricing.output === undefined)) {
    return { costUsd: 0, hasPricing: false };
  }
  const inCost = (pricing.input ?? 0) * (inputTokens / 1_000_000);
  const outCost = (pricing.output ?? 0) * (outputTokens / 1_000_000);
  return { costUsd: inCost + outCost, hasPricing: true };
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
  costUsd: number;
  runs: number;
}

interface ModelBucket {
  model: string;
  inputTokens: number;
  outputTokens: number;
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
  let totalCost = 0;
  let totalRuns = records.length;
  let failures = 0;

  for (const r of records) {
    const dk = dayKey(r.timestamp);
    const db = byDay.get(dk) || { date: dk, inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
    db.inputTokens += r.inputTokens || 0;
    db.outputTokens += r.outputTokens || 0;
    db.costUsd += r.costUsd || 0;
    db.runs += 1;
    byDay.set(dk, db);

    const mb = byModel.get(r.model) || { model: r.model, inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
    mb.inputTokens += r.inputTokens || 0;
    mb.outputTokens += r.outputTokens || 0;
    mb.costUsd += r.costUsd || 0;
    mb.runs += 1;
    byModel.set(r.model, mb);

    totalInput += r.inputTokens || 0;
    totalOutput += r.outputTokens || 0;
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
        cost: a.cost + (r.costUsd || 0),
        runs: a.runs + 1,
      }),
      { input: 0, output: 0, cost: 0, runs: 0 }
    );

  return {
    total: { inputTokens: totalInput, outputTokens: totalOutput, costUsd: totalCost, runs: totalRuns, failures },
    today: sum(today),
    week: sum(week),
    month: sum(month),
    byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd),
  };
}
