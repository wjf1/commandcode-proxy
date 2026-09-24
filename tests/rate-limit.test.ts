// =============================================================================
// 速率限制（src/utils/rate-limit.ts）契约测试
// -----------------------------------------------------------------------------
// 覆盖：默认关闭零拦截（env 未设 = 功能不存在）、RPM/TPM 滑动窗口、窗口过期
// 恢复与内存清理、key 隔离、被拒响应的双出口形态（OpenAI / Anthropic）与
// Retry-After 头。窗口逻辑在调用时读 env，测试直接改 process.env 即可。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  checkRateLimit,
  rateLimitKeyOf,
  guardRateLimit,
  recordRequestOutput,
  recordOutputTokens,
  __testReset,
  __trackedKeys,
} from '../src/utils/rate-limit.js';

const ENV_KEYS = ['RATE_LIMIT_RPM', 'RATE_LIMIT_TPM', 'AUDIT_LOG'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  __testReset();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // 本文件不关心审计副作用：限流拒绝路径会调 auditReject，直接关掉。
  process.env.AUDIT_LOG = 'off';
});

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
});

describe('默认关闭（RATE_LIMIT_RPM / RATE_LIMIT_TPM 均未设置）', () => {
  it('checkRateLimit 恒放行且不记账（零拦截）', () => {
    for (let i = 0; i < 1000; i++) {
      expect(checkRateLimit('k').allowed).toBe(true);
    }
    expect(__trackedKeys()).toBe(0);
  });

  it('guardRateLimit 旁路放行且不建窗口', async () => {
    const app = Fastify();
    app.post('/v1/chat/completions', async (req, reply) => {
      if (guardRateLimit(req, reply)) return reply;
      return { ok: true };
    });
    await app.ready();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'm' } });
      expect(res.statusCode).toBe(200);
    }
    expect(__trackedKeys()).toBe(0);
    await app.close();
  });
});

describe('rateLimitKeyOf — 客户端标识取 key 尾号', () => {
  it('Bearer 取末 4 位；x-api-key 兜底；无凭据回落 global', () => {
    expect(rateLimitKeyOf({ headers: { authorization: 'Bearer sk-abcdef123456' } })).toBe('3456');
    expect(rateLimitKeyOf({ headers: { 'x-api-key': 'sk-abcdef123456' } })).toBe('3456');
    expect(rateLimitKeyOf({ headers: { authorization: 'Basic zzz' } })).toBe('global');
    expect(rateLimitKeyOf({ headers: {} })).toBe('global');
  });
});

describe('RPM 滑动窗口', () => {
  it('超限拒绝：allowed=false + retryAfterSec≥1 + reason', () => {
    process.env.RATE_LIMIT_RPM = '2';
    expect(checkRateLimit('k').allowed).toBe(true);
    expect(checkRateLimit('k').allowed).toBe(true);
    const v = checkRateLimit('k');
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSec ?? 0).toBeGreaterThanOrEqual(1);
    expect(v.reason).toContain('Rate limit');
  });

  it('窗口过期后恢复（60s 滑动）', () => {
    vi.useFakeTimers();
    process.env.RATE_LIMIT_RPM = '1';
    expect(checkRateLimit('k').allowed).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(checkRateLimit('k').allowed).toBe(false);
    vi.advanceTimersByTime(31_000); // 距首个事件 61s，滑出窗口
    expect(checkRateLimit('k').allowed).toBe(true);
  });

  it('key 之间互相隔离', () => {
    process.env.RATE_LIMIT_RPM = '1';
    expect(checkRateLimit('aaa1').allowed).toBe(true);
    expect(checkRateLimit('bbb2').allowed).toBe(true);
    expect(checkRateLimit('aaa1').allowed).toBe(false);
  });
});

describe('TPM（预估 input + 实际 output）', () => {
  it('预估 input 超限拒绝，reason 指明 Token 限制', () => {
    process.env.RATE_LIMIT_TPM = '100';
    expect(checkRateLimit('k', 80).allowed).toBe(true);
    const v = checkRateLimit('k', 80); // 80 + 80 > 100
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('Token');
    expect(v.retryAfterSec ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('recordOutputTokens 把流结束后的实际 output 计入窗口', () => {
    process.env.RATE_LIMIT_TPM = '100';
    expect(checkRateLimit('k', 10).allowed).toBe(true);
    recordOutputTokens('k', 95); // 窗口累计 10 + 95 = 105
    expect(checkRateLimit('k', 10).allowed).toBe(false);
  });

  it('recordRequestOutput 经 guard 记账到该请求的 key', () => {
    process.env.RATE_LIMIT_TPM = '100';
    const req = { headers: {}, url: '/v1/chat/completions' } as any;
    const reply = {} as any;
    expect(guardRateLimit(req, reply)).toBe(false); // est 0，放行
    recordRequestOutput(req, 95);
    expect(checkRateLimit('global', 10).allowed).toBe(false); // 95 + 10 > 100
  });

  it('功能关闭时 recordRequestOutput 为空操作', () => {
    const req = { headers: {}, url: '/v1/chat/completions' } as any;
    expect(() => recordRequestOutput(req, 500)).not.toThrow();
  });
});

describe('内存清理（防 Map 无限增长）', () => {
  it('全表 sweep 清掉窗口外 key', () => {
    vi.useFakeTimers();
    process.env.RATE_LIMIT_RPM = '5';
    for (const k of ['a', 'b', 'c', 'd', 'e']) checkRateLimit(k);
    expect(__trackedKeys()).toBe(5);
    vi.advanceTimersByTime(61_000);
    checkRateLimit('f'); // 触发下一次全表 sweep
    expect(__trackedKeys()).toBe(1);
  });
});

describe('guardRateLimit 被拒响应 — 双出口形态 + Retry-After', () => {
  async function buildApp() {
    const app = Fastify();
    app.post('/v1/chat/completions', async (req, reply) => {
      if (guardRateLimit(req, reply)) return reply;
      return { ok: true };
    });
    app.post('/v1/messages', async (req, reply) => {
      if (guardRateLimit(req, reply)) return reply;
      return { ok: true };
    });
    await app.ready();
    return app;
  }

  const HDR = { authorization: 'Bearer sk-abcdef123456' };

  it('OpenAI 出口：429 + error.type=rate_limit_error + error.code=RATE_LIMIT + Retry-After', async () => {
    process.env.RATE_LIMIT_RPM = '1';
    const app = await buildApp();
    const first = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: HDR, payload: { model: 'm' } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: HDR, payload: { model: 'm' } });
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const body = second.json();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe('RATE_LIMIT');
    await app.close();
  });

  it('Anthropic 出口：429 + type=error 信封 + error.type=rate_limit_error + Retry-After', async () => {
    process.env.RATE_LIMIT_RPM = '1';
    const app = await buildApp();
    const first = await app.inject({ method: 'POST', url: '/v1/messages', headers: HDR, payload: { model: 'm' } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/v1/messages', headers: HDR, payload: { model: 'm' } });
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const body = second.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe('RATE_LIMIT');
    await app.close();
  });
});
