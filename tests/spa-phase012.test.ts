// =============================================================================
// 可视化界面三期改造（Phase 0/1/2）的回归防线。
// -----------------------------------------------------------------------------
// 手法与 spa-search-functions / spa-badge-escape 一致：从 public/index.html 取出
// **真实源码**执行（new Function），避免测试与页面各说一套。
//
// 覆盖点：
// - Phase 0 语义色板：:root 变量定义、卡片类收口（.card/.inset-card）、body 收口；
//   统一空状态 emptyState 与骨架屏函数；窄屏表格 .tbl-min。
// - Phase 1 概览今日指标卡 id、账号额度徽标 quotaBadge（缺失数据不误报）。
// - Phase 2 用量表过滤/排序纯函数（默认零状态）、过滤栏默认折叠、
//   模型家族 modelFamily、日志高亮 logHighlight（先 esc 后着色，XSS 红线）。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');

/** 按大括号配平取出一个顶层 `function name(...) { ... }` 源码。 */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in public/index.html`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** 取出单行的 `const NAME = ...;` 声明。 */
function extractArrowConst(src: string, name: string): string {
  const line = src.split('\n').map(l => l.trim()).find(l => l.startsWith(`const ${name} =`));
  if (!line) throw new Error(`const ${name} not found in public/index.html`);
  return line;
}

/** 取出 `const NAME = { ... };` 对象字面量声明。 */
function extractConstObject(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`const ${name} not found in public/index.html`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, src.indexOf(';', i) + 1);
    }
  }
  throw new Error(`unbalanced braces in const ${name}`);
}

function loadFn(name: string, deps: Record<string, unknown> = {}) {
  const keys = Object.keys(deps);
  return new Function(...keys, `${extractFn(html, name)}; return ${name};`)(...keys.map(k => deps[k]));
}

const esc = new Function(`${extractArrowConst(html, 'esc')}; return esc;`)() as (s: unknown) => string;
const emptyState = loadFn('emptyState', { esc }) as (icon: string, text: string, colSpan?: number) => string;
const logHighlight = (() => {
  const reDecl = extractArrowConst(html, 'LOG_TOKEN_RE');
  const re = new Function(`${reDecl}; return LOG_TOKEN_RE;`)() as RegExp;
  return new Function('esc', 'LOG_TOKEN_RE', `${extractFn(html, 'logHighlight')}; return logHighlight;`)(esc, re) as (s: string) => string;
})();
const modelFamily = loadFn('modelFamily') as (m: unknown) => string;
const usageMatchesQuery = loadFn('usageMatchesQuery') as (r: unknown, q: string) => boolean;
const usageRowKey = loadFn('usageRowKey') as (r: unknown) => string;
// sortUsageRows 读写全局 usageSortKey/usageSortDir：以参数注入等价闭包。
const makeSortUsageRows = () => new Function('usageSortKey', 'usageSortDir', `${extractFn(html, 'sortUsageRows')}; return sortUsageRows;`);
const usageDetailHtml = loadFn('usageDetailHtml', { esc, fmtTokens: (n: number) => String(n), projectDisplayName: (p: string) => p }) as (r: unknown) => string;
const badge = loadFn('badge', { BADGE_TONES: new Function(`${extractConstObject(html, 'BADGE_TONES')}; return BADGE_TONES;`)(), esc }) as (t: string, tone: string, title?: string) => string;
const quotaBadge = loadFn('quotaBadge', { badge }) as (u: unknown) => string;

const ROW = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-09-24T10:00:00.000Z', model: 'gpt-5.6-sol', inputTokens: 100, outputTokens: 50,
  timingMs: 1200, costUsd: 0.01, status: 'COMPLETED', mode: 'chat', ...over,
});

// ─── Phase 0 ───────────────────────────────────────────────────────────────────

describe('Phase 0 语义色板与结构', () => {
  it(':root 定义了任务要求的核心语义变量', () => {
    for (const v of ['--c-bg', '--c-panel', '--c-text', '--c-accent', '--c-success', '--c-warn', '--c-danger']) {
      expect(html).toContain(v + ':');
    }
  });

  it('卡片类收口为语义 class，且暗色主题默认未变', () => {
    expect(html).toMatch(/\.card\{background:var\(--c-panel\)/);
    expect(html).toMatch(/\.inset-card\{background:var\(--c-inset\)/);
    expect(html).not.toContain('bg-slate-950 text-slate-100'); // body 已收口
    expect(html).toMatch(/<html lang="zh-CN" class="dark">/);   // 暗色默认不变
    expect(html).not.toMatch(/data-theme|theme-toggle|toggleTheme/); // 不引入主题切换
  });

  it('响应式表格降级：窄屏媒体查询下宽表有最小宽度', () => {
    expect(html).toMatch(/@media \(max-width:767px\)/);
    expect(html).toMatch(/\.tbl-min\{min-width:/);
    expect(html).toContain('w-full text-xs text-left tbl-min');
  });

  it('统一空状态：图标 + 中文 + 动态文本转义', () => {
    const out = emptyState('fa-inbox', '暂无数据', 3);
    expect(out).toContain('colspan="3"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('暂无数据');
    const xss = emptyState('fa-inbox', '<img src=x onerror=alert(1)>');
    expect(xss).not.toContain('<img');
    expect(xss).toContain('&lt;img');
  });

  it('骨架屏：卡片/行骨架函数生成 shimmer 占位，仅空容器使用', () => {
    expect(html).toMatch(/@keyframes skelSweep/);
    expect(html).toMatch(/\.skel\{position:relative;overflow:hidden/);
    expect(html).toContain('function showSkeletonIfEmpty(');
    expect(html).toContain('skeletonRows(10, 6)');
  });

  it('toast 保持统一实现，无 alert 残留', () => {
    expect(html).toMatch(/<div id="toastBox" role="status" aria-live="polite"/);
    expect(html).toContain('function showToast(');
    expect(html).not.toMatch(/\balert\(/);
  });
});

// ─── Phase 1 ───────────────────────────────────────────────────────────────────

describe('Phase 1 概览指标与账号徽标', () => {
  it('概览页补齐今日请求/成本与活跃账号卡片（静态 id 存在）', () => {
    for (const id of ['statTodayRuns', 'statTodayCost', 'statActiveAccounts', 'statActiveDetail']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("apiJson('/api/usage/history')"); // 复用既有端点
    expect(html).toContain('function loadOverviewUsage(');
    expect(html).toContain('onclick="refreshOverview()"');   // 刷新状态快捷按钮
  });

  it('quotaBadge：额度分档正确，数据缺失时不显示（不把未知画成正常）', () => {
    expect(quotaBadge({ credits: { windowLimits: { fiveHour: { used: 92, cap: 100 } } } })).toContain('额度告急');
    expect(quotaBadge({ credits: { windowLimits: { fiveHour: { used: 75, cap: 100 } } } })).toContain('额度偏高');
    expect(quotaBadge({ credits: { windowLimits: { fiveHour: { used: 30, cap: 100 } } } })).toContain('额度正常');
    expect(quotaBadge({ credits: { windowLimits: { fiveHour: { used: 0, cap: 0 } } } })).toBe('');
    expect(quotaBadge(null)).toBe('');
    expect(quotaBadge({})).toBe('');
    const warn = quotaBadge({ credits: { windowLimits: { fiveHour: { used: 95, cap: 100 } } } });
    expect(warn).toContain('bg-rose-500/15');
  });

  it('badge 扩展 tone 后仍全部转义 text', () => {
    const tones = new Function(`${extractConstObject(html, 'BADGE_TONES')}; return BADGE_TONES;`)() as Record<string, string>;
    for (const t of ['rose', 'amber', 'slate', 'emerald', 'sky']) expect(tones[t]).toBeTruthy();
    expect(badge('<b>x</b>', 'sky')).not.toContain('<b>');
  });
});

// ─── Phase 2 ───────────────────────────────────────────────────────────────────

describe('Phase 2 用量表过滤 / 排序 / 下钻', () => {
  it('过滤栏默认折叠（details 无 open），新交互不改变首屏', () => {
    expect(html).toMatch(/<details id="usageFilterBar" class="usage-filter">/); // 无 open 属性
    expect(html).toContain('id="usageFilterInput"');
    expect(html).toMatch(/id="usageFilterInput"[^>]*aria-label="[^"]+"/);
  });

  it('排序：默认 key 为空保持后端顺序；点击后按 key 升/降序', () => {
    const rows = [ROW({ costUsd: 0.3 }), ROW({ costUsd: 0.1 }), ROW({ costUsd: 0.2 })];
    expect(makeSortUsageRows()('', -1)(rows).map((r: any) => r.costUsd)).toEqual([0.3, 0.1, 0.2]);
    expect(makeSortUsageRows()('costUsd', -1)(rows).map((r: any) => r.costUsd)).toEqual([0.3, 0.2, 0.1]);
    expect(makeSortUsageRows()('costUsd', 1)(rows).map((r: any) => r.costUsd)).toEqual([0.1, 0.2, 0.3]);
  });

  it('过滤：多词 AND、大小写不敏感、覆盖模型/状态/模式/会话/项目', () => {
    const r = ROW({ model: 'Claude Sonnet', status: 'FAILED', mode: 'messages', sessionId: 'sess-1', project: 'F:/AI/Zcode' });
    expect(usageMatchesQuery(r, '')).toBe(true);
    expect(usageMatchesQuery(r, 'claude')).toBe(true);
    expect(usageMatchesQuery(r, 'claude failed')).toBe(true);
    expect(usageMatchesQuery(r, 'claude ok')).toBe(false);
    expect(usageMatchesQuery(r, 'messages')).toBe(true);
    expect(usageMatchesQuery(r, 'sess-1')).toBe(true);
    expect(usageMatchesQuery(r, 'zcode')).toBe(true);
    expect(usageMatchesQuery(r, 'nope')).toBe(false);
  });

  it('行下钻：详情内容全部转义，行 key 稳定且区分不同行', () => {
    expect(html).toMatch(/function toggleUsageDetail\(/);
    expect(html).toMatch(/tr\[data-key\]/);
    // 键盘下钻：keydown 委托必须用 closest('tr[data-key]') 定位行（e.target 是聚焦的 tr 本身），
    // 不能写成 e.target === tbody（事件冒泡到 tbody 时 target 是 tr，条件恒假导致键盘失效）。
    const bindFn = extractFn(html, 'bindUsageTableOnce');
    expect(bindFn).toContain("closest('tr[data-key]')");
    expect(bindFn).not.toContain('e.target !== body');
    expect(bindFn).toContain("e.key !== 'Enter'");
    const det = usageDetailHtml({ sessionId: '<sess>', project: '<proj>', projectSource: 'heuristic', cacheReadTokens: 5, costSource: 'estimated', estimatedCostUsd: 0.001, timestamp: '<ts>' });
    expect(det).not.toContain('<sess>');
    expect(det).not.toContain('<proj>');
    expect(det).not.toContain('<ts>');
    expect(det).toContain('&lt;sess&gt;');
    const a = ROW(); const b = ROW({ model: 'claude-x' });
    expect(usageRowKey(a)).toBe(usageRowKey({ ...a }));
    expect(usageRowKey(a)).not.toBe(usageRowKey(b));
  });

  it('列头为带 aria-sort 的排序按钮，默认全部 none', () => {
    expect((html.match(/aria-sort="none"/g) || []).length).toBe(6);
    expect((html.match(/onclick="toggleUsageSort\('/g) || []).length).toBe(6);
    expect(html).toMatch(/function toggleUsageSort\(/);
  });
});

describe('Phase 2 模型家族与日志高亮', () => {
  it('modelFamily：category 优先，关键词推断兜底，未知返回空', () => {
    expect(modelFamily({ category: 'flagship', id: 'claude-sonnet-5' })).toBe('flagship');
    expect(modelFamily({ id: 'anthropic/claude-sonnet-5' })).toBe('Claude');
    expect(modelFamily({ id: 'gpt-5.6-sol' })).toBe('GPT');
    expect(modelFamily({ id: 'glm-4.6' })).toBe('GLM');
    expect(modelFamily({ id: 'deepseek-v3', owned_by: 'deepseek' })).toBe('DeepSeek');
    expect(modelFamily({ id: 'unknown-model-x' })).toBe('');
  });

  it('模型卡片右上角出现家族徽章（badge 转义通道）', () => {
    expect(html).toContain("badge(fam, 'sky', '模型家族')");
    expect(html).toContain('const fam = modelFamily(m);');
  });

  it('logHighlight：模型名与错误码着色，普通文本不变', () => {
    expect(logHighlight('claude-sonnet-5 responded')).toContain('<span class="lg-model">claude-sonnet-5</span>');
    expect(logHighlight('HTTP 502 from upstream')).toContain('<span class="lg-err">HTTP 502</span>');
    expect(logHighlight('ECONNREFUSED 127.0.0.1:9090')).toContain('<span class="lg-err">ECONNREFUSED</span>');
    expect(logHighlight('rate limited 429')).toContain('<span class="lg-err">429</span>');
    // 端口号 9090 不以 4/5 开头，不应误标
    expect(logHighlight('listening on 9090')).not.toContain('lg-err');
    expect(logHighlight('plain message')).toBe('plain message');
  });

  it('logHighlight 是 XSS 安全的：先 esc 后着色，无裸标签注入', () => {
    const out = logHighlight('<script>alert(1)</script> claude-sonnet-5');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('lg-model');
  });

  it('日志行带 level 徽章（INFO/WARN/ERROR 着色加粗）', () => {
    expect(html).toContain('lg-lv-err');
    expect(html).toContain('lg-lv-warn');
    expect(html).toContain('lg-lv-info');
    expect(html).toContain("String(l.level || 'info').toUpperCase()");
    expect(html).toContain('logHighlight(l.message)');
  });
});

describe('四大习惯保护', () => {
  it('顶部 Tab 导航与中文界面未变', () => {
    for (const t of ['overview', 'accounts', 'usage', 'models', 'logs']) {
      expect(html).toContain(`id="tab-${t}"`);
    }
    expect(html).toContain('面板概览'); // 中文界面
  });
});
