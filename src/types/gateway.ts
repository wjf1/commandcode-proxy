// =============================================================================
// 类型定义：网关配置、账号与日志条目
// -----------------------------------------------------------------------------
// 自 types/index.ts 原样拆出（架构 Phase 1），类型定义内容零变化。
// =============================================================================

// ─── 网关配置 ───────────────────────────────────────────────────────────────

export interface AccountInfo {
  id: string;
  name: string;
  apiKey: string;
  userName?: string;
  email?: string;
  userId?: string;
  addedAt: string;
}

export interface UpstreamConfig {
  apiBase?: string;
  ccVersion?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
}

export interface GatewayConfigFile {
  port?: number;
  host?: string;
  activeAccountId?: string;
  rotationMode?: 'manual' | 'auto-quota';
  accounts?: AccountInfo[];
  upstream?: UpstreamConfig;
}

export interface GatewayConfig {
  port: number;
  host: string;
  ccApiBase: string;
  ccVersion: string;
  rotationMode: 'manual' | 'auto-quota';
  activeAccountId: string;
  accounts: AccountInfo[];
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
  maxRetries: number;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
