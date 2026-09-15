// =============================================================================
// 上游 CC 事件 → 用量与账单采集
// -----------------------------------------------------------------------------
// 上游 /alpha/generate 的 finish 事件带回**含缓存命中**的 inputTokens，缓存明细
// 落在 inputTokenDetails.cacheReadTokens；同时 provider-metadata 事件带回网关
// **权威账单金额**（gateway.cost）。
//
// 这里把两件事收敛到一处：
//   1. 拆分出 cacheReadTokens / noCacheTokens —— 缓存读单价是输入的 1/50，
//      不拆分就会把 90%+ 的输入按全价计，导致成本虚高数倍；
//   2. 抓取 gateway.cost —— 官方已算好峰谷价与折扣，直接采用最准。
//   3. 换算成 Anthropic 规范的 usage —— 上游 inputTokens 含缓存，Anthropic 的
//      input_tokens 不含，两者口径不同（见 toAnthropicUsage）。
//
// 采集是"就高优先"：有官方 cost 用官方，没有才本地估算（见 usage-store）。
// =============================================================================
import { CCEvent, CCEventUsage } from '../../types/index.js';

export interface UsageAccumulator {
  /** 含缓存命中的输入总量。 */
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存的输入 token。 */
  cacheReadTokens: number;
  /** 写入缓存的输入 token（多数模型为 0）。 */
  cacheWriteTokens: number;
  /** 未命中缓存的输入 token。 */
  noCacheTokens: number;
  /** 上游网关给出的权威账单金额（USD）。 */
  upstreamCostUsd?: number;
  /** 是否收到过上游 usage（用于区分"真 0"与"没数据"）。 */
  sawUsage: boolean;
}

export function createUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    noCacheTokens: 0,
    sawUsage: false,
  };
}

/** 解析上游金额字符串/数字，非法值返回 undefined。 */
export function parseUsd(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 从 usage 明细中拆出缓存读/写与非缓存输入量。 */
export function splitInput(usage: CCEventUsage): { cacheRead: number; cacheWrite: number; noCache: number } {
  const details = usage.inputTokenDetails || {};
  const total = usage.inputTokens ?? 0;
  const cacheRead = details.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWrite = details.cacheWriteTokens ?? 0;
  const noCache =
    details.noCacheTokens ?? Math.max(0, total - cacheRead - cacheWrite);
  return { cacheRead, cacheWrite, noCache };
}

/**
 * 采集器 → **Anthropic 规范**的 usage 字段。
 *
 * 两边的 input 口径不同，这是必须换算而非直接透传的地方：
 *   - 上游 finish 事件的 `inputTokens` 是**含缓存命中**的输入总量（供应商按
 *     「总量 - 缓存读」计费，其余按全价），缓存明细是它的**子集**；
 *   - Anthropic 的 `input_tokens` **只算未命中缓存的输入**，总输入 =
 *     input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 *
 * 直接把上游的含缓存值写进 `input_tokens`，按规范累加的客户端（实测 ZCode）会把
 * cache_read 再加一遍：输入被记成两倍，缓存命中率随之从 ~99% 掉到 ~50%，且上下文
 * 容量被误判为两倍（提前触发压缩）。所以这里只报未命中部分，总量由三个字段相加还原。
 */
export function toAnthropicUsage(acc: UsageAccumulator): {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  const cacheRead = acc.cacheReadTokens || 0;
  const cacheWrite = acc.cacheWriteTokens || 0;
  return {
    // 上游未回 usage 时 acc.inputTokens 是本地估算、缓存明细为 0，此处原样返回。
    input_tokens: Math.max(0, acc.inputTokens - cacheRead - cacheWrite),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

/**
 * 把一个 CC 事件累加进采集器。对无关事件是 no-op，可对整条事件流逐个调用。
 *
 * 上游同一轮会同时发 finish-step 与 finish（usage 相同），后到的一方覆盖而非
 * 累加 —— 否则 token 会被计两次。
 */
export function accumulateUsage(acc: UsageAccumulator, event: CCEvent): void {
  if (!event) return;

  if (event.type === 'provider-metadata') {
    const cost = parseUsd(event.providerMetadata?.gateway?.cost);
    if (cost !== undefined) acc.upstreamCostUsd = cost;
    return;
  }

  if (event.type === 'finish' || event.type === 'finish-step') {
    const usage = event.totalUsage ?? event.data?.usage;
    if (!usage) return;
    // 覆盖语义：finish-step 与 finish 携带同一份 usage。
    if (usage.inputTokens != null) {
      const { cacheRead, cacheWrite, noCache } = splitInput(usage);
      acc.inputTokens = usage.inputTokens;
      acc.cacheReadTokens = cacheRead;
      acc.cacheWriteTokens = cacheWrite;
      acc.noCacheTokens = noCache;
    }
    if (usage.outputTokens != null) acc.outputTokens = usage.outputTokens;
    acc.sawUsage = true;
  }
}
