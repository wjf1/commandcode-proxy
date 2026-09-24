// =============================================================================
// 审计日志（src/utils/audit-log.ts）契约测试
// -----------------------------------------------------------------------------
// 覆盖：默认开启（AUDIT_LOG 未设 = on）、off 关闭、JSONL 字段只含元数据
// （键集合精确断言 —— 绝不出现消息正文/system prompt）、路径可覆盖、5MB
// 轮转、写失败静默、guard 拒绝路径落盘。路径为调用时惰性求值，测试通过
// AUDIT_LOG_PATH 指向 tmp 目录，绝不污染项目 logs/。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditRequestStart, auditRequestEnd, auditReject, accountTail } from '../src/utils/audit-log.js';

let dir = '';
let file = '';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-test-'));
  file = path.join(dir, 'audit.log');
  for (const k of ['AUDIT_LOG', 'AUDIT_LOG_PATH']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AUDIT_LOG_PATH = file;
});

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function lines(): any[] {
  return fs
    .readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

describe('默认开启（AUDIT_LOG 未设 = on）', () => {
  it('auditRequestStart + auditRequestEnd 落一行 JSONL', () => {
    const entry = auditRequestStart({ url: '/v1/chat/completions' });
    auditRequestEnd(entry, { model: 'glm-4.7', inputTokens: 11, outputTokens: 22, status: 'COMPLETED', accountId: '3456' });
    expect(lines().length).toBe(1);
  });

  it('JSONL 只含元数据字段（键集合精确断言），route 去掉 query，绝不出现正文', () => {
    const entry = auditRequestStart({ url: '/v1/chat/completions?trace=1' });
    auditRequestEnd(entry, { model: 'glm-4.7', inputTokens: 11, outputTokens: 22, status: 'COMPLETED', accountId: '3456' });
    const rec = lines()[0];
    expect(Object.keys(rec).sort()).toEqual(
      ['accountId', 'durationMs', 'inputTokens', 'model', 'outputTokens', 'route', 'status', 'ts'].sort(),
    );
    expect(rec.route).toBe('/v1/chat/completions');
    expect(rec.model).toBe('glm-4.7');
    expect(rec.inputTokens).toBe(11);
    expect(rec.outputTokens).toBe(22);
    expect(rec.status).toBe('COMPLETED');
    expect(rec.accountId).toBe('3456');
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => new Date(rec.ts).toISOString()).not.toThrow();
  });

  it('不传 accountId 时该字段缺省', () => {
    const entry = auditRequestStart({ url: '/v1/messages' });
    auditRequestEnd(entry, { status: 'FAILED' });
    const rec = lines()[0];
    expect(rec.route).toBe('/v1/messages');
    expect(rec.accountId).toBeUndefined();
    expect('accountId' in rec).toBe(false);
    expect(rec.model).toBeNull();
  });
});

describe('AUDIT_LOG=off 关闭', () => {
  it('不写任何文件', () => {
    process.env.AUDIT_LOG = 'off';
    const entry = auditRequestStart({ url: '/v1/chat/completions' });
    auditRequestEnd(entry, { status: 'COMPLETED' });
    auditReject({ url: '/v1/messages' }, 'RATE_LIMITED', 'm');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('5MB 轮转（参照 logger 的 LOG_FILE_MAX_BYTES 模式）', () => {
  it('超过 5MB 时改名为 .old 后重新追加', () => {
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
    const entry = auditRequestStart({ url: '/v1/chat/completions' });
    auditRequestEnd(entry, { model: 'm', status: 'COMPLETED' });
    expect(fs.existsSync(`${file}.old`)).toBe(true);
    expect(lines().length).toBe(1);
  });

  it('未超 5MB 不轮转', () => {
    const entry = auditRequestStart({ url: '/v1/chat/completions' });
    auditRequestEnd(entry, { status: 'COMPLETED' });
    expect(fs.existsSync(`${file}.old`)).toBe(false);
  });
});

describe('写失败静默（审计绝不影响请求路径）', () => {
  it('目录不可创建时不抛出', () => {
    const blocker = path.join(dir, 'blocker.txt');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.AUDIT_LOG_PATH = path.join(blocker, 'nested', 'audit.log');
    const entry = auditRequestStart({ url: '/v1/messages' });
    expect(() => auditRequestEnd(entry, { status: 'COMPLETED' })).not.toThrow();
  });
});

describe('guard 拒绝路径（auditReject）', () => {
  it('请求已 start 时落盘拒绝行', () => {
    const req = { url: '/v1/chat/completions' };
    auditRequestStart(req);
    auditReject(req, 'RATE_LIMITED', 'm1');
    const rec = lines()[0];
    expect(rec.status).toBe('RATE_LIMITED');
    expect(rec.model).toBe('m1');
    expect(rec.route).toBe('/v1/chat/completions');
  });

  it('未 start 也能容错落盘', () => {
    expect(() => auditReject({ url: '/v1/messages' }, 'MODEL_FORBIDDEN', 'm2')).not.toThrow();
    const rec = lines()[0];
    expect(rec.status).toBe('MODEL_FORBIDDEN');
    expect(rec.route).toBe('/v1/messages');
  });
});

describe('accountTail — 只取密钥末 4 位', () => {
  it('常规取尾号，空值返回 undefined', () => {
    expect(accountTail('sk-abcdef123456')).toBe('3456');
    expect(accountTail(undefined)).toBeUndefined();
    expect(accountTail('')).toBeUndefined();
    expect(accountTail('   ')).toBeUndefined();
  });
});
