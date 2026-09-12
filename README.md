# CommandCode Proxy v4 <img src="https://img.shields.io/badge/version-4.5.0-6366f1" alt="v4">

> 中文 | [English](#english-anchor)

一个本地部署、完全兼容 **OpenAI Chat Completions** 与 **Anthropic Messages** 的 API 网关，为 **Command Code AI**（commandcode.ai）提供透明代理。任何 OpenAI 风格的客户端（Cursor、Continue、Aider、OpenWebUI、Hermes、你自己的代码）都能直接指向它，透明地使用 CommandCode 后端模型。

> 非官方社区工具。逆向自官方 CommandCode CLI wire 协议（`/alpha/generate`），与 CommandCode 无任何关联。

---

## 🖼 界面截图 · Screenshots

除命令行外，代理自带一个**中文 Web 仪表盘**（默认 `http://127.0.0.1:9090`），用于查看状态、管理账号与查看用量。以下为实际界面截图（均已脱敏）。
*Beyond the CLI, the proxy ships a built-in **Chinese web dashboard** (default `http://127.0.0.1:9090`) for status, accounts and usage. Real screenshots below, all scrubbed.*

### 控制台总览 · Console Overview

![控制台总览](./docs/screenshots/dashboard-overview.png)

- 一屏掌握运行状态：引擎运行/停止、监听端口、运行时长、当前账号、绑定地址、API 鉴权开关、已注册账号数与可用模型数。
- 顶部可一键切换引擎、切换当前账号、调整额度轮换模式。

### 模型目录 · Model Catalog

![模型目录](./docs/screenshots/dashboard-models.png)

- 官方模型定价目录（上下文 / 输入 / 输出 / 缓存读 / 缓存写 / 能力 / Deal），实时从 commandcode.ai 刷新，也可手动“获取最新模型”。
- 支持**关键词搜索**、**标签筛选**（GO / FREE / DEAL / 视觉 / 推理）与**排序**（输入价、输出价、缓存读、上下文等），令牌数以 K/M 友好显示。

### 账号与鉴权 · Accounts & Auth

![账号与鉴权](./docs/screenshots/dashboard-accounts.png)

- 支持浏览器登录（OAuth）或粘贴 Key 登录；多账号管理，5 小时额度轮换调度（≥90% 自动切换）。
- 密钥在界面上一律**脱敏显示**（如 `sk-demo-...cccc`），可设为当前账号或移除——保证敏感信息不落屏。

## ✨ 功能特性

- **OpenAI `/v1/chat/completions`** — 流式 SSE + 非流式，工具调用（并行工具、流式 `tool_calls` 增量），视觉（`image_url` base64/data-URL），`reasoning_effort` 映射，`max_completion_tokens`，透传上游 `totalUsage` 用量
- **Anthropic `/v1/messages`** — 流式块生命周期（`message_start` → `content_block_start/delta/stop` → `signature_delta` → `message_delta` → `message_stop`），`tool_use` / `tool_result` 往返，带签名兼容的 thinking 块，system 块数组
- **忠实还原 wire 翻译** — 经官方 CLI 源码逐行核对：原始 base64 图片块带 `mediaType`、`tool_search→search_tools` 别名、按模型细分推理档位 snap、终止性错误不重试列表（`model_not_in_plan`、`premium_credits_exhausted`、`insufficient credits`）
- **工具定义全量透传** — `convertTools` 不再截断为 15 个：DSH Desktop 等多工具 Agent 宿主下发的 30+ 个工具（read/write/pwsh/web_search 等）全部透传给上游，避免模型调用被丢弃的工具而被拒绝；`tool_search→search_tools` 别名与 `name/description/input_schema` 映射逻辑不变
- **可靠性** — 429/5xx/网络错误指数退避重试，空闲流看门狗（不会无限挂起），客户端断开即取消，保证流干净收尾
- **多账号** — 仪表盘 OAuth 浏览器登录 + 手动输入 Key，5 小时额度轮换调度器（≥90% 自动切换）
- **安全默认** — 仅绑定 `127.0.0.1`（可用 `HOST` 显式开放局域网），可选 `PROXY_API_KEY` 共享密钥鉴权，XSS 加固仪表盘，CORS 仅对公共 API 表面开放；所有服务端上游请求经 `assertSafeUpstreamUrl` 校验（拒绝非 http(s) 协议、内嵌凭据、非 `commandcode.ai` 的任意 host，且默认拒绝环回/私有/保留地址——除非显式加入允许清单；非回环强制 https），打开浏览器改为无 shell 的 `spawn` 参数调用（杜绝命令注入）
- **打包** — TypeScript 构建、esbuild 打包、`pkg` 生成单文件 Windows exe
- **中文仪表盘** — 内置界面为中文，含官方模型定价目录（上下文/输入/输出/缓存读/缓存写/能力/Deal），实时从 commandcode.ai 刷新；模型目录支持**搜索、GO/FREE/DEAL/视觉/推理标签筛选与排序**，令牌数大数（K/M）友好显示
- **会话明细用量** — 面板的"用量与额度"标签页内置**会话明细**：逐会话记录 input/output token、**缓存命中量**、耗时、成本、模型、状态，并给出按天趋势折线、模型分布饼图、今日/本周/本月成本卡片与**累计缓存命中率**；持久化到本地 `~/.commandcode/usage-history.jsonl`，重启不丢
- **成本口径对齐官方账单** — 成本**优先采用上游 `provider-metadata` 的权威金额**（`gateway.cost`，已含峰谷价、缓存折扣与加成），上游未给出时才本地估算；本地估算按**缓存读/写单价分项计价**（缓存读单价仅为输入价的 1/50）并按**峰谷分时**选档。记录带 `costSource`（`official`/`estimated`）与 `estimatedCostUsd`，面板对估算值加 `~` 前缀、悬停可对照，便于及早发现定价偏差
- **缓存节省可视化** — 面板显示缓存命中相比"全价输入"**省下的金额**及其相对账面成本的倍数，直接回答"为何账单远低于输入量×输入价"；节省额按每条记录**自身发生时刻**的费率计算（峰谷价不同），并有反常定价护栏（缓存价高于输入价时不报负节省）
- **峰谷计费时段提示** — 面板提示**当前处于峰时还是谷时**、**多久后切换**，并列出受分时价影响模型的当前生效费率。切换点按官方边界（UTC 01/04/06/10，周一至周五）计算，**跨越周末也能正确预告**（如周五 10:00 后直到下周一 01:00 才是峰时）
- **端到端性能与额度预测** — 面板显示每模型**吞吐 P50/P95**（t/s）与**延迟 P50/P95**，并在明细表加吞吐列。口径明确标注为**端到端**（含上游排队/重试/网络），反映体感等待而非模型生成速度。另有**额度燃烧速率预测**：对官方窗口用量做时间差分外推"多少分钟后撞上限额、是否早于重置"——刻意不用本地历史外推，因为本地只覆盖代理流量（约 18%），会严重高估剩余时间
- **桌面通知** — 在用户多半不在面板前的时机主动弹 Windows toast：5 小时窗口将早于重置耗尽、auto-quota 切换账号、引擎暂停。原生 `Windows.UI.Notifications`，零第三方依赖，同事件 30 分钟去重限频，失败不影响请求路径；`COMMANDCODE_NOTIFY=0` 关闭。**自诊断**：启动时检测系统通知总开关（Windows 设置 → 系统 → 通知），关闭则在日志给出修复路径且不再空发注定被拒的请求——toast 被系统以 `GlobalSettingDisabled` 静默拒绝时不留任何痕迹，这类失败只能靠主动检测暴露
- **会话与项目归因** — 面板按**会话**与**项目**两个维度拆分成本。会话 ID 取自客户端声明的 `x-session-id`（实测与磁盘会话目录名一致，属**事实性标识**，三级回退且拿不到就留空）；项目则**只能推断**（上游无该维度、12 个候选端点实测全部 404），来源于 system prompt 文本，并**逐条标注置信度**：`label`（显式工作目录字段，高置信）与 `heuristic`（路径频次推断，低置信）。界面明确区分「声明值」与「推断」，未识别项单列而非猜测填充，并披露"已归因 N/M 条"。日期分组按客户端时区计算
- **官方用量总览** — 对齐官方 usage 页面（commandcode.ai/:login/settings/usage）的数据源：**Total Tokens**（含输入/输出拆分）、**Total Runs**（成功/失败/成功率）、**月度限额**进度条来自上游 `/alpha/usage/summary` 与 `/alpha/billing/credits`（与页面 `/internal/*` 接口字段一致，但接受 CLI API Key）；仪表盘新增 `GET /api/usage/overview` 聚合接口
- **结构化错误码** — 任何失败都返回**稳定错误码 + 可执行提示**（`RATE_LIMIT` / `MODEL_NOT_IN_PLAN` / `STREAM_IDLE_TIMEOUT` 等 17 个码），并按出口分别给出 OpenAI 的 `error.type/error.code` 与 Anthropic 的 `error.type`；调用方可据此判断该等额度、换模型还是改配置，详见下节错误码表
- **套餐与计费周期** — `/api/usage/overview` 新增 `plan` 块：套餐名（Go / GOAT / Pro …）、官方额度与 5 小时/周上限、`currentPeriodStart/End`、`cancelAtPeriodEnd`、以及 `totalDays / daysElapsed / daysLeft / cyclePct` 周期进度；仪表盘"用量与额度"页新增**计费周期卡片**（订阅额度到期不结转，这里一眼可见还剩几天）
- **模型按套餐可用性** — 保留上游定价页的**全量档位映射**（此前被压成一个 `onGoPlan` 布尔），`GET /v1/models` 每个模型带 `availability` / `available_on_plan` / `plan_tier`；支持 `?plan=individual-go&available=1` **按档位过滤**（不带参数时行为不变，向后兼容）。判定采用 fail-open：数据缺失时保留而非误杀

## 🚀 快速开始

```bash
npm install
npm run dev          # http://127.0.0.1:9090
```

或生产模式：

```bash
npm run build && npm start
```

或独立二进制：

```bash
npm run build:win    # dist/commandcode-proxy-v4.exe —— 零依赖运行
```

首次启动仪表盘会自动打开。可通过 **浏览器登录（OAuth）** 或粘贴 API Key 登录。密钥也会自动从 `~/.commandcode/auth.json` 或 `COMMANDCODE_API_KEY` 加载。

## 🧪 用法

```bash
# OpenAI 风格（示例用免费模型，任何套餐可直接跑通）
curl http://127.0.0.1:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"meituan/LongCat-2.0:free","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 风格
curl http://127.0.0.1:9090/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"meituan/LongCat-2.0:free","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

> 模型名请以仪表盘"模型"页或 `GET /v1/models` 返回的实时目录为准；免费/折扣模型标有 FREE / DEAL 标签。

客户端配置：OpenAI 风格设 base URL 为 `http://127.0.0.1:9090/v1`，Anthropic 风格设为 `http://127.0.0.1:9090`，密钥随意（若设置了 `PROXY_API_KEY` 则须一致）。

按套餐筛选可用模型（`plan` 可显式指定，也可省略而使用当前账号的套餐；不带 `available` 则为完整目录）：

```bash
curl "http://127.0.0.1:9090/v1/models?plan=individual-go&available=1"
```

## 🚨 错误码与重试语义

任何失败都返回**稳定错误码 + 可执行提示**，调用方可据此判断该等待额度、换模型还是改配置。

OpenAI 出口（`/v1/chat/completions`）：

```json
{ "error": { "message": "Upstream error 429: insufficient credits", "type": "rate_limit_error",
             "code": "RATE_LIMIT", "param": null, "hint": "The plan usage window (5-hour or weekly) is exhausted..." } }
```

Anthropic 出口（`/v1/messages`）：

```json
{ "type": "error", "error": { "type": "rate_limit_error", "message": "...",
                              "code": "RATE_LIMIT", "hint": "..." } }
```

| `code` | HTTP | 含义 |
|---|---|---|
| `MISSING_CREDENTIAL` | 401 | 没有任何可用 Key（环境变量/auth.json/账号池皆空） |
| `INVALID_CREDENTIAL` | 401 | Key 失效或被吊销 |
| `PROXY_AUTH_REQUIRED` | 401 | 未携带匹配的 `PROXY_API_KEY` |
| `RATE_LIMIT` | 429 | 5 小时/周额度耗尽，或余额不足 |
| `MODEL_NOT_IN_PLAN` | 403 | 模型超出当前套餐档位 |
| `MODEL_NOT_FOUND` | 404 | 模型 id 不存在（刷新目录后重试） |
| `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` | 400 | 请求形态或内容无法翻译到上游 wire |
| `REQUEST_TIMEOUT` / `STREAM_IDLE_TIMEOUT` | 504 | 请求超时 / 流中途静默被看门狗中止 |
| `NETWORK_ERROR` | 502 | 连不上上游 API |
| `SERVER_ERROR` | 5xx | 上游 5xx（**保留上游真实状态码**） |
| `PROVIDER_PROTOCOL_ERROR` | 502 | 上游返回体异常（缺 body 等） |
| `CATALOG_UNAVAILABLE` | 503 | 模型目录不可用 |
| `GATEWAY_PAUSED` | 503 | 引擎已在面板暂停 |
| `BLOCKED_HOST` | 500 | 上游地址被 SSRF 防护拒绝 |
| `INTERNAL_ERROR` | 500 | 网关内部异常 |

**重试语义**：`408/409/425/429/500/502/503/504` 按指数退避重试（上限 `upstream.maxRetries`）；一旦命中终止性计费/套餐标记（`model_not_in_plan`、`premium_credits_exhausted`、`insufficient credits`）**立即失败、绝不重试**——重试只会白耗额度。重试耗尽后仍保留上游真实状态码与错误码，不会包装成"网络故障"。

> 流式请求在 HTTP 200 已发出后无法再改状态码，此时错误码会并入内容文本，形如 `[Upstream Error: RATE_LIMIT: ...]`，便于客户端自愈。

## ⚙️ 配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `9090` | 监听端口 |
| `HOST` | `127.0.0.1` | 绑定地址（`0.0.0.0` 暴露到局域网） |
| `PROXY_API_KEY` | 未设置 | 要求 `/v1/*` **与管理面 `/api/*`** 携带该密钥（Bearer 或 `x-api-key`）；仪表盘首次访问会弹出密钥输入，本标签页内记住 |
| `COMMANDCODE_API_KEY` | 取自 auth.json | 上游密钥兜底；无命名账号时账号名显示为 `CLI Key (尾4位 xxxx)` / `Env Key (尾4位 xxxx)`，启动后由 whoami 异步补全真实用户名 |
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | 上游服务地址 |
| `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` | 未设置 | 追加允许的上游 host（逗号分隔，供自建网关/镜像）；环回/私有/保留地址默认拒绝，仅在此显式加入才放行 |
| `COMMANDCODE_VERSION` | `1.27.1` | CLI 版本标识头 |
| `ROTATION_MODE` | `manual` | `auto-quota` 启用 30 分钟额度检查 |
| `NO_OPEN_BROWSER` | 未设置 | 设为 `1` 跳过仪表盘自动打开 |
| `MAX_BODY_MB` | `64` | 入站 JSON 请求体上限（MB）；视觉/多图 base64 负载超默认 1MB 会触发 413（`FST_ERR_CTP_BODY_TOO_LARGE`），范围 1..1024 |
| `USAGE_HISTORY_MAX_MB` | `20` | 会话历史 `usage-history.jsonl` 的大小上限（MB）；超限时保留较新的一半，防止文件无限增长拖慢仪表盘聚合 |
| `COMMANDCODE_LOG_PATH` | `<项目根>/logs/proxy.log` | 运行日志落盘路径（全量追加，超 5MB 轮转为 `.old`）；控制台窗口关掉后仍可事后排查 |

持久化配置存于可执行文件旁的 `config.json`。

## 🛠 开发

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest —— 单元 + 集成（mock 上游）
npm run build:exe    # esbuild 打包
npm run build:win    # Windows exe
```

测试会拉起一个 mock CommandCode 上游，端到端跑通真实 HTTP 面：流式 chunk 形状、工具调用往返、推理档位 snap、Anthropic 块生命周期。

详见 [HERMES_TEST_PROMPT.md](./HERMES_TEST_PROMPT.md) 了解 agent 驱动的自测方案（让 LLM agent 穿过代理跑真实行为验证）。

## 🏗 架构

```
src/
├── index.ts                      # 启动引导、额度轮换调度、可选鉴权钩子
├── types/index.ts                # OpenAI / Anthropic / CC-wire 契约
├── adapters/commandcode/
│   ├── adapter.ts                # 翻译引擎（两种协议 ↔ CC wire，含中文注释）
│   └── upstream.ts               # HTTP 客户端：重试、空闲看门狗、中止
├── routes/
│   ├── chat.ts                   # POST /v1/chat/completions
│   ├── messages.ts               # POST /v1/messages
│   ├── models.ts                 # GET /v1/models、refresh
│   ├── dashboard.ts              # 管理 API 与静态资源路由
│   └── sse-common.ts             # 双出口共享：SSE 头/事件解析/持久化
public/
├── index.html                    # 仪表盘 SPA（中文界面）
└── vendor/                       # 本地化的 tailwind / font-awesome / chart.js
└── utils/
    ├── config.ts                 # 账号、OAuth 流程、额度轮换
    ├── models.ts                 # 目录同步 + 模糊模型名解析
    ├── usage-store.ts            # 会话明细持久化 + 聚合统计
    └── logger.ts                 # 净化环形缓冲日志
```

## 🔒 安全校验 · Upstream URL safety

代理对**所有**服务端上游请求做白名单校验，采用 fail-closed（不满足即拒绝），而非降级放行：

校验顺序为：仅允许 `http(s)` → 拒绝内嵌凭据 → 拒绝环回/私有/保留地址（除非显式允许）→ host 属于 `commandcode.ai` 及子域或显式允许清单 → 非回环强制 `https`，全满足才放行。

- **默认只允许** `commandcode.ai` 及其子域；环回（localhost、127.x、::1）、私有（10.x、172.16-31.x、192.168.x）、保留/链路本地（169.254.x、IPv6 ULA/链路本地）及任意公网地址默认一律拒绝，除非运维显式加入允许清单。
- **环回/私有受控例外**：本地 mock 上游、自建网关/镜像与开发测试需通过 `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` **显式**加入允许清单才放行。这是**运维显式配置**的受控例外，而非默认放行或客户端可控路径——上游地址只由 `COMMANDCODE_API_BASE` 等**运维环境变量**决定，不随客户端请求参数变化，因此不存在把客户端输入导向内网的 SSRF 路径。
- 配套校验：拒绝非 `http(s)` 协议（防 `file:`、`gopher:` 协议混淆）、拒绝内嵌凭据（`user:pass@host`）、非回环 host 强制 `https`（防降级明文；回环且显式放行时允许 http，供本地 mock）。

## 📄 免责声明与许可证

本项目通过观察官方 CLI 的网络行为来与私有 API 互通。上游协议变动时可能失效，使用可能受 CommandCode 服务条款约束。请用自己的账号与凭据使用。

本项目使用 **MIT 许可证** 发布，详见 [LICENSE](./LICENSE)。

---

## <a id="english-anchor"></a>English

A local, fully-compatible **OpenAI Chat Completions** and **Anthropic Messages** API gateway for CommandCode AI. Point any OpenAI-style client (Cursor, Continue, Aider, OpenWebUI, Hermes, your own code) at it and use CommandCode backend models transparently.

> Unofficial, community tool. Reverse-engineered from the official CommandCode CLI wire protocol (`/alpha/generate`). Not affiliated with CommandCode.

> The bilingual **Screenshots** section above shows the real dashboard UI (console overview, model catalog, accounts), all scrubbed.

### Features

- **OpenAI `/v1/chat/completions`** — streaming SSE + non-streaming, tool calling (parallel tools, streamed `tool_calls` deltas), vision (`image_url` base64/data-URL), `reasoning_effort` mapping, `max_completion_tokens`, usage passthrough from upstream `totalUsage`
- **Anthropic `/v1/messages`** — streaming block lifecycle (`message_start` → `content_block_start/delta/stop` → `signature_delta` → `message_delta` → `message_stop`), `tool_use` / `tool_result` round-trip, thinking blocks with signature compatibility, system block arrays
- **Faithful wire translation** verified against the original CLI source: raw-base64 image parts with `mediaType`, `tool_search→search_tools` aliasing, per-model effort tier snapping, terminal-error no-retry list (`model_not_in_plan`, `premium_credits_exhausted`, `insufficient credits`)
- **Full tool passthrough** — `convertTools` no longer truncates to 15 tools: the 30+ tools issued by multi-tool agent hosts (DSH Desktop and similar, e.g. read/write/pwsh/web_search at the end of the list) are all forwarded to upstream, preventing the model from calling dropped tools and being rejected; `tool_search→search_tools` aliasing and `name/description/input_schema` mapping are unchanged
- **Reliability** — exponential-backoff retries on 429/5xx/network errors, idle-stream watchdog (no infinite hangs), client-disconnect cancellation, clean stream termination guaranteed
- **Multi-account** — dashboard OAuth browser login + manual key entry, 5-hour quota rotation scheduler (auto-switch ≥90%)
- **Secure defaults** — binds `127.0.0.1` only (opt-in LAN via `HOST`), optional `PROXY_API_KEY` shared-secret auth, XSS-hardened dashboard, CORS limited to the public API surface; all server-side upstream requests are validated by `assertSafeUpstreamUrl` (rejects non-`http(s)` schemes, embedded credentials, and any host that is neither `commandcode.ai` nor explicitly allowlisted, and rejects loopback/private/reserved addresses by default; enforces `https` for non-loopback), and browser opening uses argument-array `spawn` (no shell injection)
- **Packaging** — TypeScript build, esbuild bundle, single-file Windows exe via `pkg`
- **Chinese dashboard** — built-in Chinese UI with official model pricing catalog (context/input/output/cache read/cache write/caps/deals) refreshed live from commandcode.ai
- **Per-session usage history** — the dashboard's Usage tab includes a **session detail view**: records input/output tokens, **cache-hit tokens**, latency, cost, model, and status per request, visualized with a daily trend line, model-distribution doughnut, today/week/month cost cards and a **cumulative cache-hit rate**; persisted to `~/.commandcode/usage-history.jsonl`, survives restarts
- **Cost reconciled with the official bill** — cost **prefers the authoritative amount from the upstream `provider-metadata` event** (`gateway.cost`, already inclusive of peak/off-peak rates, cache discounts and surcharges) and only falls back to local estimation when the upstream omits it; local estimation prices **cache read/write separately** (cache reads cost 1/50 of input) and picks the right rate by **time-of-day**. Records carry `costSource` (`official`/`estimated`) and `estimatedCostUsd`; the dashboard prefixes estimates with `~` and shows both on hover, so pricing drift surfaces early
- **Cache savings made visible** — the dashboard shows how much cache hits **saved versus paying full input price**, plus the multiple relative to the billed cost — answering why the bill lands far below "input tokens x input rate". Savings are priced at each record's **own timestamp** (peak/off-peak rates differ), with a guard so abnormal pricing (cache dearer than input) never reports negative savings
- **Peak/off-peak billing indicator** — the dashboard shows whether you are **currently on peak or off-peak rates**, **how long until the switch**, and the active rates for models affected by time-of-day pricing. Switch points follow the official boundaries (UTC 01/04/06/10, Mon-Fri) and **correctly expect the weekend jump**, e.g. after Friday 10:00 the next peak is Monday 01:00
- **End-to-end performance and quota projection** — the dashboard shows per-model **throughput P50/P95** (t/s) and **latency P50/P95**, plus a throughput column in the request table. The metric is explicitly labelled **end-to-end** (including upstream queuing, retries and network), so it reflects perceived wait rather than model generation speed. A **burn-rate projection** extrapolates official window usage by differencing it over time — deliberately not from local history, which only sees proxied traffic (~18%) and would badly overstate remaining time
- **Desktop notifications** — Windows toasts when the user is unlikely to be watching the dashboard: the 5-hour window will run out before it resets, auto-quota switched accounts, or the engine was paused. Native `Windows.UI.Notifications`, zero third-party dependencies, 30-minute dedupe per event, failures never affect the request path; disable with `COMMANDCODE_NOTIFY=0`. **Self-diagnosing**: the system-wide notification switch is checked at startup, and when it is off the log states the fix path instead of firing requests that Windows silently drops (`GlobalSettingDisabled`)
- **Session and project attribution** — cost is broken down by both **session** and **project**. The session ID comes from the client's declared `x-session-id` (verified to match the on-disk session directory name, so it is a **factual identifier**, with a three-step fallback that leaves it empty rather than guessing). Projects can only be **inferred** — the upstream has no such dimension and 12 candidate endpoints all returned 404 — so they are derived from system prompt text and **labelled per row** by confidence: `label` (an explicit working-directory field, high confidence) or `heuristic` (path-frequency inference, low confidence). The UI keeps "declared" and "inferred" visually distinct, lists unattributed traffic as its own row instead of guessing, and reports coverage as "attributed N/M records". Day grouping follows the client timezone
- **Official usage overview** — mirrors the data sources of the official usage page (`commandcode.ai/:login/settings/usage`): **Total Tokens** (with input/output breakdown), **Total Runs** (completed/failed/success rate) and a **monthly limit** progress bar fetched from upstream `/alpha/usage/summary` and `/alpha/billing/credits` (same fields as the page's `/internal/*` endpoints, but accepting CLI API keys); exposed via the new `GET /api/usage/overview` dashboard endpoint
- **Structured error codes** — every failure returns a **stable code plus an actionable hint** (17 codes such as `RATE_LIMIT`, `MODEL_NOT_IN_PLAN`, `STREAM_IDLE_TIMEOUT`), surfaced as OpenAI `error.type`/`error.code` on one route and Anthropic `error.type` on the other, so callers can tell whether to wait for quota, switch models, or fix configuration — see the error table below
- **Subscription plan & billing cycle** — `/api/usage/overview` now includes a `plan` block: plan name (Go / GOAT / Pro …), official credits and 5-hour/weekly caps, `currentPeriodStart/End`, `cancelAtPeriodEnd`, plus `totalDays / daysElapsed / daysLeft / cyclePct`. The dashboard's Usage tab gains a **billing-cycle card**, since subscription credits expire at renewal instead of rolling over
- **Per-plan model availability** — the upstream pricing page's **full per-plan availability map** is now preserved (it used to be collapsed into a single `onGoPlan` boolean). Each model in `GET /v1/models` carries `availability`, `available_on_plan` and `plan_tier`, and you can filter with `?plan=individual-go&available=1`; without parameters the response is unchanged (backward compatible). Judgement fails open — missing data keeps a model rather than dropping it

### Quick Start

```bash
npm install
npm run dev          # http://127.0.0.1:9090
```

or production:

```bash
npm run build && npm start
```

or the standalone binary:

```bash
npm run build:win    # dist/commandcode-proxy-v4.exe — runs with zero dependencies
```

On first launch the dashboard opens automatically. Log in via **Browser (OAuth)** or paste an API key. Keys are also auto-loaded from `~/.commandcode/auth.json` or `COMMANDCODE_API_KEY`.

Filter models by plan (`plan` may be given explicitly, or omitted to use the active account's plan; drop `available` for the full catalog):

```bash
curl "http://127.0.0.1:9090/v1/models?plan=individual-go&available=1"
```

### Error contract

Every failure returns a **stable code plus an actionable hint**, so callers can tell whether to wait for quota, switch models, or fix configuration.

OpenAI route (`/v1/chat/completions`):

```json
{ "error": { "message": "Upstream error 429: insufficient credits", "type": "rate_limit_error",
             "code": "RATE_LIMIT", "param": null, "hint": "The plan usage window (5-hour or weekly) is exhausted..." } }
```

Anthropic route (`/v1/messages`):

```json
{ "type": "error", "error": { "type": "rate_limit_error", "message": "...",
                              "code": "RATE_LIMIT", "hint": "..." } }
```

| `code` | HTTP | Meaning |
|---|---|---|
| `MISSING_CREDENTIAL` | 401 | No usable key (env / auth.json / account pool all empty) |
| `INVALID_CREDENTIAL` | 401 | Key expired or revoked |
| `PROXY_AUTH_REQUIRED` | 401 | Missing or wrong `PROXY_API_KEY` |
| `RATE_LIMIT` | 429 | 5-hour/weekly window exhausted, or out of credits |
| `MODEL_NOT_IN_PLAN` | 403 | Model is above the current subscription tier |
| `MODEL_NOT_FOUND` | 404 | Unknown model id (refresh the catalog and retry) |
| `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` | 400 | Request shape or content cannot be translated to the upstream wire |
| `REQUEST_TIMEOUT` / `STREAM_IDLE_TIMEOUT` | 504 | Request timed out / stream went silent and was aborted |
| `NETWORK_ERROR` | 502 | Cannot reach the upstream API |
| `SERVER_ERROR` | 5xx | Upstream 5xx (**the real upstream status is preserved**) |
| `PROVIDER_PROTOCOL_ERROR` | 502 | Malformed upstream response (e.g. missing body) |
| `CATALOG_UNAVAILABLE` | 503 | Model catalog unavailable |
| `GATEWAY_PAUSED` | 503 | Engine paused from the dashboard |
| `BLOCKED_HOST` | 500 | Upstream URL rejected by the SSRF guard |
| `INTERNAL_ERROR` | 500 | Unexpected proxy-side failure |

**Retry semantics**: `408/409/425/429/500/502/503/504` are retried with exponential backoff (capped by `upstream.maxRetries`); the terminal billing/plan markers (`model_not_in_plan`, `premium_credits_exhausted`, `insufficient credits`) **fail fast and are never retried**, because retrying only burns credits. Once retries are exhausted the real upstream status and code are preserved instead of being reported as a network failure.

> For streaming requests, the HTTP status is already 200 by the time the failure happens, so the code is folded into the content text as `[Upstream Error: RATE_LIMIT: ...]`.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `9090` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` exposes to LAN) |
| `PROXY_API_KEY` | unset | Require this key on `/v1/*` **and the admin surface `/api/*`** (Bearer or `x-api-key`); the dashboard prompts for it on first visit and remembers it per tab |
| `COMMANDCODE_API_KEY` | from auth.json | Upstream key fallback; with no named account the name shows as `CLI Key (last4 xxxx)` / `Env Key (last4 xxxx)`, enriched from whoami after boot |
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | Upstream base |
| `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` | unset | Extra allowed upstream hosts (comma-separated, for self-hosted gateways/mirrors); loopback/private/reserved are rejected by default unless added here |
| `COMMANDCODE_VERSION` | `1.27.1` | CLI version header |
| `ROTATION_MODE` | `manual` | `auto-quota` enables 30-min quota checks |
| `NO_OPEN_BROWSER` | unset | Set `1` to skip dashboard auto-open |
| `MAX_BODY_MB` | `64` | Max inbound JSON body size (MB); vision/multi-image base64 payloads exceed the 1MB default (413, `FST_ERR_CTP_BODY_TOO_LARGE`). Range 1..1024 |
| `USAGE_HISTORY_MAX_MB` | `20` | Size cap (MB) for `usage-history.jsonl`; when exceeded the newer half is kept so the dashboard aggregation stays fast |
| `COMMANDCODE_LOG_PATH` | `<root>/logs/proxy.log` | Runtime log file (append-all, rotated to `.old` past 5MB) so incidents survive console-window closes |

Persistent config lives in `config.json` next to the executable.

### Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest — unit + integration (mock upstream)
npm run build:exe    # esbuild bundle
npm run build:win    # Windows exe
```

### Security

> Described in the bilingual **Upstream URL safety** section above.

All server-side upstream requests pass an allowlist check and **fail closed** (reject, never degrade):

- By default only `commandcode.ai` and its subdomains are allowed; loopback (`localhost`, `127.x`, `::1`), private (`10.x`, `172.16-31.x`, `192.168.x`), reserved/link-local (`169.254.x`, IPv6 ULA/link-local), and arbitrary public hosts are rejected unless an operator adds them to the allowlist.
- **Controlled loopback/private exception**: a local mock upstream, self-hosted gateway/mirror, and dev/testing must be **explicitly** added to `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` to be reachable. This is an operator-configured exception, not a default-allowed or client-controlled path — the upstream URL is determined only by operator env vars such as `COMMANDCODE_API_BASE`, never by client request parameters, so there is no SSRF vector that steers client input to an internal network.
- Additional checks: reject non-`http(s)` schemes (protocol smuggling like `file:`, `gopher:`), reject embedded credentials (`user:pass@host`), and enforce `https` for non-loopback hosts (no plaintext downgrade; loopback with explicit allowlist may use `http` for a local mock).

### Disclaimer

This project interoperates with a private API by observing the official CLI's network behavior. It may break when the upstream protocol changes, and usage may be subject to CommandCode's terms of service. Use with your own account and credentials.
