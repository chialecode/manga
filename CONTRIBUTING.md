# MANGA 开发与贡献指南

MANGA 当前处于需求、设计与 M0 准备阶段。先读 [AGENTS.md](AGENTS.md) 和 [文档导航](docs/README.md)，再按任务进入专题。首次定位项目请查 [仓库地图](docs/dev-rules/repo-map.md)。

## 完成一次变更

1. 明确用户场景和对应需求编号；小型修复直接使用任务说明，跨模块或公共契约调整按 [开发流程](docs/dev-rules/development-workflow.md)补充方案。
2. 阅读受影响规则、设计、代码与测试。产品范围依据 [确认与待决事项](docs/decisions/open-questions.md)，不将评审稿中的每个细节当作用户已经批准。
3. 实现并同步受影响的需求、接口、迁移、交互和验收映射；记录重要决策，避免重复维护正本。
4. 按 [质量门禁](docs/dev-rules/quality-gates.md)完成验证，按 [REVIEW.md](REVIEW.md)检查最终变更。
5. 按 [审查提交规则](docs/dev-rules/git-and-github.md#review-commits)，不同交付分别提交，同一交付尚未 push 的审查修复 amend 原提交；已推送提交默认追加修复。推送前运行 `node scripts/verify.mjs`，集中推送可评审进展；使用 [变更交付模板](.github/PULL_REQUEST_TEMPLATE.md)说明结果和真实验证状态。

## 环境与命令

目前没有应用 `package.json`、锁文件或启动命令，不能执行猜测的 `pnpm dev`、应用构建或单测。使用 `.node-version` 指定的 Node.js，治理验证不需要安装第三方依赖，从根目录运行 `node scripts/verify.mjs`；单独检查文档可运行 `node scripts/check-docs.mjs`，检查范围见 [质量门禁](docs/dev-rules/quality-gates.md)。

建立应用工程时，将实际 Node.js/pnpm/框架版本、安装、启动、测试、打包步骤及验证平台写入仓库地图，并与真实脚本保持一致。

## 协作与发布

采用任务分支与 PR、squash 合并、0 个强制外部审批的单人维护流程。初始化后的 main 变更必须满足 [Git 与 GitHub 协作规则](docs/dev-rules/git-and-github.md)；该页也说明首次 clone 的本地 hook 配置、CI 触发与低频操作。不要覆盖他人修改或重写无关历史。提交、推送、PR、合并与发布按用户和宿主已授权范围执行。

项目许可证、对外贡献协议和发布签名尚未确定，见 [待决事项](docs/decisions/open-questions.md#q-09)。正式接收外部代码贡献或分发应用前明确相应信息；本地设计和开发可以继续。安全问题通过 [私密漏洞报告](SECURITY.md)提交。
