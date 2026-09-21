// =============================================================================
// P1-3 回归：仪表盘 badge() 必须转义 text。
// -----------------------------------------------------------------------------
// badge() 的 title 参数走了 esc()，text 却被裸拼进 innerHTML；调用点把上游定价页
// 抓来的字段（m.deal.discountPercent）直接当 text 传进来。全站没有 CSP 兜底。
//
// 这里不用正则读源码，而是把 index.html 里**真实的** badge/esc/BADGE_TONES 源码片段
// 取出来执行 —— 沿用 dashboard-spa.test.ts 已有的 new Function 手法，这样改动实现
// （比如换变量名）不会让测试假失败，但删掉 esc 一定会。
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
  throw new Error(`unbalanced braces in ${name}`);
}

const tones = extractConstObject(html, 'BADGE_TONES');
const badgeSrc = extractFn(html, 'badge');

// esc 是箭头函数（index.html:393），必须按声明式取。取不到就直接抛——
// 绝不退化成恒等函数：本测试初版就是这么写的，结果"未转义"是测试自己造的假阳性。
const escDecl = html.match(/^const esc = .+$/m)?.[0];
if (!escDecl) throw new Error('const esc = ... not found in public/index.html');

const badge: (text: unknown, tone: string, title?: string) => string =
  new Function(`${tones}\n${escDecl}\n${badgeSrc}\nreturn badge;`)();

describe('badge() HTML 转义（P1-3）', () => {
  it('text 里的标签定界符被转义，payload 只以转义形式出现', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const out = badge(payload, 'amber');

    // 危险的是尖括号，不是 "onerror=" 这个字面子串 —— 定界符转义后它就是纯文本。
    expect(out).not.toContain('<img');
    expect(out).not.toContain('alert(1)>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('保留正常纯文本渲染，且外层结构仍是 span', () => {
    const out = badge('DEAL 50%', 'amber');
    expect(out.startsWith('<span')).toBe(true);
    expect(out).toContain('DEAL 50%');
  });

  it('title 仍然被转义（原有防御不能回退）', () => {
    const out = badge('ok', 'slate', '" onload="alert(1)');
    expect(out).not.toContain('onload="alert');
    expect(out).toContain('&quot;');
  });
});
