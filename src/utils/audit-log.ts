// =============================================================================
// 审计日志（JSONL，默认开启 minimal）—— 只记元数据，绝不记消息正文
// -----------------------------------------------------------------------------
// - 每个补全请求一行 JSON：{ ts, route, model, inputTokens, outputTokens,
//   status, durationMs, accountId? }。status 取值：COMPLETED / FAILED /
//   RATE_LIMITED / MODEL_FORBIDDEN（后两者来自限流与模型访问控制 guard）。
//   accountId 是上游 Command Code API key 的末 4 位（accountTail），绝不落
//   全量密钥；字段层面就不存在消息正文、system prompt 或任何用户内容。
// - 路径：AUDIT_LOG_PATH 可覆盖；默认 getProjectRootDir()/logs/audit.log
//   （与 logger.ts 的 LOG_FILE_PATH 同款目录模式，但不改 logger.ts）。
//   路径在**写入时**惰性求值，测试可用 AUDIT_LOG_PATH 指到临时目录。
// - 开关：AUDIT_LOG 默认 on，设 off 关闭（关闭时零 IO、零开销）。
// - 落盘：追加式 + 超 5MB 轮转 .old（参照 logger 的 LOG_FILE_MAX_BYTES 模式）；
//   任何写失败（目录不可创建、磁盘只读等）一律静默禁用，绝不影响请求路径。
// - API：auditRequestStart(req) 在 handler 入口创建条目并开始计时；
//   auditRequestEnd(entry, result) 在请求收敛点落盘（本仓库路由里与用量落库
//   persistOnce 同点，一次请求只记一条）。guard 拒绝路径拿不到闭包 entry，
//   用 auditReject(req, ...) 经 WeakMap 关联容错落盘。
// =============================================================================
import fs from 'fs';
import path from 'path';
import { getProjectRootDir } from './paths.js';

const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

export interface AuditEntry {
  startTs: number;
  route: string;
}

export interface AuditResult {
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  status: string;
  accountId?: string;
}

/** entry 与请求对象弱关联，供 guard 拒绝路径（无闭包 entry）容错取回。 */
const pendingEntries = new WeakMap<object, AuditEntry>();

function auditEnabled(): boolean {
  return (process.env.AUDIT_LOG ?? 'on').trim().toLowerCase() !== 'off';
}

function auditFilePath(): string {
  return process.env.AUDIT_LOG_PATH
    ? path.resolve(process.env.AUDIT_LOG_PATH)
    : path.join(getProjectRootDir(), 'logs', 'audit.log');
}

function resolveRoute(req: { url?: string }): string {
  return String(req?.url ?? '').split('?')[0] || 'unknown';
}

/** 取密钥末 4 位作账号标识；空值返回 undefined。绝不返回全量密钥。 */
export function accountTail(key: string | undefined | null): string | undefined {
  const k = String(key ?? '').trim();
  return k ? k.slice(-4) : undefined;
}

/** handler 入口调用：创建审计条目并开始计时。 */
export function auditRequestStart(req: { url?: string }): AuditEntry {
  const entry: AuditEntry = { startTs: Date.now(), route: resolveRoute(req) };
  pendingEntries.set(req as object, entry);
  return entry;
}

/** guard 拒绝路径（限流 / 模型访问控制）在路由早期落盘一行审计。 */
export function auditReject(req: { url?: string }, status: string, model?: string | null): void {
  const entry = pendingEntries.get(req as object) ?? auditRequestStart(req);
  auditRequestEnd(entry, { model: model ?? null, status });
}

/** 请求收敛点调用：组装元数据并落盘一行。写失败静默。 */
export function auditRequestEnd(entry: AuditEntry, result: AuditResult): void {
  if (!auditEnabled()) return;
  const record: Record<string, unknown> = {
    ts: new Date(entry.startTs).toISOString(),
    route: entry.route,
    model: result.model ?? null,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    status: result.status,
    durationMs: Math.max(0, Date.now() - entry.startTs),
  };
  if (result.accountId) record.accountId = result.accountId;
  appendAuditLine(JSON.stringify(record));
}

function appendAuditLine(line: string): void {
  try {
    const file = auditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) {
        fs.renameSync(file, `${file}.old`);
      }
    } catch {
      /* 文件尚不存在等场景，继续追加 */
    }
    fs.appendFileSync(file, `${line}\n`, 'utf-8');
  } catch {
    // 落盘失败（目录不可写、磁盘只读等）静默禁用：审计绝不影响请求路径。
  }
}
