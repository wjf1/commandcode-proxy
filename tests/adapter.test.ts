import { describe, it, expect } from 'vitest';
import { CommandCodeAdapter } from '../src/adapters/commandcode/adapter.js';
import { AnthropicRequest, OpenAIChatRequest } from '../src/types/index.js';

const adapter = new CommandCodeAdapter();

describe('OpenAI → CC translation', () => {
  it('translates basic chat with system + user', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 100,
    };
    const wire = adapter.translateOpenAIRequest(req);
    expect(wire.params.model).toBe('claude-sonnet-5');
    expect(wire.params.system).toBe('You are helpful.');
    expect(wire.params.messages).toHaveLength(1);
    expect(wire.params.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(wire.params.max_tokens).toBe(100);
    expect(wire.params.stream).toBe(true);
  });

  it('converts assistant tool_calls and tool results into CC parts', () => {
    const req: OpenAIChatRequest = {
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
      ],
    };
    const wire = adapter.translateOpenAIRequest(req);
    const assistant = wire.params.messages.find(m => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const callPart = (assistant!.content as any[]).find(p => p.type === 'tool-call');
    expect(callPart.toolCallId).toBe('call_1');
    expect(callPart.toolName).toBe('read_file');
    expect(callPart.input).toEqual({ path: 'a.txt' });

    const toolMsg = wire.params.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const resultPart = (toolMsg!.content as any[])[0];
    expect(resultPart.type).toBe('tool-result');
    expect(resultPart.output.value).toBe('file contents here');
  });

  it('prunes dangling tool results (no matching call) to avoid upstream 400s', () => {
    const req: OpenAIChatRequest = {
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'ghost_id', content: 'orphan' },
        { role: 'user', content: 'again' },
      ],
    };
    const wire = adapter.translateOpenAIRequest(req);
    for (const m of wire.params.messages) {
      if (Array.isArray(m.content)) {
        for (const p of m.content as any[]) {
          expect(p.type === 'tool-result' ? true : true).toBe(true);
          if (p.type === 'tool-result') expect(p.toolCallId).not.toBe('ghost_id');
        }
      }
    }
    // The orphan-only tool message should have been dropped entirely.
    expect(wire.params.messages.some(m => m.role === 'tool')).toBe(false);
  });

  it('maps reasoning_effort to supported tiers only', () => {
    const req: OpenAIChatRequest = {
      model: 'deepseek/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'x' }],
      reasoning_effort: 'low', // deepseek supports ['high','max'] → snaps to 'high'
    };
    const wire = adapter.translateOpenAIRequest(req);
    expect(wire.params.reasoning_effort).toBe('high');
  });

  it('respects thinking budget_tokens for Anthropic-style extended thinking', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 20000 },
    };
    const wire = adapter.translateOpenAIRequest(req);
    expect(wire.params.reasoning_effort).toBe('max');
  });
});

describe('Anthropic → CC translation (v3 bug fixes)', () => {
  it('converts user tool_result blocks into tool messages — NOT dropped', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Read a.txt' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the file data' }],
        },
      ],
    };
    const wire = adapter.translateAnthropicRequest(req);
    const toolMsg = wire.params.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined(); // v3 dropped this entirely
    const part = (toolMsg!.content as any[])[0];
    expect(part.type).toBe('tool-result');
    expect(part.toolCallId).toBe('toolu_1');
    expect(part.output.value).toBe('the file data');
  });

  it('marks is_error tool_results with [ERROR] prefix', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'run_cmd', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
        },
      ],
    };
    const wire = adapter.translateAnthropicRequest(req);
    const toolMsg = wire.params.messages.find(m => m.role === 'tool')!;
    expect(((toolMsg.content as any[])[0].output.value as string)).toContain('[ERROR] boom');
  });

  it('converts base64 image blocks to raw wire shape with mediaType', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
            { type: 'text', text: 'what is this?' },
          ],
        },
      ],
    };
    const wire = adapter.translateAnthropicRequest(req);
    const userMsg = wire.params.messages[0];
    const parts = userMsg.content as any[];
    // Original CLI wire shape: raw base64 + mediaType, not a data URL
    expect(parts[0]).toEqual({ type: 'image', image: 'QUJD', mediaType: 'image/png' });
    expect(parts[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('joins system block arrays instead of JSON.stringify-ing them', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'Rule one.' },
        { type: 'text', text: 'Rule two.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const wire = adapter.translateAnthropicRequest(req);
    expect(wire.params.system).toBe('Rule one.\n\nRule two.');
  });

  it('maps Anthropic tools and tool_choice any→any, tool→tool', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'any' },
    };
    const wire = adapter.translateAnthropicRequest(req);
    expect(wire.params.tools).toHaveLength(1);
    expect(wire.params.tools![0].name).toBe('get_weather');
    expect((wire.params.tool_choice as any).type).toBe('any');
  });

  it('preserves assistant thinking history as reasoning_content', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should analyze this.', signature: 'sig' },
            { type: 'text', text: 'Answer' },
          ],
        },
        { role: 'user', content: 'go on' },
      ],
    };
    const wire = adapter.translateAnthropicRequest(req);
    const assistant = wire.params.messages.find(m => m.role === 'assistant')!;
    // thinking history rides along inside the assistant text parts
    const parts = assistant.content as any[];
    if (Array.isArray(parts)) {
      expect(parts.some(p => p.type === 'reasoning' && p.text === 'I should analyze this.')).toBe(true);
    } else {
      expect((parts as any).reasoning_content).toBe('I should analyze this.');
    }
  });
});

describe('Stream encoding', () => {
  it('emits OpenAI chunks with correct finish_reason mapping', () => {
    const state = adapter.createStreamEncoderState('claude-sonnet-5');
    const out = [
      ...adapter.encodeOpenAIChunk({ type: 'start' }, state),
      ...adapter.encodeOpenAIChunk({ type: 'text-delta', text: 'Hello' }, state),
      ...adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'length' }, state),
    ];
    expect(out).toHaveLength(4); // start + delta + finish + [DONE]
    expect(out[2]).toContain('"finish_reason":"length"');
    expect(out[3]).toContain('[DONE]');
  });

  it('splits inline  thinking tags into reasoning_content', () => {
    const state = adapter.createStreamEncoderState('m');
    const chunks = adapter.encodeOpenAIChunk(
      { type: 'text-delta', text: ' thinkinghmm responsevisible' },
      state
    );
    const joined = chunks.join('');
    expect(joined).toContain('reasoning_content');
    expect(joined).toContain('"content":"visible"');
    expect(joined).not.toContain(' thinking');
  });

  it('builds valid Anthropic non-streaming response with tool_use', () => {
    const events: any[] = [
      { type: 'start' },
      { type: 'reasoning-delta', text: 'thinking...' },
      { type: 'text-delta', text: 'Let me check.' },
      { type: 'tool-call', toolCallId: 'tu_1', toolName: 'search', input: { q: 'x' } },
      { type: 'finish', finishReason: 'tool-calls', data: { usage: { inputTokens: 10, outputTokens: 20 } } },
    ];
    const msg = adapter.buildAnthropicResponse(events, 'msg_x', 'claude-sonnet-5', 5);
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(msg.content.some((b: any) => b.type === 'thinking')).toBe(true);
    expect(msg.content.some((b: any) => b.type === 'text')).toBe(true);
    expect(msg.content.some((b: any) => b.type === 'tool_use' && b.name === 'search')).toBe(true);
  });
});
