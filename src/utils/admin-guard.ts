// =============================================================================
// 管理面鉴权边界（回移植自同源仓 multi-upstream-gateway 批次 B）
// -----------------------------------------------------------------------------
//   B2 Host 回环白名单 —— token 注入进页面 HTML，所以它依赖 B2：Host 不先关进
//      白名单，DNS rebinding 把 evil.tld 指到 127.0.0.1 后 Origin 与 Host 天然
//      相等，同源校验必然放行，rebinding 的页面能把带着 token 的 HTML 一起读走。
//   B1 管理面写操作凭据 —— 只卡写操作；PROXY_API_KEY 从此只管 /v1/*，实现权限
//      分离（数据面密钥泄露不再等于管理面失守）。/api/* 的读端点保持可被本机
//      脚本直接访问。
// 全部判据做成纯函数，便于单测锁定。
// =============================================================================
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** 管理面写操作的凭据。显式设置 ADMIN_API_TOKEN 可固定（脚本用）。 */
export const ADMIN_TOKEN: string = process.env.ADMIN_API_TOKEN?.trim() || randomUUID();

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** 把 `name:port` / `[v6]:port` 形态的 Host 值拆成小写主机名；无法解析时返回 null。 */
function hostNameOf(value: string): string | null {
  try {
    // 借 URL 解析：凭据（user@host）、路径、通配等畸形写法都会被归到真实 hostname 上。
    const url = new URL(`http://${value}`);
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * 入站 Host 是否属于回环名（或 ADMIN_ALLOWED_HOSTS 追加的名字）。
 * 端口不参与判定：同源检查已经约束了 host:port 的一致性。
 */
export function isLoopbackHostHeader(host: string | undefined, extraCsv?: string): boolean {
  if (!host) return false;
  const name = hostNameOf(host.trim());
  if (!name) return false;
  if (LOOPBACK_NAMES.has(name)) return true;
  const allowed = (extraCsv ?? process.env.ADMIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^\[|\]$/g, ''))
    .filter(Boolean);
  return allowed.includes(name);
}

/** 常量时间比较，避免用计时侧信道逐字节猜 token。长度不同也要走完哈希。 */
export function adminTokenOk(presented: string | undefined): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(ADMIN_TOKEN).digest();
  return timingSafeEqual(a, b);
}

/** dashboard HTML 的 <head> 注入 token meta（前端 apiJson 读取后随写请求回传）。 */
export function injectAdminTokenMeta(html: string): string {
  if (html.includes('name="ccproxy-admin-token"')) return html;
  return html.replace('<head>', `<head>\n  <meta name="ccproxy-admin-token" content="${ADMIN_TOKEN}">`);
}
