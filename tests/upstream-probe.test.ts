// =============================================================================
// 200 流内 error 事件的重试判定
// -----------------------------------------------------------------------------
// 背景（真实事故）：请求带着 29 万 token 上下文打到上游，网关转发 provider 时失败，
// 回了一个 HTTP **200** 的流，里面是 error 事件 "Invalid error response format: Gateway
// request failed"。旧行为把它当成模型的回答返回 —— 界面里那一轮 16 分钟的工作就以这段
// 文本收场。HTTP 层的重试只覆盖非 2xx，够不到它。
//
// 这里的纯函数决定「要不要丢弃本次调用重试」，判错的两个方向都有代价：
//   - 该重试却没重试 → 用户白等一轮（本次事故）；
//   - 不该重试却重试 → 白耗额度（29 万 token 上下文单次 $0.087，两次就是 $0.26
//     换一个必然相同的错误）。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { isRetryableEventMessage, classifyProbeEvent, classifyBuffered } from '../src/adapters/commandcode/upstream.js';

describe('isRetryableEventMessage — 只重试瞬时性失败', () => {
  it('典型瞬时失败值得重试', () => {
    // 本次事故里的原文
    expect(isRetryableEventMessage('Invalid error response format: Gateway request failed')).toBe(true);
    expect(isRetryableEventMessage('Our servers are currently overloaded. Please try again.')).toBe(true);
    expect(isRetryableEventMessage("No available providers match the 'only' filter")).toBe(true);
  });

  it('确定性不可用不重试（重试只会白耗额度）', () => {
    expect(isRetryableEventMessage('This model is not available in your region')).toBe(false);
    expect(isRetryableEventMessage('Model/provider not recognized: anthropic:foo')).toBe(false);
    expect(isRetryableEventMessage('This model does not exist')).toBe(false);
  });

  it('计费/套餐类终止错误不重试（复用 terminalCodeFor 判定）', () => {
    expect(isRetryableEventMessage('insufficient credits')).toBe(false);
    expect(isRetryableEventMessage('premium_credits_exhausted')).toBe(false);
    expect(isRetryableEventMessage('model_not_in_plan')).toBe(false);
  });

  it('空消息不重试（判不出来就别浪费额度）', () => {
    expect(isRetryableEventMessage('')).toBe(false);
    expect(isRetryableEventMessage('   ')).toBe(false);
    expect(isRetryableEventMessage(undefined as any)).toBe(false);
  });
});

describe('classifyProbeEvent — 单个事件的判定', () => {
  it('可重试的 error 事件 → retry', () => {
    expect(classifyProbeEvent({ type: 'error', error: 'Gateway request failed' })).toBe('retry');
    expect(classifyProbeEvent({ type: 'error', error: { message: 'Gateway request failed' } })).toBe('retry');
  });

  it('确定性的 error 事件 → accept（重试也白搭，按既有逻辑原样交出去）', () => {
    expect(classifyProbeEvent({ type: 'error', error: 'This model is not available in your region' })).toBe('accept');
  });

  it('内容类事件 → accept（已经开始产出，不能再丢）', () => {
    for (const type of ['text-delta', 'reasoning-delta', 'tool-call', 'tool-call-delta', 'finish', 'finish-step']) {
      expect(classifyProbeEvent({ type })).toBe('accept');
    }
  });

  it('start / 未知事件 → ignore（不影响判定，继续看）', () => {
    // 这条是本次修复的要害：CC 的流以 start 开场，用「首事件」判定等于永不触发。
    expect(classifyProbeEvent({ type: 'start' })).toBe('ignore');
    expect(classifyProbeEvent({ type: 'usage' })).toBe('ignore');
    expect(classifyProbeEvent(null)).toBe('ignore');
    expect(classifyProbeEvent({})).toBe('ignore');
  });
});

describe('classifyBuffered — 增量扫描，处理被截断的半行', () => {
  const line = (o: unknown) => `data: ${JSON.stringify(o)}\n`;

  it('start 之后才是 error：照样判定为 retry', () => {
    const text = line({ type: 'start' }) + line({ type: 'error', error: 'Gateway request failed' });
    expect(classifyBuffered(text, 0).verdict).toBe('retry');
  });

  it('内容先到：判为 accept，不再往后看 error', () => {
    const text = line({ type: 'text-delta', text: 'hi' }) + line({ type: 'error', error: 'Gateway request failed' });
    expect(classifyBuffered(text, 0).verdict).toBe('accept');
  });

  it('半行不判定，等下一批数据', () => {
    const partial = line({ type: 'start' }) + 'data: {"type":"err';
    const r = classifyBuffered(partial, 0);
    expect(r.verdict).toBe('ignore');
    // 补齐后即可判定，且不重复扫描已处理过的行
    const full = partial + 'or","error":"Gateway request failed"}\n';
    expect(classifyBuffered(full, r.scanned).verdict).toBe('retry');
  });

  it('忽略空行、SSE 注释与 [DONE]', () => {
    const text = '\n: keepalive\n\ndata: [DONE]\n' + line({ type: 'text-delta', text: 'x' });
    expect(classifyBuffered(text, 0).verdict).toBe('accept');
  });

  it('全是中性事件 → 保持 ignore（继续攒）', () => {
    expect(classifyBuffered(line({ type: 'start' }) + line({ type: 'usage', n: 1 }), 0).verdict).toBe('ignore');
  });

  it('非法 JSON 行被跳过而不是误判', () => {
    expect(classifyBuffered('data: {broken\n' + line({ type: 'start' }), 0).verdict).toBe('ignore');
  });
});
