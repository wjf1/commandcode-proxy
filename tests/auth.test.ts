import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { verifyProxyAuth } from '../src/routes/chat.js';

const KEY = 'test-admin-key-123';

/** 用 fastify.inject 构建不监听端口的鉴权契约测试。 */
async function buildApp() {
  const app = Fastify();
  verifyProxyAuth(app);
  app.get('/v1/ping', async () => ({ ok: true }));
  app.post('/v1/messages', async () => ({ ok: true }));
  app.options('/v1/chat/completions', async () => ({ ok: true }));
  app.get('/api/status', async () => ({ ok: true }));
  app.get('/health', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('verifyProxyAuth — PROXY_API_KEY set', () => {
  beforeAll(() => { process.env.PROXY_API_KEY = KEY; });
  afterAll(() => { delete process.env.PROXY_API_KEY; });

  it('rejects /v1/* and /api/* without a key', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/v1/ping' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    await app.close();
  });

  it('accepts Bearer and x-api-key on both surfaces', async () => {
    const app = await buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ping', headers: { authorization: `Bearer ${KEY}` } })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { 'x-api-key': KEY } })).statusCode
    ).toBe(200);
    await app.close();
  });

  it('rejects a wrong key', async () => {
    const app = await buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { 'x-api-key': 'wrong' } })).statusCode
    ).toBe(401);
    await app.close();
  });

  it('returns the Anthropic error envelope for /v1/messages, OpenAI shape elsewhere', async () => {
    const app = await buildApp();
    const messages = JSON.parse((await app.inject({ method: 'POST', url: '/v1/messages' })).body);
    expect(messages.type).toBe('error');
    expect(messages.error.type).toBe('authentication_error');

    const api = JSON.parse((await app.inject({ method: 'GET', url: '/api/status' })).body);
    expect(api.error.type).toBe('authentication_error');
    expect(api.error.code).toBe('PROXY_AUTH_REQUIRED');
    await app.close();
  });

  it('leaves non-protected paths (e.g. /health, dashboard /) open', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('exempts CORS preflight (OPTIONS) from auth — browsers send no auth headers on preflight', async () => {
    const app = await buildApp();
    expect(
      (await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions', headers: { origin: 'https://web.example' } })).statusCode
    ).toBe(200);
    await app.close();
  });
});

describe('verifyProxyAuth — no key configured', () => {
  it('registers no hook: everything passes', async () => {
    delete process.env.PROXY_API_KEY;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/v1/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
    await app.close();
  });
});
