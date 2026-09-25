// =============================================================================
// 流水线阶段 4：流包装与首事件探测
// -----------------------------------------------------------------------------
// 职责：
//   1. web → Node Readable 包装，空闲看门狗随每个 chunk 重置（wrapUpstreamStream）。
//   2. 挂钟/空闲超时触发时向已交还的流注入语义正确的 UpstreamError。
//   3. 首事件探测（probeUpstream 及其判定函数族）：上游以 HTTP 200 的流内 error
//      事件报错且尚未产出任何内容时，丢弃本次调用交给编排层重试。
//
// 状态归属：wrapUpstreamStream 内部的 discarded 标志由返回句柄的 markDiscarded()
// 显式开启（探测拒绝时编排层调用）；并发槽位释放通过 onStreamGone 回调注入，
// 槽位语义完全归编排层。
// =============================================================================
import { Readable, PassThrough } from 'node:stream';
import { terminalCodeFor, ErrorCode } from '../../../utils/errors.js';
import { UpstreamError } from './errors.js';
import type { AttemptTimeouts } from './timeouts.js';

/**
 * error 事件里的错误文本是否值得重试。
 *
 * 只重试「看起来是瞬时」的失败：网关请求失败、服务过载、无可用 provider —— 这些随时段
 * 与容量波动，下一次很可能就好了。确定性不可用的（区域限制、模型/provider 不认识）
 * 重试只会白耗额度：本机实测的失败请求带着 29 万 token 上下文，单次就是 $0.087，
 * 白重试两次是 $0.26 换一个必然相同的错误。
 *
 * 计费/套餐类终止错误复用既有的 terminalCodeFor 判定，不在这里重复维护模式表。
 */
export function isRetryableEventMessage(message: string): boolean {
  const m = (message || '').trim();
  if (!m) return false;
  if (terminalCodeFor(m) !== undefined) return false;
  const lower = m.toLowerCase();
  return !DETERMINISTIC_UNAVAILABLE.some(s => lower.includes(s))
    && !DETERMINISTIC_REQUEST_SHAPE.some(s => lower.includes(s));
}

/** error 事件里代表「确定性不可用」的文本特征（全小写比较）。 */
const DETERMINISTIC_UNAVAILABLE = [
  'not available in your region',
  'not available in your country',
  'model/provider not recognized',
  'not in your plan',
  'model_not_in_plan',
  'does not exist',
  'invalid api key',
];

/**
 * 「请求形态本身不对」的确定性错误特征（全小写比较）。
 *
 * 判据此前只有 DETERMINISTIC_UNAVAILABLE 这一张否决表，落在表外的文案一律重试 ——
 * 于是上游校验层拒绝的请求（实测的 zod 式 `Too big: expected number to be <=200000`）
 * 会被打满整个重试预算。本机实测 maxRetries=2 时上游被连打 3 次、多花 1.5s 退避，
 * 换回必然相同的错误；29 万 token 的上下文单次就是 $0.087。
 *
 * 只收结构化、几乎不可能出现在瞬时故障里的片段：判错的代价是"用户白等一轮"，
 * 所以宁可漏收也不要宽收。注意 `Invalid error response format:` 只是网关的**包装前缀**，
 * 瞬时与确定性错误都带它，绝不能作为特征。
 */
const DETERMINISTIC_REQUEST_SHAPE = [
  'too big:',
  'too small:',
  'expected number to be',
  // 校验器有时吐原始 issue code，有时吐人类可读文案，两种形态都收。
  'unrecognized_keys',
  'unrecognized key',
  'invalid_enum_value',
  'invalid enum value',
  'invalid_literal',
  'received additional arguments',
  'invalid_type',
  'context length exceeded',
  'context window exceeded',
  'prompt is too long',
];

/** 携带内容或会改变客户端流状态、一旦转发就不能再重来的 CC 事件类型。 */
const CONTENT_EVENT_TYPES = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-call',
  'tool-call-delta',
  'finish',
  'finish-step',
]);

/**
 * 判定单个 CC 事件在「能否丢弃重试」上的含义。
 *   - error 且消息可重试 → 'retry'（上游还没产出任何内容就失败了）
 *   - error 但确定性不可用 → 'accept'（重试也白搭，按既有逻辑原样交出去）
 *   - 内容类事件 → 'accept'（已经开始产出，不能再丢）
 *   - 其余（start / 保活 / 未知元数据）→ 'ignore'（不影响判定，继续看）
 */
export function classifyProbeEvent(event: any): 'retry' | 'accept' | 'ignore' {
  if (!event || typeof event.type !== 'string') return 'ignore';
  if (event.type === 'error') {
    const errObj = event.error ?? event;
    const msg = typeof errObj === 'string' ? errObj : errObj?.message;
    return isRetryableEventMessage(msg || '') ? 'retry' : 'accept';
  }
  return CONTENT_EVENT_TYPES.has(event.type) ? 'accept' : 'ignore';
}

/**
 * 扫描已累积文本里**完整的行**并按顺序判定。
 * 最后一段可能是被截断的半行，不能判定，留给下一次数据到达。
 * 返回已扫描到的行号，避免重复判定同一行。
 */
export function classifyBuffered(
  text: string,
  alreadyScanned: number,
): { verdict: 'retry' | 'accept' | 'ignore'; scanned: number } {
  const lines = text.split('\n');
  const complete = lines.length - 1;
  for (let i = alreadyScanned; i < complete; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const payload = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!payload || payload === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue; // 注释行或非法 JSON，跳过
    }
    const verdict = classifyProbeEvent(ev);
    if (verdict !== 'ignore') return { verdict, scanned: complete };
  }
  return { verdict: 'ignore', scanned: complete };
}

/** 探测缓冲的字节上限：还没攒出可判定的事件就别再攒了，直接放行。 */
const PROBE_MAX_BYTES = 64 * 1024;
/** 探测的时间上限：上游迟迟不吐可判定的事件就放行，不为判别而拖住请求。 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * 从已累积文本里取第一个完整的 SSE 事件负载。
 * 返回 found=false 表示还没攒到完整事件（最后一段可能是被截断的半行，不能判定）。
 */
export function firstEventPayload(text: string): { found: boolean; payload?: string } {
  const lines = text.split('\n');
  for (const line of lines.slice(0, -1)) {
    const t = line.trim();
    if (!t || t.startsWith(':')) continue; // 空行 / SSE 注释（保活）
    const payload = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!payload || payload === '[DONE]') continue;
    return { found: true, payload };
  }
  return { found: false };
}

/**
 * 预读流开头，判定「上游是否在产出任何内容之前就报错了」。
 *
 * 已读字节不会丢：判定为放行时把它们写回返回流的最前面，其余原样透传。预读期间会
 * `pause()`，确保从摘掉监听器到接上管道之间不会有 chunk 落在空档里被丢掉。
 */
export async function probeUpstream(raw: Readable): Promise<{ rejected: boolean; stream: Readable }> {
  const head: Buffer[] = [];
  const state: { verdict: 'retry' | 'accept' | 'ignore' } = { verdict: 'ignore' };
  let scannedLines = 0;
  let consumedBytes = 0;

  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      // 先暂停再摘监听器：否则空档期到达的 chunk 会流向已无消费者的流而丢失。
      raw.pause();
      raw.off('data', onData);
      raw.off('end', finish);
      raw.off('close', finish);
      raw.off('error', finish);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      head.push(buf);
      consumedBytes += buf.length;
      const text = Buffer.concat(head).toString('utf8');
      const res = classifyBuffered(text, scannedLines);
      scannedLines = res.scanned;
      if (res.verdict !== 'ignore') {
        state.verdict = res.verdict;
        finish();
      } else if (consumedBytes > PROBE_MAX_BYTES) {
        finish(); // 攒不出可判定的事件，放行
      }
    };
    // finish 只会在计时器触发或数据事件里被调用，那时 timer 已初始化。
    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    raw.on('data', onData);
    raw.once('end', finish);
    raw.once('close', finish);
    raw.once('error', finish);
  });

  if (state.verdict === 'retry') {
    raw.destroy();
    return { rejected: true, stream: raw };
  }
  return { rejected: false, stream: reflow(raw, head) };
}

/** 把预读到的字节放在新流的最前面，其余从原流透传。 */
function reflow(raw: Readable, head: Buffer[]): Readable {
  const out = new PassThrough();
  const buffered = Buffer.concat(head);
  if (buffered.length) out.write(buffered);
  const errored = (raw as any).errored;
  if (errored) {
    out.destroy(errored);
  } else if (raw.readableEnded || raw.destroyed) {
    out.end(); // 极短响应：预读期间就已结束，别让下游等一个永不到来的 end
  } else {
    raw.on('error', e => out.destroy(e));
    raw.pipe(out); // pipe 会自动 resume
  }
  return out;
}

export interface WrappedUpstreamStream {
  stream: Readable;
  /** 首事件探测判定丢弃时先调用：被丢弃的流消失时不归还并发槽位。 */
  markDiscarded(): void;
}

/**
 * 把上游 web 响应体包装为 Node Readable：
 *   - 每收到一个 chunk 重置空闲看门狗；
 *   - 流消失（close/error）时撤销计时器并归还并发槽位（onStreamGone）；
 *   - 挂钟/空闲超时在流交还之后触发时，向流注入语义正确的 UpstreamError。
 */
export function wrapUpstreamStream(args: {
  webBody: unknown;
  timeouts: AttemptTimeouts;
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
  /** 流消失时归还并发槽位（编排层注入；被丢弃的流除外）。 */
  onStreamGone: () => void;
}): WrappedUpstreamStream {
  const { webBody, timeouts, onStreamGone } = args;

  // 把 web stream 包装成 Node 流：每收到一个 chunk 都重置空闲看门狗。
  const rawStream = Readable.fromWeb(webBody as any);
  timeouts.armIdleWatchdog();
  rawStream.on('data', () => timeouts.armIdleWatchdog());

  // 被首事件探测判定为「上游以 200 报错」而丢弃的流，不要把并发槽位还回去 ——
  // 槽位要留给紧随其后的那次重试（槽位在整个 sendToCC 调用里只申请一次）。
  let discarded = false;
  const handleStreamGone = () => {
    timeouts.dispose();
    if (!discarded) onStreamGone();
  };
  rawStream.on('close', handleStreamGone);
  rawStream.on('error', handleStreamGone);

  // 流已经交还调用方之后再被挂钟上限掐断时，必须替换成一个「不像 abort」的错误对象：
  // 两条路由的 upstreamStream.on('error') 都先用 isAbortError(err) 判定"客户端自己
  // 走了"，命中就静默 reply.raw.end()，既不发 error 事件也不落 FAILED。裸 AbortError
  // 会命中那条分支，于是超时在客户端侧的表现是"模型答到一半自己停了"。
  // AbortSignal 的 abort 监听器是同步派发的，因此这里 destroy(err) 会先于 fetch
  // 自己抛出的 AbortError 到达调用方。错误文案刻意不含 "abort" 子串（isAbortError
  // 的判据之一）。
  timeouts.signal.addEventListener('abort', () => {
    if (rawStream.destroyed) return;
    if (timeouts.deadlineFired) {
      rawStream.destroy(new UpstreamError(
        `Upstream exceeded ${args.upstreamTimeoutMs / 1000}s total deadline`,
        504,
        false,
        ErrorCode.REQUEST_TIMEOUT,
      ));
    } else if (timeouts.idleFired) {
      // 空闲看门狗本来就会带一句不含 "abort" 子串的 abort reason，所以它并不会
      // 像挂钟上限那样被误判成"客户端自己走了"。但裸 Error 到路由里走的是
      // toProxyError 的兜底分类，会被记成 PROVIDER_PROTOCOL_ERROR（502 语义）。
      // "上游卡住不吐字节"是超时而不是协议错误：给成 UpstreamError 后客户端能按
      // STREAM_IDLE_TIMEOUT/504 分支重试，落库的失败原因也随之正确。
      rawStream.destroy(new UpstreamError(
        `No data from upstream for ${args.idleTimeoutMs / 1000}s`,
        504,
        false,
        ErrorCode.STREAM_IDLE_TIMEOUT,
      ));
    }
  }, { once: true });

  return {
    stream: rawStream,
    markDiscarded() { discarded = true; },
  };
}
