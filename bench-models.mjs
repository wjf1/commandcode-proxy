// =============================================================================
// 对套餐内每个可用模型跑真实基准，为「端到端性能」面板播种初始数据
// -----------------------------------------------------------------------------
// 要点：这些是**真实请求**，打真实上游、花真实额度、由 proxy 记入用量历史。它们不
// 是伪造的数字——面板上的吞吐/延迟就是这几次实测的结果。为可追溯，每条请求都带
// 客户端声明的会话上下文（x-session-id / x-zcode-session-type=benchmark），因此在
// 会话表里能认出这批流量来自基准，而不是 agent 真实工作负载。
//
// 口径提醒（与面板一致，别误读）：
//   - 面板的吞吐是**端到端**吞吐 = 输出 token / 整个请求生命周期（含上游排队、重试、
//     网络），不等于模型生成速度。
//   - 提示词固定，让各模型的输出长度可比（t/s 受输出长度影响：短输出的首 token 时间
//     占比更高，会低估吞吐）。
//   - 串行执行。并发会让延迟与吞吐互相污染，测出来的数没有可比性。
//   - `--rounds N` 让每个模型跑 N 次。单轮只能得到「一次探针」，面板上的 P50 就是那一
//     次的值；多轮才能给出稳定的中位数。同一个模型的 N 轮连续执行，条件更一致。
//
// 安全阀：每 BENCH_CHECK_EVERY 个模型按本次会话的 sessionId 从本地用量历史精确累加已
// 花成本，超过 BENCH_MAX_USD 就中止，避免跑飞。刻意不用官方额度计数器（实测花掉
// $0.0197 后增量仍显示 0.0000，粒度太粗拦不住）。
//
// 用法：
//   node bench-models.mjs                        # 预演，列出将基准的模型
//   node bench-models.mjs --run --rounds 5        # 每个模型 5 轮
//   node bench-models.mjs --run --rounds 5 --replace   # 先清掉历史基准记录再跑
//
// 环境变量：BENCH_PLAN / BENCH_MAX_USD / BENCH_LIMIT / BENCH_TIMEOUT_MS / USAGE_HISTORY_PATH
// =============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveUsageFile, readRecords, rewriteSafely, backupFile } from './usage-history-io.mjs';

const RUN = process.argv.includes('--run');
const REPLACE = process.argv.includes('--replace');
const PROXY = process.env.BENCH_BASE || 'http://127.0.0.1:9090';
const PLAN = process.env.BENCH_PLAN || 'individual-goat';
const LIMIT = Number(process.env.BENCH_LIMIT || 0);
const ROUNDS = Math.max(1, Number(process.env.BENCH_ROUNDS || argValue('--rounds') || 1));
const MAX_USD = Number(process.env.BENCH_MAX_USD || 4);
const CHECK_EVERY = 5;

/** 取 `--rounds 5` / `--rounds=5` 两种写法的值。 */
function argValue(name) {
  const withEq = process.argv.find(a => a.startsWith(`${name}=`));
  if (withEq) return withEq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 固定提示词：要求一个长度确定、内容平凡、几乎不需要推理的输出，好让各模型的
// 输出 token 数落在同一量级。60 行整数约 150~200 token，稳稳越过面板的 32 token 闸门。
const PROMPT = 'List the integers from 1 to 60, one per line, and nothing else in your reply.';
const MAX_TOKENS = 1024;
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 150_000);

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SESSION_ID = `bench-${STAMP}`;
const USAGE_FILE = resolveUsageFile();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 本次基准会话的 sessionId 前缀，用于识别所有基准流量（含历史轮次）。 */
const BENCH_PREFIX = 'bench-';
const isBenchRecord = r => typeof r?.sessionId === 'string' && r.sessionId.startsWith(BENCH_PREFIX);

async function jget(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** 本次会话累计成本：只算当前 SESSION_ID 的记录，安全阀据此判断。 */
function spentSoFar() {
  return readRecords(USAGE_FILE)
    .filter(r => r.sessionId === SESSION_ID)
    .reduce((s, r) => s + (r.costUsd || 0), 0);
}

async function benchOne(model, round) {
  const body = {
    model,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: MAX_TOKENS,
    stream: false,
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 客户端声明的上下文：让这批流量在面板上可识别、可追溯，不冒充 agent 工作负载。
        'x-session-id': SESSION_ID,
        'x-zcode-session-type': 'benchmark',
        'x-zcode-agent': 'bench',
        'x-client-timezone': 'Etc/GMT-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { model, round, ok: false, wallMs: Date.now() - t0, error: err.name === 'TimeoutError' ? `超时 >${TIMEOUT_MS}ms` : err.message };
  }
  const wallMs = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    return { model, round, ok: false, wallMs, status: res.status, error: text.slice(0, 300) };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { model, round, ok: false, wallMs, error: `响应非 JSON：${text.slice(0, 200)}` };
  }
  const out = j?.usage?.completion_tokens ?? null;
  return {
    model,
    round,
    ok: true,
    wallMs,
    outputTokens: out,
    inputTokens: j?.usage?.prompt_tokens ?? null,
    tokS: out && wallMs > 0 ? out / (wallMs / 1000) : null,
    // 面板记的耗时由 proxy 侧测得；本地墙钟与之比对，差得远说明中间有异常排队。
    contentPreview: (j?.choices?.[0]?.message?.content || '').slice(0, 60).replace(/\n/g, ' '),
  };
}

/**
 * 清掉历史基准记录（--replace）。
 *
 * 为什么必须先清：面板的 P50 是把该模型的**所有**记录一起算的。旧的单轮探针与新跑的多
 * 轮样本混在一起，"替换数据"就变成了"掺入数据"，中位数被单次探针拉偏。
 * 写盘前备份 + 被删记录留档，并借用 usage-history-io 的并发写保护（proxy 仍在写文件）。
 */
function removePreviousBenchRecords() {
  const all = readRecords(USAGE_FILE);
  const victims = all.filter(isBenchRecord);
  if (!victims.length) {
    console.log('未发现历史基准记录，无需清理。\n');
    return;
  }
  const backup = backupFile(USAGE_FILE, 'backup');
  const archive = `${USAGE_FILE}.bench-removed-${STAMP}`;
  fs.writeFileSync(archive, victims.map(r => JSON.stringify(r)).join('\n') + '\n');

  const res = rewriteSafely(USAGE_FILE, records => {
    const keep = [];
    const drop = [];
    for (const r of records) (isBenchRecord(r) ? drop : keep).push(r);
    return { keep, drop };
  }, { label: 'bench-replace' });

  if (!res.ok) {
    console.error(`清理历史基准记录失败（${res.attempts} 次重试仍未拿到稳定快照）。文件未被修改，请重试。`);
    process.exit(2);
  }
  console.log(`已清除历史基准记录 ${res.drop.length} 条（原有 ${all.length} 条 → 现有 ${res.keep.length} 条）`);
  console.log(`  完整备份：${backup}`);
  console.log(`  被清记录留档：${archive}\n`);
}

/** 单模型多轮结果的汇总。 */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const listing = await jget(`${PROXY}/v1/models?plan=${PLAN}&available=1`);
  let models = (listing.data || []).map(m => m.id);
  if (LIMIT > 0) models = models.slice(0, LIMIT);

  const total = models.length * ROUNDS;
  console.log(`套餐档位：${PLAN}   可用模型：${models.length} 个   每模型轮次：${ROUNDS}   计划请求：${total}`);
  console.log(`基准会话：${SESSION_ID}`);
  if (!RUN) {
    console.log('\n（预演模式，未发起请求。加 --run 实际执行。）\n');
    models.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m}`));
    return;
  }

  if (REPLACE) removePreviousBenchRecords();

  const before = await jget(`${PROXY}/api/usage/overview`).then(j => j?.limits?.fiveHour?.used).catch(() => null);
  console.log(`安全阀：本次会话累计成本超过 $${MAX_USD} 即中止\n`);

  const results = [];
  let aborted = false;
  for (let mi = 0; mi < models.length && !aborted; mi++) {
    const model = models[mi];
    const rounds = [];
    for (let r = 1; r <= ROUNDS; r++) {
      let res = await benchOne(model, r);
      // 只对网络/服务端错误补一次；应用层错误（如模型区域受限）重试无益。
      if (!res.ok && (res.error || res.status >= 500)) {
        await sleep(2000);
        res = await benchOne(model, r);
        res.retried = true;
      }
      rounds.push(res);
      const tag = res.ok
        ? `${String(res.outputTokens).padStart(4)} out ${String(res.wallMs).padStart(6)}ms ${(res.tokS || 0).toFixed(1)} t/s`
        : `✗ ${res.status || ''} ${res.error}`;
      console.log(`[${String(mi + 1).padStart(2)}/${models.length}] ${model.padEnd(36)} r${r} ${tag}`);

      if (spentSoFar() > MAX_USD) {
        console.log(`\n⚠ 本次基准已消耗超过 $${MAX_USD}，提前中止。`);
        aborted = true;
        break;
      }
      await sleep(1000); // 串行 + 间隔，别把上游惹毛
    }
    results.push({ model, rounds });

    if ((mi + 1) % CHECK_EVERY === 0) {
      const spent = spentSoFar();
      console.log(`    … 已完成 ${mi + 1}/${models.length} 个模型，累计成本 $${spent.toFixed(4)}`);
    }
  }

  // ── 汇总 ──
  const flat = results.flatMap(x => x.rounds);
  const okRounds = flat.filter(r => r.ok);
  const usable = okRounds.filter(r => r.outputTokens >= 32);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`请求数 ${flat.length}：成功 ${okRounds.length}，失败 ${flat.length - okRounds.length}`);
  console.log(`其中输出 ≥32 token（面板吞吐闸门之内）的 ${usable.length} 条`);
  console.log(`本次基准累计成本：$${spentSoFar().toFixed(4)}`);

  console.log(`\n按模型汇总（吞吐中位数 / 延迟中位数，仅统计可用轮次）：`);
  const summary = results.map(({ model, rounds }) => {
    const good = rounds.filter(r => r.ok && r.outputTokens >= 32);
    const tokS = good.map(r => r.tokS);
    const lat = good.map(r => r.wallMs);
    return {
      model,
      okCount: good.length,
      rounds: rounds.length,
      tokSMedian: median(tokS),
      latMedianMs: median(lat),
      outTokens: median(good.map(r => r.outputTokens)),
      failedRounds: rounds.filter(r => !r.ok).length,
      emptyRounds: rounds.filter(r => r.ok && r.outputTokens < 32).length,
    };
  });
  for (const s of summary) {
    const t = s.tokSMedian == null ? '   —' : s.tokSMedian.toFixed(1);
    const l = s.latMedianMs == null ? '   —' : Math.round(s.latMedianMs) + 'ms';
    const note = [];
    if (s.failedRounds) note.push(`${s.failedRounds} 轮请求失败`);
    if (s.emptyRounds) note.push(`${s.emptyRounds} 轮输出过短`);
    console.log(`  ${s.model.padEnd(36)} ${String(s.okCount) + '/' + s.rounds} 轮  ${t.padStart(7)} t/s  ${l.padStart(9)}  ${note.join(' · ')}`);
  }

  const neverOk = summary.filter(s => s.okCount === 0);
  if (neverOk.length) {
    console.log(`\n⚠ 全程拿不到可用样本的模型 ${neverOk.length} 个（上游不可用/区域受限，非提示词问题）：`);
    for (const s of neverOk) {
      const r = results.find(x => x.model === s.model).rounds[0];
      console.log(`  ${s.model.padEnd(36)} ${r.status || ''} ${(r.error || '').slice(0, 110)}`);
    }
  }

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `bench-${STAMP}.json`);
  fs.writeFileSync(out, JSON.stringify({ session: SESSION_ID, plan: PLAN, rounds: ROUNDS, prompt: PROMPT, maxTokens: MAX_TOKENS, summary, results }, null, 2));
  console.log(`\n明细已写入：${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('基准失败：', err);
    process.exit(1);
  });
}
