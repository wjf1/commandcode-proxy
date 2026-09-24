// =============================================================================
// 类型定义：CommandCode 私有 wire 协议（逆向自官方 CLI）与流式编码状态
// -----------------------------------------------------------------------------
// 自 types/index.ts 原样拆出（架构 Phase 1），类型定义内容零变化。
// CommandCode wire 协议是翻译引擎的"归一化中间语"。
// =============================================================================

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
  /** 原 CLI 的 wire 字段；此前只靠 as any 塞进去，补进类型以免写错键名。 */
  mediaType?: string;
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
  /**
   * tool-call-delta 的参数片段（AI-SDK 语法的字段名）。上游只在首片给
   * toolCallId/toolName，后续片靠这个字段续上 JSON 片段。
   */
  argsText?: string;
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
    argsText?: string;
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
  /** 写入缓存的输入 token 数（多数模型为 0）。 */
  cacheWriteTokens: number;
  /** 输入中未命中缓存的 token 数。 */
  noCacheTokens: number;
  /** 上游 provider-metadata 给出的权威账单金额（USD）；缺省为 undefined。 */
  upstreamCostUsd?: number;
}
