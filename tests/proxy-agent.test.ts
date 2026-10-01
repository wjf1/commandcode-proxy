import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import dns from 'node:dns';
import {
  ensureSafeNoProxy,
  resolveProxyUrl,
  initOutboundProxy,
  getOutboundProxyStatus,
  configureDnsResultOrder,
  isProxyReachable,
} from '../src/utils/proxy-agent.js';
import type { GatewayConfig } from '../src/types/gateway.js';

describe('Outbound Proxy Agent (proxy-agent.ts)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.COMMANDCODE_DNS_ORDER;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  describe('configureDnsResultOrder', () => {
    it('默认配置 IPv4 优先', () => {
      expect(() => configureDnsResultOrder()).not.toThrow();
    });

    it('支持环境变量指定 verbatim 模式', () => {
      process.env.COMMANDCODE_DNS_ORDER = 'verbatim';
      expect(() => configureDnsResultOrder()).not.toThrow();
    });
  });

  describe('ensureSafeNoProxy', () => {
    it('在 NO_PROXY 为空时强制补充所有本地回环地址', () => {
      const result = ensureSafeNoProxy();
      expect(result).toContain('localhost');
      expect(result).toContain('127.0.0.1');
      expect(result).toContain('::1');
      expect(process.env.NO_PROXY).toBe(result);
      expect(process.env.no_proxy).toBe(result);
    });

    it('保留用户自定的 NO_PROXY 主机并补充缺失的回环主机', () => {
      process.env.NO_PROXY = 'example.internal,10.0.0.1';
      const result = ensureSafeNoProxy();
      expect(result).toContain('example.internal');
      expect(result).toContain('10.0.0.1');
      expect(result).toContain('localhost');
      expect(result).toContain('127.0.0.1');
      expect(result).toContain('::1');
    });
  });

  describe('resolveProxyUrl', () => {
    it('无任何配置时返回 null', () => {
      expect(resolveProxyUrl()).toBeNull();
    });

    it('config.proxy 优先级高于环境变量', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
      const mockConfig = { proxy: 'http://127.0.0.1:7897' } as GatewayConfig;
      expect(resolveProxyUrl(mockConfig)).toBe('http://127.0.0.1:7897');
    });

    it('无 config.proxy 时遵循标准环境变量优先级', () => {
      process.env.HTTP_PROXY = 'http://127.0.0.1:8081';
      process.env.HTTPS_PROXY = 'http://127.0.0.1:8082';
      expect(resolveProxyUrl()).toBe('http://127.0.0.1:8082');

      delete process.env.HTTPS_PROXY;
      expect(resolveProxyUrl()).toBe('http://127.0.0.1:8081');

      delete process.env.HTTP_PROXY;
      process.env.ALL_PROXY = 'http://127.0.0.1:8083';
      expect(resolveProxyUrl()).toBe('http://127.0.0.1:8083');
    });

    it('支持小写环境变量 https_proxy / http_proxy', () => {
      process.env.https_proxy = 'http://127.0.0.1:9999';
      expect(resolveProxyUrl()).toBe('http://127.0.0.1:9999');
    });

    it('拒绝非法协议（非 http/https）并安全回退为 null', () => {
      process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
      expect(resolveProxyUrl()).toBeNull();
    });

    it('拒绝无法解析的非法 URL 字符串并平滑回退为 null', () => {
      process.env.HTTPS_PROXY = 'not-a-valid-url:::999';
      expect(resolveProxyUrl()).toBeNull();
    });
  });

  describe('isProxyReachable', () => {
    it('对正常监听的本地端口探测成功', async () => {
      const server = net.createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;

      const result = await isProxyReachable(`http://127.0.0.1:${port}`, 500);
      expect(result.reachable).toBe(true);
      expect(typeof result.latencyMs).toBe('number');

      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('对未开放端口快速失败并返回不可达原因', async () => {
      // 随机选取一个本地未开放端口
      const result = await isProxyReachable('http://127.0.0.1:59998', 200);
      expect(result.reachable).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('initOutboundProxy & Auto-fallback', () => {
    it('未配置代理时初始化为 direct 状态（IPv4 优先）', async () => {
      const status = await initOutboundProxy();
      expect(status.enabled).toBe(false);
      expect(status.proxyUrl).toBeUndefined();
      expect(status.noProxy).toContain('localhost');
      expect(getOutboundProxyStatus().enabled).toBe(false);
    });

    it('配置有效且在线代理时正确装配 Dispatcher', async () => {
      const server = net.createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;

      const mockConfig = { proxy: `http://user:secret123@127.0.0.1:${port}` } as GatewayConfig;
      const status = await initOutboundProxy(mockConfig);

      expect(status.enabled).toBe(true);
      expect(status.proxyUrl).toBe(`http://user:******@127.0.0.1:${port}/`);
      expect(status.noProxy).toContain('127.0.0.1');

      const current = getOutboundProxyStatus();
      expect(current.enabled).toBe(true);
      expect(current.proxyUrl).toBe(`http://user:******@127.0.0.1:${port}/`);

      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('配置的代理不可达时平滑自动降级为直连（Auto-fallback），绝不抛出异常阻断', async () => {
      const mockConfig = { proxy: 'http://127.0.0.1:59997' } as GatewayConfig;
      const status = await initOutboundProxy(mockConfig);

      expect(status.enabled).toBe(false);
      expect(status.proxyUrl).toBe('http://127.0.0.1:59997/');
      expect(status.fallbackReason).toBeTruthy();

      const current = getOutboundProxyStatus();
      expect(current.enabled).toBe(false);
    });
  });
});
