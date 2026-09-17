import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');

// 仪表盘 SPA 是纯 <script>（不经编译直接进浏览器）。历史上混入过 TypeScript
// 的 `as` 断言导致整个脚本块在浏览器里 SyntaxError——用本测试锁死：
// 内联脚本必须能作为纯 JavaScript 解析。
describe('dashboard SPA (public/index.html)', () => {
  it('inline script parses as plain JavaScript (no TypeScript syntax)', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) {
      expect(() => new Function(code)).not.toThrow();
    }
  });

  it('every statically referenced element id exists in the HTML', () => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const referenced = new Set(
      [...script.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
    );
    const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const missing = [...referenced].filter(id => !defined.has(id));
    expect(missing).toEqual([]);
  });

  it('every onclick handler references a function defined in the script', () => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const onclicks = new Set(
      [...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]),
    );
    expect(onclicks.size).toBeGreaterThan(0);
    const missing = [...onclicks].filter(fn => !new RegExp('function\\s+' + fn + '\\b').test(script));
    expect(missing).toEqual([]);
  });

  it('does not reference external CDNs (assets are localized)', () => {
    expect(html).not.toMatch(/https?:\/\/cdn\.|https?:\/\/cdnjs\.cloudflare\.com|https?:\/\/cdn\.jsdelivr\.net/);
  });

  // 模型卡片必须能把 GO 与 GOAT 两个档位分开标注：只看 onGoPlan 会让
  // GOAT-only 的模型（如 gpt-5.6-sol）显示成没有档位区别的「可用」。
  it('renders both GO and GOAT plan badges from the per-plan availability map', () => {
    expect(html).toMatch(/data-tag="goat"/);
    expect(html).toMatch(/isPlanOn\(m, 'individual-go'\)/);
    expect(html).toMatch(/isPlanOn\(m, 'individual-goat'\)/);
    expect(html).toMatch(/planPill\('individual-go'/);
    expect(html).toMatch(/planPill\('individual-goat'/);
    expect(html).not.toMatch(/if \(m\.onGoPlan\) tags \+=/);
  });
});
