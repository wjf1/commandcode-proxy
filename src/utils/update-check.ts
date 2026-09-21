// =============================================================================
// 版本更新检查（尽力而为，不阻塞启动、不影响请求路径）
// -----------------------------------------------------------------------------
// 启动时与每 24h 查询一次 GitHub Releases 最新版本。api.github.com 是固定
// URL 的只读公开接口（无凭据、无客户端输入参与），不受上游 SSRF 白名单约束。
// 查询失败（离线/被墙）静默保留上次结果，下次再查。
// =============================================================================
import { logger } from './logger.js';
import { PROXY_VERSION } from './version.js';

const TAGS_API = 'https://api.github.com/repos/wjf1/commandcode-proxy/tags?per_page=100';
const RELEASES_PAGE = 'https://github.com/wjf1/commandcode-proxy/releases';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const state: { latest: string | null; checkedAt: number } = { latest: null, checkedAt: 0 };

function parseSemver(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * 严格版：只有 x.y.z 形态才算版本号。
 * 与 parseSemver 分开是有意的 —— 后者对不认识的输入回退 [0,0,0]，
 * 用于"比较两个已知版本"没问题，但会把 'latest' 这类 tag 当成 0.0.0 参与择优。
 */
function parseTagVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] > b[2]);
}

/**
 * 从 GitHub `/tags` 的响应里取最大 semver tag。
 *
 * 不能用 releases/latest：本项目只打 tag、不创建 Release 对象，releases/latest
 * 会永久停在最后一次手工建 Release 的版本上（实测 v4.12.0），使"发现新版本"失效。
 * GitHub 也不保证 /tags 按版本序返回，因此必须比较后取最大。
 * 对脏数据（非数组、null 项、非版本号 tag、字段类型错误）一律忽略而非抛错。
 */
export function pickLatestTag(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  let best: string | null = null;
  let bestKey: [number, number, number] | null = null;

  for (const item of items) {
    const name = (item as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = parseTagVersion(name);
    if (key === null) continue;
    if (!bestKey || compareSemver(key, bestKey) > 0) {
      bestKey = key;
      best = name.trim();
    }
  }
  return best;
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
    // per_page=100 覆盖当前全部 tag（26 个）。若将来 tag 数超过 100，GitHub 不保证
    // /tags 按版本序返回，需要改为分页取最大或换用 git ls-remote 侧的排序端点。
    const res = await fetch(TAGS_API, {
      headers: { 'User-Agent': 'commandcode-proxy', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const latest = pickLatestTag(data);
    if (latest) {
      state.latest = latest;
      state.checkedAt = Date.now();
      if (isNewerVersion(latest, PROXY_VERSION)) {
        logger.info(
          `[UPDATE] New version available: ${latest} (current ${PROXY_VERSION}) — ` +
          RELEASES_PAGE,
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
