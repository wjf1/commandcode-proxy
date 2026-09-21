// =============================================================================
// P1-1 回归：upstreamTimeoutMs 必须是真实的挂钟上限，而不只是一个展示在仪表盘上的数字。
// -----------------------------------------------------------------------------
// 修复前该配置被 loadConfig 读取、写入默认值、并在 /api/status 回显，但 src/ 里
// **0 个消费点**：唯一生效的是 idleTimeoutMs（且每次收到字节都会被重置，因此一个
// 持续 trickle 的慢上游可以永远挂住连接）。
//
// 两个用例刻意把 idleTimeoutMs 设得比 upstreamTimeoutMs 大得多，这样"超时发生了"
// 只能归因于挂钟上限，而不是空闲看门狗——否则测试无法区分两者。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TOTAL_TIMEOUT_MS = 400;
const IDLE_TIMEOUT_MS = 2_500; // 刻意远大于总时限，确保区分
// 判定"是挂钟上限掐断的、不是空闲看门狗"的硬边界。
const DEADLINE_BOUND_MS = 1_500;

let silentServer: http.Server;   // 收下连接但永不响应
let trickleServer: http.Server;  // 持续 trickle 保活注释行
let stateDir = '';
const timers: NodeJS.Timeout[] = [];

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-deadline-'));

  silentServer = http.createServer(() => { /* 故意不响应 */ });
  trickleServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"start"}\n\n');
    // 每 100ms 一个保活：空闲看门狗永远被重置，只有挂钟上限能掐断它。
    const t = setInterval(() => { try { res.write(': keep\n\n'); } catch { clearInterval(t); } }, 100);
    t.unref?.();
    timers.push(t);
    res.on('close', () => clearInterval(t));
  });

  await new Promise<void>(r => silentServer.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => trickleServer.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  for (const t of timers) clearInterval(t);
  await Promise.all([
    new Promise<void>(r => silentServer.close(() => r())),
    new Promise<void>(r => trickleServer.close(() => r())),
  ]);
});

/** 每个用例指向不同 mock 端口，并重写 config.json —— 这同时验证配置真的被消费。 */
async function loadSendToCC(port: number) {
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({
      upstream: { apiBase: base, timeoutMs: TOTAL_TIMEOUT_MS, idleTimeoutMs: IDLE_TIMEOUT_MS, maxRetries: 0 },
    }),
  );
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');

  // loadConfig() 每次都重读 env + 配置文件，无需手动失效缓存。
  const up = await import('../src/adapters/commandcode/upstream.js');
  return up.sendToCC;
}

function makeBody() {
  return {
    threadId: 't-deadline',
    params: { model: 'claude-sonnet-5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
    config: { workingDir: stateDir },
  } as any;
}

describe('上游挂钟总时限（P1-1）', () => {
  it('上游迟迟不返回响应头时，以 REQUEST_TIMEOUT 失败（空闲看门狗此时不该抢先）', async () => {
    const sendToCC = await loadSendToCC((silentServer.address() as AddressInfo).port);
    const started = Date.now();

    await expect(sendToCC(makeBody(), { apiKey: 'ck-deadline' })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TOTAL_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_BOUND_MS); // 证明不是 idle 看门狗干的
  }, 8_000);

  it('上游持续 trickle 时，连接仍会在挂钟上限处被掐断', async () => {
    const sendToCC = await loadSendToCC((trickleServer.address() as AddressInfo).port);
    const started = Date.now();

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-deadline' });

    const outcome = await new Promise<string>(resolve => {
      const done = (v: string) => resolve(v);
      stream.on('data', () => {});
      stream.once('error', () => done('errored'));
      stream.once('end', () => done('ended'));
      stream.once('close', () => done('closed'));
      // 兜底：若上限完全失效，让断言去判失败，而不是把测试挂到超时。
      const guard = setTimeout(() => done('hung'), IDLE_TIMEOUT_MS * 2);
      guard.unref?.();
    });

    const elapsed = Date.now() - started;
    expect(outcome).not.toBe('hung');
    expect(['errored', 'ended', 'closed']).toContain(outcome);
    expect(elapsed).toBeLessThan(DEADLINE_BOUND_MS);
  }, 8_000);

  // 这条才是「静默截断」的真正防线。chat.ts:222-227 与 messages.ts:316 都先用
  // isAbortError(err) 判定"客户端自己走了"，命中就静默 end()：不发 error 事件、
  // 不 persistOnce('FAILED')。而裸 AbortError 会命中它 —— 于是超时在客户端侧表现为
  // "模型答到一半自己停了"，用量历史里连 FAILED 都不留。
  // 注意 isAbortError 的判据包含「消息里含 abort 子串」，所以错误文案也不能出现该词。
  it('挂钟上限在流中途触发时给出可辨识错误，且不被 isAbortError 误判为客户端离开', async () => {
    const { isAbortError } = await import('../src/adapters/commandcode/upstream.js');
    const sendToCC = await loadSendToCC((trickleServer.address() as AddressInfo).port);

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-deadline' });

    const err = await new Promise<any>(resolve => {
      stream.on('data', () => {});
      stream.once('error', resolve);
      const guard = setTimeout(() => resolve(null), IDLE_TIMEOUT_MS * 2);
      guard.unref?.();
    });

    expect(err, '流中途必须带着错误终止，而不是安静地结束').toBeTruthy();
    expect(err.code).toBe('REQUEST_TIMEOUT');
    expect(isAbortError(err)).toBe(false);
  }, 8_000);
});
