// =============================================================================
// 吞吐/延迟分布 与 额度燃烧速率预测
// -----------------------------------------------------------------------------
// 两处都强调口径，测试同样锁住口径：
//   - tok/s 是**端到端**吞吐（timingMs 含排队/重试/网络），不等于模型生成速度；
//   - 燃烧速率来自**官方 used 的时间差分**，绝不能用本地用量历史外推 —— 本地
//     只覆盖代理流量（实测约 18%），用它预测全账号额度会严重高估剩余时间。
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  projectFromSamples,
  recordQuotaSample,
  getQuotaProjection,
  resetQuotaSamples,
  quotaSampleCount,
  QuotaSample,
} from '../src/utils/quota-tracker.js';
import { throughputTokS, percentile, perfOf, compareModelPerf, UsageRecord, MIN_THROUGHPUT_OUTPUT_TOKENS } from '../src/utils/usage-store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

// ─── 吞吐与延迟 ─────────────────────────────────────────────────────────────

describe('throughputTokS — 端到端口径', () => {
  it('500 tok / 5s = 100 t/s', () => {
    expect(throughputTokS(500, 5000)).toBeCloseTo(100, 6);
  });

  it('无输出 / 无耗时 / 非法值返回 null（而不是 0 或 NaN）', () => {
    expect(throughputTokS(0, 5000)).toBeNull();
    expect(throughputTokS(100, 0)).toBeNull();
    expect(throughputTokS(-5, 1000)).toBeNull();
    expect(throughputTokS(NaN, 1000)).toBeNull();
    expect(throughputTokS(100, NaN)).toBeNull();
  });
});

describe('percentile — 线性插值', () => {
  it('单元素与空数组', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
  });
  it('P50 与 P95 落点正确', () => {
    // 1..100 升序：P50 = 50.5，P95 = 95.05
    const a = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(a, 0.5)).toBeCloseTo(50.5, 6);
    expect(percentile(a, 0.95)).toBeCloseTo(95.05, 6);
  });
});

// ─── perfOf：吞吐闸门 ───────────────────────────────────────────────────────
//
// 背景（真实事故）：集成套件未隔离 USAGE_HISTORY_PATH，把 mock 上游返回的
// 3 / 25 token 响应写进了生产用量库。这些记录耗时只有十几毫秒（本机 mock），
// 于是 25/0.012 ≈ 2083 t/s、3/0.016 ≈ 187 t/s —— 面板上 claude-sonnet-5 的
// P50 吞吐因此显示 187.5 t/s、P95 显示 2083 t/s，看起来像在吹牛。
// 闸门设计：输出过短的记录只进延迟统计，不进吞吐统计。

const rec = (o: Partial<UsageRecord>): UsageRecord => ({
  timestamp: '2026-09-11T02:00:00.000Z',
  model: 'm',
  inputTokens: 100,
  outputTokens: 500,
  timingMs: 5000,
  costUsd: 0,
  hasPricing: true,
  status: 'COMPLETED',
  mode: 'chat',
  ...o,
});

describe('perfOf — 短输出不进吞吐统计', () => {
  it('默认阈值下，19ms / 3 token 的样本被闸门挡在吞吐之外，但仍计入延迟', () => {
    const p = perfOf([rec({ outputTokens: 3, timingMs: 19 })]);
    expect(MIN_THROUGHPUT_OUTPUT_TOKENS).toBe(32);
    expect(p.throughputSamples).toBe(0);
    expect(p.tokSP50).toBeNull();
    expect(p.tokSP95).toBeNull();
    // 延迟照旧 —— 这确实是一次真实等待
    expect(p.latencyP50Ms).toBe(19);
    expect(p.samples).toBe(1);
  });

  it('mock 残留样本（3/25 token + 十几毫秒）不会拉飞 P50/P95', () => {
    const mockNoise = [
      rec({ outputTokens: 3, timingMs: 16 }),
      rec({ outputTokens: 3, timingMs: 19 }),
      rec({ outputTokens: 25, timingMs: 12 }),
      rec({ outputTokens: 17, timingMs: 19 }),
    ];
    const realTraffic = [
      rec({ outputTokens: 600, timingMs: 9000 }),
      rec({ outputTokens: 900, timingMs: 11000 }),
    ];
    const p = perfOf([...mockNoise, ...realTraffic]);
    expect(p.throughputSamples).toBe(2);
    expect(p.samples).toBe(6);
    // 只剩真实流量：(66.7 + 81.8)/2 → P50 落在 70 上下，而不是 187 或 2083
    expect(p.tokSP50!).toBeLessThan(100);
    expect(p.tokSP95!).toBeLessThan(100);
  });

  it('阈值可显式传入（0 = 关闭闸门，恢复原口径）', () => {
    const rs = [rec({ outputTokens: 25, timingMs: 12 })];
    expect(perfOf(rs, 0).throughputSamples).toBe(1);
    expect(perfOf(rs, 0).tokSP50).toBeCloseTo(2083.3, 1);
    expect(perfOf(rs, 32).throughputSamples).toBe(0);
    // 边界：恰好等于阈值时计入
    expect(perfOf([rec({ outputTokens: 32, timingMs: 1000 })], 32).throughputSamples).toBe(1);
  });

  it('非 COMPLETED 的记录两个口径都不计', () => {
    const p = perfOf([
      rec({ outputTokens: 500, status: 'FAILED' }),
      rec({ outputTokens: 500, timingMs: 0 }),
    ]);
    expect(p.samples).toBe(0);
    expect(p.throughputSamples).toBe(0);
    expect(p.tokSP50).toBeNull();
    expect(p.latencyP50Ms).toBeNull();
  });
});

describe('compareModelPerf — 座次，不是过滤', () => {
  const m = (model, throughputSamples, samples) => ({ model, throughputSamples, samples });

  it('有吞吐数据的行排在算不出速率的行之前，哪怕后者延迟样本更多', () => {
    const rows = [
      m('只有延迟', 0, 505), // 输出全都过短：算不出速率，但被调用过 505 次
      m('有吞吐', 3, 3),
    ];
    rows.sort(compareModelPerf);
    expect(rows.map(r => r.model)).toEqual(['有吞吐', '只有延迟']);
  });

  it('吞吐样本相同时按延迟样本降序', () => {
    const rows = [m('a', 2, 2), m('b', 2, 90), m('c', 2, 40)];
    rows.sort(compareModelPerf);
    expect(rows.map(r => r.model)).toEqual(['b', 'c', 'a']);
  });

  it('排序后行数不变——算不出速率的行只是沉底，不被删掉', () => {
    const rows = [m('x', 0, 1), m('y', 10, 10), m('z', 0, 40)];
    expect(rows.slice().sort(compareModelPerf)).toHaveLength(3);
  });
});

// ─── 额度燃烧速率 ───────────────────────────────────────────────────────────

const sample = (at: number, used: number, cap = 3, resetAt: number | null = null): QuotaSample =>
  ({ at, used, cap, resetAt });

describe('projectFromSamples — 官方 used 的时间差分', () => {
  const NOW = 1_800_000_000_000;

  it('无采样时全部为空', () => {
    const p = projectFromSamples([], NOW);
    expect(p.samples).toBe(0);
    expect(p.burnPerHour).toBeNull();
    expect(p.willHitCapBeforeReset).toBeNull();
  });

  it('单一采样：有余量与比例，但无速率', () => {
    const p = projectFromSamples([sample(NOW - MIN, 1.2, 3)], NOW);
    expect(p.samples).toBe(1);
    expect(p.remainingUsd).toBeCloseTo(1.8, 9);
    expect(p.usageRatio).toBeCloseTo(0.4, 9);
    expect(p.burnPerHour).toBeNull();
    expect(p.willHitCapBeforeReset).toBeNull();
  });

  it('线性消耗：速率 = 差分/时长，并外推撞限时间', () => {
    // 1 小时内从 1.0 涨到 2.0 → 1.0 USD/h，剩余 1.0 → 60 分钟后撞限
    const s = [sample(NOW - HOUR, 1.0, 3), sample(NOW, 2.0, 3)];
    const p = projectFromSamples(s, NOW);
    expect(p.burnPerHour).toBeCloseTo(1.0, 9);
    expect(p.remainingUsd).toBeCloseTo(1.0, 9);
    expect(p.minutesToCap).toBe(60);
  });

  it('将在重置之前撞限 → willHitCapBeforeReset = true（需要行动的结论）', () => {
    // 速率 1.0/h，剩余 1.0 → 60 分钟撞限；重置在 120 分钟后 → 撞限在前
    const s = [sample(NOW - HOUR, 1.0, 3), sample(NOW, 2.0, 3, NOW + 2 * HOUR)];
    const p = projectFromSamples(s, NOW);
    expect(p.minutesToCap).toBe(60);
    expect(p.minutesToReset).toBe(120);
    expect(p.willHitCapBeforeReset).toBe(true);
  });

  it('重置更早到来 → 不会撞限', () => {
    // 60 分钟后才撞限，但 40 分钟后就重置 → 无需行动
    const s = [sample(NOW - HOUR, 1.0, 3), sample(NOW, 2.0, 3, NOW + 40 * MIN)];
    const p = projectFromSamples(s, NOW);
    expect(p.minutesToCap).toBe(60);
    expect(p.minutesToReset).toBe(40);
    expect(p.willHitCapBeforeReset).toBe(false);
  });

  it('官方计数回落（重置/口径修正）→ 速率为 0，不外推', () => {
    const s = [sample(NOW - HOUR, 2.5, 3), sample(NOW, 0.5, 3)];
    const p = projectFromSamples(s, NOW);
    expect(p.burnPerHour).toBe(0);
    expect(p.minutesToCap).toBeNull();
    expect(p.willHitCapBeforeReset).toBe(false);
  });

  it('速率非正（持平）→ 不会撞限', () => {
    const s = [sample(NOW - HOUR, 1.5, 3), sample(NOW, 1.5, 3)];
    expect(projectFromSamples(s, NOW).willHitCapBeforeReset).toBe(false);
  });

  it('跨度不足 10 分钟时自动放宽取更早样本，抑制噪声', () => {
    // 最近 3 分钟内多个抖动样本，但 30 分钟前有基线 → 应采用 30 分钟跨度
    const s = [
      sample(NOW - 30 * MIN, 1.0, 3),
      sample(NOW - 3 * MIN, 1.4, 3),
      sample(NOW - 2 * MIN, 1.2, 3),
      sample(NOW, 1.5, 3),
    ];
    const p = projectFromSamples(s, NOW);
    expect(p.windowMinutes).toBe(30);
    // (1.5-1.0)/0.5h = 1.0 USD/h
    expect(p.burnPerHour).toBeCloseTo(1.0, 9);
  });

  it('过期采样（>6h）被丢弃', () => {
    const s = [sample(NOW - 7 * HOUR, 0, 3), sample(NOW, 1.5, 3)];
    const p = projectFromSamples(s, NOW);
    expect(p.samples).toBe(1);
    expect(p.burnPerHour).toBeNull();
  });

  it('缺 resetAt 时撞限判断为 null（无法比较）', () => {
    const s = [sample(NOW - HOUR, 1.0, 3, null), sample(NOW, 2.0, 3, null)];
    const p = projectFromSamples(s, NOW);
    expect(p.minutesToCap).toBe(60);
    expect(p.willHitCapBeforeReset).toBeNull();
  });
});

describe('进程内采样器', () => {
  it('记录并读取，重复值也保留（用于确认"确实没增长"）', () => {
    resetQuotaSamples();
    recordQuotaSample(1.0, 3, null, 1000);
    recordQuotaSample(1.0, 3, null, 2000);
    recordQuotaSample(1.2, 3, null, 3000);
    expect(quotaSampleCount()).toBe(3);
    const p = getQuotaProjection(3000);
    expect(p.samples).toBe(3);
  });

  it('非法值被拒绝', () => {
    resetQuotaSamples();
    recordQuotaSample(NaN, 3, null, 1000);
    recordQuotaSample(1, NaN, null, 1000);
    expect(quotaSampleCount()).toBe(0);
  });

  it('超出容量上限时丢弃最旧样本', () => {
    resetQuotaSamples();
    for (let i = 0; i < 210; i++) recordQuotaSample(i, 3, null, i * 1000);
    expect(quotaSampleCount()).toBe(200);
  });
});
