// =============================================================================
// 回归防线：用量落库与用量导出。
// -----------------------------------------------------------------------------
// 1. A11 —— chat.ts 的流式路径只回填了 inputTokens，上游不给 usage 时整条按
//    outputTokens: 0 落库，成本被系统性低估（messages.ts 与 chat.ts 非流式都做了
//    双侧回落，唯独这条漏了）。
// 2. A10 —— /api/usage/history 无论调用方要多少都硬编码 slice(-200)，而"导出 CSV"
//    照此拼文件并提示"已导出 N 条"：拿去对账的人拿到的是静默截断的残缺数据。
//
// 两条都打在真实 HTTP 响应与真实用量库文件上。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const RECORDS = 205; // 跨过原先硬编码的 200 条上限

let app: FastifyInstance;
let mock: http.Server;
let baseUrl = '';

const sseOf = (events: any[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

beforeAll(async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-usagetest-'));

  // 上游刻意不回 usage：这正是 A11 要打的场景。
  mock = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (p === '/alpha/generate') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseOf([
        { type: 'start' },
        { type: 'text-delta', text: 'The quick brown fox jumps over the lazy dog. ' },
        { type: 'text-delta', text: 'And keeps typing a reasonably long answer.' },
        { type: 'finish', finishReason: 'stop' },
      ]));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ upstream: { timeoutMs: 60_000, idleTimeoutMs: 30_000, maxRetries: 0 } }),
  );
  // 全部路径走 env 隔离，且必须在任何 src 模块求值之前设置完毕。
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_API_KEY = 'ck-usage-fixture-credential';
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');

  const { chatRoutes } = await import('../src/routes/chat.js');
  const { dashboardRoutes } = await import('../src/routes/dashboard.js');
  app = Fastify();
  await app.register(chatRoutes);
  await app.register(dashboardRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  for (let i = 0; i < RECORDS; i++) {
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: `q${i}` }] }),
    }).then(r => r.text());
  }
  // 用量写入是异步队列，轮询等待落库完成而不是猜一个 sleep。
  const { getUsageHistory } = await import('../src/utils/usage-store.js');
  const deadline = Date.now() + 15_000;
  while (getUsageHistory().length < RECORDS && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>(r => mock.close(() => r()));
});

describe('A11 · 上游不回 usage 时的输出侧回落', () => {
  it('流式请求落库的 outputTokens 不为 0', async () => {
    const { getUsageHistory } = await import('../src/utils/usage-store.js');
    const records = getUsageHistory();
    expect(records.length).toBe(RECORDS);
    const withOutput = records.filter(r => (r.outputTokens || 0) > 0);
    // 修复前：这里一条都不满足（全部 0），成本被记成只剩输入侧。
    expect(withOutput.length, '每条请求都产出了文本，不该记成 0 输出').toBe(RECORDS);
    expect(records.every(r => (r.inputTokens || 0) > 0)).toBe(true);
  });
});

describe('A10 · 用量历史取数条数可指定', () => {
  it('默认仍只回 200 条（展示用，行为不变）', async () => {
    const res = await fetch(`${baseUrl}/api/usage/history`);
    const json = await res.json();
    expect(json.recent).toHaveLength(200);
    expect(json.storedRecords).toBe(RECORDS);
  });

  it('?limit= 能取回全部记录，导出因此不再被静默截断', async () => {
    const res = await fetch(`${baseUrl}/api/usage/history?limit=50000`);
    const json = await res.json();
    expect(json.recent).toHaveLength(RECORDS);
    // 旧实现里 limit 是写死的 200，任何 ?limit= 都被忽略。
    const small = await (await fetch(`${baseUrl}/api/usage/history?limit=5`)).json();
    expect(small.recent).toHaveLength(5);
  });
});
