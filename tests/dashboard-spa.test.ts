import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('does not reference external CDNs (assets are localized)', () => {
    expect(html).not.toMatch(/https?:\/\/cdn\.|https?:\/\/cdnjs\.cloudflare\.com|https?:\/\/cdn\.jsdelivr\.net/);
  });
});
