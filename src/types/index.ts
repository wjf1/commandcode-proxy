// =============================================================================
// 类型定义：三大协议的契约
// -----------------------------------------------------------------------------
// 本文件集中定义了三套互相转换的数据结构：
//   1. Gateway 配置（GatewayConfig 及其文件形态 GatewayConfigFile）
//   2. OpenAI Chat Completions API（OpenAIChatRequest / OpenAIMessage / ...）
//   3. Anthropic Messages API（AnthropicRequest / AnthropicMessage / ...）
//   4. CommandCode 私有 wire 协议（CCRequestBody / CCMessage / CCEvent / ...）
//      —— 逆向自官方 CLI，是翻译引擎的"归一化中间语"。
//   5. 模型元数据（ModelItem / ModelPricing / ModelCaps / ModelDeal）
//   6. 日志条目（LogEntry）
// 这些接口是翻译正确性的根基，改动需同步更新 adapter 与路由。
// =============================================================================

// ─── 网关配置 ───────────────────────────────────────────────────────────────

export interface AccountInfo {
  id: string;
  name: string;
  apiKey: string;
  userName?: string;
  email?: string;
  userId?: string;
  addedAt: string;
}

export interface UpstreamConfig {
  apiBase?: string;
  ccVersion?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
}

export interface GatewayConfigFile {
  port?: number;
  host?: string;
  activeAccountId?: string;
  rotationMode?: 'manual' | 'auto-quota';
  accounts?: AccountInfo[];
  upstream?: UpstreamConfig;
}

export interface GatewayConfig {
  port: number;
  host: string;
  ccApiBase: string;
  ccVersion: string;
  rotationMode: 'manual' | 'auto-quota';
  activeAccountId: string;
  accounts: AccountInfo[];
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
  maxRetries: number;
}

// ─── OpenAI Chat Completions API ──────────────────────────────────────────────

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface OpenAITool {
  type: 'function' | 'custom';
  function?: OpenAIFunctionDef;
  custom?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImageUrlPart;

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  /** OpenAI：流式请求是否在收尾 chunk 附带 usage。 */
  stream_options?: { include_usage?: boolean };
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  reasoning_effort?: string | number;
  thinking?: { type: 'enabled'; budget_tokens?: number };
  stop?: string | string[];
  user?: string;
  parallel_tool_calls?: boolean;
  response_format?: { type: string };
}

// ─── Anthropic Messages API ───────────────────────────────────────────────────

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  } | {
    type: 'url';
    url: string;
  };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' };
  metadata?: { user_id?: string };
}

// ─── CommandCode wire protocol (reverse-engineered from CLI) ─────────────────

export interface CCConfig {
  date: string;
  environment: string;
  workingDir: string;
  availableTools: unknown[];
  structure: unknown[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: unknown[];
  os: string;
  shell: string;
}

export interface CCMessage {
  role: string;
  content: string | CCContentPart[];
}

export interface CCContentPart {
  type: 'text' | 'image' | 'reasoning' | 'tool-call' | 'tool-result';
  text?: string;
  image?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: { type: string; value?: unknown };
}

export interface CCTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface CCToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
}

export interface CCRequestBody {
  config: CCConfig;
  memory: unknown;
  taste: unknown;
  skills: unknown;
  permissionMode: string;
  threadId: string;
  params: {
    model: string;
    messages: CCMessage[];
    system?: string;
    tools?: CCTool[];
    tool_choice?: CCToolChoice | Record<string, unknown>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    reasoning_effort?: string;
  };
}

/**
 * 上游 usage 结构。实测（/alpha/generate 的 finish 事件）形如：
 *   { inputTokens, outputTokens, totalTokens, reasoningTokens, cachedInputTokens,
 *     inputTokenDetails: { noCacheTokens, cacheReadTokens },
 *     outputTokenDetails: { textTokens, reasoningTokens } }
 * 注意 inputTokens 是**含缓存命中的总量**，缓存命中量在
 * inputTokenDetails.cacheReadTokens / cachedInputTokens 里 —— 计费必须拆分，
 * 否则会把单价仅为输入 1/50 的缓存读按全价输入计。
 */
export interface CCEventUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  /** 缓存命中的输入 token（与 inputTokenDetails.cacheReadTokens 同义）。 */
  cachedInputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

/**
 * provider-metadata 事件里的网关计费字段（权威账单金额，USD 字符串）。
 * 网关已把峰谷价、缓存折扣与加成全部算好，直接采用即可，无需自行估算。
 */
export interface CCGatewayBilling {
  /** 本次请求实际计入的总额（含加成）。 */
  cost?: string | number;
  marketCost?: string | number;
  surchargeCost?: string | number;
  gatewayCost?: string | number;
  inferenceCost?: string | number;
  inputInferenceCost?: string | number;
  outputInferenceCost?: string | number;
  generationId?: string;
}

export interface CCEvent {
  type: 'start' | 'text-delta' | 'reasoning-delta' | 'tool-call' | 'tool-call-delta' | 'finish' | 'finish-step' | 'error' | 'provider-metadata';
  text?: string;
  /** Original CLI: finish events carry totalUsage at the top level. */
  totalUsage?: CCEventUsage;
  /** provider-metadata 事件：权威计费信息（gateway.cost 等）。 */
  providerMetadata?: {
    gateway?: CCGatewayBilling;
    [key: string]: unknown;
  };
  data?: {
    text?: string;
    toolCallId?: string;
    toolName?: string;
    name?: string;
    input?: unknown;
    arguments?: unknown;
    finishReason?: string;
    usage?: CCEventUsage;
  };
  text2?: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  finishReason?: string;
  rawFinishReason?: string;
  error?: { message?: string; code?: string | number } | string;
}

export interface StreamEncoderState {
  id: string;
  created: number;
  model: string;
  toolCallIndex: number;
  toolCallIdToIndex: Map<string, number>;
  sawFinish: boolean;
  hasEmittedText: boolean;
  thinkingState: 'none' | 'in_think' | 'done';
  /** OpenAI stream_options.include_usage：收尾 chunk 附带 usage。 */
  includeUsage?: boolean;
  /** 上游未回 usage 时收尾 chunk 的输入量兜底（本地估算）。 */
  estimatedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  /** 输入中命中缓存的 token 数（计费按 cacheRead 单价）。 */
  cacheReadTokens: number;
  /** 输入中未命中缓存的 token 数。 */
  noCacheTokens: number;
  /** 上游 provider-metadata 给出的权威账单金额（USD）；缺省为 undefined。 */
  upstreamCostUsd?: number;
}

// ─── Models ──────────────────────────────────────────────────────────────────

/** Per-1M-token pricing (USD). Mirrors the official Command Code pricing page. */
export interface ModelPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 官方定价页的峰谷分时价。部分模型（当前 4 个）在峰时段按更高费率计费，
 * 例如 deepseek-v4.1-flash 谷时 $0.15/$0.60、峰时 $0.30/$1.20。
 * 面板静态展示的 pricing 取谷时（官方页面默认展示档），实际估算需按时间选档。
 */
export interface TimeOfDayPricing {
  /** 峰时费率。 */
  peak?: ModelPricing;
  /** 谷时费率。 */
  offPeak?: ModelPricing;
  peakHoursPerDay?: number;
  offPeakHoursPerDay?: number;
  /** 峰时窗口的人类可读描述，例如 "01–04 & 06–10 UTC, Mon–Fri"。 */
  windows?: string;
  tip?: string;
}

/** Model capability flags (Caps). */
export interface ModelCaps {
  text?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

/** Promo / deal info (FREE / discount percent). */
export interface ModelDeal {
  id?: string;
  discountPercent?: number;
  free?: boolean;
  expires?: string;
  endsWhen?: string;
  revertNote?: string;
}

export interface ModelItem {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  name?: string;
  context_length?: number;
  reasoning_efforts?: string[];
  supports_vision?: boolean;
  // -- Official pricing catalog enrichment (from commandcode.ai) --
  context_window?: number;
  category?: string;
  caps?: ModelCaps;
  pricing?: ModelPricing;
  /** 峰谷分时价（官方仅对部分模型提供）。 */
  timeOfDay?: TimeOfDayPricing;
  deal?: ModelDeal;
  /** Available on the individual Go plan (availability.individual-go). */
  onGoPlan?: boolean;
  /**
   * Per-plan availability map from the official pricing catalog, e.g.
   * {"individual-go":true,"individual-goat":true,...}. Stored verbatim so the
   * dashboard/API can filter by the caller's own plan instead of hardcoding one.
   */
  availability?: Record<string, boolean>;
  tip?: string;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
