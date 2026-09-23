// =============================================================================
// 回归防线：仪表盘模型搜索的两个纯函数，从 public/index.html 里取出**真实源码**执行
// （与 spa-badge-escape.test.ts 同一手法），避免测试与页面各说一套。
// -----------------------------------------------------------------------------
// 1. `modelMatchesQuery` / `highlightHit` 里的分词正则写成 /s+/（少一个反斜杠），
//    于是"按空白切分"实际是"按字面字母 s 切分"：
//      - 多词查询被从单词中间切断 → 'claude anthropic' 切成 ['claude an','thropic']，
//        永远匹配不上，搜索框看起来半坏；
//      - 纯 s 的查询切成空数组 → Array.prototype.every 对空数组恒为 true →
//        搜 's' 会命中**所有**模型，包括名字里根本没有 s 的。
// 2. highlightHit 的转义写成 '\$&'（JS 字符串里就是 $&），等于完全没转义，
//    且字符类里漏了反斜杠：含 ( 的查询会把高亮打在错误的字符上，含 \ 的查询
//    让 new RegExp 抛错并被 catch 吞掉 → 高亮静默失效。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');

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

/** 取出单行的 `const NAME = ...;` 声明（页面里的 esc 是箭头函数，不是 function 声明）。 */
function extractArrowConst(src: string, name: string): string {
  const line = src.split('\n').map(l => l.trim()).find(l => l.startsWith(`const ${name} =`));
  if (!line) throw new Error(`const ${name} not found in public/index.html`);
  return line;
}

function loadFn(name: string, deps: Record<string, unknown> = {}) {
  const keys = Object.keys(deps);
  return new Function(...keys, `${extractFn(html, name)}; return ${name};`)(...keys.map(k => deps[k]));
}

const esc = new Function(`${extractArrowConst(html, 'esc')}; return esc;`)() as (s: unknown) => string;
const modelMatchesQuery = loadFn('modelMatchesQuery') as (m: unknown, q: string) => boolean;
const highlightHit = loadFn('highlightHit', { esc }) as (t: string, q: string) => string;

const SONNET = { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', owned_by: 'anthropic' };
// 整个 haystack 里不含字母 s，用来暴露"空 token 数组恒真"
const GPT_NO_S = { id: 'openai/gpt-5-mini', name: 'GPT 5 Mini', owned_by: 'openai' };

describe('模型搜索分词', () => {
  it('单词查询命中', () => {
    expect(modelMatchesQuery(SONNET, 'claude')).toBe(true);
    expect(modelMatchesQuery(SONNET, 'nope')).toBe(false);
  });

  it('多词查询按空白切分并取交集', () => {
    // 旧写法切成 ['claude an','thropic']，这条必然 false
    expect(modelMatchesQuery(SONNET, 'claude anthropic')).toBe(true);
    expect(modelMatchesQuery(SONNET, 'claude zzznope')).toBe(false);
  });

  it('查询里全是分隔字符时不得命中一切', () => {
    // 旧写法 split(/s+/) 得到 ['',''] → filter(Boolean) → [] → every 恒 true
    expect(modelMatchesQuery(GPT_NO_S, 's')).toBe(false);
    expect(modelMatchesQuery(GPT_NO_S, 'ss')).toBe(false);
    // 纯空白同样应当作"无查询条件"，与空串一致地放行
    expect(modelMatchesQuery(GPT_NO_S, '   ')).toBe(true);
  });
});

describe('命中高亮的转义', () => {
  it('括号按字面匹配，不当成捕获组', () => {
    expect(highlightHit('a(b)c', '(b)')).toBe('a<mark>(b)</mark>c');
  });

  it('反斜杠查询不会让高亮静默失效', () => {
    // 旧写法不把 \ 转义 → new RegExp('\\') 抛错 → catch 里返回原文，一个 mark 都没有
    expect(highlightHit('C:\\tmp\\x', '\\')).toContain('<mark>');
  });

  it('转义过的实体不会被二次拆开', () => {
    expect(highlightHit('<b>', '<')).toContain('&lt;');
  });
});
