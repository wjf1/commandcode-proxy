// =============================================================================
// CommandCode 上游 HTTP 客户端
// -----------------------------------------------------------------------------
// 职责：把翻译好的 CC wire 请求体 POST 到上游 /alpha/generate，返回可读的
//      Node Readable 流（SSE）。相比 v3 的加固点：
//   - 指数退避重试：429/5xx/网络错误可重试（v3 失败即崩溃）
//   - 空闲看门狗（idle watchdog）：超时覆盖"整个请求生命周期"，每个 chunk
//     到达都会重置计时器 —— 修复 v3 无声卡死（收到 header 后静默挂起）的 bug
//   - 客户端断开立即通过 AbortSignal.any 传播中止
//   - 终止性计费/套餐错误（terminal errors）不重试，直接快速失败以节省额度
// =============================================================================
import { Readable, PassThrough } from 'node:stream';
import { CCRequestBody } from '../../types/index.js';
import { loadConfig, assertSafeUpstreamUrl } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { ErrorCode, ProxyError, codeForStatus, terminalCodeFor, type ErrorCodeName } from '../../utils/errors.js';

/** 去除 token 前的 Bearer 前缀（大小写不敏感）。 */
export function stripBearerPrefix(token: string): string {
  return (token || '').replace(/^Bearer\s+/i, '').trim();
}

/**
 * CJK 感知的文本 token 估算。
 * "4 字符 = 1 token" 对英文成立，但中文约 1-1.6 字符/token，按 4 字符折算会
 * 低估数倍。这里 CJK 字符按 1 字 1 token、其余按 4 字符 1 token 估算。
 * 仅用于上游未回 usage 时的兜底口径，不参与计费。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 判断一个错误是否为"客户端/上游中止"类错误，用于决定是否放弃重试。 */
export function isAbortError(err: any): boolean {
  if (!err) return false;
  if (err.isAbort) return true;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20) return true;
  if (err.message && (err.message === 'This operation was aborted' || err.message === '__ABORT__' || String(err.message).toLowerCase().includes('abort'))) {
    return true;
  }
  if (err.cause) {
    const c = err.cause;
    if (c.name === 'AbortError' || c.code === 'ABORT_ERR' || c.code === 20) return true;
    if (c.message && String(c.message).toLowerCase().includes('abort')) return true;
  }
  return false;
}

/**
 * 上游失败。继承 ProxyError，因此在原有的 status / retryable 之上，
 * 还带一个稳定错误码与可执行提示（OpenAI / Anthropic 出口共用）。
 */
export class UpstreamError extends ProxyError {
  constructor(message: string, status?: number, retryable = false, code?: ErrorCodeName) {
    super(code ?? codeForStatus(status), message, { status, retryable });
    this.name = 'UpstreamError';
  }
}

/**
 * 构造请求上游所需的头。
 * 其中 x-session-id / x-project-slug / x-command-code-version / x-cli-environment
 * 等是 CLI 上送、用于服务端识别/限流/计费的指纹头，需保持与 CLI 一致。
 */
export function buildHeaders(apiKey: string, ccVersion: string, body: CCRequestBody): Record<string, string> {
  const cleanKey = stripBearerPrefix(apiKey);
  const sessionId = body.threadId;
  const baseDir = String(body.config?.workingDir || process.cwd()).split(/[/\\]/).filter(Boolean).pop() ?? 'commandcode-proxy';
  const projectSlug = baseDir.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'commandcode-proxy';

  return {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    ...(cleanKey ? { Authorization: `Bearer ${cleanKey}` } : {}),
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
    'x-session-id': sessionId || '',
    'x-project-slug': projectSlug,
    'x-taste-learning': 'false',
    'x-co-flag': 'false',
  };
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// ─── 上游并发上限 ────────────────────────────────────────────────────────────
// 防止失控客户端同时压起大量长流拖垮进程/额度。默认 0 = 不限制（兼容既有
// 部署）；MAX_UPSTREAM_CONCURRENCY 设为正整数后，超限请求立即以
// GATEWAY_BUSY(503) 快速失败，不排队。
const MAX_UPSTREAM_CONCURRENCY = (() => {
  const n = parseInt(process.env.MAX_UPSTREAM_CONCURRENCY || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
let activeUpstreamRequests = 0;

/**
 * 是否允许重试：状态码可重试，且错误文本未命中终止性（计费/套餐）标记
 * —— premium_credits_exhausted / model_not_in_plan / insufficient credits
 * 重试只会白耗额度，应当快速失败（原版 CLI 行为）。
 * 判定集中在此处，便于单测锁定该契约。
 */
export function isRetryableFailure(status: number, message: string): boolean {
  return terminalCodeFor(message) === undefined && RETRYABLE_STATUS.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface SendOptions {
  apiKey: string;
  abortSignal?: AbortSignal;
  /**
   * 每次重试前回调，调用方可在额度错误时切换账号。
   *
   * 返回**下一次尝试要用的 apiKey**；返回 undefined / 不返回表示沿用当前 key。
   * 之所以要返回而不是就地改外部变量：apiKey 在本对象构造时已被快照，回调再去改
   * 调用方的局部变量对这里没有任何影响。
   */
  onRetry?: (attempt: number, err: Error) => string | undefined | Promise<string | undefined>;
  /**
   * 流内事件的预判钩子：决定「丢弃本次调用重试」还是「放行给调用方」。
   *
   * 上游会把「模型不可用 / 区域受限 / 网关请求失败」这类失败以 error 事件发在一个
   * **HTTP 200** 的流里，而 HTTP 层的重试只覆盖非 2xx，够不到它。返回 'retry' 时本次
   * 调用会被丢弃并按同一套退避重试。
   *
   * 判定在**向调用方交还流之前**完成，此时客户端一个字节都还没收到，重试不会造成重复。
   * 判据是「内容之前出现可重试的 error」，不是「第一个事件」—— CC 的流以一个 start
   * 事件开场，用「首事件」判定等于永不触发。
   */
  probeEvents?: (rawEventData: string) => 'retry' | 'accept' | 'ignore';
}

/**
 * error 事件里的错误文本是否值得重试。
 *
 * 只重试「看起来是瞬时」的失败：网关请求失败、服务过载、无可用 provider —— 这些随时段
 * 与容量波动，下一次很可能就好了。确定性不可用的（区域限制、模型/provider 不认识）
 * 重试只会白耗额度：本机实测的失败请求带着 29 万 token 上下文，单次就是 $0.087，
 * 白重试两次是 $0.26 换一个必然相同的错误。
 *
 * 计费/套餐类终止错误复用既有的 terminalCodeFor 判定，不在这里重复维护模式表。
 */
export function isRetryableEventMessage(message: string): boolean {
  const m = (message || '').trim();
  if (!m) return false;
  if (terminalCodeFor(m) !== undefined) return false;
  const lower = m.toLowerCase();
  return !DETERMINISTIC_UNAVAILABLE.some(s => lower.includes(s));
}

/** error 事件里代表「确定性不可用」的文本特征（全小写比较）。 */
const DETERMINISTIC_UNAVAILABLE = [
  'not available in your region',
  'not available in your country',
  'model/provider not recognized',
  'not in your plan',
  'model_not_in_plan',
  'does not exist',
  'invalid api key',
];

/** 携带内容或会改变客户端流状态、一旦转发就不能再重来的 CC 事件类型。 */
const CONTENT_EVENT_TYPES = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-call',
  'tool-call-delta',
  'finish',
  'finish-step',
]);

/**
 * 判定单个 CC 事件在「能否丢弃重试」上的含义。
 *   - error 且消息可重试 → 'retry'（上游还没产出任何内容就失败了）
 *   - error 但确定性不可用 → 'accept'（重试也白搭，按既有逻辑原样交出去）
 *   - 内容类事件 → 'accept'（已经开始产出，不能再丢）
 *   - 其余（start / 保活 / 未知元数据）→ 'ignore'（不影响判定，继续看）
 */
export function classifyProbeEvent(event: any): 'retry' | 'accept' | 'ignore' {
  if (!event || typeof event.type !== 'string') return 'ignore';
  if (event.type === 'error') {
    const errObj = event.error ?? event;
    const msg = typeof errObj === 'string' ? errObj : errObj?.message;
    return isRetryableEventMessage(msg || '') ? 'retry' : 'accept';
  }
  return CONTENT_EVENT_TYPES.has(event.type) ? 'accept' : 'ignore';
}

/**
 * 扫描已累积文本里**完整的行**并按顺序判定。
 * 最后一段可能是被截断的半行，不能判定，留给下一次数据到达。
 * 返回已扫描到的行号，避免重复判定同一行。
 */
export function classifyBuffered(
  text: string,
  alreadyScanned: number,
): { verdict: 'retry' | 'accept' | 'ignore'; scanned: number } {
  const lines = text.split('\n');
  const complete = lines.length - 1;
  for (let i = alreadyScanned; i < complete; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const payload = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!payload || payload === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue; // 注释行或非法 JSON，跳过
    }
    const verdict = classifyProbeEvent(ev);
    if (verdict !== 'ignore') return { verdict, scanned: complete };
  }
  return { verdict: 'ignore', scanned: complete };
}

/** 探测缓冲的字节上限：还没攒出可判定的事件就别再攒了，直接放行。 */
const PROBE_MAX_BYTES = 64 * 1024;
/** 探测的时间上限：上游迟迟不吐可判定的事件就放行，不为判别而拖住请求。 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * 从已累积文本里取第一个完整的 SSE 事件负载。
 * 返回 found=false 表示还没攒到完整事件（最后一段可能是被截断的半行，不能判定）。
 */
export function firstEventPayload(text: string): { found: boolean; payload?: string } {
  const lines = text.split('\n');
  for (const line of lines.slice(0, -1)) {
    const t = line.trim();
    if (!t || t.startsWith(':')) continue; // 空行 / SSE 注释（保活）
    const payload = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!payload || payload === '[DONE]') continue;
    return { found: true, payload };
  }
  return { found: false };
}

/**
 * 预读流开头，判定「上游是否在产出任何内容之前就报错了」。
 *
 * 已读字节不会丢：判定为放行时把它们写回返回流的最前面，其余原样透传。预读期间会
 * `pause()`，确保从摘掉监听器到接上管道之间不会有 chunk 落在空档里被丢掉。
 */
async function probeUpstream(raw: Readable): Promise<{ rejected: boolean; stream: Readable }> {
  const head: Buffer[] = [];
  const state: { verdict: 'retry' | 'accept' | 'ignore' } = { verdict: 'ignore' };
  let scannedLines = 0;
  let consumedBytes = 0;

  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      // 先暂停再摘监听器：否则空档期到达的 chunk 会流向已无消费者的流而丢失。
      raw.pause();
      raw.off('data', onData);
      raw.off('end', finish);
      raw.off('close', finish);
      raw.off('error', finish);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      head.push(buf);
      consumedBytes += buf.length;
      const text = Buffer.concat(head).toString('utf8');
      const res = classifyBuffered(text, scannedLines);
      scannedLines = res.scanned;
      if (res.verdict !== 'ignore') {
        state.verdict = res.verdict;
        finish();
      } else if (consumedBytes > PROBE_MAX_BYTES) {
        finish(); // 攒不出可判定的事件，放行
      }
    };
    // finish 只会在计时器触发或数据事件里被调用，那时 timer 已初始化。
    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    raw.on('data', onData);
    raw.once('end', finish);
    raw.once('close', finish);
    raw.once('error', finish);
  });

  if (state.verdict === 'retry') {
    raw.destroy();
    return { rejected: true, stream: raw };
  }
  return { rejected: false, stream: reflow(raw, head) };
}

/** 把预读到的字节放在新流的最前面，其余从原流透传。 */
function reflow(raw: Readable, head: Buffer[]): Readable {
  const out = new PassThrough();
  const buffered = Buffer.concat(head);
  if (buffered.length) out.write(buffered);
  const errored = (raw as any).errored;
  if (errored) {
    out.destroy(errored);
  } else if (raw.readableEnded || raw.destroyed) {
    out.end(); // 极短响应：预读期间就已结束，别让下游等一个永不到来的 end
  } else {
    raw.on('error', e => out.destroy(e));
    raw.pipe(out); // pipe 会自动 resume
  }
  return out;
}

/**
 * POST 到 /alpha/generate，并把 SSE 响应体包装为 Node Readable 流返回。
 *
 * 相比 v3 的加固：
 *  - 对 429/5xx/网络错误做指数退避重试（v3 失败即崩）。
 *  - 超时现在通过"空闲看门狗"覆盖整个请求生命周期：每收到一个 chunk 就重置
 *    计时器，而不是收到 header 后就清除（v3 的 bug：中途静默卡死会无限挂起）。
 *  - 客户端中止通过 AbortSignal.any 立即传播。
 */
export async function sendToCC(body: CCRequestBody, opts: SendOptions): Promise<Readable> {
  const config = loadConfig();
  let url: string;
  try {
    url = assertSafeUpstreamUrl(`${config.ccApiBase}/alpha/generate`).toString();
  } catch (err: any) {
    logger.error(`[UPSTREAM] Blocked unsafe upstream URL: ${err.message}`);
    throw new UpstreamError(`Unsafe upstream URL: ${err.message}`, undefined, false, ErrorCode.BLOCKED_HOST);
  }

  // 强制 auto-accept + 流式 —— CLI wire 契约要求两者。
  body.permissionMode = 'auto-accept';
  body.params.stream = true;

  // headers 必须在重试循环**内部**构建：onRetry 换账号后，旧 key 不能再用于下一次尝试。
  let currentApiKey = opts.apiKey;
  const reqData = JSON.stringify(body);

  // 切号失败（轮换回调自己打上游打挂）不该让本次重试作废，因此只记日志不抛。
  const maybeSwitchAccount = async (attempt: number, err: Error): Promise<void> => {
    if (!opts.onRetry) return;
    try {
      const next = await opts.onRetry(attempt, err);
      if (next && next !== currentApiKey) {
        currentApiKey = next;
        logger.info(`[UPSTREAM] Thread ${body.threadId} | Account switched on retry ${attempt} (key tail ${String(next).slice(-4)})`);
      }
    } catch (cbErr: any) {
      logger.warn(`[UPSTREAM] onRetry callback failed: ${cbErr?.message || cbErr}`);
    }
  };

  if (MAX_UPSTREAM_CONCURRENCY > 0) {
    if (activeUpstreamRequests >= MAX_UPSTREAM_CONCURRENCY) {
      throw new UpstreamError(
        `Upstream concurrency limit reached (${MAX_UPSTREAM_CONCURRENCY}); ` +
        `raise MAX_UPSTREAM_CONCURRENCY or retry later`,
        503,
        false,
        ErrorCode.GATEWAY_BUSY,
      );
    }
    activeUpstreamRequests++;
  }
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased || MAX_UPSTREAM_CONCURRENCY === 0) return;
    slotReleased = true;
    activeUpstreamRequests--;
  };

  const maxAttempts = Math.max(1, config.maxRetries + 1);
  let lastError: any;

  // 循环内任何 throw 都先释放并发槽位；成功路径的释放挂在返回流的 close/error 上。
  try {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = buildHeaders(currentApiKey, config.ccVersion, body);
    const timeoutController = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    let idleFired = false;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let deadlineFired = false;

    // 挂钟总时限（upstream.timeoutMs）。与空闲看门狗的本质区别：看门狗每收到一个字节
    // 就会重置，所以一个持续 trickle 的上游可以无限期挂住连接；这个上限跨"等响应头"
    // 与"读流"两个阶段一次性生效，直到流结束才撤销。
    //
    // 注意：这是一次**行为变更**——修复前该配置完全不起作用，任何长度超过 timeoutMs
    // 的长推理请求都是靠它不被执行才活下来的。
    const armDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        timeoutController.abort(new Error(`Upstream exceeded ${config.upstreamTimeoutMs / 1000}s total deadline`));
      }, config.upstreamTimeoutMs);
      deadlineTimer.unref?.();
    };
    armDeadline();

    const disarmDeadline = () => {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
    };

    // 空闲看门狗：每次被调用都会重置计时器。一旦上游超过 idleTimeoutMs 无数据，
    // 主动 abort 本次请求并标记 idleFired，抛"上游卡死"错误。
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        timeoutController.abort(new Error(`No data from upstream for ${config.idleTimeoutMs / 1000}s`));
      }, config.idleTimeoutMs);
    };

    try {
      const combinedSignal = opts.abortSignal
        ? (AbortSignal as any).any
          ? (AbortSignal as any).any([opts.abortSignal, timeoutController.signal])
          : timeoutController.signal
        : timeoutController.signal;

      if (opts.abortSignal && !(AbortSignal as any).any) {
        opts.abortSignal.addEventListener('abort', () => timeoutController.abort(), { once: true });
      }

      armIdleWatchdog();

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: reqData,
        signal: combinedSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let parsedMsg = '';
        try {
          parsedMsg = JSON.parse(errorText).message || JSON.parse(errorText)?.error?.message || '';
        } catch {}
        const displayMsg = parsedMsg || errorText.slice(0, 200);
        logger.error(`[UPSTREAM] Model: ${body.params.model} | Thread ${body.threadId} | Error ${response.status}: ${displayMsg}`);

        // 终止性计费/套餐错误：永不重试（原版 CLI 行为）。
        const retryable = isRetryableFailure(response.status, displayMsg);
        const err = new UpstreamError(
          `Upstream error ${response.status}: ${displayMsg}`,
          response.status,
          retryable,
          terminalCodeFor(displayMsg) ?? codeForStatus(response.status),
        );
        if (retryable && attempt < maxAttempts) {
          lastError = err;
          await maybeSwitchAccount(attempt, err);
          // 指数退避：500ms * 2^(attempt-1)，封顶 8s。
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          logger.warn(`[UPSTREAM] Retryable ${response.status}, retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
          await sleep(backoffMs);
          continue;
        }
        throw err;
      }

      if (!response.body) {
        throw new UpstreamError('Upstream response body is null', undefined, false, ErrorCode.PROVIDER_PROTOCOL_ERROR);
      }

      // 把 web stream 包装成 Node 流：每收到一个 chunk 都重置空闲看门狗。
      const rawStream = Readable.fromWeb(response.body as any);
      armIdleWatchdog();
      rawStream.on('data', () => armIdleWatchdog());
      // 被首事件探测判定为「上游以 200 报错」而丢弃的流，不要把并发槽位还回去 ——
      // 槽位要留给紧随其后的那次重试（槽位在整个 sendToCC 调用里只申请一次）。
      let discarded = false;
      const onStreamGone = () => {
        if (idleTimer) clearTimeout(idleTimer);
        disarmDeadline();
        if (!discarded) releaseSlot();
      };
      rawStream.on('close', onStreamGone);
      rawStream.on('error', onStreamGone);

      // 上游以 error 事件报错（模型不可用 / 区域受限 / 网关请求失败）时，这次调用实际
      // 什么都没产出，而此刻客户端还没收到任何字节 —— 丢弃重试是安全的。
      //
      // 只在**还有重试预算**时才探测：最后一次尝试直接放行，让调用方按既有逻辑处理
      // （把错误并入流）。这样本机制是纯增量——只多试几次，不改对客户端的契约。
      if (attempt < maxAttempts) {
        const probe = await probeUpstream(rawStream);
        if (probe.rejected) {
          discarded = true;
          rawStream.destroy();
          throw new UpstreamError(
            `Upstream reported an error event before producing any content (model ${body.params.model})`,
            undefined,
            true,
            ErrorCode.PROVIDER_PROTOCOL_ERROR,
          );
        }
        armIdleWatchdog();
        return probe.stream;
      }

      return rawStream;
    } catch (err: any) {
      if (idleTimer) clearTimeout(idleTimer);
      disarmDeadline();

      // 挂钟上限先于空闲判定：两者的 abort 都走 isAbortError，但成因与错误码不同。
      if (deadlineFired) {
        throw new UpstreamError(
          `Upstream exceeded ${config.upstreamTimeoutMs / 1000}s total deadline`,
          504,
          false,
          ErrorCode.REQUEST_TIMEOUT,
        );
      }

      if (isAbortError(err)) {
        if (idleFired) {
          throw new UpstreamError(`Upstream stalled: no data for ${config.idleTimeoutMs / 1000}s`, undefined, true, ErrorCode.STREAM_IDLE_TIMEOUT);
        }
        throw Object.assign(new Error('__ABORT__'), { isAbort: true });
      }

      lastError = err;

      // 网络级失败值得再试一次，除非客户端已离开。
      if (opts.abortSignal?.aborted) {
        throw Object.assign(new Error('__ABORT__'), { isAbort: true });
      }
      if (err instanceof UpstreamError && !err.retryable) {
        // Terminal errors (e.g. MODEL_NOT_IN_PLAN / premium_credits_exhausted): fail fast, do not retry.
        throw err;
      }
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
        logger.warn(`[UPSTREAM] Thread ${body.threadId} | Upstream failure (${err.message}), retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
        await maybeSwitchAccount(attempt, err);
        await sleep(backoffMs);
        continue;
      }

      if (err instanceof UpstreamError) {
        // 重试次数用尽：保留上游真实状态码与错误码。若一律包装成
        // "connection failed"，客户端会把 3 次 503 误判成网络故障。
        throw new UpstreamError(err.message, err.status, false, err.code);
      }
      const detailedMsg = err?.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
      throw new UpstreamError(`Upstream connection failed: ${detailedMsg}`, undefined, false, ErrorCode.NETWORK_ERROR);
    }
  }

  if (lastError instanceof UpstreamError) {
    throw new UpstreamError(
      `Upstream failed after ${maxAttempts} attempts: ${lastError.message}`,
      lastError.status,
      false,
      lastError.code,
    );
  }
  throw new UpstreamError('Upstream failed', undefined, false, ErrorCode.NETWORK_ERROR);
  } catch (err) {
    releaseSlot();
    throw err;
  }
}
