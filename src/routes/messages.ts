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
import { sendToCC, isAbortError, estimateTextTokens, estimateWireInputTokens, IMAGE_TOKEN_ALLOWANCE } from '../adapters/commandcode/upstream.js';
import { accumulateUsage, createUsageAccumulator, toAnthropicUsage } from '../adapters/commandcode/usage.js';
import { buildRequestContext, systemTextOf } from '../utils/request-context.js';
import { hardenConnectionForLongStream, persistCompletion, writeSSEHeaders, parseEventLine } from './sse-common.js';
import { AnthropicRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning, checkAndRotateAccountsOnQuota } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, ProxyError, toProxyError } from '../utils/errors.js';
import { auditRequestStart, auditRequestEnd, accountTail } from '../utils/audit-log.js';
import { guardRateLimit, recordRequestOutput } from '../utils/rate-limit.js';
import { guardModelAccess } from '../utils/model-access.js';

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
    // 工具 schema 也进上下文，Anthropic 的 count_tokens 口径本来就包含它。
    if (Array.isArray(body.tools) && body.tools.length) text += JSON.stringify(body.tools) + '\n';
    let images = 0;
    // tool_result 的 content 既可以是字符串，也可以是 [{type:'text'|'image'}] 数组 ——
    // 而**数组形态才是 agent 上下文的主体**（文件内容、命令输出、截图）。此前只认
    // 字符串，这块被整个漏掉，于是 count_tokens 大幅低报：客户端以为无需压缩上下文，
    // 最后由上游以 context length 超限报错。
    const countBlocks = (blocks: any[]): void => {
      for (const b of blocks || []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') text += (b.text || '') + '\n';
        else if (b.type === 'thinking') text += (b.thinking || '') + '\n';
        else if (b.type === 'image' || b.type === 'image_url') images++;
        else if (b.type === 'tool_use') text += `${b.name || ''} ${JSON.stringify(b.input ?? {})}\n`;
        else if (b.type === 'tool_result') {
          if (typeof b.content === 'string') text += b.content + '\n';
          else if (Array.isArray(b.content)) countBlocks(b.content);
        }
      }
    };
    for (const m of body.messages || []) {
      countBlocks(typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []));
      text += '\n';
    }
    return { input_tokens: estimateTextTokens(text) + images * IMAGE_TOKEN_ALLOWANCE };
  });

  fastify.post('/v1/messages', async (req, reply) => {
    // 请求防护三件套（默认关闭/旁路，零配置升级承诺）：审计开始计时 + 限流 + 模型访问控制。
    const audit = auditRequestStart(req);
    if (guardRateLimit(req, reply)) return reply;
    if (guardModelAccess(req, reply)) return reply;
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
    // 只数真正进上下文的字段：原先 JSON.stringify 整个上行体会把 config 元数据和
    // 图片 base64 也算成 input_tokens（一张截图能量出几十万个假 token）。
    let inputTokens = estimateWireInputTokens(translated);
    const usageAcc = createUsageAccumulator();
    // 会话/项目等归因信息：会话 ID 来自客户端声明，项目为推断（见模块注释）。
    const requestContext = buildRequestContext(req.headers as any, body);

    // 一次请求只落一条用量记录：非流式在 send() 之前就记了 COMPLETED，若 send 抛错会走进
    // 外层 catch 再记一条 FAILED，把同一次请求记成两条，样本数与成功率都会失真。
    let recorded = false;
    const persistOnce = (status: 'COMPLETED' | 'FAILED', errorCode?: string): void => {
      if (recorded) return;
      recorded = true;
      // 审计落盘与 TPM 出账和用量落库同点收敛：recorded 幂等保证一次请求只记一条。
      auditRequestEnd(audit, { model: modelName, inputTokens: usageAcc.inputTokens, outputTokens: usageAcc.outputTokens, status, accountId: accountTail(apiKey) });
      recordRequestOutput(req, usageAcc.outputTokens);
      persistCompletion(modelName, usageAcc, requestContext, startTime, status, msgId, 'messages', errorCode);
    };

    // 上游把「模型不可用 / 区域限制 / 无可用 provider / 网关请求失败」这类失败以 error
    // **事件**的形式发在一个 200 流里，而不是用 HTTP 错误码。这种请求过去会被记成
    // COMPLETED + 0 输出，失败在用量历史里完全看不出来——它比「抛异常」更常见。
    let sawUpstreamError = false;
    const noteUpstreamError = (event: any): void => {
      if (event?.type !== 'error') return;
      const errObj = event.error ?? event;
      const msg = typeof errObj === 'string' ? errObj : errObj?.message;
      if (msg && msg !== 'unknown') {
        sawUpstreamError = true;
        // 这条文本过去只进响应体、从不落日志，导致排查只能靠反推用量历史。
        logger.warn(`[MESSAGES] Upstream error event | Model ${modelName} | Trace ${msgId} | ${String(msg).slice(0, 300)}`);
      }
    };

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, {
          apiKey,
          abortSignal: abortController.signal,
          onRetry: async () => {
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
        // 上游在发出任何数据之前就失败（最典型的是模型不可用的 403/404）。这类请求过去
        // 在用量历史里完全不留痕，面板的失败数因此结构性恒为 0。
        persistOnce('FAILED', proxyErr.code);
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
              // 此处缓存明细尚不可知（上游收尾才给），只是个占位估算，收尾
              // message_delta 会用 toAnthropicUsage 的真实值覆盖掉。
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

        // tool_use 按 id 复用同一个块。此前每个 tool-call-delta 分片都各自发一轮
        // content_block_start/delta/stop 并递增索引：N 个分片就变成 N 个同 id 的块、
        // 各带一段 JSON 碎片，Anthropic SDK 聚合出来的是坏 input —— 而 adapter.ts
        // 非流式路径是按 id 合并的，同一份上游流在两条编码路径下结论不同。
        interface ToolBlock { index: number; name: string; open: boolean }
        const toolBlocks = new Map<string, ToolBlock>();
        let currentToolId = '';
        const closeToolBlocks = () => {
          for (const b of toolBlocks.values()) {
            if (!b.open) continue;
            b.open = false;
            reply.raw.write(sse('content_block_stop', { type: 'content_block_stop', index: b.index }));
          }
        };

        const openTextBlock = () => {
          if (textBlockOpen) return;
          // 块必须先后天闭合：Anthropic 客户端按 start/stop 配对来切内容块。
          closeToolBlocks();
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
          closeToolBlocks();
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
          noteUpstreamError(event);

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
            const rawId = (event.toolCallId || event.data?.toolCallId) as string | undefined;
            // 无 id 的分片归属到当前调用；还没有任何调用时才造一个新 id。
            const toolCallId = rawId || currentToolId || `toolu_${crypto.randomUUID().slice(0, 8)}`;
            currentToolId = toolCallId;
            const toolName = ((event.toolName || event.data?.toolName || event.name || event.data?.name) as string) || '';
            // argsText：AI-SDK 系 tool-call-delta 的参数片段字段。读取链末尾追加，
            // 上游不发这个字段时行为与原先逐字相同（纯增量）。
            const raw = event.input ?? event.data?.input ?? event.argsText ?? event.data?.argsText;
            const partialJson = raw == null
              ? (event.type === 'tool-call-delta' ? '' : '{}')
              : (typeof raw === 'string' ? raw : JSON.stringify(raw));
            let block = toolBlocks.get(toolCallId);
            if (!block) {
              block = { index: toolBlockIndex++, name: toolName || 'tool', open: true };
              toolBlocks.set(toolCallId, block);
              reply.raw.write(
                sse('content_block_start', {
                  type: 'content_block_start',
                  index: block.index,
                  content_block: { type: 'tool_use', id: toolCallId, name: block.name, input: {} },
                })
              );
            }
            // 同一调用只发一次 start，其余分片全部走 input_json_delta 追加，
            // 客户端按序拼接即是完整 JSON。
            if (partialJson) {
              reply.raw.write(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: block.index,
                  delta: { type: 'input_json_delta', partial_json: partialJson },
                })
              );
            }
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
          // 最后一个 tool_use 块只能在这里闭合：流式期间它一直开着等后续分片。
          closeToolBlocks();
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
              // 输入侧用量只有上游收尾的 finish 事件才给得准（message_start 里发的
              // 是本地估算）。这里按 Anthropic 规范补报：input_tokens 只算未命中缓存
              // 的输入，缓存明细单列，三者相加才是输入总量 —— 详见 toAnthropicUsage。
              usage: {
                ...toAnthropicUsage(usageAcc),
                output_tokens: outputTokens,
              },
            })
          );
          reply.raw.write(sse('message_stop', { type: 'message_stop' }));
          const timing = ((Date.now() - startTime) / 1000).toFixed(3);
          const finalStatus = sawUpstreamError ? 'FAILED' : 'COMPLETED';
          logger.info(
            `Input Tokens ${inputTokens.toLocaleString('en-US')} | Output Tokens ${outputTokens.toLocaleString('en-US')} | Timing ${timing}s | Model ${modelName} | Status ${finalStatus}`
          );
          // 上游以 error 事件告知失败时，这条请求不该记成 COMPLETED（见 sawUpstreamError）。
          persistOnce(finalStatus, sawUpstreamError ? ErrorCode.PROVIDER_PROTOCOL_ERROR : undefined);
          reply.raw.end();
        });

        // 与 chat.ts 同理：readline 会把 input 流的错误转成它自己的 'error'，
        // 只挂 upstreamStream 会漏，而无监听器的 'error' 会抛成未捕获异常。
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
          logger.error(`[MESSAGES] Upstream stream error | Trace ${msgId} | ${err.message}`);
          closeThinkingBlock();
          closeTextBlock();
          closeToolBlocks();
          const proxyErr = toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
          // 流中途失败：带上已累积的 usage 落库（前半段上游很可能已计费，记 0 会低估）。
          persistOnce('FAILED', proxyErr.code);
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
        };
        upstreamStream.on('error', handleStreamError);
        rl.on('error', handleStreamError);

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
          noteUpstreamError(event);
        }
      }

      const message = adapter.buildAnthropicResponse(events, msgId, modelName, inputTokens);
      // 日志与仪表盘保持同一口径：报输入**总量**（未命中 + 缓存读/写），而不是报文里
      // 那个按 Anthropic 规范只算未命中部分的 input_tokens。
      const logInputTokens =
        message.usage.input_tokens +
        message.usage.cache_read_input_tokens +
        message.usage.cache_creation_input_tokens;
      const nonStreamStatus = sawUpstreamError ? 'FAILED' : 'COMPLETED';
      logger.info(
        `Input Tokens ${logInputTokens.toLocaleString('en-US')} | Output Tokens ${message.usage.output_tokens.toLocaleString('en-US')} | Timing ${((Date.now() - startTime) / 1000).toFixed(3)}s | Model ${modelName} | Status ${nonStreamStatus}`
      );
      if (!usageAcc.sawUsage) {
        usageAcc.inputTokens = message.usage.input_tokens;
        usageAcc.outputTokens = message.usage.output_tokens;
      }
      persistOnce(nonStreamStatus, sawUpstreamError ? ErrorCode.PROVIDER_PROTOCOL_ERROR : undefined);
      return reply.send(message);
    } catch (err: any) {
      if (isAbortError(err) || err?.isAbort) return reply.raw.end();
      logger.error(`[MESSAGES] Request failed | Trace ${msgId} | ${err.message}`);
      const proxyErr = toProxyError(err, ErrorCode.INTERNAL_ERROR);
      // 若成功路径已记过 COMPLETED，persistOnce 会跳过，不会把同一次请求记成两条。
      persistOnce('FAILED', proxyErr.code);
      return reply.status(proxyErr.status).send(proxyErr.anthropicPayload());
    }
  });
}
