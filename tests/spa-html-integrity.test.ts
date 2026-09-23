// =============================================================================
// 结构回归防线：public/index.html 的标记完整性。
// -----------------------------------------------------------------------------
// SPA 被 eslint 有意排除（eslint.config.js 的 ignores: ['public/**']），也没有构建
// 步骤，所以"改坏了 HTML"这件事此前没有任何工具会拦。这不是假想风险：本仓库给
// 弹窗批量补 for= 属性时，就产出过
//     <label class="text-xs ..."for="loginNickname" class="text-xs ...">
// 这种"引号后紧跟属性名 + 属性重复"的畸形标记，全靠人工复查才发现。
//
// a11y / apiJson 那两条测试都靠同样的批量脚本落地，因此这里补上最低限度的守门：
// 属性粘连、同一标签内属性重复、标签配平。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');

/** 去掉 <script>/<style>/注释：只检查静态标记，JS 模板字符串里的 HTML 由别处守卫。 */
function staticMarkup(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '');
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);

interface ParsedTag { name: string; attrs: string[]; closing: boolean; selfClose: boolean }

/** 引号感知的起始标签扫描：拿到标签名与其属性名列表。 */
function parseTags(src: string): ParsedTag[] {
  const out: ParsedTag[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') { i++; continue; }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(src.slice(i));
    if (!m) { i++; continue; }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    let j = i + m[0].length;
    const attrs: string[] = [];
    let selfClose = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '>') { j++; break; }
      if (c === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
      if (/\s/.test(c)) { j++; continue; }
      let k = j;
      while (k < src.length && !/[\s=>]/.test(src[k])) k++;
      const attrName = src.slice(j, k).toLowerCase();
      if (attrName) attrs.push(attrName);
      let p = k;
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] === '=') {
        let q = p + 1;
        while (q < src.length && /\s/.test(src[q])) q++;
        const quote = src[q];
        if (quote === '"' || quote === "'") {
          const end = src.indexOf(quote, q + 1);
          j = end < 0 ? src.length : end + 1;
        } else {
          j = q; // 无引号值
          while (j < src.length && !/[\s>]/.test(src[j])) j++;
        }
      } else {
        j = k;
      }
    }
    out.push({ name, attrs, closing, selfClose });
    i = j;
  }
  return out;
}

const GLUED_ATTR = /"(?:id|class|for|role|style|title|type|value|aria-[a-z-]+|data-[a-z-]+|on[a-z]+)=/;

function findGlued(src: string): number[] {
  const bad: number[] = [];
  const tags = /<[^>]+>/g;
  let m: RegExpExecArray | null;
  while ((m = tags.exec(src))) {
    if (GLUED_ATTR.test(m[0])) bad.push(src.slice(0, m.index).split('\n').length);
  }
  return bad;
}

function findDuplicateAttrs(src: string): string[] {
  const bad: string[] = [];
  for (const t of parseTags(src)) {
    if (t.closing || VOID_TAGS.has(t.name)) continue;
    const seen = new Set<string>();
    for (const a of t.attrs) {
      if (seen.has(a)) { bad.push(`<${t.name} ... ${a}=`); break; }
      seen.add(a);
    }
  }
  return bad;
}

function findUnbalanced(src: string): string[] {
  const stack: string[] = [];
  const problems: string[] = [];
  for (const t of parseTags(src)) {
    if (VOID_TAGS.has(t.name) || t.selfClose) continue;
    if (t.closing) {
      const top = stack.pop();
      if (top !== t.name) problems.push(`</${t.name}> 与 <${top ?? 'nothing'}> 不匹配`);
      if (top && top !== t.name) stack.push(top);
    } else {
      stack.push(t.name);
    }
  }
  for (const leftover of stack) problems.push(`<${leftover}> 未闭合`);
  return problems;
}

describe('自检：探测器本身要能抓到已知缺陷', () => {
  // 没有这条，上面的检测器哪天退化成"什么都不报"也不会有人发现。
  // 用的就是本仓库真实产出过的畸形标记。
  const BROKEN = '<div><label class="text-xs"for="x" class="text-xs">昵称</label><span></div>';
  it('能抓到引号后粘连的属性', () => {
    expect(findGlued(BROKEN).length).toBe(1);
  });
  it('能抓到同一标签内重复的属性', () => {
    expect(findDuplicateAttrs(BROKEN)).toContain('<label ... class=');
  });
  it('能抓到未闭合的标签', () => {
    expect(findUnbalanced(BROKEN).length).toBeGreaterThan(0);
  });
  it('对合法标记不误报', () => {
    const OK = '<div><label for="x" class="a b">昵称</label><input id="x" type="text"><br></div>';
    expect(findGlued(OK)).toEqual([]);
    expect(findDuplicateAttrs(OK)).toEqual([]);
    expect(findUnbalanced(OK)).toEqual([]);
  });
});

describe('public/index.html 的静态标记', () => {
  const body = staticMarkup(html);

  it('取到的静态标记规模合理（防止剥离规则失效后变成空断言）', () => {
    expect(body).toContain('<body');
    expect(body).toContain('<label');
    expect((body.match(/<label/g) || []).length).toBeGreaterThan(0);
  });

  it('没有引号后紧跟属性名的粘连写法', () => {
    const bad = findGlued(body);
    expect(bad, `第 ${bad.join(', ')} 行附近有 "attr=" 粘连`).toEqual([]);
  });

  it('没有同一个标签内重复的属性', () => {
    expect(findDuplicateAttrs(body)).toEqual([]);
  });

  it('标签配平', () => {
    expect(findUnbalanced(body), '静态标记存在未闭合/错配标签').toEqual([]);
  });
});
