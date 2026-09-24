// =============================================================================
// Wave 2 安全修复：日志密钥脱敏（LOG_REDACTION）
// -----------------------------------------------------------------------------
// 日志是排查时的第一入口，但也因此最容易把 Bearer Token / api-key 落进
// proxy.log 与仪表盘日志页。修复后默认按密钥形态打码；LOG_REDACTION=off
// 可显式回退（默认 on，符合"安全默认 + 配置放行"原则）。
// =============================================================================
import { describe, it, expect, afterEach } from 'vitest';
import { logger, redactSecrets } from '../src/utils/logger.js';

afterEach(() => {
  delete process.env.LOG_REDACTION;
  logger.clearLogs();
});

describe('redactSecrets（纯函数）', () => {
  it('masks Bearer tokens in Authorization headers', () => {
    const out = redactSecrets('Upstream request Authorization: Bearer sk-abc123def456ghi789 failed with 401');
    expect(out).not.toContain('sk-abc123def456ghi789');
    expect(out).toContain('Authorization: Bearer [REDACTED]');
  });

  it('masks api-key / x-api-key header values', () => {
    expect(redactSecrets('headers: { "x-api-key": "cc_live_0123456789abcdef" }')).not.toContain('cc_live_0123456789abcdef');
    expect(redactSecrets('api-key: cc_live_0123456789abcdef')).toContain('[REDACTED]');
    expect(redactSecrets('apikey=cc_live_0123456789abcdef')).toContain('[REDACTED]');
  });

  it('masks bare sk- style tokens', () => {
    const out = redactSecrets('got key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(out).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(out).toContain('[REDACTED]');
  });

  it('masks token/key query parameters', () => {
    const out = redactSecrets('GET https://api.commandcode.ai/v1/models?token=secretvalue12345&x=1');
    expect(out).not.toContain('secretvalue12345');
    expect(out).toContain('token=[REDACTED]');
  });

  it('leaves ordinary log text untouched', () => {
    const line = 'Upstream Model: claude-sonnet-5 | Thread 42 | Status COMPLETED';
    expect(redactSecrets(line)).toBe(line);
  });

  it('leaves short words after api-key untouched (no over-redaction of prose)', () => {
    expect(redactSecrets('api-key is missing')).toBe('api-key is missing');
  });
});

describe('logger 输出面（环形缓冲 / 文件同源）', () => {
  it('buffers redacted entries by default (LOG_REDACTION unset)', () => {
    logger.info('Upstream Authorization: Bearer sk-live-abcd1234efgh5678 rejected');
    const [entry] = logger.getLogs();
    expect(entry.message).not.toContain('sk-live-abcd1234efgh5678');
    expect(entry.message).toContain('[REDACTED]');
  });

  it('honors LOG_REDACTION=off as an explicit rollback', () => {
    process.env.LOG_REDACTION = 'off';
    const raw = 'Upstream Authorization: Bearer sk-live-abcd1234efgh5678 rejected';
    logger.info(raw);
    expect(logger.getLogs()[0].message).toBe(raw);
  });

  it('treats LOG_REDACTION=on / any other value as enabled', () => {
    process.env.LOG_REDACTION = 'on';
    logger.info('api-key: cc_live_0123456789abcdef');
    expect(logger.getLogs()[0].message).toContain('[REDACTED]');

    logger.clearLogs();
    process.env.LOG_REDACTION = 'yes-please';
    logger.info('api-key: cc_live_0123456789abcdef');
    expect(logger.getLogs()[0].message).toContain('[REDACTED]');
  });

  it('redaction survives control-character smuggling (sanitize runs first)', () => {
    logger.info('Authorization: Bearer sk-x\u0000-bearer sk-live-abcd1234efgh5678');
    expect(logger.getLogs()[0].message).not.toContain('sk-live-abcd1234efgh5678');
    expect(logger.getLogs()[0].message).not.toContain('\u0000');
  });
});
