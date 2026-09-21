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
const PROJECT_ROOT = path.resolve(__dirname, '..');

let app: FastifyInstance;
let upstream: http.Server;
let envFile = '';

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
  // .env 也必须可隔离：config.ts:28 把它硬编码到项目根，而 config/models/pricing/usage
  // 全都有 env 覆盖钩子。缺了它，任何写凭据的路径（含本用例、以及 exe 从 Program
  // Files 下运行）都会把**明文 key** 落到工作目录里一个 gitignore 兜不住语义的文件。
  envFile = path.join(stateDir, '.env');
  process.env.COMMANDCODE_ENV_FILE_PATH = envFile;

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
});

// 上面两个用例本身就是一次真实写凭据操作：若 .env 不可隔离，它就会把明文 key
// 落到仓库根（实测发生过——文件时间戳与用例运行时间一致）。这条锁死不再复发。
describe('.env 写入位置可隔离', () => {
  it('凭据落 COMMANDCODE_ENV_FILE_PATH，而不是项目根', async () => {
    expect(existsEnvFile()).toBe(true);
    expect(readFileSync(envFile, 'utf-8')).toContain(PLAINTEXT_KEY);
    expect(existsSync(path.join(PROJECT_ROOT, '.env'))).toBe(false);
  });
});

function existsEnvFile(): boolean {
  return !!envFile && existsSync(envFile);
}
