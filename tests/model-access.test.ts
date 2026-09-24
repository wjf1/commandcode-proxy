// =============================================================================
// 模型访问控制（src/utils/model-access.ts）契约测试
// -----------------------------------------------------------------------------
// 覆盖：默认全放行（env 未设 = 零拦截）、allowlist 优先、blocklist、大小写
// 不敏感、以及被拒响应的双出口形态（OpenAI / Anthropic，403 + permission_error）。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { checkModelAccess, guardModelAccess } from '../src/utils/model-access.js';

const ENV_KEYS = ['MODEL_ALLOWLIST', 'MODEL_BLOCKLIST', 'AUDIT_LOG'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // 本文件不关心审计副作用：模型拒绝路径会调 auditReject，直接关掉。
  process.env.AUDIT_LOG = 'off';
});

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('默认全放行（MODEL_ALLOWLIST / MODEL_BLOCKLIST 均未设置）', () => {
  it('任意模型 allowed', () => {
    for (const m of ['glm-4.7', 'claude-sonnet-5', '', 'anything-else']) {
      expect(checkModelAccess(m).allowed).toBe(true);
    }
  });

  it('guardModelAccess 零拦截', async () => {
    const app = Fastify();
    app.post('/v1/chat/completions', async (req, reply) => {
      if (guardModelAccess(req, reply)) return reply;
      return { ok: true };
    });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'any-model' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('MODEL_ALLOWLIST（设置了则不在名单内即拒）', () => {
  beforeEach(() => { process.env.MODEL_ALLOWLIST = 'glm-4.7, claude-sonnet-5'; });

  it('名单内放行', () => {
    expect(checkModelAccess('glm-4.7').allowed).toBe(true);
    expect(checkModelAccess('claude-sonnet-5').allowed).toBe(true);
  });

  it('名单外拒绝，reason 指向 MODEL_ALLOWLIST', () => {
    const v = checkModelAccess('gpt-9');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('MODEL_ALLOWLIST');
  });

  it('大小写不敏感 + 名单项两侧空格容忍', () => {
    expect(checkModelAccess('GLM-4.7').allowed).toBe(true);
    expect(checkModelAccess('  Claude-Sonnet-5  ').allowed).toBe(true);
  });

  it('空模型名按不在名单内拒绝', () => {
    expect(checkModelAccess('').allowed).toBe(false);
  });
});

describe('MODEL_BLOCKLIST（未设 allowlist 时生效）', () => {
  beforeEach(() => { process.env.MODEL_BLOCKLIST = 'bad-model,legacy-model'; });

  it('名单内拒绝，reason 指向 MODEL_BLOCKLIST', () => {
    const v = checkModelAccess('bad-model');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('MODEL_BLOCKLIST');
  });

  it('名单外放行 + 大小写不敏感', () => {
    expect(checkModelAccess('good-model').allowed).toBe(true);
    expect(checkModelAccess('BAD-MODEL').allowed).toBe(false);
  });
});

describe('allowlist 优先：设了 allowlist 就不再看 blocklist', () => {
  beforeEach(() => {
    process.env.MODEL_ALLOWLIST = 'a-model';
    process.env.MODEL_BLOCKLIST = 'a-model';
  });

  it('allowlist 命中的模型即使也在 blocklist 也放行', () => {
    expect(checkModelAccess('a-model').allowed).toBe(true);
  });

  it('不在 allowlist 的模型一律拒绝（即便不在 blocklist）', () => {
    expect(checkModelAccess('b-model').allowed).toBe(false);
  });
});

describe('guardModelAccess 被拒响应 — 双出口形态（403）', () => {
  async function buildApp() {
    const app = Fastify();
    app.post('/v1/chat/completions', async (req, reply) => {
      if (guardModelAccess(req, reply)) return reply;
      return { ok: true };
    });
    app.post('/v1/messages', async (req, reply) => {
      if (guardModelAccess(req, reply)) return reply;
      return { ok: true };
    });
    await app.ready();
    return app;
  }

  it('OpenAI 出口：403 + error.type=permission_error + error.code=MODEL_NOT_IN_PLAN', async () => {
    process.env.MODEL_BLOCKLIST = 'forbidden-model';
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'forbidden-model' } });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.type).toBe('permission_error');
    expect(body.error.code).toBe('MODEL_NOT_IN_PLAN');
    await app.close();
  });

  it('Anthropic 出口：403 + type=error 信封 + error.type=permission_error', async () => {
    process.env.MODEL_BLOCKLIST = 'forbidden-model';
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: { model: 'forbidden-model' } });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('permission_error');
    expect(body.error.code).toBe('MODEL_NOT_IN_PLAN');
    await app.close();
  });

  it('allowlist 拒绝路径同样 403', async () => {
    process.env.MODEL_ALLOWLIST = 'only-this';
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'other' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
