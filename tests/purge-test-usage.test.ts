// =============================================================================
// 测试残留清理工具的判定谓词
// -----------------------------------------------------------------------------
// 这个谓词决定「哪些用量记录可以从生产库里删掉」，误判即数据丢失，因此单独锁定。
// 真实事故背景见 purge-test-usage.mjs 顶部注释。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { isTestNoise } from '../purge-test-usage.mjs';

const rec = o => ({
  timestamp: '2026-09-11T02:00:00.000Z',
  model: 'claude-sonnet-5',
  inputTokens: 7,
  outputTokens: 3,
  timingMs: 19,
  costUsd: 0.0001,
  hasPricing: true,
  status: 'COMPLETED',
  mode: 'chat',
  ...o,
});

const NO_REAL = new Set();

describe('isTestNoise — 只认本机 mock 上游的产物', () => {
  it('典型 mock 残留（7/3 token、19ms、无上下文）被识别', () => {
    expect(isTestNoise(rec({}), NO_REAL)).toBe(true);
  });

  it('带任何真实调用上下文的记录一律不动', () => {
    expect(isTestNoise(rec({ sessionId: 's1' }), NO_REAL)).toBe(false);
    expect(isTestNoise(rec({ project: 'f:\\AI\\Zcode' }), NO_REAL)).toBe(false);
    expect(isTestNoise(rec({ agent: 'glm' }), NO_REAL)).toBe(false);
    expect(isTestNoise(rec({ sessionType: 'main' }), NO_REAL)).toBe(false);
  });

  it('耗时达到跨公网量级的一律不动（实测真实调用下界 2245ms）', () => {
    expect(isTestNoise(rec({ timingMs: 300 }), NO_REAL)).toBe(false);
    expect(isTestNoise(rec({ timingMs: 2245 }), NO_REAL)).toBe(false);
    expect(isTestNoise(rec({ timingMs: 19 }), NO_REAL)).toBe(true);
  });

  it('有真实流量的模型整体豁免，哪怕某条记录看起来像残留', () => {
    const t = new Set(['claude-sonnet-5']);
    expect(isTestNoise(rec({}), t)).toBe(false);
  });

  it('未完成 / 缺耗时的记录不动', () => {
    expect(isTestNoise(rec({ status: 'FAILED' }), NO_REAL)).toBe(false);
    expect(isTestNoise(rec({ timingMs: undefined }), NO_REAL)).toBe(false);
    expect(isTestNoise(null, NO_REAL)).toBe(false);
  });
});
