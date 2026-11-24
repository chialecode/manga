# MANGA 开发与贡献指南

MANGA 已有可运行的桌面应用与每周发布的正式版，产品验收尚未完成。先读 [AGENTS.md](AGENTS.md) 和[文档导航](docs/README.md)，再按任务进入专题。首次定位项目请查[仓库地图](docs/dev-rules/repo-map.md)。

## 完成一次变更

1. 在 [Issues](https://github.com/chialecode/manga/issues) 找到或新建对应 issue，明确用户场景和需求编号；跨模块或公共契约调整先在 issue 里写清方案（[开发流程](docs/dev-rules/development-workflow.md)）。
2. 阅读受影响规则、设计、代码与测试。产品范围依据[已确认决定](docs/decisions/confirmed-decisions.md)与需求正本；仍待用户决定的事项是带 `needs-user` 标签的 issue，不将评审稿中的每个细节当作用户已经批准。
3. 从最新 `main` 切分支 `<type>/<issue号>-<简短描述>`，实现并同步受影响的需求、接口、迁移、交互和验收映射。
4. 按[质量门禁](docs/dev-rules/quality-gates.md)用 `node scripts/quick-gate.mjs` 验证；发布前以及改到打包、安装、更新、签名或发布链路时跑整套 `node scripts/stage.mjs gate`。
5. 提交用 Conventional Commits，每个提交带 DCO `Signed-off-by`（按 [Git 规则](docs/dev-rules/git-and-github.md#local-git)启用的 hook 会自动补上，未启用时用 `git commit -s`）。push 后按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)建 PR，写明结果和真实验证状态。
6. CI `repository-quality` 通过、非作者独立审查（[REVIEW.md](REVIEW.md)）无阻塞项后，低风险 PR squash 合并；碰到[高风险清单](docs/dev-rules/development-workflow.md#high-risk)的加 `risk:high`，由维护者合并。

## 环境与命令

前置：使用 `.node-version` 指定的 Node.js 24.19+，在仓库根执行 `pnpm install`。开发宿主：`pnpm dev`。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 以独立开发 Profile 启动 Electron 宿主 |
| `node scripts/quick-gate.mjs` | 日常快速门禁（约 5 分钟内）：`verify --skip-tests`、与改动相关的测试、点名的打包烟测阶段 |
| `node scripts/verify.mjs` | 脚本语法、文档、公开内容、依赖方向、类型检查、全部 Vitest 及必要回归（`pre-push` 与 CI 共用） |
| `node scripts/stage.mjs gate` | 整套门禁：测试、打包烟测、安装演练、性能基准与报告 |
| `node scripts/stage.mjs package` / `install-dev` | 做出开发版安装包；在本机静默更新 `MANGA Dev` |
| `node scripts/check-docs.mjs` | 仅文档检查 |
| `node scripts/check-publication.mjs` | 工作树与暂存内容的路径、凭据和私有文件检查 |

详细入口见[仓库地图](docs/dev-rules/repo-map.md)、[质量门禁](docs/dev-rules/quality-gates.md)。

## 协作与发布

采用 issue 驱动、任务分支与 PR、squash 合并、0 个强制外部审批的单人维护流程；`main` 的规则、CI 触发、本地 hook 配置与低频操作见 [Git 与 GitHub 协作规则](docs/dev-rules/git-and-github.md)。不要覆盖他人修改或重写无关历史。正式版由每周发布工作流构建、签名并发布。

只有协作者能建 issue 和 PR。外部反馈、缺陷和建议请使用 [Discussions](https://github.com/chialecode/manga/discussions)，有价值的由维护者整理成 issue。

项目采用 [Apache-2.0](LICENSE)。提交贡献须具有相应权利；是否额外采用贡献协议、产品签名及分发方式见 [#48](https://github.com/chialecode/manga/issues/48)。第三方依赖按其许可证保留必要声明，项目许可证不改变依赖义务。安全问题通过[私密漏洞报告](SECURITY.md)提交。
