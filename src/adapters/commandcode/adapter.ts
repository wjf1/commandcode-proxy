// =============================================================================
// CommandCode 适配器（组装层）
// -----------------------------------------------------------------------------
// 职责：把 OpenAI Chat Completions 与 Anthropic Messages 两种上游协议请求，
//      "归一化"翻译成 CommandCode CLI 的私有 wire 协议（/alpha/generate）请求体，
//      并把 CommandCode 返回的 SSE 事件流反向编码为两种协议的响应（流式/非流式）。
// 实现按职责拆分在兄弟模块（本类只是组装与 re-export，保持既有 import 面不变）：
//   - reasoning.ts            max_tokens 钳制 + 推理档位求解
//   - request-translate.ts    请求翻译（OpenAI/Anthropic → CC wire）
//   - stream-encode.ts        响应侧 OpenAI 流式编码（CC 事件 → SSE chunk）
//   - anthropic-response.ts   响应侧 Anthropic 非流式构建
//   - usage-extract.ts        CC 事件上的 usage / 错误消息提取
// 参考依据：逆向自官方 CommandCode CLI 源码的 wire 契约（详见各模块注释）。
// 行为由 tests/adapter-snapshot.test.ts 的 90+ 快照逐字节钉死，拆分零变化。
// =============================================================================
import { OpenAIChatRequest, AnthropicRequest, CCEvent, StreamEncoderState } from '../../types/index.js';
import { resolveReasoningEffort } from './reasoning.js';
import { translateOpenAIRequest as translateOpenAIRequestImpl, translateAnthropicRequest as translateAnthropicRequestImpl } from './request-translate.js';
import { createStreamEncoderState as createStreamEncoderStateImpl, encodeOpenAIChunk as encodeOpenAIChunkImpl } from './stream-encode.js';
import { buildAnthropicResponse as buildAnthropicResponseImpl } from './anthropic-response.js';

export { resolveReasoningEffort, clampMaxTokens, CC_WIRE_MAX_TOKENS_CAP } from './reasoning.js';

export class CommandCodeAdapter {
  /** 推理强度求解（详见 reasoning.ts 的优先级与"向下就近对齐"说明）。 */
  resolveReasoningEffort(model: string, requested?: any, thinkingConfig?: any): string | undefined {
    return resolveReasoningEffort(model, requested, thinkingConfig);
  }

  /**
   * OpenAI Chat Completions → CC wire 请求体（详见 request-translate.ts）。
   */
  translateOpenAIRequest(req: OpenAIChatRequest, opts?: { threadId?: string }) {
    return translateOpenAIRequestImpl(req, opts);
  }

  /**
   * Anthropic Messages → CC wire 请求体（先转 OpenAI 中间形态再复用同一通路，
   * 详见 request-translate.ts）。
   */
  translateAnthropicRequest(req: AnthropicRequest, opts?: { threadId?: string }) {
    return translateAnthropicRequestImpl(req, opts);
  }

  /** 流式编码器状态（id/created 由调用方按需覆盖）。 */
  createStreamEncoderState(
    model: string,
    opts?: { includeUsage?: boolean; estimatedInputTokens?: number },
  ): StreamEncoderState {
    return createStreamEncoderStateImpl(model, opts);
  }

  /** 单个 CC SSE 事件 → 0..n 个 OpenAI SSE 数据块（详见 stream-encode.ts）。 */
  encodeOpenAIChunk(event: CCEvent, state: StreamEncoderState): string[] {
    return encodeOpenAIChunkImpl(event, state);
  }

  /** CC 事件数组 → 完整 Anthropic 非流式响应消息（详见 anthropic-response.ts）。 */
  buildAnthropicResponse(events: CCEvent[], msgId: string, modelName: string, inputTokens: number) {
    return buildAnthropicResponseImpl(events, msgId, modelName, inputTokens);
  }
}
