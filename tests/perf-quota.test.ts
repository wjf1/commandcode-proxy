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
import { throughputTokS, percentile } from '../src/utils/usage-store.js';

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
