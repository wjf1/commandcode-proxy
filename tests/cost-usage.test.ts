// =============================================================================
// 成本与缓存采集测试
// -----------------------------------------------------------------------------
// 覆盖两处曾导致面板成本与官方账单差 7 倍的缺陷：
//   1. 上游 finish 的 inputTokens **含**缓存命中，缓存读单价仅为输入的 1/50，
//      不拆分就会把 90%+ 的输入按全价计；
//   2. 官方对 deepseek 等模型设峰时价（$0.30/$1.20），只取谷时价会低估一半。
// 另覆盖 provider-metadata 的权威账单金额采集（gateway.cost）。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accumulateUsage, createUsageAccumulator, parseUsd } from '../src/adapters/commandcode/usage.js';
import { isPeakBillingTime } from '../src/utils/usage-store.js';

// ─── 采集：缓存拆分与官方账单 ────────────────────────────────────────────────

describe('accumulateUsage — 缓存明细拆分', () => {
  it('把含缓存的 inputTokens 拆成 noCache / cacheRead（实测上游结构）', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, {
      type: 'finish',
      totalUsage: {
        inputTokens: 7616,
        outputTokens: 13,
        cachedInputTokens: 7296,
        inputTokenDetails: { noCacheTokens: 320, cacheReadTokens: 7296 },
      },
    });
    expect(acc.inputTokens).toBe(7616);
    expect(acc.cacheReadTokens).toBe(7296);
    expect(acc.noCacheTokens).toBe(320);
    expect(acc.outputTokens).toBe(13);
    expect(acc.sawUsage).toBe(true);
  });

  it('兼容只有 cachedInputTokens 的简写形态', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, { type: 'finish', totalUsage: { inputTokens: 1000, cachedInputTokens: 900 } });
    expect(acc.cacheReadTokens).toBe(900);
    expect(acc.noCacheTokens).toBe(100);
  });

  it('无缓存字段时全部计入 noCache，不虚构缓存命中', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, { type: 'finish', totalUsage: { inputTokens: 500, outputTokens: 20 } });
    expect(acc.cacheReadTokens).toBe(0);
    expect(acc.noCacheTokens).toBe(500);
  });

  it('finish-step 与 finish 携带同一份 usage 时覆盖而非累加', () => {
    const acc = createUsageAccumulator();
    const usage = { inputTokens: 7616, outputTokens: 13, inputTokenDetails: { cacheReadTokens: 7296, noCacheTokens: 320 } };
    accumulateUsage(acc, { type: 'finish-step', totalUsage: usage });
    accumulateUsage(acc, { type: 'finish', totalUsage: usage });
    // 累加会得到 15232 —— 上游两个事件是同一轮，必须覆盖。
    expect(acc.inputTokens).toBe(7616);
    expect(acc.outputTokens).toBe(13);
  });

  it('对无关事件是 no-op', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, { type: 'text-delta', text: 'hi' });
    accumulateUsage(acc, { type: 'start' });
    expect(acc.sawUsage).toBe(false);
    expect(acc.inputTokens).toBe(0);
  });
});

describe('accumulateUsage — 官方账单金额（provider-metadata）', () => {
  it('抓取 gateway.cost 作为权威金额', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, {
      type: 'provider-metadata',
      providerMetadata: { gateway: { cost: '0.000155376', inferenceCost: '0.000155376' } },
    });
    expect(acc.upstreamCostUsd).toBeCloseTo(0.000155376, 12);
  });

  it('也接受数字形态', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, { type: 'provider-metadata', providerMetadata: { gateway: { cost: 0.5 } } });
    expect(acc.upstreamCostUsd).toBe(0.5);
  });

  it('缺少 cost 时不写入（回落本地估算）', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, { type: 'provider-metadata', providerMetadata: { gateway: { marketCost: '0.1' } } });
    expect(acc.upstreamCostUsd).toBeUndefined();
  });
});

describe('parseUsd', () => {
  it('解析字符串与数字', () => {
    expect(parseUsd('0.001')).toBe(0.001);
    expect(parseUsd(0.001)).toBe(0.001);
  });
  it('非法值返回 undefined', () => {
    expect(parseUsd('abc')).toBeUndefined();
    expect(parseUsd(undefined)).toBeUndefined();
    expect(parseUsd(NaN)).toBeUndefined();
    expect(parseUsd({})).toBeUndefined();
  });
});

// ─── 峰谷时段判定 ────────────────────────────────────────────────────────────

describe('isPeakBillingTime — 官方 01–04 & 06–10 UTC, Mon–Fri', () => {
  const utc = (iso: string) => new Date(iso);

  it('工作日 UTC 01–04 与 06–10 为峰时', () => {
    // 2026-09-11 是周五
    expect(isPeakBillingTime(utc('2026-09-11T01:00:00Z'))).toBe(true);
    expect(isPeakBillingTime(utc('2026-09-11T03:59:00Z'))).toBe(true);
    expect(isPeakBillingTime(utc('2026-09-11T06:00:00Z'))).toBe(true);
    expect(isPeakBillingTime(utc('2026-09-11T09:59:00Z'))).toBe(true);
  });

  it('工作日窗口之间与之外为谷时', () => {
    expect(isPeakBillingTime(utc('2026-09-11T00:59:00Z'))).toBe(false);
    expect(isPeakBillingTime(utc('2026-09-11T04:00:00Z'))).toBe(false);
    expect(isPeakBillingTime(utc('2026-09-11T05:59:00Z'))).toBe(false);
    expect(isPeakBillingTime(utc('2026-09-11T10:00:00Z'))).toBe(false);
    expect(isPeakBillingTime(utc('2026-09-11T18:00:00Z'))).toBe(false);
  });

  it('周末全天为谷时（官方 "all day Sat–Sun"）', () => {
    // 2026-09-12 周六 / 2026-09-13 周日
    expect(isPeakBillingTime(utc('2026-09-12T02:00:00Z'))).toBe(false);
    expect(isPeakBillingTime(utc('2026-09-12T08:00:00Z'))).toBe(false);
    expect(isPeakBillingTime(utc('2026-09-13T07:00:00Z'))).toBe(false);
  });
});

// ─── 本地估算：缓存价 + 峰谷价（需注入模型定价缓存）────────────────────────────

describe('estimateCostUsd — 缓存读按 1/50 单价、峰谷分时', () => {
  let stateDir: string;
  let store: typeof import('../src/utils/usage-store.js');

  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-cost-'));
    // 官方实测费率：deepseek-v4.1-flash 谷时 0.15/0.6/0.003，峰时 0.30/1.20/0.006
    writeFileSync(
      path.join(stateDir, 'models.json'),
      JSON.stringify([
        {
          id: 'deepseek/deepseek-v4.1-flash',
          object: 'model',
          created: 1,
          owned_by: 'deepseek',
          name: 'DeepSeek V4.1 Flash',
          pricing: { input: 0.15, output: 0.6, cacheRead: 0.003 },
          timeOfDay: {
            peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
            offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
            peakHoursPerDay: 7,
            windows: '01–04 & 06–10 UTC, Mon–Fri',
          },
        },
        {
          id: 'static-model',
          object: 'model',
          created: 1,
          owned_by: 'x',
          pricing: { input: 1, output: 2, cacheRead: 0.1 },
        },
        {
          // 反常定价：缓存读比输入还贵 —— 节省额应为 0，不得为负
          id: 'weird-model',
          object: 'model',
          created: 1,
          owned_by: 'x',
          pricing: { input: 1, output: 1, cacheRead: 2 },
        },
      ]),
      'utf-8'
    );
    vi.resetModules();
    process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
    store = await import('../src/utils/usage-store.js');
  });

  afterEach(() => {
    delete process.env.COMMANDCODE_MODELS_CACHE_PATH;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const estimateCostUsd = (...args: Parameters<typeof store.estimateCostUsd>) => store.estimateCostUsd(...args);

  const PEAK = new Date('2026-09-11T02:00:00Z'); // 周五 峰时
  const OFF = new Date('2026-09-11T18:00:00Z'); // 周五 谷时

  it('峰时高缓存命中：与官方账单口径一致（曾虚高约 7 倍）', () => {
    // 实测探针：320 非缓存 + 7296 缓存读 + 13 输出 → 官方 0.000155376
    const { costUsd, hasPricing } = estimateCostUsd('deepseek/deepseek-v4.1-flash', 7616, 13, {
      cacheReadTokens: 7296,
      at: PEAK,
    });
    expect(hasPricing).toBe(true);
    expect(costUsd).toBeCloseTo(0.000155376, 12);
  });

  it('峰时零缓存：非缓存输入按峰时输入价（曾低估一半）', () => {
    // 实测探针：64 输入全未命中 + 162 输出 → 官方 0.0002136
    const { costUsd } = estimateCostUsd('deepseek/deepseek-v4.1-flash', 64, 162, { at: PEAK });
    expect(costUsd).toBeCloseTo(0.0002136, 12);
  });

  it('谷时同量请求按谷时价（比峰时低一半）', () => {
    const { costUsd } = estimateCostUsd('deepseek/deepseek-v4.1-flash', 64, 162, { at: OFF });
    expect(costUsd).toBeCloseTo(0.0001068, 12);
  });

  it('旧口径（整段输入×输入价）会明显高估 —— 回归保护', () => {
    const { costUsd } = estimateCostUsd('deepseek/deepseek-v4.1-flash', 7616, 13, {
      cacheReadTokens: 7296,
      at: PEAK,
    });
    const oldFormula = (7616 / 1e6) * 0.15 + (13 / 1e6) * 0.6; // 0.0011502
    expect(costUsd).toBeLessThan(oldFormula / 5);
  });

  it('无分时价的模型回落到静态定价', () => {
    const { costUsd, hasPricing } = estimateCostUsd('static-model', 1000, 1000, {
      cacheReadTokens: 500,
      at: PEAK,
    });
    // 500×1 + 500×0.1 + 1000×2 = 500 + 50 + 2000 微美元
    expect(hasPricing).toBe(true);
    expect(costUsd).toBeCloseTo((500 * 1 + 500 * 0.1 + 1000 * 2) / 1e6, 12);
  });

  it('未知模型 hasPricing=false 且成本为 0', () => {
    const { costUsd, hasPricing } = estimateCostUsd('nope', 100, 100);
    expect(hasPricing).toBe(false);
    expect(costUsd).toBe(0);
  });

  // ── 缓存节省可视化 ──────────────────────────────────────────────────────────

  describe('estimateCacheSavingsUsd — 缓存命中省下多少', () => {
    it('按 (输入价 − 缓存读价) 计算峰时节省', () => {
      // 峰时 0.30 − 0.006 = 0.294 /M
      const saved = store.estimateCacheSavingsUsd('deepseek/deepseek-v4.1-flash', 152448, PEAK);
      expect(saved).toBeCloseTo((152448 / 1e6) * (0.3 - 0.006), 12);
      expect(saved).toBeCloseTo(0.044819712, 12);
    });

    it('谷时节省按谷时差额（0.15 − 0.003）', () => {
      const saved = store.estimateCacheSavingsUsd('deepseek/deepseek-v4.1-flash', 1250000, OFF);
      expect(saved).toBeCloseTo((1250000 / 1e6) * (0.15 - 0.003), 12);
    });

    it('峰时节省严格大于谷时同量（费率差更大）', () => {
      const peak = store.estimateCacheSavingsUsd('deepseek/deepseek-v4.1-flash', 1000000, PEAK);
      const off = store.estimateCacheSavingsUsd('deepseek/deepseek-v4.1-flash', 1000000, OFF);
      expect(peak).toBeGreaterThan(off);
      expect(peak / off).toBeCloseTo(0.294 / 0.147, 6);
    });

    it('无缓存命中时为 0', () => {
      expect(store.estimateCacheSavingsUsd('deepseek/deepseek-v4.1-flash', 0, PEAK)).toBe(0);
    });

    it('缓存价高于输入价时不报负节省（反常定价护栏）', () => {
      // weird-model 的 cacheRead(2) > input(1)，节省应为 0 而非负数
      expect(store.estimateCacheSavingsUsd('weird-model', 1000, PEAK)).toBe(0);
    });

    it('未知模型为 0（无定价）', () => {
      expect(store.estimateCacheSavingsUsd('nope', 1000, PEAK)).toBe(0);
    });
  });

  // ── 峰谷窗口描述 ────────────────────────────────────────────────────────────

  describe('describeBillingWindow — 当前档位与切换倒计时', () => {
    it('峰时：isPeak=true，nextChangeAt 指向 04:00 UTC', () => {
      const at = new Date('2026-09-11T02:00:00Z'); // 周五 02:00 峰时
      const w = store.describeBillingWindow(at);
      expect(w.isPeak).toBe(true);
      expect(w.nextIsPeak).toBe(false);
      expect(w.nextChangeAt).toBe('2026-09-11T04:00:00.000Z');
      expect(w.minutesUntilChange).toBe(120);
      expect(w.windows).toContain('UTC');
      expect(w.peakHoursPerDay).toBe(7);
    });

    it('峰时 06–10：切换点指向 10:00 UTC', () => {
      const w = store.describeBillingWindow(new Date('2026-09-11T06:30:00Z'));
      expect(w.isPeak).toBe(true);
      expect(w.nextChangeAt).toBe('2026-09-11T10:00:00.000Z');
    });

    it('谷时：切换点指向当日 01:00 或 06:00 峰时起点', () => {
      const w = store.describeBillingWindow(new Date('2026-09-11T00:30:00Z'));
      expect(w.isPeak).toBe(false);
      expect(w.nextIsPeak).toBe(true);
      expect(w.nextChangeAt).toBe('2026-09-11T01:00:00.000Z');
      expect(w.minutesUntilChange).toBe(30);
    });

    it('周五 10:00 后一直谷时，跨越周末到下周一 01:00', () => {
      const w = store.describeBillingWindow(new Date('2026-09-11T12:00:00Z')); // 周五中午
      expect(w.isPeak).toBe(false);
      expect(w.nextIsPeak).toBe(true);
      // 下周一 2026-09-14 01:00 UTC
      expect(w.nextChangeAt).toBe('2026-09-14T01:00:00.000Z');
    });

    it('周六为谷时，下次切换仍是下周一 01:00', () => {
      const w = store.describeBillingWindow(new Date('2026-09-12T09:00:00Z')); // 周六
      expect(w.isPeak).toBe(false);
      expect(w.nextChangeAt).toBe('2026-09-14T01:00:00.000Z');
    });
  });

  describe('getTimeOfDayModels — 列出受分时价影响的模型', () => {
    it('只返回带 timeOfDay 的模型，并给出当前生效费率', () => {
      const peakList = store.getTimeOfDayModels(PEAK);
      expect(peakList).toHaveLength(1);
      expect(peakList[0].id).toBe('deepseek/deepseek-v4.1-flash');
      expect(peakList[0].activeRates?.input).toBe(0.3); // 峰时档

      const offList = store.getTimeOfDayModels(OFF);
      expect(offList[0].activeRates?.input).toBe(0.15); // 谷时档
    });
  });
});

// 无分时价模型的场景需在全新模块实例下验证（模型缓存在导入时加载）。
describe('describeBillingWindow — 全部模型均为静态定价时', () => {
  let stateDir: string;
  let store: typeof import('../src/utils/usage-store.js');

  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-nostat-'));
    writeFileSync(
      path.join(stateDir, 'models.json'),
      JSON.stringify([{ id: 'static-model', object: 'model', created: 1, owned_by: 'x', pricing: { input: 1, output: 2 } }]),
      'utf-8'
    );
    vi.resetModules();
    process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
    store = await import('../src/utils/usage-store.js');
  });

  afterEach(() => {
    delete process.env.COMMANDCODE_MODELS_CACHE_PATH;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('不返回窗口描述，且 isPeak 为 false', () => {
    const w = store.describeBillingWindow(new Date('2026-09-11T02:00:00Z'));
    expect(w.isPeak).toBe(false);
    expect(w.windows).toBeUndefined();
    expect(w.nextChangeAt).toBeNull();
    expect(w.minutesUntilChange).toBeNull();
  });

  it('getTimeOfDayModels 返回空数组', () => {
    expect(store.getTimeOfDayModels(new Date('2026-09-11T02:00:00Z'))).toEqual([]);
  });
});
