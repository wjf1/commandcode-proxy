// 管理面鉴权边界纯函数锁定（回移植批次 B：B2 Host 白名单 + B1 token 凭据）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminTokenOk, isLoopbackHostHeader, injectAdminTokenMeta } from '../src/utils/admin-guard.js';

describe('isLoopbackHostHeader（B2）', () => {
  it('回环名（含端口与 IPv6 方括号形态）放行', () => {
    expect(isLoopbackHostHeader('127.0.0.1:49152')).toBe(true);
    expect(isLoopbackHostHeader('localhost')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:8080')).toBe(true);
    expect(isLoopbackHostHeader('LOCALHOST:3000')).toBe(true);
  });

  it('非回环 / 畸形 / 缺失 Host 拒绝', () => {
    expect(isLoopbackHostHeader('evil.tld')).toBe(false);
    expect(isLoopbackHostHeader('0.0.0.0:8080')).toBe(false);
    // URL 解析会把 user@ 剥成凭据，hostname 归一化到 127.0.0.1（真实主机判定，见 admin-guard 注释）
    expect(isLoopbackHostHeader('user@127.0.0.1:8080')).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1/path')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });

  it('ADMIN_ALLOWED_HOSTS 追加名单生效', () => {
    expect(isLoopbackHostHeader('proxy.lan', 'proxy.lan,db.local')).toBe(true);
    expect(isLoopbackHostHeader('other.lan', 'proxy.lan')).toBe(false);
  });
});

describe('adminTokenOk（B1）', () => {
  beforeAll(() => {
    // ADMIN_TOKEN 在模块加载时固化：本文件只锁「比较逻辑」，不锁具体值。
    // 空串/undefined 恒拒；任意非空串在未设 ADMIN_API_TOKEN 时与随机 token 不等。
  });
  afterAll(() => { /* 无环境残留 */ });

  it('空凭据恒拒', () => {
    expect(adminTokenOk(undefined)).toBe(false);
    expect(adminTokenOk('')).toBe(false);
  });

  it('错误凭据恒拒（随机 token 不可猜）', () => {
    expect(adminTokenOk('guess')).toBe(false);
    expect(adminTokenOk('x'.repeat(64))).toBe(false);
  });
});

describe('injectAdminTokenMeta', () => {
  it('向 <head> 注入 meta 且幂等', () => {
    const html = '<html><head><title>t</title></head><body></body></html>';
    const once = injectAdminTokenMeta(html);
    expect(once).toContain('<meta name="ccproxy-admin-token"');
    expect(injectAdminTokenMeta(once)).toBe(once);
  });
});
