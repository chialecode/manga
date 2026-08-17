# MANGA 仓库：Agent 工作入口

> 本文件是 Codex 与 Claude Code 共用的项目指令正本。`CLAUDE.md` 只保留 `@AGENTS.md`，
> 不要在两处重复维护规则。

## 仓库边界

- 本仓库只负责 Windows 桌面客户端及其共享 packages。首发不含移动端、Web 端与任何服务端。
- 本产品**本地优先**：核心阅读、播放、媒体库与标记功能在完全离线时必须可用。任何让核心功能依赖网络的改动都需要先说明理由。
- 开始工作前先检查工作区状态和相关源码，不覆盖、不回退开发者已有改动。
- 用户的媒体文件是只读的。**任何代码路径都不得写入、移动、重命名或删除用户媒体目录中的文件。**

## 规则组织

- 开发与工程规则统一放在 `docs/dev-rules/`。
- 产品行为与体验规则统一放在 `docs/product-rules/`。
- UI 视觉、交互与内容设计规则统一放在 `docs/design-rules/`。
- 架构正本是 `docs/architecture.md`：技术栈、进程拓扑、信任边界、数据模型与不变式。与任何规则文档冲突时以它为准。
- 根 `AGENTS.md` 只保留所有任务都适用的规则、风险入口和文档索引。
- 目录或模块专属规则放到对应目录的嵌套 `AGENTS.md`；跨目录复用的专题说明放在 `docs/`，并由本文件写明触发条件。

## 当前规则索引

- 首次接触本仓、需要定位功能代码位置或判断新代码归属哪个 package 时，先读 `docs/dev-rules/repo-map.md`。
- 首次安装、修复依赖、更新 `vendor-bin` 二进制或准备新 worktree 时，必须先读 `docs/dev-rules/environment-setup.md`。
- **引入任何新的第三方依赖前，必须先读 `docs/dev-rules/dependency-admission.md`。** 本仓的默认答案是自研；只有「自研等于重新实现一份成熟的公开规范或数值内核」时才允许引入，且必须提交 ADR。绕过准入直接加依赖视为 P0。
- 修改 package 依赖方向、进程拓扑、`packages/domain` 的纯度，或新增 utility / child 进程前，必须先读 `docs/dev-rules/architecture-invariants.md`。
- 修改 Renderer、preload、`BrowserWindow`、CSP、自定义协议、Fuses、导航行为或任何 Electron 特权能力前，必须先读 `docs/dev-rules/electron-security-and-process-boundaries.md`。其中三条是**不变量**：**渲染进程零特权**（无 Node API、无 fs 句柄、无 DB 连接、无密钥）、**媒体 URL 只用不透明 token**（禁止把真实路径放进任何 URL）、**电子书内容 `script-src 'none'`**（EPUB 允许内嵌脚本，CSP 是唯一防线，iframe sandbox 在此场景不可靠）。放宽任一条视为安全变更，需重新评审。
- 新增或修改 RPC 方法、流式通道、取消语义、背压策略或错误模型前，必须先读 `docs/dev-rules/ipc-contract.md`。**无 zod schema 的方法不得注册**；**契约中不得存在返回明文密钥的字段**。
- 修改数据库 schema、migration、FTS 索引、备份恢复或运行期数据库访问前，必须先读 `docs/dev-rules/database-and-migrations.md`。其中**已发布的 migration 文件不可修改**是红线，由 `migration-freeze` 闸门拦截；需要改动时只能追加新 migration。
- 修改锚点（anchor）表结构、失效状态机、`evidence_link`，或任何写入派生内容（transcript / ai_message / ai_artifact）的路径前，必须先读 `docs/product-rules/core-product-principles.md` 的「证据模型」一节。其中两条是**不变量**：**锚点绝不静默重定位或静默丢失**、**派生内容必须携带至少一条 evidence_link 且不得覆盖用户原始记录**。
- 新增或修改日志、错误处理、时间单位、UI 文案与 i18n、命名约定前，必须先读 `docs/dev-rules/engineering-conventions.md`。其中**全系统整数毫秒**与**日志脱敏只增不减**是不变量。
- 新增或修改测试、CI 闸门，或需要判断某项改动该跑哪一层测试时，必须先读 `docs/dev-rules/testing-and-gates.md`。**不得通过跳过、删除或弱化测试制造通过。**
- 新增或修改外部数据源（元数据、弹幕、资源索引）、网络请求路径或凭证处理前，必须先读 `docs/product-rules/core-product-principles.md` 的「外部能力边界」一节。**新增 provider 默认关闭**；**源码中禁止硬编码 URL 字面量**；**自动测试禁止访问真实站点**。
- 触及应用名、appId、安装/数据目录、自定义协议名，或开发版与正式版的隔离逻辑前，必须先读 `docs/dev-rules/naming-and-identifiers.md`。这些标识符**发布后不可更改**；**仅显示名用大写 `MANGA`，一切目录与协议名小写**；**内部资源协议禁止带 `manga-` 前缀**；源码中禁止出现这些标识符的字面量，一律从 `packages/contract/identity.ts` 导入。
- 修改打包配置、Fuses 位、安装器或更新器前，必须先读 `docs/architecture.md` §16。**禁止应用降级**：更新器只接受更高版本。
- 修改三栏布局、侧栏状态机、已打开资源模型、右栏面板注册、主题令牌或字体栈前，必须先读 `docs/design-rules/app-shell.md`。其中三条是**契约**：**右栏 `closed` 时宽度为 0 且无残留把手**、**`restoreViewState` 收到损坏状态必须静默降级而非丢弃会话行**、**中日文层级不得依赖 600 与 700 的字重差**。
- 判断当前该做什么、某个交付是否达标时，读 `docs/roadmap/phase-1.md`。

## 通用工作流程

1. 先确认目标、仓库边界、当前分支与工作区状态。
2. 尊重已有的 Git 工作流。已有任务分支或 worktree 时直接复用，不嵌套创建。
3. 按任务类型读取 `docs/dev-rules/` 与 `docs/product-rules/` 中的相关规则，再读 `docs/architecture.md` 的对应章节。
4. 先读实际代码和测试，再决定实现；不要只依赖文档猜测现状。
5. 修改时保持范围最小，保护已有改动，不使用破坏性 Git 命令。
6. 完成后运行与风险匹配的检查，并 review 整体 diff。
7. 如实报告已验证、未验证、风险和需要开发者决定的事项。**标注为「待验证」的事实不得作为决策依据。**

## Git 与交付

- 默认 PR-first。代码和文档从非默认分支通过 PR 进入 `main`。远端为 `origin` → `github.com/chialecode/manga`。
- **闸门的强制力在本地 git hook，不在 CI。** `pre-commit` 跑静态闸门，`pre-push` 跑运行时闸门；CI（`push` 到 `main` 与 `pull_request` 到 `main`）只做复核。**禁止使用 `--no-verify` 绕过 hook** —— 等同于跳过闸门。
- 本仓库只有一位维护者，而 GitHub 不允许批准自己的 PR，因此分支保护的 required approvals 为 0。**这意味着 PR 的质量完全由本地 hook 与 CI 承担，没有第二个人兜底。**
- **提交前测试门禁（硬性要求）**：提交前必须在本地跑完仓库根 `pnpm test:unit`，并对本次改动涉及的每个 package 跑 `pnpm --filter <包名> run --if-present typecheck`。任何一项失败都不得提交。
- 在上述门禁之上按风险追加验证：触及进程边界、数据库、协议或供应链的改动追加 `pnpm test:all`，最终以 CI 门禁为准。
- 提交 PR 时如实说明改动、验证范围与风险，明确写出哪些没验证。

## 绝对安全底线

- 用户凭证、令牌、API Key 和更新包签名私钥不得写入仓库或任何可能被 Git 跟踪的路径。
- 未经明确授权，不执行删除数据、覆盖改动、推送、发布、合并等外部或难以恢复的操作。
- 任务触及以下任一处时，必须先停下来核对专项规则，并在动手前说明风险或请求确认：
  进程边界与 Fuses、自定义协议与路径解析、密钥存取、已发布的 migration、锚点失效语义、外部网络出口、更新器、`vendor-bin` 二进制来源。
