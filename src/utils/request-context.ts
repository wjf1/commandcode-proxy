// =============================================================================
// 请求上下文提取（会话 / 项目 / 客户端元信息）
// -----------------------------------------------------------------------------
// 采集两类**性质截然不同**的归因信息，面板必须区别对待，不可并列呈现：
//
//   1. 会话 ID —— 客户端**声明**的标识符。来自 `x-session-id` 头（实测值与磁盘上
//      的会话目录名 sess_<uuid> 完全一致，可交叉印证），请求体 metadata.user_id
//      里镜像了一份作为兜底。取值精确、含义无歧义；拿不到就是 null，绝不猜测。
//
//   2. 项目 —— **推断**出来的属性。上游不提供该维度（/alpha/usage/* 分维度端点
//      实测全部 404），代理自身也没有调用方的工作目录，只能从 system prompt 的
//      文本里提取。因此每一条都带 projectSource 标注置信度，且宁可留空也不标错
//      —— 一个自信的错误标签比没有标签更糟。
//
// 两者都只覆盖**经过本代理的流量**：上游 usage summary 显示本周期全账号 2511 次
// 请求，代理侧仅记录到约 448 次（约 18%），其余为直连 CLI 或其他客户端。
// =============================================================================

/** 项目归属的置信度来源。 */
export type ProjectSource =
  /** system prompt 里带显式标签的字段（如 "Primary working directory: ..."），高置信。 */
  | 'label'
  /** 从文本中扫描出的候选路径，按出现频次与噪声过滤推断，较低置信。 */
  | 'heuristic';

export interface RequestContext {
  /** 客户端声明的会话 ID；无法获取时为 null（不是空串）。 */
  sessionId: string | null;
  /** 推断出的项目根目录（规范化全路径）；无法可靠推断时为 null。 */
  project: string | null;
  /** project 的置信度来源；project 为 null 时也为 null。 */
  projectSource: ProjectSource | null;
  /** 会话类型：main / subagent 等（ZCode 的 x-zcode-session-type）。 */
  sessionType: string | null;
  /** 发起方的 agent 标识（ZCode 的 x-zcode-agent）。 */
  agent: string | null;
  /** 客户端时区（IANA 名，经校验）；用于按调用方本地日期分组。 */
  timezone: string | null;
}

export const EMPTY_REQUEST_CONTEXT: RequestContext = {
  sessionId: null,
  project: null,
  projectSource: null,
  sessionType: null,
  agent: null,
  timezone: null,
};

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * 读取单个头部值。Node 的 HTTP 层会统一小写头部名，但测试与直调场景可能传入
 * 原始大小写，因此这里按小写归一后再查，数组取首个。
 */
function header(headers: HeaderBag | undefined, name: string): string | null {
  if (!headers) return null;
  const want = name.toLowerCase();
  let raw: string | string[] | undefined = headers[want];
  if (raw === undefined) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === want) {
        raw = headers[k];
        break;
      }
    }
  }
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * 解析可能是 JSON 的字符串，最多两轮 —— 实测 metadata.user_id 是
 * "{\"device_id\":...}" 这种**被编码成字符串的 JSON**，部分客户端还会再包一层。
 */
function parseMaybeJson(value: unknown): Record<string, any> | null {
  let cur: unknown = value;
  for (let i = 0; i < 2; i++) {
    if (typeof cur !== 'string') break;
    const t = cur.trim();
    if (!t.startsWith('{')) break;
    try {
      cur = JSON.parse(t);
    } catch {
      return null;
    }
  }
  return cur && typeof cur === 'object' ? (cur as Record<string, any>) : null;
}

/**
 * 提取会话 ID。按可靠性依次回退，全部失败返回 null。
 *
 * 注意 `x-session-id` 与 metadata 里的 session_id 实测一致，取头部优先是因为它
 * 不依赖请求体结构，对非 ZCode 客户端也能工作。
 */
export function extractSessionId(headers: HeaderBag | undefined, body: any): string | null {
  const fromHeader = header(headers, 'x-session-id');
  if (fromHeader) return fromHeader;

  const meta = parseMaybeJson(body?.metadata?.user_id);
  const fromMeta = meta?.session_id;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();

  // OpenAI 兼容客户端惯用 `user` 字段承载调用方标识。
  if (typeof body?.user === 'string' && body.user.trim()) return body.user.trim();

  return null;
}

/** 校验 IANA 时区名是否可用，避免把脏值写进记录。 */
export function isValidTimezone(tz: string | null): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── 项目推断 ────────────────────────────────────────────────────────────────

/**
 * 带显式标签的工作目录字段。实测 ZCode 的 system prompt 形如：
 *   Primary working directory: C:\Users\admin\.zcode\workspace\default
 *   - Is a git repository: no
 * 这是最可靠的来源，故单列为 'label' 置信度。
 */
const LABELED_WORKDIR_RE =
  /(?:primary\s+working\s+directory|working\s+directory|workspace\s+root|project\s+root|repo(?:sitory)?\s+root)\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\r\n]+))/i;

/** 明显不属于"用户项目"的路径特征，命中即排除。 */
const NOISE_PATH_RE =
  /(^|[\\/])(node_modules|\.git|AppData[\\/]Local[\\/]Temp|Windows|Program Files(?: \(x86\))?|\.zcode[\\/]cli[\\/](plugins|skills|agents|artifacts|exec|log|db)|\.zcode[\\/]workspace[\\/]default[\\/]\.mimosa|dist|__pycache__)([\\/]|$)/i;

/**
 * 规范化候选路径：去引号/末尾标点、把 JSON 转义的双反斜杠还原为单反斜杠、
 * 统一去掉末尾分隔符。
 *
 * 注意：**不能**用 `split(/\\n/)` 之类的规则按"字面量 \n"切分 —— 路径里
 * `\node_modules`、`\new` 这类以 n 开头的段会被误切成两半（实测
 * `C:\proj\node_modules\foo` 被截成 `C:\proj`）。真实换行由捕获正则的
 * `[^\r\n]` 处理；只有"转义换行 + 新字段"这种提示词产物才需要窄规则截断。
 */
export function normalizeProjectPath(raw: string): string | null {
  let s = String(raw || '').trim();
  if (!s) return null;
  // 去掉外层引号
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  // 还原 JSON 双重转义
  s = s.replace(/\\\\/g, '\\');
  // 截断提示词产物的"字面量 \n"：仅当其后紧跟字段标记（- 或 #）时才切，
  // 避免误伤 \node_modules 这类合法路径段。
  s = s.split(/\\n(?=[-#])/)[0];
  // 也是以真实换行截断（双保险）
  s = s.split(/\r?\n/)[0];
  // 去掉尾随的标点与分隔符
  s = s.replace(/[\s,;:.]+$/g, '').replace(/[\\/]+$/g, '');
  if (!s) return null;

  const isWinAbs = /^[A-Za-z]:[\\/]/.test(s);
  const isPosixAbs = s.startsWith('/') && !s.startsWith('//');
  if (!isWinAbs && !isPosixAbs) return null;
  if (NOISE_PATH_RE.test(s)) return null;
  // 只保留路径合法字符，防止把整句话当成路径
  if (!/^[\w\s.:\\/~\-+@()\[\]]+$/.test(s)) return null;
  if (s.length > 200) return null;

  // Windows 盘符统一小写，便于同一路径的稳定分组。
  if (isWinAbs) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

/** 扫描文本中的绝对路径候选（Windows 盘符路径与 POSIX 绝对路径）。 */
function scanAbsolutePaths(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z]:\\[^\s"'`,;<>|]*|\/(?:[\w.@+-]+\/)*[\w.@+-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = normalizeProjectPath(m[0]);
    if (p) out.push(p);
  }
  return out;
}

/** 取路径的父目录（去掉末段）。 */
function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  if (idx <= 0) return null;
  const parent = p.slice(0, idx).replace(/[\\/]+$/, '');
  return parent || null;
}

/**
 * 从 system prompt 文本推断项目根目录。
 *
 * 优先级：
 *   1. 显式标签字段（`Primary working directory:` …）→ 'label'，高置信
 *   2. 扫描候选绝对路径，按**父目录出现频次**取最高者 → 'heuristic'，低置信
 *   3. 都不可靠 → null（宁可留空，不标错）
 *
 * 关于第 2 步的固有局限（务必不要当作事实呈现）：
 *   - 按**父目录**而非完整路径计数 —— 同一项目下的不同文件路径互不相同，
 *     按完整路径计数会永远得到 1，从而漏掉所有项目。
 *   - 它给出的是"被反复引用的目录"，**不等于**项目根：可能落在 src/ 之类的
 *     子目录上，也可能被提及多次的外部路径带偏。
 *   - 因此调用方必须保留 projectSource 标注，界面需与 'label' 区别呈现。
 */
export function inferProject(systemText: string): { project: string | null; source: ProjectSource | null } {
  if (!systemText || typeof systemText !== 'string') return { project: null, source: null };

  // 1) 显式标签 —— 唯一可靠的来源
  const labelMatch = LABELED_WORKDIR_RE.exec(systemText);
  if (labelMatch) {
    const candidate = normalizeProjectPath(labelMatch[1] || labelMatch[2] || labelMatch[3] || '');
    if (candidate) return { project: candidate, source: 'label' };
  }

  // 2) 频次启发式：统计父目录出现次数
  const candidates = scanAbsolutePaths(systemText);
  if (candidates.length === 0) return { project: null, source: null };

  const freq = new Map<string, number>();
  for (const p of candidates) {
    const dir = parentDir(p) || p;
    freq.set(dir, (freq.get(dir) || 0) + 1);
  }
  if (freq.size === 0) return { project: null, source: null };

  // 只被提及一次的目录太可能是顺带引用，不足以作为归属依据。
  const MIN_MENTIONS = 2;
  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, n] of freq) {
    if (n < MIN_MENTIONS) continue;
    // 频次相同时取**更浅**的路径：越靠近项目根，越少是子目录。
    if (n > bestCount || (n === bestCount && best !== null && dir.length < best.length)) {
      best = dir;
      bestCount = n;
    }
  }
  if (!best) return { project: null, source: null };
  return { project: best, source: 'heuristic' };
}

/** 从 Anthropic 请求的 system 字段（字符串或块数组）取出纯文本。 */
export function systemTextOf(body: any): string {
  const sys = body?.system;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

/**
 * 汇总一次请求的上下文字段。任何一项无法确定时对应字段为 null，
 * 由下游按"未识别"呈现，不编造取值。
 */
export function buildRequestContext(headers: HeaderBag | undefined, body: any): RequestContext {
  const tz = header(headers, 'x-client-timezone');
  const { project, source } = inferProject(systemTextOf(body));
  return {
    sessionId: extractSessionId(headers, body),
    project,
    projectSource: source,
    sessionType: header(headers, 'x-zcode-session-type'),
    agent: header(headers, 'x-zcode-agent'),
    timezone: isValidTimezone(tz) ? tz : null,
  };
}

/** 取路径末段作为展示名（完整路径可能含用户名，面板默认只显示末段）。 */
export function projectDisplayName(project: string | null | undefined): string {
  if (!project) return '未识别';
  const parts = project.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || project;
}
