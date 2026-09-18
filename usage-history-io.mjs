// =============================================================================
// 用量历史（usage-history.jsonl）的安全读写 —— purge / bench 两个维护工具共用
// -----------------------------------------------------------------------------
// 这个文件是计费与性能面板的数据源，而 proxy 进程在工具运行期间**仍在往它追加记录**
// （你自己的 agent 会话就在写）。因此"读全量 → 过滤 → 覆盖写回"这个朴素做法会丢数据，
// 必须做并发保护。两个工具都需要这套逻辑，抽到一处避免两份实现各自出错。
//
// 保护手段（rewriteSafely）：
//   1. 先向文件追加一个唯一哨兵行；
//   2. 读回全量，确认哨兵就是最后一行——否则说明读取期间有新写入，本次快照不完整，重试；
//   3. 由**本次快照**重新计算保留集并生成 payload（绝不在循环外预先算好，否则两次读取
//      之间 proxy 追加的记录会连同旧快照一起被覆盖掉）；
//   4. 写临时文件后校验文件尺寸未变，最后原子 rename。
//
// 残余风险（已知且刻意不处理）：第 4 步的 statSync 与 renameSync 之间有微秒级窗口，期间
// 若恰好有并发追加，那条记录会丢失。窗口小到需要跨进程精确插桩才可能命中，代价是一条
// 几百字节的日志行；为此再加一层写回校验会让代码复杂度超过收益。调用方应知晓这一点。
// =============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 用量历史文件路径：尊重 USAGE_HISTORY_PATH，否则取 ~/.commandcode/usage-history.jsonl。 */
export function resolveUsageFile() {
  if (process.env.USAGE_HISTORY_PATH) return path.resolve(process.env.USAGE_HISTORY_PATH);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.commandcode', 'usage-history.jsonl');
}

function parseLine(line) {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;
    // 跳过重写过程留下的哨兵行（重试失败时它们会残留在文件里）。
    if (obj.__sentinel) return null;
    return obj;
  } catch {
    return null; // 跳过损坏行（proxy 也会跳过）
  }
}

/** 读全量记录。文件不存在返回空数组。 */
export function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseLine)
    .filter(Boolean);
}

/**
 * 带并发写保护的原地替换。
 * @param planFn (records) => { keep, drop } —— 纯函数，会在每次尝试时用最新快照调用
 * @returns { ok, keep, drop, attempts } —— ok=false 表示多次重试都没拿到稳定快照，文件未被修改
 */
export function rewriteSafely(file, planFn, { attempts = 6, label = 'rewrite' } = {}) {
  const tmp = path.join(path.dirname(file), `.${label}-tmp-${process.pid}`);

  for (let i = 0; i < attempts; i++) {
    const tag = `__${label}_sentinel_${process.pid}_${Date.now()}_${i}`;
    const sentinel = JSON.stringify({ __sentinel: tag });
    fs.appendFileSync(file, sentinel + '\n');

    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    // 读取期间若有并发写入落在哨兵之后，本次快照就不完整，重来。
    if (!raw.trimEnd().endsWith(sentinel)) continue;
    if (lines.filter(l => l.includes(tag)).length !== 1) continue;
    const sizeAtRead = fs.statSync(file).size;

    // 哨兵之前的所有行就是本次快照（哨兵之后为空，上面已校验）。
    const snapshot = lines
      .slice(0, lines.findIndex(l => l.trim() === sentinel))
      .filter(Boolean)
      .map(parseLine)
      .filter(Boolean);

    const { keep, drop } = planFn(snapshot);
    // payload 必须由本次快照构建，见文件头第 3 条。
    const payload = keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '');

    fs.writeFileSync(tmp, payload);
    if (fs.statSync(file).size !== sizeAtRead) {
      fs.rmSync(tmp, { force: true });
      continue; // 期间有并发写入，丢弃本次结果重来
    }
    fs.renameSync(tmp, file);
    return { ok: true, keep, drop, attempts: i + 1 };
  }

  fs.rmSync(tmp, { force: true });
  return { ok: false, attempts };
}

/** 写一份带时间戳的备份，返回备份路径。 */
export function backupFile(file, suffix = 'backup') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.${suffix}-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}
