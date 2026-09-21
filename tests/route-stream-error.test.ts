// =============================================================================
// 回归防线：上游流被挂钟上限掐断时，错误必须是**路由级**可见的，且绝不能变成
// 未捕获异常。
// -----------------------------------------------------------------------------
// 起因：修 P1-1 时给 sendToCC 加了「用可辨识错误 destroy 流」，适配层单测全绿，
// 但端到端跑起来代理日志出现
//   [CRITICAL] Uncaught Exception: Upstream exceeded 1.5s total deadline
// 原因是 createInterface({ input }) 会把 input 流的 error 转成 **readline 自己的**
// 'error' 事件；两条路由原先只挂 upstreamStream.on('error')，那个 'error' 无人
// 监听 → 直接抛成进程级未捕获异常。一次超时被升级成进程事故。
//
// 所以断言必须落在路由层：走真实的 /v1/chat/completions，让路由自己建 readline。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TOTAL_TIMEOUT_MS = 700;
const IDLE_TIMEOUT_MS = 8_000; // 确保只有挂钟上限能触发

let app: FastifyInstance;
let mock: http.Server;
let stateDir = '';
let baseUrl = '';
const uncaught: Error[] = [];
const onUncaught = (e: Error) => uncaught.push(e);

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-rte-'));

  mock = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (p === '/alpha/generate') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"start","id":"x"}\n\n');
      // 永不停嘴：空闲看门狗不会触发，只有挂钟上限能掐断。
      const t = setInterval(() => { try { res.write(': keep\n\n'); } catch { clearInterval(t); } }, 80);
      t.unref?.();
      res.on('close', () => clearInterval(t));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
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
  process.env.COMMANDCODE_API_KEY = 'ck-route-level-fake-credential';
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');

  process.on('uncaughtException', onUncaught);

  const { chatRoutes } = await import('../src/routes/chat.js');
  app = Fastify();
  await app.register(chatRoutes);
  // 必须真监听：路由会写 reply.raw 并对 socket 调 setTimeout(0)，app.inject 没有
  // 真实 socket，会在 req.raw.setTimeout 处 500（测的就不是想测的那条路径了）。
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  process.removeListener('uncaughtException', onUncaught);
  await app?.close();
  await new Promise<void>(r => mock.close(() => r()));
});

describe('/v1/chat/completions 流中途超时的可见性（路由级）', () => {
  it('SSE 里带上游超时信息，且按时终止而不是静默截断', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });

    let body = '';
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // 兜底：若挂钟上限完全失效，用 idle 的 2 倍判失败，而不是把测试挂死。
    const guard = setTimeout(() => reader.cancel().catch(() => {}), IDLE_TIMEOUT_MS * 2);
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; body += dec.decode(value, { stream: true }); }
    } catch { /* 主动 cancel 会抛，忽略 */ }
    clearTimeout(guard);
    const elapsed = Date.now() - started;

    expect(elapsed, '必须由挂钟上限终止；远超上限说明没生效').toBeLessThan(IDLE_TIMEOUT_MS);
    // 既有契约是把上游错误并入正文而非 JSON error 字段（v4.17.0 明确保留该契约），
    // 关键是客户端能看见，而不是拿到一段无解释的空白回答。
    expect(body).toMatch(/Upstream Error|deadline|timed out/i);
  }, 25_000);

  it('超时不得变成进程级未捕获异常', async () => {
    // 上一条用例已经跑过一次真实流；这里断言没有 'error' 事件被丢给空监听器。
    expect(uncaught.map(e => e.message)).toEqual([]);
  }, 20_000);
});
