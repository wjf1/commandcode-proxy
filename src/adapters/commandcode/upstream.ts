import { Readable } from 'node:stream';
import { CCRequestBody } from '../../types/index.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export function stripBearerPrefix(token: string): string {
  return (token || '').replace(/^Bearer\s+/i, '').trim();
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

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
 * Original CLI hv list: terminal billing/plan errors. Retrying these is
 * pointless and just burns quota — fail fast instead.
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
  /** Called before each retry so callers can swap accounts on quota errors. */
  onRetry?: (attempt: number, err: UpstreamError) => void | Promise<void>;
}

/**
 * POST to /alpha/generate and return the SSE body as a Node Readable.
 *
 * Hardening vs v3:
 *  - Retries with exponential backoff on 429/5xx/network errors (v3 failed fast).
 *  - The timeout now covers the WHOLE request lifecycle via an idle watchdog:
 *    it resets on every received chunk instead of being cleared after headers
 *    (v3's bug: a silent mid-stream stall hung forever).
 *  - Client aborts propagate immediately through AbortSignal.any.
 */
export async function sendToCC(body: CCRequestBody, opts: SendOptions): Promise<Readable> {
  const config = loadConfig();
  const url = `${config.ccApiBase}/alpha/generate`;

  // Force auto-accept + streaming — the CLI wire contract expects both.
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

        // Terminal billing/plan errors: never retry (original CLI behavior).
        const terminal = hasTerminalMarker(displayMsg);
        const retryable = !terminal && RETRYABLE_STATUS.has(response.status);
        const err = new UpstreamError(`Upstream error ${response.status}: ${displayMsg}`, response.status, retryable);
        if (retryable && attempt < maxAttempts) {
          lastError = err;
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

      // Wrap the web stream so every chunk re-arms the idle watchdog.
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

      // Network-level failures are worth one retry unless the client left.
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
