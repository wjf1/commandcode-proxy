// =============================================================================
// POST /v1/messages —— Anthropic Messages 兼容路由
// -----------------------------------------------------------------------------
// 职责：
//   - 用 CommandCodeAdapter 把 Anthropic 请求（含 thinking/tool_use/tool_result、
//     base64 图片、system 块数组）翻译为 CC wire
//   - 流式：输出标准 Anthropic 事件序列 message_start → content_block_start/delta/
//     stop → signature_delta → message_delta → message_stop
//   - 非流式：汇聚事件为单个 message 响应
//   - 与 chat.ts 相同的服务加固：socket keepalive、客户端断开取消上游
// =============================================================================
import { FastifyInstance } from 'fastify';
import { createInterface } from 'readline';
import crypto from 'node:crypto';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError, estimateTextTokens } from '../adapters/commandcode/upstream.js';
import { accumulateUsage, createUsageAccumulator } from '../adapters/commandcode/usage.js';
import { buildRequestContext, systemTextOf } from '../utils/request-context.js';
import { hardenConnectionForLongStream, persistCompletion, writeSSEHeaders, parseEventLine } from './sse-common.js';
import { AnthropicRequest, AnthropicContentBlock, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, ProxyError, toProxyError } from '../utils/errors.js';

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function messagesRoutes(fastify: FastifyInstance) {
  const adapter = new CommandCodeAdapter();

  // ── POST /v1/messages/count_tokens —— Anthropic SDK 兼容 ────────────────────
  // 上游没有对应端点，这里用 CJK 感知的本地估算兜底（不发起上游请求、不受
  // 引擎暂停影响），口径与 usage 缺失时的成本估算一致，供客户端做上下文预算。
  fastify.post('/v1/messages/count_tokens', async (req, reply) => {
    const body = req.body as AnthropicRequest;
    if (!body || !Array.isArray(body.messages)) {
      const err = new ProxyError(ErrorCode.UNSUPPORTED_OPTION, 'Invalid request: messages field is required');
      return reply.status(err.status).send(err.anthropicPayload());
    }
    let text = systemTextOf(body) + '\n';
    for (const m of body.messages || []) {
      const blocks: AnthropicContentBlock[] =
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
      for (const b of blocks) {
        if (b.type === 'text') text += b.text + '\n';
        else if (b.type === 'thinking') text += b.thinking + '\n';
        else if (b.type === 'tool_use') text += JSON.stringify(b.input ?? {});
        else if (b.type === 'tool_result' && typeof b.content === 'string') text += b.content + '\n';
      }
      text += '\n';
    }
    return { input_tokens: estimateTextTokens(text) };
  });

  fastify.post('/v1/messages', async (req, reply) => {
    if (!getGatewayRunning()) {
      const err = new ProxyError(ErrorCode.GATEWAY_PAUSED, 'CommandCode Gateway Engine is currently PAUSED.');
      return reply.status(err.status).send(err.anthropicPayload());
    }

    const body = req.body as AnthropicRequest;
    if (!body || !Array.isArray(body.messages)) {
      const err = new ProxyError(ErrorCode.UNSUPPORTED_OPTION, 'Invalid request: messages field is required');
      return reply.status(err.status).send(err.anthropicPayload());
    }

    let apiKey = getActiveApiKey();
    if (!apiKey) {
      const err = new ProxyError(ErrorCode.MISSING_CREDENTIAL, 'No active Command Code API Key. Add one in the dashboard.');
      return reply.status(err.status).send(err.anthropicPayload());
    }

    const abortController = new AbortController();
    hardenConnectionForLongStream(req, reply, abortController);

    const startTime = Date.now();
    const translated = adapter.translateAnthropicRequest(body);
    const modelName = translated.params.model;
    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
    let inputTokens = estimateTextTokens(JSON.stringify(translated));
    const usageAcc = createUsageAccumulator();
    // 会话/项目等归因信息：会话 ID 来自客户端声明，项目为推断（见模块注释）。
    const requestContext = buildRequestContext(req.headers as any, body);

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, {
          apiKey,
          abortSignal: abortController.signal,
          onRetry: async () => {
            if (await checkAndRotateAccountsOnQuota()) {
              apiKey = getActiveApiKey();
            }
          },
        });
      } catch (err: any) {
        if (isAbortError(err) || err?.isAbort) return reply.raw.end();
        const proxyErr = toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
        return reply.status(proxyErr.status).send(proxyErr.anthropicPayload());
      }

      if (body.stream) {
        writeSSEHeaders(reply);

        reply.raw.write(
          sse('message_start', {
            type: 'message_start',
            message: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: modelName,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          })
        );
        reply.raw.write(sse('ping', { type: 'ping' }));

        const pingInterval = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(':\n\n');
        }, 15000);
        const cleanupPings = () => clearInterval(pingInterval);

        // 块索引簿记：索引 0 预留给文本、1 给 thinking，2+ 给 tool_use 块 ——
        // 随事件到达而懒创建。
        let textBlockOpen = false;
        let thinkingBlockOpen = false;
        let toolBlockIndex = 2;
        let outputTokens = 0;
        let stopReason: string | null = null;

        const openTextBlock = () => {
          if (textBlockOpen) return;
          textBlockOpen = true;
          reply.raw.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        };
        const closeTextBlock = () => {
          if (!textBlockOpen) return;
          textBlockOpen = false;
          reply.raw.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        };

        const openThinkingBlock = () => {
          if (thinkingBlockOpen) return;
          thinkingBlockOpen = true;
          reply.raw.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }));
        };
        const closeThinkingBlock = () => {
          if (!thinkingBlockOpen) return;
          thinkingBlockOpen = false;
          // 严格的 Anthropic 客户端会在块关闭前校验 signature。
          reply.raw.write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'signature_delta', signature: '' },
            })
          );
          reply.raw.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }));
        };

        const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });

        rl.on('line', (line: string) => {
          const event = parseEventLine(line);
          if (!event) return;

          accumulateUsage(usageAcc, event);

          if (event.type === 'text-delta') {
            const text = event.text || event.data?.text;
            if (text) {
              closeThinkingBlock();
              openTextBlock();
              outputTokens += estimateTextTokens(text);
              reply.raw.write(
                sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
              );
            }
          } else if (event.type === 'reasoning-delta') {
            const text = event.text || event.data?.text;
            if (text) {
              openThinkingBlock();
              outputTokens += estimateTextTokens(text);
              reply.raw.write(
                sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: text } })
              );
            }
          } else if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
            closeThinkingBlock();
            closeTextBlock();
            const toolCallId = ((event.toolCallId || event.data?.toolCallId) as string) || `toolu_${crypto.randomUUID().slice(0, 8)}`;
            const toolName = ((event.toolName || event.data?.toolName || event.name || event.data?.name) as string) || 'tool';
            const input = event.input ?? event.data?.input ?? {};
            reply.raw.write(
              sse('content_block_start', {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} },
              })
            );
            reply.raw.write(
              sse('content_block_delta', {
                type: 'content_block_delta',
                index: toolBlockIndex,
                delta: { type: 'input_json_delta', partial_json: typeof input === 'string' ? input : JSON.stringify(input) },
              })
            );
            reply.raw.write(sse('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex }));
            toolBlockIndex++;
            stopReason = 'tool_use';
          } else if (event.type === 'error') {
            const errObj = event.error || event;
            const errMsg =
              typeof errObj === 'string'
                ? errObj
                : ((errObj as any)?.message as string | undefined) || '';
            if (errMsg && errMsg !== 'unknown') {
              closeThinkingBlock();
              openTextBlock();
              reply.raw.write(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: `\n[Upstream Error: ${errMsg}]\n` },
                })
              );
            }
          } else if (event.type === 'finish' || event.type === 'finish-step') {
            const usage = event.totalUsage ?? event.data?.usage;
            if (usage) {
              if (usage.inputTokens != null) inputTokens = usage.inputTokens;
              if (usage.outputTokens != null) outputTokens = usage.outputTokens;
            }
            const rawFR = event.finishReason || event.data?.finishReason;
            if (rawFR === 'tool-calls' || rawFR === 'tool_calls') stopReason = 'tool_use';
            else if (rawFR === 'length' || rawFR === 'max_tokens') stopReason = 'max_tokens';
            else if (rawFR && !stopReason) stopReason = 'end_turn';
          }
        });

        rl.on('close', () => {
          cleanupPings();
          closeThinkingBlock();
          closeTextBlock();
          if (!stopReason) stopReason = 'end_turn';
          // 上游未回 usage 时回落到本地估算，避免记录为 0。
          if (!usageAcc.sawUsage) {
            usageAcc.inputTokens = inputTokens;
            usageAcc.outputTokens = outputTokens;
          }
          reply.raw.write(
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: outputTokens },
            })
          );
          reply.raw.write(sse('message_stop', { type: 'message_stop' }));
          const timing = ((Date.now() - startTime) / 1000).toFixed(3);
          logger.info(
            `Input Tokens ${inputTokens.toLocaleString('en-US')} | Output Tokens ${outputTokens.toLocaleString('en-US')} | Timing ${timing}s | Model ${modelName} | Status COMPLETED`
          );
          persistCompletion(modelName, usageAcc, requestContext, startTime, 'COMPLETED', msgId, 'messages');
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          if (isAbortError(err) || err?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[MESSAGES] Upstream stream error | Trace ${msgId} | ${err.message}`);
          closeThinkingBlock();
          closeTextBlock();
          const proxyErr = toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
          // Anthropic 客户端按 error.type 分支，这里给出规范类型而非自定义串。
          reply.raw.write(sse('error', { type: 'error', error: proxyErr.anthropicPayload().error }));
          reply.raw.write(
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
              usage: { output_tokens: outputTokens },
            })
          );
          reply.raw.write(sse('message_stop', { type: 'message_stop' }));
          reply.raw.end();
        });

        return reply;
      }

      // ── 非流式 ──
      const events: CCEvent[] = [];
      const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
      for await (const line of rl) {
        const event = parseEventLine(line);
        if (event) {
          events.push(event);
          accumulateUsage(usageAcc, event);
        }
      }

      const message = adapter.buildAnthropicResponse(events, msgId, modelName, inputTokens);
      logger.info(
        `Input Tokens ${message.usage.input_tokens.toLocaleString('en-US')} | Output Tokens ${message.usage.output_tokens.toLocaleString('en-US')} | Timing ${((Date.now() - startTime) / 1000).toFixed(3)}s | Model ${modelName} | Status COMPLETED`
      );
      if (!usageAcc.sawUsage) {
        usageAcc.inputTokens = message.usage.input_tokens;
        usageAcc.outputTokens = message.usage.output_tokens;
      }
      persistCompletion(modelName, usageAcc, requestContext, startTime, 'COMPLETED', msgId, 'messages');
      return reply.send(message);
    } catch (err: any) {
      if (isAbortError(err) || err?.isAbort) return reply.raw.end();
      logger.error(`[MESSAGES] Request failed | Trace ${msgId} | ${err.message}`);
      const proxyErr = toProxyError(err, ErrorCode.INTERNAL_ERROR);
      return reply.status(proxyErr.status).send(proxyErr.anthropicPayload());
    }
  });
}
