// =============================================================================
// Prompt 版本管理（本地快照 + 回滚）
// -----------------------------------------------------------------------------
// - 存储布局：<PROMPTS_DIR>/<name>.md|.txt 为当前内容（内容即文本，不做结构化）；
//   <PROMPTS_DIR>/.versions/<name>/<时间戳>.md 为历史快照
// - 保存语义：写入新内容前，若该 name 已有旧内容，先把旧内容快照一份。
//   回滚也走同一条保存路径（恢复前同样先快照当前内容），历史不因回滚丢失。
// - 时间戳：ISO 8601 中的冒号在 Windows 文件名里非法（会被当成 NTFS 数据流），
//   因此落盘文件名把 ':' 替换为 '-'；对外 API 的 ts 即文件名主干，
//   time 字段还原为标准 ISO 形式。
// - 原子写：临时文件名带 pid + rename（与 usage-store.ts 同款做法）。
// - name / ts 参数一律过白名单（[A-Za-z0-9._-]，且禁止连续两个点），
//   防目录穿越：拼路径前先校验，不依赖事后 realpath 兜底。
// =============================================================================
import fs from 'fs';
import path from 'path';
import { getProjectRootDir } from './paths.js';

const VERSIONS_DIRNAME = '.versions';
const PROMPT_EXTS = ['.md', '.txt'] as const;
/** name / ts 白名单：字母数字、点、下划线、连字符；连续两个点视为目录穿越。 */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes('..') && name !== '.' && name !== '..';
}

/**
 * 解析 PROMPTS_DIR：未设时默认 <项目根>/prompts；相对路径相对项目根。
 * 每次调用时读 env —— 测试可以中途换目录，生产语义不变。
 */
export function resolvePromptsDir(): string {
  const raw = process.env.PROMPTS_DIR?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.join(getProjectRootDir(), raw);
  return path.join(getProjectRootDir(), 'prompts');
}

function assertValidName(name: string): void {
  if (!isValidName(name)) throw new Error(`Invalid prompt name: ${name}`);
}

/** name → 现有 prompt 文件（.md 优先、其次 .txt）；都没有返回 null。 */
function findPromptFile(dir: string, name: string): string | null {
  for (const ext of PROMPT_EXTS) {
    const p = path.join(dir, `${name}${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function toFileTs(d: Date): string {
  return d.toISOString().replace(/:/g, '-');
}

/** 文件名主干 → 标准 ISO 8601（把时:分:秒位置被替换掉的 '-' 还原回 ':'）。 */
function fromFileTs(ts: string): string {
  return ts.length >= 19
    ? `${ts.slice(0, 10)}T${ts.slice(11, 13)}:${ts.slice(14, 16)}:${ts.slice(17)}`
    : ts;
}

function versionsDirFor(dir: string, name: string): string {
  return path.join(dir, VERSIONS_DIRNAME, name);
}

// 同一毫秒内连续保存会产生同名快照互相覆盖：撞名则 +1ms 重试直到空闲。
// 时间戳保持单调，快照的文件名字典序永远与写入顺序一致（倒序即最新在前）。
function nextSnapshotFile(dir: string, name: string): string {
  const versionsDir = versionsDirFor(dir, name);
  fs.mkdirSync(versionsDir, { recursive: true });
  let ms = Date.now();
  for (;;) {
    const file = path.join(versionsDir, `${toFileTs(new Date(ms))}.md`);
    if (!fs.existsSync(file)) return file;
    ms += 1;
  }
}

// 临时文件名带 pid：固定名在两个实例共用同一数据目录时会互相踩，且 Windows 上
// rename 覆盖被对方打开的文件会 EPERM（usage-store.ts 同款做法）。
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 列出所有 prompt name（按文件主干去重排序）。目录不存在返回空数组。 */
export function listPrompts(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const names = new Set<string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!(PROMPT_EXTS as readonly string[]).includes(ext)) continue;
    names.add(entry.name.slice(0, -ext.length));
  }
  return [...names].sort();
}

/** 当前内容；不存在返回 null。 */
export function readPrompt(dir: string, name: string): string | null {
  assertValidName(name);
  const file = findPromptFile(dir, name);
  if (!file) return null;
  return fs.readFileSync(file, 'utf-8');
}

export interface PromptVersionInfo {
  /** 快照标识（文件名主干），可直接传给 readVersion / rollbackPrompt。 */
  ts: string;
  /** 标准 ISO 8601 形式。 */
  time: string;
  /** 快照字节数。 */
  size: number;
}

/** name 的全部快照，按时间倒序（最新在前）。无快照返回空数组。 */
export function listVersions(dir: string, name: string): PromptVersionInfo[] {
  assertValidName(name);
  const versionsDir = versionsDirFor(dir, name);
  if (!fs.existsSync(versionsDir)) return [];
  return fs.readdirSync(versionsDir)
    .filter(f => f.toLowerCase().endsWith('.md') && !f.startsWith('.'))
    .map(f => {
      const ts = f.slice(0, -3);
      return { ts, time: fromFileTs(ts), size: fs.statSync(path.join(versionsDir, f)).size };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

/** 读取某快照内容；不存在返回 null。 */
export function readVersion(dir: string, name: string, ts: string): string | null {
  assertValidName(name);
  assertValidName(ts);
  const file = path.join(versionsDirFor(dir, name), `${ts}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

export interface SaveResult {
  name: string;
  /** 实际写入的当前内容文件绝对路径。 */
  file: string;
  /** 本次保存是否把旧内容落了快照（首次保存为 false）。 */
  snapshotted: boolean;
}

/** 保存：旧内容存在则先快照，再原子写入新内容（保留原扩展名，新建默认 .md）。 */
export function savePrompt(dir: string, name: string, content: string): SaveResult {
  assertValidName(name);
  fs.mkdirSync(dir, { recursive: true });
  const existing = findPromptFile(dir, name);
  let snapshotted = false;
  if (existing) {
    atomicWrite(nextSnapshotFile(dir, name), fs.readFileSync(existing, 'utf-8'));
    snapshotted = true;
  }
  const target = existing ?? path.join(dir, `${name}.md`);
  atomicWrite(target, content);
  return { name, file: target, snapshotted };
}

/** 回滚：恢复前先把当前内容快照一份（复用 savePrompt 的保存语义）。快照不存在返回 null。 */
export function rollbackPrompt(dir: string, name: string, ts: string): SaveResult | null {
  const content = readVersion(dir, name, ts);
  if (content === null) return null;
  return savePrompt(dir, name, content);
}
