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

  // ── 归因字段 ──────────────────────────────────────────────────────────────
  /** 客户端声明的会话 ID（x-session-id 等）。拿不到为 undefined，不猜测。 */
  sessionId?: string;
  /** 推断出的项目路径。注意：这是**推断值**，务必结合 projectSource 判断可信度。 */
  project?: string;
  /** 项目归属的置信度：label = 显式标签字段；heuristic = 频次推断。 */
  projectSource?: 'label' | 'heuristic';
  /** 会话类型（main / subagent 等）。 */
  sessionType?: string;
  /** 发起方 agent 标识。 */
  agent?: string;
  /** 客户端时区（IANA），用于按调用方本地日期分组。 */
  timezone?: string;
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
 * 缓存命中带来的节省额（USD）—— 即"这些输入若按全价计会多花多少"。
 *
 * 缓存读单价通常只有输入价的 1/50（如 deepseek-v4.1-flash 谷时
 * $0.003/M vs $0.15/M），agent 场景输入命中率常达 96%–99%，这笔差额是
 * 账单远低于"输入 × 输入价"的最主要原因，单列出来才看得出缓存的价值。
 *
 * 返回 0 表示无缓存命中或无定价数据。
 */
export function estimateCacheSavingsUsd(
  modelId: string,
  cacheReadTokens: number,
  at: Date = new Date()
): number {
  if (!cacheReadTokens || cacheReadTokens <= 0) return 0;
  const model = getModelForPricing(modelId);
  const rates = selectRates(model, at);
  if (!rates || rates.input === undefined) return 0;
  const inRate = rates.input;
  const cacheReadRate = rates.cacheRead ?? inRate;
  // 缓存单价高于输入价（理论上不该出现）时不报"负节省"。
  const delta = inRate - cacheReadRate;
  if (delta <= 0) return 0;
  return (cacheReadTokens / 1_000_000) * delta;
}

/**
 * 官方峰谷计费窗口：UTC 周一至周五 01–04 与 06–10（合计 7h/day），
 * 其余时段（含周末全天）为谷时。
 */
export interface BillingWindow {
  /** 当前是否处于峰时。 */
  isPeak: boolean;
  /** 下一次费率切换的时刻（ISO）；已到边界或无分时价模型时为 null。 */
  nextChangeAt: string | null;
  /** 切换后是否进入峰时。 */
  nextIsPeak: boolean | null;
  /** 距离下次切换的分钟数。 */
  minutesUntilChange: number | null;
  /** 官方对窗口的描述文案。 */
  windows?: string;
  /** 峰时窗口每天的小时数。 */
  peakHoursPerDay?: number;
}

/**
 * 描述给定时刻的峰谷状态与下一次切换点。
 *
 * 仅对含分时价的模型有意义；无分时价模型返回窗口描述为空、isPeak=false。
 * 切换点通过枚举官方边界的候选时刻（UTC 01/04/06/10 点）求得，因此周末
 * 与工作日交界也能正确跨越（如周五 10:00 之后一直谷时到下周一 01:00）。
 */
export function describeBillingWindow(at: Date = new Date()): BillingWindow {
  const todModels = (() => {
    try {
      return getCachedModels().filter(m => m.timeOfDay && (m.timeOfDay.peak || m.timeOfDay.offPeak));
    } catch {
      return [];
    }
  })();

  const sample = todModels.find(m => m.timeOfDay?.windows)?.timeOfDay;
  const isPeak = isPeakBillingTime(at);

  if (todModels.length === 0) {
    return { isPeak: false, nextChangeAt: null, nextIsPeak: null, minutesUntilChange: null };
  }

  // 边界小时（UTC）：谷→峰在 01 与 06，峰→谷在 04 与 10。
  const boundaries = [1, 4, 6, 10];
  let best: Date | null = null;
  for (let dayOffset = 0; dayOffset <= 3 && !best; dayOffset++) {
    for (const hour of boundaries) {
      const candidate = new Date(at);
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      candidate.setUTCHours(hour, 0, 0, 0);
      if (candidate.getTime() <= at.getTime()) continue;
      if (isPeakBillingTime(candidate) !== isPeak) {
        best = candidate;
        break;
      }
    }
  }

  return {
    isPeak,
    nextChangeAt: best ? best.toISOString() : null,
    nextIsPeak: best ? isPeakBillingTime(best) : null,
    minutesUntilChange: best ? Math.round((best.getTime() - at.getTime()) / 60000) : null,
    windows: sample?.windows,
    peakHoursPerDay: sample?.peakHoursPerDay,
  };
}

/** 含峰谷分时价的模型及其当前生效费率（供面板展示"现在按哪档计费"）。 */
export function getTimeOfDayModels(at: Date = new Date()) {
  try {
    return getCachedModels()
      .filter(m => m.timeOfDay && (m.timeOfDay.peak || m.timeOfDay.offPeak))
      .map(m => {
        const rates = selectRates(m, at);
        return {
          id: m.id,
          name: m.name,
          activeRates: rates,
          peak: m.timeOfDay!.peak,
          offPeak: m.timeOfDay!.offPeak,
        };
      });
  } catch {
    return [];
  }
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

/**
 * 历史文件大小上限（字节）。默认 20MB，可用环境变量 USAGE_HISTORY_MAX_MB 调整。
 * 只追加不轮转的话，文件会随使用无限增长，而 /api/usage/history 每次都全量
 * 读取 + 聚合，几十万行后仪表盘会明显变慢。
 */
const USAGE_MAX_BYTES = (() => {
  const mb = parseInt(process.env.USAGE_HISTORY_MAX_MB || '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 20 * 1024 * 1024;
})();

/** 超限时保留文件后半（从中点后的第一条完整行起），整写替换。 */
function rotateUsageFile(): void {
  try {
    if (!fs.existsSync(USAGE_FILE_PATH)) return;
    const size = fs.statSync(USAGE_FILE_PATH).size;
    if (size < USAGE_MAX_BYTES) return;
    const raw = fs.readFileSync(USAGE_FILE_PATH, 'utf-8');
    const nl = raw.indexOf('\n', Math.floor(raw.length / 2));
    const kept = nl >= 0 ? raw.slice(nl + 1) : raw;
    const tmp = `${USAGE_FILE_PATH}.tmp`;
    fs.writeFileSync(tmp, kept, 'utf-8');
    fs.renameSync(tmp, USAGE_FILE_PATH);
    logger.info(`[USAGE] Rotated usage history: ${(size / 1048576).toFixed(1)}MB -> ${(kept.length / 1048576).toFixed(1)}MB`);
  } catch (err: any) {
    logger.warn(`[USAGE] History rotation failed: ${err.message}`);
  }
}

let lastRotationCheck = 0;

/** 追加一条记录到 JSONL（串行写，避免并发交错）；周期性检查是否需要轮转。 */
export function recordCompletion(entry: UsageRecord): void {
  const line = JSON.stringify(entry);
  const now = Date.now();
  const shouldCheckRotation = now - lastRotationCheck > 60_000;
  if (shouldCheckRotation) lastRotationCheck = now;
  // 串行化写入：避免并发请求同时写同一行而交错。
  writeQueue = writeQueue.then(() => {
    try {
      if (shouldCheckRotation) rotateUsageFile();
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
  savingsUsd: number;
  runs: number;
}

interface ModelBucket {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  savingsUsd: number;
  runs: number;
}

/** 项目聚合桶。project 为 null 表示归属"未识别"。 */
/**
 * 端到端吞吐（tok/s）= 输出 token / 耗时秒。
 *
 * **口径注意**：timingMs 覆盖整个请求生命周期（上游排队、重试、网络往返），
 * 因此这是"端到端吞吐"，**不等于**模型生成速度 —— 用它评估模型快慢会失真，
 * 但用于"这条请求体感多久出完"是准确的。无输出或无耗时时返回 null。
 */
export function throughputTokS(outputTokens: number, timingMs: number): number | null {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
  if (!Number.isFinite(timingMs) || timingMs <= 0) return null;
  return outputTokens / (timingMs / 1000);
}

/** 线性插值百分位。输入须已升序排序；空数组返回 null。 */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

interface ModelPerf {
  samples: number;
  /** 端到端吞吐 tok/s：均值与中位数。 */
  tokSAvg: number | null;
  tokSP50: number | null;
  tokSP95: number | null;
  /** 端到端耗时（毫秒）P50 / P95。 */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

/** 由一批记录算吞吐/延迟分布（只计 COMPLETED 且有输出的请求）。 */
function perfOf(records: UsageRecord[]): ModelPerf {
  const tok: number[] = [];
  const lat: number[] = [];
  for (const r of records) {
    if (r.status !== 'COMPLETED') continue;
    const t = throughputTokS(r.outputTokens, r.timingMs);
    if (t !== null) tok.push(t);
    if (Number.isFinite(r.timingMs) && r.timingMs > 0) lat.push(r.timingMs);
  }
  tok.sort((a, b) => a - b);
  lat.sort((a, b) => a - b);
  const avg = tok.length ? tok.reduce((s, x) => s + x, 0) / tok.length : null;
  return {
    samples: tok.length,
    tokSAvg: avg === null ? null : Math.round(avg * 10) / 10,
    tokSP50: percentile(tok, 0.5) === null ? null : Math.round(percentile(tok, 0.5)! * 10) / 10,
    tokSP95: percentile(tok, 0.95) === null ? null : Math.round(percentile(tok, 0.95)! * 10) / 10,
    latencyP50Ms: percentile(lat, 0.5) === null ? null : Math.round(percentile(lat, 0.5)!),
    latencyP95Ms: percentile(lat, 0.95) === null ? null : Math.round(percentile(lat, 0.95)!),
  };
}

interface ProjectBucket {
  project: string | null;
  /** 该项目下出现过的置信度来源，label 优先展示。 */
  sources: Set<'label' | 'heuristic'>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  savingsUsd: number;
  runs: number;
  sessions: Set<string>;
  lastAt: string;
}

/** 会话聚合桶。会话 ID 为客户端声明值，属事实性标识。 */
interface SessionBucket {
  sessionId: string;
  project: string | null;
  projectSource: 'label' | 'heuristic' | null;
  sessionType: string | null;
  agent: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  savingsUsd: number;
  runs: number;
  firstAt: string;
  lastAt: string;
  models: Set<string>;
}

/**
 * 把时间戳归一到指定时区的日期（YYYY-MM-DD）。
 *
 * 此前用服务器本地时区，跨时区调用方会看到日期错位（例如 UTC+8 用户在
 * 本地 00:30 的请求会被归到前一天）。记录里带了客户端时区就按其计算。
 */
function dayKey(ts: string, timeZone?: string | null): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
  if (timeZone) {
    try {
      // en-CA 的 toLocaleDateString 输出恰为 YYYY-MM-DD
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch { /* 时区非法则回落到服务器本地 */ }
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 汇总统计：按天趋势、按模型/项目/会话分布、总计、今日/本周/本月。 */
export function getUsageStats() {
  const records = getUsageHistory();
  const byDay = new Map<string, DayBucket>();
  const byModel = new Map<string, ModelBucket>();
  const byProject = new Map<string, ProjectBucket>();
  const bySession = new Map<string, SessionBucket>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let totalSavings = 0;
  let totalRuns = records.length;
  let failures = 0;

  for (const r of records) {
    const cacheRead = r.cacheReadTokens || 0;
    // 节省额按该条记录**自身发生时刻**的费率算 —— 峰谷价不同，用当前时刻
    // 会算错历史记录。
    const savings = estimateCacheSavingsUsd(r.model, cacheRead, new Date(r.timestamp));
    const dk = dayKey(r.timestamp, r.timezone);
    const db = byDay.get(dk) || { date: dk, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, savingsUsd: 0, runs: 0 };
    db.inputTokens += r.inputTokens || 0;
    db.outputTokens += r.outputTokens || 0;
    db.cacheReadTokens += cacheRead;
    db.costUsd += r.costUsd || 0;
    db.savingsUsd += savings;
    db.runs += 1;
    byDay.set(dk, db);

    const mb = byModel.get(r.model) || { model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, savingsUsd: 0, runs: 0 };
    mb.inputTokens += r.inputTokens || 0;
    mb.outputTokens += r.outputTokens || 0;
    mb.cacheReadTokens += cacheRead;
    mb.costUsd += r.costUsd || 0;
    mb.savingsUsd += savings;
    mb.runs += 1;
    byModel.set(r.model, mb);

    // 项目维度：未识别（null）也单独成组，避免被静默丢弃。
    const pKey = r.project || '\u0000unattributed';
    const pb = byProject.get(pKey) || {
      project: r.project ?? null, sources: new Set<'label' | 'heuristic'>(),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, savingsUsd: 0,
      runs: 0, sessions: new Set<string>(), lastAt: r.timestamp,
    };
    if (r.projectSource) pb.sources.add(r.projectSource);
    pb.inputTokens += r.inputTokens || 0;
    pb.outputTokens += r.outputTokens || 0;
    pb.cacheReadTokens += cacheRead;
    pb.costUsd += r.costUsd || 0;
    pb.savingsUsd += savings;
    pb.runs += 1;
    if (r.sessionId) pb.sessions.add(r.sessionId);
    if (r.timestamp > pb.lastAt) pb.lastAt = r.timestamp;
    byProject.set(pKey, pb);

    // 会话维度：仅统计有会话 ID 的记录（客户端声明值，不做猜测填充）。
    if (r.sessionId) {
      const sb = bySession.get(r.sessionId) || {
        sessionId: r.sessionId, project: r.project ?? null,
        projectSource: r.projectSource ?? null, sessionType: r.sessionType ?? null,
        agent: r.agent ?? null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        costUsd: 0, savingsUsd: 0, runs: 0, firstAt: r.timestamp, lastAt: r.timestamp,
        models: new Set<string>(),
      };
      // 同一会话若跨了不同推断结果，保留首次的非空值，避免抖动。
      if (!sb.project && r.project) { sb.project = r.project; sb.projectSource = r.projectSource ?? null; }
      sb.inputTokens += r.inputTokens || 0;
      sb.outputTokens += r.outputTokens || 0;
      sb.cacheReadTokens += cacheRead;
      sb.costUsd += r.costUsd || 0;
      sb.savingsUsd += savings;
      sb.runs += 1;
      sb.models.add(r.model);
      if (r.timestamp < sb.firstAt) sb.firstAt = r.timestamp;
      if (r.timestamp > sb.lastAt) sb.lastAt = r.timestamp;
      bySession.set(r.sessionId, sb);
    }

    totalInput += r.inputTokens || 0;
    totalOutput += r.outputTokens || 0;
    totalCacheRead += cacheRead;
    totalCost += r.costUsd || 0;
    totalSavings += savings;
    if (r.status === 'FAILED') failures += 1;
  }

  const withSessions = records.filter(r => r.sessionId).length;
  const withProject = records.filter(r => r.project).length;
  const withLabeledProject = records.filter(r => r.projectSource === 'label').length;

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
        savings: a.savings + estimateCacheSavingsUsd(r.model, r.cacheReadTokens || 0, new Date(r.timestamp)),
        runs: a.runs + 1,
      }),
      { input: 0, output: 0, cacheRead: 0, cost: 0, savings: 0, runs: 0 }
    );

  const hitRate = totalInput > 0 ? totalCacheRead / totalInput : 0;

  return {
    total: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      costUsd: totalCost,
      /** 缓存命中相对全价输入省下的金额（USD）。 */
      savingsUsd: totalSavings,
      /** 省下的钱相当于账面成本的倍数（"白赚 N 倍"），无成本时为 0。 */
      savingsMultiple: totalCost > 0 ? totalSavings / totalCost : 0,
      runs: totalRuns,
      failures,
      /** 缓存命中占输入的比例，便于一眼看出计费为何远低于"输入×输入价"。 */
      cacheHitRate: hitRate,
    },
    today: sum(today),
    week: sum(week),
    month: sum(month),
    byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd),
    // 项目维度（推断）：costSource 意义上的 projectSource 保留在每行上，
    // 汇总时取"该项目下最强证据"，label 优先于 heuristic。
    byProject: Array.from(byProject.values())
      .map(p => ({
        project: p.project,
        projectSource: p.sources.has('label') ? ('label' as const) : p.sources.has('heuristic') ? ('heuristic' as const) : null,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheReadTokens: p.cacheReadTokens,
        costUsd: p.costUsd,
        savingsUsd: p.savingsUsd,
        runs: p.runs,
        sessionCount: p.sessions.size,
        lastAt: p.lastAt,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    // 每模型端到端吞吐与延迟分布（口径说明见 throughputTokS）。
    byModelPerf: Object.entries(
      records.reduce<Record<string, UsageRecord[]>>((acc, r) => {
        (acc[r.model] ||= []).push(r);
        return acc;
      }, {})
    )
      .map(([model, rs]) => ({ model, ...perfOf(rs) }))
      .sort((a, b) => b.samples - a.samples),
    // 会话维度（客户端声明的事实性标识）。
    bySession: Array.from(bySession.values())
      .map(s => ({ ...s, models: Array.from(s.models) }))
      .sort((a, b) => b.costUsd - a.costUsd),
    attribution: {
      /** 有会话 ID 的记录数（客户端声明值）。 */
      sessionsIdentified: withSessions,
      /** 有项目归属的记录数（含推断）。 */
      projectsIdentified: withProject,
      /** 其中来自显式标签字段（高置信）的记录数。 */
      projectsLabeled: withLabeledProject,
      totalRecords: records.length,
    },
  };
}
