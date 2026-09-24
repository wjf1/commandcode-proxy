// =============================================================================
// 简易环形缓冲 logger + 文件持久化
// -----------------------------------------------------------------------------
// - 维护一个最多 MAX_LOGS 条的环形缓冲，供仪表盘 /api/logs 读取
// - 同时输出到控制台（info→log、warn→warn、error→error）
// - 全量追加到 logs/proxy.log（COMMANDCODE_LOG_PATH 可改），重启不丢，
//   超 5MB 轮转为 .old —— 供事后排查"昨晚为什么挂"
// - 对消息做清洗：剔除控制字符与 ANSI 转义序列，防止日志注入到 HTML 时
//   携带终端序列或标记
// =============================================================================
import fs from 'fs';
import path from 'path';
import { LogEntry } from '../types/index.js';
import { getProjectRootDir } from './paths.js';

const MAX_LOGS = 500;
const logBuffer: LogEntry[] = [];

export const LOG_FILE_PATH = process.env.COMMANDCODE_LOG_PATH
  ? path.resolve(process.env.COMMANDCODE_LOG_PATH)
  : path.join(getProjectRootDir(), 'logs', 'proxy.log');
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

function timestamp(): string {
  // 手写而不是 toLocaleTimeString('en-GB', { hour12: false })：后者每次调用都要
  // 重新构造一个 Intl formatter（实测 3 万次 ≈ 1.6s），而日志是每请求多条的热点。
  // 顺带消掉 ICU 在 hour12:false 下把午夜渲染成 "24:00:00" 的版本差异。
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 清洗控制字符与 ANSI 转义序列，使渲染到仪表盘的日志行永不注入标记或终端序列。
 */
function sanitize(message: string): string {
  return String(message)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // eslint-disable-next-line no-control-regex -- \u001B(ESC) 即目标清洗字符
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

const REDACTED = '[REDACTED]';

/**
 * 按密钥形态脱敏：Authorization: Bearer/Basic、api-key/x-api-key 键值、裸 sk- 令牌、
 * query 里的 token/key 参数。安全默认（LOG_REDACTION 未设即 on），设为 off 可显式回退，
 * 供依赖日志原文排查密钥问题的场景临时使用。
 */
export function redactSecrets(message: string): string {
  if ((process.env.LOG_REDACTION || '').trim().toLowerCase() === 'off') return message;
  return message
    // Authorization: Bearer xxx / Basic xxx（值至少 8 字符，避免误伤普通语句）
    .replace(/(authorization\s*[:=]\s*)(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      (_m, p1: string, p2: string) => `${p1}${p2} ${REDACTED}`)
    // api-key / x-api-key / apikey 键值对（header、JSON、query 通用；key/value 均允许引号包裹）
    .replace(/((?:["']?(?:x-)?api-?key["']?\s*[:=]\s*))("[^"]{8,}"|[^\s,;{}]{8,})/gi,
      (_m, p1: string) => `${p1}${REDACTED}`)
    // 裸 sk- 风格令牌
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    // query 参数：token / key / access_token
    .replace(/([?&](?:access_)?(?:token|key|apikey|api_key)=)[^&\s]+/gi, (_m, p1: string) => `${p1}${REDACTED}`);
}

function appendFileSink(entry: LogEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });
    try {
      if (fs.statSync(LOG_FILE_PATH).size > LOG_FILE_MAX_BYTES) {
        fs.renameSync(LOG_FILE_PATH, `${LOG_FILE_PATH}.old`);
      }
    } catch { /* 文件尚不存在等场景，继续追加 */ }
    fs.appendFileSync(LOG_FILE_PATH, `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}\n`, 'utf-8');
  } catch {
    // 落盘失败（磁盘只读等）不影响控制台输出与请求路径
  }
}

function push(level: LogEntry['level'], message: string): void {
  // 先 sanitize 清掉控制字符（防止用 \x00 拆分 "Bearer" 绕过正则），再做密钥脱敏。
  const entry: LogEntry = { timestamp: timestamp(), level, message: redactSecrets(sanitize(message)) };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
  if (level === 'error') console.error(`${prefix} ${entry.message}`);
  else if (level === 'warn') console.warn(`${prefix} ${entry.message}`);
  else console.log(`${prefix} ${entry.message}`);
  appendFileSink(entry);
}

export const logger = {
  info: (msg: string) => push('info', msg),
  warn: (msg: string) => push('warn', msg),
  error: (msg: string) => push('error', msg),
  getLogs: (): LogEntry[] => [...logBuffer],
  clearLogs: (): void => {
    logBuffer.length = 0;
  },
};
