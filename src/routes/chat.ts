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
import { sendToCC, isAbortError, estimateTokens } from '../adapters/commandcode/upstream.js';
import { accumulateUsage, createUsageAccumulator, UsageAccumulator } from '../adapters/commandcode/usage.js';
import { OpenAIChatRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, ProxyError, toProxyError } from '../utils/errors.js';
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

/**
 * 持久化一次会话记录到 usage-history.jsonl。
 * 成本优先取上游权威金额（上游已算好峰谷价与缓存折扣），缺失时才本地估算。
 */
function persistCompletion(
  model: string,
  usage: UsageAccumulator,
  startTime: number,
  status: 'COMPLETED' | 'FAILED',
  traceId?: string,
  mode: 'chat' | 'messages' = 'chat'
): void {
  const estimated = estimateCostUsd(model, usage.inputTokens || 0, usage.outputTokens || 0, {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    at: new Date(startTime),
  });
  const hasUpstreamCost = usage.upstreamCostUsd !== undefined;
  recordCompletion({
    timestamp: new Date().toISOString(),
    model,
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    timingMs: Date.now() - startTime,
    costUsd: hasUpstreamCost ? usage.upstreamCostUsd! : estimated.costUsd,
    costSource: hasUpstreamCost ? 'official' : 'estimated',
    estimatedCostUsd: estimated.costUsd,
    hasPricing: hasUpstreamCost || estimated.hasPricing,
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
      const err = new ProxyError(ErrorCode.PROXY_AUTH_REQUIRED, 'Invalid or missing PROXY_API_KEY');
      // /v1/messages 的调用方按 Anthropic 错误信封解析，其余按 OpenAI 形态。
      return req.url.startsWith('/v1/messages')
        ? reply.status(err.status).send(err.anthropicPayload())
        : reply.status(err.status).send({ error: err.openAIPayload() });
    }
  });
}

export async function chatRoutes(fastify: FastifyInstance) {
  const adapter = new CommandCodeAdapter();

  fastify.post('/v1/chat/completions', async (req, reply) => {
    if (!getGatewayRunning()) {
      const err = new ProxyError(ErrorCode.GATEWAY_PAUSED, 'CommandCode Gateway Engine is currently PAUSED.');
      return reply.status(err.status).send({ error: err.openAIPayload() });
    }

    const body = req.body as OpenAIChatRequest;
    if (!body || !Array.isArray(body.messages)) {
      const err = new ProxyError(ErrorCode.UNSUPPORTED_OPTION, 'Invalid request: messages field is required');
      return reply.status(err.status).send({ error: err.openAIPayload() });
    }

    let apiKey = getActiveApiKey();
    if (!apiKey) {
      const err = new ProxyError(ErrorCode.MISSING_CREDENTIAL, 'No active Command Code API Key. Add one in the dashboard.');
      return reply.status(err.status).send({ error: err.openAIPayload() });
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
    const usageAcc = createUsageAccumulator();

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
        const proxyErr = toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
        if (body.stream) {
          writeSSEHeaders(reply);
          const state = adapter.createStreamEncoderState(modelName);
          // 流已经开始后无法再改 HTTP 状态码，把稳定错误码并入内容，便于调用方自愈。
          for (const c of adapter.encodeOpenAIChunk({ type: 'error', error: { message: `${proxyErr.code}: ${proxyErr.message}` } }, state)) {
            reply.raw.write(c);
          }
          for (const c of adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state)) {
            reply.raw.write(c);
          }
          return reply.raw.end();
        }
        return reply.status(proxyErr.status).send({ error: proxyErr.openAIPayload() });
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
            accumulateUsage(usageAcc, event);
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
          // 上游未回 usage 时回落到本地估算的输入量，避免记录为 0。
          if (!usageAcc.sawUsage) usageAcc.inputTokens = inputTokens;
          logCompletion(usageAcc.inputTokens, usageAcc.outputTokens, startTime, modelName);
          persistCompletion(modelName, usageAcc, startTime, 'COMPLETED', state.id, 'chat');
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

        accumulateUsage(usageAcc, event);

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
            if (usage.inputTokens != null) inputTokens = usage.inputTokens;
            if (usage.outputTokens != null) outputTokens = usage.outputTokens;
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
      // 本地 output 估算仅在上游未给出 usage 时才需要；有 usage 时以 usageAcc 为准。
      if (!usageAcc.sawUsage) {
        usageAcc.inputTokens = inputTokens;
        usageAcc.outputTokens = outputTokens;
      }
      persistCompletion(modelName, usageAcc, startTime, 'COMPLETED', undefined, 'chat');

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
      const proxyErr = toProxyError(err, ErrorCode.INTERNAL_ERROR);
      return reply.status(proxyErr.status).send({ error: proxyErr.openAIPayload() });
    }
  });
}
