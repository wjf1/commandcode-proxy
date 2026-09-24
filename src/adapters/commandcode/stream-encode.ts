// =============================================================================
// 响应侧 OpenAI 流式编码（原 adapter.ts 职责模块化）
// -----------------------------------------------------------------------------
// createStreamEncoderState：编码器状态
// encodeOpenAIChunk：单个 CC SSE 事件 → 0..n 个 OpenAI SSE 数据块
// 原样搬迁，逻辑零改动；adapter.ts 的 CommandCodeAdapter 委托至此。
// usage 提取与错误消息提取委托 usage-extract.ts（同源逻辑，不改行为）。
// =============================================================================
import crypto from 'node:crypto';
import { CCEvent, StreamEncoderState } from '../../types/index.js';
import { splitInput, parseUsd } from './usage.js';
import { estimateTextTokens } from './upstream.js';
import { finishUsageOf, openAIUpstreamErrorText } from './usage-extract.js';

export function createStreamEncoderState(
  model: string,
  opts?: { includeUsage?: boolean; estimatedInputTokens?: number },
): StreamEncoderState {
  return {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
    created: Math.floor(Date.now() / 1000),
    model,
    toolCallIndex: 0,
    toolCallIdToIndex: new Map<string, number>(),
    sawFinish: false,
    hasEmittedText: false,
    includeUsage: opts?.includeUsage === true,
    estimatedInputTokens: opts?.estimatedInputTokens,
    thinkingState: 'none',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    noCacheTokens: 0,
  };
}

// ── CC 事件 → OpenAI SSE chunk ─────────────────────────────────────────────

/**
 * 把单个 CC SSE 事件编码为 0..n 个 OpenAI SSE 数据块。
 * 处理的事件类型：
 *  - start      → 先发一个 role=assistant 的空 delta
 *  - error      → 追加 [Upstream Error: ...] 文本块
 *  - reasoning-delta → 输出为 delta.reasoning_content
 *  - text-delta → 输出为 delta.content（并剥离内联 thinking 标签）
 *  - tool-call / tool-call-delta → 输出为 delta.tool_calls 数组增量
 *  - finish     → 输出带 finish_reason 的收尾块 + [DONE]
 */
export function encodeOpenAIChunk(event: CCEvent, state: StreamEncoderState): string[] {
  const chunks: string[] = [];

  if (event.type === 'start') {
    chunks.push(openAIDelta(state, { role: 'assistant', content: '' }, null));
    return chunks;
  }

  if (event.type === 'error' || (event as any).error) {
    const msgStr = openAIUpstreamErrorText(event);
    if (msgStr) {
      state.hasEmittedText = true;
      chunks.push(openAIDelta(state, { content: `\n[Upstream Error: ${msgStr}]\n` }, null));
    }
    return chunks;
  }

  if (event.type === 'reasoning-delta') {
    const text = event.text || event.data?.text;
    if (text) {
      state.hasEmittedText = true;
      state.outputTokens += estimateTextTokens(text);
      chunks.push(openAIDelta(state, { reasoning_content: text } as any, null));
    }
    return chunks;
  }

  if (event.type === 'text-delta') {
    const rawText = event.text || event.data?.text || '';
    if (!rawText) return chunks;

    // 部分模型会在 text-delta 里内联 <think>…</think>（或 <thinking>）标签，
    // 需要把标签内文本路由到 reasoning_content 而不是 content。标签可能被
    // 拆在相邻 delta 里，因此用 thinkingState 跨事件记忆当前是否处于 think 块。
    const OPEN_RE = /<(?:think|thinking)>/;
    const CLOSE_RE = /<\/(?:think|thinking)>/;

    let rest = rawText;
    while (rest) {
      if (state.thinkingState === 'in_think') {
        const m = CLOSE_RE.exec(rest);
        if (!m) {
          state.hasEmittedText = true;
          state.outputTokens += estimateTextTokens(rest);
          chunks.push(openAIDelta(state, { reasoning_content: rest } as any, null));
          break;
        }
        const thinkContent = rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        state.thinkingState = 'done';
        if (thinkContent) {
          state.hasEmittedText = true;
          state.outputTokens += estimateTextTokens(thinkContent);
          chunks.push(openAIDelta(state, { reasoning_content: thinkContent } as any, null));
        }
        continue;
      }
      const m = OPEN_RE.exec(rest);
      if (m) {
        const before = rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        state.thinkingState = 'in_think';
        if (before) {
          state.hasEmittedText = true;
          state.outputTokens += estimateTextTokens(before);
          chunks.push(openAIDelta(state, { content: before }, null));
        }
        continue;
      }
      state.hasEmittedText = true;
      state.outputTokens += estimateTextTokens(rest);
      chunks.push(openAIDelta(state, { content: rest }, null));
      break;
    }
    return chunks;
  }

  if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
    state.hasEmittedText = true;
    const toolCallId = (event.toolCallId || event.data?.toolCallId) as string || `call_${crypto.randomUUID().slice(0, 8)}`;
    let idx = state.toolCallIdToIndex.get(toolCallId);
    if (idx === undefined) {
      idx = state.toolCallIndex++;
      state.toolCallIdToIndex.set(toolCallId, idx);
    }

    const toolName = (event.toolName || event.data?.toolName || event.name || event.data?.name) as string || 'tool';
    const input = event.input ?? event.data?.input ?? event.arguments ?? event.data?.arguments;
    const argsStr = typeof input === 'string' ? input : input ? JSON.stringify(input) : '';

    chunks.push(
      `data: ${JSON.stringify({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: idx,
                  id: toolCallId,
                  type: 'function',
                  function: { name: toolName, arguments: argsStr },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`
    );
    return chunks;
  }

  if (event.type === 'provider-metadata') {
    // 上游账单金额（gateway.cost）—— 用于成本对账，不产出任何下游 chunk。
    const cost = parseUsd(event.providerMetadata?.gateway?.cost);
    if (cost !== undefined) state.upstreamCostUsd = cost;
    return chunks;
  }

  if (event.type === 'finish' || event.type === 'finish-step') {
    state.sawFinish = true;
    // Original CLI: usage lives at event.totalUsage; data.usage is legacy.
    const usage = finishUsageOf(event);
    if (usage) {
      if (usage.inputTokens != null) {
        state.inputTokens = usage.inputTokens;
        // 缓存命中量必须拆出来：单价仅为输入价的 1/50，混在 inputTokens 里会虚高成本。
        const { cacheRead, cacheWrite, noCache } = splitInput(usage);
        state.cacheReadTokens = cacheRead;
        state.cacheWriteTokens = cacheWrite;
        state.noCacheTokens = noCache;
      }
      if (usage.outputTokens != null) state.outputTokens = usage.outputTokens;
    }
    const upstreamFR = event.finishReason || event.data?.finishReason;
    const hasToolCalls = state.toolCallIdToIndex.size > 0;
    // 上游明确回 stop/end_turn 时也不能压过**实际已流出**的工具调用：客户端按
    // finish_reason 判断回合是否结束，被压过时整批 tool_calls 被丢弃、agent 静默卡住。
    // 只有 length（被 max_tokens 截断）优先级更高。与 chat.ts 非流式路径处置一致。
    const rawFR = hasToolCalls && upstreamFR !== 'length' && upstreamFR !== 'max_tokens'
      ? 'tool-calls'
      : upstreamFR || (hasToolCalls ? 'tool-calls' : 'stop');
    const finishReason =
      rawFR === 'tool-calls' || rawFR === 'tool_calls'
        ? 'tool_calls'
        : rawFR === 'length' || rawFR === 'max_tokens'
          ? 'length'
          : 'stop';
    // OpenAI 语义：stream_options.include_usage 时收尾 chunk 携带 usage
    //（输入量优先用上游 totalUsage，缺失时回落本地估算）。
    if (state.includeUsage) {
      const pt = state.inputTokens || state.estimatedInputTokens || 0;
      chunks.push(`data: ${JSON.stringify({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: {
          prompt_tokens: pt,
          completion_tokens: state.outputTokens,
          total_tokens: pt + state.outputTokens,
          // 缓存命中明细按 OpenAI 语义放在 prompt_tokens_details，客户端据此算缓存折扣。
          prompt_tokens_details: { cached_tokens: state.cacheReadTokens || 0 },
        },
      })}\n\n`);
    } else {
      chunks.push(openAIDelta(state, {}, finishReason));
    }
    chunks.push('data: [DONE]\n\n');
    return chunks;
  }

  return chunks;
}

function openAIDelta(state: StreamEncoderState, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}
