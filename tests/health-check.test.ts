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
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import {
  probeOnce,
  getChannelHealth,
  startHealthChecks,
  resetHealthState,
} from '../src/utils/health-check.js';

// 指向公网默认上游（与代码默认一致），assertSafeUpstreamUrl 才会放行；
// fetch 已 mock，不会真的出网。
const SAFE_BASE = 'https://api.commandcode.ai';

let fetchMock: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

const okResponse = (status: number) => ({ ok: status >= 200 && status < 300, status } as Response);

beforeEach(() => {
  vi.restoreAllMocks();
  resetHealthState();
  process.env.COMMANDCODE_API_BASE = SAFE_BASE;
  delete process.env.HEALTH_CHECK_INTERVAL_MS;
  delete process.env.HEALTH_CHECK_TIMEOUT_MS;
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
