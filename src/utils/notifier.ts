// =============================================================================
// 桌面通知（Windows toast）
// -----------------------------------------------------------------------------
// 面板里的 alert() 只在页面打开时可见，而真正需要用户行动的时刻——额度将耗尽、
// 账号被切走、引擎暂停——往往发生在用户没盯着面板的时候。代理是唯一能看到每次
// 请求的组件，因此由它负责把这些时机推出去。
//
// 设计约束：
//   - 用 PowerShell 原生 toast（Windows.UI.Notifications），不引第三方依赖；
//   - 同一事件做**去重 + 限频**：burnstop 类场景最怕的不是不提醒，而是每 30 秒
//     弹一次把用户烦到直接关掉通知权限；
//   - 通知失败绝不影响代理请求路径（catch 掉，只记日志）；
//   - 进程退出前不留残留子进程（detached + 短超时）。
// =============================================================================
import { spawn } from 'node:child_process';
import { logger } from './logger.js';

/** 同一事件两条通知的最小间隔（毫秒）。 */
const DEDUPE_INTERVAL_MS = 30 * 60 * 1000;

const lastSentAt = new Map<string, number>();

export type NotifyLevel = 'info' | 'warn' | 'critical';

/** 是否启用桌面通知。默认开（只对少数关键事件触发），设 0/false 关闭。 */
export function notificationsEnabled(): boolean {
  const v = process.env.COMMANDCODE_NOTIFY;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

function escapeXml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 发送一条 Windows toast。非 Windows 平台与被禁用时静默跳过。
 *
 * @param key     去重键（同一键在 DEDUPE_INTERVAL_MS 内只发一次）
 * @param title   通知标题
 * @param body    通知正文
 * @param level   严重级别，仅用于日志分类，不影响展示
 * @returns 是否真正发出（false = 被去重/禁用/失败）
 */
export function notify(key: string, title: string, body: string, level: NotifyLevel = 'info'): boolean {
  if (!notificationsEnabled()) return false;
  if (process.platform !== 'win32') return false;

  const now = Date.now();
  const prev = lastSentAt.get(key);
  if (prev !== undefined && now - prev < DEDUPE_INTERVAL_MS) return false;
  lastSentAt.set(key, now);

  // PowerShell 内联脚本：不走 shell 拼接，参数经 XML 转义后内插。
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
    `$t = $xml.GetElementsByTagName('text')`,
    `$t.Item(0).AppendChild($xml.CreateTextNode('${escapeXml(title)}')) | Out-Null`,
    `$t.Item(1).AppendChild($xml.CreateTextNode('${escapeXml(body)}')) | Out-Null`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CommandCode Proxy').Show($toast)`,
  ].join('; ');

  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // 不阻塞请求路径：失败只记日志。
    child.on('error', (err) => logger.warn(`[NOTIFY] toast spawn failed: ${err.message}`));
    const timer = setTimeout(() => child.kill(), 15000);
    timer.unref?.();
    child.unref();
    logger.info(`[NOTIFY] ${level}: ${title} — ${body}`);
    return true;
  } catch (err: any) {
    logger.warn(`[NOTIFY] failed: ${err?.message || err}`);
    return false;
  }
}

/** 测试用：清空去重状态。 */
export function resetNotifyState(): void {
  lastSentAt.clear();
}
