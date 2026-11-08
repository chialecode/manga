# Git 与 GitHub 协作规则

本文是 MANGA 的版本管理、托管、CI、分支保护及外部集成正本。仓库为 [chialecode/manga](https://github.com/chialecode/manga)，默认分支为 `main`。选择理由见 [ADR-0002](../decisions/0002-local-first-github.md)，建立与验证记录在提交 `ec9968d`（[归档](https://github.com/chialecode/manga/tree/ec9968d/docs/evidence)）。

## 1. 本地优先与工作节奏

项目主要由 AI Agent 连续完成一个里程碑或已明确拆出的子阶段，再集中审查。默认采用“一个阶段一个分支、一个 commit、一个 PR”：阶段指一个里程碑或已明确拆出的子阶段。阶段首次交付保存一个 commit，push 前阶段内的一切后续修改都 amend 进这个提交，审查收敛后集中 push。实现过程可以连续编辑、测试和修复，不按时间、文件、功能点或工作包数量要求提交。commit 保存可追溯的本地版本，push 保存远端分支，PR/合并完成代码集成；这些动作都不等于产品里程碑验收或正式发布。

| 动作 | 触发时机 | 默认节奏 | 完成条件 |
| --- | --- | --- | --- |
| 创建分支 | 开始一个里程碑、明确子阶段或与当前阶段无关的紧急修复 | 一个阶段一个分支；内部工作包、跨会话、换 Agent、返工和审查修复均复用 | 基点与依赖清楚，不夹带无关工作 |
| 本地 commit | 阶段首次实现与自检完成、交给审查时；之后每次修改完成并验证时 | 每个阶段只有 1 个；push 前阶段内的返工、审查记录、修复与人工反馈修复全部 amend 进该提交，已推送后默认追加集中修复 | 实现、必要测试与相关文档一致；暂存内容已检查 |
| push | A 审查收敛（Agent 侧阶段完成）且用户明确授权后；授权请求登记在[用户待办](../../USER-ACTIONS.md)，人工检查不是前提 | 默认本轮整体推送 1 次；远程审查有新修复时再集中推送，无每日配额 | 待推送版本验证通过、公开内容已核对、目标分支及有效授权明确 |
| 创建/更新 PR | Agent 侧阶段完成且用户明确授权相应 PR 操作后 | 一个里程碑/明确子阶段一个 PR；审查修复更新原 PR，未完成用 draft 表达 | 说明具体行为、验证与剩余限制 |
| 合并与收尾 | PR 范围完成、必要检查通过、反馈已处理 | 每个 PR 完成时一次；合并后结束该分支 | 有合并授权；不把里程碑外缺口掩盖成通过；未执行的人工检查在用户待办中如实保持 not-run 并顺延 |

首次 push 前，阶段分支相对基点只有一个提交。阶段内的规划与计划文档、B 实施与返工、A 审查报告与局部修复、证据和人工反馈修复都属于这一个提交；执行角色、审查轮次、内容类型（代码、文档或证据）以及“独立功能”“独立修复”都不构成新的提交边界。只有不同阶段才分别提交，它们本来就在各自的分支上、对应各自的 PR；与本阶段无关的紧急修复另开分支，不在阶段分支上多留一个提交。中间仅在大范围改造前需要回退点、试验路线分叉、工作被中断或跨环境交接需要保存现场时增加检查点。普通测试通过、完成一个 P 工作包、时间到了或 Agent 内部上下文切换，都不自动触发 commit/push。这些检查点只在本地使用，push 前归并回阶段提交。连续实现期间可以保持工作区未提交，但交给独立审查者前应保存清楚的阶段提交。

### 1.1 分支边界与基点

1. 开始先执行 `git status --short --branch`、检查当前分支与跟踪关系。已有任务分支承载相同目标时继续使用，不因开启新聊天、换 Agent、补测试或收到 review 另建分支。
2. 独立新目标默认从已更新的 `main` 建分支；在开始、交接或集成前按需 fetch 一次，不循环拉取。确认工作区干净或已有改动明确归属后再切换，不能自动 stash/reset/覆盖他人文件来凑干净状态。
3. 命名使用 `feat/<目标>`、`fix/<问题>`、`docs/<专题>`、`chore/<维护>`，小写英文和连字符，例如 `feat/agent-foundation`、`fix/recording-seek`。名称描述交付内容，不使用 `temp`、`test2` 或仅以日期区分同一任务。阶段按顺序编号（A-122）：阶段名是 M 加从 1 起的顺序号，下一阶段在上一阶段编号上加 1，不用字母后缀拆子阶段；编号与 PR 编号无关（bot 等也会占用 PR 编号）。写法按读者区分：给人读的地方用大写，即正文、计划、决定记录和带阶段前缀的编号（如 `MN-W01`、`MN-A-01`）；机器标识用小写，即路径、文件名、分支（`feat/mN-<目标>`）、提交 scope（`feat(mN)`）、数据目录与登记表的 `currentStage`。接受阶段名的命令行参数两种大小写都认，统一记为小写。
4. 新目标依赖尚未合并的旧分支时，先把旧分支保存为可审查提交。可以从明确的旧提交建立依赖分支，并在交接/PR 标明基点、前置 PR 和临时目标分支；不得假装来自 main，也不要求无关工作全部停下。前置以 squash 合并后，整理后继分支使其只包含新工作，重新验证；已共享历史的改写或强推按单独授权处理。当前必需 CI 只对目标为 main 的 PR 触发，依赖分支不能宣称已获得该检查。
5. 目标合并后新里程碑使用新分支；不把后续阶段继续叠在已合并分支上。main 只经 PR 集成，禁止日常直推。仅当范围确实需要独立验收、并行维护或独立回退时拆成交付子阶段；文件多、工作包多本身不要求增加分支或 PR。

### 1.2 commit 的内容与检查

阶段提交包含本阶段的全部功能及其实现、测试、迁移、文档与证据；强耦合的接口、使用方和登记文件因此总在同一提交中，不留下无法运行或链接失效的中间状态。与本阶段无关的格式化、依赖升级或其他目标走独立分支。Agent 不需要把已经连续完成的实现倒拆成虚构的开发步骤；阶段提交的正文说明最终结果、工作包覆盖、验证与限制；amend 时同步移除失效消息，已推送后的追加修复提交说明解决的问题。

提交前核对 `git diff`、新文件清单及归属，按路径或 hunk 暂存，再看 `git diff --cached` 与 `git diff --cached --check`。不要未经检查直接把全部未跟踪文件加入。依赖目录、构建包、真实库、私有配置不进入提交；可公开的合成证据按质量门禁保留。多人/多 Agent 共享工作区时只提交本任务明确负责的内容，不替别人打包未完成修改。

实现期间继续按风险运行定向检查，不因减少 commit 次数减少测试。首次交付、amend 或追加集中修复提交前，按[质量门禁](quality-gates.md)完成本批需要的验证。部分暂存时，工作区通过不等于暂存版本通过，应使提交包含必要依赖或在隔离目录验证暂存/提交版本。完整推送批次必须有 `node scripts/verify.mjs` 的通过结果，其他包/恢复/性能检查按实际变更触发；仅创建 commit 不使相同源码的已有结果失效，已有 pre-push hook 按其配置执行。纯文档不重跑无关的设备或性能实验。

消息采用 `type(scope): 具体结果`，scope 可省略，正文可用中文。type 使用 `feat`、`fix`、`docs`、`refactor`、`test`、`build`、`ci`、`chore`；说明做了什么，避免 `update`、`fix bugs`、`done`。复杂提交正文记录原因、验证、数据兼容和已知限制。例如 `fix(capture): keep playback advancing after seek`。只有阶段门槛实际满足时才写“完成某阶段”之类的验收结论。

正常检查点应可运行且相关检查通过。中断时若必须保存尚未完成的局部进展，可在本地用 `chore(wip): ...` 明确标记，并记录失败和恢复位置；该状态不作交付，发布到远端前仍须满足必需门禁或另有明确的备份例外授权。未推送的阶段提交按[审查提交规则](#review-commits)归并修复与恢复检查点；已推送提交默认追加修复，禁止为美化历史自动强推。所有提交都带 DCO `Signed-off-by` 签名（A-43）：签名使用提交者本人的 Git 身份，表示提交者对 [DCO](https://developercertificate.org/) 的声明。本仓的 `prepare-commit-msg` hook 自动为新提交和 amend 补上提交者签名、不重复添加；未启用 hook 时用 `git commit -s` / `git commit --amend -s`。归并历史得到的阶段提交同样要带签名。已推送的未签名提交要补签只能改写历史，按改写远端历史的授权处理。GPG 签名与额外贡献许可当前不强制。

### 1.3 push、PR 与授权

推送前确认目标远端/分支、待推送提交范围及其公开内容，运行 `node scripts/verify.mjs` 与变更所需门禁，集中修复发现的问题后推送。验证必须覆盖被推送提交；未提交修复不能替提交中的旧版本提供通过证明。首次推送明确设置任务分支 upstream，后续复用；不用 `--all`、`--mirror` 或强推替代明确目标。

提交到任务分支与阶段验收分开：有明确范围且通过相关检查的原型或修复可以在本地提交供审查，即使整个里程碑未退出。2026-09-20 用户收紧远端时机（A-24）：push、创建 PR、合并只在阶段完成且用户明确表示执行相应动作后进行，A 审查收敛后可推荐。2026-10-06 起（A-53），“阶段完成”指 Agent 侧完成：必需用例与自动证据通过、A 审查收敛、没有阻塞项。人工检查与非阻塞决定不再是前提，它们在用户待办中如实保持 not-run 或当前默认，并顺延到后续阶段。不能因此直接合并未完成的 PR、标记发行或覆盖已知限制。

已授权开发任务中的常规本地分支准备、归属明确的暂存和 commit 由 Agent 连续完成，不逐命令询问；用户要求“只修改、暂不提交”时保留工作区。push、创建 PR、合并、安装 App 和发布各自遵守会话已有授权，已获授权的范围连续执行，不从“允许 push”推导“允许合并/发布”。缺少必要外部操作授权时，按[集中审批流程](development-workflow.md#continuous-execution)先完成本地成果、自审与验证，把具体操作、目标分支和范围登记为用户待办中的 ACT 项，不因等待 push/PR 暂停本地实现；下一阶段可按 1.1 第 4 条从未合并的阶段提交建立依赖分支继续。

使用 [PR 模板](../../.github/PULL_REQUEST_TEMPLATE.md)，不把每个 commit 单独开 PR。阶段完成且获明确 PR 授权后创建 PR，之后按授权集中更新同一 PR；只按新提交或实际状态变化查一次必要结果，不循环 `push → 等 CI → 小修 → push`，不通过反复推送调试可在本地复现的问题。

### 1.4 交接与阶段切换

Agent 将本轮实现交给独立审查者时，记录分支、交付 commit、未提交文件/归属、验证和证据、下一动作。审查者在同一分支集中修复，验证后将未 push 的修复 amend 回阶段提交，并提供新基点；已推送后默认追加集中修复。报告保留问题与复验依据，不为逐轮本地审查增加 commit。执行过 push 时再记录远端分支/PR，不把本地提交描述为已备份到远端。下一轮里程碑或大改造开始前，前一轮成果应已有可恢复基线。

阶段切换时，Agent 先检查上一阶段的基线是否已保存：上一阶段已合并则基于更新后的 main，尚未合并则从明确的提交继续并记录依赖；已完成的提交和建分支不重复执行。push 或上一阶段 PR 合并不是本地新阶段开工的前置，其审批可并入最终交付。不要把新的正式工程混入未提交的基线，也不要求用户再发一次“开始下一步”。

<a id="review-commits"></a>
### 1.5 审查修复与未推送提交

提交边界按阶段划分：一个阶段一个提交。谁完成、在哪一轮、改的是代码还是文档或证据，都不产生新的提交；例如同一阶段的 B 实施、B 返工、A 审查记录和用户反馈修复在 push 前是同一个提交。不同阶段在各自的分支上各有一个提交，即使都未 push 也不合并。

阶段首次实现并自检后保存一个 commit。之后的审查修复、返工、审查报告和人工反馈修复，完成修复、必要验证和暂存核对后，直接 amend 这个阶段提交，不按 finding、审查轮次或执行角色追加 commit。消息仍准确描述最终结果时使用 `git commit --amend --no-edit`；结果或范围变化时同时修订消息，移除已经失效的错误描述和临时过程记录。问题依据、修复与复验保留在相关报告中。

阶段分支上若已有多个本阶段提交（中断检查点、临时 fixup，或误按角色/轮次分开的提交），push 前先确认它们都属于本阶段且未推送，用备份分支保存本地恢复点，再用 `git reset --soft <阶段基点>` 后重新提交，或用 fixup/autosquash，把它们归并为一个阶段提交，并按最终结果重写消息。分支依赖尚未合并的前置阶段时，前置阶段的提交保持原样，只归并本阶段的提交；对前置阶段的修复回到前置阶段分支处理，不 amend 进本阶段。整理后更新交接基点；历史证据保留原被测版本的 SHA，不把整理历史写成重新测试。

amend 前核对远端引用、实际推送记录和协作状态；没有 upstream 不等于从未推送。交给另一位本地 Agent 审查本身不要求追加 commit，但改写后必须提供新基点。已推送的提交默认追加集中修复提交；main 只允许 squash 合并，合并后 main 上仍是一个阶段一个提交。改写远端历史只按明确授权执行，核对目标和预期旧 SHA，使用指定分支的 `--force-with-lease`，不得覆盖新增远端工作。减少 commit 不减少验证，也不改变 push、PR、合并或发布的授权边界。

### 1.6 本地 Git 配置

仅在本仓库设置，避免改动其他项目的 Git 行为：

```powershell
git config --local core.autocrlf false
git config --local pull.ff only
git config --local fetch.prune true
git config --local core.hooksPath .githooks
node scripts/verify.mjs
```

`.gitattributes` 负责文本行尾，`.editorconfig` 负责编辑习惯。`pre-push` 经 `scripts/pre-push.mjs` 调用同一验证入口，并把完整输出写入 `dist/evidence-runs/pre-push-*.log`（保留最近 10 份；失败时打印路径，供定位偶发失败，见 [LOOP-08](../delivery/status.md#loop-08)），不访问 GitHub API、不自动提交或格式化；`prepare-commit-msg` 只为提交消息补提交者的 DCO 签名。Git 不随 clone 自动启用自定义 hook，新工作区需要显式配置；hook 可被跳过，不能代替远端合并约束。暂存、工作树或准备推送的提交不同步时，维护者仍须确认被推送版本已验证。

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
  1. `decide`（Ubuntu，`contents: read`，不安装依赖）：运行 `node scripts/stage/release-decide.mjs`，读取最高的 `v0.1.*` 标签与 `main` 在它之后的新提交（包括 Dependabot 等任何合并进 `main` 的 PR）。没有新合并时以“本周没有新的合并”成功结束，不启动后续 Windows 构建；没有任何 `v0.1.*` 标签时发布 `0.1.1`；有新合并时算出下一个 `0.1.x` 版本号并生成中文发布说明素材。
  2. `check`（`windows-2025`，`contents: read`，**无任何 secret**）：按锁文件下载随包工具（FFmpeg、Silero VAD、字幕字体）、生成合成样本，依次运行 `node scripts/verify.mjs`、`node scripts/stage.mjs test`、`node scripts/stage.mjs package` 与 `node scripts/stage.mjs installer`（使用测试身份 `MANGA Test` / `MANGA Dev Test`）。共享运行器不跑性能基准，基准结论以本机最近一次门禁证据为准，并在 `release.json` 记录基准源码指纹与本次发布源码是否一致。任一步骤失败则停止，本周不发布。
  3. `build`（`windows-2025`，`contents: read`，绑定受保护环境 `environment: release`）：在同一提交上构建正式版安装包、生成块图 `.blockmap`、`latest.yml`、Ed25519 分离签名 `.sig`、`SHA256SUMS` 与中文 `RELEASE-NOTES.md`，并执行从上一版到当前版本的升级演练与 1 字节篡改拒绝演练（`node scripts/stage.mjs release --ci`）。环境的两个 secret（`MANGA_PLUGIN_SIGNING_KEY_PEM` 与 `MANGA_UPDATE_SIGNING_KEY_PEM`）分别只映射给打包插件和签名发布包的那一个步骤，写入运行器临时目录后交给脚本，步骤结束即在 `finally` 中删除，绝不打印或进入日志与 artifact。产物通过 `actions/upload-artifact` 上传（保留 7 天）。
  4. `publish`（Ubuntu，`contents: write`，**无 secret、不执行 `pnpm install`**，`if: inputs.dry_run != true`）：下载 artifact，运行 `node scripts/stage/release-publish-verify.mjs --publish` 用仓库内置公钥再次核对 `SHA256SUMS`、`latest.yml` 与 `.sig`，确认标签尚不存在后调用 `gh release create v0.1.x --target <SHA>` 发布正式版。
- **静态检查守护：** `scripts/check-workflows.mjs` 随 `node scripts/verify.mjs` 自动运行，静态校验 `ci.yml` 与 `release.yml` 的触发器、顶层与各 job 权限、secret 只出现在 `build` 的指定步骤、所有 Action 固定 40 位完整 SHA 且在 `.github/actions-policy.json` 允许列表中、`publish` 不含任何依赖安装命令。
- **长期不活动与失败排查：** 公开仓库连续 60 天无仓库活动时 GitHub 会自动停用定时 workflow，在 Actions 页面重新启用或手动触发一次即可恢复。如果某周定时运行失败，workflow 直接停止、不发布，不自动重跑或自动改代码；Agent 在下一阶段开工时可执行一次 `gh run list --workflow release.yml --limit 3` 查看最近一次运行状态，若失败则纳入当前阶段修复。

### 2.2 本机发布、发布授权与更新密钥轮换（A-125）

- **本机一键发布命令：** `node scripts/stage.mjs release` 在 `main` 分支、工作区干净、与 `origin/main` 同步且当前源码指纹的 `stage gate` 通过时运行，复用门禁打包产物生成 `dist/release/v0.1.x/` 下的 `manga-setup-0.1.x.exe`、`.blockmap`、`latest.yml`、`.sig`、`SHA256SUMS`、`RELEASE-NOTES.md` 与脱敏的 `release.json`，并在临时目录用测试安装身份完成升级演练与篡改拒绝演练。
- **发布授权边界：** 正式发布默认由 2.1 的每周 workflow 自动执行；本机运行 `node scripts/stage.mjs release` 默认只生成文件并完成演练，**不创建 Git 标签、不调用 `gh release create`**，并在输出与 `release.json` 的 `requiresAuthorization` 中写出需用户当次明确授权才执行的发布命令。只有在用户当次明确授权本机发布、显式传入 `MANGA_RELEASE_PUBLISH=1` 与 `--publish` 时才创建标签并上传 Release。
- **Ed25519 更新签名密钥与轮换步骤：** 正式版更新使用独立于第一方插件密钥的 Ed25519 密钥对（私钥 `dist/keys/update-release.pem` 不入库并存入 GitHub `release` 环境 secret `MANGA_UPDATE_SIGNING_KEY_PEM`，公钥 `dist/keys/update-release.pub` 内置在 `packages/app-core/src/update/signature.ts` 的 `RELEASE_UPDATE_PUBLIC_KEYS`）。需要轮换更新密钥时，必须分两步过渡，避免已安装的旧版本无法校验过渡版本：
  1. **发布过渡版本 `v0.1.N`：** 生成新密钥对，把新公钥追加到 `RELEASE_UPDATE_PUBLIC_KEYS`（同时保留旧公钥），用**旧私钥**为 `v0.1.N` 签名并发布，使已安装的旧版本能够验证并升级到同时信任新旧公钥的 `v0.1.N`；
  2. **切换新私钥并移除旧公钥：** 更新本机 `dist/keys/update-release.pem` 与 GitHub `release` 环境 secret `MANGA_UPDATE_SIGNING_KEY_PEM` 为新私钥；待用户升级到 `v0.1.N` 后（或旧私钥因泄露需立即作废时），从 `RELEASE_UPDATE_PUBLIC_KEYS` 移除旧公钥并用新私钥签发后续版本。


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

- 外部只开放 Discussions（A-123）：为避免 AI 批量生成的垃圾内容和难以处理的低质量 Issue，关闭 Issues；保留 PR 但仅协作者可创建（`pull_request_creation_policy=collaborators_only`）。文档集中在 Git 中，关闭 Wiki 和 Projects。来自 fork 的 PR 运行 workflow 前须维护者批准（所有外部贡献者）。
- 只允许 squash 合并，使用 PR 标题和正文形成提交消息；关闭自动合并，启用合并后分支删除。
- Actions 默认令牌只读，不允许 Actions 创建/批准 PR；日常验证 workflow（`ci.yml`）不包含写权限或 secrets。发布工作流（`release.yml`）仅在 `publish` job 声明 `contents: write` 用于创建 GitHub Release，两把签名私钥仅存于只允许 `main` 分支部署的 `release` 环境 secrets（`MANGA_PLUGIN_SIGNING_KEY_PEM`、`MANGA_UPDATE_SIGNING_KEY_PEM`），不設仓库级全局 secret。
- 保持 Secret scanning 和 Push protection 开启。忽略规则只是减少误提交，仍需人工核对暂存区；若秘密已经泄露，优先撤销或轮换凭据。
- 使用 GitHub 私密漏洞报告作为安全入口，处理范围见 [SECURITY.md](../../SECURITY.md)。不编造邮箱、支持时限或不存在的发行版本。
- 项目许可证已确认为 [Apache-2.0](../../LICENSE)；额外贡献权利安排、发布签名和安装包发布方式仍见 [Q-09](../../USER-ACTIONS.md#q-09)。不擅自变更已确认许可；提交的 DCO 签名按第 1.2 节执行。

维护者在 Settings 中调整配置后，应同步相应 JSON、规则正本和验证记录。通过 API 更新时，先读取当前值，只提交差异；请求串行执行，变更请求之间至少间隔一秒，出错停止而非盲目重放。完成后一轮核对即可，不安排定时巡检或自动纠偏。

## 5. Bot 与低频操作

依赖更新策略由 [决定记录](../decisions/0002-local-first-github.md)维护。[dependabot.yml](../../.github/dependabot.yml)当前仅配置 GitHub 原生 Dependabot 的 Actions 依赖更新。A-36 已要求补充应用依赖更新与后续 bot 路线，路线如下表，npm/pnpm workspace、独立原型锁与其他有实际用途的检查先在本地准备；本次仍为计划，未启用新的远端自动化。

每月把 Actions 更新合为一组、最多一个未关闭 PR、关闭自动 rebase，由维护者择时评审与合并；不启用自动合并。版本更新 PR 数量上限不约束安全更新，安全警报与自动安全修复是不同设置，不能声称“上限 1”覆盖所有安全 PR。本期自动安全修复 PR 保持关闭，安全告警按维护需要人工处理。

自动 AI review、DCO、设计/模板检查等按 A-36 路线逐项核对当前远端状态和接入前提；不因参考配置存在就宣称本仓已安装或生效。接入前写清用途、权限、触发事件和最大消息量；stale、欢迎评论和自动标签目前无明确需求，不默认启用，不重复 GitHub 原生已有能力。

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
