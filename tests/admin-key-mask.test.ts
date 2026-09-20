// =============================================================================
// P1-4 回归：管理面不得把明文上游 apiKey 回传前端。
// -----------------------------------------------------------------------------
// 同文件内 /api/accounts 与 /api/usage/aggregate 都已经用 apiKeyMasked 做掩码，
// manual-login 是唯一漏网的出口。断言打在真实 HTTP 响应上，而不是函数内部。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const PLAINTEXT_KEY = `ck-plaintext-${randomUUID()}--do-not-leak`;

let app: FastifyInstance;
let upstream: http.Server;
let envFilePath: string;

beforeAll(async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-mask-'));

  // 真实 loginNewAccount 会打 whoami / billing；用本地 mock 上游喂给它，
  // 不 mock 我们自己的逻辑。
  upstream = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (p === '/alpha/whoami') {
      res.end(JSON.stringify({ success: true, user: { id: 'u9', name: 'Mask Tester', userName: 'masktest' } }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  // 写入新账号会同步 .env（供免重启回注）。它默认落在 cwd，而 vitest 的 cwd 就是
  // 仓库根——在真实部署目录里跑测试会把 mock 的 COMMANDCODE_API_BASE 写进生产 .env。
  envFilePath = path.join(stateDir, '.env');
  process.env.COMMANDCODE_ENV_PATH = envFilePath;

  const { dashboardRoutes } = await import('../src/routes/dashboard.js');
  app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>(r => upstream.close(() => r()));
});

describe('POST /api/auth/manual-login 凭据外泄（P1-4）', () => {
  it('响应体任何位置都不出现明文 apiKey', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/manual-login',
      payload: { apiKey: PLAINTEXT_KEY, name: 'manual' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(PLAINTEXT_KEY);
  });

  it('账号以掩码形式回传，且可被前端识别', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/manual-login',
      payload: { apiKey: PLAINTEXT_KEY },
    });
    const json = res.json();
    const account = json.account ?? json;

    expect(account.id).toBeTruthy();
    expect(account.apiKey).toBeUndefined();
    // 与 /api/accounts (dashboard.ts:192) 同一套掩码范式
    expect(account.apiKeyMasked).toBe(`${PLAINTEXT_KEY.slice(0, 8)}...${PLAINTEXT_KEY.slice(-4)}`);
  });

  // 落盘断言而非「仓库根不该有 .env」：后者会被开发者自己放的 .env 误判。
  // .env 本身就是明文凭据存储（审查另记），这里只锁住它**落在哪里**。
  it('保存账号时 .env 跟随 COMMANDCODE_ENV_PATH，而不是写进测试进程的 cwd', () => {
    expect(existsSync(envFilePath)).toBe(true);
    expect(readFileSync(envFilePath, 'utf-8')).toContain('ACCOUNTS_COUNT=1');
  });
});
