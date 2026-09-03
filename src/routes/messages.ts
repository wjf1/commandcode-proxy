import { FastifyInstance } from 'fastify';
import { createInterface } from 'readline';
import crypto from 'node:crypto';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError, estimateTokens, UpstreamError } from '../adapters/commandcode/upstream.js';
import { AnthropicRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';

function writeSSEHeaders(reply: any): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();
}

function parseEventLine(line: string): CCEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonStr || jsonStr === '[DONE]') return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function messagesRoutes(fastify: FastifyInstance) {
  const adapter = new CommandCodeAdapter();

  fastify.post('/v1/messages', async (req, reply) => {
    if (!getGatewayRunning()) {
      return reply.status(503).send({
        error: { message: 'Gateway PAUSED', type: 'service_unavailable' },
      });
    }

    const body = req.body as AnthropicRequest;
    if (!body || !Array.isArray(body.messages)) {
      return reply.status(400).send({
        error: { type: 'invalid_request_error', message: 'messages field is required' },
      });
    }

    let apiKey = getActiveApiKey();
    if (!apiKey) {
      return reply.status(401).send({
        error: { type: 'authentication_error', message: 'No API Key' },
      });
    }

    req.raw.setTimeout(0);
    if (req.raw.socket) {
      req.raw.socket.setTimeout(0);
      req.raw.socket.setKeepAlive(true, 10000);
      req.raw.socket.setNoDelay(true);
    }

    const abortController = new AbortController();
    const onClientClose = () => {
      if (!reply.raw.writableEnded) abortController.abort();
    };
    req.raw.on('aborted', onClientClose);
    reply.raw.on('close', onClientClose);

    const startTime = Date.now();
    const translated = adapter.translateAnthropicRequest(body);
    const modelName = translated.params.model;
    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
    let inputTokens = estimateTokens(JSON.stringify(translated).length);

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
        const status = err instanceof UpstreamError && err.status ? err.status : 502;
        return reply.status(status >= 400 && status < 600 ? status : 502).send({
          error: { type: 'upstream_error', message: err.message },
        });
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

        // Block bookkeeping: index 0 reserved for text, 1 for thinking,
        // 2+ for tool_use blocks — opened lazily as events arrive.
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
          // Strict Anthropic clients validate a signature before block close.
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

          if (event.type === 'text-delta') {
            const text = event.text || event.data?.text;
            if (text) {
              closeThinkingBlock();
              openTextBlock();
              outputTokens += Math.ceil(text.length / 4);
              reply.raw.write(
                sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
              );
            }
          } else if (event.type === 'reasoning-delta') {
            const text = event.text || event.data?.text;
            if (text) {
              openThinkingBlock();
              outputTokens += Math.ceil(text.length / 4);
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
            if (event.data?.usage) {
              if (event.data.usage.inputTokens) inputTokens = event.data.usage.inputTokens;
              if (event.data.usage.outputTokens) outputTokens = event.data.usage.outputTokens;
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
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          if (isAbortError(err) || err?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[MESSAGES] Upstream stream error: ${err.message}`);
          closeThinkingBlock();
          closeTextBlock();
          reply.raw.write(sse('error', { type: 'error', error: { type: 'upstream_error', message: err.message } }));
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

      // ── Non-streaming ──
      const events: CCEvent[] = [];
      const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
      for await (const line of rl) {
        const event = parseEventLine(line);
        if (event) events.push(event);
      }

      const message = adapter.buildAnthropicResponse(events, msgId, modelName, inputTokens);
      logger.info(
        `Input Tokens ${message.usage.input_tokens.toLocaleString('en-US')} | Output Tokens ${message.usage.output_tokens.toLocaleString('en-US')} | Timing ${((Date.now() - startTime) / 1000).toFixed(3)}s | Model ${modelName} | Status COMPLETED`
      );
      return reply.send(message);
    } catch (err: any) {
      if (isAbortError(err) || err?.isAbort) return reply.raw.end();
      logger.error(`[MESSAGES] Request failed: ${err.message}`);
      return reply.status(502).send({
        error: { type: 'upstream_error', message: err.message },
      });
    }
  });
}
