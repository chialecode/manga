# Git 与 GitHub 协作规则

本文是 MANGA 的版本管理、托管、CI、分支保护及外部集成正本。仓库为 [chialecode/manga](https://github.com/chialecode/manga)，默认分支为 `main`。选择理由见 [ADR-0002](../decisions/0002-local-first-github.md)，实际建立和验证记录见 [执行报告](../evidence/2026-09-19-github-bootstrap.md)。

## 1. 本地优先与工作节奏

1. 开始前执行 `git status --short --branch`，保留已有修改；基于已有任务分支继续，必要时新建 `feat/`、`fix/`、`docs/` 或 `chore/` 分支。
2. 本地编辑、评审和验证可以多次进行，整理成可评审的一批后再推送。使用已存在的任务分支和 PR，避免反复创建、关闭或重建同一事项。
3. 推送前执行 `node scripts/verify.mjs`；产品工程建立后追加与变更相匹配的类型、测试和构建命令。失败在本地修复，不通过反复推送试探 CI。
4. 推送、创建 PR、合并、安装 App 和发布必须在当前任务已授权范围内；有效授权可连续执行，不要求逐命令重复确认。使用 [PR 模板](../../.github/PULL_REQUEST_TEMPLATE.md)说明结果、依据、验证和剩余问题。
5. 检查 Actions 的结果页或必要的一次状态查询。没有新的提交、日志或外部状态变化时，不持续轮询或重复重跑。

提交消息使用清楚的目的，例如 `docs: clarify module lifecycle`、`fix: preserve reading position`。提交前用 `git diff --cached` 核对暂存内容。当前不强制 DCO sign-off、GPG 签名或特定贡献许可；引入这些要求需要先确认贡献协议和维护成本。

<a id="review-commits"></a>
### 审查修复与未推送提交

提交边界由交付范围决定。不同里程碑、独立功能或独立修复各自保留提交，即使它们都没有 push；例如 M0 与 M1a 仍是两个交付 commit。不得把“未推送”解释为整条本地分支必须合成一个提交。

同一交付首次实现并自检后保存一个 commit。后续本地 Agent 审查发现问题，完成修复、必要验证和暂存核对后，直接 amend 对应的原交付提交，不按 finding 或审查轮次追加修复 commit。消息仍准确描述最终结果时使用 `git commit --amend --no-edit`；结果或范围变化时同时修订消息，移除已经失效的错误描述和临时过程记录。问题依据、修复与复验保留在相关报告中。

若目标提交后面已有其他本地提交，先确认归属、依赖和未推送状态，保存本地恢复点，再用交互式 rebase/edit 或 fixup/autosquash 将修复归入目标提交，并衔接后续提交。保留其他交付的边界与实现，更新受影响的交接基点；不能把对前置提交的修复直接 amend 到不相关的 HEAD。恢复用检查点和临时 fixup 提交在本轮交付前归并到对应交付，不进入最终推送历史。

amend 前核对远端引用、实际推送记录和协作状态；没有 upstream 不等于从未推送。交给另一位本地 Agent 审查本身不要求追加 commit，但改写后必须提供新基点。已推送的提交默认追加集中修复提交；改写远端历史只按明确授权执行，核对目标和预期旧 SHA，使用指定分支的 `--force-with-lease`，不得覆盖新增远端工作。减少 commit 不减少验证，也不改变 push、PR、合并或发布的授权边界。

### 本地 Git 配置

仅在本仓库设置，避免改动其他项目的 Git 行为：

```powershell
git config --local core.autocrlf false
git config --local pull.ff only
git config --local fetch.prune true
git config --local core.hooksPath .githooks
node scripts/verify.mjs
```

`.gitattributes` 负责文本行尾，`.editorconfig` 负责编辑习惯。`pre-push` 调用同一验证入口，不访问 GitHub API、不自动提交或格式化。Git 不随 clone 自动启用自定义 hook，新工作区需要显式配置；hook 可被跳过，不能代替远端合并约束。暂存、工作树或准备推送的提交不同步时，维护者仍须确认被推送版本已验证。

## 2. CI 的范围与触发

[ci.yml](../../.github/workflows/ci.yml)只提供一个稳定检查 `repository-quality`，执行本地验证入口。当前没有应用依赖安装、应用单测、Electron 构建或安装包验证，不能以此检查证明产品可发布。

| 项目 | 策略与理由 |
| --- | --- |
| 自动触发 | 面向 `main` 的 PR：opened、synchronize、reopened；草稿 PR 也检查，ready 状态切换不额外触发 |
| 手动触发 | `workflow_dispatch`；用于首次接线或有明确原因的远端诊断 |
| main push、schedule、PR 文本编辑 | 不触发此 workflow；合并后不重复同一套检查，不做定时全量构建 |
| 必需检查 | 固定 job 名 `repository-quality`；不按路径过滤，避免某些 PR 永久等待缺失检查 |
| 运行环境 | 单个 Ubuntu 24.04 runner；Node 版本读取 `.node-version`；当前验证脚本可跨平台执行 |
| 资源控制 | 每次运行最多 5 分钟；同一个 PR/手动分支的新运行取消旧运行 |
| 权限 | `contents: read`，checkout 不保留凭据；不使用 `pull_request_target`、仓库 secrets 或写入令牌 |
| 供应链 | Actions 固定完整 SHA；远端只允许 checkout/setup-node，新增 Action 同步调整 allowlist 并评审 |

一个本地批次通常只需一次分支推送，已有 PR 因该更新运行一次 CI。首次创建 PR、重开 PR、手动运行和取消中的旧任务仍可能分别产生运行记录；并发取消不会消除已发生的触发或消耗。

应用工程建立后，先让开发者在本地运行真实命令，再把必要的快速检查纳入此工作流。Windows 专属集成、Electron 安装包和迁移测试应在相应实现具备后增加；复杂耗时检查先使用有明确入口的手动验证。不能因为 CI runner 是 Linux 就宣称其他桌面平台已经验收。

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
| 合并方式 | 只允许 squash，保持线性历史；不开自动合并或 merge queue |
| 分支清理 | 合并后由 GitHub 删除已合并的任务分支；本地 fetch 使用 prune 清理失效的远端跟踪引用 |

初始化只用于建立空历史、导入文档和接通首次检查。确认 CI 能产生正确的成功状态后再启用最终 Ruleset，之后执行 PR 流程。不能先要求一个从未存在且无法执行的检查，也不能把永久管理员绕过作为正常协作路径。

改检查名称时，先让新检查真实产出，再切换规则、移除旧名，防止 PR 卡死。紧急调整保护需有明确维护授权，记录理由、临时范围、替代验证和恢复结果；不得自动在检查失败时撤销保护。

## 4. 仓库设置与安全

[repository-settings.json](../../.github/repository-settings.json)记录仓库开关，[actions-policy.json](../../.github/actions-policy.json)记录 Actions 策略。它们是可审阅的期望配置；不在 CI 中运行自动对账或自动修改设置。

- 开启 Issues 与结构化表单；文档集中在 Git 中，关闭 Wiki、Projects 和 Discussions。确有协作需求时再启用相应入口。
- 只允许 squash 合并，使用 PR 标题和正文形成提交消息；关闭自动合并，启用合并后分支删除。
- Actions 默认令牌只读，不允许 Actions 创建/批准 PR；workflow 不包含写权限。
- 保持 Secret scanning 和 Push protection 开启。忽略规则只是减少误提交，仍需人工核对暂存区；若秘密已经泄露，优先撤销或轮换凭据。
- 使用 GitHub 私密漏洞报告作为安全入口，处理范围见 [SECURITY.md](../../SECURITY.md)。不编造邮箱、支持时限或不存在的发行版本。
- 许可证、贡献权利安排、发布签名和安装包发布方式仍见 [Q-09](../decisions/open-questions.md#q-09)。公开仓库不等于已授予某一种开源许可证，不擅自创建 LICENSE 或 DCO 声明。

维护者在 Settings 中调整配置后，应同步相应 JSON、规则正本和验证记录。通过 API 更新时，先读取当前值，只提交差异；请求串行执行，变更请求之间至少间隔一秒，出错停止而非盲目重放。完成后一轮核对即可，不安排定时巡检或自动纠偏。

## 5. Bot 与低频操作

依赖更新策略由 [决定记录](../decisions/0002-local-first-github.md)维护。[dependabot.yml](../../.github/dependabot.yml)仅配置 GitHub 原生 Dependabot 的 Actions 依赖更新；应用依赖清单建立后再增加相应生态。

每月把 Actions 更新合为一组、最多一个未关闭 PR、关闭自动 rebase，由维护者择时评审与合并；不启用自动合并。版本更新 PR 数量上限不约束安全更新，安全警报与自动安全修复是不同设置，不能声称“上限 1”覆盖所有安全 PR。本期自动安全修复 PR 保持关闭，安全告警按维护需要人工处理。

不默认启用自动 AI review、DCO、stale、欢迎评论、标签机器人或基于 PR 文本每次编辑触发的工作流。必要时先写清用途、权限、触发事件和最大消息量，再接入；不要重复 GitHub 原生已有能力。

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
