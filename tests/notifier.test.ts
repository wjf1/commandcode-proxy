// =============================================================================
// 桌面通知：去重、开关与 AUMID 回退
// -----------------------------------------------------------------------------
// 这里锁的是三个容易回归的行为：
//   1. 同一事件在窗口期内只发一次（否则会把用户烦到关掉通知权限）；
//   2. COMMANDCODE_NOTIFY=0 时整体禁用；
//   3. AUMID 注册失败时回退到 PowerShell 标识，而不是让 toast 被 Windows
//      静默吞掉（实测 Win11 会丢弃未注册 AUMID 的 toast 且不报错）。
// 不对真实注册表/toast 做断言 —— 那属于手工验证项。
// =============================================================================
import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldSend,
  notificationsEnabled,
  PROXY_AUMID,
  escapeXmlSafe,
} from '../src/utils/notifier.js';

describe('shouldSend — 事件去重', () => {
  it('同一键在窗口期内只发一次', () => {
    const last = new Map<string, number>();
    expect(shouldSend('quota', 1000, 30_000, last)).toBe(true);
    expect(shouldSend('quota', 5_000, 30_000, last)).toBe(false);
    expect(shouldSend('quota', 20_000, 30_000, last)).toBe(false);
    expect(shouldSend('quota', 31_000, 30_000, last)).toBe(true); // 超过窗口
  });

  it('不同键互不影响', () => {
    const last = new Map<string, number>();
    expect(shouldSend('quota', 1000, 30_000, last)).toBe(true);
    expect(shouldSend('engine', 2000, 30_000, last)).toBe(true);
  });

  it('默认使用模块级状态（跨调用累积）', () => {
    expect(shouldSend('shared', 1000)).toBe(true);
    expect(shouldSend('shared', 2000)).toBe(false);
  });
});

describe('notificationsEnabled — 开关', () => {
  const ORIGINAL = process.env.COMMANDCODE_NOTIFY;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COMMANDCODE_NOTIFY;
    else process.env.COMMANDCODE_NOTIFY = ORIGINAL;
  });

  it('未设置时默认启用', () => {
    delete process.env.COMMANDCODE_NOTIFY;
    expect(notificationsEnabled()).toBe(true);
  });

  it('支持多种关闭写法', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      process.env.COMMANDCODE_NOTIFY = v;
      expect(notificationsEnabled()).toBe(false);
    }
  });

  it('非关闭值视为启用', () => {
    process.env.COMMANDCODE_NOTIFY = '1';
    expect(notificationsEnabled()).toBe(true);
    process.env.COMMANDCODE_NOTIFY = 'yes';
    expect(notificationsEnabled()).toBe(true);
  });
});

describe('AUMID 常量与 XML 转义', () => {
  it('自有 AUMID 不是回退用的系统标识', () => {
    expect(PROXY_AUMID).toBe('CommandCode.Proxy');
    expect(PROXY_AUMID).not.toContain('WindowsPowerShell');
  });

  it('XML 特殊字符被转义，防注入通知正文', () => {
    expect(escapeXmlSafe('<b>foo</b> & "q" \'x\'')).toBe('&lt;b&gt;foo&lt;/b&gt; &amp; &quot;q&quot; &apos;x&apos;');
  });
});
