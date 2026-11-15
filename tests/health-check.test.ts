// =============================================================================
// 通道健康检查：探活、状态聚合与仅告警策略
// -----------------------------------------------------------------------------
// 锁定的行为：
//   1. 探活 URL 必须先过 assertSafeUpstreamUrl —— 不安全时记为不健康且**不发请求**；
//   2. 网络层失败（超时/DNS/拒连）与 5xx 算不健康；4xx 也算存活（HTTP 栈在响应）；
//   3. 连续失败 ≥2 次仅 logger.warn（含连续次数与错误摘要），恢复时 logger.info 一次
//      —— 绝不影响请求路径；
//   4. HEALTH_CHECK_INTERVAL_MS=0 时不启动定时器。
// fetch 全部 spyOn mock，不发真实网络请求。
//
// getActiveApiKey 部分 mock（其余 config 导出保持真实实现）：probeProtocol 的
// "有无凭据"分支必须与测试机上真实存在的 COMMANDCODE_API_KEY / auth.json 解耦。
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import { getActiveApiKey } from '../src/utils/config.js';
import {
  probeOnce,
  probeProtocol,
  getChannelHealth,
  startHealthChecks,
  startProtocolChecks,
  resetHealthState,
} from '../src/utils/health-check.js';

vi.mock('../src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/config.js')>()),
  getActiveApiKey: vi.fn(),
}));

const mockedGetActiveApiKey = vi.mocked(getActiveApiKey);

// 指向公网默认上游（与代码默认一致），assertSafeUpstreamUrl 才会放行；
// fetch 已 mock，不会真的出网。
const SAFE_BASE = 'https://api.commandcode.ai';
const TEST_KEY = 'cc-test-key-1234';

let fetchMock: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

const okResponse = (status: number) => ({ ok: status >= 200 && status < 300, status } as Response);
const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);

beforeEach(() => {
  vi.restoreAllMocks();
  resetHealthState();
  process.env.COMMANDCODE_API_BASE = SAFE_BASE;
  delete process.env.HEALTH_CHECK_INTERVAL_MS;
  delete process.env.HEALTH_CHECK_TIMEOUT_MS;
  delete process.env.PROTOCOL_CHECK_INTERVAL_MS;
  delete process.env.PROTOCOL_CHECK_TIMEOUT_MS;
  delete process.env.COMMANDCODE_API_KEY;
  mockedGetActiveApiKey.mockReturnValue(null); // 默认无凭据：协议探针一律 skipped
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(200));
  // 全局抑制日志：既便于断言，也避免告警落到真实 logs/proxy.log
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.COMMANDCODE_API_BASE;
  delete process.env.HEALTH_CHECK_INTERVAL_MS;
  delete process.env.HEALTH_CHECK_TIMEOUT_MS;
  delete process.env.PROTOCOL_CHECK_INTERVAL_MS;
  delete process.env.PROTOCOL_CHECK_TIMEOUT_MS;
  delete process.env.COMMANDCODE_API_KEY;
});

describe('probeOnce — 探活与结果记录', () => {
  it('上游 200 时记为健康，并按探活 URL 发起 GET', async () => {
    const r = await probeOnce();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${SAFE_BASE}/`);
  });

  it('5xx 记为不健康并累计连续失败', async () => {
    fetchMock.mockResolvedValue(okResponse(503));
    await probeOnce();
    await probeOnce();
    const h = getChannelHealth();
    expect(h.lastResult?.ok).toBe(false);
    expect(h.lastResult?.status).toBe(503);
    expect(h.consecutiveFailures).toBe(2);
    expect(h.uptimePercent).toBe(0);
  });

  it('4xx 也视为通道存活（无凭据探活，重要的是服务在响应）', async () => {
    fetchMock.mockResolvedValue(okResponse(404));
    const r = await probeOnce();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(404);
    expect(getChannelHealth().consecutiveFailures).toBe(0);
  });

  it('网络层失败（超时/拒连）记为不健康且不抛错', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );
    const r = await probeOnce();
    expect(r.ok).toBe(false);
    expect(r.status).toBeUndefined();
    expect(r.error).toContain('aborted');
    expect(getChannelHealth().consecutiveFailures).toBe(1);
  });

  it('URL 不安全时记为不健康且不再发请求', async () => {
    process.env.COMMANDCODE_API_BASE = 'http://192.168.1.5'; // 私网地址且未加白
    const r = await probeOnce();
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getChannelHealth().consecutiveFailures).toBe(1);
  });

  it('uptimePercent 反映最近样本的成功比例（2 成功 1 失败 ≈ 66.7）', async () => {
    await probeOnce(); // ok
    await probeOnce(); // ok
    fetchMock.mockRejectedValue(new Error('boom'));
    await probeOnce(); // fail
    expect(getChannelHealth().uptimePercent).toBeCloseTo(66.7, 1);
  });
});

describe('告警 — 仅日志旁路，绝不拦截', () => {
  it('连续失败达到 2 次时 logger.warn（含连续次数与错误摘要）', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 1.2.3.4:443'));
    await probeOnce();
    expect(warnSpy).not.toHaveBeenCalled(); // 单次失败不打扰
    await probeOnce();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('2');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('ECONNREFUSED');
  });

  it('从不健康恢复后 logger.info 恰好一次且连续失败清零', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await probeOnce();
    await probeOnce();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(okResponse(200));
    await probeOnce();
    expect(getChannelHealth().consecutiveFailures).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    // 恢复后再次探活不再重复 info
    await probeOnce();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('健康时全程不产生 warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await probeOnce();
    await probeOnce();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('startHealthChecks — 定时装配', () => {
  it('HEALTH_CHECK_INTERVAL_MS=0 时不启动（返回 null，零 fetch）', () => {
    process.env.HEALTH_CHECK_INTERVAL_MS = '0';
    expect(startHealthChecks()).toBeNull();
  });

  it('按 opts.intervalMs 启动并周期探活，timer 可清除', async () => {
    vi.useFakeTimers();
    const timer = startHealthChecks({ intervalMs: 1000 });
    expect(timer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clearInterval(timer!);
  });

  it('env 缺省时按 5 分钟周期，HEALTH_CHECK_INTERVAL_MS 可覆盖', async () => {
    vi.useFakeTimers();
    process.env.HEALTH_CHECK_INTERVAL_MS = '60000';
    const timer = startHealthChecks();
    expect(timer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearInterval(timer!);
  });
});

// ─── probeProtocol：协议形态探针（/alpha/whoami，带凭据，纯旁路）─────────────
// 判定依据（与 src/utils/config.ts 对 whoami 的实际消费一致）：
//   user 对象存在（顶层或 data 包装）且 id/name/userName/email 任一非空 → ok。
describe('probeProtocol — 协议形态探针', () => {
  it('无活动凭据时 skipped 且零 fetch（getActiveApiKey 返回 null）', async () => {
    const r = await probeProtocol();
    expect(r).toEqual({ skipped: true, reason: 'no-key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200 且 user 结构符合预期 → ok，keySuffix 为尾 4 位，请求带既有惯例头', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(jsonResponse(200, {
      user: { id: 'u_1', name: 'Tester', email: 't@example.com' },
      org: { id: 'org_1' },
    }));
    const r = await probeProtocol();
    expect(r).toMatchObject({
      ok: true, kind: 'ok', keySuffix: '1234', status: 200,
    });
    expect(r.skipped !== true && r.checkedAt).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown[];
    expect(String(url)).toBe(`${SAFE_BASE}/alpha/whoami`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers['User-Agent']).toBe('cli');
    expect(headers['x-cli-environment']).toBe('cli');
    expect(typeof headers['x-command-code-version']).toBe('string');
  });

  it('200 但 data 包装的 user 也算结构符合（与 fetchLiveUsageStats 的双层消费一致）', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { user: { id: 'u_1' } } }));
    const r = await probeProtocol();
    expect(r).toMatchObject({ ok: true, kind: 'ok' });
  });

  it('200 但结构缺 user 字段 → protocol-changed（协议变更信号）', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(jsonResponse(200, { message: 'pong' }));
    const r = await probeProtocol();
    expect(r).toMatchObject({ ok: false, kind: 'protocol-changed', status: 200 });
  });

  it('200 但响应体不是 JSON → protocol-changed', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); },
    } as unknown as Response);
    const r = await probeProtocol();
    expect(r).toMatchObject({ ok: false, kind: 'protocol-changed', status: 200 });
  });

  it('401 → credential-invalid（凭据失效单列，不是上游故障）', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(okResponse(401));
    const r = await probeProtocol();
    expect(r).toMatchObject({ ok: false, kind: 'credential-invalid', status: 401, keySuffix: '1234' });
  });

  it('5xx / 网络层失败 → unreachable，且 warn 留痕、不重试', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(okResponse(503));
    const r1 = await probeProtocol();
    expect(r1).toMatchObject({ ok: false, kind: 'unreachable', status: 503 });
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const r2 = await probeProtocol();
    expect(r2).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(r2.skipped !== true && r2.status).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 失败不重试：每轮恰好一次
  });

  it('URL 不安全时不发请求，记为 unreachable', async () => {
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    process.env.COMMANDCODE_API_BASE = 'http://192.168.1.5';
    const r = await probeProtocol();
    expect(r).toMatchObject({ ok: false, kind: 'unreachable', keySuffix: '1234' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('结果并入 getChannelHealth().protocolCheck；resetHealthState 重置为 pending', async () => {
    expect(getChannelHealth().protocolCheck).toEqual({ skipped: true, reason: 'pending' });
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 'u_1' } }));
    await probeProtocol();
    expect(getChannelHealth().protocolCheck).toMatchObject({ kind: 'ok', ok: true });
    resetHealthState();
    expect(getChannelHealth().protocolCheck).toEqual({ skipped: true, reason: 'pending' });
  });
});

describe('startProtocolChecks — 定时装配', () => {
  it('PROTOCOL_CHECK_INTERVAL_MS=0 时不启动（返回 null，零 fetch）', () => {
    process.env.PROTOCOL_CHECK_INTERVAL_MS = '0';
    expect(startProtocolChecks()).toBeNull();
  });

  it('env 缺省时按 10 分钟周期，可被 opts.intervalMs 覆盖；与 HTTP 探活互不影响', async () => {
    vi.useFakeTimers();
    mockedGetActiveApiKey.mockReturnValue(TEST_KEY);
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 'u_1' } }));
    const timer = startProtocolChecks({ intervalMs: 1000 });
    expect(timer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 只有协议探针在跑（未启动 startHealthChecks）
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/alpha/whoami');
    clearInterval(timer!);
    expect(getChannelHealth().protocolCheck).toMatchObject({ kind: 'ok' });
  });
});
