// =============================================================================
// Wave 3 安全修复：DNS Rebinding 连接层校验（DNS_REBINDING_GUARD）
// -----------------------------------------------------------------------------
// assertSafeUpstreamUrl 只能校验 URL 字面里的 host：攻击者控制的域名可以先解析到
// 公网 IP 通过校验，实际请求时再解析到内网地址（DNS rebinding）。本防护在每个上游
// 请求出口做"请求前解析 + 校验"。默认 on；DNS_REBINDING_GUARD=off 显式回退；
// IP 字面量 / localhost / allowlist 命中主机跳过解析校验（无 rebinding 可能或已显式信任）。
// =============================================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import { assertSafeUpstreamDns } from '../src/utils/config.js';

afterEach(() => {
  delete process.env.DNS_REBINDING_GUARD;
  delete process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
  vi.restoreAllMocks();
});

describe('assertSafeUpstreamDns', () => {
  it('rejects a public-looking domain that resolves to a private address (rebinding)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '10.0.0.5', family: 4 },
    ] as any);
    await expect(assertSafeUpstreamDns('https://api.commandcode.ai/alpha/generate'))
      .rejects.toThrow(/10\.0\.0\.5.*rebinding guard/i);
  });

  it('fails closed when any of multiple resolved addresses is private', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ] as any);
    await expect(assertSafeUpstreamDns('https://api.commandcode.ai/alpha/generate'))
      .rejects.toThrow(/169\.254\.169\.254/);
  });

  it('accepts a domain resolving only to public addresses', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ] as any);
    await expect(assertSafeUpstreamDns('https://api.commandcode.ai/alpha/generate')).resolves.toBeUndefined();
  });

  it('skips resolution entirely when DNS_REBINDING_GUARD=off (explicit rollback)', async () => {
    process.env.DNS_REBINDING_GUARD = 'off';
    const spy = vi.spyOn(dns.promises, 'lookup');
    await expect(assertSafeUpstreamDns('https://evil.example.com/')).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips resolution for IP-literal hosts (no rebinding surface)', async () => {
    const spy = vi.spyOn(dns.promises, 'lookup');
    await expect(assertSafeUpstreamDns('https://93.184.216.34/v1')).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips resolution for loopback hosts (local mock / self-hosted gateway form)', async () => {
    const spy = vi.spyOn(dns.promises, 'lookup');
    await expect(assertSafeUpstreamDns('http://localhost:9911/alpha/generate')).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips resolution for explicitly allowlisted hosts (operator trust)', async () => {
    process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = 'cc-gw.internal.example.com';
    const spy = vi.spyOn(dns.promises, 'lookup');
    await expect(assertSafeUpstreamDns('https://cc-gw.internal.example.com/v1')).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects hostnames that fail to resolve (fail-closed, no silent bypass)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND') as any);
    await expect(assertSafeUpstreamDns('https://nonexistent.commandcode.ai/')).rejects.toThrow(/ENOTFOUND/);
  });
});
