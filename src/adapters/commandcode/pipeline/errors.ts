// =============================================================================
// 上游流水线共享错误基础件
// -----------------------------------------------------------------------------
// UpstreamError / isAbortError 会被流水线的多个阶段（受控请求、响应处理、流
// 包装）共同构造与判定，因此单独成模块，避免 pipeline/* 反向依赖编排层
// upstream.ts 形成循环依赖。upstream.ts 仍 re-export 这些符号，外部导入
// 路径保持不变。
// =============================================================================
import { ProxyError, codeForStatus, type ErrorCodeName } from '../../../utils/errors.js';

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
