# Changelog

所有主要版本更新都记录在此文件。

## [4.10.0] - 2026-09-12

### 修复
- **燃烧速率预测 UI 从未显示** — `renderUsageForAccount` 引用 `window5hProjection` 元素，但 HTML 里从未定义它（`if (pNote)` 静默跳过），"约 X 分钟后撞上限额"的核心预警实际是死代码。已在 5 小时窗口卡片补回该元素。
- **内联 thinking 标签剥离的定界符丢失** — 编码器用 `' thinking'` / `' response'`（空格前缀）做定界，系历史编辑事故中 `<think>` 类标签被剥掉的残留。后果：模型正常回复里任何含英文单词 "thinking" 的句子都会被误路由进 `reasoning_content`，而真正的 `<think>…</think>` 块反而不被处理。现按真实标签 `<think>`/`<thinking>`（含跨 delta 拆分）用状态机重写，并锁定"含 thinking 字样的普通英文不受影响"的回归测试。
- **上游用量请求无超时** — `fetchJson`（whoami/credits/subscriptions/summary）此前为裸 fetch，上游挂起时登录、仪表盘聚合、5 分钟额度采样会无限等待。现统一 15s 超时（`AbortSignal.timeout`）。
- **`npm test` 在干净克隆上必挂** — 集成测试 spawn `dist/index.js`，无 dist 时必然 "Proxy did not become ready in time"。现在 dist 缺失时整个集成套件自动跳过并提示先 `npm run build`。

### 安全
- **管理面纳入共享密钥鉴权** — `PROXY_API_KEY` 此前只保护 `/v1/*`，绑定 `0.0.0.0` 时局域网内任何人仍可直连 `/api/*` 增删账号、切换 Key、清空历史。现在 `/api/*` 与 `/v1/*` 共用同一把密钥（常量时间比较）；仪表盘首次收到 401 时弹出密钥输入框，提交后自动重试原请求，密钥仅存 sessionStorage（关标签页即清除）。并发 401 共享同一次输入，取消后 60 秒内不再打扰轮询。
- **非回环绑定且未鉴权时的醒目警示** — `/api/status` 新增 `boundNonLoopback` 字段；概览页"安全"卡片在"非回环 + 无密钥"时变红色"未鉴权暴露！"并悬停给出修复路径；启动日志与控制台同步输出警告。
- **管理接口防跨站驱动** — CORS 只能阻止"读响应"而非"发请求"。`/api/*` 的写操作现在校验 `Origin` 头与请求 host 一致（非浏览器客户端不带 Origin，不受影响）。
- **`PROXY_API_KEY` 比较改为常量时间**（`crypto.timingSafeEqual`）。
- **SSRF 网段覆盖补全** — 私有/保留地址判定补充 100.64.0.0/10（CGNAT）与 198.18.0.0/15。

### 改进
- **仪表盘静态资源本地化** — Tailwind / Font Awesome / Chart.js 从三个公共 CDN 改为随仓库 `public/vendor/` 分发（经 `/assets/vendor/*` 服务，含字体，路径穿越防护），离线或 CDN 不可达时界面不再掉样式、丢图表；`pkg` assets 同步纳入。
- **`usage-history.jsonl` 大小轮转** — 默认 20MB（`USAGE_HISTORY_MAX_MB` 可调），超限保留较新一半；此前只追加不轮转，仪表盘每 30s 全量读取聚合会随文件增长持续变慢。
- **日志持久化** — 全量日志追加到 `logs/proxy.log`（`COMMANDCODE_LOG_PATH` 可改，超 5MB 轮转 `.old`），控制台窗口关闭后仍可事后排查；路径解析收敛到 `utils/paths.ts`（logger 复用，避免循环导入）。
- **错误可关联到用量记录** — 非流式 chat 请求现在预生成 `traceId`（响应 id、错误日志、usage 记录三者一致）；流式/致命错误日志与上游错误日志带上 `Trace`/`Thread`（threadId 即 x-session-id），一次失败可从报错串到归因明细。
- **用量统计缓存** — 新增 `fetchLiveUsageStatsCached`（45s TTL + 并发去重），仪表盘 overview/aggregate 共用；实测切用量页的重复上游请求（每账号 4 个/轮）从每轮 2.9s 降到毫秒级命中。登录与额度轮换仍走未缓存的原始拉取，保证新鲜度。
- **未捕获异常的退出策略** — 单次异常仍只记日志；但 5 分钟内累计 3 次（Exception/Rejection 合并计数）即主动 `exit(1)`，交给服务管理器/看门狗重启，避免带病进程挂着僵死的上游连接。
- **仪表盘 SPA 迁出模板字符串** — 约 1000 行内嵌 HTML/JS 迁为静态文件 `public/index.html`，`GET /` 改为按请求读取（`dashboard.ts` 从 1400+ 行降到 404 行）；前端代码从此可独立编辑、可在浏览器 devtools 直接调试源文件；`pkg` assets 更新为 `public/**/*`。服务内容与迁出前逐字节一致（迁移即抓取运行时输出）。
- **原生 alert/confirm 全部替换** — 新增与面板风格一致的轻量 toast（成功/失败/信息，4s 自动消退）与确认模态（Esc 取消、Enter 确认）：浏览器登录结果反馈、移除账号、清空会话历史三处流程；原生弹窗数量归零。
- **界面交互** — "实时日志"标签页现在真的实时（激活时每 5s 轮询）；登录模态支持 Enter 提交 / Esc 关闭并自动聚焦；账号卡片按钮改为事件委托（去掉内联 onclick 拼 JS 字符串）；页面切入后台时暂停状态/用量轮询；补充 favicon。
- **模型页人民币价格为折算参考** — 明示按 1 USD ≈ ¥6.72 折算（此前汇率硬编码无说明）。
- **CJK 感知的 token 兜底估算** — 上游未回 usage 时，输入/输出量估算对中文文本从"4 字符=1 token"改为 CJK 字按 1 字 1 token 计，减少数倍低估。
- **chat/messages 双出口助手收敛** — SSE 头、事件行解析、长连接加固、会话持久化收敛到 `src/routes/sse-common.ts`，消除双份实现。

### 工程化
- **新增 GitHub Actions CI**（`.github/workflows/ci.yml`）：push/PR 上自动执行 `npm ci → typecheck → build → vitest run`（先 build 是因为集成测试 spawn `dist/index.js`）。
- **定价页解析契约锁定** — `parsePricingFromHtml` 导出并用合成 RSC fixture 锁定：多 chunk 拼接、静态价含缓存价、峰/谷分时价双保留（回归早期"峰时价被丢弃"）、`onGoPlan` 只看显式档位键不看 `all`、缺 id 行跳过、无 payload 返回空。官方页面改版时会在这里变红而不是静默失效。
- **`resolveModelName` 表驱动测试**：精确 / 前缀剥离 / 后缀 / 展示名 / 部分包含 / 家族规则 / 未知透传 / 空输入共 10 组；为此新增 `setCachedModelsForTest` 测试挂钩。
- **输出 token 兜底估算统一 CJK 感知** — `estimateTextTokens` 覆盖 adapter 编码器、chat/messages 非流式累计的全部输出路径（此前只换了输入侧）。

### 测试
- 新增：`<think>` 标签拆分（单 delta / 跨 delta）、普通英文含 "thinking" 不误判；定价页解析 5 项；模型解析 10 项；适配 `describe.skipIf` 跳过逻辑。新增 `tests/auth.test.ts`（6 项，`fastify.inject` 不监听端口）：密钥开启时 /v1 与 /api 双面 401/200（Bearer 与 x-api-key）、错误密钥拒绝、`/v1/messages` 返回 Anthropic 信封而其余返回 OpenAI 形态、非保护路径放行、未配置密钥时不注册钩子。全量 **216 项通过**（含 build 后 31 项集成），`tsc --noEmit` 无错误。

- 版本号 `4.9.2` → `4.9.3`。

## [4.9.2] - 2026-09-12

### 修复
- **桌面通知的静默失败现在可自诊断** — 4.9.1 修掉 AUMID 未注册后，实机验证发现通知**仍然**不显示：通知平台事件日志（`Microsoft-Windows-PushNotification-Platform/Operational`，事件 3150）显示 `PolicyReason [GlobalSettingDisabled]`——**系统通知总开关本身是关闭的**（`HKCU...PushNotifications\ToastEnabled=0`），且**所有应用**（包括 ZCode 自己）的通知都在被同一策略拒绝。本代理无从修复用户的系统开关，但可以把它讲出来：
  - 启动时主动读取总开关（经 PowerShell `Get-ItemProperty`，60 秒缓存），关闭则在日志中给出**明确的修复路径**（Windows 设置 → 系统 → 通知）；
  - `notify()` 在总开关关闭时不再白白 spawn 一个注定被拒的 PowerShell 进程，直接跳过并在日志写明原因（同一原因 30 分钟去重，不刷日志）；
  - 开关状态可随时变化，因此不永久缓存。
- **改用 PowerShell 而非 `reg.exe` 读注册表** — 本机实测 `reg.exe` 的命令行查询（无论带不带 `/v`）均被以"无效语法"拒绝（status=1、无输出，疑似安全软件干扰），而 `Get-ItemProperty` 读同一键稳定可用。诊断同样依赖"工具可用性以实测为准"，否则会得出"通知已开启"的错误结论（本过程实际发生过一次）。

### 验证
- 修复路径实测闭环：总开关关闭时启动日志输出"系统通知总开关已关闭，桌面通知将不会显示"；用户打开开关后，toast 以自有 AUMID（`CommandCode.Proxy`）**真实弹出并收到**——即 4.9.1（AUMID 注册）+ 本版（开关诊断）两层修复叠加后功能完整可用。
- 全量 **193 项通过**，`tsc --noEmit` 无错误。

- 版本号 `4.9.1` → `4.9.2`。

## [4.9.1] - 2026-09-12

### 修复
- **桌面通知被 Windows 静默丢弃（从未真正显示过）** — toast 必须以**已注册的应用标识（AUMID）**发出，此前随手用了 `'CommandCode Proxy'` 这个未注册字符串，导致 PowerShell 调用成功返回（日志显示已发送）但 **Win11 在展示层直接丢弃且不报任何错**——即通知功能实际上从未生效。实测环境 Win11 25H2（build 26200）。
  - 现按本机其他应用（豆包/抖音/Steam++）的同一方式，把 AUMID 注册进 `HKCU\Software\Classes\AppUserModelId\CommandCode.Proxy`（`DisplayName` + `ShowInSettings`），**无需管理员权限、无需打包**，通知显示为 "CommandCode Proxy" 并可在 Windows 通知设置中单独管理。
  - 注册幂等（已存在则不再写注册表），进程内缓存探测结果，并在启动时预注册（`setImmediate`，不阻塞）。
  - 注册失败时**回退到 PowerShell 自身的 AUMID**——通知显示名会变成 "Windows PowerShell"，但至少能显示出来；日志中以 `[own]` / `[fallback]` 区分实际使用的标识。
  - 可选环境变量 `COMMANDCODE_NOTIFY_ICON` 指定 .ico 路径，设置后通知带图标。
- **头部注释中的错别字**（`採接` → `拼接`）。

### 测试
- 新增 `tests/notifier.test.ts`（8 项）：事件去重（窗口期内只发一次、跨键互不影响、超窗重发）、`COMMANDCODE_NOTIFY` 多种关闭写法、自有 AUMID 与回退标识的区分、通知正文 XML 转义（防拼进 PowerShell 脚本时注入）。
- 全量 **193 项通过**（基线 185），`tsc --noEmit` 无错误。

### 验证
- 注册表确认写入成功（`reg query` 可见 `DisplayName=CommandCode Proxy`、`ShowInSettings=1`）；启动日志输出 `AUMID registered`；实发通知日志标记为 `[own]`，表示走的是自有标识而非回退。

- 版本号 `4.9.0` → `4.9.1`。

## [4.9.0] - 2026-09-11

### 新增
- **端到端吞吐与延迟分布** — 面板新增"端到端性能"表：每模型的吞吐 P50/P95（t/s）、延迟 P50/P95、样本数；"会话明细"表新增**吞吐**列。
  - 口径在界面与代码注释中**显式标注**：`timingMs` 覆盖整个请求生命周期（上游排队、重试、网络往返），因此这是**端到端吞吐**而非模型生成速度 —— 用来比较"体感等待"是准确的，用来评估模型快慢会失真。
  - 只计 `COMPLETED` 且有输出的请求；无输出/无耗时返回 null 而非 0。
- **额度燃烧速率预测** — "账号与额度"页的 5 小时窗口卡片新增预测行：按当前速率**多少分钟后撞上限额**、是否**早于官方重置时间**（唯一需要行动的结论）。
  - **关键口径**：官方 `windowLimits.fiveHour.used` 是全账号值，而本地用量历史只覆盖代理流量（实测约 18%），用本地速率外推会严重高估剩余时间、给出危险的反向预警。因此速率来自**官方 used 的时间差分**：新增 `src/utils/quota-tracker.ts`，每 5 分钟采样一次 `credits` 端点（只拉这一个端点，开销最低），对采样做差分得燃烧速率。
  - 采样跨度不足 10 分钟时自动放宽取更早样本以抑制噪声；官方计数回落（窗口重置/口径修正）时速率为 0、不外推；过期采样（>6h）丢弃；缺 `resetAt` 时撞限判断为 null 而非猜测。
  - 面板采样不足时显示"采样中"，速率非正时显示"当前无消耗"。
- **桌面通知（Windows toast）** — 新增 `src/utils/notifier.ts`，在三类用户多半不在面板前的时机主动提醒：**5 小时窗口将早于重置耗尽**、**auto-quota 自动切换账号**、**引擎被暂停**。
  - 用 PowerShell 原生 `Windows.UI.Notifications` toast，**零第三方依赖**；同一事件 30 分钟去重限频（避免把用户烦到关闭通知权限）；通知失败只记日志，绝不影响代理请求路径；`COMMANDCODE_NOTIFY=0` 可整体关闭。

### 变更
- `GET /api/usage/history` 新增 `byModelPerf` 与 `quotaProjection` 块；打开面板本身也会产生一个额度采样点。
- `config.ts` 新增 `fetchWindowLimits()`：只拉 `credits` 的轻量采样接口，与完整的 `fetchLiveUsageStats`（4 个端点）区分。

### 测试
- 新增 `tests/perf-quota.test.ts`（17 项）：
  - 吞吐：500 tok/5s = 100 t/s，无输出/无耗时/非法值返回 null；
  - 百分位：P50/P95 线性插值落点、单元素、空数组；
  - 燃烧速率：线性外推、**撞限早于重置 = true / 重置早于撞限 = false**（这对结论的方向性被专门锁住）、计数回落时速率为 0、跨度不足自动放宽、过期采样丢弃、缺 `resetAt` 返回 null、采样器容量上限与非法值拒绝。

### 验证
- 实机：`byModelPerf` 返回真实分布（`deepseek-v4.1-flash` 377 样本、吞吐 P50 76.5 t/s / P95 171.5 t/s、延迟 P50 5.45s）；`quotaProjection` 首个采样正确给出余量与重置倒计时、速率待累计；Windows toast 独立进程实测弹出成功。
- 全量 **185 项通过**（基线 168），`tsc --noEmit` 无错误。

- 版本号 `4.8.0` → `4.9.0`。

## [4.8.0] - 2026-09-11

### 新增
- **会话维度聚合（客户端声明的标识）** — 按会话归因每次请求的成本与 token。
  - 会话 ID 取自客户端发送的 `x-session-id` 头，实测值与磁盘上的会话目录名 `sess_<uuid>` 完全一致（独立交叉印证），属**事实性标识**而非推测。
  - 三级回退：`x-session-id` → 请求体 `metadata.user_id`（实测是**被编码成字符串的 JSON**，需二次解析）→ OpenAI 兼容客户端的 `user` 字段。全部失败则留空，**不猜测填充**。
  - 同时采集 `x-zcode-session-type`（main / subagent）、`x-zcode-agent`。
  - 面板新增**会话排行**表：会话 ID、所属项目、请求数、成本、agent、持续时长，并标注「声明值」徽章。
- **项目维度聚合（文本推断，带置信度）** — 按项目归因成本。
  - 上游**不提供**该维度（`/alpha/usage/{projects,sessions,history,breakdown,daily,...}` 等 12 个候选端点实测全部 404），代理自身也没有调用方工作目录（原 `x-project-slug` 取自代理自己的 `process.cwd()`，是无效值），因此只能从 system prompt 文本提取。
  - 两级来源并**逐条标注置信度**：`label` = 命中显式字段（实测 ZCode 的 `Primary working directory: <路径>`，高置信）；`heuristic` = 按路径**父目录**出现频次推断（低置信，≥2 次才采纳）。
  - 护栏「宁可留空，不标错」：无标签且无可信频次 → `project` 为空，面板显示「未识别」。显式排除 `node_modules` / `AppData\Local\Temp` / `Windows` / `.zcode\cli\{plugins,skills,artifacts,exec,log,db}` 等噪声目录。
  - 面板新增**项目分布**表，`推断` 徽章 + 每行 `标签`/`推测` 置信度标记，与「声明值」会话表**视觉上明确区分**，并写明「项目无权威字段来源」。
- **归因覆盖度披露** — `GET /api/usage/history` 新增 `attribution` 块（`sessionsIdentified` / `projectsIdentified` / `projectsLabeled` / `totalRecords`），面板显示"已归因 N/M 条"。
- **按客户端时区分组日期** — 此前 `dayKey` 用服务器本地时区，跨时区调用方会看到日期错位（UTC+8 用户在本地 00:30 的请求被归到前一天）。现读取 `x-client-timezone`（经 `Intl` 校验，非法值回退服务器时区）按其计算。

### 修复
- **头部大小写处理不完整** — `header()` 原先只查小写名，真实的原始大小写头部（如 `X-Session-Id`）取不到值；现按小写归一后遍历匹配。
- **`normalizeProjectPath` 误截断合法路径段** — 原先用 `split(/\\n/)` 处理提示词里的字面量 `\n`，把 `C:\proj\node_modules\foo` 这类**以 `n` 开头的路径段**切成了 `C:\proj`。现改为仅在字面量 `\n` 后紧跟字段标记（`-` 或 `#`）时才截断。
- **频次启发式失效** — 原先按**完整文件路径**计数，而同一项目下各文件路径互不相同，导致计数永远为 1、推断永不生效；现改为按**父目录**计数，并在频次相同时取更浅（更接近项目根）的路径。

### 变更
- `UsageRecord` 新增 `sessionId` / `project` / `projectSource` / `sessionType` / `agent` / `timezone`（均为可选，不确定则不写入）。
- `getUsageStats()` 新增 `byProject` / `bySession` / `attribution`；未识别项目单独成组而非静默丢弃。
- 同一会话跨多次推断得到不同项目时保留首个非空值，避免抖动。

### 测试
- 新增 `tests/attribution.test.ts`（36 项）：
  - 会话 ID 三级回退、双层编码 metadata、空白值、大小写头部、裸客户端返回 null；
  - 时区校验（合法 IANA vs `Not/AZone`）；
  - 路径规范化：盘符小写、双重转义还原、引号剥离、噪声目录排除、相对路径拒绝、超长拒绝，以及**三个已修缺陷的回归**（`\node_modules` 误截断、父目录计数、字面量 `\n` 截断）；
  - 项目推断：标签优先、无标签时频次推断、**只出现一次必须返回 null**、空/非法输入、标签值不可用时回落启发式；
  - 聚合：项目按成本排序并保留置信度、未识别单独成组、会话仅计有 ID 的记录、`attribution` 计数、跨推断抖动保护、**客户端时区分组生效**（23:30 UTC 在上海时区归到次日）。
- 全量 **168 项通过**（基线 132），`tsc --noEmit` 无错误。

### 验证
- 实机：新记录正确落盘 `sessionId=72c84a09-…`、`project=c:\Users\admin\.zcode\workspace\default`、`projectSource=label`、`agent=glm`、`timezone=Asia/Shanghai`；`/api/usage/history` 的 `byProject` / `bySession` / `attribution` 均返回正确数据。

- 版本号 `4.7.0` → `4.8.0`。

## [4.7.0] - 2026-09-11

### 新增
- **缓存节省可视化** — 面板"用量与监控"页新增**缓存节省**卡片，显示缓存命中相比"全价输入"省下的金额，并给出它相对账面成本的倍数，回答"为什么我的账单远低于输入量×输入价"。
  - 节省额 = `cacheReadTokens × (输入价 − 缓存读价)`，按**每条记录自身的发生时刻**取费率 —— 峰谷价不同，用当前时刻算历史记录会算错。
  - 聚合层新增 `savingsUsd` / `savingsMultiple`（总计），以及 `byDay` / `byModel` 维度的 `savingsUsd`。
  - 护栏：缓存单价高于输入价（反常定价）时不报负节省，返回 0。
- **峰谷计费时段提示** — 面板顶部新增提示条，显示当前处于**峰时还是谷时**、**多少小时后切换**，并列出受分时价影响模型的当前生效费率。
  - 新增 `describeBillingWindow()`：给出 `isPeak` / `nextChangeAt` / `nextIsPeak` / `minutesUntilChange`，切换点通过枚举官方边界（UTC 01/04/06/10）求得，因此**周末与工作日交界能正确跨越**（如周五 10:00 后一直谷时，直到下周一 01:00）。
  - 新增 `getTimeOfDayModels()`：列出带 `timeOfDay` 的模型及其当前档位费率（通常 4 个 deepseek 模型）。
  - `GET /api/usage/history` 响应新增 `billing` 块（`window` + `models`）。

### 测试
- `tests/cost-usage.test.ts` 从 19 项扩至 **33 项**，新增：
  - 缓存节省按 (输入价 − 缓存读价) 计算，峰时 $0.044819712（152,448 token × 0.294/M）等实测值；
  - 峰时节省严格大于谷时同量（比值 2:1，对应费率差 0.294 vs 0.147）；
  - 零缓存、未知模型、**缓存价高于输入价**三种边界均返回 0；
  - 峰谷窗口：峰时 02:00 → 切换点 04:00（120 分钟后）、06:30 → 10:00、谷时 00:30 → 01:00（30 分钟后）、**周五 12:00 → 下周一 01:00 跨越周末**、周六 → 下周一 01:00；
  - 全部模型均为静态定价时 `describeBillingWindow` 返回空窗口、`getTimeOfDayModels` 返回空数组。
- 全量 **132 项通过**（基线 118），`tsc --noEmit` 无错误。

### 验证
- 实机复算：按记录时刻选档独立重算节省额得 **$3.9725**，与接口返回 **$3.9055** 偏差 **1.72%**，差额来自两次读取之间的新增实时请求（文件持续追加）。其中峰时记录贡献 $2.70、谷时 $1.27，与预期分时行为一致。

- 版本号 `4.6.0` → `4.7.0`。

## [4.6.0] - 2026-09-11

### 修复
- **面板成本与官方账单差约 15 倍（缓存命中被按全价输入计费）** — 上游 `finish` 事件的 `inputTokens` 是**含缓存命中的总量**，缓存明细在 `inputTokenDetails.cacheReadTokens`。此前 `usage-store` 把整段输入统一按 `pricing.input` 计价，而 agent 场景的输入约 **96%–99% 命中缓存**，官方缓存读单价仅为输入价的 **1/50**（如 `deepseek-v4.1-flash` 谷时输入 $0.15/M、缓存读 $0.003/M）。
  - 实测对照：一条 `input 153,993（缓存命中 152,448）/ output 176` 的请求，旧口径记 **$0.023205**，官方账单为 **$0.001589388** —— 虚高 **14.6 倍**；缓存命中率更高时可达 29 倍。
  - 现在按 `nonCache×input + cacheRead×cacheRead + cacheWrite×cacheWrite + output×output` 分项计价。
- **峰时请求成本被低估一半** — 官方对 4 个 deepseek 模型设**峰谷分时价**（谷时 $0.15/$0.60、峰时 $0.30/$1.20，峰时为 UTC 周一至周五 01–04 与 06–10，共 7h/day）。此前解析定价页时只取 `tiers[0].rates`（= 谷时档），`timeOfDay` 整块被丢弃，峰时请求一律按谷时价估算。
  - 现已解析 `timeOfDay.peak` / `offPeak` / `windows` / `peakHoursPerDay` 并落盘，估算时按请求时刻选档（`isPeakBillingTime`）。
- **类型声明与上游实际结构不符** — `CCEvent.totalUsage` 原先声明的是 `cacheReadTokens` / `cacheWriteTokens`（顶层平铺），与上游实际的 `inputTokenDetails` 嵌套结构对不上，导致即使想读缓存量也读不到。现按实测结构重写并新增 `CCEventUsage` 类型。

### 新增
- **采集上游权威账单金额（`gateway.cost`）** — 上游 `provider-metadata` 事件带回网关已算好的账单字段（`cost` / `marketCost` / `surchargeCost` / `gatewayCost` / `inferenceCost` / `inputInferenceCost` / `outputInferenceCost` / `generationId`），此前该事件**完全没有处理分支**、整条被丢弃。新增 `src/adapters/commandcode/usage.ts` 统一采集：
  - 成本**优先采用官方 `gateway.cost`**，上游未给出时才回落到本地估算 —— 连峰谷价、缓存折扣与加成都不必自行维护；
  - 记录新增 `costSource`（`official` / `estimated`）与 `estimatedCostUsd`，面板对本地估算值加 `~` 前缀，悬停可看两者对照，便于上游调价时及早发现偏差；
  - 采集对 `finish-step` / `finish` 两个事件做**覆盖**而非累加 —— 上游同一轮会发两次相同 usage，累加会让 token 翻倍。
- **缓存用量落盘** — `UsageRecord` 新增 `cacheReadTokens` / `cacheWriteTokens`；聚合统计（`getUsageStats`）新增 `cacheReadTokens` 与 `cacheHitRate`（累计缓存命中率）。
- **仪表盘"缓存命中"列与累计命中率** — "用量与监控"页的请求明细新增"缓存命中"列（显示命中量与占输入百分比，悬停看具体数值），"累计"卡片新增累计缓存命中率与命中 token 量，直观解释成本为何远低于"输入 × 输入价"。

### 变更
- `CCEvent.type` 新增 `provider-metadata`；`StreamEncoderState` 新增 `cacheReadTokens` / `noCacheTokens` / `upstreamCostUsd`；`ModelItem` 新增 `timeOfDay`。
- `pricing.json` 结构版本 `PRICING_SCHEMA_VERSION` 2 → 3，旧缓存自动失效并重新抓取，避免升级后 `timeOfDay` 静默为空。
- 旧记录（无缓存字段）在聚合时按缓存 0 处理，**历史成本数字无法回填**。

### 测试
- 新增 `tests/cost-usage.test.ts`（19 项）：
  - **实测数据回归**——直接用真实上游响应的费率复算，断言本地估算与官方 `gateway.cost` 一致到 1e-12：缓存命中探针 `320 非缓存 + 7,296 缓存读 + 13 输出 = 0.000155376`（峰时）、零缓存探针 `64 + 162 = 0.0002136`（峰时）、同量谷时 `0.0002136 / 2`；
  - 缓存明细拆分的多种形态（完整 `inputTokenDetails`、仅 `cachedInputTokens`、无缓存字段）；
  - `finish-step` + `finish` 覆盖语义（防 token 翻倍）；
  - `provider-metadata` 账单采集（字符串 / 数字 / 缺失）；
  - 峰时窗口边界（01:00 / 03:59 / 04:00 / 06:00 / 09:59 / 10:00 UTC）与周末全天谷时；
  - 无分时价的模型回落静态定价、未知模型 `hasPricing=false`。
- 全量 **118 项通过**（基线 99），`tsc --noEmit` 无错误。

- 版本号 `4.5.0` → `4.6.0`。

## [4.5.0] - 2026-09-10

### 新增
- **套餐与计费周期（`/api/usage/overview` 新增 `plan` 块）** — 此前该接口只读 `credits` / `summary`，完全没读订阅信息。现在补齐：`planId` / `name`（Go、GOAT、Pro…）、官方额度与上限（`monthlyCredits` / `fiveHourCap` / `weeklyCap`）、`status`、`cancelAtPeriodEnd`、`currentPeriodStart` / `currentPeriodEnd`，以及派生的周期进度 `totalDays` / `daysElapsed` / `daysLeft` / `cyclePct`。
  - 仪表盘"用量与额度"页新增**计费周期卡片**：剩余天数、周期进度条、起止时间、是否自动续费。订阅额度在续费时刷新且**不结转**，这张卡片让"还剩几天、留了多少额度作废"一眼可见。
- **模型按套餐可用性（新增 `src/utils/plans.ts`）** — 上游定价页的 `availability` 是**按档位的完整映射**（实测 9 个键：`individual-go` / `individual-goat` / `individual-pro` / `individual-pro-v1` / `individual-provider` / `individual-max` / `individual-ultra` / `teams-pro` / `all`），此前解析时被压成单个 `onGoPlan` 布尔，档位信息全部丢失。现在：
  - 原样保留 `availability` 映射并落盘 `pricing.json` / `models.json`；
  - `GET /v1/models` 每个模型新增 `availability` / `available_on_plan` / `plan_tier` 字段；
  - 支持 `?plan=<planId>&available=1` 按档位过滤；不带参数时**行为与之前完全一致**（返回全部模型），避免打断既有客户端；
  - 未显式给 `plan` 时回落到当前账号的套餐（内部 10 分钟缓存，不给每个请求都加一次上游调用）；
  - 判定 **fail-open**：无 availability 数据 → 返回 `undefined` 并**保留**该模型，不误杀（与插件 `modelVisibleInPlan` 的取向一致）；
  - `all` 键**刻意不参与判定**：实测 `claude-opus-4-8` 的 `all=true`，但在 Go 档位调用返回 403 `MODEL_NOT_IN_PLAN`。
  - 档位数值只填官方文档可证实的（Go $10/$3/$6、GOAT $70/$14/$35、Pro $80/$16/$40、Team Pro $40/$12/$24）；`individual-max` / `individual-ultra` / `individual-pro-v1` 与文档中 "Max 10× / Max 20× / Pro" 的对应关系未证实，**只给名称不给数值**，避免面板展示错误数字。

### 修复
- **`/health` 版本号不再硬编码** — 此前固定返回 `"version":"4.0.0"`，与 `package.json` 实际版本无关（探活/监控拿不到真实版本）。现新增 `src/utils/version.ts` 从 `package.json` 读取（兼容 `pkg` 打包路径），`/health`、`/api/status` 与启动横幅统一使用该版本号。

### 测试
- 新增 `tests/plans.test.ts`（12 项）：档位表数值、未证实档位不编造数值、`all` 键不参与判定、fail-open 行为、档位标签折叠、`buildAvailabilityMap` 规范化（保留全部档位、丢弃非布尔值、非法输入返回 undefined）。
- `tests/integration.test.ts` 新增 9 项：`/health` 与 `/api/status` 版本号等于 `package.json`；`plan` 块的套餐名与上限；由 `currentPeriodStart/End` 派生的周期窗口；`/v1/models` 默认响应向后兼容（无 `plan` 块、不过滤）；按档位过滤后不得残留被标记为不可用的模型；每个模型的 `plan_tier` 标签。
- 集成测试的 mock 上游改为按路径分流（此前**所有**路径都返回 SSE，导致仪表盘的 JSON 接口在测试中不可用），并把 `capturedBodies` 的记录范围收窄到 `/alpha/generate`，避免非生成流量污染"重试次数"断言。
- 全量 **98 项通过**（基线 79），`tsc --noEmit` 无错误。

- 版本号 `4.4.0` → `4.5.0`。

## [4.4.0] - 2026-09-10

### 新增
- **结构化错误码 + 可执行提示（移植自 zcode-commandcode-private）** — 新增 `src/utils/errors.ts`，把每次失败归类到 17 个稳定错误码之一，并附一条可执行 `hint`：
  - `ErrorCode` / `ProxyError`：一个错误码同时决定 HTTP 状态、OpenAI 出口的 `error.type`/`error.code`、Anthropic 出口的 `error.type`（Anthropic 客户端按它分支）、以及 `retryable`。
  - 两个出口都带 `code` + `hint`：`/v1/chat/completions` 走 OpenAI 信封，`/v1/messages` 走 Anthropic 信封；`PROXY_API_KEY` 鉴权失败也按 URL 前缀选择信封。
  - `codeForStatus` 映射与原插件对齐（401/403→`INVALID_CREDENTIAL`、402/429→`RATE_LIMIT`、404→`MODEL_NOT_FOUND`、5xx→`SERVER_ERROR`）；另把 400/422 单列为 `UNSUPPORTED_OPTION`——上游拒绝的是本网关翻译出的 wire 体，报成"网络故障"会把排查方向带偏。
  - `terminalCodeFor` 集中判定终止性计费/套餐标记（`model_not_in_plan` / `premium_credits_exhausted` / `insufficient credits`），取代原先散落在 `upstream.ts` 的 `hasTerminalMarker`。
- **流内错误也带错误码** — 流式请求在 HTTP 200 已发出后无法再改状态码，故把错误码并入内容文本：`[Upstream Error: RATE_LIMIT: ...]`；Anthropic 流的 `error` 事件改用规范 `error.type`（原为自定义串 `upstream_error`，不是 Anthropic 规范取值）。

### 修复
- **重试耗尽不再伪装成网络故障** — 此前重试次数用尽后统一抛出 `Upstream connection failed` + 502，客户端会把连续 503 误判成网络问题；现在保留上游真实状态码与错误码（连续 503 → `SERVER_ERROR`/503，连续 429 → `RATE_LIMIT`/429）。

### 变更（不兼容）
- **错误体 `code` 字段语义变化** — 原为数字 HTTP 状态码（与 HTTP status 重复），现为字符串错误码（如 `"RATE_LIMIT"`）。读取该字段的客户端需相应调整；`message` 字段语义与取值保持不变。

### 测试
- 新增 `tests/errors.test.ts`（21 项）：状态码映射、终止性标记识别（大小写不敏感）、`isRetryableFailure` 契约（终止性错误在任何状态码下都不得重试）、每个错误码都必须有非空提示、两种信封形态与 JSON 序列化。
- `tests/integration.test.ts` 新增 9 项错误契约用例（真实构建产物 + mock 上游）：两种出口的错误信封、终止性错误**只尝试一次**（与普通 429 会重试形成对照）、5xx 保留上游状态码、非法请求 400、引擎暂停 503 且恢复后请求重新成功。
- 全量 **79 项通过**，`tsc --noEmit` 无错误（基线 70 项）。

- 版本号 `4.3.0` → `4.4.0`。

## [4.3.0] - 2026-09-10

### 新增
- **工具定义全量透传（不再截断 15 个）** — `convertTools` 不再 `slice(0, 15)`，对 OpenAI/Anthropic 下发的工具定义全部透传给上游（`tools.map`）：
  - 适配 DSH Desktop 等多工具 Agent 宿主：此类宿主会下发 30+ 个工具（read/write/pwsh/web_search 等排在列表后段），截断会让模型调用到被丢弃的工具而被上游拒绝。
  - 上游按收到的清单校验，全部透传即可；`tool_search→search_tools` 别名与 `name/description/input_schema` 映射逻辑保持不变。
  - 新增 `tests/adapter.test.ts` 用例：20 个工具全部保留、首尾顺序不变。
- 版本号 `4.2.4` → `4.3.0`。

## [4.2.4] - 2026-09-08

### 修复
- **兜底账号不再显示占位名** — 无命名账号（仅靠 `COMMANDCODE_API_KEY` / `~/.commandcode/auth.json` 兜底 Key）时，账号名不再写死为 `Default System Account`：
  - 立即显示带 Key 来源与尾 4 位的名称：`CLI Key (尾4位 xxxx)` / `Env Key (尾4位 xxxx)`（`defaultAccountName`，不暴露完整密钥）。
  - 启动后后台用 `/alpha/whoami` 异步补全真实用户名为 `Command Code (xxx)` 并回填 whoami 字段（`enrichDefaultAccountName`，不阻塞启动、失败静默）。
  - dashboard 三处硬编码兜底名统一走该命名函数；`loadDefaultApiKeyFromEnvOrSystem` 改为同时返回来源。
  - 新增 `tests/config-account-name.test.ts`（4 项：来源读取、命名格式、完整密钥不落名）。
- 版本号 `4.2.3` → `4.2.4`。

## [4.2.3] - 2026-09-08

### 修复
- **视觉请求 413（`FST_ERR_CTP_BODY_TOO_LARGE`）** — Fastify 默认入站请求体上限为 1MB，视觉/多图请求的 base64 负载经常超限被拒（status=413、retryable=false）。将 `bodyLimit` 调整为可配置：
  - 默认 **64MB**（`src/utils/config.ts#resolveBodyLimit`）。
  - 新增环境变量 **`MAX_BODY_MB`**（1..1024 的正整数，按 MB 计），非法值/未设置回退默认，便于按需调整。
  - 新增 `tests/config-body.test.ts` 覆盖默认值、读取与非法回退。
- 版本号 `4.2.2` → `4.2.3`。

## [4.2.2] - 2026-09-08

### 文档
- **README 界面截图替换 Mermaid 图** — GitHub 渲染器对含 `<br/>`、`→`、`/` 等字符的 Mermaid 图报词法错误（“架构总览”与“安全校验”流程图无法渲染）。将其移除，改用**实际前端界面脱敏截图**做功能介绍：
  - 新增“界面截图”章节，配三张脱敏截图：控制台总览、模型目录、账号与鉴权，并配中英双语功能说明。
  - 截图来自本地 9092 演示实例（假账号 `sk-demo-...cccc`），不涉及真实凭据；模型目录为内置公开定价。
  - `.gitignore` 增加 `docs/screenshots/` 例外，使截图可随仓库提交。
- 版本号 `4.2.1` → `4.2.2`。

## [4.2.1] - 2026-09-08

### 安全加固
- **上游 URL 默认拒绝环回/私有/保留地址** — 收紧 `assertSafeUpstreamUrl` / `isAllowedUpstreamHost`：
  - 默认只允许 `commandcode.ai` 及其子域；**环回**（`localhost`、`127.x`、`::1`）、**私有**（`10.x`、`172.16-31.x`、`192.168.x`）、**保留/链路本地**（`169.254.x`、IPv6 ULA/链路本地）地址默认一律拒绝（fail-closed）。
  - 自建网关/镜像与本地 mock 上游需通过 `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` **显式**加入允许清单才放行；非回环仍强制 https。
  - 更新 `tests/url-safety.test.ts`（新增环回/私有/保留默认拒绝、显式放行用例；13 项）与 `tests/integration.test.ts`（mock 上游显式允许 `127.0.0.1`）。

### 文档
- **README 双语配图与润色** — 新增“可视化总览”章节（架构总览、一次调用的翻译流程、上游 URL 安全校验三张 Mermaid 图）；新增“安全校验”章节，同步说明环回/私有/保留地址默认拒绝与显式白名单；按最新安全行为校准特性与配置说明（中英双语对等）。
- 版本号 `4.2.0` → `4.2.1`（安全加固 + 文档/README 修订，作为一次补丁发布）。

## [4.2.0] - 2026-09-08

### 安全加固
- **上游 URL 校验（SSRF 加固）** — 新增 `assertSafeUpstreamUrl` / `isAllowedUpstreamHost`，所有服务端上游请求（用量统计 `/alpha/*`、模型同步 `/provider/v1/models`、官方定价页 `/docs/plans/go`、`/alpha/generate`）统一校验：
  - 拒绝非 `http(s)` 协议（`file:`、`gopher:` 等协议混淆）
  - 拒绝 URL 内嵌凭据（`user:pass@host`）
  - 默认只允许 `commandcode.ai` 及其子域 + 回环地址，其余 host 拒绝（块级 SSRF）
  - 非回环 host 强制 `https`（阻止降级到明文 http）
  - 自定义网关/镜像通过环境变量 `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` 追加（逗号分隔）
- **打开浏览器改为无 shell 的 `spawn`** — 用 `rundll32`（Win）/`open`（Mac）/`xdg-open`（Linux）以参数数组调用，彻底移除 `exec` + cmd `start` 的 shell 拼接，杜绝命令注入，并保留对 URL 的绝对地址校验。
- **OAuth 回调 state 校验** — 回调若携带 `state` 必须与本流程随机生成的 `stateToken` 一致，不携带则兼容旧流程，防 CSRF。
- 新增 `tests/url-safety.test.ts`（12 个用例覆盖上述边界）。

### 变更
- 版本号 `4.1.0` → `4.2.0`。

## [4.1.0] - 2026-09-08

### 新增
- **模型目录：搜索 / 标签筛选 / 排序** — 仪表盘"模型"页新增纯前端过滤，不新增后端 API：
  - 关键词搜索（模型 ID / 名称 / 提供商，多词 AND，命中关键字高亮）
  - 标签筛选：GO / FREE / DEAL / 视觉 / 推理
  - 排序：默认、输入价升/降、输出价升/降、缓存读升/降、上下文降序
  - 结果计数（共 N 个 · 命中 M 个）与无结果空态提示
  - "获取最新模型"按钮加载时禁用并置灰，避免重复点击
- **用量卡片令牌大数显示** — 今日 / 本周 / 本月 / 累计的 token 数以百万为单位显示（如 `12.34M`），替代原始长数字。

### 修复
- **"累计"卡片定价提示布局** — `usagePricingNote` 由一次性 inline 浮动改为独立 `p` 标签并保留上边距，避免与卡片内容错位。

### 变更
- 版本号 `4.0.0` → `4.1.0`。
