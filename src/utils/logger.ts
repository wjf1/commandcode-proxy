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

const LOG_FILE_PATH = process.env.COMMANDCODE_LOG_PATH
  ? path.resolve(process.env.COMMANDCODE_LOG_PATH)
  : path.join(getProjectRootDir(), 'logs', 'proxy.log');
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * 清洗控制字符与 ANSI 转义序列，使渲染到仪表盘的日志行永不注入标记或终端序列。
 */
function sanitize(message: string): string {
  return String(message)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
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
  const entry: LogEntry = { timestamp: timestamp(), level, message: sanitize(message) };
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
