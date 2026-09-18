// =============================================================================
// 用量历史安全读写（usage-history-io.mjs）
// -----------------------------------------------------------------------------
// 这是数据安全关键路径：purge 与 bench 两个工具都靠它覆盖写生产用量库，而 proxy 进程
// 在同一时刻仍在往那个文件追加记录。写错就是把用户数据丢掉，所以逐条锁定：
//   - 保留集/删除集正确；
//   - **调用之前**已被 proxy 追加的记录必须保留（历史 bug：payload 在循环外预先算好，
//     于是两次读取之间追加的记录连同旧快照一起被覆盖掉）；
//   - 遇到并发写入要重试，而不是硬写；
//   - 多次重试仍不稳定时返回失败且**不丢记录**；
//   - 残留的哨兵行不会被当成正常记录读回来。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRecords, rewriteSafely, backupFile } from '../usage-history-io.mjs';

let dir;
let file;

const rec = (id, extra = {}) =>
  JSON.stringify({
    timestamp: '2026-09-18T00:00:00.000Z',
    model: 'm',
    inputTokens: 1,
    outputTokens: 100,
    timingMs: 1000,
    costUsd: 0,
    hasPricing: true,
    status: 'COMPLETED',
    mode: 'chat',
    sessionId: id,
    ...extra,
  });

const write = ids => writeFileSync(file, ids.map(id => rec(id)).join('\n') + '\n', 'utf-8');
const idsOf = f => readRecords(f).map(r => r.sessionId);
const keepExcept = dropIds => records => {
  const keep = [];
  const drop = [];
  for (const r of records) (dropIds.includes(r.sessionId) ? drop : keep).push(r);
  return { keep, drop };
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'usage-io-'));
  file = path.join(dir, 'usage.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readRecords', () => {
  it('文件不存在时返回空数组', () => {
    expect(readRecords(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('跳过损坏行与残留的哨兵行', () => {
    writeFileSync(file, [rec('a'), '{broken', JSON.stringify({ __sentinel: 'x' }), rec('b')].join('\n') + '\n', 'utf-8');
    expect(idsOf(file)).toEqual(['a', 'b']);
  });
});

describe('rewriteSafely — 保留集与并发保护', () => {
  it('按 planFn 保留/删除，行数与内容都对得上', () => {
    write(['a', 'b', 'c', 'd']);
    const res = rewriteSafely(file, keepExcept(['b', 'd']), { label: 't' });
    expect(res.ok).toBe(true);
    expect(res.drop.map(r => r.sessionId)).toEqual(['b', 'd']);
    expect(idsOf(file)).toEqual(['a', 'c']);
  });

  it('保留集为空时写出空文件，而不是残留一条旧行', () => {
    write(['a', 'b']);
    const res = rewriteSafely(file, () => ({ keep: [], drop: readRecords(file) }), { label: 't' });
    expect(res.ok).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('');
    expect(readRecords(file)).toEqual([]);
  });

  // 回归：payload 曾由循环外的旧快照预先算好，导致"调用前刚追加的记录"被静默丢弃。
  it('调用 rewriteSafely 之前刚追加的记录会被保留（不被旧快照覆盖）', () => {
    write(['a']);
    // 模拟 proxy 在我们读取之后、写回之前追加了一条
    appendFileSync(file, rec('newcomer') + '\n');
    const res = rewriteSafely(file, keepExcept(['a']), { label: 't' });
    expect(res.ok).toBe(true);
    expect(idsOf(file)).toEqual(['newcomer']);
  });

  it('写入过程中出现并发追加 → 检测到尺寸变化并重试，最终两边都不丢', () => {
    write(['a', 'b']);
    let appended = false;
    const res = rewriteSafely(
      file,
      records => {
        if (!appended) {
          appended = true;
          appendFileSync(file, rec('concurrent') + '\n'); // 让首次尝试的尺寸校验失败
        }
        return keepExcept([])(records);
      },
      { label: 't' },
    );
    expect(res.ok).toBe(true);
    expect(res.attempts).toBeGreaterThan(1); // 确实走了重试
    expect(idsOf(file).sort()).toEqual(['a', 'b', 'concurrent']);
  });

  it('快照始终不稳定时返回 ok=false，且不丢任何记录', () => {
    write(['a', 'b']);
    const res = rewriteSafely(
      file,
      records => {
        appendFileSync(file, rec('noise') + '\n'); // 每次尝试都制造并发写入
        return keepExcept([])(records);
      },
      { label: 't', attempts: 3 },
    );
    expect(res.ok).toBe(false);
    // 没有任何记录被删掉（噪声行与原始行都还在）
    const ids = idsOf(file);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids.filter(x => x === 'noise')).toHaveLength(3);
  });
});

describe('backupFile', () => {
  it('生成带时间戳的副本，内容与原文件一致', () => {
    write(['a', 'b']);
    const dest = backupFile(file, 'backup');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe(readFileSync(file, 'utf-8'));
    expect(dest).toContain('.backup-');
  });
});
