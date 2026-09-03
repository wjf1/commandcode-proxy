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
  lastUsedAt?: string;
  totalRequests?: number;
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
  permissionMode?: string;
  accounts?: AccountInfo[];
  upstream?: UpstreamConfig;
}

export interface GatewayConfig {
  port: number;
  host: string;
  ccApiBase: string;
  ccVersion: string;
  rotationMode: 'manual' | 'auto-quota';
  permissionMode: string;
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

export interface CCEvent {
  type: 'start' | 'text-delta' | 'reasoning-delta' | 'tool-call' | 'tool-call-delta' | 'finish' | 'finish-step' | 'error';
  text?: string;
  /** Original CLI: finish events carry totalUsage at the top level. */
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  data?: {
    text?: string;
    toolCallId?: string;
    toolName?: string;
    name?: string;
    input?: unknown;
    arguments?: unknown;
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
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
  promptTokens: number;
  completionTokens: number;
  thinkingState: 'none' | 'in_think' | 'done';
  inputTokens: number;
  outputTokens: number;
}

// ─── Models ──────────────────────────────────────────────────────────────────

/** Per-1M-token pricing (USD). Mirrors the official Command Code pricing page. */
export interface ModelPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
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
  deal?: ModelDeal;
  /** Available on the individual Go plan (availability.individual-go). */
  onGoPlan?: boolean;
  tip?: string;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
