import { describe, it, expect, beforeEach } from 'vitest';
import { parsePricingFromHtml, resolveModelName, buildAliasMap, setCachedModelsForTest } from '../src/utils/models.js';
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

// ── 短别名重映射（buildAliasMap / resolveModelName）──────────────────────────
//
// 背景：目录里同时有短别名（`qwen-3.7-max`）与规范条目（`Qwen/Qwen3.7-Max`），上游
// 只认后者——别名透传过去一律 403 `Model/provider not recognized`（实测 11 个别名
// 全部如此）。判别信号完全取自目录：别名条目的 owned_by 回指自身，规范条目不是。
//
// 关键在于重映射必须排在**精确匹配之前**：别名本身就在目录里，精确匹配会直接放行，
// 于是又打回上游换来一个 403——这正是修复前的行为。

const ALIAS_CATALOG: ModelItem[] = [
  // 别名：owned_by 回指自身
  { id: 'qwen-3.7-max', object: 'model', created: 0, owned_by: 'qwen-3.7-max', name: 'Qwen 3.7 Max' },
  { id: 'nemotron-3-ultra', object: 'model', created: 0, owned_by: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra' },
  // 同名规范条目：owned_by 是真实 owner
  { id: 'Qwen/Qwen3.7-Max', object: 'model', created: 0, owned_by: 'command-code', name: 'Qwen 3.7 Max' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', object: 'model', created: 0, owned_by: 'command-code', name: 'Nemotron 3 Ultra' },
  // 正常的短 id：owned_by 不是自身，不该被当成别名
  { id: 'gpt-5.6-sol', object: 'model', created: 0, owned_by: 'command-code', name: 'GPT 5.6 Sol' },
  // 带前缀的正常条目：owned_by 与 id 前缀一致，同样不是别名
  { id: 'deepseek/deepseek-v4-pro', object: 'model', created: 0, owned_by: 'deepseek', name: 'DeepSeek V4 Pro' },
];

describe('buildAliasMap — 只认 owned_by 回指自身的同名条目', () => {
  it('把别名映射到同名规范条目（不依赖硬编码的模型名）', () => {
    const map = buildAliasMap(ALIAS_CATALOG);
    expect(map.get('qwen-3.7-max')).toBe('Qwen/Qwen3.7-Max');
    expect(map.get('nemotron-3-ultra')).toBe('nvidia/nemotron-3-ultra-550b-a55b');
  });

  it('正常的短 id 与带前缀条目都不进映射表', () => {
    const map = buildAliasMap(ALIAS_CATALOG);
    expect(map.has('gpt-5.6-sol')).toBe(false);
    expect(map.has('deepseek/deepseek-v4-pro')).toBe(false);
    expect(map.has('Qwen/Qwen3.7-Max')).toBe(false);
  });

  it('同名条目多于两个时不做猜测（宁可让上游报准确错误）', () => {
    const ambiguous: ModelItem[] = [
      { id: 'x-1', object: 'model', created: 0, owned_by: 'x-1', name: 'Dup' },
      { id: 'a/x', object: 'model', created: 0, owned_by: 'command-code', name: 'Dup' },
      { id: 'b/x', object: 'model', created: 0, owned_by: 'command-code', name: 'Dup' },
    ];
    expect(buildAliasMap(ambiguous).size).toBe(0);
  });

  it('缺少 name 或 name 为空时不参与映射', () => {
    const noName: ModelItem[] = [
      { id: 'a-1', object: 'model', created: 0, owned_by: 'a-1' } as ModelItem,
      { id: 'p/a', object: 'model', created: 0, owned_by: 'command-code', name: '  ' },
    ];
    expect(buildAliasMap(noName).size).toBe(0);
  });
});

describe('resolveModelName — 别名重映射优先于精确匹配', () => {
  beforeEach(() => setCachedModelsForTest(ALIAS_CATALOG));

  it('请求短别名时改写为上游认可的规范 id', () => {
    expect(resolveModelName('qwen-3.7-max')).toBe('Qwen/Qwen3.7-Max');
    expect(resolveModelName('nemotron-3-ultra')).toBe('nvidia/nemotron-3-ultra-550b-a55b');
  });

  it('请求规范 id 时保持原样', () => {
    expect(resolveModelName('Qwen/Qwen3.7-Max')).toBe('Qwen/Qwen3.7-Max');
  });

  it('不带别名的正常 id 不受影响', () => {
    expect(resolveModelName('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveModelName('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
  });
});
