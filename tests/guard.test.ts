import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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

// Wave 4：Origin scheme 校验收紧（ORIGIN_SCHEME_CHECK）。管理面此前只比对 host，
// 攻击者可用任意 scheme 的同 host Origin 绕过（如 https 页面驱动 http 管理接口的
// 混合内容场景）。默认收紧；ORIGIN_SCHEME_CHECK=off 显式回退（反代 TLS 终止等
// 页面协议与后端协议不一致的部署）。两参旧签名保持旧语义，调用方零破坏。
describe('isSameOriginIfPresent — scheme 收紧（Wave 4）', () => {
  afterEach(() => { delete process.env.ORIGIN_SCHEME_CHECK; });

  it('默认 on：scheme 一致放行，不一致拒绝', () => {
    expect(isSameOriginIfPresent('http://127.0.0.1:9090', '127.0.0.1:9090', 'http')).toBe(true);
    expect(isSameOriginIfPresent('https://gw.example', 'gw.example', 'https')).toBe(true);
    expect(isSameOriginIfPresent('https://127.0.0.1:9090', '127.0.0.1:9090', 'http')).toBe(false);
    expect(isSameOriginIfPresent('http://gw.example', 'gw.example', 'https')).toBe(false);
  });

  it('ORIGIN_SCHEME_CHECK=off 显式回退：scheme 不一致仍放行', () => {
    process.env.ORIGIN_SCHEME_CHECK = 'off';
    expect(isSameOriginIfPresent('https://gw.example', 'gw.example', 'http')).toBe(true);
  });

  it('不传 requestProtocol 保持旧语义（两参调用方零破坏）', () => {
    expect(isSameOriginIfPresent('https://gw.lan:8080', 'gw.lan:8080')).toBe(true);
    expect(isSameOriginIfPresent('http://evil.example', 'gw.lan:8080')).toBe(false);
  });

  it('端到端：dashboard 管理写操作对混合 scheme Origin 返回 403', async () => {
    const app = Fastify();
    await app.register(dashboardRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/gateway/toggle',
      headers: { origin: 'https://127.0.0.1:9090', host: '127.0.0.1:9090', 'content-type': 'application/json' },
      body: JSON.stringify({ running: true }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
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
