// =============================================================================
// 流水线阶段 3：响应处理与错误分类
// -----------------------------------------------------------------------------
// 职责：
//   1. 非 2xx 响应的分类与决策（handleUpstreamErrorStatus）：解析错误文本、
//      终止性/可重试判定、退避计算。
//   2. catch 块错误的成因分类（classifyCaughtError）：挂钟上限 / 空闲卡死 /
//      客户端中止 / 一般失败，四者错误码与语义不同。
//   3. 重试预算用尽时的终态包装（finalizeAttemptFailure）与退避公式（backoffMsFor）。
//
// 状态归属：本模块是无状态纯函数集合；"是否继续重试"的 continue/throw 控制流、
// 换号回调（maybeSwitchAccount）与重试日志顺序归编排层，本模块只给出决策输入。
// 注意：Retryable 日志在编排层位于换号回调**之后**打印（保持既有顺序），
// 而一般失败的日志位于换号回调**之前**——两处顺序本就不同，提取时逐字保留。
// =============================================================================
import { ErrorCode, codeForStatus, terminalCodeFor } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { UpstreamError, isAbortError } from './errors.js';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * 是否允许重试：状态码可重试，且错误文本未命中终止性（计费/套餐）标记
 * —— premium_credits_exhausted / model_not_in_plan / insufficient credits
 * 重试只会白耗额度，应当快速失败（原版 CLI 行为）。
 * 判定集中在此处，便于单测锁定该契约。
 */
export function isRetryableFailure(status: number, message: string): boolean {
  return terminalCodeFor(message) === undefined && RETRYABLE_STATUS.has(status);
}

/** 指数退避：500ms * 2^(attempt-1)，封顶 8s。 */
export function backoffMsFor(attempt: number): number {
  return Math.min(8000, 500 * Math.pow(2, attempt - 1));
}

/** 从上游错误响应文本里解析可读消息；解析失败返回空串。 */
function parseErrorResponseText(errorText: string): string {
  let parsedMsg = '';
  try {
    parsedMsg = JSON.parse(errorText).message || JSON.parse(errorText)?.error?.message || '';
  } catch {}
  return parsedMsg;
}

export interface ErrorStatusVerdict {
  action: 'retry' | 'throw';
  /** 决策所针对的错误对象（编排层用它设置 lastError / 调换号回调 / 抛出）。 */
  error: UpstreamError;
  /** action === 'retry' 时的退避毫秒数。 */
  backoffMs?: number;
  /** 上游状态码（编排层拼 Retryable 日志用）。 */
  status: number;
}

/**
 * 非 2xx 响应的处理：读取并解析错误文本、打日志、按终止性/可重试与剩余预算
 * 给出 retry/throw 决策。Retryable 日志与换号回调仍归编排层（顺序敏感）。
 */
export async function handleUpstreamErrorStatus(args: {
  response: Response;
  attempt: number;
  maxAttempts: number;
  model: string;
  threadId: string;
}): Promise<ErrorStatusVerdict> {
  const { response, attempt, maxAttempts } = args;
  const errorText = await response.text();
  const displayMsg = parseErrorResponseText(errorText) || errorText.slice(0, 200);
  logger.error(`[UPSTREAM] Model: ${args.model} | Thread ${args.threadId} | Error ${response.status}: ${displayMsg}`);

  // 终止性计费/套餐错误：永不重试（原版 CLI 行为）。
  const retryable = isRetryableFailure(response.status, displayMsg);
  const err = new UpstreamError(
    `Upstream error ${response.status}: ${displayMsg}`,
    response.status,
    retryable,
    terminalCodeFor(displayMsg) ?? codeForStatus(response.status),
  );
  if (retryable && attempt < maxAttempts) {
    return { action: 'retry', error: err, backoffMs: backoffMsFor(attempt), status: response.status };
  }
  return { action: 'throw', error: err, status: response.status };
}

export interface CaughtErrorVerdict {
  kind: 'deadline' | 'idle' | 'client-abort' | 'failure';
  /** kind !== 'failure' 时为应直接抛出的错误对象。 */
  error?: Error;
}

/** 客户端/上游已离开：路由层用 isAbortError 识别这个标记错误并静默收尾。 */
export function clientAbortError(): Error {
  return Object.assign(new Error('__ABORT__'), { isAbort: true });
}

/**
 * catch 块错误的成因分类。判定顺序与原实现一致：
 * 挂钟上限先于空闲判定（两者的 abort 都走 isAbortError，但成因与错误码不同），
 * 其次是 isAbortError（空闲卡死 / 客户端中止），再次是客户端已离开。
 * 返回 kind === 'failure' 时错误进入重试决策。
 */
export function classifyCaughtError(err: any, ctx: {
  deadlineFired: boolean;
  idleFired: boolean;
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
  clientAborted: boolean;
}): CaughtErrorVerdict {
  if (ctx.deadlineFired) {
    return {
      kind: 'deadline',
      error: new UpstreamError(
        `Upstream exceeded ${ctx.upstreamTimeoutMs / 1000}s total deadline`,
        504,
        false,
        ErrorCode.REQUEST_TIMEOUT,
      ),
    };
  }

  if (isAbortError(err)) {
    if (ctx.idleFired) {
      return {
        kind: 'idle',
        error: new UpstreamError(`Upstream stalled: no data for ${ctx.idleTimeoutMs / 1000}s`, undefined, true, ErrorCode.STREAM_IDLE_TIMEOUT),
      };
    }
    return { kind: 'client-abort', error: clientAbortError() };
  }

  // 网络级失败值得再试一次，除非客户端已离开。
  if (ctx.clientAborted) {
    return { kind: 'client-abort', error: clientAbortError() };
  }

  return { kind: 'failure' };
}

/**
 * 重试预算用尽时的终态包装：
 * UpstreamError 保留上游真实状态码与错误码（若一律包装成"connection failed"，
 * 客户端会把 3 次 503 误判成网络故障）；其他错误统一包成 NETWORK_ERROR，
 * 并附上底层 cause 的消息（如有）。
 */
export function finalizeAttemptFailure(err: any): UpstreamError {
  if (err instanceof UpstreamError) {
    return new UpstreamError(err.message, err.status, false, err.code);
  }
  const detailedMsg = err?.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
  return new UpstreamError(`Upstream connection failed: ${detailedMsg}`, undefined, false, ErrorCode.NETWORK_ERROR);
}
