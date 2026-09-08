import { describe, it, expect, afterEach } from 'vitest';
import { assertSafeUpstreamUrl, isAllowedUpstreamHost } from '../src/utils/config.js';

afterEach(() => {
  delete process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
});

describe('assertSafeUpstreamUrl', () => {
  it('accepts the default commandcode.ai API base (https)', () => {
    expect(assertSafeUpstreamUrl('https://api.commandcode.ai/alpha/whoami').hostname).toBe('api.commandcode.ai');
  });

  it('accepts the apex commandcode.ai pricing page (https)', () => {
    expect(assertSafeUpstreamUrl('https://commandcode.ai/docs/plans/go').hostname).toBe('commandcode.ai');
  });

  it('accepts subdomains of commandcode.ai (https)', () => {
    expect(assertSafeUpstreamUrl('https://foo.bar.commandcode.ai/v1').hostname).toBe('foo.bar.commandcode.ai');
  });

  it('accepts loopback http (local mock / dev upstream)', () => {
    expect(assertSafeUpstreamUrl('http://127.0.0.1:9911/alpha/generate').hostname).toBe('127.0.0.1');
    expect(assertSafeUpstreamUrl('http://localhost:9090/').hostname).toBe('localhost');
  });

  it('rejects non-loopback http (downgrade)', () => {
    expect(() => assertSafeUpstreamUrl('http://api.commandcode.ai/alpha/whoami')).toThrow(/https/);
  });

  it('rejects arbitrary hosts not in the allowlist', () => {
    expect(() => assertSafeUpstreamUrl('https://evil.example.com/path')).toThrow(/not allowed/);
    expect(() => assertSafeUpstreamUrl('https://169.254.169.254/latest/meta-data')).toThrow(/not allowed/);
  });

  it('rejects non-http(s) schemes (protocol smuggling)', () => {
    expect(() => assertSafeUpstreamUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => assertSafeUpstreamUrl('gopher://commandcode.ai')).toThrow(/http/);
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafeUpstreamUrl('https://user:pass@api.commandcode.ai/alpha/whoami')).toThrow(/credentials/);
  });

  it('rejects URLs without an allowed host', () => {
    // WHATWG 会把 `https:///path` 解析为 hostname="path"，因不在白名单被拒。
    expect(() => assertSafeUpstreamUrl('https:///path')).toThrow(/not allowed/);
  });

  it('honors the extra-allowlist env var for custom gateways', () => {
    process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = 'cc-gateway.example.com, .internal.example.com';
    expect(assertSafeUpstreamUrl('https://cc-gateway.example.com/v1').hostname).toBe('cc-gateway.example.com');
    expect(assertSafeUpstreamUrl('https://sub.internal.example.com/v1').hostname).toBe('sub.internal.example.com');
    expect(() => assertSafeUpstreamUrl('https://unknown.example.com/v1')).toThrow(/not allowed/);
  });
});

describe('isAllowedUpstreamHost', () => {
  it('allows commandcode.ai, subdomains and loopback', () => {
    expect(isAllowedUpstreamHost('commandcode.ai')).toBe(true);
    expect(isAllowedUpstreamHost('api.commandcode.ai')).toBe(true);
    expect(isAllowedUpstreamHost('a.b.commandcode.ai')).toBe(true);
    expect(isAllowedUpstreamHost('127.0.0.1')).toBe(true);
    expect(isAllowedUpstreamHost('localhost')).toBe(true);
  });

  it('denies unrelated hosts by default', () => {
    expect(isAllowedUpstreamHost('example.com')).toBe(false);
    expect(isAllowedUpstreamHost('notcommandcode.ai')).toBe(false);
  });
});
