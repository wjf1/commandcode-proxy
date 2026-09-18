// =============================================================================
// 对套餐内每个可用模型跑一次真实基准，为「端到端性能」面板播种初始数据
// -----------------------------------------------------------------------------
// 要点：这些是**真实请求**，打真实上游、花真实额度、由 proxy 记入用量历史。它们不
// 是伪造的数字——面板上的吞吐/延迟就是这一次实测的结果。为可追溯，每条请求都带
// 客户端声明的会话上下文（x-session-id / x-zcode-session-type=benchmark），因此在
// 会话表里能认出这批流量来自基准，而不是 agent 真实工作负载。
//
// 口径提醒（与面板一致，别误读）：
//   - 面板的吞吐是**端到端**吞吐 = 输出 token / 整个请求生命周期（含上游排队、重试、
//     网络），不等于模型生成速度。
//   - 提示词固定，让各模型的输出长度可比（t/s 受输出长度影响：短输出的首 token 时间
//     占比更高，会低估吞吐）。
//   - 串行执行。并发会让延迟与吞吐互相污染，测出来的数没有可比性。
//   - 一个模型只跑一次 → 该模型在面板上的 P50 就是这一次的测量值。这是「初始数据」
//     的固有限制，样本列会如实显示 1。
//
// 安全阀：每 BENCH_CHECK_EVERY 个模型查一次官方额度用量，5 小时窗口增量超过
// BENCH_MAX_USD 就中止，避免跑飞。
//
// 用法：
//   node bench-models.mjs              # 列出将要基准的模型，不发起请求
//   node bench-models.mjs --run        # 实际执行
// 环境变量：BENCH_PLAN / BENCH_MAX_USD / BENCH_LIMIT（只跑前 N 个，便于试探）
// =============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RUN = process.argv.includes('--run');
const PROXY = process.env.BENCH_BASE || 'http://127.0.0.1:9090';
const PLAN = process.env.BENCH_PLAN || 'individual-goat';
const LIMIT = Number(process.env.BENCH_LIMIT || 0);
const MAX_USD = Number(process.env.BENCH_MAX_USD || 4);
const CHECK_EVERY = 5;

// 固定提示词：要求一个长度确定、内容平凡、几乎不需要推理的输出，好让各模型的
// 输出 token 数落在同一量级。60 行整数约 150~200 token，稳稳越过面板的 32 token 闸门。
const PROMPT = 'List the integers from 1 to 60, one per line, and nothing else in your reply.';
const MAX_TOKENS = 1024;
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 150_000);

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SESSION_ID = `bench-${STAMP}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jget(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const fiveHourUsed = async () => {
  const j = await jget(`${PROXY}/api/usage/overview`);
  return j?.limits?.fiveHour?.used ?? null;
};

// 安全阀的成本口径：官方额度计数器（/alpha/billing/credits）粒度太粗——实测花掉
// $0.0197 后增量仍显示 0.0000，靠它兜不住。改为直接读 proxy 写下的本地用量历史，
// 按本次基准的 sessionId 精确累加，这才真的能拦住跑飞的消耗。
const USAGE_FILE = process.env.USAGE_HISTORY_PATH
  ? path.resolve(process.env.USAGE_HISTORY_PATH)
  : path.join(process.env.USERPROFILE || process.env.HOME || '', '.commandcode', 'usage-history.jsonl');

function spentSoFar() {
  try {
    return fs
      .readFileSync(USAGE_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => {
        try {
          const r = JSON.parse(line);
          return r.sessionId === SESSION_ID ? sum + (r.costUsd || 0) : sum;
        } catch {
          return sum;
        }
      }, 0);
  } catch {
    return null; // 读不到就不拦（总额预估仅约 $0.45，安全阀是双保险而非主防线）
  }
}

async function benchOne(model) {
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
    return { model, ok: false, wallMs: Date.now() - t0, error: err.name === 'TimeoutError' ? `超时 >${TIMEOUT_MS}ms` : err.message };
  }
  const wallMs = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    return { model, ok: false, wallMs, status: res.status, error: text.slice(0, 300) };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { model, ok: false, wallMs, error: `响应非 JSON：${text.slice(0, 200)}` };
  }
  const out = j?.usage?.completion_tokens ?? null;
  const inp = j?.usage?.prompt_tokens ?? null;
  return {
    model,
    ok: true,
    wallMs,
    outputTokens: out,
    inputTokens: inp,
    tokS: out && wallMs > 0 ? out / (wallMs / 1000) : null,
    // 面板记的耗时由 proxy 侧测得；本地墙钟与之比对，差得远说明中间有异常排队。
    contentPreview: (j?.choices?.[0]?.message?.content || '').slice(0, 60).replace(/\n/g, ' '),
  };
}

async function main() {
  const listing = await jget(`${PROXY}/v1/models?plan=${PLAN}&available=1`);
  let models = (listing.data || []).map(m => m.id);
  if (LIMIT > 0) models = models.slice(0, LIMIT);

  console.log(`套餐档位：${PLAN}   可用模型：${models.length} 个   基准会话：${SESSION_ID}`);
  if (!RUN) {
    console.log('\n（预演模式，未发起请求。加 --run 实际执行。）\n');
    models.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m}`));
    return;
  }

  const before = await fiveHourUsed();
  console.log(`起始 5 小时窗口已用：${before} USD；安全阀上限：+${MAX_USD} USD\n`);

  const results = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    let r = await benchOne(model);
    // 只对网络/服务端错误补一次；应用层错误（如模型不支持该参数）重试也没用。
    if (!r.ok && (r.error || r.status >= 500)) {
      await sleep(2000);
      r = await benchOne(model);
      r.retried = true;
    }
    results.push(r);
    const tag = r.ok ? `✓ ${String(r.outputTokens).padStart(4)} out  ${String(r.wallMs).padStart(6)}ms  ${(r.tokS || 0).toFixed(1)} t/s` : `✗ ${r.status || ''} ${r.error}`;
    console.log(`[${String(i + 1).padStart(2)}/${models.length}] ${model.padEnd(38)} ${tag}`);

    if ((i + 1) % CHECK_EVERY === 0) {
      const spent = spentSoFar();
      if (spent != null && spent > MAX_USD) {
        console.log(`\n⚠ 本次基准已消耗 $${spent.toFixed(4)}，超过安全阀 $${MAX_USD}，提前中止。`);
        break;
      }
    }
    await sleep(1000); // 串行 + 间隔，别把上游惹毛
  }

  const after = await fiveHourUsed().catch(() => null);
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  console.log(`\n完成：成功 ${ok.length} / ${results.length}，失败 ${failed.length}`);
  const spentTotal = spentSoFar();
  if (spentTotal != null) console.log(`本次基准累计成本：$${spentTotal.toFixed(4)}`);
  if (before != null && after != null && after - before > 0) {
    console.log(`官方 5 小时窗口：${before.toFixed(4)} → ${after.toFixed(4)} USD`);
  }
  if (failed.length) {
    console.log('\n失败清单：');
    for (const f of failed) console.log(`  ${f.model.padEnd(38)} ${f.status || ''} ${f.error}`);
  }
  // 输出长度是否落在可比区间
  const outToks = ok.map(r => r.outputTokens).filter(Boolean).sort((a, b) => a - b);
  if (outToks.length) {
    console.log(`\n输出 token：min ${outToks[0]} / p50 ${outToks[outToks.length >> 1]} / max ${outToks[outToks.length - 1]}`);
    const below = ok.filter(r => r.outputTokens < 32);
    if (below.length) console.log(`注意：${below.length} 个模型的输出 <32 token，会被面板的吞吐闸门挡掉：${below.map(r => r.model).join(', ')}`);
  }

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `bench-${STAMP}.json`);
  fs.writeFileSync(out, JSON.stringify({ session: SESSION_ID, plan: PLAN, prompt: PROMPT, maxTokens: MAX_TOKENS, results }, null, 2));
  console.log(`\n明细已写入：${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('基准失败：', err);
    process.exit(1);
  });
}
