import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { isSameOriginIfPresent } from '../src/routes/sse-common.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';

describe('isSameOriginIfPresent', () => {
  it('allows same-host origin', () => {
    expect(isSameOriginIfPresent('http://127.0.0.1:9090', '127.0.0.1:9090')).toBe(true);
    expect(isSameOriginIfPresent('https://gw.lan:8080', 'gw.lan:8080')).toBe(true);
  });

  it('rejects foreign and malformed origins', () => {
    expect(isSameOriginIfPresent('http://evil.example', '127.0.0.1:9090')).toBe(false);
    expect(isSameOriginIfPresent('http://127.0.0.1:9090@evil.example', '127.0.0.1:9090')).toBe(false);
    expect(isSameOriginIfPresent('not a url', '127.0.0.1:9090')).toBe(false);
  });

  it('allows missing Origin (non-browser clients) but not missing host with one present', () => {
    expect(isSameOriginIfPresent(undefined, '127.0.0.1:9090')).toBe(true);
    expect(isSameOriginIfPresent('http://127.0.0.1:9090', undefined)).toBe(false);
  });
});

// 端到端：管理面写操作被异源 Origin 拒绝、同源放行（fastify.inject，不监听端口）。
describe('dashboard admin routes — cross-origin guard', () => {
  let app: Fastify.FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(dashboardRoutes);
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it('rejects foreign-origin POST with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/gateway/toggle',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ running: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows same-origin POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/gateway/toggle',
      headers: { origin: 'http://127.0.0.1', host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ running: true }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows POST without Origin (curl/SDK style)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/logs/clear',
    });
    expect(res.statusCode).toBe(200);
  });
});
