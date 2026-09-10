# Changelog

所有主要版本更新都记录在此文件。

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
