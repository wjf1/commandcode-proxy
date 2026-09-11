// =============================================================================
// 桌面通知（Windows toast）
// -----------------------------------------------------------------------------
// 面板里的 alert() 只在页面打开时可见，而真正需要用户行动的时刻——额度将耗尽、
// 账号被切走、引擎暂停——往往发生在用户没盯着面板的时候。代理是唯一能看到每次
// 请求的组件，因此由它负责把这些时机推出去。
//
// 设计约束：
//   - 用 PowerShell 原生 toast（Windows.UI.Notifications），不引第三方依赖；
//   - toast 必须以**已注册的应用标识（AUMID）**发出，否则调用成功但 Windows 在
//     展示层静默丢弃（实测 Win11 25H2 如此，且不报任何错）。因此这里把 AUMID
//     注册进 HKCU\Software\Classes\AppUserModelId —— 与豆包/抖音/Steam++ 等
//     应用在本机的注册方式一致，无需管理员权限、无需打包；
//   - AUMID 注册失败时回退到 PowerShell 自身的 AUMID（通知仍能显示，只是
//     发送者显示为 "Windows PowerShell"）；
//   - 同一事件做**去重 + 限频**：burnstop 类场景最怕的不是不提醒，而是每 30 秒
//     弹一次把用户烦到直接关掉通知权限；
//   - 通知失败绝不影响代理请求路径（catch 掉，只记日志）。
// =============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { logger } from './logger.js';

/** 本代理自己的应用标识。注册后通知显示为 "CommandCode Proxy"。 */
export const PROXY_AUMID = 'CommandCode.Proxy';
/** 回退用的系统 AUMID（PowerShell 自身，一定已注册）。 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const REG_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${PROXY_AUMID}`;
/** 同一事件两条通知的最小间隔（毫秒）。 */
const DEDUPE_INTERVAL_MS = 30 * 60 * 1000;
/** 可选的自定义图标（.ico），设置后通知会带图标。 */
const NOTIFY_ICON = process.env.COMMANDCODE_NOTIFY_ICON?.trim() || '';

/** null = 尚未探测；true = 已注册；false = 注册失败（用回退 AUMID）。 */
let aumidState: boolean | null = null;

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

/** 导出别名：通知正文会拼进 PowerShell 内联脚本，转义必须可靠（可测）。 */
export const escapeXmlSafe = escapeXml;

/** 去重判定（独立导出便于测试）。 */
export function shouldSend(key: string, now: number, intervalMs = DEDUPE_INTERVAL_MS, last?: Map<string, number>): boolean {
  const prev = (last ?? lastSentAt).get(key);
  if (prev !== undefined && now - prev < intervalMs) return false;
  (last ?? lastSentAt).set(key, now);
  return true;
}

const lastSentAt = new Map<string, number>();

/**
 * 确保本代理的 AUMID 已注册。幂等；探测结果缓存于进程内。
 * 写 HKCU 不需要管理员权限。失败返回 false（调用方回退到 PowerShell AUMID）。
 */
export function ensureAumidRegistered(): boolean {
  if (aumidState !== null) return aumidState;
  try {
    // 先探测：已存在就不再写，避免每次启动都改注册表。
    const probe = spawnSync('reg', ['query', REG_KEY], { windowsHide: true });
    const exists = probe.status === 0;
    if (!exists) {
      const add = (args: string[]) => spawnSync('reg', ['add', REG_KEY, ...args, '/f'], { windowsHide: true });
      add(['/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'CommandCode Proxy']);
      add(['/v', 'ShowInSettings', '/t', 'REG_DWORD', '/d', '1']);
      if (NOTIFY_ICON) add(['/v', 'IconUri', '/t', 'REG_SZ', '/d', NOTIFY_ICON]);
      const verify = spawnSync('reg', ['query', REG_KEY], { windowsHide: true });
      aumidState = verify.status === 0;
    } else {
      aumidState = true;
    }
  } catch (err: any) {
    logger.warn(`[NOTIFY] AUMID registration failed: ${err?.message || err}`);
    aumidState = false;
  }
  if (aumidState) {
    logger.info(`[NOTIFY] AUMID registered: ${PROXY_AUMID}`);
  } else {
    logger.warn('[NOTIFY] Falling back to the PowerShell AUMID (sender will show as "Windows PowerShell").');
  }
  return aumidState;
}

/** 测试与重注册场景用。 */
export function resetAumidState(): void {
  aumidState = null;
}

// ── 系统级通知开关自诊断 ────────────────────────────────────────────────────
//
// 实测案例：本机 ToastEnabled=0（系统通知总开关关闭）时，toast 在 API 层
// Show() 成功返回、日志也显示已发送，但通知平台在策略层以
// PolicyReason=GlobalSettingDisabled 拒绝（事件 3150），屏幕与通知中心都
// 不会有任何痕迹 —— 且**所有应用**（包括 electron.app.ZCode 自己）都一样。
// 因此这里主动读取该开关：关闭时不再白白 spawn PowerShell，并把原因讲清楚。

const TOAST_ENABLED_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
/**
 * 用 reg.exe 的**绝对路径**：实测不带路径时解析结果随调用方 PATH 而异
 * （本机调试环境曾解析到行为不同的 reg，报"无效语法"），写死系统目录
 * 消除这一差异。
 */
/**
 * 用 **PowerShell** 读注册表：本机实测 reg.exe 的命令行查询会被以"无效语法"
 * 拒绝（status=1、无输出，疑似安全软件干扰），而 PowerShell 的
 * Get-ItemProperty 读同一键稳定可用 —— 以实测可用者为准。
 */
const PS_EXE = 'powershell.exe';
/** 开关状态缓存时长：用户随时可能在设置里改，不宜永久缓存。 */
const TOAST_ENABLED_TTL_MS = 60_000;
let toastEnabledCache: { value: boolean; at: number } | null = null;

/** 读取系统通知总开关（Windows 设置 → 系统 → 通知 的主开关）。 */
export function isGlobalToastEnabled(now: number = Date.now()): boolean {
  if (toastEnabledCache && now - toastEnabledCache.at < TOAST_ENABLED_TTL_MS) {
    return toastEnabledCache.value;
  }
  let enabled = true;
  try {
    const r = spawnSync(
      PS_EXE,
      [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        `(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications' -Name ToastEnabled -ErrorAction SilentlyContinue).ToastEnabled`,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 },
    );
    if (r.status === 0 && typeof r.stdout === 'string') {
      const t = r.stdout.trim();
      // 输出为空 = 值不存在 = 用户从未改过 = 默认允许。
      if (t !== '') {
        const n = Number.parseInt(t, 10);
        if (Number.isFinite(n)) enabled = n !== 0;
      }
    } else {
      logger.warn(`[NOTIFY] Failed to read global toast switch (status=${r.status}).`);
    }
  } catch (err: any) {
    logger.warn(`[NOTIFY] Failed to read global toast switch: ${err?.message || err}`);
  }
  toastEnabledCache = { value: enabled, at: now };
  return enabled;
}

/** 测试用。 */
export function resetToastEnabledCache(): void {
  toastEnabledCache = null;
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

  // 系统总开关关闭时，toast 会被通知平台以 GlobalSettingDisabled 拒绝且不留
  // 痕迹 —— 与其白白 spawn 一个注定失败的 PowerShell，不如把原因写进日志。
  if (!isGlobalToastEnabled()) {
    if (!shouldSend('sys-toast-off', Date.now())) return false;
    logger.warn(
      '[NOTIFY] 系统通知总开关已关闭（HKCU...PushNotifications\\ToastEnabled=0）。' +
      'toast 会被 Windows 以 GlobalSettingDisabled 拒绝，本次跳过。' +
      '修复：设置 → 系统 → 通知，打开总开关。'
    );
    return false;
  }

  const now = Date.now();
  if (!shouldSend(key, now)) return false;

  const aumid = ensureAumidRegistered() ? PROXY_AUMID : POWERSHELL_AUMID;

  // PowerShell 内联脚本：不走 shell 拼接，参数经 XML 转义后内插。
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
    `$t = $xml.GetElementsByTagName('text')`,
    `$t.Item(0).AppendChild($xml.CreateTextNode('${escapeXml(title)}')) | Out-Null`,
    `$t.Item(1).AppendChild($xml.CreateTextNode('${escapeXml(body)}')) | Out-Null`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid}').Show($toast)`,
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
    logger.info(`[NOTIFY] ${level} [${aumid === PROXY_AUMID ? 'own' : 'fallback'}]: ${title} — ${body}`);
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
