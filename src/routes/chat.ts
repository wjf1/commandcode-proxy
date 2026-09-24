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
import { sendToCC, isAbortError, estimateTextTokens, estimateWireInputTokens } from '../adapters/commandcode/upstream.js';
import { accumulateUsage, createUsageAccumulator } from '../adapters/commandcode/usage.js';
import { buildRequestContext } from '../utils/request-context.js';
import { hardenConnectionForLongStream, persistCompletion, writeSSEHeaders, parseEventLine } from './sse-common.js';
import { OpenAIChatRequest } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, ProxyError, toProxyError } from '../utils/errors.js';
import { auditRequestStart, auditRequestEnd, accountTail } from '../utils/audit-log.js';
import { guardRateLimit, recordRequestOutput } from '../utils/rate-limit.js';

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function logCompletion(inputTokens: number, outputTokens: number, startTime: number, model: string, status: 'COMPLETED' | 'FAILED'): void {
  const timing = ((Date.now() - startTime) / 1000).toFixed(3);
  // 状态必须与落库一致。此前这里恒打 COMPLETED，而同一条请求落库是 FAILED ——
  // 拿日志排查失败请求时会得出完全相反的结论。
  logger.info(`Input Tokens ${fmtNum(inputTokens)} | Output Tokens ${fmtNum(outputTokens)} | Timing ${timing}s | Model ${model} | Status ${status}`);
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
    // CORS 预检请求不携带自定义头（含鉴权），必须放行，否则浏览器客户端
    // 在设置 PROXY_API_KEY 后连预检都过不去。
    if (req.method === 'OPTIONS') return;
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
    // 请求防护三件套（默认关闭/旁路，零配置升级承诺）：审计开始计时 + 限流 + 模型访问控制。
    const audit = auditRequestStart(req);
    if (guardRateLimit(req, reply)) return reply;
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
    // 只数真正进上下文的字段：原先 JSON.stringify 整个上行体会把 config 元数据和
    // 图片 base64 也算成 input_tokens（一张截图能量出几十万个假 token）。
    let inputTokens = estimateWireInputTokens(translated);
    const usageAcc = createUsageAccumulator();
    // 非流式也预生成 traceId：响应 id、错误日志、用量记录三者对得上。
    const traceId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    // 会话/项目等归因信息：会话 ID 来自客户端声明，项目为推断（见模块注释）。
    const requestContext = buildRequestContext(req.headers as any, body);

    // 一次请求只落一条用量记录。非流式在 send() 之前就记了 COMPLETED，若 send 抛错会
    // 走进外层 catch 再记一条 FAILED——那会把同一次请求记成两条，样本数与成功率都失真。
    // 上游把「模型不可用 / 区域限制 / 无可用 provider / 网关请求失败」这类失败以 error
    // **事件**的形式发在一个 200 流里，而不是用 HTTP 错误码。这种请求过去会被记成
    // COMPLETED + 0 输出，失败在用量历史里完全看不出来——它比「抛异常」更常见。
    let sawUpstreamError = false;
    const noteUpstreamError = (event: any): void => {
      if (event?.type !== 'error') return;
      const msg = typeof event.error === 'string' ? event.error : event.error?.message;
      if (msg && msg !== 'unknown') {
        sawUpstreamError = true;
        // 这条文本过去只进响应体、从不落日志，导致排查只能靠反推用量历史。
        logger.warn(`[CHAT] Upstream error event | Model ${modelName} | Trace ${traceId} | ${String(msg).slice(0, 300)}`);
      }
    };

    let recorded = false;
    const persistOnce = (status: 'COMPLETED' | 'FAILED', errorCode?: string, traceOverride?: string): void => {
      if (recorded) return;
      recorded = true;
      // 审计落盘与 TPM 出账和用量落库同点收敛：recorded 幂等保证一次请求只记一条。
      auditRequestEnd(audit, { model: modelName, inputTokens: usageAcc.inputTokens, outputTokens: usageAcc.outputTokens, status, accountId: accountTail(apiKey) });
      recordRequestOutput(req, usageAcc.outputTokens);
      persistCompletion(modelName, usageAcc, requestContext, startTime, status, traceOverride ?? traceId, 'chat', errorCode);
    };

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, {
          apiKey,
          abortSignal: abortController.signal,
          onRetry: async () => {
            // auto-quota 模式下重试可能落到一个新账号上。
            // 必须把新 key **返回**给 sendToCC：opts.apiKey 在构造时已快照，就地改局部
            // 变量对下一次尝试没有任何影响（P0-4 的第三层缺陷）。
            if (await checkAndRotateAccountsOnQuota()) {
              apiKey = getActiveApiKey();
              return apiKey;
            }
            return undefined;
          },
        });
      } catch (err: any) {
        if (isAbortError(err) || err?.isAbort) return reply.raw.end();
        const proxyErr = toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
        // 上游在发出任何数据之前就失败了（最典型的是模型不可用的 403/404）。这类请求
        // 过去在用量历史里完全不留痕，面板的失败数因此恒为 0。
        persistOnce('FAILED', proxyErr.code);
        if (body.stream) {
          writeSSEHeaders(reply);
          const state = adapter.createStreamEncoderState(modelName, {
          includeUsage: body.stream_options?.include_usage === true,
          estimatedInputTokens: inputTokens,
        });
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
        const state = adapter.createStreamEncoderState(modelName, {
          includeUsage: body.stream_options?.include_usage === true,
          estimatedInputTokens: inputTokens,
        });
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
            noteUpstreamError(event);
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
          // 输出侧此前漏了：上游不给 usage 时整条按 outputTokens: 0 落库，成本被低估。
          // 编码器本来就按分片在累加估算值（state.outputTokens），拿它兜底；非流式路径
          // 早就是这么做的，两条路径此处应当一致。
          if (!usageAcc.outputTokens) usageAcc.outputTokens = state.outputTokens || 0;
          logCompletion(usageAcc.inputTokens, usageAcc.outputTokens, startTime, modelName, sawUpstreamError ? 'FAILED' : 'COMPLETED');
          // 上游以 error 事件告知失败时，这条请求不该记成 COMPLETED。
          persistOnce(
            sawUpstreamError ? 'FAILED' : 'COMPLETED',
            sawUpstreamError ? ErrorCode.PROVIDER_PROTOCOL_ERROR : undefined,
            state.id,
          );
          reply.raw.end();
        });

        // 流错误只此一处处理，但必须同时挂在两个源上：
        //   - upstreamStream 自身的 'error'；
        //   - readline 的 'error' —— createInterface({input}) 会把 input 流的错误转成
        //     它自己的 'error' 事件，只挂前者会漏，而无监听器的 'error' 直接抛成
        //     未捕获异常（实测日志：[CRITICAL] Uncaught Exception: Upstream exceeded
        //     1.5s total deadline），把一次超时升级成进程级事故。
        let streamErrorHandled = false;
        const handleStreamError = (err: any): void => {
          if (streamErrorHandled) return;
          streamErrorHandled = true;
          if (isAbortError(err) || err?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[CHAT] Stream error | Model ${modelName} | Trace ${state.id} | ${err.message}`);
          // 流中途失败：带上已经累积的 usage 落库（前半段上游很可能已计费，记 0 会低估）。
          // 错误码取上游真实分类——超时与协议错误不该一律记成 PROVIDER_PROTOCOL_ERROR，
          // 与 messages.ts 的 toProxyError 保持一致。
          const proxyErr = toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
          persistOnce('FAILED', proxyErr.code, state.id);
          if (!state.sawFinish) {
            for (const c of adapter.encodeOpenAIChunk({ type: 'error', error: { message: err.message || 'Upstream stream error' } }, state)) {
              reply.raw.write(c);
            }
            for (const c of adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state)) {
              reply.raw.write(c);
            }
          }
          reply.raw.end();
        };
        upstreamStream.on('error', handleStreamError);
        rl.on('error', handleStreamError);

        return reply;
      }

      // ── 非流式 ──
      let fullText = '';
      let reasoningContent = '';
      let outputTokens = 0;
      const toolCallsMap = new Map<string, any>();
      // 分片归属：上游的 tool-call-delta 常常只在首片带 id/name，后续片只给参数片段。
      let currentToolId = '';
      let toolCallSeq = 0;
      // 参数合并：字符串视为片段直接串接，对象按键浅合并后重新序列化。
      const mergeToolArgs = (prev: string, input: any): string => {
        if (typeof input === 'string') return prev + input;
        if (input == null) return prev;
        let base: any;
        try {
          base = prev ? JSON.parse(prev) : {};
        } catch {
          return prev + JSON.stringify(input);
        }
        const b = base && typeof base === 'object' ? base : {};
        const i = typeof input === 'object' ? input : {};
        return JSON.stringify({ ...b, ...i });
      };
      let finishReason = 'stop';

      const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
      for await (const line of rl) {
        const event = parseEventLine(line);
        if (!event) continue;

        accumulateUsage(usageAcc, event);

        if (event.type === 'error') {
          const errMsg = typeof event.error === 'string' ? event.error : event.error?.message;
          if (errMsg && errMsg !== 'unknown') {
            noteUpstreamError(event);
            fullText += `\n[Upstream Error: ${errMsg}]\n`;
          }
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
          const rawId = (event.toolCallId || event.data?.toolCallId) as string | undefined;
          // 一律回落 'call_1' 会让同一回合内的多个工具调用互相覆盖；无 id 的片段
          // 归属到当前这个调用。
          const tcId = rawId || currentToolId || `call_${++toolCallSeq}`;
          currentToolId = tcId;
          const name = ((event.toolName || event.data?.toolName || event.name || event.data?.name) as string) || '';
          // argsText 是 AI-SDK 系 tool-call-delta 的参数片段字段；追加在读取链末尾，
          // 上游不发这个字段时行为与原先逐字相同（纯增量，不改既有语义）。
          const raw = event.input ?? event.data?.input ?? event.arguments ?? event.data?.arguments
            ?? event.argsText ?? event.data?.argsText;
          const prev = toolCallsMap.get(tcId);
          if (!prev) {
            toolCallsMap.set(tcId, {
              id: tcId,
              type: 'function',
              function: {
                name: name || 'tool',
                arguments: raw == null ? '{}' : typeof raw === 'string' ? raw : JSON.stringify(raw),
              },
            });
          } else {
            if (name) prev.function.name = name;
            // 原来这里是 set 覆盖：多片段流式下 arguments 只剩最后一片，客户端拿到
            // 的是解析失败的坏 JSON。按 id 合并，与 adapter.ts 非流式路径一致。
            prev.function.arguments = mergeToolArgs(prev.function.arguments, raw);
          }
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

      logCompletion(inputTokens, outputTokens, startTime, modelName, sawUpstreamError ? 'FAILED' : 'COMPLETED');
      // 本地 output 估算仅在上游未给出 usage 时才需要；有 usage 时以 usageAcc 为准。
      if (!usageAcc.sawUsage) {
        usageAcc.inputTokens = inputTokens;
        usageAcc.outputTokens = outputTokens;
      }
      // 上游以 error 事件告知失败时，这条请求不该记成 COMPLETED（见 sawUpstreamError）。
      persistOnce(
        sawUpstreamError ? 'FAILED' : 'COMPLETED',
        sawUpstreamError ? ErrorCode.PROVIDER_PROTOCOL_ERROR : undefined,
      );

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
          // 缓存命中明细按 OpenAI 语义放在 prompt_tokens_details，客户端据此算缓存折扣。
          prompt_tokens_details: { cached_tokens: usageAcc.cacheReadTokens || 0 },
        },
      });
    } catch (err: any) {
      if (isAbortError(err) || err?.isAbort) return reply.raw.end();
      logger.error(`[CHAT] Fatal request error | Trace ${traceId} | ${err.message}`);
      const proxyErr = toProxyError(err, ErrorCode.INTERNAL_ERROR);
      // 若成功路径已记过 COMPLETED（非流式在 send 之前记），persistOnce 会跳过，
      // 不会把同一次请求记成两条。
      persistOnce('FAILED', proxyErr.code);
      return reply.status(proxyErr.status).send({ error: proxyErr.openAIPayload() });
    }
  });
}
