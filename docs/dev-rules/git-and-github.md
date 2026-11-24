# Git 与 GitHub 协作规则

本文是 MANGA 的版本管理、托管、CI、分支保护及外部集成正本。仓库为 [chialecode/manga](https://github.com/chialecode/manga)，默认分支为 `main`。选择理由见 [ADR-0002](../decisions/0002-local-first-github.md)，建立与验证记录在提交 `ec9968d`（[归档](https://github.com/chialecode/manga/tree/ec9968d/docs/evidence)）。

<a id="workflow"></a>
## 1. 分支、提交与 PR

一个 issue 一个分支、一个小 PR，squash 合并（[开发流程](development-workflow.md#change-loop)）。commit 保存可追溯的本地版本，push 保存远端分支，PR/合并完成代码集成；这些动作都不等于产品验收或正式发布。

<a id="branches"></a>
### 1.1 分支

1. 开始先执行 `git status --short --branch`，检查当前分支与跟踪关系；已有任务分支承载相同目标时继续使用，不因开启新聊天、换 Agent、补测试或收到 review 另建分支。
2. 新目标从已更新的 `main` 建分支，命名 `<type>/<issue号>-<简短描述>`（小写英文和连字符，如 `fix/42-tray-restore`、`feat/57-danmaku-density`）。确认工作区干净或已有改动明确归属后再切换，不自动 stash/reset/覆盖他人文件。
3. 依赖尚未合并的分支时，从它的提交建立依赖分支，在 PR 里写明基点与前置 PR；前置以 squash 合并后 rebase 到 `main` 并重新验证。必需 CI 只对目标为 `main` 的 PR 触发，依赖分支不能宣称已获得该检查。
4. `main` 只经 PR 集成，禁止直推。阶段（里程碑）按顺序编号（A-122）：阶段名是 M 加从 1 起的顺序号；给人读的地方用大写（正文、决定记录、带阶段前缀的编号），机器标识用小写（路径、登记表的 `currentStage`）。

<a id="commits"></a>
### 1.2 提交

- 消息用 Conventional Commits：`type(scope): 具体结果`，scope 可省略，正文可用中文；type 用 `feat`、`fix`、`docs`、`refactor`、`test`、`build`、`ci`、`chore`、`perf`。说明做了什么，避免 `update`、`fix bugs`、`done`；复杂提交正文写原因、验证、数据兼容和已知限制。
- 所有提交都带 DCO `Signed-off-by` 签名（A-43），使用提交者本人的 Git 身份；本仓的 `prepare-commit-msg` hook 自动补签名，未启用 hook 时用 `git commit -s`。仓库开启了网页提交签名要求，squash 合并的提交由 GitHub 补签名。
- 提交前核对 `git diff`、新文件清单及归属，按路径或 hunk 暂存，再看 `git diff --cached` 与 `git diff --cached --check`；不要未经检查把全部未跟踪文件加入。依赖目录、构建包、真实库、私有配置不进入提交；多人/多 Agent 共享工作区时只提交本任务负责的内容。
- 分支里提交几次都可以，合并时 squash 成一个；已推送的提交默认追加修复，不为美化历史强推。改写已共享的历史只按明确授权执行，用指定分支的 `--force-with-lease`。

<a id="pr-and-merge"></a>
### 1.3 push、PR 与合并

- push 与建 PR 长期授权。push 前确认目标分支与待推送提交的公开内容（[公开内容检查](quality-gates.md#11-公开内容检查)），`pre-push` hook 会跑 `node scripts/verify.mjs`；首次推送设置 upstream，不用 `--all`、`--mirror` 或强推。
- 使用 [PR 模板](../../.github/PULL_REQUEST_TEMPLATE.md)：关联 issue、做了什么、验证（命令 / 结果 / 未运行项）、风险。碰了[高风险清单](development-workflow.md#high-risk)加 `risk:high`。
- CI `repository-quality` 通过、非作者的独立审查无阻塞项后：低风险 PR 由 Agent `gh pr merge <号> --squash --match-head-commit <头提交>` 合并；`risk:high` 等用户合并。审查修复推到同一分支，只按新提交查一次必要结果，不循环 `push → 等 CI → 小修 → push`，不通过反复推送调试能在本地复现的问题。
- 合并后 GitHub 删除远端分支；本地 `git switch main && git pull --ff-only`，再[安装开发版](development-workflow.md#dev-install-at-handoff)。

<a id="local-git"></a>
### 1.4 本地 Git 配置

仅在本仓库设置，避免改动其他项目的 Git 行为：

```powershell
git config --local core.autocrlf false
git config --local pull.ff only
git config --local fetch.prune true
git config --local core.hooksPath .githooks
node scripts/verify.mjs
```

`.gitattributes` 负责文本行尾，`.editorconfig` 负责编辑习惯。`pre-push` 经 `scripts/pre-push.mjs` 调用同一验证入口，并把完整输出写入 `dist/evidence-runs/pre-push-*.log`（保留最近 10 份；失败时打印路径，供定位偶发失败），不访问 GitHub API、不自动提交或格式化；`prepare-commit-msg` 只为提交消息补提交者的 DCO 签名。Git 不随 clone 自动启用自定义 hook，新工作区需要显式配置；hook 可被跳过，不能代替远端合并约束。

## 2. CI 的范围与触发

[ci.yml](../../.github/workflows/ci.yml)只提供一个稳定检查 `repository-quality`。面向 main 的 PR 与手动触发会 Corepack 启用 pnpm 11.24.0、按锁文件安装，再运行 `node scripts/verify.mjs`（文档、公开检查及反例、报告反例、依赖、类型和契约/修复回归）。超时 15 分钟。它不下载 Electron、不跑完整 POC-03 媒体矩阵或 Windows 打包。runner 上没有 Windows 媒体前置（固定版本的 Windows FFmpeg、语音模型和用它们生成的合成样本），工作流以 `MANGA_MEDIA_PREREQUISITES=absent` 声明，需要它们的用例记为跳过而不是通过；本地 `verify.mjs` 与阶段入口照常运行这些用例（[质量门禁](quality-gates.md#5-ci-接线与扩展)）。


| 项目 | 策略与理由 |
| --- | --- |
| 自动触发 | 面向 `main` 的 PR：opened、synchronize、reopened；草稿 PR 也检查，ready 状态切换不额外触发 |
| 手动触发 | `workflow_dispatch`；用于首次接线或有明确原因的远端诊断 |
| main push、schedule、PR 文本编辑 | 不触发此 workflow；合并后不重复同一套检查，不做定时全量构建 |
| 必需检查 | 固定 job 名 `repository-quality`；不按路径过滤，避免某些 PR 永久等待缺失检查 |
| 运行环境 | 单个 Ubuntu 24.04 runner；Node 版本读取 `.node-version`；当前验证脚本可跨平台执行；Windows 媒体前置缺席，相关用例跳过（见上） |
| 资源控制 | 每次运行最多 15 分钟；同一个 PR/手动分支的新运行取消旧运行 |
| 权限 | `contents: read`，checkout 不保留凭据；不使用 `pull_request_target`、仓库 secrets 或写入令牌 |
| 供应链 | Actions 固定完整 SHA；远端允许列表只放 `actions/checkout`、`actions/setup-node`、`actions/upload-artifact`、`actions/download-artifact`，新增 Action 同步调整 allowlist 并评审 |

一个本地批次通常只需一次分支推送，已有 PR 因该更新运行一次 CI。首次创建 PR、重开 PR、手动运行和取消中的旧任务仍可能分别产生运行记录；并发取消不会消除已发生的触发或消耗。

应用工程建立后，先让开发者在本地运行真实命令，再把必要的快速检查纳入此工作流。当前 PR CI 已安装锁定依赖并做类型/依赖门禁；完整阶段门禁仍以开发机本地的 Windows 11 环境为准。

### 2.1 每周发布工作流（`release.yml`，A-126）

[release.yml](../../.github/workflows/release.yml) 是上述 `ci.yml` 规则的有意例外，专门负责正式版的自动构建、升级演练与 GitHub Releases 发布；`ci.yml` 与必需检查 `repository-quality` 保持不变。

- **触发与并发：** 每周一 `00:00 UTC`（北京时间 `08:00`，cron `0 0 * * 1`）定时运行，以及 `workflow_dispatch` 手动触发（输入 `dry_run`，默认 `true`：只构建与演练、不创建标签与 Release）；不响应 `push`、`pull_request` 或任何 fork 事件。`concurrency` 组为 `release` 且 `cancel-in-progress: false`，不中途取消正在进行的发布。
- **四个阶段（按最小权限隔离）：**
  1. `decide`（Ubuntu，`contents: read`，不安装依赖）：运行 `node scripts/stage/release-decide.mjs`，读取最高的 `v0.1.*` 标签与 `main` 在它之后的新提交（包括 Dependabot 等任何合并进 `main` 的 PR）。没有新合并时以“本周没有新的合并”成功结束，不启动后续 Windows 构建；没有任何 `v0.1.*` 标签时发布 `0.1.1`；有新合并时算出下一个 `0.1.x` 版本号并生成中文发布说明素材，随后在同一轻量 Ubuntu 任务中运行 `node scripts/tools/check-tool-links.mjs` 对全部锁定随包工具下载地址发 HTTP `HEAD` 预检（跟随重定向），失效时在分配昂贵的 `windows-2025` 运行器之前即快速失败并明确指出失效锁文件（A-127）。离线静态检查 `check-tool-links.mjs --pins` 随 `verify.mjs` 守护 FFmpeg 使用月末保留标签而非会被上游清理的每日标签、其余工具固定 40 位完整提交 SHA。
  2. `check`（`windows-2025`，`contents: read`，**无任何 secret**）：按锁文件下载随包工具（FFmpeg、Silero VAD、字幕字体）、生成合成样本，依次运行 `node scripts/verify.mjs`、`node scripts/stage.mjs test`、`node scripts/stage.mjs package` 与 `node scripts/stage.mjs installer`（使用测试身份 `MANGA Test` / `MANGA Dev Test`）。共享运行器不跑性能基准，基准结论以本机最近一次门禁证据为准，并在 `release.json` 记录基准源码指纹与本次发布源码是否一致。任一步骤失败则停止，本周不发布。
  3. `build`（`windows-2025`，`contents: read`，绑定受保护环境 `environment: release`）：在同一提交上构建正式版安装包、生成块图 `.blockmap`、`latest.yml`、Ed25519 分离签名 `.sig`、`SHA256SUMS` 与中文 `RELEASE-NOTES.md`，并执行从上一版到当前版本的升级演练与 1 字节篡改拒绝演练（`node scripts/stage.mjs release --ci`）。环境的两个 secret（`MANGA_PLUGIN_SIGNING_KEY_PEM` 与 `MANGA_UPDATE_SIGNING_KEY_PEM`）分别只映射给打包插件和签名发布包的那一个步骤，写入运行器临时目录后交给脚本，步骤结束即在 `finally` 中删除，绝不打印或进入日志与 artifact。产物通过 `actions/upload-artifact` 上传（保留 7 天）。
  4. `publish`（Ubuntu，`contents: write`，**无 secret、不执行 `pnpm install`**，`if: inputs.dry_run != true`）：下载 artifact，运行 `node scripts/stage/release-publish-verify.mjs --publish` 用仓库内置公钥再次核对 `SHA256SUMS`、`latest.yml` 与 `.sig`，确认标签尚不存在后调用 `gh release create v0.1.x --target <SHA>` 发布正式版。
- **静态检查守护：** `scripts/check-workflows.mjs` 随 `node scripts/verify.mjs` 自动运行，静态校验 `ci.yml` 与 `release.yml` 的触发器、顶层与各 job 权限、secret 只出现在 `build` 的指定步骤、所有 Action 固定 40 位完整 SHA 且在 `.github/actions-policy.json` 允许列表中、`publish` 不含任何依赖安装命令。
- **长期不活动与失败排查：** 公开仓库连续 60 天无仓库活动时 GitHub 会自动停用定时 workflow，在 Actions 页面重新启用或手动触发一次即可恢复。如果某周定时运行失败，workflow 直接停止、不发布，不自动重跑或自动改代码；每周维护时执行一次 `gh run list --workflow release.yml --limit 3` 查看最近一次运行状态（[开发流程](development-workflow.md#weekly)），失败就建 `bug` issue 修复。

### 2.2 本机发布、发布授权与更新密钥轮换（A-125）

- **本机一键发布命令：** `node scripts/stage.mjs release` 在 `main` 分支、工作区干净、与 `origin/main` 同步且当前源码指纹的 `stage gate` 通过时运行，复用门禁打包产物生成 `dist/release/v0.1.x/` 下的 `manga-setup-0.1.x.exe`、`.blockmap`、`latest.yml`、`.sig`、`SHA256SUMS`、`RELEASE-NOTES.md` 与脱敏的 `release.json`，并在临时目录用测试安装身份完成升级演练与篡改拒绝演练。
- **发布授权边界：** 正式发布默认由 2.1 的每周 workflow 自动执行；本机运行 `node scripts/stage.mjs release` 默认只生成文件并完成演练，**不创建 Git 标签、不调用 `gh release create`**，并在输出与 `release.json` 的 `requiresAuthorization` 中写出需用户当次明确授权才执行的发布命令。只有在用户当次明确授权本机发布、显式传入 `MANGA_RELEASE_PUBLISH=1` 与 `--publish` 时才创建标签并上传 Release。
- **Ed25519 更新签名密钥与轮换步骤：** 正式版更新使用独立于第一方插件密钥的 Ed25519 密钥对（私钥 `%APPDATA%\manga-release\update-signing.key` 不入库并存入 GitHub `release` 环境 secret `MANGA_UPDATE_SIGNING_KEY_PEM`，公钥 `%APPDATA%\manga-release\update-signing.pub` 内置在 `packages/app-core/src/update/signature.ts` 的 `RELEASE_UPDATE_PUBLIC_KEYS`）。需要轮换更新密钥时，必须分两步过渡，避免已安装的旧版本无法校验过渡版本：
  1. **发布过渡版本 `v0.1.N`：** 生成新密钥对，把新公钥追加到 `RELEASE_UPDATE_PUBLIC_KEYS`（同时保留旧公钥），用**旧私钥**为 `v0.1.N` 签名并发布，使已安装的旧版本能够验证并升级到同时信任新旧公钥的 `v0.1.N`；
  2. **切换新私钥并移除旧公钥：** 更新本机 `%APPDATA%\manga-release\update-signing.key` 与 GitHub `release` 环境 secret `MANGA_UPDATE_SIGNING_KEY_PEM` 为新私钥；待用户升级到 `v0.1.N` 后（或旧私钥因泄露需立即作废时），从 `RELEASE_UPDATE_PUBLIC_KEYS` 移除旧公钥并用新私钥签发后续版本。


## 3. main Ruleset 与合并

[main.json](../../.github/rulesets/main.json)是预期规则定义，适用于 `refs/heads/main`；GitHub 远端是实际执行方，提交 JSON 本身不会自动启用保护。

| 规则 | 决定 |
| --- | --- |
| 删除、强推 | 禁止 |
| 变更入口 | 必须通过 PR；无常驻 bypass actor，维护者也按同一规则工作 |
| 审批人数 | 0；当前为单人维护，不要求自己给自己审批，也不设置不存在的审阅者 |
| Code owner | CODEOWNERS 记录责任归属，不强制 owner approval；加入协作者后再评估独立审批 |
| 讨论 | 所有 review thread 必须解决 |
| 必需检查 | `repository-quality`，绑定 GitHub Actions App，防止其他集成以同名状态冒充 |
| 必须更新到最新 main | 关闭；减少无意义的更新分支和重复 CI。共享契约、依赖、迁移或相关 main 改动时，合并前仍须更新并重新验证 |
| 合并方式 | 只允许 squash，保持线性历史；允许自动合并（必需检查通过后才合并），不用 merge queue |
| 分支清理 | 合并后由 GitHub 删除已合并的任务分支；本地 fetch 使用 prune 清理失效的远端跟踪引用 |

初始化只用于建立空历史、导入文档和接通首次检查。确认 CI 能产生正确的成功状态后再启用最终 Ruleset，之后执行 PR 流程。不能先要求一个从未存在且无法执行的检查，也不能把永久管理员绕过作为正常协作路径。

改检查名称时，先让新检查真实产出，再切换规则、移除旧名，防止 PR 卡死。紧急调整保护需有明确维护授权，记录理由、临时范围、替代验证和恢复结果；不得自动在检查失败时撤销保护。

## 4. 仓库设置与安全

[repository-settings.json](../../.github/repository-settings.json)记录仓库开关，[actions-policy.json](../../.github/actions-policy.json)记录 Actions 策略。它们是可审阅的期望配置；不在 CI 中运行自动对账或自动修改设置。

- Issues 只允许协作者创建（`issue_creation_policy=collaborators_only`），是需求、缺陷与需要用户事项的队列（[开发流程](development-workflow.md#issues)；A-138 取代 A-123 关闭 Issues 的做法）。外部反馈、缺陷和建议走 Discussions，由维护者整理成 issue。PR 同样仅协作者可创建（`pull_request_creation_policy=collaborators_only`）。文档集中在 Git 中，关闭 Wiki 和 Projects。来自 fork 的 PR 运行 workflow 前须维护者批准（所有外部贡献者）。
- 只允许 squash 合并，使用 PR 标题和正文形成提交消息；允许自动合并与“更新分支”，启用合并后分支删除；网页上的提交要求签名（`web_commit_signoff_required`）。
- Actions 默认令牌只读，不允许 Actions 创建/批准 PR；日常验证 workflow（`ci.yml`）不包含写权限或 secrets。发布工作流（`release.yml`）仅在 `publish` job 声明 `contents: write` 用于创建 GitHub Release，两把签名私钥仅存于只允许 `main` 分支部署的 `release` 环境 secrets（`MANGA_PLUGIN_SIGNING_KEY_PEM`、`MANGA_UPDATE_SIGNING_KEY_PEM`），不設仓库级全局 secret。
- 保持 Secret scanning 和 Push protection 开启。忽略规则只是减少误提交，仍需人工核对暂存区；若秘密已经泄露，优先撤销或轮换凭据。
- 使用 GitHub 私密漏洞报告作为安全入口，处理范围见 [SECURITY.md](../../SECURITY.md)。不编造邮箱、支持时限或不存在的发行版本。
- 项目许可证已确认为 [Apache-2.0](../../LICENSE)；额外贡献权利安排、发布签名和安装包发布方式仍见 [Q-09](https://github.com/chialecode/manga/issues/48)。不擅自变更已确认许可；提交的 DCO 签名按第 1.2 节执行。

维护者在 Settings 中调整配置后，应同步相应 JSON、规则正本和验证记录。通过 API 更新时，先读取当前值，只提交差异；请求串行执行，变更请求之间至少间隔一秒，出错停止而非盲目重放。完成后一轮核对即可，不安排定时巡检或自动纠偏。

## 5. Dependabot 与低频操作

依赖更新策略由 [决定记录](../decisions/0002-local-first-github.md)维护（A-36、A-132）。[dependabot.yml](../../.github/dependabot.yml)配置 GitHub 原生 Dependabot：

- **npm（pnpm workspace）：** 每周；React、Tiptap 各成一组，其余同主版本更新合为一组，主版本单独 PR；最多 3 个未关闭 PR。
- **Actions：** 每月合为一组，最多 1 个未关闭 PR；Action 固定完整 SHA，Dependabot 同步更新 SHA 与版本注释。
- 两者都有 7 天冷却期（`cooldown.default-days: 7`，与 `minimumReleaseAge` 一致），关闭自动 rebase，不启用自动合并。
- **版本更新 PR** 在[每周维护](development-workflow.md#weekly)时按风险分级处理：npm 同主版本更新组在 CI 与本机快速门禁通过后按低风险合并；主版本更新与 GitHub Actions 更新加 `risk:high`，由用户合并；不采用的写明原因关闭。

Dependabot 告警与自动安全修复 PR 已打开（2026-11-14 用户授权，Agent 经 API 打开并核对）。安全修复 PR 不受冷却期与 PR 数量上限约束，不等每周维护，有就尽快评审，风险分级同上；它合并后照常计入每周发布。本地的漏洞检查是 `node scripts/deps.mjs --audit`，见[质量门禁](quality-gates.md)。

自动 AI review、DCO、设计/模板检查等按 A-36 路线逐项核对当前远端状态和接入前提；不因参考配置存在就宣称本仓已安装或生效。接入前写清用途、权限、触发事件和最大消息量；stale、欢迎评论和自动标签目前无明确需求，不默认启用，不重复 GitHub 原生已有能力。

不设 bot 账号：Agent 用维护者本人的 `gh` 身份 push、建 PR、评论与合并，靠分支名、PR 模板、标签与审查评论区分来源。

低频协作要求：

- 本地排查和验证先完成，再批量推送有效进展；不要自动循环 commit/push、开关 PR、刷标签或发布相同评论。
- 使用 GitHub 页面通知或事件通知；工具查询有明确目的和有界次数，不运行高频 `gh ... --watch` 或自建无限轮询。
- API 遵守 `Retry-After`、`X-RateLimit-Remaining` 和 `X-RateLimit-Reset`。遇到 403/429 先读错误语义，限流时停止请求，等待服务要求的时间；权限问题先修权限，不立即重试。
- 若账户再次被 flagged，停止相关自动化，保留任务时间和错误信息，通过 GitHub 官方支持处理；不切换账号或令牌绕过限制。

这些措施减少无效请求和写入，不能保证账号不会被风控标记。GitHub 未公布一个可保证免于反 spam 审查的请求频率；API 限流额度也不是反 spam 安全额度。

## 6. GitBook 接入准备

本次只准备 [.gitbook.yaml](../../.gitbook.yaml)和 [阅读目录](../SUMMARY.md)，不连接 Space、不安装 App、不创建站点、不启用发布 workflow。文件存在不代表 GitBook 同步或公开站点已经可用。

内容根设为仓库根：首页使用根 README，目录使用 `docs/SUMMARY.md`。这样 AGENTS、贡献指南和 docs 内相对链接可共享同一内容根，避免把根目录规则排除在阅读范围外。SUMMARY 只承担导航，不另复制需求和设计正文。

后续连接时按此顺序执行：

1. 明确 GitBook 账号/组织、目标 Space、站点公开范围、费用与域名；初始同步选择 GitHub → GitBook，避免用空 Space 覆盖 Git 历史。
2. GitHub App 仅授权本仓库；使用现有 `main` 作为已审阅内容来源。GitBook 新版连接界面可能生成站点级 `gitbook-docs.yaml`，应在获得真实 Space 信息后保存其映射，不预填虚构标识。
3. 仓库是编辑正本。默认不在 GitBook 网页编辑正文；若同步方式会回写 Git，必须通过分支和 PR，不授予直写 main 的 Ruleset 绕过权限。无法做到时调整接入方式，不削弱主分支规则。
4. 先做一次同步预览，检查导航、中文锚点、Mermaid、根目录链接、JSON/脚本下载链接和草稿状态展示，再决定发布。仓库链接校验不等于 GitBook 渲染验收。
5. 确认成功后登记真实站点地址、Space 映射、授权范围和停用步骤。GitBook App 自身接收事件，无需另加 GitHub Actions 定时同步。

## 7. 平台说明

- [GitHub REST API 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)：串行请求、变更间隔和限流处理。
- [GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)：规则、绕过与执行范围。
- [Dependabot 配置](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)：分组、计划、rebase 与 PR 上限。
- [GitBook 内容配置](https://gitbook.com/docs/docs-as-code/git-sync/content-configuration)：内容根、首页和 SUMMARY；实际接入以当前界面为准。

每次推送前，除统一验证外，还须按 [公开内容门禁](quality-gates.md#11-公开内容检查)核对待推送提交、文件名、文档/证据与暂存内容，清理外部工程参考叙述、私密材料和本机专属信息。自动检查只覆盖明确规则，不能替代该语义审查。
