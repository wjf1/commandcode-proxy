import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPromptRoutes } from '../src/routes/prompts.js';
import { isValidName, listVersions, readVersion } from '../src/utils/prompt-versions.js';

// fastify.inject 端到端（不监听端口）；存储用 mkdtempSync 临时目录。
describe('prompt versions routes', () => {
  let tmpDir: string;
  let appOff: Fastify.FastifyInstance;
  let appOn: Fastify.FastifyInstance;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-versions-test-'));

    // 默认关闭的 app：注册前保证开关未设
    delete process.env.PROMPT_VERSIONS;
    appOff = Fastify();
    await appOff.register(registerPromptRoutes);
    await appOff.ready();

    // 开启的 app：存储指向临时目录
    process.env.PROMPT_VERSIONS = 'on';
    process.env.PROMPTS_DIR = tmpDir;
    appOn = Fastify();
    await appOn.register(registerPromptRoutes);
    await appOn.ready();
  });

  afterAll(async () => {
    delete process.env.PROMPT_VERSIONS;
    delete process.env.PROMPTS_DIR;
    await appOff.close();
    await appOn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 默认关闭 ────────────────────────────────────────────────────────────────
  describe('default off', () => {
    it('returns 404 when PROMPT_VERSIONS is unset', async () => {
      const res = await appOff.inject({ method: 'GET', url: '/api/prompts' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when PROMPT_VERSIONS=off', async () => {
      process.env.PROMPT_VERSIONS = 'off';
      const app = Fastify();
      await app.register(registerPromptRoutes);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/prompts' });
      await app.close();
      expect(res.statusCode).toBe(404);
    });
  });

  // ── 开启后：保存 → 快照 → 回滚 ─────────────────────────────────────────────
  describe('enabled: save / snapshot / rollback', () => {
    it('save v1 (no snapshot yet), save v2, save v3 → two snapshots, rollback to first', async () => {
      const save = (content: string) => appOn.inject({
        method: 'POST',
        url: '/api/prompts/alpha',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      // 首次保存：无旧内容，不产生快照
      let res = await save('version one');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'success', name: 'alpha', snapshotted: false });

      // 当前内容可读回（text/plain）
      res = await appOn.inject({ method: 'GET', url: '/api/prompts/alpha' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toBe('version one');

      // 第二次保存：版本列表出现 1 个快照（旧内容 version one）
      await save('version two');
      let versions = listVersions(tmpDir, 'alpha');
      expect(versions).toHaveLength(1);
      expect(versions[0].size).toBe('version one'.length);
      expect(readVersion(tmpDir, 'alpha', versions[0].ts)).toBe('version one');

      // 第三次保存：共两个快照，时间倒序（最新在前）
      await save('version three');
      versions = listVersions(tmpDir, 'alpha');
      expect(versions).toHaveLength(2);
      expect(versions[0].time >= versions[1].time).toBe(true);
      expect(readVersion(tmpDir, 'alpha', versions[1].ts)).toBe('version one');

      // 回滚到第一个快照（最早 = version one）；恢复前当前内容 v3 先被快照
      const first = versions[versions.length - 1].ts;
      res = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/alpha/rollback',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ts: first }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'success', restored: first, snapshotted: true });

      res = await appOn.inject({ method: 'GET', url: '/api/prompts/alpha' });
      expect(res.body).toBe('version one');
      expect(listVersions(tmpDir, 'alpha')).toHaveLength(3);
    });

    it('lists prompt names', async () => {
      const res = await appOn.inject({ method: 'GET', url: '/api/prompts' });
      expect(res.statusCode).toBe(200);
      expect(res.json().prompts).toContain('alpha');
    });

    it('reads a snapshot over HTTP', async () => {
      const versions = listVersions(tmpDir, 'alpha');
      const res = await appOn.inject({ method: 'GET', url: `/api/prompts/alpha/versions/${versions[1].ts}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toBe('version two'); // 倒序第二个 = 第二次保存前被快照的 v2
    });

    it('404s for unknown prompt and unknown snapshot', async () => {
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/nope' })).statusCode).toBe(404);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/nope/versions' })).statusCode).toBe(404);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/alpha/versions/1999-01-01T00-00-00.000Z' })).statusCode).toBe(404);
      const rollback = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/alpha/rollback',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ts: '1999-01-01T00-00-00.000Z' }),
      });
      expect(rollback.statusCode).toBe(404);
    });

    it('rejects path traversal and invalid names with 400', async () => {
      // 纯函数级：`..`、`.`、带分隔符与绝对路径形态一律不合格
      expect(isValidName('..')).toBe(false);
      expect(isValidName('.')).toBe(false);
      expect(isValidName('a/b')).toBe(false);
      expect(isValidName('a\\b')).toBe(false);
      expect(isValidName('c:\\etc')).toBe(false);
      expect(isValidName('alpha-1.v2')).toBe(true);
      // 裸 `..` 与编码 `%2E%2E` 都会被 HTTP/URL 规范化提前归并为 `/api/`（404 拒绝）；
      // 能到达 name 校验的是含 `..` 片段（foo..bar）与解码出 `/`、空格的形态 —— 必须 400
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/..' })).statusCode).toBe(404);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/%2E%2E' })).statusCode).toBe(404);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/foo..bar' })).statusCode).toBe(400);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/foo%2Fbar' })).statusCode).toBe(400);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/bad%20name' })).statusCode).toBe(400);
      const post = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/foo..bar',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x' }),
      });
      expect(post.statusCode).toBe(400);
    });

    it('rejects non-string content with 400', async () => {
      const res = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/alpha',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 42 }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── 鉴权：与 dashboard 管理面一致（照 guard.test.ts 的写法）────────────────
  describe('cross-origin guard (same as dashboard admin)', () => {
    it('rejects foreign-origin POST with 403', async () => {
      const res = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/alpha',
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hacked' }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows same-origin POST', async () => {
      const res = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/alpha',
        headers: { origin: 'http://127.0.0.1', host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'from dashboard' }),
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows POST without Origin (curl/SDK style)', async () => {
      const res = await appOn.inject({
        method: 'POST',
        url: '/api/prompts/beta',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'beta content' }),
      });
      expect(res.statusCode).toBe(200);
      expect((await appOn.inject({ method: 'GET', url: '/api/prompts/beta' })).body).toBe('beta content');
    });
  });
});
