// =============================================================================
// POST /v1/chat/completions —— OpenAI 兼容路由
// -----------------------------------------------------------------------------
// 职责：
//   - 校验网关状态、请求体、api key 是否就绪
//   - 用 CommandCodeAdapter 把 OpenAI 请求翻译为 CC wire
//   - 通过 sendToCC 发送上游，并把返回的错误/SSE 流按 OpenAI 规范透传
//   - 流式：转成 OpenAI chunk（role 起始 delta、内容增量、工具调用增量、收尾）
//   - 非流式：汇总全部事件为单个 chat.completion 响应
//   - 长连接加固：socket 禁用超时 + keepalive；客户端断开则取消上游
//   - 可选共享密钥鉴权（PROXY_API_KEY）
// =============================================================================
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createInterface } from 'readline';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError, estimateTokens, UpstreamError } from '../adapters/commandcode/upstream.js';
import { OpenAIChatRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { recordCompletion, estimateCostUsd } from '../utils/usage-store.js';

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function writeSSEHeaders(reply: any): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();
}

function logCompletion(inputTokens: number, outputTokens: number, startTime: number, model: string): void {
  const timing = ((Date.now() - startTime) / 1000).toFixed(3);
  logger.info(`Input Tokens ${fmtNum(inputTokens)} | Output Tokens ${fmtNum(outputTokens)} | Timing ${timing}s | Model ${model} | Status COMPLETED`);
}

/** 持久化一次会话记录到 usage-history.jsonl */
function persistCompletion(inputTokens: number, outputTokens: number, startTime: number, model: string, status: 'COMPLETED' | 'FAILED', traceId?: string, mode: 'chat' | 'messages' = 'chat'): void {
  const { costUsd, hasPricing } = estimateCostUsd(model, inputTokens || 0, outputTokens || 0);
  recordCompletion({
    timestamp: new Date().toISOString(),
    model,
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    timingMs: Date.now() - startTime,
    costUsd,
    hasPricing,
    status,
    traceId,
    mode,
  });
}

/** 解析一行 SSE 为一个 CCEvent；空行或 [DONE] 返回 null。 */
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

/**
 * 可选的共享密钥鉴权。设置 PROXY_API_KEY 环境变量后，每个 /v1/* 调用都必须
 * 以 `Authorization: Bearer <key>` 或 `x-api-key` 携带它。未设置 = 开放本机访问
 * （默认回环绑定已保证安全）。
 */
export function verifyProxyAuth(fastify: FastifyInstance): void {
  const requiredKey = process.env.PROXY_API_KEY?.trim();
  if (!requiredKey) return;

  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return;
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const xKey = String(req.headers['x-api-key'] || '').trim();
    if (bearer !== requiredKey && xKey !== requiredKey) {
      return reply.status(401).send({
        error: { message: 'Invalid or missing PROXY_API_KEY', type: 'authentication_error', code: 401 },
      });
    }
  });
}

export async function chatRoutes(fastify: FastifyInstance) {
  const adapter = new CommandCodeAdapter();

  fastify.post('/v1/chat/completions', async (req, reply) => {
    if (!getGatewayRunning()) {
      return reply.status(503).send({
        error: { message: 'CommandCode Gateway Engine is currently PAUSED.', type: 'service_unavailable', code: 503 },
      });
    }

    const body = req.body as OpenAIChatRequest;
    if (!body || !Array.isArray(body.messages)) {
      return reply.status(400).send({
        error: { message: 'Invalid request: messages field is required', type: 'invalid_request_error', code: 400 },
      });
    }

    let apiKey = getActiveApiKey();
    if (!apiKey) {
      return reply.status(401).send({
        error: { message: 'No active Command Code API Key. Add one in the dashboard.', type: 'invalid_request_error', code: 401 },
      });
    }

    // 面向长会话（多分钟推理）的 socket 加固。
    req.raw.setTimeout(0);
    if (req.raw.socket) {
      req.raw.socket.setTimeout(0);
      req.raw.socket.setKeepAlive(true, 10000);
      req.raw.socket.setNoDelay(true);
    }

    const startTime = Date.now();
    const abortController = new AbortController();

    // 仅当客户端在我们写完之前离开时才取消上游。
    const onClientClose = () => {
      if (!reply.raw.writableEnded) abortController.abort();
    };
    req.raw.on('aborted', onClientClose);
    reply.raw.on('close', onClientClose);

    const translated = adapter.translateOpenAIRequest(body);
    const modelName = translated.params.model;
    let inputTokens = estimateTokens(JSON.stringify(translated).length);

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, {
          apiKey,
          abortSignal: abortController.signal,
          onRetry: async () => {
            // auto-quota 模式下重试可能落到一个新账号上。
            if (await checkAndRotateAccountsOnQuota()) {
              apiKey = getActiveApiKey();
            }
          },
        });
      } catch (err: any) {
        if (isAbortError(err) || err?.isAbort) return reply.raw.end();
        if (body.stream) {
          writeSSEHeaders(reply);
          const state = adapter.createStreamEncoderState(modelName);
          for (const c of adapter.encodeOpenAIChunk({ type: 'error', error: { message: err.message || 'Upstream service error' } }, state)) {
            reply.raw.write(c);
          }
          for (const c of adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state)) {
            reply.raw.write(c);
          }
          return reply.raw.end();
        }
        const status = err instanceof UpstreamError && err.status ? err.status : 502;
        return reply.status(status >= 400 && status < 600 ? status : 502).send({
          error: { message: err.message, type: 'upstream_error', code: status },
        });
      }

      if (body.stream) {
        writeSSEHeaders(reply);
        const state = adapter.createStreamEncoderState(modelName);
        for (const c of adapter.encodeOpenAIChunk({ type: 'start' }, state)) reply.raw.write(c);

        // 每 15s 发一条 SSE 注释行 —— 防止 CDN/代理的空闲断开。
        const pingInterval = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(':\n\n');
        }, 15000);
        const cleanupPings = () => clearInterval(pingInterval);

        const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });

        rl.on('line', (line: string) => {
          const event = parseEventLine(line);
          if (!event) return;
          try {
            for (const c of adapter.encodeOpenAIChunk(event, state)) reply.raw.write(c);
          } catch (err: any) {
            logger.warn(`[CHAT] Chunk encode error: ${err.message}`);
          }
        });

        rl.on('close', () => {
          cleanupPings();
          if (!state.sawFinish) {
            for (const c of adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state)) {
              reply.raw.write(c);
            }
          }
          logCompletion(inputTokens, state.outputTokens, startTime, modelName);
          persistCompletion(inputTokens, state.outputTokens, startTime, modelName, 'COMPLETED', state.id, 'chat');
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          if (isAbortError(err) || err?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[CHAT] Stream error | Model ${modelName} | ${err.message}`);
          if (!state.sawFinish) {
            for (const c of adapter.encodeOpenAIChunk({ type: 'error', error: { message: err.message || 'Upstream stream error' } }, state)) {
              reply.raw.write(c);
            }
            for (const c of adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state)) {
              reply.raw.write(c);
            }
          }
          reply.raw.end();
        });

        return reply;
      }

      // ── 非流式 ──
      let fullText = '';
      let reasoningContent = '';
      let outputTokens = 0;
      const toolCallsMap = new Map<string, any>();
      let finishReason = 'stop';

      const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
      for await (const line of rl) {
        const event = parseEventLine(line);
        if (!event) continue;

        if (event.type === 'error') {
          const errMsg = typeof event.error === 'string' ? event.error : event.error?.message;
          if (errMsg && errMsg !== 'unknown') fullText += `\n[Upstream Error: ${errMsg}]\n`;
        }
        if (event.type === 'text-delta') {
          const txt = event.text || event.data?.text || '';
          fullText += txt;
          outputTokens += Math.ceil(txt.length / 4);
        }
        if (event.type === 'reasoning-delta') {
          const txt = event.text || event.data?.text || '';
          reasoningContent += txt;
          outputTokens += Math.ceil(txt.length / 4);
        }
        if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
          const tcId = ((event.toolCallId || event.data?.toolCallId) as string) || 'call_1';
          const name = ((event.toolName || event.data?.toolName || event.name || event.data?.name) as string) || 'tool';
          const input = event.input ?? event.data?.input ?? event.arguments ?? event.data?.arguments ?? {};
          toolCallsMap.set(tcId, {
            id: tcId,
            type: 'function',
            function: { name, arguments: typeof input === 'string' ? input : JSON.stringify(input) },
          });
        }
        if (event.type === 'finish' || event.type === 'finish-step') {
          const rawFR = event.finishReason || event.data?.finishReason;
          if (rawFR) {
            finishReason =
              rawFR === 'tool-calls' || rawFR === 'tool_calls'
                ? 'tool_calls'
                : rawFR === 'length' || rawFR === 'max_tokens'
                  ? 'length'
                  : 'stop';
          }
          const usage = event.totalUsage ?? event.data?.usage;
          if (usage) {
            if (usage.inputTokens) inputTokens = usage.inputTokens;
            if (usage.outputTokens) outputTokens = usage.outputTokens;
          }
        }
      }

      const choiceMessage: any = { role: 'assistant', content: fullText || null };
      if (reasoningContent) choiceMessage.reasoning_content = reasoningContent;
      if (toolCallsMap.size > 0) {
        choiceMessage.tool_calls = Array.from(toolCallsMap.values());
        finishReason = 'tool_calls';
      }

      logCompletion(inputTokens, outputTokens, startTime, modelName);
      persistCompletion(inputTokens, outputTokens, startTime, modelName, 'COMPLETED', undefined, 'chat');

      return reply.send({
        id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, message: choiceMessage, finish_reason: finishReason }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      });
    } catch (err: any) {
      if (isAbortError(err) || err?.isAbort) return reply.raw.end();
      logger.error(`[CHAT] Fatal request error: ${err.message}`);
      return reply.status(502).send({
        error: { message: `Internal proxy error: ${err.message}`, type: 'internal_error', code: 502 },
      });
    }
  });
}
