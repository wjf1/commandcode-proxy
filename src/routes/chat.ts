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
import crypto from 'node:crypto';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError, estimateTextTokens } from '../adapters/commandcode/upstream.js';
import { accumulateUsage, createUsageAccumulator } from '../adapters/commandcode/usage.js';
import { buildRequestContext } from '../utils/request-context.js';
import { hardenConnectionForLongStream, persistCompletion, writeSSEHeaders, parseEventLine } from './sse-common.js';
import { OpenAIChatRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, ProxyError, toProxyError } from '../utils/errors.js';

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function logCompletion(inputTokens: number, outputTokens: number, startTime: number, model: string): void {
  const timing = ((Date.now() - startTime) / 1000).toFixed(3);
  logger.info(`Input Tokens ${fmtNum(inputTokens)} | Output Tokens ${fmtNum(outputTokens)} | Timing ${timing}s | Model ${model} | Status COMPLETED`);
}

/** 常量时间字符串比较，避免逐字节短路泄露密钥前缀。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // 仍做一次等长比较，保持耗时与内容无关
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 可选的共享密钥鉴权。设置 PROXY_API_KEY 环境变量后：
 *  - `/v1/*`：API 调用方必须以 `Authorization: Bearer <key>` 或 `x-api-key` 携带它；
 *  - `/api/*`：管理面同一把密钥（绑定 0.0.0.0 时防止局域网直连增删账号）。
 * 未设置 = 开放本机访问（默认回环绑定已保证安全）。仪表盘 HTML 本身保持公开，
 * 前端在 /api 401 时弹密钥输入框。
 */
export function verifyProxyAuth(fastify: FastifyInstance): void {
  const requiredKey = process.env.PROXY_API_KEY?.trim();
  if (!requiredKey) return;

  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/') && !req.url.startsWith('/api/')) return;
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const xKey = String(req.headers['x-api-key'] || '').trim();
    if (!safeEqual(bearer, requiredKey) && !safeEqual(xKey, requiredKey)) {
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

    const startTime = Date.now();
    const abortController = new AbortController();

    // 面向长会话（多分钟推理）的 socket 加固；客户端断开则取消上游。
    hardenConnectionForLongStream(req, reply, abortController);

    const translated = adapter.translateOpenAIRequest(body);
    const modelName = translated.params.model;
    let inputTokens = estimateTextTokens(JSON.stringify(translated));
    const usageAcc = createUsageAccumulator();
    // 非流式也预生成 traceId：响应 id、错误日志、用量记录三者对得上。
    const traceId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    // 会话/项目等归因信息：会话 ID 来自客户端声明，项目为推断（见模块注释）。
    const requestContext = buildRequestContext(req.headers as any, body);

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
          persistCompletion(modelName, usageAcc, requestContext, startTime, 'COMPLETED', state.id, 'chat');
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          if (isAbortError(err) || err?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[CHAT] Stream error | Model ${modelName} | Trace ${state.id} | ${err.message}`);
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
          outputTokens += estimateTextTokens(txt);
        }
        if (event.type === 'reasoning-delta') {
          const txt = event.text || event.data?.text || '';
          reasoningContent += txt;
          outputTokens += estimateTextTokens(txt);
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
      persistCompletion(modelName, usageAcc, requestContext, startTime, 'COMPLETED', traceId, 'chat');

      return reply.send({
        id: traceId,
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
      logger.error(`[CHAT] Fatal request error | Trace ${traceId} | ${err.message}`);
      const proxyErr = toProxyError(err, ErrorCode.INTERNAL_ERROR);
      return reply.status(proxyErr.status).send({ error: proxyErr.openAIPayload() });
    }
  });
}
