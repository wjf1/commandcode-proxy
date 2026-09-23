// =============================================================================
// 回归防线：流式工具调用的分片必须**合并**，超时必须**可见**。
// -----------------------------------------------------------------------------
// 三条既有测试都没覆盖到的路径：
//   1. adapter.ts 的 OpenAI 流式编码器：上游 finish 事件明确给 stop 时，会压过
//      实际已流出的 tool_calls（此前只有 `__TOOLSTREAM__` 用例，它给的是
//      finishReason:'tool-calls'，正好绕过缺陷）。后果：客户端按 finish_reason
//      判回合结束，整批工具调用被丢弃、agent 静默卡住。
//   2. messages.ts：每个 tool-call-delta 分片各自发一轮 content_block_start/delta/stop
//      并递增索引 → N 个分片变成 N 个同 id 块、各带一段 JSON 碎片。
//   3. chat.ts 非流式：toolCallsMap.set 覆盖，arguments 只剩最后一片。
// 另加上游空闲超时的**分类**：流已交还调用方后再被空闲看门狗掐断，错误到路由里
// 走的是 toProxyError 的兜底，被记成 PROVIDER_PROTOCOL_ERROR（502 语义）而不是超时。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { CommandCodeAdapter as AdapterType } from '../src/adapters/commandcode/adapter.js';

const IDLE_TIMEOUT_MS = 700;
const TOTAL_TIMEOUT_MS = 20_000; // 确保只有空闲看门狗能触发 idle 用例

// 必须是**动态** import：adapter.ts → models.ts → config.ts，而 CONFIG_FILE_PATH /
// ENV_FILE_PATH 是 config.ts 的模块级常量，只在首次求值时读一次 env。静态 import 会在
// beforeAll 设置 COMMANDCODE_CONFIG_PATH 之前就把这个模块初始化掉，于是本用例实际跑在
// 代码默认值上（idle 120s / 总时限 1800s），超时类断言全部失效并且把测试挂死。
let adapter: AdapterType;

/** 从 SSE 文本里取出所有 `data:` 帧的 JSON。 */
function frames(raw: string): any[] {
  return raw
    .split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

function anthropicEvents(raw: string): any[] {
  return frames(raw).filter(f => f && f.type);
}

describe('A5 · OpenAI 流式编码器的 finish_reason', () => {
  const encodeAll = (events: any[]): any[] => {
    const state = adapter.createStreamEncoderState('claude-sonnet-5');
    const out: string[] = [];
    for (const e of events) out.push(...adapter.encodeOpenAIChunk(e, state));
    return frames(out.join(''));
  };

  it('上游明确回 stop 也不得压过已流出的工具调用', () => {
    const fs = encodeAll([
      { type: 'start' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Chennai' } },
      // 关键：上游给的是 stop/end_turn —— 旧实现在这里让 rawFR 直接胜出，
      // 客户端于是把这一步当成纯文本回合结束。
      { type: 'finish', finishReason: 'stop' },
    ]);
    const last = [...fs].reverse().find(f => f.choices?.[0]?.finish_reason);
    expect(last?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('被 max_tokens 截断时仍如实报 length', () => {
    const fs = encodeAll([
      { type: 'start' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'f', input: {} },
      { type: 'finish', finishReason: 'length' },
    ]);
    const last = [...fs].reverse().find(f => f.choices?.[0]?.finish_reason);
    expect(last?.choices?.[0]?.finish_reason).toBe('length');
  });

  it('没有工具调用时保持 stop', () => {
    const fs = encodeAll([
      { type: 'start' },
      { type: 'text-delta', text: 'hi' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const last = [...fs].reverse().find(f => f.choices?.[0]?.finish_reason);
    expect(last?.choices?.[0]?.finish_reason).toBe('stop');
  });
});

let app: FastifyInstance;
let mock: http.Server;
let baseUrl = '';
const uncaught: Error[] = [];
const onUncaught = (e: Error) => uncaught.push(e);

/** 把一段上游事件序列渲染成 SSE 响应体。 */
const sse = (events: any[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

beforeAll(async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-tcfrag-'));

  mock = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (p !== '/alpha/generate') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true }));
      return;
    }
    let payload = '';
    req.on('data', c => { payload += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (payload.includes('__FRAG_ARGS_TEXT__')) {
        // AI-SDK 形态：首片带 id/name，后续片只给 argsText 片段。
        res.end(sse([
          { type: 'start' },
          { type: 'tool-call-delta', toolCallId: 'call_a', toolName: 'write_file', argsText: '{"path"' },
          { type: 'tool-call-delta', argsText: ':"a.txt"' },
          { type: 'tool-call-delta', argsText: ',"content":"hi"}' },
          { type: 'finish', finishReason: 'tool-calls' },
        ]));
        return;
      }
      if (payload.includes('__FRAG_INPUT__')) {
        // 字符串形态的 input 片段（旧代码读取链里本来就有 input）。
        res.end(sse([
          { type: 'start' },
          { type: 'tool-call-delta', toolCallId: 'call_b', toolName: 'search', input: '{"q"' },
          { type: 'tool-call-delta', input: ':"x"}' },
          { type: 'finish', finishReason: 'tool-calls' },
        ]));
        return;
      }
      if (payload.includes('__TWO_TOOLS__')) {
        // 同回合两个工具调用，且第二个不带 id 之前的回落曾是 'call_1' 固定值。
        res.end(sse([
          { type: 'start' },
          { type: 'tool-call', toolCallId: 'call_x', toolName: 'one', input: { a: 1 } },
          { type: 'tool-call', toolCallId: 'call_y', toolName: 'two', input: { b: 2 } },
          { type: 'finish', finishReason: 'tool-calls' },
        ]));
        return;
      }
      if (payload.includes('__IDLE_STALL__')) {
        // 出一个字节后就静默：不注册任何计时器，响应对象自己就会一直挂着，
        // 空闲看门狗必须把这次失败说出口。
        res.write(sse([{ type: 'start' }, { type: 'text-delta', text: 'partial' }]));
        return;
      }
      res.end(sse([
        { type: 'start' },
        { type: 'text-delta', text: 'Hello.' },
        { type: 'finish', finishReason: 'stop' },
      ]));
    });
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ upstream: { timeoutMs: TOTAL_TIMEOUT_MS, idleTimeoutMs: IDLE_TIMEOUT_MS, maxRetries: 0 } }),
  );
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_API_KEY = 'ck-toolcall-fixture-credential';
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');

  process.on('uncaughtException', onUncaught);

  // env 就位之后才允许加载 src 模块（见文件顶部说明）。
  const { CommandCodeAdapter } = await import('../src/adapters/commandcode/adapter.js');
  adapter = new CommandCodeAdapter();

  const { chatRoutes } = await import('../src/routes/chat.js');
  const { messagesRoutes } = await import('../src/routes/messages.js');
  app = Fastify();
  await app.register(chatRoutes);
  await app.register(messagesRoutes);
  // 必须真监听：路由写 reply.raw 并对 socket 调 setTimeout(0)，inject 没有真实 socket。
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.removeListener('uncaughtException', onUncaught);
  await app?.close();
  await new Promise<void>(r => mock.close(() => r()));
});

async function postChat(sentinel: string, stream = false): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      stream,
      messages: [{ role: 'user', content: sentinel }],
    }),
  });
  return res.text();
}

async function postMessages(sentinel: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: sentinel }],
    }),
  });
  return res.text();
}

describe('A4 · /v1/chat/completions 非流式的分片合并', () => {
  it('argsText 片段拼成完整可解析的 arguments', async () => {
    const body = JSON.parse(await postChat('__FRAG_ARGS_TEXT__'));
    const tc = body.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc[0].id).toBe('call_a');
    expect(JSON.parse(tc[0].function.arguments)).toEqual({ path: 'a.txt', content: 'hi' });
    expect(body.choices[0].finish_reason).toBe('tool_calls');
  });

  it('字符串 input 片段同样合并', async () => {
    const body = JSON.parse(await postChat('__FRAG_INPUT__'));
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ q: 'x' });
  });

  it('同回合多个工具调用不互相覆盖', async () => {
    const body = JSON.parse(await postChat('__TWO_TOOLS__'));
    const tcs = body.choices[0].message.tool_calls;
    expect(tcs.map((t: any) => t.id)).toEqual(['call_x', 'call_y']);
    expect(JSON.parse(tcs[1].function.arguments)).toEqual({ b: 2 });
  });
});

describe('A3 · /v1/messages 流式的 tool_use 块', () => {
  it('同一调用只有一个 content_block_start，片段以 input_json_delta 追加', async () => {
    const raw = await postMessages('__FRAG_ARGS_TEXT__');
    const events = anthropicEvents(raw);

    const starts = events.filter(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    const stops = events.filter(e => e.type === 'content_block_stop');
    expect(starts).toHaveLength(1);
    // 旧实现这里会是 3 个 start / 3 个 stop（每片一个块）。
    expect(stops.filter(s => s.index === starts[0].index)).toHaveLength(1);

    const deltas = events
      .filter(e => e.type === 'content_block_delta' && e.index === starts[0].index)
      .map(e => e.delta?.partial_json ?? '');
    const joined = deltas.join('');
    expect(JSON.parse(joined)).toEqual({ path: 'a.txt', content: 'hi' });
  });

  it('收尾 stop_reason 为 tool_use 且块索引不撞文本/thinking 块', async () => {
    const raw = await postMessages('__FRAG_INPUT__');
    const events = anthropicEvents(raw);
    const start = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    expect(start.index).toBeGreaterThanOrEqual(2);
    const mdelta = events.find(e => e.type === 'message_delta');
    expect(mdelta.delta.stop_reason).toBe('tool_use');
  });
});

describe('A2 · 空闲超时的错误分类', () => {
  it('上游只出一个字节后静默：按超时上报，而不是被兜底成协议错误', async () => {
    const started = Date.now();
    const raw = await postMessages('__IDLE_STALL__');
    const elapsed = Date.now() - started;

    expect(elapsed, '应由空闲看门狗终止').toBeLessThan(TOTAL_TIMEOUT_MS);
    const errEvt = anthropicEvents(raw).find(e => e.type === 'error');
    expect(errEvt, '客户端必须收到 error 事件，而不是无解释的空白回答').toBeTruthy();
    // 修复前这里是 PROVIDER_PROTOCOL_ERROR —— 客户端无法按"超时可调重试"分支处理，
    // 用量历史里这条失败也归错类。
    expect(errEvt.error.code).toBe('STREAM_IDLE_TIMEOUT');
  }, 30_000);

  it('以上超时不得升级成进程级未捕获异常', async () => {
    expect(uncaught.map(e => e.message)).toEqual([]);
  }, 30_000);
});
