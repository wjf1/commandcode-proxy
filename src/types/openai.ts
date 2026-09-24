// =============================================================================
// 类型定义：OpenAI Chat Completions API
// -----------------------------------------------------------------------------
// 自 types/index.ts 原样拆出（架构 Phase 1），类型定义内容零变化。
// =============================================================================

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
