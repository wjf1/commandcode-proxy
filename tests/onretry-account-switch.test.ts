// =============================================================================
// P0-4 回归：额度/瞬时错误重试时，onRetry 换出来的新账号必须真的作用到下一次请求。
// -----------------------------------------------------------------------------
// 断言的是**可观测行为**（上游收到的 Authorization 头），不是"回调被调用过"。
// 这一点是刻意的：修复前存在三层缺陷，只让 onRetry 被调用仍然不足以让切号生效——
//   1) upstream.ts 从不 await opts.onRetry
//   2) headers 在重试循环**之外**构建一次，之后不再重算
//   3) 路由里的回调给局部变量 apiKey 赋值，而 opts.apiKey 早已把旧值快照进参数对象
// 因此"Authorization 在第二次尝试时变成新 key"这条断言，能同时锁死这三层。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const KEY_A = 'ck-account-A-0000000000';
const KEY_B = 'ck-account-B-0000000000';

let server: http.Server;
let base = '';
let seenAuth: Array<string | undefined> = [];
let stateDir = '';

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-onretry-'));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seenAuth.push(req.headers.authorization);
      const attempt = seenAuth.length;

      // 第一次：可重试的瞬时失败（429 在 RETRYABLE_STATUS 内，且不含终止性计费标记）。
      if (attempt === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Gateway request failed: no available provider' }));
        return;
      }
      // 第二次：正常 SSE 流产出内容。
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"start"}\n\ndata: {"type":"delta","text":"ok-from-B"}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // sendToCC 内部调用 loadConfig()，因此这些变量必须在**首次调用之前**就位。
  // vitest 默认按文件隔离模块注册表，本文件不会与其他套件串扰。
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

function makeBody() {
  return {
    threadId: 't-onretry',
    params: { model: 'claude-sonnet-5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
    config: { workingDir: stateDir },
  } as any;
}

describe('sendToCC onRetry 账号切换（P0-4）', () => {
  it('onRetry 返回新 apiKey 时，下一次尝试用它请求上游', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    seenAuth = [];
    let switchedTo: string | undefined;

    const stream = await sendToCC(makeBody(), {
      apiKey: KEY_A,
      // 契约：回调返回**要改用的 key**（返回 undefined = 沿用当前 key）。
      onRetry: async () => {
        switchedTo = KEY_B;
        return KEY_B;
      },
    });

    const text = await new Promise<string>(resolve => {
      let acc = '';
      stream.on('data', (c: Buffer) => (acc += c.toString()));
      stream.on('end', () => resolve(acc));
    });

    expect(switchedTo).toBe(KEY_B);
    // 这一条锁死"headers 在循环内重建"：旧实现两次都会带 KEY_A。
    expect(seenAuth).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    expect(text).toContain('ok-from-B');
  });

  it('onRetry 返回 undefined 时，重试沿用当前 key（不是清空凭据）', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    seenAuth = [];

    const stream = await sendToCC(makeBody(), {
      apiKey: KEY_A,
      onRetry: async () => undefined,
    });
    await new Promise<void>(resolve => { stream.resume(); stream.on('end', () => resolve()); });

    expect(seenAuth).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_A}`]);
  });

  it('不提供 onRetry 时仍按原 key 重试（向后兼容）', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    seenAuth = [];

    const stream = await sendToCC(makeBody(), { apiKey: KEY_A });
    await new Promise<void>(resolve => { stream.resume(); stream.on('end', () => resolve()); });

    expect(seenAuth.length).toBeGreaterThanOrEqual(2);
    expect(seenAuth.every(a => a === `Bearer ${KEY_A}`)).toBe(true);
  });
});
