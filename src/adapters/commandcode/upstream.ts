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
import { Readable } from 'node:stream';
import { CCRequestBody } from '../../types/index.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

/** 去除 token 前的 Bearer 前缀（大小写不敏感）。 */
export function stripBearerPrefix(token: string): string {
  return (token || '').replace(/^Bearer\s+/i, '').trim();
}

/** 粗略 token 估算：约 4 个字符 = 1 个 token。 */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
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

export class UpstreamError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
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

/**
 * 原版 CLI 的 hv 列表：终止性的计费/套餐错误。对这些错误重试毫无意义，
 * 只会白白消耗额度 —— 应当快速失败。
 */
const TERMINAL_ERROR_MARKERS = ['premium_credits_exhausted', 'model_not_in_plan', 'insufficient credits'];

function hasTerminalMarker(message: string): boolean {
  const lower = message.toLowerCase();
  return TERMINAL_ERROR_MARKERS.some(m => lower.includes(m));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface SendOptions {
  apiKey: string;
  abortSignal?: AbortSignal;
  /** 每次重试前回调，调用方可在额度错误时切换账号。 */
  onRetry?: (attempt: number, err: UpstreamError) => void | Promise<void>;
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
  const url = `${config.ccApiBase}/alpha/generate`;

  // 强制 auto-accept + 流式 —— CLI wire 契约要求两者。
  body.permissionMode = 'auto-accept';
  body.params.stream = true;

  const headers = buildHeaders(opts.apiKey, config.ccVersion, body);
  const reqData = JSON.stringify(body);

  const maxAttempts = Math.max(1, config.maxRetries + 1);
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutController = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    let idleFired = false;

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
        logger.error(`[UPSTREAM] Model: ${body.params.model} | Error ${response.status}: ${displayMsg}`);

        // 终止性计费/套餐错误：永不重试（原版 CLI 行为）。
        const terminal = hasTerminalMarker(displayMsg);
        const retryable = !terminal && RETRYABLE_STATUS.has(response.status);
        const err = new UpstreamError(`Upstream error ${response.status}: ${displayMsg}`, response.status, retryable);
        if (retryable && attempt < maxAttempts) {
          lastError = err;
          // 指数退避：500ms * 2^(attempt-1)，封顶 8s。
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          logger.warn(`[UPSTREAM] Retryable ${response.status}, retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
          await sleep(backoffMs);
          continue;
        }
        throw err;
      }

      if (!response.body) {
        throw new UpstreamError('Upstream response body is null');
      }

      // 把 web stream 包装成 Node 流：每收到一个 chunk 都重置空闲看门狗。
      const nodeStream = Readable.fromWeb(response.body as any);
      armIdleWatchdog();
      nodeStream.on('data', () => armIdleWatchdog());
      nodeStream.on('close', () => {
        if (idleTimer) clearTimeout(idleTimer);
      });
      nodeStream.on('error', () => {
        if (idleTimer) clearTimeout(idleTimer);
      });

      return nodeStream;
    } catch (err: any) {
      if (idleTimer) clearTimeout(idleTimer);

      if (isAbortError(err)) {
        if (idleFired) {
          throw new UpstreamError(`Upstream stalled: no data for ${config.idleTimeoutMs / 1000}s`, undefined, true);
        }
        throw Object.assign(new Error('__ABORT__'), { isAbort: true });
      }

      lastError = err;

      // 网络级失败值得再试一次，除非客户端已离开。
      if (opts.abortSignal?.aborted) {
        throw Object.assign(new Error('__ABORT__'), { isAbort: true });
      }
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
        logger.warn(`[UPSTREAM] Network error (${err.message}), retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }

      const detailedMsg = err?.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
      throw new UpstreamError(`Upstream connection failed: ${detailedMsg}`);
    }
  }

  throw lastError ? new UpstreamError(`Upstream failed after ${maxAttempts} attempts: ${lastError.message}`) : new UpstreamError('Upstream failed');
}
