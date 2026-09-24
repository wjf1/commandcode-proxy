// =============================================================================
// Webhook 告警：阈值判断、每日去重与 fire-and-forget 容错
// -----------------------------------------------------------------------------
// 锁定的行为：
//   1. WEBHOOK_URL 未设置时整个功能关闭（不启动、fetch 零调用）；
//   2. 当日成本 / 当日错误率超阈值时向 WEBHOOK_URL POST 约定结构的 JSON；
//   3. 每个阈值每自然日最多告警一次（发送失败当天也不重试）；
//   4. 发送失败（超时/5xx）只 warn 不抛错；
//   5. WEBHOOK_CHECK_INTERVAL_MS=0 时不启动定时器。
// usage-store 统计整体 vi.mock，fetch 全部 spyOn mock，不发真实网络请求。
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import { getUsageStats, getUsageHistory } from '../src/utils/usage-store.js';
import {
  startWebhookAlerts,
  checkThresholds,
  notifyWebhook,
  webhookEnabled,
  resetWebhookState,
} from '../src/utils/webhook-alerts.js';

vi.mock('../src/utils/usage-store.js', () => ({
  getUsageStats: vi.fn(),
  getUsageHistory: vi.fn(),
}));

const mockedStats = vi.mocked(getUsageStats);
const mockedHistory = vi.mocked(getUsageHistory);

const WEBHOOK_URL = 'https://hooks.example.com/alert';

let fetchMock: ReturnType<typeof vi.spyOn>;

/** 当日（本地自然日）的 ISO 时间戳。 */
const todayIso = () => new Date().toISOString();

beforeEach(() => {
  vi.restoreAllMocks();
  resetWebhookState();
  delete process.env.WEBHOOK_URL;
  delete process.env.WEBHOOK_COST_USD;
  delete process.env.WEBHOOK_ERROR_RATE;
  delete process.env.WEBHOOK_CHECK_INTERVAL_MS;
  delete process.env.WEBHOOK_TIMEOUT_MS;
  mockedStats.mockReset();
  mockedHistory.mockReset();
  mockedStats.mockReturnValue({ today: { cost: 0 } } as any);
  mockedHistory.mockReturnValue([] as any);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.WEBHOOK_URL;
  delete process.env.WEBHOOK_COST_USD;
  delete process.env.WEBHOOK_ERROR_RATE;
  delete process.env.WEBHOOK_CHECK_INTERVAL_MS;
  delete process.env.WEBHOOK_TIMEOUT_MS;
});

function lastBody(): Record<string, any> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown[];
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('默认关闭路径', () => {
  it('WEBHOOK_URL 未设置时功能关闭：startWebhookAlerts 返回 null', () => {
    expect(webhookEnabled()).toBe(false);
    expect(startWebhookAlerts()).toBeNull();
  });

  it('WEBHOOK_URL 未设置时 checkThresholds 即使超阈值也零 fetch', async () => {
    mockedStats.mockReturnValue({ today: { cost: 999 } } as any);
    await checkThresholds();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('WEBHOOK_URL 已设但两个阈值 env 均未设置时零 fetch', async () => {
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    await checkThresholds();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('WEBHOOK_CHECK_INTERVAL_MS=0 时不启动（返回 null）', () => {
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    process.env.WEBHOOK_CHECK_INTERVAL_MS = '0';
    expect(startWebhookAlerts()).toBeNull();
  });
});

describe('成本告警（daily-cost）', () => {
  beforeEach(() => {
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    process.env.WEBHOOK_COST_USD = '5';
  });

  it('当日累计成本 ≥ 阈值时 POST 约定结构的 JSON', async () => {
    mockedStats.mockReturnValue({ today: { cost: 6.5 } } as any);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await checkThresholds();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown[];
    expect(String(url)).toBe(WEBHOOK_URL);
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const body = lastBody();
    expect(body.event).toBe('daily-cost');
    expect(body.value).toBe(6.5);
    expect(body.threshold).toBe(5);
    expect(typeof body.timestamp).toBe('string');
    expect(body.summary).toContain('6.50');
    expect(warnSpy).toHaveBeenCalled(); // 本地日志同时留痕
  });

  it('未达阈值时不发送', async () => {
    mockedStats.mockReturnValue({ today: { cost: 4.99 } } as any);
    await checkThresholds();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('同日第二次检查不再发送（每自然日最多一次）', async () => {
    mockedStats.mockReturnValue({ today: { cost: 6.5 } } as any);
    await checkThresholds();
    await checkThresholds();
    await checkThresholds();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('错误率告警（daily-error-rate）', () => {
  beforeEach(() => {
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    process.env.WEBHOOK_ERROR_RATE = '0.1';
  });

  it('当日错误率 ≥ 阈值（2/10 = 0.2 ≥ 0.1）时 POST', async () => {
    const recs = Array.from({ length: 10 }, (_, i) => ({
      timestamp: todayIso(),
      status: i < 2 ? 'FAILED' : 'COMPLETED',
    }));
    mockedHistory.mockReturnValue(recs as any);
    await checkThresholds();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(body.event).toBe('daily-error-rate');
    expect(body.value).toBeCloseTo(0.2, 5);
    expect(body.threshold).toBe(0.1);
    expect(body.summary).toContain('2/10');
  });

  it('当日无请求记录时不告警（避免 0/0 误报）', async () => {
    mockedHistory.mockReturnValue([] as any);
    await checkThresholds();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('错误率未达阈值时不发送', async () => {
    const recs = Array.from({ length: 10 }, () => ({
      timestamp: todayIso(),
      status: 'COMPLETED', // 0/10 = 0 < 0.1
    }));
    mockedHistory.mockReturnValue(recs as any);
    await checkThresholds();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('昨日及更早的记录不计入当日口径', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recs = [
      { timestamp: yesterday, status: 'FAILED' },
      { timestamp: yesterday, status: 'FAILED' },
      { timestamp: todayIso(), status: 'COMPLETED' },
    ];
    mockedHistory.mockReturnValue(recs as any);
    await checkThresholds(); // 当日 0 失败 / 1 条 → 0 < 0.1
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('发送容错与去重', () => {
  beforeEach(() => {
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    process.env.WEBHOOK_COST_USD = '5';
    mockedStats.mockReturnValue({ today: { cost: 9 } } as any);
  });

  it('fetch 超时/失败不抛错，且同日不重试', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(checkThresholds()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await checkThresholds();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 当天已占坑，不再发
  });

  it('HTTP 非 2xx 也算失败：warn 不抛错、当天不重试', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 } as Response);
    await expect(checkThresholds()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('notifyWebhook — 公开通知 API', () => {
  it('WEBHOOK_URL 未设置时返回 false 且零 fetch', async () => {
    await expect(notifyWebhook('manual-event', { foo: 1 })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('设置后 POST event + payload + timestamp', async () => {
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    await expect(notifyWebhook('manual-event', { foo: 1 })).resolves.toBe(true);
    const body = lastBody();
    expect(body).toMatchObject({ event: 'manual-event', foo: 1 });
    expect(typeof body.timestamp).toBe('string');
  });

  it('非法协议的 WEBHOOK_URL 拒绝发送', async () => {
    process.env.WEBHOOK_URL = 'file:///etc/passwd';
    await expect(notifyWebhook('manual-event', {})).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startWebhookAlerts — 定时装配', () => {
  it('按 opts.intervalMs 启动并周期检查，timer 可清除', async () => {
    vi.useFakeTimers();
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    process.env.WEBHOOK_COST_USD = '5';
    mockedStats.mockReturnValue({ today: { cost: 9 } } as any);
    const timer = startWebhookAlerts({ intervalMs: 1000 });
    expect(timer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearInterval(timer!);
  });

  it('env 缺省时按 10 分钟周期，WEBHOOK_CHECK_INTERVAL_MS 可覆盖', async () => {
    vi.useFakeTimers();
    process.env.WEBHOOK_URL = WEBHOOK_URL;
    process.env.WEBHOOK_CHECK_INTERVAL_MS = '60000';
    mockedStats.mockReturnValue({ today: { cost: 9 } } as any);
    process.env.WEBHOOK_COST_USD = '5';
    const timer = startWebhookAlerts();
    expect(timer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearInterval(timer!);
  });
});
