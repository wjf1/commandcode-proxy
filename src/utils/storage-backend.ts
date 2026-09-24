// =============================================================================
// 用量存储后端接口（UsageStorageBackend）+ 默认 JSONL 实现
// -----------------------------------------------------------------------------
// usage-store.ts 的存储层解耦：把"记录如何落盘、如何读回"抽象成一个窄接口，
// 由 usage-store 在模块加载时按 env 装配。默认实现 JsonlUsageBackend 原样保留
// 既有 usage-history.jsonl 的全部读写行为（逐行 JSON、串行追加、超限轮转保留
// 较新一半、mtime/size 读取缓存）——文件格式一个字节不变，既有用户数据完全兼容。
//
// 为未来 SQLite 后端预留的是接口面而不是实现：USAGE_STORAGE_BACKEND 目前仅
// 支持 'jsonl'（缺省即该值），其他值在进程启动期直接抛错（fail fast），保持
// 单 exe 离线约束。接口按现有公共 API 需要的全部 IO 原语设计，后补实现时
// 不需要再改 usage-store 的调用侧。
// =============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';
import type { UsageRecord } from './usage-store.js';

/**
 * 用量存储后端需要支持的全部 IO 原语。
 *
 * 约定：
 *  - append/loadAll/clear 的失败一律由实现内部捕获并记日志（与既有行为一致，
 *    存储故障不中断代理主链路），不向上抛。
 *  - 实现自身可携带读取缓存（JSONL 的 mtime/size 缓存），但缓存失效必须由
 *    clear() 自己处理。
 */
export interface UsageStorageBackend {
  /**
   * 追加已序列化的记录行（每条一行，不带换行符；实现方负责补换行、目录创建
   * 与落盘时机）。目前调用方每条记录调用一次；接口收数组是为未来后端留出
   * 批量事务的空间。
   */
  append(entries: string[]): Promise<void> | void;
  /** 读取全部记录；损坏行容错跳过。 */
  loadAll(): UsageRecord[];
  /** 清空全部历史。返回是否确有文件/数据被清空（false = 本来就没有）。 */
  clear(): boolean;
  /** 历史超过大小上限时保留较新一半（从中点后的第一条完整行起）。 */
  rotateIfNeeded(): void;
  /** 等待挂起的写入完成（优雅退出时避免丢最后几条记录）。 */
  flush(): Promise<void>;
}

export type UsageStorageBackendName = 'jsonl';

/**
 * 解析并校验 USAGE_STORAGE_BACKEND。仅支持 'jsonl'（缺省即该值）；
 * 其他值抛错——为未来 SQLite 预留的是接口，不是配置面。
 */
export function resolveStorageBackendName(raw: string | undefined): UsageStorageBackendName {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'jsonl') return 'jsonl';
  throw new Error(
    `[USAGE] Unsupported USAGE_STORAGE_BACKEND="${raw}" — only "jsonl" is available.`
  );
}

/** 用量历史文件路径：尊重 USAGE_HISTORY_PATH，否则 ~/.commandcode/usage-history.jsonl。 */
export function resolveUsageFilePath(): string {
  return process.env.USAGE_HISTORY_PATH
    ? path.resolve(process.env.USAGE_HISTORY_PATH)
    : path.join(os.homedir(), '.commandcode', 'usage-history.jsonl');
}

/**
 * 历史文件大小上限（字节）。默认 20MB，可用环境变量 USAGE_HISTORY_MAX_MB 调整。
 * 只追加不轮转的话，文件会随使用无限增长，而 /api/usage/history 每次都全量
 * 读取 + 聚合，几十万行后仪表盘会明显变慢。
 */
const USAGE_MAX_BYTES = (() => {
  const mb = parseInt(process.env.USAGE_HISTORY_MAX_MB || '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 20 * 1024 * 1024;
})();

/** JSONL 后端：usage-history.jsonl 的全部读写行为原样收敛于此。 */
export class JsonlUsageBackend implements UsageStorageBackend {
  readonly filePath: string;
  private readonly maxBytes: number;
  /** 历史文件缓存：mtime+size 未变时复用上次解析结果（仪表盘 30s 轮询复用）。 */
  private cache: { mtimeMs: number; size: number; records: UsageRecord[] } | null = null;

  constructor(filePath: string = resolveUsageFilePath(), maxBytes: number = USAGE_MAX_BYTES) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
  }

  /** 追加记录行（串行化由调用方的写队列保证；这里只做目录保障与追加写）。 */
  append(entries: string[]): void {
    if (entries.length === 0) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.filePath, entries.map(e => e + '\n').join(''), 'utf-8');
    // 每 2s 最多 flush 一次（appendFileSync 本身立即落盘，此为保守节流说明）
  }

  /** 读取全部会话历史（JSONL 逐行解析，容错跳过损坏行）。 */
  loadAll(): UsageRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = null;
        return [];
      }
      const st = fs.statSync(this.filePath);
      if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) {
        return this.cache.records;
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const out: UsageRecord[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj === 'object' && typeof obj.timestamp === 'string') {
            out.push(obj as UsageRecord);
          }
        } catch {
          // 跳过损坏行
        }
      }
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, records: out };
      return out;
    } catch (err: any) {
      logger.warn(`[USAGE] Error reading usage history: ${err.message}`);
      return [];
    }
  }

  /** 清空全部历史（文件写空 + 失效读取缓存）。返回是否确有文件被清空。 */
  clear(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    fs.writeFileSync(this.filePath, '', 'utf-8');
    this.cache = null;
    return true;
  }

  /** 超限时保留文件后半（从中点后的第一条完整行起），整写替换。 */
  rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const size = fs.statSync(this.filePath).size;
      if (size < this.maxBytes) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const nl = raw.indexOf('\n', Math.floor(raw.length / 2));
      const kept = nl >= 0 ? raw.slice(nl + 1) : raw;
      // 临时文件名带 pid：固定名在两个实例共用同一数据目录时会互相踩，且 Windows 上
      // rename 覆盖被对方打开的文件会 EPERM（仓库自带的 usage-history-io.mjs 早就
      // 用了 pid 唯一 + 哨兵的写法，生产代码这里却漏了）。
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept, 'utf-8');
      fs.renameSync(tmp, this.filePath);
      logger.info(`[USAGE] Rotated usage history: ${(size / 1048576).toFixed(1)}MB -> ${(kept.length / 1048576).toFixed(1)}MB`);
    } catch (err: any) {
      logger.warn(`[USAGE] History rotation failed: ${err.message}`);
    }
  }

  /** JSONL 追加写本身是同步落盘的，无挂起写入。 */
  flush(): Promise<void> {
    return Promise.resolve();
  }
}
