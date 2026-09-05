import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

const MOCK_PORT = 9911;
const PROXY_PORT = 9091;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;

let mockServer: http.Server;
let proxyProcess: ChildProcess;
let capturedBodies: any[] = [];

/** Build an SSE response body from CC events. */
function sse(events: any[]): string {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

beforeAll(async () => {
  // ── Mock CommandCode upstream ──
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      capturedBodies.push(parsed);
      const userText = JSON.stringify(parsed.params?.messages?.map((m: any) => m.content)) || '';

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (userText.includes('__TOOLSTREAM__')) {
        // Tool-calling scenario: model decides to call a tool
        res.end(sse([
          { type: 'start' },
          { type: 'text-delta', text: 'Let me check the weather.' },
          { type: 'tool-call', toolCallId: 'call_weather_1', toolName: 'get_weather', input: { city: 'Chennai', unit: 'celsius' } },
          { type: 'finish', finishReason: 'tool-calls', data: { usage: { inputTokens: 42, outputTokens: 17 } } },
        ]));
      } else if (userText.includes('__THINK__')) {
        // Reasoning scenario
        res.end(sse([
          { type: 'start' },
          { type: 'reasoning-delta', text: 'Analyzing the problem step by step...' },
          { type: 'text-delta', text: 'The answer is 4.' },
          { type: 'finish', finishReason: 'stop', data: { usage: { inputTokens: 10, outputTokens: 25 } } },
        ]));
      } else {
        // Plain text scenario
        res.end(sse([
          { type: 'start' },
          { type: 'text-delta', text: 'Hello, ' },
          { type: 'text-delta', text: 'world!' },
          { type: 'finish', finishReason: 'stop', data: { usage: { inputTokens: 7, outputTokens: 3 } } },
        ]));
      }
    });
  });
  await new Promise<void>(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

  // ── Proxy under test ──
  const projectRoot = path.resolve(__dirname, '..');
  proxyProcess = spawn(process.execPath, ['dist/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      HOST: '127.0.0.1',
      COMMANDCODE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      // 全新环境（无 config.json / auth.json）下必须有可用凭据，否则 /v1/*
      // 一律 401，整个集成套件都会失败。mock 上游不校验其值，因此现场
      // 生成一个随机占位符即可（不是任何真实凭据）。
      COMMANDCODE_API_KEY: randomUUID(),
      NO_OPEN_BROWSER: '1',
    },
    stdio: 'ignore',
  });

  // Wait for readiness
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PROXY_BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Proxy did not become ready in time');
}, 40000);

afterAll(async () => {
  if (proxyProcess) {
    proxyProcess.kill();
    await new Promise(r => setTimeout(r, 500));
    if (proxyProcess.pid && !proxyProcess.killed) {
      try {
        spawn('taskkill', ['/pid', String(proxyProcess.pid), '/T', '/F']);
      } catch {}
    }
  }
  if (mockServer) await new Promise<void>(r => mockServer.close(() => r()));
});

// ─── OpenAI compatibility ─────────────────────────────────────────────────────

describe('OpenAI /v1/chat/completions — real-client feel', () => {
  it('non-streaming: exact OpenAI response envelope with usage', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.object).toBe('chat.completion');
    expect(data.id).toMatch(/^chatcmpl-/);
    expect(typeof data.created).toBe('number');
    expect(data.model).toBe('claude-sonnet-5');
    expect(data.choices).toHaveLength(1);
    expect(data.choices[0].index).toBe(0);
    expect(data.choices[0].message.role).toBe('assistant');
    expect(data.choices[0].message.content).toBe('Hello, world!');
    expect(data.choices[0].finish_reason).toBe('stop');
    // Usage must come from upstream finish event, not estimates
    expect(data.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it('streaming: chunk sequence matches OpenAI SSE spec exactly', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const raw = await res.text();
    const allLines = raw.split('\n').filter(l => l.startsWith('data: '));
    const payloads = allLines.filter(l => !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)));

    // First chunk: role announcement delta
    expect(payloads[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(payloads[0].choices[0].finish_reason).toBeNull();

    // Every chunk carries the same id/object/created/model
    for (const p of payloads) {
      expect(p.object).toBe('chat.completion.chunk');
      expect(p.id).toMatch(/^chatcmpl-/);
      expect(p.model).toBe('claude-sonnet-5');
      expect(p.choices[0]).toHaveProperty('index');
      expect(p.choices[0]).toHaveProperty('delta');
      expect(p.choices[0]).toHaveProperty('finish_reason');
    }

    // Text deltas arrive in order
    const textDeltas = payloads.filter(p => p.choices[0].delta.content);
    expect(textDeltas.map(p => p.choices[0].delta.content)).toEqual(['Hello, ', 'world!']);

    // Terminal chunk: empty delta + finish_reason, then [DONE]
    const finishChunk = payloads.find(p => p.choices[0].finish_reason !== null);
    expect(finishChunk.choices[0].finish_reason).toBe('stop');
    expect(finishChunk.choices[0].delta).toEqual({});
    expect(allLines[allLines.length - 1]).toBe('data: [DONE]');
  });

  it('tool calling: streamed tool_calls deltas with correct ids/names/args', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: '__TOOLSTREAM__ weather in Chennai?' }],
        max_tokens: 200,
        stream: true,
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string' } } },
          },
        }],
      }),
    });
    const raw = await res.text();
    const payloads = raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)));

    // Content delta arrives first
    const contentDelta = payloads.find(p => p.choices[0].delta.content);
    expect(contentDelta.choices[0].delta.content).toBe('Let me check the weather.');

    // Tool call delta: OpenAI-shaped tool_calls array
    const toolDelta = payloads.find(p => p.choices[0].delta.tool_calls);
    expect(toolDelta).toBeDefined();
    const tc = toolDelta.choices[0].delta.tool_calls[0];
    expect(tc.index).toBe(0);
    expect(tc.id).toBe('call_weather_1');
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: 'Chennai', unit: 'celsius' });

    // Finish reason must be tool_calls (what OpenAI clients switch on)
    const finish = payloads.find(p => p.choices[0].finish_reason !== null);
    expect(finish.choices[0].finish_reason).toBe('tool_calls');

    // Wire payload carried our tool definition (name/description/schema only)
    const wire = capturedBodies[capturedBodies.length - 1];
    expect(wire.params.tools).toHaveLength(1);
    expect(wire.params.tools[0]).toEqual({
      name: 'get_weather',
      description: 'Get current weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string' } } },
    });
  });

  it('non-streaming tool call: message.tool_calls array like real OpenAI', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: '__TOOLSTREAM__ weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
      }),
    });
    const data = await res.json();
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.content).toBe('Let me check the weather.');
    expect(data.choices[0].message.tool_calls).toHaveLength(1);
    expect(data.choices[0].message.tool_calls[0]).toEqual({
      id: 'call_weather_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Chennai","unit":"celsius"}' },
    });
  });
});

// ─── Reasoning effort mapping ────────────────────────────────────────────────

describe('Reasoning effort mapping (verified on the wire)', () => {
  async function captureEffort(model: string, effort?: string | number) {
    const before = capturedBodies.length;
    await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'x' }],
        ...(effort !== undefined ? { reasoning_effort: effort } : {}),
      }),
    });
    return capturedBodies[capturedBodies.length - 1];
  }

  it('valid effort passes through unchanged', async () => {
    const wire = await captureEffort('claude-sonnet-5', 'xhigh');
    expect(wire.params.reasoning_effort).toBe('xhigh');
  });

  it('unsupported effort snaps DOWN to nearest supported tier', async () => {
    // deepseek supports ['high','max'] only — 'low' must snap to 'high'
    const wire = await captureEffort('deepseek/deepseek-v4-pro', 'low');
    expect(wire.params.reasoning_effort).toBe('high');
  });

  it('no effort requested → no reasoning_effort field (original CLI behavior)', async () => {
    const wire = await captureEffort('claude-sonnet-5');
    // Original CLI: supportsThinking gates the field; no default is injected.
    expect(wire.params.reasoning_effort).toBeUndefined();
  });

  it('numeric efforts map like OpenAI-style levels', async () => {
    const wire = await captureEffort('claude-sonnet-5', 4);
    expect(wire.params.reasoning_effort).toBe('high');
  });

  it('models without requested effort send no field; gemini default omitted', async () => {
    const wire = await captureEffort('google/gemini-3.6-flash');
    // Original CLI never invents a default — the field is simply absent.
    expect(wire.params.reasoning_effort).toBeUndefined();
  });
});

// ─── Anthropic compatibility ─────────────────────────────────────────────────

describe('Anthropic /v1/messages — real-client feel', () => {
  it('thinking budget_tokens maps to effort tiers on the wire', async () => {
    await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 10000 },
        messages: [{ role: 'user', content: '__THINK__ solve this' }],
      }),
    });
    const wire = capturedBodies[capturedBodies.length - 1];
    expect(wire.params.reasoning_effort).toBe('high'); // 8000–15999 → high
  });

  it('streaming: full Anthropic block lifecycle incl. signature_delta', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: '__THINK__ what is 2+2' }],
      }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const raw = await res.text();
    const events = raw.split('\n\n').filter(Boolean).map(chunk => {
      const evLine = chunk.split('\n').find(l => l.startsWith('event: '));
      const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
      return { type: evLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
    });
    const types = events.map(e => e.type);

    // Canonical Anthropic event order
    expect(types[0]).toBe('message_start');
    expect(types).toContain('ping');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types[types.length - 2]).toBe('message_delta');
    expect(types[types.length - 1]).toBe('message_stop');

    // Thinking block opens with type thinking
    const thinkStart = events.find(e => e.data?.content_block?.type === 'thinking');
    expect(thinkStart).toBeDefined();

    // thinking_delta present, followed by signature_delta before close
    const thinkDeltas = events.filter(e => e.data?.delta?.type === 'thinking_delta');
    expect(thinkDeltas.length).toBeGreaterThan(0);
    const sigDelta = events.find(e => e.data?.delta?.type === 'signature_delta');
    expect(sigDelta).toBeDefined();

    // Text block lifecycle after thinking
    const textStart = events.find(e => e.data?.content_block?.type === 'text');
    expect(textStart).toBeDefined();
    const textDelta = events.find(e => e.data?.delta?.type === 'text_delta');
    expect(textDelta.data.delta.text).toBe('The answer is 4.');

    // Both blocks closed
    const stops = events.filter(e => e.type === 'content_block_stop');
    expect(stops.length).toBe(2);

    // Final stop reason + usage
    const msgDelta = events.find(e => e.type === 'message_delta');
    expect(msgDelta.data.delta.stop_reason).toBe('end_turn');
    expect(msgDelta.data.usage.output_tokens).toBe(25);
  });

  it('tool round-trip: tool_use history converts correctly on the wire', async () => {
    await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Read a.txt' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'a.txt' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'FILE DATA' }] },
        ],
      }),
    });
    const wire = capturedBodies[capturedBodies.length - 1];

    // Assistant turn became a CC tool-call part
    const assistant = wire.params.messages.find((m: any) => m.role === 'assistant');
    const callPart = (assistant.content as any[]).find(p => p.type === 'tool-call');
    expect(callPart.toolCallId).toBe('toolu_9');
    expect(callPart.toolName).toBe('read_file');

    // Tool result survived (the v3 killer bug)
    const toolMsg = wire.params.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const resultPart = (toolMsg.content as any[])[0];
    expect(resultPart.toolCallId).toBe('toolu_9');
    expect(resultPart.output.value).toBe('FILE DATA');
  });

  it('non-streaming: Anthropic envelope with thinking + text + usage', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: '__THINK__ hi' }],
      }),
    });
    const data = await res.json();
    expect(data.type).toBe('message');
    expect(data.role).toBe('assistant');
    expect(data.id).toMatch(/^msg_/);
    expect(data.stop_reason).toBe('end_turn');
    expect(data.usage).toEqual({ input_tokens: 10, output_tokens: 25 });
    expect(data.content[0]).toEqual({ type: 'thinking', thinking: 'Analyzing the problem step by step...', signature: '' });
    expect(data.content[1]).toEqual({ type: 'text', text: 'The answer is 4.' });
  });
});
