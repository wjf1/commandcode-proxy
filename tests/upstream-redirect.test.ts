// =============================================================================
// Wave 3 安全修复：SSRF 重定向阻断（UPSTREAM_REDIRECT）
// -----------------------------------------------------------------------------
// Node fetch 默认 redirect:'follow'：即使初始 URL 通过了 assertSafeUpstreamUrl，
// 被攻击者控制的上游仍可用 302 把带凭据的请求引向 169.254.169.254 等内网/元数据
// 地址——初始校验完全被绕过。修复后一律 redirect:'manual'：
//   - 默认 conservative：3xx 按上游错误处理，永不跟随；
//   - UPSTREAM_REDIRECT=follow 显式放行：逐跳校验目标，私网/回环/保留地址
//     （含云元数据）即使被 allowlist 放行也永不跟随；跨 host 跳转剥离凭据。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let redirectServer: http.Server;
let hitCount = 0;
let locationHeader = 'http://169.254.169.254/latest/meta-data/';
let stateDir = '';

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-redirect-'));
  redirectServer = http.createServer((_req, res) => {
    hitCount++;
    res.writeHead(302, { Location: locationHeader });
    res.end();
  });
  await new Promise<void>(r => redirectServer.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise<void>(r => redirectServer.close(() => r()));
});

afterEach(() => {
  delete process.env.UPSTREAM_REDIRECT;
  delete process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
  vi.restoreAllMocks();
});

async function loadSendToCC() {
  const port = (redirectServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ upstream: { apiBase: base, timeoutMs: 5000, idleTimeoutMs: 2500, maxRetries: 0 } }),
  );
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  const up = await import('../src/adapters/commandcode/upstream.js');
  return up.sendToCC;
}

function makeBody() {
  return {
    threadId: 't-redirect',
    params: { model: 'claude-sonnet-5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
    config: { workingDir: stateDir },
  } as any;
}

describe('SSRF 重定向阻断（端到端，真实 mock 上游）', () => {
  it('默认 conservative：302 不被跟随，按上游错误终止且不再发出第二次请求', async () => {
    const sendToCC = await loadSendToCC();
    hitCount = 0;
    locationHeader = 'http://169.254.169.254/latest/meta-data/';

    await expect(sendToCC(makeBody(), { apiKey: 'ck-redirect' })).rejects.toMatchObject({
      code: 'PROVIDER_PROTOCOL_ERROR',
    });
    // 只打到 mock 上游一次：302 之后没有任何第二次 fetch（包括对元数据地址的）。
    expect(hitCount).toBe(1);
  }, 8_000);

  it('UPSTREAM_REDIRECT=follow：重定向到私网/元数据地址仍被强制阻断（allowlist 也不放行）', async () => {
    process.env.UPSTREAM_REDIRECT = 'follow';
    const sendToCC = await loadSendToCC();
    hitCount = 0;
    locationHeader = 'http://169.254.169.254/latest/meta-data/';

    await expect(sendToCC(makeBody(), { apiKey: 'ck-redirect' })).rejects.toThrow(/private|reserved/i);
    expect(hitCount).toBe(1);
  }, 8_000);
});

describe('SSRF 重定向跟随（fetch mock，验证合法放行路径）', () => {
  it('follow：同 host 跳转保留 POST 与请求体，流成功建立', async () => {
    process.env.UPSTREAM_REDIRECT = 'follow';
    const sendToCC = await loadSendToCC();
    // 跳转目标的 DNS 校验不依赖真实网络：mock 解析为公网 IP。
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);

    const sse = 'data: {"type":"done"}\n\n';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://api.commandcode.ai/alpha/generate-v2' } }))
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-redirect' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondUrl, secondInit] = fetchMock.mock.calls[1];
    expect(String(secondUrl)).toBe('https://api.commandcode.ai/alpha/generate-v2');
    expect((secondInit as any).method).toBe('POST');
    expect((secondInit as any).body).toBeTruthy();
    expect((secondInit as any).redirect).toBe('manual');
    stream.destroy();
  }, 8_000);

  it('follow：跨 host 跳转剥离凭据头，防止 Authorization 被引到第三方', async () => {
    process.env.UPSTREAM_REDIRECT = 'follow';
    const sendToCC = await loadSendToCC();
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);

    const sse = 'data: {"type":"done"}\n\n';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://mirror.commandcode.ai/alpha/generate' } }))
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-secret-last-four-aaaa' });
    const secondInit = fetchMock.mock.calls[1][1] as Record<string, string>;
    const joined = JSON.stringify(secondInit).toLowerCase();
    expect(joined).not.toContain('ck-secret-last-four-aaaa');
    expect(joined).not.toContain('bearer');
    stream.destroy();
  }, 8_000);

  it('follow：重定向链超过 5 跳后放弃并报错', async () => {
    process.env.UPSTREAM_REDIRECT = 'follow';
    const sendToCC = await loadSendToCC();
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      const n = Number(new URL(String(_url)).searchParams.get('hop') || 0);
      void init;
      return new Response(null, { status: 302, headers: { location: `https://api.commandcode.ai/alpha/generate?hop=${n + 1}` } });
    });

    await expect(sendToCC(makeBody(), { apiKey: 'ck-redirect' })).rejects.toThrow(/redirect/i);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6); // 初始 1 次 + 最多 5 跳
  }, 8_000);
});

describe('assertSafeUpstreamRedirectTarget（纯函数）', () => {
  it('resolve 相对 Location 并拒绝私网目标——即使主机在 allowlist 中', async () => {
    // allowlist 放行了基线校验（https 形态），重定向层仍强制拦截
    process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1,169.254.169.254,10.0.0.9';
    const { assertSafeUpstreamRedirectTarget } = await import('../src/utils/config.js');
    expect(() => assertSafeUpstreamRedirectTarget('/latest/meta-data/', 'https://169.254.169.254')).toThrow(/never be followed/);
    expect(() => assertSafeUpstreamRedirectTarget('https://10.0.0.9/v1')).toThrow(/never be followed/);
    expect(assertSafeUpstreamRedirectTarget('/alpha/generate', 'https://api.commandcode.ai').hostname).toBe('api.commandcode.ai');
  });
});
