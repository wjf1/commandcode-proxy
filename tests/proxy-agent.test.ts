import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ensureSafeNoProxy,
  resolveProxyUrl,
  initOutboundProxy,
  getOutboundProxyStatus,
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
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
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

  describe('initOutboundProxy', () => {
    it('未配置代理时初始化为 direct 状态', () => {
      const status = initOutboundProxy();
      expect(status.enabled).toBe(false);
      expect(status.proxyUrl).toBeUndefined();
      expect(status.noProxy).toContain('localhost');
      expect(getOutboundProxyStatus().enabled).toBe(false);
    });

    it('配置有效代理时正确装配 Dispatcher 并掩码密码', () => {
      const mockConfig = { proxy: 'http://user:secret123@127.0.0.1:7897' } as GatewayConfig;
      const status = initOutboundProxy(mockConfig);
      expect(status.enabled).toBe(true);
      expect(status.proxyUrl).toBe('http://user:******@127.0.0.1:7897/');
      expect(status.noProxy).toContain('127.0.0.1');

      const current = getOutboundProxyStatus();
      expect(current.enabled).toBe(true);
      expect(current.proxyUrl).toBe('http://user:******@127.0.0.1:7897/');
    });
  });
});
