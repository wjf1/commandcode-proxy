// =============================================================================
// Prompt 版本管理路由（/api/prompts/*）
// -----------------------------------------------------------------------------
// - 默认关闭：env PROMPT_VERSIONS 未设或非 'on' 时本 plugin 不注册任何路由
//   （开关判断在函数开头，每次装配时读 env）。
// - 鉴权与 dashboard.ts 管理面同款，两层：
//   * PROXY_API_KEY 共享密钥由 index.ts 的 verifyProxyAuth 全局 hook 覆盖
//     /api/* —— 本 plugin 经 fastify.register 挂到主实例即自动受保护，
//     这里不重复挂（避免二次注册同一 hook）。
//   * 这里补上 dashboard.ts 同款的 Origin 校验：非幂等方法（POST 等）要求
//     同源，防浏览器随机网页驱动写操作；/api/* 一并禁用缓存。
// - name / ts 参数走白名单校验（isValidName），防目录穿越。
// =============================================================================
import { FastifyInstance } from 'fastify';
import { isSameOriginIfPresent } from './sse-common.js';
import {
  isValidName,
  listPrompts,
  listVersions,
  readPrompt,
  readVersion,
  resolvePromptsDir,
  rollbackPrompt,
  savePrompt,
} from '../utils/prompt-versions.js';

const PROMPTS_PREFIX = '/api/prompts';

const IDENTITY_METHODS = ['GET', 'OPTIONS', 'HEAD'];

export async function registerPromptRoutes(fastify: FastifyInstance) {
  // 默认关闭：未设或 'off' 直接 return，一个路由都不注册。
  const flag = String(process.env.PROMPT_VERSIONS ?? '').trim().toLowerCase();
  if (flag !== 'on') return;

  // 与 dashboard.ts 管理面同款防护：写操作要求同源 Origin；/api/* 禁用缓存。
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith(PROMPTS_PREFIX) && !IDENTITY_METHODS.includes(req.method)) {
      if (!isSameOriginIfPresent(req.headers.origin as string | undefined, req.headers.host as string | undefined, req.protocol)) {
        return reply.status(403).send({ error: 'Cross-origin admin request rejected' });
      }
    }
    reply.header('Cache-Control', 'no-cache');
  });

  // 列出所有 prompt name
  fastify.get(PROMPTS_PREFIX, async () => {
    const dir = resolvePromptsDir();
    return { prompts: listPrompts(dir), dir };
  });

  // 当前内容（text/plain）
  fastify.get(`${PROMPTS_PREFIX}/:name`, async (req: any, reply) => {
    const name = String((req.params as any).name || '');
    if (!isValidName(name)) return reply.status(400).send({ error: 'Invalid prompt name' });
    const content = readPrompt(resolvePromptsDir(), name);
    if (content === null) return reply.status(404).send({ error: 'Prompt not found' });
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  // 版本列表（时间倒序）
  fastify.get(`${PROMPTS_PREFIX}/:name/versions`, async (req: any, reply) => {
    const name = String((req.params as any).name || '');
    if (!isValidName(name)) return reply.status(400).send({ error: 'Invalid prompt name' });
    const dir = resolvePromptsDir();
    const versions = listVersions(dir, name);
    // 该 name 既无当前文件也无任何快照 → 视为不存在
    if (versions.length === 0 && readPrompt(dir, name) === null) {
      return reply.status(404).send({ error: 'Prompt not found' });
    }
    return { name, versions };
  });

  // 读取某快照（text/plain）
  fastify.get(`${PROMPTS_PREFIX}/:name/versions/:ts`, async (req: any, reply) => {
    const name = String((req.params as any).name || '');
    const ts = String((req.params as any).ts || '');
    if (!isValidName(name) || !isValidName(ts)) {
      return reply.status(400).send({ error: 'Invalid prompt name or timestamp' });
    }
    const content = readVersion(resolvePromptsDir(), name, ts);
    if (content === null) return reply.status(404).send({ error: 'Version not found' });
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  // 保存：body { content }；写新内容前先把旧内容快照
  fastify.post(`${PROMPTS_PREFIX}/:name`, async (req: any, reply) => {
    const name = String((req.params as any).name || '');
    if (!isValidName(name)) return reply.status(400).send({ error: 'Invalid prompt name' });
    const body = req.body || {};
    if (typeof body.content !== 'string') {
      return reply.status(400).send({ error: 'content (string) required' });
    }
    const result = savePrompt(resolvePromptsDir(), name, body.content);
    return { status: 'success', ...result };
  });

  // 回滚：body { ts }；恢复前先把当前内容快照
  fastify.post(`${PROMPTS_PREFIX}/:name/rollback`, async (req: any, reply) => {
    const name = String((req.params as any).name || '');
    if (!isValidName(name)) return reply.status(400).send({ error: 'Invalid prompt name' });
    const body = req.body || {};
    const ts = typeof body.ts === 'string' ? body.ts : '';
    if (!isValidName(ts)) return reply.status(400).send({ error: 'ts (snapshot id) required' });
    const result = rollbackPrompt(resolvePromptsDir(), name, ts);
    if (result === null) return reply.status(404).send({ error: 'Version not found' });
    return { status: 'success', ...result, restored: ts };
  });
}
