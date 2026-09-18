// =============================================================================
// 从用量历史中剔除集成测试残留记录（一次性维护工具）
// -----------------------------------------------------------------------------
// 背景：tests/integration.test.ts 曾用 `{...process.env}` 拉起真实 proxy，却只隔离了
// config/models/pricing 三个状态文件，漏掉 USAGE_HISTORY_PATH —— 于是套件对**本机 mock
// 上游**发出的每次调用（3 / 17 / 25 token、十几毫秒）都追加进了生产用量库
// ~/.commandcode/usage-history.jsonl。性能面板直接读这个文件，结果是完全没有真实流量
// 的模型（claude-sonnet-5 等）在面板上显示 2000+ t/s 的假吞吐与 19ms 的假延迟。
//
// 该泄漏已在 tests/integration.test.ts 中修复；本脚本用于清理已产生的历史脏数据。
//
// 判定谓词（必须全部满足，宁可漏删不可误删）：
//   - status === 'COMPLETED'
//   - 无 sessionId、无 project、无 agent        —— 没有任何真实调用上下文
//   - timingMs < 300                            —— 跨公网调用的实测下界是 2245ms，
//                                                  <300ms 只可能来自本机 mock 上游
//   - 模型是纯测试模型（从无带 sessionId 的真实流量）
//
// 安全措施：
//   - 默认 dry-run，必须显式 --apply 才写盘
//   - 写盘前把原文件完整备份，并把被删除的记录单独留档（审计用）
//   - 哨兵行 + 前后尺寸校验 + 重试：避免与本机正在写入的 proxy 抢文件导致丢记录
//
// 用法：
//   node purge-test-usage.mjs            # 预演，只报告
//   node purge-test-usage.mjs --apply    # 实际清理
// 可用 USAGE_HISTORY_PATH 指向其它文件。
// =============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveUsageFile, readRecords, rewriteSafely, backupFile } from './usage-history-io.mjs';

const APPLY = process.argv.includes('--apply');
const MIN_CONNECTED_MS = 300;

const FILE = resolveUsageFile();

/** 判定一条记录是否为集成测试残留（纯函数，便于在测试中锁定）。 */
export function isTestNoise(record, modelsWithRealTraffic) {
  if (!record || typeof record !== 'object') return false;
  if (record.status !== 'COMPLETED') return false;
  if (record.sessionId || record.project || record.agent || record.sessionType) return false;
  if (!Number.isFinite(record.timingMs) || record.timingMs >= MIN_CONNECTED_MS) return false;
  return !modelsWithRealTraffic.has(record.model);
}

function plan(records) {
  // 「有真实流量」= 该模型至少有一条带客户端上下文（sessionId/project/agent）的记录。
  // 这些模型整体豁免，哪怕其中混着几条短耗时记录也不动 —— 避免误删真实数据。
  const modelsWithRealTraffic = new Set();
  for (const r of records) {
    if (r.sessionId || r.project || r.agent) modelsWithRealTraffic.add(r.model);
  }
  const keep = [];
  const drop = [];
  for (const r of records) (isTestNoise(r, modelsWithRealTraffic) ? drop : keep).push(r);
  return { keep, drop, modelsWithRealTraffic };
}

function main() {
  const records = readRecords(FILE);
  if (!records.length && !fs.existsSync(FILE)) {
    console.error(`找不到用量历史文件：${FILE}`);
    process.exit(1);
  }

  const { keep, drop } = plan(records);

  console.log(`文件：${FILE}`);
  console.log(`记录总数：${records.length}`);
  console.log(`判定为测试残留：${drop.length} 条`);
  console.log(`正常记录：${keep.length} 条`);

  if (drop.length) {
    const byModel = {};
    for (const r of drop) {
      const b = (byModel[r.model] ||= { n: 0, out: 0, cost: 0, pairs: {} });
      b.n++;
      b.out += r.outputTokens || 0;
      b.cost += r.costUsd || 0;
      b.pairs[`${r.inputTokens}/${r.outputTokens}`] = (b.pairs[`${r.inputTokens}/${r.outputTokens}`] || 0) + 1;
    }
    console.log('\n按模型：');
    for (const [m, b] of Object.entries(byModel).sort((a, c) => c[1].n - a[1].n)) {
      const pairs = Object.entries(b.pairs).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ');
      console.log(`  ${m.padEnd(38)} ${String(b.n).padStart(4)} 条  ${b.out} 输出 token  $${b.cost.toFixed(6)}  [${pairs}]`);
    }
  }

  if (!APPLY) {
    console.log('\n（预演模式，未写盘。加 --apply 执行实际清理。）');
    return;
  }
  if (!drop.length) {
    console.log('\n没有需要清理的记录。');
    return;
  }

  const backup = backupFile(FILE, 'backup');
  const stamp = backup.replace(`${FILE}.backup-`, '');
  const removed = `${FILE}.removed-${stamp}`;
  fs.writeFileSync(removed, drop.map(r => JSON.stringify(r)).join('\n') + '\n');

  const res = rewriteSafely(FILE, plan, { label: 'purge' });
  if (!res.ok) {
    console.error(`\n替换失败（${res.attempts} 次重试仍未拿到稳定快照）。文件未被修改，请稍后重试。`);
    process.exit(2);
  }

  const after = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).length;
  console.log(`\n完成（${res.attempts} 次尝试）。原有 ${records.length} 条 → 现有 ${after} 条。`);
  console.log(`完整备份：${backup}`);
  console.log(`被移除记录留档：${removed}`);
  // 数量对不上只可能是清理窗口内 proxy 追加了新记录（rewriteSafely 会用最新快照重算）。
  if (after !== res.keep.length) {
    console.log(`注：清理期间 proxy 又写入了 ${after - res.keep.length} 条新记录（已保留）。`);
  }
}

// 仅在被直接执行时跑 main；被测试 import 时只暴露纯函数。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
