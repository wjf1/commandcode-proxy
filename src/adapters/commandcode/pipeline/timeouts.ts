// =============================================================================
// 流水线阶段 1：超时与信号装配
// -----------------------------------------------------------------------------
// 每次 attempt（尝试）武装两套计时器：
//   - 挂钟总时限（upstreamTimeoutMs）：从本次尝试开始一次性生效，跨"等响应头"
//     与"读流"两个阶段，直到流结束才撤销；
//   - 空闲看门狗（idleTimeoutMs）：每次被调用都重置，覆盖整个请求生命周期。
// 两者与客户端中止信号合并为一个 AbortSignal（timeouts.signal），交给受控
// 请求阶段作为 fetch 的 signal。
//
// 状态归属：计时器句柄与 fired 标志全部封装在本模块返回的对象里，编排层与
// 下游阶段只通过显式接口读写，不共享可变闭包变量。
// =============================================================================

export interface AttemptTimeoutConfig {
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface AttemptTimeouts {
  /** 合并客户端中止与本地超时后的信号，交给受控请求阶段（fetch 的 signal）。 */
  readonly signal: AbortSignal;
  armDeadline(): void;
  disarmDeadline(): void;
  armIdleWatchdog(): void;
  /** 挂钟上限是否已触发（错误分类时区分成因用）。 */
  readonly deadlineFired: boolean;
  /** 空闲看门狗是否已触发。 */
  readonly idleFired: boolean;
  /** 撤销所有计时器。幂等，每次尝试的 catch 与成功路径都要调用。 */
  dispose(): void;
}

/**
 * 装配一次尝试的超时与信号。返回时挂钟总时限已武装（与原实现一致：挂钟从
 * attempt 开始就计时，而不是等 fetch 发起）。
 */
export function createAttemptTimeouts(config: AttemptTimeoutConfig, clientSignal?: AbortSignal): AttemptTimeouts {
  const timeoutController = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleFired = false;
  let deadlineTimer: NodeJS.Timeout | null = null;
  let deadlineFired = false;

  // 挂钟总时限（upstream.timeoutMs）。与空闲看门狗的本质区别：看门狗每收到一个字节
  // 就会重置，所以一个持续 trickle 的上游可以无限期挂住连接；这个上限跨"等响应头"
  // 与"读流"两个阶段一次性生效，直到流结束才撤销。
  //
  // 注意：这是一次**行为变更**——修复前该配置完全不起作用，任何长度超过 timeoutMs
  // 的长推理请求都是靠它不被执行才活下来的。
  const armDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => {
      deadlineFired = true;
      timeoutController.abort(new Error(`Upstream exceeded ${config.upstreamTimeoutMs / 1000}s total deadline`));
    }, config.upstreamTimeoutMs);
    deadlineTimer.unref?.();
  };
  armDeadline();

  const disarmDeadline = () => {
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
  };

  // 空闲看门狗：每次被调用都会重置计时器。一旦上游超过 idleTimeoutMs 无数据，
  // 主动 abort 本次请求并标记 idleFired，抛"上游卡死"错误。
  const armIdleWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      timeoutController.abort(new Error(`No data from upstream for ${config.idleTimeoutMs / 1000}s`));
    }, config.idleTimeoutMs);
  };

  // 客户端断开立即传播：AbortSignal.any 可用时直接合并；否则退化为把客户端
  // 中止事件桥接到本地 controller（旧 Node 兼容路径）。
  const combinedSignal = clientSignal
    ? (AbortSignal as any).any
      ? (AbortSignal as any).any([clientSignal, timeoutController.signal])
      : timeoutController.signal
    : timeoutController.signal;
  if (clientSignal && !(AbortSignal as any).any) {
    clientSignal.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }

  return {
    signal: combinedSignal,
    armDeadline,
    disarmDeadline,
    armIdleWatchdog,
    get deadlineFired() { return deadlineFired; },
    get idleFired() { return idleFired; },
    dispose() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      disarmDeadline();
    },
  };
}
