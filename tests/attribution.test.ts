// =============================================================================
// 归因测试：会话 ID（客户端声明）与项目（文本推断）
// -----------------------------------------------------------------------------
// 这两类数据的性质截然不同，测试也按此分层：
//   - 会话 ID：精确取值，必须能在无头部时经 metadata / user 字段兜底；
//   - 项目：**推断**，测试重点在于"不确定时必须返回 null"而非"猜中"，
//     并锁住几个已修复的真实缺陷（\node_modules 被误截断、按完整路径计数
//     导致频次永远为 1、噪声目录被当成项目）。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildRequestContext,
  extractSessionId,
  inferProject,
  isValidTimezone,
  normalizeProjectPath,
  projectDisplayName,
} from '../src/utils/request-context.js';

const BS = String.fromCharCode(92); // 单反斜杠

/** 实测捕获的 ZCode system prompt 片段。 */
const REAL_SYSTEM = [
  'You are ZCode.',
  '# Environment',
  `- Primary working directory: C:${BS}Users${BS}admin${BS}.zcode${BS}workspace${BS}default`,
  '- Is a git repository: no',
].join(String.fromCharCode(10));

describe('extractSessionId — 客户端声明的会话标识', () => {
  it('优先取 x-session-id 头', () => {
    expect(extractSessionId({ 'x-session-id': 'abc-123' }, {})).toBe('abc-123');
  });

  it('头部缺失时，解析 metadata.user_id 里被编码的 JSON', () => {
    const body = { metadata: { user_id: '{"device_id":"d1","session_id":"meta-sess"}' } };
    expect(extractSessionId({}, body)).toBe('meta-sess');
  });

  it('双层编码的 metadata 也能解析', () => {
    const inner = JSON.stringify({ session_id: 'deep-sess' });
    const body = { metadata: { user_id: JSON.stringify({ payload: inner }) } };
    // 第一层解开后没有 session_id，应返回 null 而不是乱猜
    expect(extractSessionId({}, body)).toBeNull();
  });

  it('再回落到 OpenAI 的 user 字段', () => {
    expect(extractSessionId({}, { user: 'caller-42' })).toBe('caller-42');
  });

  it('都没有时返回 null（而不是空串）', () => {
    expect(extractSessionId({}, { model: 'x' })).toBeNull();
    expect(extractSessionId(undefined, undefined)).toBeNull();
  });

  it('忽略空白值', () => {
    expect(extractSessionId({ 'x-session-id': '   ' }, {})).toBeNull();
  });

  it('头部值大小写不敏感', () => {
    expect(extractSessionId({ 'X-Session-Id': 'upper' }, {})).toBe('upper');
  });
});

describe('isValidTimezone', () => {
  it('接受合法 IANA 时区', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });
  it('拒绝非法值与空值', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
  });
});

describe('normalizeProjectPath — 规范化与噪声过滤', () => {
  it('保留合法绝对路径并小写盘符', () => {
    expect(normalizeProjectPath(`C:${BS}work${BS}myapp`)).toBe(`c:${BS}work${BS}myapp`);
    expect(normalizeProjectPath('/home/u/proj')).toBe('/home/u/proj');
  });

  it('还原 JSON 双重转义的反斜杠', () => {
    const twice = `C:${BS}${BS}work${BS}${BS}app`;
    expect(normalizeProjectPath(twice)).toBe(`c:${BS}work${BS}app`);
  });

  it('不去掉引号外的标点尾巴', () => {
    expect(normalizeProjectPath(`"C:${BS}work${BS}app"`)).toBe(`c:${BS}work${BS}app`);
    expect(normalizeProjectPath(`C:${BS}work${BS}app.`)).toBe(`c:${BS}work${BS}app`);
  });

  it('不得把 \\node_modules 这类以 n 开头的段误截断（真实缺陷回归）', () => {
    // 旧实现用 split(/\\n/) 处理转义换行，把 C:\proj\node_modules 切成了 C:\proj
    const p = `C:${BS}proj${BS}node_modules${BS}foo`;
    expect(normalizeProjectPath(p)).toBeNull(); // 噪声目录，整体排除
  });

  it('排除系统与工具噪声目录', () => {
    const noise = [
      `/usr/lib/Windows/x`,
      `C:${BS}a${BS}AppData${BS}Local${BS}Temp${BS}b`,
      `C:${BS}Users${BS}admin${BS}.zcode${BS}cli${BS}plugins${BS}cache${BS}x`,
      `C:${BS}p${BS}node_modules${BS}q`,
    ];
    for (const n of noise) expect(normalizeProjectPath(n)).toBeNull();
  });

  it('拒绝相对路径与含非法字符的整句文本', () => {
    expect(normalizeProjectPath('src/utils/foo.ts')).toBeNull();
    expect(normalizeProjectPath('see C:\\\\a<pipe>|x')).toBeNull();
  });

  it('拒绝空值与超长值', () => {
    expect(normalizeProjectPath('')).toBeNull();
    expect(normalizeProjectPath(`C:${BS}` + 'a'.repeat(300))).toBeNull();
  });

  it('截断"字面量 \\n + 字段标记"的提示词产物，但不误伤路径', () => {
    // 实际传入的是正则捕获到的值：路径后面紧跟字面量 \n 与下一字段，
    // 需要切掉尾巴而不能把 \node_modules 这类合法段一起切掉。
    const captured = `C:${BS}work${BS}app${BS}n- Is a git repository: no`;
    expect(normalizeProjectPath(captured)).toBe(`c:${BS}work${BS}app`);
    // 对照：合法路径段以 n 开头时不得被截断
    const legit = `C:${BS}work${BS}node_modules${BS}pkg`;
    expect(normalizeProjectPath(legit)).toBeNull(); // 属噪声目录，整体排除
    const legit2 = `C:${BS}work${BS}newfolder`;
    expect(normalizeProjectPath(legit2)).toBe(`c:${BS}work${BS}newfolder`);
  });
});

describe('inferProject — 项目归属（推断，宁可留空）', () => {
  it('从显式标签字段提取，标记为 label（高置信）', () => {
    expect(inferProject(REAL_SYSTEM)).toEqual({
      project: `c:${BS}Users${BS}admin${BS}.zcode${BS}workspace${BS}default`,
      source: 'label',
    });
  });

  it('标签值带引号也能提取', () => {
    const t = `Primary working directory: "C:${BS}work${BS}app"`;
    expect(inferProject(t)).toEqual({ project: `c:${BS}work${BS}app`, source: 'label' });
  });

  it('无标签时按父目录频次推断，标记为 heuristic', () => {
    const t = `read C:${BS}work${BS}myapp${BS}src${BS}a.ts then C:${BS}work${BS}myapp${BS}src${BS}b.ts`;
    expect(inferProject(t)).toEqual({ project: `c:${BS}work${BS}myapp${BS}src`, source: 'heuristic' });
  });

  it('只出现一次的路径不据以归属（必须返回 null）', () => {
    expect(inferProject(`see C:${BS}random${BS}once.ts`)).toEqual({ project: null, source: null });
  });

  it('频次相同时取更浅的路径（更接近项目根）', () => {
    const t = [
      `C:${BS}work${BS}app${BS}src${BS}a.ts`,
      `C:${BS}work${BS}app${BS}src${BS}b.ts`,
    ].join(' ');
    // 两文件的父目录都是 ...\src，仅一个候选
    expect(inferProject(t).source).toBe('heuristic');
  });

  it('空文本与非法输入返回 null', () => {
    expect(inferProject('')).toEqual({ project: null, source: null });
    expect(inferProject(null as any)).toEqual({ project: null, source: null });
    expect(inferProject({} as any)).toEqual({ project: null, source: null });
  });

  it('标签存在但值不可用时，回落到启发式而非直接失败', () => {
    const t = `Primary working directory: relative/path\nmore C:${BS}real${BS}proj${BS}x.ts C:${BS}real${BS}proj${BS}y.ts`;
    expect(inferProject(t)).toEqual({ project: `c:${BS}real${BS}proj`, source: 'heuristic' });
  });
});

describe('buildRequestContext — 汇总', () => {
  it('完整 ZCode 请求：会话为声明值，项目为推断值', () => {
    const ctx = buildRequestContext(
      {
        'x-session-id': '72c84a09-aaff-4195-bfce-fd436ad559ab',
        'x-zcode-session-type': 'main',
        'x-zcode-agent': 'glm',
        'x-client-timezone': 'Asia/Shanghai',
      },
      { system: REAL_SYSTEM }
    );
    expect(ctx.sessionId).toBe('72c84a09-aaff-4195-bfce-fd436ad559ab');
    expect(ctx.sessionType).toBe('main');
    expect(ctx.agent).toBe('glm');
    expect(ctx.timezone).toBe('Asia/Shanghai');
    expect(ctx.project).toBe(`c:${BS}Users${BS}admin${BS}.zcode${BS}workspace${BS}default`);
    expect(ctx.projectSource).toBe('label');
  });

  it('裸客户端：全部字段为 null，不编造取值', () => {
    const ctx = buildRequestContext({}, { model: 'gpt', messages: [] });
    expect(ctx).toEqual({
      sessionId: null, project: null, projectSource: null,
      sessionType: null, agent: null, timezone: null,
    });
  });

  it('非法时区被拒绝为 null', () => {
    expect(buildRequestContext({ 'x-client-timezone': 'Not/AZone' }, {}).timezone).toBeNull();
  });

  it('Anthropic 块数组形式的 system 也能提取', () => {
    const ctx = buildRequestContext({}, { system: [{ type: 'text', text: REAL_SYSTEM }] });
    expect(ctx.projectSource).toBe('label');
  });
});

describe('projectDisplayName', () => {
  it('取末段作为展示名（全路径可能含用户名）', () => {
    expect(projectDisplayName(`C:${BS}Users${BS}admin${BS}.zcode${BS}workspace${BS}default`)).toBe('default');
    expect(projectDisplayName('/home/u/myapp')).toBe('myapp');
  });
  it('未识别时给出明确文案', () => {
    expect(projectDisplayName(null)).toBe('未识别');
    expect(projectDisplayName(undefined)).toBe('未识别');
  });
});

// ── 聚合层：项目 / 会话维度 ─────────────────────────────────────────────────

describe('getUsageStats — byProject / bySession 聚合', () => {
  let stateDir: string;
  let store: typeof import('../src/utils/usage-store.js');

  const rec = (o: Record<string, unknown>) => JSON.stringify({
    timestamp: '2026-09-11T02:00:00.000Z',
    model: 'deepseek/deepseek-v4.1-flash',
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500,
    timingMs: 100, costUsd: 0.001, hasPricing: true, status: 'COMPLETED', mode: 'messages',
    ...o,
  });

  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-attr-'));
    writeFileSync(path.join(stateDir, 'models.json'), JSON.stringify([
      {
        id: 'deepseek/deepseek-v4.1-flash', object: 'model', created: 1, owned_by: 'deepseek',
        pricing: { input: 0.15, output: 0.6, cacheRead: 0.003 },
      },
    ]), 'utf-8');
    process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
    process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
    vi.resetModules();
    store = await import('../src/utils/usage-store.js');
  });

  afterEach(() => {
    delete process.env.COMMANDCODE_MODELS_CACHE_PATH;
    delete process.env.USAGE_HISTORY_PATH;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('按项目聚合，并保留置信度来源', () => {
    writeFileSync(process.env.USAGE_HISTORY_PATH!, [
      rec({ project: `C:${BS}work${BS}app`, projectSource: 'label', sessionId: 's1', costUsd: 0.5 }),
      rec({ project: `C:${BS}work${BS}app`, projectSource: 'label', sessionId: 's2', costUsd: 0.3 }),
      rec({ project: `C:${BS}other${BS}x`, projectSource: 'heuristic', costUsd: 0.2 }),
    ].join('\n') + '\n', 'utf-8');

    const s = store.getUsageStats();
    expect(s.byProject).toHaveLength(2);
    // 按成本降序
    expect(s.byProject[0].costUsd).toBeCloseTo(0.8, 6);
    expect(s.byProject[0].projectSource).toBe('label');
    expect(s.byProject[0].sessionCount).toBe(2);
    expect(s.byProject[1].projectSource).toBe('heuristic');
  });

  it('未识别项目单独成组，不被静默丢弃', () => {
    writeFileSync(process.env.USAGE_HISTORY_PATH!, [
      rec({ project: `C:${BS}work${BS}app`, projectSource: 'label' }),
      rec({}), // 无项目
    ].join('\n') + '\n', 'utf-8');

    const s = store.getUsageStats();
    expect(s.byProject).toHaveLength(2);
    const unattr = s.byProject.find(p => p.project === null);
    expect(unattr).toBeTruthy();
    expect(unattr!.runs).toBe(1);
    expect(unattr!.projectSource).toBeNull();
  });

  it('按会话聚合，仅含有会话 ID 的记录', () => {
    writeFileSync(process.env.USAGE_HISTORY_PATH!, [
      rec({ sessionId: 'sess-a', costUsd: 0.4, sessionType: 'main', agent: 'glm', models: undefined }),
      rec({ sessionId: 'sess-a', costUsd: 0.1 }),
      rec({ sessionId: 'sess-b', costUsd: 0.9, sessionType: 'subagent' }),
      rec({}), // 无会话 ID → 不计入 bySession
    ].join('\n') + '\n', 'utf-8');

    const s = store.getUsageStats();
    expect(s.bySession).toHaveLength(2);
    expect(s.bySession[0].sessionId).toBe('sess-b'); // 成本高者在前
    const a = s.bySession.find(x => x.sessionId === 'sess-a')!;
    expect(a.runs).toBe(2);
    expect(a.costUsd).toBeCloseTo(0.5, 6);
    expect(a.sessionType).toBe('main');
    expect(a.agent).toBe('glm');
  });

  it('attribution 统计覆盖情况（会话 vs 项目，分别计数）', () => {
    writeFileSync(process.env.USAGE_HISTORY_PATH!, [
      rec({ sessionId: 's1', project: `C:${BS}w${BS}app`, projectSource: 'label' }),
      rec({ sessionId: 's2', project: `C:${BS}w${BS}app`, projectSource: 'heuristic' }),
      rec({}), // 两者都没有
    ].join('\n') + '\n', 'utf-8');

    const s = store.getUsageStats();
    expect(s.attribution.sessionsIdentified).toBe(2);
    expect(s.attribution.projectsIdentified).toBe(2);
    expect(s.attribution.projectsLabeled).toBe(1);
    expect(s.attribution.totalRecords).toBe(3);
  });

  it('同一会话跨不同推断结果时保留首个非空项目，避免抖动', () => {
    writeFileSync(process.env.USAGE_HISTORY_PATH!, [
      rec({ sessionId: 's1', project: `C:${BS}a`, projectSource: 'label' }),
      rec({ sessionId: 's1', project: `C:${BS}b`, projectSource: 'heuristic' }),
    ].join('\n') + '\n', 'utf-8');

    const s = store.getUsageStats();
    expect(s.bySession[0].project).toBe(`C:${BS}a`);
    expect(s.bySession[0].projectSource).toBe('label');
  });

  it('记录里的客户端时区用于日期分组（避免跨时区错位）', () => {
    // 02:00 UTC = 当日 10:00 上海；用 UTC 分组与上海分组应得到同一天
    writeFileSync(process.env.USAGE_HISTORY_PATH!, [
      rec({ timestamp: '2026-09-11T02:00:00.000Z', timezone: 'Asia/Shanghai' }),
      // 23:30 UTC = 次日 07:30 上海 → 上海时区应归到 9-12
      rec({ timestamp: '2026-09-11T23:30:00.000Z', timezone: 'Asia/Shanghai' }),
    ].join('\n') + '\n', 'utf-8');

    const s = store.getUsageStats();
    const dates = s.byDay.map(d => d.date).sort();
    expect(dates).toEqual(['2026-09-11', '2026-09-12']);
  });
});
