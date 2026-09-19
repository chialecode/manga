# 仓库地图与环境事实

核对日期：2026-09-19。本文区分真实文件与目标结构，建立源码后必须更新。

## 当前存在

| 位置 | 职责 |
| --- | --- |
| 根 README / AGENTS / CONTRIBUTING / DESIGN / REVIEW | 产品、开发、设计与评审入口；CLAUDE 引用 AGENTS |
| `docs/product/`、`docs/design/` | 原有需求和详细设计评审稿 |
| `docs/product-rules/`、`docs/dev-rules/`、`docs/design-rules/` | 按任务触发的持续约束 |
| `docs/governance/`、`docs/decisions/` | 文档登记、治理和决定 |
| `docs/delivery/`、`docs/evidence/`、`docs/templates/` | 计划、当前状态、验证记录与模板 |
| `scripts/check-docs.mjs` | 无第三方依赖的文档校验 |
| `scripts/verify.mjs`、`.node-version` | 本地与 CI 共用的离线治理验证入口及 Node 版本 |
| `.github/workflows/ci.yml` | PR 与手动检查工作流，稳定 job 为 repository-quality |
| `.github/rulesets/`、`.github/*settings.json`、`.github/actions-policy.json` | 可审阅的远端期望配置；文件本身不自动修改 GitHub |
| `.github/PULL_REQUEST_TEMPLATE.md`、`.github/ISSUE_TEMPLATE/`、`.github/CODEOWNERS` | 交付、问题模板和责任归属 |
| `.githooks/pre-push`、`.gitattributes`、`.gitignore`、`.editorconfig` | 本地验证提醒、文本规范与忽略规则 |
| `.gitbook.yaml`、`docs/SUMMARY.md` | GitBook 内容配置与目录；尚未连接 Space 或发布 |
| `SECURITY.md` | 私密安全报告说明 |

截至本次核对，Git 历史与 [远端仓库](https://github.com/chialecode/manga)已建立，文件包含文档、治理工具与 GitHub 配置；仍没有应用源码、应用依赖清单、锁文件、安装包或数据库。远端实际执行与验证见 [建立报告](../evidence/2026-09-19-github-bootstrap.md)，操作正本见 [Git 与 GitHub](git-and-github.md)。

这些是核对时的项目状态。未来任务重新检查目录和 Git 状态，不依据本文假设它们永远不变。

## 目标代码归属

[总体架构](../design/architecture.md#3-monorepo-组织)是分层入口，[组合方案第 11 节](../design/composable-ai-native-architecture.md#11-工程结构与约束)细化新增责任，以下只用于选址。

| 目标路径（尚未建立） | 应放置的内容 |
| --- | --- |
| `apps/desktop/`、`apps/reader-host/` | Electron 产品宿主、最小独立宿主验证 |
| `packages/contracts-*`、`plugin-sdk` | 公共 DTO、版本、schema 与插件接口 |
| `packages/composition`、`kernel` | 组合计划；运行时契约及最终选定的单一生产实现 |
| `packages/platform-electron`、`storage-sqlite`、`ui` | 平台、持久化与通用界面基础 |
| `modules/` | 资源、引用、格式/阅读、记录、创作、Agent 等领域与应用服务 |
| `providers/` | 模型、元数据、获取源、传输等可替换实现 |
| `bundles/`、`profiles/` | 组合默认值和宿主装配方案 |

按场景建立实际需要的包，不提前生成所有空目录；小型契约可以先用一个包的公开子入口。模块私有目录不是跨模块 API。

## 建立工程时登记

Electron、TypeScript、monorepo 为已确认方向；Windows 11 x64 为首发基线。pnpm、UI 框架、SQLite 驱动和组合运行时的具体选择仍见 [决定台账](../decisions/open-questions.md)。

首次加入可运行工程时，本页补充：精确 Node.js/包管理器版本、安装与锁文件规则、环境变量示例、开发入口、相关测试、类型检查、打包、数据目录和故障排查。只有实际创建并运行过的命令才标可用。密钥示例用占位值，依赖由实际清单与锁文件维护，文档不保存第二份完整版本表。
