# Changelog

所有主要版本更新都记录在此文件。

## [4.18.1] - 2026-09-21

### 新增
- **CI 发布流水线 `.github/workflows/release.yml`**：推 `v*` tag 就按 CHANGELOG 对应段落自动创建 GitHub Release（标题取 annotated tag 的 subject）。也支持 `workflow_dispatch` 手工补建，且幂等——Release 已存在则跳过。
  背景：v4.13.0 起的 6 个版本只打了 tag、没建 Release 对象，而应用内检查读的是 `/releases/latest`，于是"发现新版本"静默失效了好几天且无处报错。4.18.0 已把检查改读 tags 兜住，但**人工建 Release 本身就是病根**，这次补上自动化防复发。
  取舍：本 workflow 不等 CI，tag 一推就发；若希望"CI 绿了才发"，改成 `workflow_run` 触发即可。

### 修复
- **`.gitignore` 加 `!scripts/extract-release-notes.mjs`**。仓库根级 `*.mjs` 规则会把它吞掉，`git status` 里根本看不见这个文件——少了这行，全新克隆上 workflow 会因为引用的脚本未入库而直接失败。

### 构建
- `eslint.config.js` 为 `scripts/**/*.mjs` 声明 node 全局（`console`）。**没有**把它加进 ignores：CI 会执行、又没有任何静态检查的文件，等于把第一次运行留到线上。已负向确认该脚本真的在被检查（引入未声明引用会报 `no-undef`）。

### 测试
- 新增 `scripts/extract-release-notes.mjs` + `tests/release-notes.test.ts`（9 项）。重点是**失败路径**：版本不在 CHANGELOG 里、或 tag 名不合 `vX.Y.Z` 规范时，脚本必须非零退出——否则就会发出一个空正文的 Release，正好是这套自动化想消灭的那类静默失效。
- 契约经变异校验：把三处 `process.exit(1)` 改成 `process.exit(0)` 后，2 项失败路径用例立刻红；恢复后 9 项全绿。
- 全量 **316 项通过**（原 307 + 9），`tsc --noEmit`、`eslint .` 无错误。

## [4.18.0] - 2026-09-21

架构审查（批次 A）修复。取**次版本号**而非修订号：本次含两处行为变更（下方标注 ⚠️）与一处内部契约变更（`SendOptions.onRetry` 的签名），不是单纯补丁。

### 修复
- ⚠️ **额度/瞬时错误重试时的账号切换现在真正生效**（原 `onRetry` 死代码，见 4.17.0「已知问题」）。这条路径上实际有**三层**缺陷，只补第 1 层仍然不会切号：
  1. `sendToCC` 从不 `await opts.onRetry`；
  2. `headers` 在重试循环**之外**构建一次，换号后仍带旧 key；
  3. 路由里的回调给局部变量 `apiKey` 赋值，而 `opts.apiKey` 早在构造参数对象时把旧值快照进去了。
  契约随之调整：`onRetry` 现在**返回**下一次要用的 apiKey（返回 undefined = 沿用当前 key）。
  **行为变更**：撞额度时会在重试途中切到另一个账号，该请求的上游归属随之改变。
- ⚠️ **`upstream.timeoutMs` 从此真正生效**。此前它被加载、写入默认值、并在 `/api/status` 与仪表盘展示，但 `src/` 里 0 个消费点——唯一起作用的是 `idleTimeoutMs`，而它每收到一个字节就重置，因此一个持续 trickle 的上游可以无限期挂住连接。新增跨"等响应头 + 读流"两阶段的挂钟上限，超时归类为既有的 `REQUEST_TIMEOUT`。
  **默认值同时从 600s 提高到 1800s**：这个配置以前从不执行，所以任何"看起来正常"的长请求都从没被它约束过；编码 agent 带大上下文的单次请求合理可能超过 10 分钟，直接按 600s 执行会误杀。注意 `0` 不等于"不限制"（读取处是 `||`，0 会回落到默认值）。上限按**尝试**计，配默认 `maxRetries: 2` 时最坏耗时约为 3 × 上限。
- **流错误不再变成进程级未捕获异常**（接上一条，实施后才暴露）。给 `sendToCC` 加上"用可辨识错误掐断流"之后，适配层单测全绿，但端到端跑起来代理日志出现 `[CRITICAL] Uncaught Exception: Upstream exceeded …`：`createInterface({ input })` 会把 input 流的 error 转成 **readline 自己的** `'error'` 事件，而两条路由只挂了 `upstreamStream.on('error')`，无人监听的 `'error'` 直接抛成未捕获异常——一次超时被升级成进程事故。现由同一个具名处理函数同时挂到两个源上，并用 `streamErrorHandled` 保证只处理一次。
  同时修正 `chat.ts` 落库错误码：流中途失败过去一律记 `PROVIDER_PROTOCOL_ERROR`，现按 `toProxyError` 的真实分类记录（与 `messages.ts` 一致），超时在用量历史里可辨。
  **端到端实测**（1.5s 上限 / 8s 空闲、持续 trickle 的 mock 上游）：1554ms 终止、SSE 内含超时文本、用量历史落 `status:FAILED / errorCode:REQUEST_TIMEOUT`、无未捕获异常。
- **`npm test` 不再对推理路由零覆盖地报全绿**。本仓库所有集成用例都 `spawn` 编译产物，缺 `dist/` 时被 `describe.skipIf` 静默跳过（实测：未构建时 244 passed / 42 skipped 且退出码 0）。现在 `pretest` 自动构建，并在 `beforeAll` 首行加了明确报错。注意 vitest 在一个文件没有任何可运行用例时**不会执行文件级 beforeAll**，所以 `tests/integration.test.ts` 里那条不带 skipIf 的前置用例是这套防护的触发器，删除它会退回老行为。
- **「发现新版本」提示恢复工作**：改为读 `/tags` 并按 semver 取最大。此前读的是 `releases/latest`，而本仓库只打 tag 不建 Release 对象——实测 `releases/latest` 停在 v4.12.0 而 tag 已到 v4.17.0，于是自 v4.13.0 起该提示永远不会触发。（另一条路线是恢复创建 GitHub Release，未在本次改动内。）
- **`/api/auth/manual-login` 不再明文回传上游 apiKey**，改为与 `/api/accounts` 一致的 `apiKeyMasked`。`loginNewAccount` 的返回类型仍带完整凭据（内部调用方需要），收口在 HTTP 边界。
- **`.env` 现在可像其它状态文件一样隔离**（`COMMANDCODE_ENV_FILE_PATH`）。此前 `config.ts:28` 把它硬编码到 `getProjectRootDir()`，而 `config.json` / `models.json` / `pricing.json` / `usage-history.jsonl` 全都有 env 覆盖钩子——只有这个存**明文上游 key** 的文件没有。后果是任何写凭据的路径都会把密钥落到当前工作目录的 `.env`：从 `Program Files` 运行的打包产物如此，测试也如此（新增的 `admin-key-mask.test.ts` 第一次运行时就在仓库根生成了带 mock key 的 `.env`，时间戳与用例运行时刻一致，可稳定复现）。
- **仪表盘 `badge()` 转义 text**：`title` 参数一直走 `esc()`，`text` 却是裸拼进 innerHTML，而调用点把上游定价页抓来的 `m.deal.discountPercent` 直接传入。全站仍无 CSP，故属纵深防御缺口。

### 构建
- `pkg.assets` 移除 `models.json`：它是运行时生成的缓存且已在 `.gitignore` 里，全新克隆上打包会静默缺该资产。

### 测试
- 新增 6 个文件共 19 项（288 → 307），全部先观察到失败再实现：`onretry-account-switch`（断言上游实际收到的 `Authorization` 头变化，而非"回调被调用过"）、`upstream-total-timeout`（把 `idleTimeoutMs` 刻意设得大于总时限，使超时只能归因于挂钟上限）、`admin-key-mask`、`spa-badge-escape`（取出 index.html 里真实的 `badge`/`esc`/`BADGE_TONES` 源码执行）、`update-check-tags`、`route-stream-error`（路由级：真监听端口走 `/v1/chat/completions`，断言超时对客户端可见且不产生未捕获异常）。
- `route-stream-error` 做过变异校验：临时删掉 `chat.ts` 里那行 `rl.on('error', …)`，两条用例立刻失败（一条测到 16s 未被上限终止，一条抓到 1 个未捕获异常），确认这道防线是有牙的而不是常绿摆设。另注：该用例必须真监听端口——`app.inject` 没有真实 socket，路由在 `req.raw.setTimeout(0)` 处就会 500，测不到想测的路径。
- 全量 **303 项通过**（原 288 + 15），`tsc --noEmit`、`eslint .` 无错误；语句覆盖率 48.36% → 57.8%。

### 已知问题（本次排查中发现，未修）
- **管理面默认零鉴权**：`PROXY_API_KEY` 未设置时 `verifyProxyAuth` 直接 return，`/api/*` 16 个管理端点完全无鉴权；且 `/v1` 数据面与 `/api` 管理面共用同一把密钥，未做权限分离。跨站驱动已被 `isSameOriginIfPresent` 挡住，但该检查比对的是**攻击者可控的 `Host` 头**，DNS rebinding 可绕过（无 Host 白名单）。属需要设计决策的独立批次，未随本次一起改。
- 出站 fetch 未设 `redirect:'manual'`，`assertSafeUpstreamUrl` 只校验初始 URL，二跳可逃逸 SSRF 白名单。
- OAuth 回调在 `state` 缺失时放行（`config.ts` 注释说明是为兼容旧版 CLI 的有意取舍）。
- 密钥以明文写入 `config.json` / `.env`，无文件权限加固；`.env` 会被回注 `process.env`。
- `rewriteSafely`（仅 dev 工具，不在服务路径）的 `renameSync` 无 try/catch，Windows 上偶发 `EPERM` 会抛出并泄漏临时文件。

## [4.17.0] - 2026-09-18

### 修复
- **「上游以 HTTP 200 报错」现在会被有界重试，不再直接把错误文本当回答** — 事故复盘：一轮 agent 工作了 **16 分钟**，其中一个请求带着 **29 万 token 上下文**（`cacheReadTokens: 0`，全量缓存失效）打到上游；网关转发 provider 时失败，回了一个 **200** 的 SSE 流，里面是 error 事件 `Invalid error response format: Gateway request failed`。旧行为把它并入正文返回（`\n[Upstream Error: ...]\n`），客户端当成模型的正常回答显示——界面里那一轮就以这段文本收场。日志当时把这次请求记成 `Status COMPLETED | Output Tokens 0`，`grep` 整个 `proxy.log` 连这条错误文本都找不到，排查只能靠反推用量历史。
  - 根因不在代理也不在客户端：CC 网关调 provider 失败且返回了格式不合规的错误体，CC API 只能包一句笼统的话发出来。**但链路完全没有重试**——`sendToCC` 的重试只覆盖非 2xx 与网络错误，一旦上游回了 200、流交给路由，后续事件就只是数据。
  - 修复：在 `sendToCC` 里新增流内事件预判。判定在**把流交还给调用方之前**完成（此刻客户端一个字节都没收到，丢弃重试不会造成重复），判据是「**内容之前**出现可重试的 error 事件」。已读字节原样退回，下游的 readline 与空闲看门狗完全不受影响；预读期间 `pause()`，确保摘监听器与接管道之间不会有 chunk 落空。
  - **只用「首事件」判定是不够的**：CC 的流以一个 `start` 事件开场，按「首事件」判等于永不触发——这一点是写集成测试时才发现的，因此判据改为按顺序扫描事件（`start`/保活/未知元数据视为中性，继续看；内容类事件立即放行）。
  - **只重试瞬时性失败**：网关请求失败、服务过载、无可用 provider 值得重试；区域限制、模型/provider 不认识这类确定性不可用**不重试**——29 万 token 上下文单次就是 $0.087，白重试两次等于花 $0.26 换一个必然相同的错误。计费/套餐类终止错误复用既有的 `terminalCodeFor` 判定，不重复维护模式表。
  - **不改对客户端的契约**：只在**还有重试预算**时探测；最后一次尝试直接放行，让路由按既有逻辑把错误并入流。所以本机制是纯增量——只多试几次，不改变「重试耗尽后客户端看到什么」。
- **上游 error 事件的文本现在会落日志** — 这条文本过去只进响应体、从不落盘，是本次定位困难的直接原因。两条路由（OpenAI + Anthropic）都在识别到 error 事件时记一条 warn：`model + traceId + 消息截断 300 字符`。实调验证已生效。
- 顺带修掉 `[UPSTREAM]` 重试日志把一切失败都写成 `Network error` 的问题（新的流内重试也走这条日志，措辞改为 `Upstream failure`）。

### 已知问题（本次排查中发现，未修）
- **`SendOptions.onRetry` 是死代码** — 它在类型上存在，两条路由也都传了「额度错误时轮换账号」的回调，但 `upstream.ts` 里**从未调用过它**，所以那条账号轮换路径从未生效。没有顺手接上：`onRetry` 会在重试途中换掉 `apiKey`，属于有实际后果的行为变更，应由你确认后再启用。

### 测试
- 新增 `tests/upstream-probe.test.ts`（14 项）锁定判定纯函数：瞬时 vs 确定性 vs 计费终止三类消息的取舍、`start` 为中性而内容类事件立即放行、半行不判定且不重复扫描、空行/注释/`[DONE]`/非法 JSON 不误判。
- `integration.test.ts` 新增 4 项，走真实编译产物 + 真实 HTTP（重试循环、退避、流交接、被丢弃流的清理都是端到端跑出来的）：
  - 首次 error 事件被丢弃重试后**恢复成功**，客户端拿到真实内容且响应里不含 `Upstream Error`；
  - 确定性不可用**只试 1 次**（等 1.5s 后仍为 1，确认没有偷偷重试）；
  - 持续瞬时失败**封顶 3 次尝试**（`maxRetries` 默认 2），且仍按既有逻辑并入流、记 FAILED；
  - **内容已产出后的 error 不重试**（只试 1 次），避免重复内容。
  - 计数器改为按 sentinel 取差值，修掉了原先跨用例累加导致的假失败。
- 全量 **288 项通过**（原 270 + 18），`tsc --noEmit` 与 `eslint .` 无错误。

## [4.16.0] - 2026-09-18

> 修复 4.15.0「已知问题」里记录的两个缺陷，并把基准工具升级为多轮。

### 修复
- **11 个「可用」却调不通的模型：短别名现在重映射到上游认可的规范 id** — 4.15.0 的基准实测发现 `qwen-3.7-max`、`nemotron-3-ultra` 等 11 个标为 GOAT 可用的目录条目被上游一律 403 `Model/provider not recognized: anthropic:<id>`，而同名的带前缀条目（`Qwen/Qwen3.7-Max`、`nvidia/nemotron-3-ultra-550b-a55b`）调用正常。
  - 根因：`resolveModelName()` 的**精确匹配排在别名处理之前**——短别名本身就在目录里，精确匹配直接放行，于是原样透传给上游换来 403。
  - 修复：新增 `buildAliasMap()`，从目录自身推导别名表并把它排在精确匹配**之前**。判别信号不硬编码任何模型名：别名条目的 `owned_by` **回指自身**（上游并不认识这个 owner），规范条目不是。该信号与实测打不通的 11 个**完全重合且无孤立项**，因此映射既完备又不过度——实测上下文中 62 个可用模型现在全部可调。
  - 只认 1:1 的同名组：一侧同名条目多于一个时不猜，宁可让别名继续报上游的准确错误，也不静默替换成用户没请求过的模型。
  - 实调验证：`qwen-3.7-max` → 返回 `Qwen/Qwen3.7-Max`、`nemotron-3-ultra` → 返回 `nvidia/nemotron-3-ultra-550b-a55b`，均为真实补全，不再 403。
- **失败请求现在会落库，面板的成功率不再是构造出来的 100%** — `persistCompletion()` 过去在 `chat.ts` / `messages.ts` 的 3 个调用点**全部硬编码 `'COMPLETED'`**，`'FAILED'` 只存在于类型定义与计数分支里，没有任何代码路径能产生它，于是失败请求在用量历史里一条记录都不留、`total.failures` 恒为 0。
  - 补齐全部错误分支：上游在出数据前就失败（最典型是 403/404）、流中途断开、路由层致命异常，都记 FAILED。
  - **更关键的是补上了主流失败形态**：上游把「模型区域受限 / 无可用 provider / 服务器过载」这类失败以 error **事件**发在一个 **HTTP 200 流**里。这种请求过去被记成 `COMPLETED + 0 输出`——从用量历史里完全看不出失败。现在识别到 error 事件即落 FAILED。实测证据：基准中 `z-ai/glm-5.3-flash` 等模型出现过 `This model is not available in your region`、`No available providers match the 'only' filter`、`Our servers are currently overloaded`，全部是 200 + 0 token。
  - `UsageRecord` 新增可选字段 `errorCode`（失败请求的稳定错误码），让"失败了但不知道为什么"变成可查。旧记录缺该字段不受影响。
  - 新增**一次性写入保护** `persistOnce()`：非流式路径在 `reply.send()` **之前**就记了 COMPLETED，若 send 抛错会走进外层 catch 再记一条 FAILED，把同一次请求记成两条、样本数与成功率双双失真。现在一次请求只可能产生一条记录。
  - 实调验证：请求不存在的模型 → 落一条 `{status: FAILED, errorCode: INVALID_CREDENTIAL, outputTokens: 0, costUsd: 0, timingMs: 902}`，面板 `failures` 由恒为 0 变为 1。

### 新增
- **`usage-history-io.mjs`：用量历史的安全读写，purge / bench 两个工具共用** — 这个文件是计费与性能面板的数据源，而 proxy 在工具运行期间**仍在往它追加记录**（你自己的 agent 会话就在写），"读全量 → 过滤 → 覆盖写回"会丢数据。抽出的 `rewriteSafely()` 用「追加哨兵 → 读回确认哨兵是最后一行 → 由本次快照重算 payload → 校验尺寸未变 → 原子 rename」保护，任一环节发现并发写入就整体重试。
  - 抽取过程中修掉了原 `purge-test-usage.mjs` 里一个**真实的数据丢失 bug**：payload 在循环**外**预先算好，而循环内会用最新快照重算 keep/drop，于是两次读取之间 proxy 追加的记录（它们已进入快照、但不在旧 payload 里）会被静默覆盖掉。现在 payload 一律由本次快照构建，并有回归测试锁定。
  - 模块文档明确写出残余风险：`statSync` 与 `renameSync` 之间有微秒级窗口，期间恰好并发追加会丢那一条；为此再加一层写回校验的复杂度超过收益，故记录在案而不处理。
- **基准工具支持多轮（`--rounds N`）与替换（`--replace`）** — 单轮只能得到"一次探针"，面板上的 P50 就是那一次的值，而实测上游存在明显的瞬时失败与波动（同一模型连续请求可见 2.5s 与 6.1s 的差异，也见过随机 `overloaded`）。多轮给出稳定的中位数。
  - `--rounds N`：每个模型连续跑 N 轮（同一模型连续执行，条件更一致），汇总给出吞吐中位数 / 延迟中位数 / 可用轮次数，并单独列出「全程拿不到可用样本」的模型及其上游错误原因。
  - `--replace`：正式开跑前清掉**所有历史基准记录**（按 `sessionId: bench-*` 识别）。必须先清，否则新旧混在一起，"替换数据"会变成"掺入数据"，中位数被单次探针拉偏。清理前完整备份、被清记录单独留档，并复用 `rewriteSafely` 的并发写保护。
  - 单轮内的成本安全阀改为**每轮**检查（原先每 5 个模型），并改用本地用量历史精确累加。

### 实测结果（GOAT 档，2026-09-18，5 轮 × 62 个可用模型）
- **310 次请求：成功 309 / 失败 1**（一次 DNS 抖动 `ENOTFOUND api.commandcode.ai`，补跑一次成功），**实际花费 $0.8647**。其中 292 条输出 ≥32 token（面板吞吐闸门之内）。
- **面板从 44 行增至 52 行**，49 行有真实吞吐样本，可视区 20 行内 `—` 行 0 个。
- **覆盖率：62 个「GOAT 可用」条目去重后是 51 个规范模型**（11 个别名已并入其规范条目，不再各占一行），其中 **49 个拿到真实吞吐样本**。仅 2 个全程拿不到样本，原因是上游确实不提供：`MiniMaxAI/MiniMax-M2.7`（`No available providers match the 'only' filter`）与 `google/gemini-3.7-flash`（`not available in your region`）——**不是提示词问题**，换提示词重测无效（4.15.0 曾误记为「输出过短」，本版更正该判断）。
- 失败分类验证了本版的 FAILED 修复：18 条 FAILED 记录里 **16 条是 `PROVIDER_PROTOCOL_ERROR`、outputTokens 全为 0**，即 HTTP 200 流内的 error 事件（上游区域受限 / provider 不可用 / 服务器过载）；另 1 条 NETWORK_ERROR、1 条 INTERNAL_ERROR。这些在修复前会被记成 `COMPLETED + 0 输出`，从面板上完全看不出失败。
- 瞬时性得到证实：`thinkingmachines/inkling` 4/5 轮失败、`tencent/hy3-paid` 与 `poolside/laguna-s-2.1-free` 各 2/5 轮失败，其余轮次正常；`z-ai/glm-5.3-flash` 在 4.15.0 的单轮基准里返回 0 输出、本轮 5 轮全部成功。这正是需要多轮中位数而非单次探针的直接证据。
- 吞吐中位数（仅计可用轮次）区间：最高 `nvidia/nemotron-3-ultra-550b-a55b` 84.1 t/s、`deepseek/deepseek-v4-flash-fast` 72.9、`deepseek/deepseek-v4.1-flash` 71.9；最低 `gpt-5.6-sol` 8.6。延迟中位数 2.0s ~ 14.3s。
- 计数核对：310 次请求产生 **311 条记录**，多出的 1 条是 `tencent/hy3-paid` r2 失败后补跑的那一次（FAILED + COMPLETED 各一条）。已核对 `(model, traceId)` 全库唯一、无任何重复记录，确认 `persistOnce()` 的一次性写入保护在真实流量下有效。

### 测试
- `models.test.ts` 新增 7 项：`buildAliasMap` 的映射/不映射/同名歧义不猜/缺 name 跳过，以及 `resolveModelName` 的别名优先于精确匹配。
- `integration.test.ts` 新增 4 项：失败请求落 `FAILED` 且带 `errorCode`、上游中断不丢记录、成功请求只落一条（无双记）、**200 流内的 error 事件在 OpenAI 与 Anthropic 两条路由上都记为 FAILED**。mock 上游相应新增 `__ERROR_EVENT__` 与 `__STREAM_ERROR__` 两个场景，并新增隔离的用量历史读取工具。
- 新增 `usage-history-io.test.ts`（8 项）锁定数据安全路径：保留/删除集正确、空保留集写空文件、**调用前刚追加的记录不被旧快照覆盖**（回归）、并发追加触发重试且不丢数据、快照始终不稳定时返回失败且不丢记录、哨兵行与损坏行不被读回、备份内容一致。
- 全量 **270 项通过**（原 250 + 20），`tsc --noEmit` 与 `eslint .` 无错误。

### 说明
- 4.15.0 记录的「11 个别名调不通」与「失败数恒为 0」两个已知问题，本版均已修复。

## [4.15.0] - 2026-09-18

### 新增
- **`bench-models.mjs`：对套餐内每个可用模型跑一次真实基准，为「端到端性能」面板播种初始数据** — 面板此前只有被 agent 实际调用过的模型有数据，大量模型是空白或只有 1 条样本，无法横向比较。本工具对 `GET /v1/models?plan=…&available=1` 返回的每个模型发一次**真实请求**（打真实上游、花真实额度、由 proxy 记入用量历史），因此面板上的数字是实测值，不是任何形式的伪造数据。
  - 为可追溯，每条请求都带客户端声明的上下文（`x-session-id: bench-<时间戳>`、`x-zcode-session-type: benchmark`、`x-zcode-agent: bench`），在会话表里能认出这批流量来自基准，而不是冒充 agent 工作负载；不计入项目归因。
  - 方法论：**串行**执行（并发会让延迟与吞吐互相污染，测出来的数不可比）；提示词固定（`List the integers from 1 to 60…`）让各模型输出长度同量级——t/s 受输出长度影响，短输出的首 token 时间占比更高会低估吞吐；`max_tokens` 1024；每请求 150s 硬超时；仅对网络/5xx 错误补一次重试（应用层错误重试无用）。
  - 安全阀：每 5 个模型按本次基准的 sessionId 从本地用量历史**精确累加**已花成本，超过 `BENCH_MAX_USD`（默认 4）即中止。刻意不用官方额度计数器（`/alpha/billing/credits`）——实测花掉 $0.0197 后其增量仍显示 `0.0000`，粒度太粗拦不住。
  - 默认预演（只列出将基准的模型），`--run` 才发请求；明细写入 `logs/bench-<时间戳>.json`。
- **本次实测结果**（GOAT 档，2026-09-18）：62 个可用模型中 **51 个成功、11 个失败**，花费 **$0.2663**。面板性能表由 44 行增至 **51 行**，其中 **48 行**有真实吞吐样本，可视区 20 行内 `—` 行 0 个。输出 token 区间 min 120 / p50 186 / max 1024。

### 已知问题（本次基准暴露，尚未修复）
- **11 个「GOAT 可用」的目录条目实际被上游 403 拒绝** — `qwen-3.8-omni-flash`、`qwen-3.8-max-0902`、`qwen-3.8-max`、`qwen-3.8-27b`、`qwen-3.6-max`、`qwen-3.6-plus`、`qwen-3.7-max`、`qwen-3.7-plus`、`qwen-3.8-flash`、`qwen-3.7-flash`、`nemotron-3-ultra`：全部报 `Upstream error 403: Model/provider not recognized: anthropic:<id>`。对照 `models.json` 可见这些是**短别名条目**（`owned_by` 指向模型自身，如 `"owned_by":"qwen-3.7-max"`），而同名的带前缀条目（`Qwen/Qwen3.7-Max`、`nvidia/nemotron-3-ultra-550b-a55b`）`owned_by` 为 `command-code` 且调用正常。即目录把 62 个模型标为可用，其中 11 个根本调不通。需要在模型目录层处理（剔除别名条目，或按 `owned_by` 正确解析 provider），涉及产品决策故未擅自改动。
- **用量记录永远不会有 FAILED 状态，面板的失败数结构性恒为 0** — `persistCompletion()` 在 `chat.ts` / `messages.ts` 的 3 处调用点全部硬编码 `'COMPLETED'`，`'FAILED'` 只存在于类型定义与 `getUsageStats()` 的计数分支里，没有任何代码路径能产生它。后果：上面那 11 次 403 在用量历史里**一条记录都没留下**（`total.failures` 仍显示 0），面板的 100% 成功率是构造出来的，不是真实情况的反映。修复需要在各错误分支补 FAILED 落库。

### 测试
- 全量 **250 项通过**，`tsc --noEmit` 与 `eslint .` 无错误。
- `bench-models.mjs` 不参与单测（它打真实上游、花钱），以预演模式 + `BENCH_LIMIT=1` 单模型冒烟验证：记录正确落入用量历史并带 `sessionType: benchmark`，面板 `byModelPerf` 立即看到该模型（`throughputSamples: 1`）。

## [4.14.1] - 2026-09-18

### 修复
- **性能表的座次改由吞吐样本数决定，算不出速率的行不再占位** — 4.14.0 给吞吐加了闸门后，输出全都过短的模型会显示 `—`（无有效速率）。原先排序用的是延迟样本数，于是这类行会混在表中部，而面板只渲染前 20 行——实测清理后的数据里，`zai-org/GLM-5.2-Fast`、`zai-org/GLM-5` 正好卡在可视区末尾，把有吞吐数据的行往下挤。改为按吞吐样本数降序（并列时再按延迟样本数降序）后，可视区内的 `—` 行从 2 行降到 0 行，全部 5 行沉到表尾。
  - 明确一点：**排序只改座次，不做任何过滤**。这些行仍然保留，因为它们携带真实的延迟测量（实测 1.2s ~ 25.3s）与「该模型确实被调用过」这一事实；把它们删掉会让性能表与用量表对不上账。`—` 的语义是「这一次的输出太短，算速率没有意义」，而不是「没有数据」。
  - 新增 `compareModelPerf()` 导出为纯比较函数，便于单测锁定座次规则。
- 版本号 `4.14.0` → `4.14.1`。

### 测试
- `perf-quota.test.ts` 新增 3 项：有吞吐数据的行排在前（哪怕算不出速率的行延迟样本多得多）、吞吐样本并列时按延迟样本降序、排序后行数不变（沉底而非删除）。
- 全量 **250 项通过**，`tsc --noEmit` 与 `eslint .` 无错误。

## [4.14.0] - 2026-09-18

### 修复
- **集成测试不再往生产用量库写记录** — `tests/integration.test.ts` 用 `{...process.env}` 拉起真实 proxy 进程，却只把 `COMMANDCODE_CONFIG_PATH` / `COMMANDCODE_MODELS_CACHE_PATH` / `COMMANDCODE_PRICING_CACHE_PATH` 隔离到临时目录，**漏了 `USAGE_HISTORY_PATH`**。`usage-store.ts` 的兜底值于是落到 `~/.commandcode/usage-history.jsonl` —— 而那份文件正是计费与性能面板的数据源。后果是套件对本机 mock 上游发出的每次调用（3 / 17 / 25 token、本机回环所以只要十几毫秒）都被当成真实流量记入生产库。已在 spawn env 中补上 `USAGE_HISTORY_PATH`，并加注释说明为何不能漏（同仓库 `attribution.test.ts` 一直是对的，集成测试漏了）。
  - 实测验证：修复后跑完整套件（33 项集成用例、全部打向 mock 上游），生产用量库新增的短耗时无上下文记录数为 **0**；测试记录落在 `%TEMP%\ccproxy-it-*\usage.jsonl`。
- **性能面板的吞吐 P50/P95 不再被极短响应带飞** — 面板此前把「样本 = 所有有输出的 COMPLETED 请求」直接喂给 `输出token / 耗时`。分母趋零时这个除法失去意义：19ms / 3 token ≈ 187 t/s、12ms / 25 token ≈ 2083 t/s，于是 `claude-sonnet-5` 那行显示 P50 **187.5 t/s**、P95 **2083 t/s**，看起来像在吹牛（该模型当时 505 条样本全部是被上一条 bug 写进来的 mock 残留，无一条真实流量）。
  - `perfOf()` 新增吞吐闸门：输出不足 `MIN_THROUGHPUT_OUTPUT_TOKENS`（默认 **32**，可用环境变量 `PERF_MIN_OUTPUT_TOKENS` 覆盖，设 0 关闭）的记录**只进延迟统计、不进吞吐分布**。延迟照旧统计——那确实是一次真实等待，只是不适合用来算速率。
  - `byModelPerf` 新增 `throughputSamples` 字段：`samples` 改为延迟样本数（COMPLETED 且有耗时），`throughputSamples` 是再过闸门的吞吐样本数，两个口径不再混为一谈。
  - 面板「样本」列显示延迟样本数并带筛选图标提示，悬停显示「吞吐样本 N（仅计输出 ≥32 token）· 延迟样本 M」；后端未升级时自动回退到旧展示，不会把每行都标成被筛选。
  - 实测对比（清理前的备份数据）：`claude-sonnet-5` P50 吞吐 `187.5` → `—`、`claude-opus-4-8` `200.0` → `—`、`gemini-3.6-flash` `176.5` → `—`；真实流量行基本不动（`deepseek-v4-flash-vision-exp` 72.4 → 72.4、`deepseek-v4.1-flash` 83.3 → 83.8）。
- `package-lock.json` 的 `version` 字段补齐：4.13.0 发版时只改了 `package.json`，lockfile 停在 4.12.1。
- 版本号 `4.13.0` → `4.14.0`。

### 新增
- **`purge-test-usage.mjs`：清理用量历史中的测试残留（一次性维护工具）** — 上一条 bug 已经写进生产库的脏数据需要清掉。判定谓词刻意保守（**宁可漏删不可误删**），要求同时满足：`status === 'COMPLETED'`、无 `sessionId` / `project` / `agent` / `sessionType`、`timingMs < 300`（跨公网调用实测下界 2245ms，<300ms 只可能来自本机 mock 上游）、且该模型从无带上下文的真实流量。任何一条不满足即保留。
  - 默认 dry-run，须显式 `--apply` 才写盘；写盘前完整备份原文件，被删除的记录单独留档为 `*.removed-<时间戳>`（审计用）。
  - 并发写保护：先向日志追加哨兵行 → 读回确认哨兵就是最后一行 → 写临时文件 → 校验文件尺寸未变 → 原子 rename，任一环节发现期间有新写入就整体重试（最多 6 次），避免和正在写日志的本机 proxy 抢文件导致丢记录。
  - 本次实跑：2445 条 → 1847 条，移除 **598 条**（`claude-sonnet-5` 505、`deepseek/deepseek-v4-pro` 40、`google/gemini-3.6-flash` 40、`claude-opus-4-8` 13），全部为本机 mock 上游产物，涉及成本仅 $0.114。真实流量的模型一条未动。

### 测试
- `perf-quota.test.ts` 新增 4 项：短输出样本被闸门挡在吞吐之外但仍计入延迟、mock 残留样本（3/25 token + 十几毫秒）不再拉飞 P50/P95、阈值可显式传入且边界值（恰好等于阈值）计入、非 COMPLETED 记录两个口径都不计。
- 新增 `purge-test-usage.test.ts`（5 项）锁定清理工具的判定谓词——这个谓词决定「哪些记录可以从生产库删掉」，误判即数据丢失：带任何真实上下文的一律不动、耗时达跨公网量级的一律不动、有真实流量的模型整体豁免、非 COMPLETED / 缺耗时的不动。
- `dashboard-spa.test.ts` 新增 1 项：面板必须按 `r.throughputSamples` 渲染并标注「仅计输出 ≥32 token」。
- 全量 **247 项通过**（原 237 项 + 10），`tsc --noEmit` 与 `eslint .` 均无错误。

## [4.13.0] - 2026-09-18

### 改进
- **模型卡片现在把 Go 与 GOAT 两个档位分开标注** — 此前卡片头部只判断压扁后的 `onGoPlan`（即 `availability['individual-go']`），GOAT 独有的模型因此完全没有档位标识：`gpt-5.6-sol`、`xai/grok-4.6`、`google/gemini-3.7-flash`、`google/gemini-3.8-flash`、`meta/muse-spark-1.2`、`meta/muse-spark-1.3` 这 6 个模型在 Go 档不可用、只在 GOAT 可用，却和其它模型一样只显示一枚中性的「可用」，无法区分。
  - 每张卡片底部新增固定的「档位」行：`GO`（靛蓝）与 `GOAT`（金色 + 皇冠）两枚药丸**始终占位**，可用为实心强调色 + ✓、不可用为灰底 + ✗。固定占位让卡片等高、整列纵向对齐，扫一眼即可比较两个档位，而不是"只在可用时才冒出一枚标签"。
  - 判定改为读上游完整的 `availability` 映射（前端新增 `isPlanOn(m, key)`），仅在 `availability` 整体缺失时才回退到旧的 `onGoPlan`；档位键与显示名的映射（`PLAN_LABELS`）与 `src/utils/plans.ts` 的 `PLAN_TIERS` 保持一致。
  - GO / GOAT 都不含的 19 个模型（含 claude-sonnet-5、claude-opus-5 等）不再显示笼统的「可用」，改标中性徽章「更高档位」，悬停可见其实际可用档位清单（如 `Pro · Pro (v1) · Provider · Max · Ultra · Team Pro`）。
  - 筛选条新增 `GOAT` 标签（与原 `GO` 并列），两者均走 `isPlanOn`；结果计数扩为「共 N 个 · 命中 M 个 · Go 档可用 X 个 · GOAT 档可用 Y 个」，并在筛选条下补一行图例说明药丸读法。
  - 可读性：不可用药丸文字用 `slate-400`（卡片底色上对比度约 5.3:1），而非更暗的 `slate-500`（约 3.2:1）——10px 字号下后者偏暗。
- 版本号 `4.12.1` → `4.13.0`。README 中英双语「模型目录 / Dashboard」小节同步更新，`docs/screenshots/dashboard-models.png` 按新界面重拍（1440×900@2x）。

### 测试
- 新增 `dashboard-spa.test.ts` 一项回归：断言 `GOAT` 筛选标签、`isPlanOn(m, 'individual-goat')` 与两枚 `planPill` 均已接入，且旧的 `if (m.onGoPlan) tags +=` 渲染路径已移除。
- 全量 **237 项通过**，`tsc --noEmit` 无错误。
- 实机验证（Chromium，1440×900）：79 张卡片全部渲染出 2 枚档位药丸；`gpt-5.6-luna` = GO ✓/GOAT ✓、`gpt-5.6-sol` = GO ✗/GOAT ✓、`claude-sonnet-5` = 双 ✗ + 「更高档位」徽章；`GO` 筛选命中 54、`GOAT` 筛选命中 60，与目录数据一致；图例行不换行、与计数不重叠，药丸文字无溢出。

## [4.12.1] - 2026-09-17

### 修复
- **`max_tokens` 超过 CC wire 硬上限 200000 时整轮请求被上游 400 拒绝** — CC wire 的 schema 校验对 `params.max_tokens` 有全局硬上限 200000（上游报 `Validation error: Too big: expected number to be <=200000 at "params.max_tokens"`，`provider_code=UNSUPPORTED_OPTION`、`retryable=false`）。宿主（实测 ZCode）会按模型上下文窗口推导 `max_tokens`（如 `deepseek/deepseek-v4.1-flash` 的 1M 窗口），一旦超过 200000，请求在翻译层原样透传、打到上游即被拒，该轮执行直接失败且不可重试。
  - 修复：`adapters/commandcode/adapter.ts` 新增 `clampMaxTokens()`，在 `translateOpenAIRequest()` 组装 wire `params.max_tokens` 处统一向下钳制到 200000（Anthropic Messages 路径复用同一通路，一并覆盖）。实测边界：200000 通过、250000 复现 400。
  - 影响：超限请求不再整轮失败，输出预算被钳到上游允许的最大值；未超限请求行为不变。
- 版本号 `4.12.0` → `4.12.1`。

### 测试
- 新增 3 项回归测试（超限钳制、边界内透传、Anthropic 路径同样钳制），全量 **236 项通过**，`tsc --noEmit` 无错误。

## [4.12.0] - 2026-09-16

### 改进
- **额度窗口三张卡片的进度条现在真正对齐** — 此前「5 小时窗口 / 每周窗口 / 计费周期」结构不一致：前两张是"标题 → 进度条 → 重置时间"，计费周期卡中间多一行"12 天后额度重置"的大数字，把该卡进度条往下顶了约 60px；卡片被栅格拉成等高后，底部说明行的位置也各不相同，整排看过去是错落的。现统一成三段式骨架（`.win-card` = 表头 / `.meter` / `.win-meta`）：
  - 表头 `.win-head` 固定 `min-height: 2.25rem`，计费周期的天数大数字（`.win-big`）并入表头右端，三张卡表头同高——**进度条顶边因此完全重合**；
  - 说明区 `.win-meta` 用 `flex: 1` + `justify-content: flex-end` 贴底，三张卡的说明行底边同样对齐，不再留半张卡高的空白；
  - 视觉细节同步收紧：卡片改渐变底 + 顶部主色描边（`::before` 取 `--win` 变量，靛蓝/紫/翠绿各一色）、悬停微抬，图标收进圆角色块；进度条轨道换成 `.meter`（内描边 + 阴影），填充块补 `inset` 高光。
- **进度条着色收敛为单一入口 `paintMeter(id, pct, base)`** — 宽度与颜色全部走内联样式，布局交给 `.meter`。此前三处各自 `bar.className = '... bg-rose-500 h-2.5 rounded-full'` 整体覆写 class：既会连轨道样式一起抹掉，也让"≥90% 转红、≥70% 转琥珀"的阈值规则散在四处（改一处漏三处）。现在一处判定，并按 `min-width: 0.5rem` 保证极小占比也画得出来，不再出现"有消耗但条子看起来是空的"。
- 计费周期卡的「到期自动续费」从表头挪到说明区，与周期区间（`8/28 00:35 → 9/28 00:35 · 已过 64.4%`）同栏，表头只留标题与剩余天数——三张卡的表头信息密度因此一致。

### 测试
- 全量 **233 项通过**，`tsc --noEmit`、`eslint` 无错误（含 `tests/dashboard-spa.test.ts` 四项 SPA 守卫：内联脚本须能按纯 JS 解析、`getElementById` 引用的 id 必须存在、`onclick` 处理器必须已定义、不得引用外部 CDN）。
- 布局实测（1440×900，Chromium）：三张卡 `top=507`、尺寸均为 `395×151`；三条 `.meter` 的 `top` 同为 `578`（高 10px）；说明区底边同为 `635`。

- 版本号 `4.11.2` → `4.12.0`。

## [4.11.2] - 2026-09-15

### 修复
- **Anthropic 客户端把输入记成两倍，缓存命中率只剩 50%** — 4.11.1 让收尾 `message_delta` 补报缓存明细时，把上游 `finish` 事件里**含缓存命中**的 `inputTokens` 直接写进了 Anthropic 的 `input_tokens`，并在注释里声明"缓存字段是子集、客户端不要重复相加"。这违反了 Anthropic Messages 规范：那边的 `input_tokens` **只算未命中缓存的输入**，总输入 = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。按规范累加的客户端（实测 ZCode）于是把 `cache_read_input_tokens` 又加了一遍，输入被记成两倍——状态栏插件的缓存命中率随之从 ~99% 掉到 ~50%（`cache_read ÷ 被翻倍的 input`），上下文容量也被误判为两倍，会提前触发压缩。
  - 定位依据（三方对齐，两处独立验证）：① ZCode `db.sqlite` 的 `model_usage.input_tokens` 恒等于代理 `usage-history.jsonl` 的 `inputTokens + cacheReadTokens`（实测 174822 = 87526 + 87296），而 `cache_read_input_tokens` 与代理一致，说明客户端确实在相加；② 上游权威账单能反推口径——deepseek 峰时价 $0.30/$1.20（谷时 $0.15/$0.60，恰为 2 倍），官方 `gateway.cost` 与「**只对 `输入总量 − 缓存读` 按全价计费**」的估算**逐位相等**（0.000694776），若上游 `inputTokens` 不含缓存则该金额会差约 19 倍；③ 代理 `raw_usage_json` 与 `usage-store` 的成本估算同样按含缓存口径，且与官方账单一致。
  - 修复：新增 `toAnthropicUsage()`（`adapters/commandcode/usage.ts`）统一做口径换算 —— 只报未命中部分，缓存读写单列；流式 `message_delta` 与非流式 `buildAnthropicResponse` 共用同一实现，避免两处口径漂移（4.11.1 的 bug 正是"非流式路径没做拆分"的同源问题）。非流式日志改为打印**输入总量**（三字段相加），与仪表盘口径保持一致。
  - **OpenAI 路由不动**：那边 `prompt_tokens` 含 `prompt_tokens_details.cached_tokens` 本就是 OpenAI 规范（子集语义），两出口各按本家规范是**正确的不对称**。
  - 影响：报文里 `input_tokens` 的数值会变小（等于原来的值减去缓存读），总量由三字段相加还原、**语义总量不变**；Anthropic 客户端记录的输入量与缓存命中率随之恢复正确。
- **上游输入量在流式日志里被丢弃** — 非流式路径此前用 `message.usage.input_tokens` 打日志，该字段在本版本起只表示未命中部分，故显式改为三字段相加的总量，避免运维侧日志突然"变小"。

### 兼容性
- **Anthropic 路由 `input_tokens` 语义变更（向规范收敛）** — 由「含缓存读的输入总量」改为「未命中缓存的输入」。按 Anthropic 规范累加的客户端（ZCode、Anthropic SDK 生态）会因此得到正确总量；把 `input_tokens` 当总量直接使用的非规范客户端会看到该字段变小，需改为三字段相加。README 双语文档与特性条目已同步更正。
- OpenAI 路由契约不变（`prompt_tokens` 含缓存读，`cached_tokens` 为子集）。

### 测试
- 新增 `tests/cost-usage.test.ts` 的 `toAnthropicUsage` 4 项：实测数值换算（87526/87296 → 未命中 230）、缓存写入扣除、无缓存时不虚报不扣减、无上游 usage 时回落值不被扣成负数；其中锁定**不变量 `input_tokens + cache_read + cache_creation == 上游输入总量`**。
- 同步更新 3 处既有断言（`integration.test.ts` 流式与非流式、`adapter.test.ts` 单元）为 Anthropic 语义，并补不变量断言。全量 **233 项通过**（较 4.11.1 的 229 项 +4），`tsc --noEmit` 与 `eslint` 无错误。

- 版本号 `4.11.1` → `4.11.2`。

## [4.11.1] - 2026-09-14

### 修复
- **客户端看不到缓存命中，输入量还是估算值** — Anthropic 路由的流式响应里，`message_start` 在拿到上游 usage 之前就已发出（`input_tokens` 只能是本地估算），而真正的收尾 `message_delta` 只带了 `output_tokens`：上游在 `finish` 事件里给出的**缓存命中明细**（`usageAcc.cacheReadTokens`）与**真实输入量**被整个丢掉。后果是 Anthropic 兼容客户端（实测 ZCode）记录的 `input_tokens` 是估算值、`cache_read_input_tokens` 恒为 0，用量界面上完全看不到缓存命中——而代理自己其实拿到了准确值（缓存读占输入 99%）。现在收尾 delta 一并补报 `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`；非流式 `buildAnthropicResponse` 同样补齐。
- 同源的 OpenAI 路由缺字段：非流式响应与流式 `include_usage` 收尾 chunk 都没有缓存明细，现补 `prompt_tokens_details.cached_tokens`。

### 兼容性
- **`usage` 新增字段，纯增量，既有字段语义不变** — Anthropic 路由新增 `cache_read_input_tokens` / `cache_creation_input_tokens`（流式在收尾 `message_delta`，非流式在 `message.usage`）；OpenAI 路由新增 `prompt_tokens_details.cached_tokens`。`input_tokens` / `prompt_tokens` 仍是**含缓存读的输入总量**，缓存字段是其中的子集，客户端不要重复相加。

### 清理（行为不变）
- 缓存拆分逻辑收敛到 `usage.ts` 的 `splitInput` 并导出复用，删掉 adapter 内的重复实现（此前非流式路径压根没做这一步，正是上面那个 bug 的成因）；`StreamEncoderState` 补 `cacheWriteTokens`，与既有 `cacheReadTokens` / `noCacheTokens` 对齐。

### 测试
- 集成 mock 上游的 `__THINK__` 场景带上缓存明细，新增断言锁定：流式收尾 `message_delta` 必须报出真实 `input_tokens`（=10，而非估算）与 `cache_read_input_tokens`（=8）；两条非流式路由同样锁定。全量 **229 项通过**。

## [4.11.0] - 2026-09-12

### 修复
- **仪表盘在浏览器完全不可用（4.10.0 回归，紧急）** — 4.10.0 重构时把 TypeScript 的 `as HTMLElement` 断言写进了纯 `<script>`，浏览器解析整个脚本块直接 SyntaxError，**所有仪表盘交互全部失效**（Node 侧 diff/冒烟抓不到，因为没人执行页面脚本）。已修复，并新增 `tests/dashboard-spa.test.ts` 三项守卫：内联脚本必须能作为纯 JS 解析、`getElementById` 引用的元素 id 必须存在、不得引用外部 CDN。
- **`start.cmd` 与 logger 双写同一日志文件** — 启动脚本 `>> logs\proxy.log` 与 4.10.0 起的日志落盘指向同一文件，两个写入者会交错/重复。控制台输出改到独立的 `logs/console.log`。
- **CORS 预检被鉴权挡死** — 设置 `PROXY_API_KEY` 后，浏览器的 `OPTIONS` 预检请求（不携带鉴权头）会 401，纯浏览器客户端无法使用。预检现已豁免（`tests/auth.test.ts` 锁定）。

### 兼容性
- **`POST /v1/messages/count_tokens`** — Anthropic SDK/工具会调用它做上下文预算，此前 404。现返回 CJK 感知的本地估算（不发起上游请求、不受引擎暂停影响）。
- **OpenAI `stream_options.include_usage`** — 流式收尾 chunk 现按 OpenAI 语义附带 `usage`（上游 totalUsage 优先，缺失回落本地估算）；未开启时行为不变。
- **`.env` 转正** — 此前保存账号时会写出 `.env` 但应用从不读取（纯误导）。现在启动时自动加载（已存在的环境变量优先，docker/systemd 注入不受影响），与写入侧形成闭环：仪表盘添加账号重启即生效。

### 清理（行为不变）
- 删除从未生效的 `permissionMode` 配置项（wire 契约强制 auto-accept，配置了也被覆盖）；既有 config.json 里残留的该键会被静默忽略，部署无需改动。
- 删除无调用方的 `estimateTokens`、未采用的 `sseLineIterator`、`StreamEncoderState.promptTokens/completionTokens`、`AccountInfo.lastUsedAt/totalRequests`、启动脚本里无消费者的 `COMMANDCODE_PROXY_DIR`；`version.ts` 复用 `utils/paths.ts`（消除第三份副本）。

### 改进
- **每请求读盘归零** — `loadConfig` 与 `getUsageHistory` 增加 mtime+size 缓存，文件未变时不再重复读盘+解析。
- **优雅退出** — SIGINT/SIGTERM 先冲刷用量写队列再关闭服务，Ctrl+C 不丢最后一两条会话记录。
- **管理面 Origin 校验抽纯函数**（`isSameOriginIfPresent`）+ `fastify.inject` 集成测试进 CI（此前只有手测）。
- **每日预算告警** — `DAILY_BUDGET_USD` 设置后当日成本达阈值弹一次 toast；重启从历史回填当日金额，不误报。
- **版本更新检查** — 启动与每 24h 查询 GitHub Releases（api.github.com，只读无凭据，失败静默），有新版时仪表盘头部显示徽章。
- **用量导出 CSV** — 会话明细一键导出（UTF-8 BOM，Excel 直开）。
- **上游并发上限** — `MAX_UPSTREAM_CONCURRENCY`（默认不限制，兼容既有部署），超限以新错误码 `GATEWAY_BUSY`(503) 快速失败。
- **`GET /api/config`** — 只读运行配置视图（端口/绑定/上游参数/路径/限额，不含任何密钥）。

### 测试
- 新增 `tests/guard.test.ts`（6 项：Origin 纯函数 + 管理面异源 403/同源 200/无 Origin 放行）、`tests/dashboard-spa.test.ts`（3 项）、count_tokens 与 include_usage 集成测试。全量 **228 项通过**，`tsc --noEmit` 无错误。

- 版本号 `4.10.0` → `4.11.0`。

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
