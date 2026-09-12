// =============================================================================
// 结构化错误分类
// -----------------------------------------------------------------------------
// 移植自 zcode-commandcode-private/mcp/core.mjs 的 ErrorCode / CommandCodeError，
// 并适配本网关的双出口（OpenAI /v1/chat/completions 与 Anthropic /v1/messages）。
//
// 目标：任何失败都带一个稳定错误码 + 一条可执行提示，调用方（Cursor、Continue、
// Agent、自写脚本）能据此判断该等待额度、换模型、还是改配置，而不是只拿到 502。
//
// 一个错误码同时决定：
//   - HTTP 状态码
//   - OpenAI 出口的 error.type / error.code
//   - Anthropic 出口的 error.type（Anthropic 客户端按 error.type 分支）
//   - retryable：是否允许上游重试；必须与 upstream.ts 原有的终止性错误语义一致
// =============================================================================

export const ErrorCode = {
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  PROXY_AUTH_REQUIRED: 'PROXY_AUTH_REQUIRED',
  RATE_LIMIT: 'RATE_LIMIT',
  MODEL_NOT_IN_PLAN: 'MODEL_NOT_IN_PLAN',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  PROVIDER_PROTOCOL_ERROR: 'PROVIDER_PROTOCOL_ERROR',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  STREAM_IDLE_TIMEOUT: 'STREAM_IDLE_TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION',
  CATALOG_UNAVAILABLE: 'CATALOG_UNAVAILABLE',
  BLOCKED_HOST: 'BLOCKED_HOST',
  GATEWAY_PAUSED: 'GATEWAY_PAUSED',
  GATEWAY_BUSY: 'GATEWAY_BUSY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 每个错误码对应一条可执行提示（英文，直接回给 API 调用方与智能体）。 */
const HINTS: Record<ErrorCodeName, string> = {
  MISSING_CREDENTIAL:
    'No Command Code API key is available. Add an account in the dashboard, or set COMMANDCODE_API_KEY / ~/.commandcode/auth.json.',
  INVALID_CREDENTIAL:
    'The Command Code API key is expired or revoked. Re-run browser login (OAuth) or paste a new key in the dashboard.',
  PROXY_AUTH_REQUIRED:
    'This gateway requires PROXY_API_KEY. Send it as "Authorization: Bearer <key>" or "x-api-key: <key>".',
  RATE_LIMIT:
    'The plan usage window (5-hour or weekly) is exhausted, or credits ran out. Wait for resetAt from /api/usage/overview, buy top-up credits, or enable auto-quota account rotation.',
  MODEL_NOT_IN_PLAN:
    'The model is above your subscription tier. Use a model your plan allows, enable on-demand top-up credits, or upgrade the plan.',
  MODEL_NOT_FOUND:
    'Refresh the catalog with POST /v1/models/refresh, then use a model id returned by GET /v1/models.',
  PROVIDER_PROTOCOL_ERROR:
    'The upstream returned an unexpected payload or terminated the stream abnormally. Retry; if it persists, inspect the raw SSE events.',
  REQUEST_TIMEOUT:
    'The upstream did not respond in time. Raise upstream.timeoutMs, or check network stability to the Command Code API.',
  STREAM_IDLE_TIMEOUT:
    'The upstream stalled mid-stream and the idle watchdog aborted the request. Raise upstream.idleTimeoutMs if long reasoning turns are expected.',
  NETWORK_ERROR:
    'Could not reach the configured upstream API base. Check connectivity and the COMMANDCODE_API_BASE value.',
  SERVER_ERROR:
    'The upstream is failing (5xx) or degraded. Retry with backoff; if it persists the service is unhealthy.',
  UNSUPPORTED_CONTENT:
    'The request contains content this gateway cannot translate to the upstream wire format.',
  UNSUPPORTED_OPTION:
    'The request uses an option or shape this gateway does not support. See the README for supported fields.',
  CATALOG_UNAVAILABLE:
    'The model catalog could not be loaded. Retry, or check GET /api/status for upstream reachability.',
  BLOCKED_HOST:
    'The upstream URL was rejected by the SSRF guard: non-http(s), embedded credentials, private/loopback host, or a domain outside the allowlist.',
  GATEWAY_PAUSED:
    'The gateway engine is paused. Resume it from the dashboard or via POST /api/gateway/toggle.',
  GATEWAY_BUSY:
    'Too many concurrent upstream requests (MAX_UPSTREAM_CONCURRENCY). Retry with backoff or raise the limit.',
  INTERNAL_ERROR:
    'Unexpected proxy-side failure. Check the dashboard log tab for the underlying stack trace.',
};

/**
 * 上游错误文本里的终止性（计费/套餐）标记 → 错误码。
 * 命中即视为不可重试（原版 CLI 行为）：重试只会白耗额度。
 */
const TERMINAL_MARKERS: ReadonlyArray<readonly [string, ErrorCodeName]> = [
  ['model_not_in_plan', ErrorCode.MODEL_NOT_IN_PLAN],
  ['premium_credits_exhausted', ErrorCode.RATE_LIMIT],
  ['insufficient credits', ErrorCode.RATE_LIMIT],
];

/** 上游 HTTP 状态 → 错误码（与插件 httpError 的映射对齐，另补 4xx 细分）。 */
export function codeForStatus(status: number | undefined): ErrorCodeName {
  if (status === 401 || status === 403) return ErrorCode.INVALID_CREDENTIAL;
  if (status === 402 || status === 429) return ErrorCode.RATE_LIMIT;
  if (status === 404) return ErrorCode.MODEL_NOT_FOUND;
  // 400/422：上游拒绝了本网关翻译出来的 wire 体，属请求形态问题；
  // 报 NETWORK_ERROR（"检查网络"）会误导排查方向，故单列。
  if (status === 400 || status === 422) return ErrorCode.UNSUPPORTED_OPTION;
  if (status !== undefined && status >= 500) return ErrorCode.SERVER_ERROR;
  return ErrorCode.NETWORK_ERROR;
}

/** 错误文本命中终止性计费/套餐标记时返回对应错误码，否则返回 undefined。 */
export function terminalCodeFor(message: string): ErrorCodeName | undefined {
  const lower = String(message ?? '').toLowerCase();
  for (const [marker, code] of TERMINAL_MARKERS) {
    if (lower.includes(marker)) return code;
  }
  return undefined;
}

const STATUS_BY_CODE: Record<ErrorCodeName, number> = {
  MISSING_CREDENTIAL: 401,
  INVALID_CREDENTIAL: 401,
  PROXY_AUTH_REQUIRED: 401,
  RATE_LIMIT: 429,
  MODEL_NOT_IN_PLAN: 403,
  MODEL_NOT_FOUND: 404,
  UNSUPPORTED_CONTENT: 400,
  UNSUPPORTED_OPTION: 400,
  BLOCKED_HOST: 500,
  CATALOG_UNAVAILABLE: 503,
  GATEWAY_PAUSED: 503,
  GATEWAY_BUSY: 503,
  REQUEST_TIMEOUT: 504,
  STREAM_IDLE_TIMEOUT: 504,
  NETWORK_ERROR: 502,
  SERVER_ERROR: 502,
  PROVIDER_PROTOCOL_ERROR: 502,
  INTERNAL_ERROR: 500,
};

/** OpenAI 错误族（error.type 取值）。 */
const OPENAI_TYPE: Record<ErrorCodeName, string> = {
  MISSING_CREDENTIAL: 'authentication_error',
  INVALID_CREDENTIAL: 'authentication_error',
  PROXY_AUTH_REQUIRED: 'authentication_error',
  RATE_LIMIT: 'rate_limit_error',
  MODEL_NOT_IN_PLAN: 'permission_error',
  MODEL_NOT_FOUND: 'not_found_error',
  UNSUPPORTED_CONTENT: 'invalid_request_error',
  UNSUPPORTED_OPTION: 'invalid_request_error',
  BLOCKED_HOST: 'api_error',
  CATALOG_UNAVAILABLE: 'api_error',
  GATEWAY_PAUSED: 'api_error',
  GATEWAY_BUSY: 'api_error',
  REQUEST_TIMEOUT: 'api_error',
  STREAM_IDLE_TIMEOUT: 'api_error',
  NETWORK_ERROR: 'api_error',
  SERVER_ERROR: 'api_error',
  PROVIDER_PROTOCOL_ERROR: 'api_error',
  INTERNAL_ERROR: 'api_error',
};

/** Anthropic 错误族（error.type 取值，客户端按它分支）。 */
const ANTHROPIC_TYPE: Record<ErrorCodeName, string> = {
  MISSING_CREDENTIAL: 'authentication_error',
  INVALID_CREDENTIAL: 'authentication_error',
  PROXY_AUTH_REQUIRED: 'authentication_error',
  RATE_LIMIT: 'rate_limit_error',
  MODEL_NOT_IN_PLAN: 'permission_error',
  MODEL_NOT_FOUND: 'not_found_error',
  UNSUPPORTED_CONTENT: 'invalid_request_error',
  UNSUPPORTED_OPTION: 'invalid_request_error',
  BLOCKED_HOST: 'api_error',
  CATALOG_UNAVAILABLE: 'api_error',
  GATEWAY_PAUSED: 'api_error',
  GATEWAY_BUSY: 'api_error',
  REQUEST_TIMEOUT: 'api_error',
  STREAM_IDLE_TIMEOUT: 'api_error',
  NETWORK_ERROR: 'api_error',
  SERVER_ERROR: 'api_error',
  PROVIDER_PROTOCOL_ERROR: 'api_error',
  INTERNAL_ERROR: 'api_error',
};

export interface ProxyErrorInit {
  /** 覆盖默认状态码（如需透传上游真实状态）。 */
  status?: number;
  context?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

export class ProxyError extends Error {
  readonly code: ErrorCodeName;
  readonly status: number;
  readonly context: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCodeName, message: string, init: ProxyErrorInit = {}) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    this.status = init.status ?? STATUS_BY_CODE[code] ?? 500;
    this.context = init.context ?? {};
    this.retryable = init.retryable ?? false;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  /** 可执行的排查/处置建议。 */
  get hint(): string {
    return HINTS[this.code];
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      hint: this.hint,
      context: this.context,
    };
  }

  /** OpenAI 出口的 error 对象。 */
  openAIPayload() {
    return {
      message: this.message,
      type: OPENAI_TYPE[this.code],
      code: this.code as string,
      param: null as string | null,
      hint: this.hint,
    };
  }

  /** Anthropic 出口的完整 error 信封。 */
  anthropicPayload() {
    return {
      type: 'error' as const,
      error: {
        type: ANTHROPIC_TYPE[this.code],
        message: this.message,
        code: this.code as string,
        hint: this.hint,
      },
    };
  }
}

/** 任意异常 → ProxyError；已是 ProxyError 则原样返回。 */
export function toProxyError(error: unknown, fallbackCode: ErrorCodeName = ErrorCode.INTERNAL_ERROR): ProxyError {
  if (error instanceof ProxyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProxyError(terminalCodeFor(message) ?? fallbackCode, message, { cause: error });
}
