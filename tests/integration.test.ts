import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };

// 随机空闲端口：多人并行跑测试或端口被占时不再假失败。
async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const srv = new net.default.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}
const MOCK_PORT = await getFreePort();
const PROXY_PORT = await getFreePort();
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;

// 集成测试启动的是编译产物 dist/index.js；干净克隆上没有 dist 会必然超时。
// 此时跳过整个套件并提示先 `npm run build`，避免 `npm test` 一上来就红。
const DIST_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');
const distReady = existsSync(DIST_ENTRY);

let mockServer: http.Server;
let proxyProcess: ChildProcess;
const capturedBodies: any[] = [];

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
      const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;

      // ── Non-generate endpoints: serve minimal JSON so the usage/plan paths
      // can be exercised (before this, EVERY path answered with SSE, which made
      // the dashboard's JSON endpoints unusable in tests). ──
      if (path !== '/alpha/generate') {
        res.setHeader('Content-Type', 'application/json');
        if (path === '/alpha/whoami') {
          res.end(JSON.stringify({ success: true, user: { id: 'u1', name: 'Integration Tester', userName: 'integration' } }));
          return;
        }
        if (path === '/alpha/billing/subscriptions') {
          res.end(JSON.stringify({
            success: true,
            data: {
              planId: 'individual-go',
              status: 'active',
              cancelAtPeriodEnd: false,
              currentPeriodStart: new Date(Date.now() - 14 * 864e5).toISOString(),
              currentPeriodEnd: new Date(Date.now() + 17 * 864e5).toISOString(),
            },
          }));
          return;
        }
        if (path === '/provider/v1/models') {
          res.end(JSON.stringify({
            object: 'list',
            data: [
              { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 200000 },
              { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', context_length: 200000 },
              { id: 'meituan/LongCat-2.0:free', name: 'LongCat 2.0', context_length: 131072 },
            ],
          }));
          return;
        }
        if (path === '/pricing-fake') {
          // 复刻官方定价页的 Next.js RSC payload 结构，让 availability 解析链路可测。
          const rows = [
            {
              id: 'claude-sonnet-5',
              name: 'Claude Sonnet 5',
              category: 'premium',
              contextWindow: 200000,
              caps: { text: true, vision: true, reasoning: true },
              availability: {
                'individual-go': false,
                'individual-goat': false,
                'individual-pro': false,
                'individual-provider': true,
                all: true,
              },
              tiers: [{ rates: { input: 3, output: 15 } }],
            },
            {
              id: 'claude-opus-4-8',
              name: 'Claude Opus 4.8',
              category: 'premium',
              contextWindow: 200000,
              caps: { text: true, vision: false, reasoning: true },
              availability: {
                'individual-go': false,
                'individual-goat': false,
                'individual-pro': false,
                'individual-provider': true,
                all: true,
              },
              tiers: [{ rates: { input: 15, output: 75 } }],
            },
            {
              id: 'meituan/LongCat-2.0:free',
              name: 'LongCat 2.0',
              category: 'free',
              contextWindow: 131072,
              caps: { text: true, vision: false, reasoning: false },
              availability: { 'individual-go': true, 'individual-goat': true, all: true },
              tiers: [{ rates: { input: 0, output: 0 } }],
            },
          ];
          res.setHeader('Content-Type', 'text/html');
          res.end(
            `<!doctype html><html><body><script>self.__next_f.push([1,${JSON.stringify(
              JSON.stringify({ rows }),
            )}])</script></body></html>`,
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'not mocked' }));
        return;
      }

      // 只记录 generate 请求，避免非生成流量污染"重试次数"断言。
      const parsed = JSON.parse(body || '{}');
      capturedBodies.push(parsed);
      const userText = JSON.stringify(parsed.params?.messages?.map((m: any) => m.content)) || '';

      // ── Error scenarios, driven by a sentinel in the user text ──
      const fail = (status: number, message: string) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message }));
        return true;
      };
      if (userText.includes('__TERMINAL_QUOTA__')) return fail(429, 'insufficient credits');
      if (userText.includes('__NOT_IN_PLAN__')) return fail(403, 'model_not_in_plan');
      if (userText.includes('__PLAIN_429__')) return fail(429, 'too many requests');
      if (userText.includes('__SERVER_ERROR__')) return fail(500, 'upstream exploded');

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
  // 状态文件（config/models/pricing）隔离到临时目录：否则启动时的账号名补全会把
  // mock 的假身份与随机 key 写进仓库根的 config.json，污染之后的真实运行。
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-it-'));
  proxyProcess = spawn(process.execPath, [path.join(projectRoot, 'dist', 'index.js')], {
    cwd: stateDir,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      HOST: '127.0.0.1',
      COMMANDCODE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      // 回环/私有地址默认被拒绝；此处显式允许本机 mock 上游（本地自建网关/sandbox 场景）。
      COMMANDCODE_UPSTREAM_ALLOWED_HOSTS: '127.0.0.1',
      // 全新环境（无 config.json / auth.json）下必须有可用凭据，否则 /v1/*
      // 一律 401，整个集成套件都会失败。mock 上游不校验其值，因此现场
      // 生成一个随机占位符即可（不是任何真实凭据）。
      COMMANDCODE_API_KEY: randomUUID(),
      // 状态与目录缓存全部落到临时目录，绝不写进仓库。
      COMMANDCODE_CONFIG_PATH: path.join(stateDir, 'config.json'),
      COMMANDCODE_MODELS_CACHE_PATH: path.join(stateDir, 'models.json'),
      COMMANDCODE_PRICING_CACHE_PATH: path.join(stateDir, 'pricing.json'),
      COMMANDCODE_PRICING_URL: `http://127.0.0.1:${MOCK_PORT}/pricing-fake`,
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

describe.skipIf(!distReady)('OpenAI /v1/chat/completions — real-client feel', () => {
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

  it('stream_options.include_usage attaches usage to the final chunk', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const raw = await res.text();
    const chunks = raw.split('\n\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
    const last = JSON.parse(chunks[chunks.length - 1].slice(6));
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage).toBeDefined();
    expect(last.usage.prompt_tokens).toBeGreaterThan(0);
    expect(last.usage.total_tokens).toBe(last.usage.prompt_tokens + last.usage.completion_tokens);
    // 未开启时不应出现 usage 字段
    const res2 = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });
    const raw2 = await res2.text();
    expect(raw2).not.toContain('"usage"');
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

  it('accepts request bodies larger than the 1MB Fastify default (no 413)', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024); // ~2MB payload
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: big }], max_tokens: 16 }),
    });
    // bodyLimit is raised to 64MB by default, so a >1MB body must NOT be rejected with 413.
    expect(res.status).toBe(200);
  });
});

// ─── Reasoning effort mapping ────────────────────────────────────────────────

describe.skipIf(!distReady)('Reasoning effort mapping (verified on the wire)', () => {
  async function captureEffort(model: string, effort?: string | number) {
    const _before = capturedBodies.length;
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

describe.skipIf(!distReady)('Anthropic /v1/messages — real-client feel', () => {
  it('count_tokens returns a local estimate without hitting the upstream', async () => {
    const res = await fetch(`${PROXY_BASE}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 16,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: '你好，世界 hello world' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { input_tokens: number };
    expect(Number.isFinite(data.input_tokens)).toBe(true);
    expect(data.input_tokens).toBeGreaterThan(0);
    // 不应产生上游 generate 调用
    const generateCalls = capturedBodies.length;
    await fetch(`${PROXY_BASE}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] }),
    });
    expect(capturedBodies.length).toBe(generateCalls);
  });

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

// ─── Structured error contract ────────────────────────────────────────────────
// 每个失败都必须带稳定错误码 + 可执行提示，且终止性计费/套餐错误绝不重试。

describe.skipIf(!distReady)('structured error contract', () => {
  const ask = (text: string) => ({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: text }],
    max_tokens: 32,
  });

  const postChat = (body: any) =>
    fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const postMessages = (body: any) =>
    fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('OpenAI route: quota exhaustion → 429 RATE_LIMIT with an actionable hint', async () => {
    const res = await postChat(ask('__TERMINAL_QUOTA__'));
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.code).toBe('RATE_LIMIT');
    expect(data.error.type).toBe('rate_limit_error');
    expect(data.error.hint).toContain('usage window');
  });

  it('OpenAI route: model outside plan → 403 MODEL_NOT_IN_PLAN', async () => {
    const res = await postChat(ask('__NOT_IN_PLAN__'));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe('MODEL_NOT_IN_PLAN');
    expect(data.error.type).toBe('permission_error');
    expect(data.error.hint).toContain('subscription tier');
  });

  it('OpenAI route: 5xx → SERVER_ERROR (retries exhausted, upstream status preserved)', async () => {
    const res = await postChat(ask('__SERVER_ERROR__'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.code).toBe('SERVER_ERROR');
  });

  it('terminal billing errors are never retried (exactly one upstream attempt)', async () => {
    const before = capturedBodies.length;
    await postChat(ask('__TERMINAL_QUOTA__'));
    expect(capturedBodies.length - before).toBe(1);
  });

  it('a plain 429 still retries with backoff (contrast with the terminal case)', async () => {
    const before = capturedBodies.length;
    const res = await postChat(ask('__PLAIN_429__'));
    expect(capturedBodies.length - before).toBeGreaterThan(1);
    // 重试耗尽后仍保留上游真实状态与错误码，不伪装成网络故障。
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('RATE_LIMIT');
  }, 20000);

  it('Anthropic route: uses the Anthropic error envelope with a canonical error type', async () => {
    const res = await postMessages(ask('__TERMINAL_QUOTA__'));
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.type).toBe('error');
    expect(data.error.type).toBe('rate_limit_error');
    expect(data.error.code).toBe('RATE_LIMIT');
    expect(data.error.hint).toBeTruthy();
  });

  it('invalid OpenAI request → 400 UNSUPPORTED_OPTION', async () => {
    const res = await postChat({ model: 'claude-sonnet-5' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('UNSUPPORTED_OPTION');
    expect(data.error.type).toBe('invalid_request_error');
  });

  it('invalid Anthropic request → 400 invalid_request_error', async () => {
    const res = await postMessages({ model: 'claude-sonnet-5' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.type).toBe('error');
    expect(data.error.code).toBe('UNSUPPORTED_OPTION');
    expect(data.error.type).toBe('invalid_request_error');
  });

  it('paused gateway → 503 GATEWAY_PAUSED (and resumes cleanly)', async () => {
    const toggle = (running: boolean) =>
      fetch(`${PROXY_BASE}/api/gateway/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running }),
      });

    await toggle(false);
    try {
      const res = await postChat(ask('Hi'));
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error.code).toBe('GATEWAY_PAUSED');
      expect(data.error.hint).toContain('paused');
    } finally {
      await toggle(true);
    }

    // Engine is back up: the same request now succeeds.
    const ok = await postChat(ask('Hi'));
    expect(ok.status).toBe(200);
  });
});

// ─── Version reporting ────────────────────────────────────────────────────────

describe.skipIf(!distReady)('version reporting', () => {
  it('/health reports the real package version instead of a hardcoded string', async () => {
    const data = await (await fetch(`${PROXY_BASE}/health`)).json();
    expect(data.status).toBe('ok');
    expect(data.version).toBe(pkg.version);
    expect(data.version).not.toBe('4.0.0');
  });

  it('/api/status reports the same version', async () => {
    const data = await (await fetch(`${PROXY_BASE}/api/status`)).json();
    expect(data.version).toBe(pkg.version);
  });
});

// ─── Subscription plan + billing cycle (/api/usage/overview) ──────────────────

describe.skipIf(!distReady)('plan & billing cycle', () => {
  it('exposes the subscription plan with its verified credit caps', async () => {
    const res = await fetch(`${PROXY_BASE}/api/usage/overview`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.plan).toBeTruthy();
    expect(d.plan.planId).toBe('individual-go');
    expect(d.plan.name).toBe('Go');
    expect(d.plan.status).toBe('active');
    expect(d.plan.monthlyCredits).toBe(10);
    expect(d.plan.fiveHourCap).toBe(3);
    expect(d.plan.weeklyCap).toBe(6);
    expect(d.plan.cancelAtPeriodEnd).toBe(false);
  });

  it('derives the billing cycle window from currentPeriodStart/End', async () => {
    const d = await (await fetch(`${PROXY_BASE}/api/usage/overview`)).json();
    const p = d.plan;
    expect(p.currentPeriodStart).toBeGreaterThan(0);
    expect(p.currentPeriodEnd).toBeGreaterThan(p.currentPeriodStart);
    expect(p.totalDays).toBeGreaterThan(0);
    expect(p.daysElapsed).toBeGreaterThanOrEqual(0);
    expect(p.daysLeft).toBeGreaterThan(0);
    expect(p.daysLeft).toBeLessThanOrEqual(Math.ceil(p.totalDays));
    expect(p.cyclePct).toBeGreaterThanOrEqual(0);
    expect(p.cyclePct).toBeLessThanOrEqual(100);
  });
});

// ─── Per-plan model availability (③) ──────────────────────────────────────────

describe.skipIf(!distReady)('per-plan model availability', () => {
  beforeAll(async () => {
    // 显式同步一次目录 + 定价（含 availability），不依赖启动时的后台同步时序。
    const res = await fetch(`${PROXY_BASE}/v1/models/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it('preserves the upstream per-plan availability map (no longer a single onGoPlan boolean)', async () => {
    const d = await (await fetch(`${PROXY_BASE}/v1/models`)).json();
    expect(d.object).toBe('list');
    expect(d.plan).toBeUndefined(); // 默认行为不变：无 plan 块、不过滤
    const opus = d.data.find((m: any) => m.id === 'claude-opus-4-8');
    expect(opus.availability['individual-go']).toBe(false);
    expect(opus.availability['individual-provider']).toBe(true);
    expect(opus.onGoPlan).toBe(false);
    expect(opus.pricing.input).toBe(15); // 定价富化仍然生效
  });

  it('reports availability per model for an explicitly requested plan', async () => {
    const d = await (await fetch(`${PROXY_BASE}/v1/models?plan=individual-go`)).json();
    const opus = d.data.find((m: any) => m.id === 'claude-opus-4-8');
    const open = d.data.find((m: any) => m.id === 'meituan/LongCat-2.0:free');
    expect(opus.available_on_plan).toBe(false);
    expect(open.available_on_plan).toBe(true);
    expect(opus.plan_tier).toBe('Provider'); // all=true 不计入，故只剩 Provider
    expect(open.plan_tier).toBe('Go · GOAT');
  });

  it('filters to the requested plan with available=1', async () => {
    const all = await (await fetch(`${PROXY_BASE}/v1/models`)).json();
    const d = await (await fetch(`${PROXY_BASE}/v1/models?plan=individual-go&available=1`)).json();
    expect(d.plan.id).toBe('individual-go');
    expect(d.plan.name).toBe('Go');
    expect(d.plan.monthlyCredits).toBe(10);
    expect(d.plan.availableOnly).toBe(true);
    expect(d.plan.filteredCount).toBe(d.data.length);
    expect(d.data.length).toBeLessThan(all.data.length);
    expect(d.data.some((m: any) => m.id === 'claude-opus-4-8')).toBe(false);
    expect(d.data.some((m: any) => m.id === 'meituan/LongCat-2.0:free')).toBe(true);
    for (const m of d.data) expect(m.available_on_plan).not.toBe(false);
  });

  it('falls back to the active account plan when plan is omitted', async () => {
    const d = await (await fetch(`${PROXY_BASE}/v1/models?available=1`)).json();
    // mock 的 /alpha/billing/subscriptions 返回 individual-go
    expect(d.plan.id).toBe('individual-go');
    expect(d.plan.monthlyCredits).toBe(10);
    expect(d.data.some((m: any) => m.id === 'claude-opus-4-8')).toBe(false);
  });
});
