import { describe, it, expect, afterEach } from 'vitest';
import { resolveBodyLimit } from '../src/utils/config.js';

afterEach(() => {
  delete process.env.MAX_BODY_MB;
});

describe('resolveBodyLimit', () => {
  it('defaults to 64MB when unset', () => {
    expect(resolveBodyLimit()).toBe(64 * 1024 * 1024);
  });

  it('reads MAX_BODY_MB as megabytes', () => {
    process.env.MAX_BODY_MB = '128';
    expect(resolveBodyLimit()).toBe(128 * 1024 * 1024);
    process.env.MAX_BODY_MB = '1';
    expect(resolveBodyLimit()).toBe(1 * 1024 * 1024);
  });

  it('falls back to default on invalid/out-of-range values', () => {
    process.env.MAX_BODY_MB = 'abc';
    expect(resolveBodyLimit()).toBe(64 * 1024 * 1024);
    process.env.MAX_BODY_MB = '0';
    expect(resolveBodyLimit()).toBe(64 * 1024 * 1024);
    process.env.MAX_BODY_MB = '-5';
    expect(resolveBodyLimit()).toBe(64 * 1024 * 1024);
    process.env.MAX_BODY_MB = '2048';
    expect(resolveBodyLimit()).toBe(64 * 1024 * 1024);
    process.env.MAX_BODY_MB = ' ';
    expect(resolveBodyLimit()).toBe(64 * 1024 * 1024);
  });
});
