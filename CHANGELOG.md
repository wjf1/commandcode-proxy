# Changelog

所有主要版本更新都记录在此文件。

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
