// =============================================================================
// 出站网络代理管理器（Outbound Proxy Agent）
// -----------------------------------------------------------------------------
// 职责：
//   1. 全局配置 IPv4 优先解析（dns.setDefaultResultOrder('ipv4first')），彻底避开
//      国内运营商恶劣的 IPv6 握手黑洞与 10 秒连接超时（UND_ERR_CONNECT_TIMEOUT）。
//   2. 解析 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 或 config.json 中的代理配置。
//   3. 自动快速探测代理可用性（Auto-fallback）：若代理客户端未启动或换到无代理电脑，
//      平滑降级为直连模式，绝不因代理断开而阻断请求。
//   4. 自动加固 NO_PROXY，强制确保本地环回地址（localhost, 127.0.0.1, ::1）直连。
//   5. 代理可用时通过 undici setGlobalDispatcher 挂载全局分发器。
// =============================================================================
import dns from 'node:dns';
import net from 'node:net';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';
import type { GatewayConfig } from '../types/gateway.js';

export interface OutboundProxyStatus {
  enabled: boolean;
  proxyUrl?: string;
  noProxy: string;
  fallbackReason?: string;
}

const MANDATORY_LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * 配置全局 DNS 解析结果顺序。
 * 默认优先返回 IPv4（ipv4first），彻底解决国内网络直连海外 Cloudflare 时
 * 因 IPv6 路由黑洞/丢包导致的 10 秒握手超时（UND_ERR_CONNECT_TIMEOUT）。
 */
export function configureDnsResultOrder(): void {
  const mode = (process.env.COMMANDCODE_DNS_ORDER || 'ipv4first').trim().toLowerCase();
  try {
    if (mode === 'verbatim') {
      dns.setDefaultResultOrder('verbatim');
    } else {
      dns.setDefaultResultOrder('ipv4first');
    }
  } catch (err: any) {
    logger.warn(`[DNS] Failed to set default result order to '${mode}': ${err.message}`);
  }
}

/**
 * 确保 NO_PROXY 环境变量始终包含本地回环地址，
 * 避免对本地 mock 服务、Fastify 监听端口以及回环探针的请求误走外网代理。
 */
export function ensureSafeNoProxy(): string {
  const rawNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const parts = rawNoProxy
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const host of MANDATORY_LOOPBACK_HOSTS) {
    if (!parts.includes(host)) {
      parts.push(host);
    }
  }

  const normalized = parts.join(',');
  process.env.NO_PROXY = normalized;
  process.env.no_proxy = normalized;
  return normalized;
}

/**
 * 从 GatewayConfig 与环境变量中解析出站代理 URL。
 * 优先级：config.proxy > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY（含小写）。
 */
export function resolveProxyUrl(config?: GatewayConfig): string | null {
  const candidate = (
    config?.proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  ).trim();

  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      logger.warn(`[PROXY] Unsupported proxy protocol: '${parsed.protocol}', expected http: or https:. Falling back to direct connection.`);
      return null;
    }
    return candidate;
  } catch (err: any) {
    logger.warn(`[PROXY] Invalid proxy URL '${candidate}': ${err.message}. Falling back to direct connection.`);
    return null;
  }
}

/**
 * 快速探测代理服务器是否可达（TCP 握手探针）。
 * 针对换电脑或未开启代理软件的场景，避免因代理不可用（ECONNREFUSED）导致所有请求秒败。
 */
export async function isProxyReachable(
  proxyUrl: string,
  timeoutMs = 800
): Promise<{ reachable: boolean; latencyMs?: number; error?: string }> {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch (err: any) {
    return { reachable: false, error: err.message };
  }

  const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  const host = url.hostname;

  return new Promise(resolve => {
    const startTime = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finalize = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable,
        latencyMs: reachable ? Date.now() - startTime : undefined,
        error,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false, `Connection timed out (${timeoutMs}ms)`));
    socket.once('error', (err: any) => finalize(false, err.message));

    socket.connect(port, host);
  });
}

let activeProxyStatus: OutboundProxyStatus = {
  enabled: false,
  noProxy: 'localhost,127.0.0.1,::1',
};

/**
 * 初始化全局出站网络代理。
 * 在服务启动早期调用，使后续所有的 fetch 请求自动适配代理与 NO_PROXY。
 * 若代理不可达，则自动平滑回退至直连模式（保持 IPv4 优先）。
 */
export async function initOutboundProxy(config?: GatewayConfig): Promise<OutboundProxyStatus> {
  // 1. 始终配置 IPv4 优先，保证直连时的稳定性
  configureDnsResultOrder();

  const noProxy = ensureSafeNoProxy();
  const proxyUrl = resolveProxyUrl(config);

  if (!proxyUrl) {
    activeProxyStatus = { enabled: false, noProxy };
    logger.info('[PROXY] Direct connection (IPv4 first, no outbound proxy configured)');
    return activeProxyStatus;
  }

  // 掩码密码用于日志输出
  const maskedUrl = (() => {
    try {
      const u = new URL(proxyUrl);
      if (u.password) u.password = '******';
      return u.toString();
    } catch {
      return proxyUrl;
    }
  })();

  // 2. 探活检测代理服务端口是否可达
  const probe = await isProxyReachable(proxyUrl);
  if (!probe.reachable) {
    activeProxyStatus = {
      enabled: false,
      proxyUrl: maskedUrl,
      fallbackReason: probe.error,
      noProxy,
    };
    logger.warn(`[PROXY] Configured proxy ${maskedUrl} is unreachable (${probe.error}). Smoothly falling back to direct connection (IPv4 first).`);
    return activeProxyStatus;
  }

  // 3. 代理可达，装配全局 ProxyAgent
  try {
    const agent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(agent);

    activeProxyStatus = {
      enabled: true,
      proxyUrl: maskedUrl,
      noProxy,
    };

    logger.info(`[PROXY] Outbound HTTP(S) proxy armed: ${maskedUrl} (probe: ${probe.latencyMs}ms, NO_PROXY: ${noProxy})`);
    return activeProxyStatus;
  } catch (err: any) {
    logger.error(`[PROXY] Failed to initialize ProxyAgent: ${err.message}. Falling back to direct connection (IPv4 first).`);
    activeProxyStatus = {
      enabled: false,
      proxyUrl: maskedUrl,
      fallbackReason: err.message,
      noProxy,
    };
    return activeProxyStatus;
  }
}

/**
 * 获取当前出站代理状态
 */
export function getOutboundProxyStatus(): OutboundProxyStatus {
  return { ...activeProxyStatus };
}
