# Changelog

所有主要版本更新都记录在此文件。

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
