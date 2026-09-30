// =============================================================================
// 出站网络代理管理器（Outbound Proxy Agent）
// -----------------------------------------------------------------------------
// 职责：
//   1. 解析 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 或 config.json 中的代理配置
//   2. 自动加固 NO_PROXY，强制确保本地环回地址（localhost, 127.0.0.1, ::1）直连
//   3. 通过 undici setGlobalDispatcher 挂载全局分发器，使全站 fetch 自动走代理
//   4. 容错处理：代理地址格式非法时平滑回退直连，避免阻塞服务启动
// =============================================================================
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';
import type { GatewayConfig } from '../types/gateway.js';

export interface OutboundProxyStatus {
  enabled: boolean;
  proxyUrl?: string;
  noProxy: string;
}

const MANDATORY_LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

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

let activeProxyStatus: OutboundProxyStatus = {
  enabled: false,
  noProxy: 'localhost,127.0.0.1,::1',
};

/**
 * 初始化全局出站网络代理。
 * 在服务启动早期调用，使后续所有的 fetch 请求自动适配代理与 NO_PROXY。
 */
export function initOutboundProxy(config?: GatewayConfig): OutboundProxyStatus {
  const noProxy = ensureSafeNoProxy();
  const proxyUrl = resolveProxyUrl(config);

  if (!proxyUrl) {
    activeProxyStatus = { enabled: false, noProxy };
    logger.info('[PROXY] Direct connection (no outbound proxy configured)');
    return activeProxyStatus;
  }

  try {
    // 遮蔽打印中的密码信息（如果有）
    const maskedUrl = (() => {
      try {
        const u = new URL(proxyUrl);
        if (u.password) u.password = '******';
        return u.toString();
      } catch {
        return proxyUrl;
      }
    })();

    const agent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(agent);

    activeProxyStatus = {
      enabled: true,
      proxyUrl: maskedUrl,
      noProxy,
    };

    logger.info(`[PROXY] Outbound HTTP(S) proxy armed: ${maskedUrl} (NO_PROXY: ${noProxy})`);
    return activeProxyStatus;
  } catch (err: any) {
    logger.error(`[PROXY] Failed to initialize ProxyAgent: ${err.message}. Falling back to direct connection.`);
    activeProxyStatus = { enabled: false, noProxy };
    return activeProxyStatus;
  }
}

/**
 * 获取当前出站代理状态
 */
export function getOutboundProxyStatus(): OutboundProxyStatus {
  return { ...activeProxyStatus };
}
