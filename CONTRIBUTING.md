# MANGA 开发与贡献指南

MANGA 当前处于需求、设计与 M0 验证阶段。先读 [AGENTS.md](AGENTS.md) 和 [文档导航](docs/README.md)，再按任务进入专题。首次定位项目请查 [仓库地图](docs/dev-rules/repo-map.md)。

## 完成一次变更

1. 明确用户场景和对应需求编号；小型修复直接使用任务说明，跨模块或公共契约调整按 [开发流程](docs/dev-rules/development-workflow.md)补充方案。
2. 阅读受影响规则、设计、代码与测试。产品范围依据 [确认与待决事项](docs/decisions/open-questions.md)，不将评审稿中的每个细节当作用户已经批准。
3. 实现并同步受影响的需求、接口、迁移、交互和验收映射；记录重要决策，避免重复维护正本。
4. 按 [质量门禁](docs/dev-rules/quality-gates.md)完成验证，按 [REVIEW.md](REVIEW.md)检查最终变更。
5. 按 [Git 工作节奏](docs/dev-rules/git-and-github.md#1-本地优先与工作节奏)，同一里程碑/明确子阶段使用一个分支，Agent 首次完整交付一个 commit，同一交付未 push 的审查修复 amend 原提交，消息描述最终结果；不同里程碑或独立交付分别提交，已推送提交默认追加修复。中间提交只按恢复需要建立；审查收敛且统一验证通过后，在有效授权内集中 push。使用 [变更交付模板](.github/PULL_REQUEST_TEMPLATE.md)说明结果和真实验证状态。

本项目采用[连续执行、集中审批](docs/dev-rules/development-workflow.md#continuous-execution)。本地实现、检查、修复和必要 Git 准备由 Agent 连续处理，不在工作包之间等待“继续”；非阻塞决定、外部操作授权和人工配置统一随可审阅成果交付，真正阻塞的问题只暂停依赖部分。

默认分工是 [A 制定计划 → B 执行交付 → A 集中审查](docs/dev-rules/development-workflow.md#agent-handoff)，交接使用仓库计划、Git 版本和[统一信息模板](docs/templates/agent-handoff.md)。A 直接修复可确定的局部问题，需要 B 的较大返工一次性给完整差异清单，不反复转述聊天或逐问题来回交接。

## 环境与命令

前置：使用 `.node-version` 指定的 Node.js 24.19+，在仓库根执行 `pnpm install`。没有发行安装包。开发宿主：`pnpm --filter @manga/desktop start`。

| 命令 | 作用 |
| --- | --- |
| `node scripts/verify.mjs` | 文档、公开内容、依赖方向、类型检查、M1a Vitest 及必要回归 |
| `node scripts/m1a.mjs test` | M1a 自动测试 |
| `node scripts/m1a.mjs package` | Windows 未签名本地包与烟测 |
| `node scripts/m1a.mjs bench` | 新栈服务侧检索/保存抽样 |
| `pnpm --filter @manga/desktop start` | 启动 M1a Electron 宿主（开发） |
| `node scripts/verify-m0.mjs` | 本机可自动的完整 M0 验证 |
| `node scripts/check-docs.mjs` | 仅文档检查 |
| `node scripts/check-publication.mjs` | 工作树与暂存内容的路径、凭据和私有文件检查 |
| `node scripts/m0.mjs desktop` | 人工窗口；缺 electron 时在 `experiments/m0-desktop` 单独安装 |

详细入口与阻塞项见 [仓库地图](docs/dev-rules/repo-map.md)、[质量门禁](docs/dev-rules/quality-gates.md)。

## 协作与发布

采用任务分支与 PR、squash 合并、0 个强制外部审批的单人维护流程。初始化后的 main 变更必须满足 [Git 与 GitHub 协作规则](docs/dev-rules/git-and-github.md)；该页也说明首次 clone 的本地 hook 配置、CI 触发与低频操作。不要覆盖他人修改或重写无关历史。提交、推送、PR、合并与发布按用户和宿主已授权范围执行。

项目采用 [Apache-2.0](LICENSE)。提交贡献须具有相应权利；是否额外采用贡献协议、产品签名及分发方式见 [待决事项](docs/decisions/open-questions.md#q-09)。第三方依赖按其许可证保留必要声明，项目许可证不改变依赖义务。安全问题通过 [私密漏洞报告](SECURITY.md)提交。
