import { describe, it, expect, beforeEach } from 'vitest';
import { parsePricingFromHtml, resolveModelName, setCachedModelsForTest } from '../src/utils/models.js';
import type { ModelItem } from '../src/types/index.js';

// ── 定价页 RSC payload 解析（parsePricingFromHtml）────────────────────────────
//
// 解析器是全仓库最脆弱的一环：手写 self.__next_f.push 分块解码 + 括号配平。
// 官方页面结构变化时它会静默失效（只留 warn 日志），因此用合成 fixture 把
// 期望的页面契约锁进测试：官方改版导致这里变红，就说明需要更新解析器。

/** 把 flight 对象包装成 App Router 风格的 HTML（拆两个 __next_f 块，覆盖拼接路径）。 */
function rscPage(flightObj: unknown): string {
  const flight = JSON.stringify(flightObj);
  const mid = Math.floor(flight.length / 2);
  const asLiteral = (s: string) => JSON.stringify(s).slice(1, -1);
  return (
    '<html><body><script>self.__next_f.push([1,"' + asLiteral(flight.slice(0, mid)) + '"])</script>' +
    '<script>self.__next_f.push([1,"' + asLiteral(flight.slice(mid)) + '"]);</script></body></html>'
  );
}

const PRICING_ROWS = {
  rows: [
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      category: 'flagship',
      contextWindow: 128000,
      caps: { vision: false, reasoning: true },
      deal: { discountPercent: 20 },
      tip: 'off-peak discount applies',
      availability: { 'individual-go': true, 'teams-pro': false, all: true },
      tiers: [{ rates: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 } }],
      timeOfDay: {
        peak: { input: 0.3, output: 1.2 },
        offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
        windows: '01-04 & 06-10 UTC, Mon-Fri',
        peakHoursPerDay: 7,
      },
    },
    {
      // 只有 all=true：按 plans.ts 的约定不视为 Go 可用
      id: 'mystery/model-x',
      name: 'Model X',
      availability: { all: true },
      tiers: [{ rates: { input: 1, output: 2 } }],
    },
    { nope: true }, // 缺 id 的行必须被跳过而不是抛错
  ],
};

describe('parsePricingFromHtml', () => {
  it('extracts rows split across multiple __next_f chunks', () => {
    const entries = parsePricingFromHtml(rscPage(PRICING_ROWS));
    expect(entries.map(e => e.id)).toEqual(['deepseek/deepseek-v4-pro', 'mystery/model-x']);
  });

  it('parses static pricing including cache rates', () => {
    const [ds] = parsePricingFromHtml(rscPage(PRICING_ROWS));
    expect(ds.pricing).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 });
    expect(ds.contextWindow).toBe(128000);
    expect(ds.caps).toEqual({ vision: false, reasoning: true });
    expect(ds.deal).toEqual({ discountPercent: 20 });
  });

  it('keeps both peak and off-peak time-of-day rates', () => {
    // 回归：早期解析器只取 tiers[0].rates，峰时价被丢弃导致成本低估一半
    const [ds] = parsePricingFromHtml(rscPage(PRICING_ROWS));
    expect(ds.timeOfDay?.peak?.input).toBe(0.3);
    expect(ds.timeOfDay?.offPeak?.input).toBe(0.15);
    expect(ds.timeOfDay?.windows).toBe('01-04 & 06-10 UTC, Mon-Fri');
    expect(ds.timeOfDay?.peakHoursPerDay).toBe(7);
  });

  it('derives onGoPlan only from an explicit plan key, never from "all"', () => {
    const [ds, mx] = parsePricingFromHtml(rscPage(PRICING_ROWS));
    expect(ds.onGoPlan).toBe(true);
    expect(ds.availability).toEqual({ 'individual-go': true, 'teams-pro': false, all: true });
    expect(mx.onGoPlan).toBe(false);
  });

  it('returns empty for a page without the RSC payload or rows marker', () => {
    expect(parsePricingFromHtml('<html>completely different page</html>')).toEqual([]);
    expect(parsePricingFromHtml(rscPage({ other: 1 }))).toEqual([]);
  });
});

// ── 模糊模型名解析（resolveModelName）────────────────────────────────────────
//
// 匹配优先级：精确 → 前缀剥离 → 后缀/名称 → 部分包含 → 家族规则 → 原样透传。
// 表驱动锁定该契约，防止重构时静默改变映射行为。

const CATALOG: ModelItem[] = [
  { id: 'claude-sonnet-5', object: 'model', created: 0, owned_by: 'command-code', name: 'Claude Sonnet 5' },
  { id: 'gpt-5.6-sol', object: 'model', created: 0, owned_by: 'command-code', name: 'GPT 5.6 Sol' },
  { id: 'google/gemini-3.6-flash', object: 'model', created: 0, owned_by: 'google', name: 'Gemini 3.6 Flash' },
  { id: 'deepseek/deepseek-v4-pro', object: 'model', created: 0, owned_by: 'deepseek', name: 'DeepSeek V4 Pro' },
];

describe('resolveModelName', () => {
  beforeEach(() => setCachedModelsForTest(CATALOG));

  const cases: Array<[string, string, string]> = [
    // [请求名, 期望解析结果, 场景说明]
    ['claude-sonnet-5', 'claude-sonnet-5', '精确命中'],
    ['google/gemini-3.6-flash', 'google/gemini-3.6-flash', '带厂商前缀的精确命中'],
    ['openai:gpt-5.6-sol', 'gpt-5.6-sol', '剥离命名空间前缀'],
    ['custom/deepseek-v4-pro', 'deepseek/deepseek-v4-pro', '未知前缀回退到后缀匹配'],
    ['Claude Sonnet 5', 'claude-sonnet-5', '按展示名匹配'],
    ['sonnet', 'claude-sonnet-5', '部分包含'],
    ['gpt-4-turbo', 'gpt-5.6-sol', '家族规则回退'],
    ['gemini flash', 'google/gemini-3.6-flash', '家族关键字（gemini 优先于 flash）'],
  ];

  for (const [requested, expected, label] of cases) {
    it(`resolves '${requested}' -> '${expected}' (${label})`, () => {
      expect(resolveModelName(requested)).toBe(expected);
    });
  }

  it('passes unknown models through as-is instead of substituting a default', () => {
    // 上游会对未知模型给出准确错误；静默替换成默认模型会让用户收到从未请求过的模型名
    expect(resolveModelName('totally-made-up-model')).toBe('totally-made-up-model');
  });

  it('falls back to the first catalog entry for empty input', () => {
    expect(resolveModelName('')).toBe('claude-sonnet-5');
    expect(resolveModelName(undefined as any)).toBe('claude-sonnet-5');
  });
});
