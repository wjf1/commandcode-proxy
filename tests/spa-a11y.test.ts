// =============================================================================
// 结构回归防线：仪表盘的无障碍基线。
// -----------------------------------------------------------------------------
// 这个面板此前是"零无障碍"：aria-* / role= / scope= / tabindex 全部为 0，
// 48 个装饰性 Font Awesome 图标没有 aria-hidden（读屏把 "fa-gauge-high 概览" 念出来），
// 标签页只切 CSS class（读屏无法知道当前在哪个分区），三个弹窗没有 role=dialog 也没有
// 焦点约束（Tab 能穿到弹窗背后继续点按钮），两个 <label> 没有 for（点标签不能聚焦输入框）。
//
// 没有构建步骤的单文件里，这类东西极易在新增区块时再次漏掉，所以按"计数"锁死。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');
const count = (re) => (html.match(re) || []).length;

describe('装饰性图标', () => {
  it('每个 Font Awesome 图标都带 aria-hidden', () => {
    const icons = count(/<i class="fa/g) + count(/<i aria-hidden="true" class="fa/g);
    expect(icons, '图标总数不应为 0，否则本条断言是空的').toBeGreaterThan(40);
    expect(count(/<i class="fa/g), '有图标漏了 aria-hidden').toBe(0);
    expect(count(/<i aria-hidden="true" class="fa/g)).toBe(icons);
  });

  it('状态圆点这类纯视觉指示器也被隐藏', () => {
    expect(html).toMatch(/<span id="statusDot" aria-hidden="true"/);
  });
});

describe('表格', () => {
  it('每个 <th> 都有 scope', () => {
    const th = count(/<th[ >]/g);
    expect(th).toBeGreaterThan(10);
    expect(count(/<th scope="col"/g), '有表头漏了 scope').toBe(th);
  });
});

describe('标签页', () => {
  it('tablist / tab / tabpanel 三者齐备且互相指向', () => {
    expect(html).toMatch(/<nav[^>]*role="tablist"/);
    const tabs = ['overview', 'accounts', 'usage', 'models', 'logs'];
    for (const t of tabs) {
      expect(html, `tab-${t} 缺少 tab 语义`)
        .toMatch(new RegExp(`id="tab-${t}" role="tab" aria-selected="(true|false)" aria-controls="content-${t}"`));
      expect(html, `content-${t} 缺少 tabpanel 语义`)
        .toMatch(new RegExp(`id="content-${t}" role="tabpanel" tabindex="0" aria-labelledby="tab-${t}"`));
    }
  });

  it('switchTab 同步 aria-selected 与 tabindex', () => {
    const fn = html.slice(html.indexOf('function switchTab(tab)'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(body).toContain("setAttribute('aria-selected'");
    expect(body).toContain('b.tabIndex = on ? 0 : -1');
  });

  it('标签栏有方向键处理', () => {
    expect(html).toMatch(/role="tablist"\]'\)\.addEventListener\('keydown'/);
    expect(html).toContain("e.key === 'ArrowRight'");
  });
});

describe('弹窗', () => {
  it('三个弹窗都有 dialog 语义与无障碍名称', () => {
    for (const id of ['loginModal', 'confirmModal', 'adminKeyModal']) {
      expect(html, `${id} 缺少 role/aria-modal/aria-label`)
        .toMatch(new RegExp(`<div id="${id}" role="dialog" aria-modal="true" aria-label="[^"]+"`));
    }
    // 只数元素上的属性；JS 里的 `[role="dialog"]` 选择器字面量不该被算进来
    expect(count(/<div[^>]*role="dialog"/g)).toBe(3);
  });

  it('存在焦点约束，且关闭后把焦点还给触发元素', () => {
    expect(html).toMatch(/e\.key !== 'Tab'/);            // Tab 圈在弹窗内
    expect(html).toContain("attributeFilter: ['class']"); // 打开时焦点移入弹窗
    // 归还焦点必须在 showLoginModal 里**同步**记录：MutationObserver 回调跑在微任务，
    // 那时弹窗内部的 focus() 已经执行，读 activeElement 会拿到即将被隐藏的元素（实测）。
    const show = html.slice(html.indexOf('function showLoginModal()'), html.indexOf('function hideLoginModal()'));
    expect(show.indexOf('modalReturnFocus = document.activeElement'))
      .toBeLessThan(show.indexOf("classList.remove('hidden')"));
    const hide = html.slice(html.indexOf('function hideLoginModal()'), html.indexOf('async function submitLogin'));
    expect(hide).toContain('back.focus()');
  });
});

describe('实时区域与表单控件', () => {
  it('toast 与引擎状态有 live region', () => {
    expect(html).toMatch(/<div id="toastBox" role="status" aria-live="polite"/);
    expect(html).toMatch(/<span id="statusText" role="status" aria-live="polite"/);
  });

  it('每个 <label> 都绑定到控件', () => {
    const labels = count(/<label /g);
    expect(labels).toBeGreaterThan(0);
    expect(count(/<label for="/g), '有 label 漏了 for').toBe(labels);
  });

  it('只有 placeholder 的控件补了无障碍名称', () => {
    expect(html).toMatch(/<input id="modelSearch"[^>]*aria-label="[^"]+"/);
    expect(html).toMatch(/<select id="rotationSelect" aria-label="[^"]+"/);
    expect(html).toMatch(/<select id="usageAccountSelect" aria-label="[^"]+"/);
  });

  it('纯图标按钮都有 aria-label', () => {
    expect(html).toMatch(/<button id="modelSearchClear" aria-label="[^"]+"/);
    // 账号卡片里的删除按钮：内容只有一个 aria-hidden 的图标
    expect(html).toMatch(/data-action="delete" aria-label="[^"]+"/);
  });
});
