// =============================================================================
// 版本更新检查（尽力而为，不阻塞启动、不影响请求路径）
// -----------------------------------------------------------------------------
// 启动时与每 24h 查询一次 GitHub Releases 最新版本。api.github.com 是固定
// URL 的只读公开接口（无凭据、无客户端输入参与），不受上游 SSRF 白名单约束。
// 查询失败（离线/被墙）静默保留上次结果，下次再查。
// =============================================================================
import { logger } from './logger.js';
import { PROXY_VERSION } from './version.js';

const RELEASES_API = 'https://api.github.com/repos/wjf1/commandcode-proxy/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const state: { latest: string | null; checkedAt: number } = { latest: null, checkedAt: 0 };

function parseSemver(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] > b[2]);
}

/** 仪表盘 /api/status 用：当前版本 vs 已知的最新发布版。 */
export function getUpdateState(): { available: boolean; latest: string | null; current: string } {
  return {
    available: state.latest ? isNewerVersion(state.latest, PROXY_VERSION) : false,
    latest: state.latest,
    current: PROXY_VERSION,
  };
}

export async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'commandcode-proxy', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { tag_name?: string };
    if (typeof data.tag_name === 'string' && data.tag_name) {
      state.latest = data.tag_name;
      state.checkedAt = Date.now();
      if (isNewerVersion(data.tag_name, PROXY_VERSION)) {
        logger.info(
          `[UPDATE] New version available: ${data.tag_name} (current ${PROXY_VERSION}) — ` +
          'https://github.com/wjf1/commandcode-proxy/releases',
        );
      }
    }
  } catch {
    // 离线/被墙：静默，24h 后再查
  }
}

/** 启动后异步查一次，之后每 24h 一次。 */
export function scheduleUpdateChecks(): void {
  setImmediate(() => { void checkForUpdate(); });
  const timer = setInterval(() => { void checkForUpdate(); }, CHECK_INTERVAL_MS);
  timer.unref?.();
}
