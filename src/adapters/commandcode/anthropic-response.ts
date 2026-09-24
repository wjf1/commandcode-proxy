// =============================================================================
// 响应侧 Anthropic 非流式构建（原 adapter.ts 职责模块化）
// -----------------------------------------------------------------------------
// buildAnthropicResponse：CC 事件数组 → 完整 Anthropic 消息。
// 原样搬迁，逻辑零改动；adapter.ts 的 CommandCodeAdapter 委托至此。
// =============================================================================
import crypto from 'node:crypto';
import { CCEvent } from '../../types/index.js';
import { splitInput } from './usage.js';
import { estimateTextTokens } from './upstream.js';
import { finishUsageOf, anthropicUpstreamErrorText } from './usage-extract.js';

/**
 * 把 CC 事件流汇聚成一个 Anthropic 非流式响应消息。
 * - 文本/reasoning/tool-call 分别累积
 * - 同一 tool-call 的多个 delta 片段会被拼接/合并成完整 input
 * - 从 finish 事件读取 totalUsage（原版 CLI 放在顶层）
 */
export function buildAnthropicResponse(events: CCEvent[], msgId: string, modelName: string, inputTokens: number) {
  let fullText = '';
  let reasoningText = '';
  const toolCalls: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let stopReason: string | null = null;

  for (const event of events) {
    if (event.type === 'text-delta') {
      const txt = event.text || event.data?.text;
      if (txt) {
        fullText += txt;
        outputTokens += estimateTextTokens(txt);
      }
    } else if (event.type === 'reasoning-delta') {
      const txt = event.text || event.data?.text;
      if (txt) {
        reasoningText += txt;
        outputTokens += estimateTextTokens(txt);
      }
    } else if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
      const id = ((event.toolCallId || event.data?.toolCallId) as string) || `toolu_${crypto.randomUUID().slice(0, 8)}`;
      const name = ((event.toolName || event.data?.toolName) as string) || 'tool';
      const input = (event.input ?? event.data?.input ?? {}) as Record<string, unknown>;
      const existing = toolCalls.find(t => t.id === id);
      if (existing) {
        // tool-call-delta may stream argument fragments
        if (typeof input === 'string') {
          (existing as any)._args = ((existing as any)._args || '') + input;
        } else {
          existing.input = { ...existing.input, ...input };
        }
      } else {
        toolCalls.push({ type: 'tool_use', id, name, input });
      }
    } else if (event.type === 'finish' || event.type === 'finish-step') {
      // Original CLI: totalUsage at top level; rawFinishReason ?? finishReason.
      const usage = finishUsageOf(event);
      if (usage) {
        if (usage.inputTokens != null) {
          inputTokens = usage.inputTokens;
          const { cacheRead, cacheWrite } = splitInput(usage);
          cacheReadTokens = cacheRead;
          cacheWriteTokens = cacheWrite;
        }
        if (usage.outputTokens != null) outputTokens = usage.outputTokens;
      }
      const rawFR = event.rawFinishReason || event.finishReason || event.data?.finishReason;
      if (rawFR === 'tool-calls' || rawFR === 'tool_calls') stopReason = 'tool_use';
      else if (rawFR === 'length' || rawFR === 'max_tokens') stopReason = 'max_tokens';
      else if (rawFR) stopReason = 'end_turn';
    } else if (event.type === 'error') {
      const errMsg = anthropicUpstreamErrorText(event);
      if (errMsg) {
        fullText += `\n[Upstream Error: ${errMsg}]\n`;
      }
    }
  }

  for (const tc of toolCalls as any[]) {
    if (typeof tc.input === 'string') {
      try {
        tc.input = JSON.parse((tc as any)._args || tc.input || '{}');
      } catch {
        tc.input = { raw: (tc as any)._args || tc.input };
      }
      delete (tc as any)._args;
    }
  }

  const content: any[] = [];
  if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText, signature: '' });
  if (fullText) content.push({ type: 'text', text: fullText });
  content.push(...toolCalls);
  if (content.length === 0) content.push({ type: 'text', text: '' });

  // Anthropic 的 input_tokens 不含缓存读写（总输入 = input_tokens + cache_read +
  // cache_creation），而上游 finish 事件给的 inputTokens 是含缓存的输入总量 ——
  // 直接透传会让按规范累加的客户端把缓存读再加一遍。详见 toAnthropicUsage。
  const noCacheInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);

  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content,
    model: modelName,
    stop_reason: stopReason || (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: noCacheInput,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheWriteTokens,
    },
  };
}
