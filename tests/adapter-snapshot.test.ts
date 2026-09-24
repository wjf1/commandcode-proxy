// =============================================================================
// adapter 快照防线（拆分前的行为基线）
// -----------------------------------------------------------------------------
// adapter.ts 职责拆分前，先在这里把它的全部对外行为逐字节钉死：
//   - OpenAI → CC wire 请求翻译（system 拼接 / 图片 / 工具调用与结果 / 悬空清理 /
//     max_tokens 钳制 / reasoning 档位 / 参数转发 / 多语言内容）
//   - Anthropic → CC wire 请求翻译（system 块 / thinking 历史 / tool_result /
//     is_error / 图片 / tool_choice / stop_sequences）
//   - OpenAI 流式编码（start / text-delta / 内联与跨 delta 的 <think> / reasoning /
//     tool-call 与分片 / finish_reason 组合 / usage 回填 / provider-metadata / 错误事件）
//   - Anthropic 非流式响应构建（文本 / thinking / tool_use 合并 / stop_reason / usage）
// 每个用例对完整输出 JSON.stringify 后 toMatchSnapshot。随机性与环境值全部归一化：
//   - StreamEncoderState 的 id/created 覆盖为固定值；
//   - 缺失 toolCallId 的回退 id（call_xxxx/toolu_xxxx）归一化为 SNAP 占位；
//   - wire.config 的日期/平台/工作目录归一化，快照跨机器跨日期稳定。
// 拆分后本文件必须逐字节一致 —— 任何快照 diff 都意味着行为变化。
// =============================================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { CommandCodeAdapter } from '../src/adapters/commandcode/adapter.js';
import { setCachedModelsForTest } from '../src/utils/models.js';
import { OpenAIChatRequest, AnthropicRequest, CCEvent, StreamEncoderState } from '../src/types/index.js';

// 快照必须跨环境稳定：resolveModelName 依赖内存模型缓存（生产环境从 models.json /
// 上游加载，各机器不同），这里注入固定目录，让所有用例的模型解析都有确定输入。
// 用例里的 model 均精确命中（resolveModelName 原样返回），不触发模糊解析。
beforeAll(() => {
  setCachedModelsForTest(
    ['claude-sonnet-5', 'gpt-5.6-sol', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.6-flash'].map(id => ({
      id, object: 'model', created: 0, owned_by: 'command-code',
    })),
  );
});

const adapter = new CommandCodeAdapter();

// ─── 归一化工具 ──────────────────────────────────────────────────────────────

function snapState(model = 'm', opts?: { includeUsage?: boolean; estimatedInputTokens?: number }): StreamEncoderState {
  const s = adapter.createStreamEncoderState(model, opts);
  s.id = 'chatcmpl-SNAP';
  s.created = 1700000000;
  return s;
}

/** 把随机回退 id 归一化（仅命中 8 位 hex 的回退形式，显式 id 不受影响）。 */
function normalizeIds(s: string): string {
  return s
    .replace(/call_[0-9a-f]{8}/g, 'call_SNAP')
    .replace(/toolu_[0-9a-f]{8}/g, 'toolu_SNAP');
}

/** wire.config 含日期/平台/工作目录等环境值，统一归一化。 */
function normalizeWire(wire: any): any {
  wire.threadId = 'snap-thread';
  wire.config.date = '1970-01-01';
  wire.config.environment = 'linux';
  wire.config.workingDir = '/snap/cwd';
  wire.config.os = 'linux';
  wire.config.shell = 'bash';
  return wire;
}

interface SnapCase {
  name: string;
  run: () => unknown;
}

const cases: SnapCase[] = [];

function wireCase(name: string, req: OpenAIChatRequest): void {
  cases.push({
    name: `openai-wire · ${name}`,
    run: () => JSON.stringify(normalizeWire(adapter.translateOpenAIRequest(req, { threadId: 'snap-thread' }))),
  });
}

function anthropicWireCase(name: string, req: AnthropicRequest): void {
  cases.push({
    name: `anthropic-wire · ${name}`,
    run: () => JSON.stringify(normalizeWire(adapter.translateAnthropicRequest(req, { threadId: 'snap-thread' }))),
  });
}

function streamCase(name: string, events: any[], model = 'm', stateOpts?: { includeUsage?: boolean; estimatedInputTokens?: number }): void {
  cases.push({
    name: `openai-stream · ${name}`,
    run: () => {
      const state = snapState(model, stateOpts);
      const out: string[] = [];
      for (const e of events) out.push(...adapter.encodeOpenAIChunk(e, state));
      return JSON.stringify(normalizeIds(out.join('')));
    },
  });
}

function anthropicMsgCase(name: string, events: CCEvent[], inputTokens = 0): void {
  cases.push({
    name: `anthropic-msg · ${name}`,
    run: () => {
      const msg = adapter.buildAnthropicResponse(events, 'msg_SNAP', 'claude-sonnet-5', inputTokens);
      return JSON.stringify(normalizeIds(JSON.stringify(msg)));
    },
  });
}

// ─── OpenAI → CC wire 请求翻译 ───────────────────────────────────────────────

wireCase('system + user 基础对话', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ],
  max_tokens: 100,
});

wireCase('多条 system 以空行拼接', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'system', content: 'Rule one.' },
    { role: 'system', content: 'Rule two.' },
    { role: 'user', content: 'go' },
  ],
});

wireCase('developer 角色并入 system', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'developer', content: 'Dev instruction.' },
    { role: 'user', content: 'go' },
  ],
  max_tokens: 64,
});

wireCase('user content 数组：text + data URL 图片', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ] },
  ],
  max_tokens: 64,
});

wireCase('image_url 非 data URL 回落 image/png', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ] },
  ],
  max_tokens: 64,
});

wireCase('assistant content + reasoning_content 历史', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'partial', reasoning_content: 'I thought about it.' } as any,
    { role: 'user', content: 'go on' },
  ],
  max_tokens: 64,
});

wireCase('assistant tool_calls 历史（JSON 字符串参数）', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'user', content: 'Read the file' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
  ],
});

wireCase('assistant tool_calls 非法 JSON 参数回退 {raw}', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: 'not-json' } },
    ] },
  ],
});

wireCase('相邻 tool 结果合并进同一条 tool 消息', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'f1', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'f2', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'one' },
    { role: 'tool', tool_call_id: 'c2', content: 'two' },
  ],
});

wireCase('tool 结果带图片提升为紧随的 user 消息', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: [
      { type: 'text', text: 'captured' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SkRH' } },
    ] },
  ],
});

wireCase('role=function 结果', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'legacy', arguments: '{}' } },
    ] },
    { role: 'function', name: 'legacy', content: 'fn output' } as any,
  ],
});

wireCase('悬空 tool result 被剪掉（无配对 call）', {
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'ghost_id', content: 'orphan' },
    { role: 'user', content: 'again' },
  ],
});

wireCase('max_tokens 250000 钳制到 200000', {
  model: 'deepseek/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 250000,
});

wireCase('max_completion_tokens 优先于 max_tokens', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 111,
  max_completion_tokens: 222,
} as OpenAIChatRequest);

wireCase('temperature / top_p / stop / response_format 转发', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 64,
  temperature: 0.3,
  top_p: 0.9,
  stop: 'END',
  response_format: { type: 'json_object' },
} as OpenAIChatRequest);

wireCase('stop 数组形态转发', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 64,
  stop: ['END', 'STOP'],
});

wireCase('reasoning_effort 向下就近对齐（deepseek low → high）', {
  model: 'deepseek/deepseek-v4-pro',
  messages: [{ role: 'user', content: 'x' }],
  reasoning_effort: 'low',
});

wireCase('数字 reasoning_effort 5 → max', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'x' }],
  reasoning_effort: 5 as any,
});

wireCase('thinking budget_tokens 20000 → max', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'x' }],
  thinking: { type: 'enabled', budget_tokens: 20000 },
} as OpenAIChatRequest);

wireCase('tools 全量转换 + tool_search 重命名 + tool_choice required', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'tool_search', description: 's', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } } },
    { type: 'custom', custom: { name: 'custom_tool', parameters: { type: 'object' } } } as any,
  ],
  tool_choice: 'required',
});

wireCase('tool_choice 指定函数', {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
  tool_choice: { type: 'function', function: { name: 'get_weather' } },
});

wireCase('空消息列表', {
  model: 'claude-sonnet-5',
  messages: [],
  max_tokens: 64,
});

wireCase('多语言与 emoji 内容', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'user', content: 'こんにちは、猫 🐱 — «кофе»' },
    { role: 'assistant', content: '好的，中文回复 🎉' },
    { role: 'user', content: '继续' },
  ],
  max_tokens: 64,
});

wireCase('user content 数组含未知 part 类型（忽略）', {
  model: 'claude-sonnet-5',
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'before' },
      { type: 'audio', audio: 'xxx' } as any,
    ] },
  ],
  max_tokens: 64,
});

// ─── Anthropic → CC wire 请求翻译 ────────────────────────────────────────────

anthropicWireCase('user 字符串 content 基础对话', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Read a.txt' }],
});

anthropicWireCase('system 字符串', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  system: 'Be terse.',
  messages: [{ role: 'user', content: 'hi' }],
});

anthropicWireCase('system 块数组拼接', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  system: [
    { type: 'text', text: 'Rule one.' },
    { type: 'text', text: 'Rule two.' },
  ],
  messages: [{ role: 'user', content: 'hi' }],
});

anthropicWireCase('assistant thinking + text 历史保留为 reasoning', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'I should analyze this.', signature: 'sig' },
      { type: 'text', text: 'Answer' },
    ] },
    { role: 'user', content: 'go on' },
  ],
});

anthropicWireCase('redacted_thinking 跳过', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'assistant', content: [
      { type: 'redacted_thinking', data: 'xxx' } as any,
      { type: 'text', text: 'Answer' },
    ] },
    { role: 'user', content: 'go on' },
  ],
});

anthropicWireCase('assistant tool_use → tool_calls', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the file data' }] },
  ],
});

anthropicWireCase('tool_result is_error 加 [ERROR] 前缀', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run_cmd', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
  ],
});

anthropicWireCase('tool_result 数组 content（text + image）', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
    { role: 'user', content: [{
      type: 'tool_result', tool_use_id: 't1',
      content: [
        { type: 'text', text: 'captured' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      ],
    }] },
  ],
});

anthropicWireCase('base64 图片块 → 裸 base64 wire 形状', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'SkRH' } },
      { type: 'text', text: 'what is this?' },
    ] },
  ],
});

anthropicWireCase('url 图片块', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: [
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ] },
  ],
});

anthropicWireCase('tools + tool_choice any → any', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'x' }],
  tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
  tool_choice: { type: 'any' },
});

anthropicWireCase('tool_choice tool(name)', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'x' }],
  tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
  tool_choice: { type: 'tool', name: 'get_weather' },
});

anthropicWireCase('stop_sequences → stop 转发', {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  stop_sequences: ['END', 'STOP'],
  messages: [{ role: 'user', content: 'hi' }],
});

anthropicWireCase('max_tokens 1000000 钳制到 200000', {
  model: 'deepseek/deepseek-v4.1-flash',
  max_tokens: 1000000,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as any],
});

anthropicWireCase('temperature / top_p 转发', {
  model: 'claude-sonnet-5',
  max_tokens: 256,
  temperature: 0.5,
  top_p: 0.8,
  messages: [{ role: 'user', content: 'hi' }],
});

// ─── OpenAI 流式编码（CC 事件 → SSE chunk 序列）──────────────────────────────

streamCase('start 事件（role delta）', [{ type: 'start' }]);

streamCase('text-delta 纯文本', [
  { type: 'start' },
  { type: 'text-delta', text: 'Hello' },
]);

streamCase('text-delta data.text 回落', [
  { type: 'text-delta', data: { text: 'via data' } },
]);

streamCase('text-delta 空文本无输出', [
  { type: 'start' },
  { type: 'text-delta', text: '' },
]);

streamCase('内联 <think>…</think> 拆分为 reasoning', [
  { type: 'start' },
  { type: 'text-delta', text: '<think>hmm</think>visible' },
]);

streamCase('<thinking> 标签变体', [
  { type: 'text-delta', text: '<thinking>deep</thinking>plain' },
]);

streamCase('<think> 开标签跨 delta', [
  { type: 'text-delta', text: '<think>par' },
  { type: 'text-delta', text: 'tial</think>ans' },
  { type: 'text-delta', text: 'wer' },
]);

streamCase('<think> 未闭合（后续全部进 reasoning）', [
  { type: 'text-delta', text: '<think>never closed' },
  { type: 'text-delta', text: ' still thinking' },
]);

streamCase('普通文本含 thinking 字样不误判', [
  { type: 'text-delta', text: 'I am thinking about the response format.' },
]);

streamCase('reasoning-delta 独立思考块', [
  { type: 'reasoning-delta', text: 'step one' },
  { type: 'reasoning-delta', text: 'step two' },
]);

streamCase('tool-call 完整事件（对象 input）', [
  { type: 'start' },
  { type: 'tool-call', toolCallId: 'call_a', toolName: 'get_weather', input: { city: 'Chennai' } },
]);

streamCase('tool-call 字符串 input', [
  { type: 'tool-call', toolCallId: 'call_s', toolName: 'raw', input: '{"k":1}' },
]);

streamCase('tool-call 无 id 回退归一化 id', [
  { type: 'tool-call', toolName: 'fallback', input: {} },
]);

streamCase('tool-call data.* 字段回落', [
  { type: 'tool-call', data: { toolCallId: 'call_d', toolName: 'data_tool', input: { x: 1 } } },
]);

streamCase('tool-call-delta 分片（同 id 归并同索引）', [
  { type: 'start' },
  { type: 'tool-call-delta', toolCallId: 'call_b', toolName: 'write_file', input: '{"path"' },
  { type: 'tool-call-delta', toolCallId: 'call_b', input: ':"a.txt"}' },
]);

streamCase('同回合两个工具调用索引递增', [
  { type: 'start' },
  { type: 'tool-call', toolCallId: 'call_x', toolName: 'one', input: { a: 1 } },
  { type: 'tool-call', toolCallId: 'call_y', toolName: 'two', input: { b: 2 } },
]);

streamCase('finish stop（无 usage，includeUsage 关）', [
  { type: 'start' },
  { type: 'text-delta', text: 'hi' },
  { type: 'finish', finishReason: 'stop' },
]);

streamCase('finish length', [
  { type: 'start' },
  { type: 'text-delta', text: 'truncated' },
  { type: 'finish', finishReason: 'length' },
]);

streamCase('finish stop 不压过已流出的工具调用', [
  { type: 'start' },
  { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Chennai' } },
  { type: 'finish', finishReason: 'stop' },
]);

streamCase('finish max_tokens 如实报 length', [
  { type: 'tool-call', toolCallId: 'call_1', toolName: 'f', input: {} },
  { type: 'finish', finishReason: 'max_tokens' },
]);

streamCase('finish tool-calls → tool_calls', [
  { type: 'tool-call', toolCallId: 'call_1', toolName: 'f', input: {} },
  { type: 'finish', finishReason: 'tool-calls' },
]);

streamCase('finish data.finishReason 回落', [
  { type: 'text-delta', text: 'hi' },
  { type: 'finish', data: { finishReason: 'stop' } },
]);

streamCase('finish totalUsage 含缓存拆分', [
  { type: 'text-delta', text: 'answer' },
  {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: {
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 70, cacheWriteTokens: 10, noCacheTokens: 20 },
    },
  },
]);

streamCase('finish data.usage 回落', [
  { type: 'finish', finishReason: 'stop', data: { usage: { inputTokens: 5, outputTokens: 7 } } },
]);

streamCase('includeUsage 收尾块携带 usage（上游有值）', [
  { type: 'start' },
  { type: 'text-delta', text: 'hello' },
  { type: 'tool-call', toolCallId: 'call_u', toolName: 'f', input: {} },
  {
    type: 'finish',
    finishReason: 'tool-calls',
    totalUsage: { inputTokens: 50, outputTokens: 6, inputTokenDetails: { cacheReadTokens: 40, noCacheTokens: 10 } },
  },
], 'claude-sonnet-5', { includeUsage: true });

streamCase('includeUsage 上游无 usage 回落本地估算输入', [
  { type: 'text-delta', text: 'hello' },
  { type: 'finish', finishReason: 'stop' },
], 'claude-sonnet-5', { includeUsage: true, estimatedInputTokens: 123 });

streamCase('provider-metadata 携带 gateway.cost', [
  { type: 'provider-metadata', providerMetadata: { gateway: { cost: '$0.0123' } } },
  { type: 'text-delta', text: 'x' },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 1 } },
], 'claude-sonnet-5', { includeUsage: true });

streamCase('provider-metadata 无 cost 忽略', [
  { type: 'provider-metadata', providerMetadata: { gateway: {} } },
  { type: 'finish', finishReason: 'stop' },
]);

streamCase('error 事件（字符串形态）', [
  { type: 'start' },
  { type: 'error', error: 'boom upstream' },
]);

streamCase('error 事件（对象 message）', [
  { type: 'error', error: { message: 'rate limited' } },
]);

streamCase('error 事件（code 字段回落）', [
  { type: 'error', error: { code: 'E_PIPE' } },
]);

streamCase('error 事件嵌套 error 字段', [
  { type: 'error', error: { error: { message: 'nested' } } },
]);

streamCase('error 事件 unknown 不输出', [
  { type: 'start' },
  { type: 'error', error: 'unknown' },
]);

streamCase('error 事件 data.error 回落（事件本身带 error 键）', [
  { type: 'text-delta', text: 'before' },
  { error: 'plain failure' } as any,
]);

streamCase('未知事件类型无输出', [
  { type: 'mystery-event', payload: 1 } as any,
]);

streamCase('完整多轮序列：thinking → 文本 → 工具 → finish', [
  { type: 'start' },
  { type: 'reasoning-delta', text: 'considering...' },
  { type: 'text-delta', text: '<think>private</think>Let me check.' },
  { type: 'tool-call-delta', toolCallId: 'call_m', toolName: 'search', input: '{"q"' },
  { type: 'tool-call-delta', toolCallId: 'call_m', input: ':"z"}' },
  { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 42, outputTokens: 9 } },
]);

// ─── Anthropic 非流式响应构建（CC 事件数组 → 消息）────────────────────────────

anthropicMsgCase('纯文本 + end_turn', [
  { type: 'text-delta', text: 'Hello.' },
  { type: 'text-delta', text: 'World.' },
  { type: 'finish', finishReason: 'stop' },
] as any[], 12);

anthropicMsgCase('thinking 块 + 文本', [
  { type: 'reasoning-delta', text: 'thinking...' },
  { type: 'text-delta', text: 'Let me check.' },
  { type: 'finish', finishReason: 'stop' },
] as any[]);

anthropicMsgCase('tool_use 单调用', [
  { type: 'tool-call', toolCallId: 'tu_1', toolName: 'search', input: { q: 'x' } },
  { type: 'finish', finishReason: 'tool-calls' },
] as any[]);

anthropicMsgCase('tool-call-delta 字符串分片合并', [
  { type: 'tool-call-delta', toolCallId: 'tu_2', toolName: 'write', input: '{"path"' },
  { type: 'tool-call-delta', toolCallId: 'tu_2', input: ':"a.txt"}' },
  { type: 'finish', finishReason: 'tool-calls' },
] as any[]);

anthropicMsgCase('多个 tool-call 依次排列', [
  { type: 'tool-call', toolCallId: 'tu_a', toolName: 'one', input: { a: 1 } },
  { type: 'tool-call', toolCallId: 'tu_b', toolName: 'two', input: { b: 2 } },
  { type: 'finish', finishReason: 'tool-calls' },
] as any[]);

anthropicMsgCase('同 id tool-call 对象 input 合并', [
  { type: 'tool-call', toolCallId: 'tu_c', toolName: 'merge', input: { a: 1 } },
  { type: 'tool-call', toolCallId: 'tu_c', input: { b: 2 } },
  { type: 'finish', finishReason: 'tool-calls' },
] as any[]);

anthropicMsgCase('tool-call 非法 JSON 回退 {raw}', [
  { type: 'tool-call-delta', toolCallId: 'tu_d', toolName: 'raw', input: 'not-json' },
  { type: 'finish', finishReason: 'tool-calls' },
] as any[]);

anthropicMsgCase('finish totalUsage 缓存拆分（input 只报未命中）', [
  { type: 'text-delta', text: 'answer' },
  {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: {
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 70, cacheWriteTokens: 10, noCacheTokens: 20 },
    },
  },
] as any[], 100);

anthropicMsgCase('finish data.usage 回落', [
  { type: 'finish', finishReason: 'stop', data: { usage: { inputTokens: 8, outputTokens: 3 } } },
] as any[], 8);

anthropicMsgCase('rawFinishReason tool_calls → tool_use', [
  { type: 'tool-call', toolCallId: 'tu_e', toolName: 'f', input: {} },
  { type: 'finish', rawFinishReason: 'tool_calls' },
] as any[]);

anthropicMsgCase('finishReason length → max_tokens', [
  { type: 'text-delta', text: 'cut' },
  { type: 'finish', finishReason: 'length' },
] as any[]);

anthropicMsgCase('finish 其他原因 → end_turn', [
  { type: 'text-delta', text: 'done' },
  { type: 'finish', finishReason: 'end_turn' },
] as any[]);

anthropicMsgCase('error 事件文本追加', [
  { type: 'text-delta', text: 'before' },
  { type: 'error', error: 'upstream exploded' },
] as any[]);

anthropicMsgCase('error 事件 unknown 忽略', [
  { type: 'error', error: 'unknown' },
] as any[]);

anthropicMsgCase('空事件数组 → 空 text 块', [] as any[]);

anthropicMsgCase('无 finish 回落 stop_reason（纯文本 end_turn）', [
  { type: 'text-delta', text: 'partial' },
] as any[]);

// ─── 执行 ────────────────────────────────────────────────────────────────────

describe('adapter 快照基线（拆分前后逐字节一致）', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(c.run()).toMatchSnapshot();
    });
  }

  it('用例数量 ≥ 50（防快照防线被悄悄缩水）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
  });
});
