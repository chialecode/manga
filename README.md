# MANGA

MANGA 取自 **Manga、Anime、Novel、Game、Agent**，是一个以 TypeScript 和 Electron 构建、采用 monorepo 管理的二次元桌面工作台。

> 围绕二次元内容，让阅读观看、随手记录、素材整理和辅助创作形成连续的工作流。

应用提供爱好者与创作者两种工作区模式。阅读器、播放器、笔记、白板、思维导图和创作工具共享稳定的内容引用，内置 Agent 通过结构化上下文和统一业务能力参与工作。

## 当前阶段

仓库已完成文档治理，并建立 **M0 验证工程**（`packages/`、`experiments/m0`）。这不是产品发行版：没有用户安装包，产品 AT 均未执行。文档描述目标行为，不能把原型证据写成产品验收通过。

首版已确认采用**本地单用户、基础功能无需登录、Windows 11 x64**，其他桌面系统后续独立验收。自动化证据与退出判断见 [M0 汇总](docs/evidence/2026-09-19-m0-summary.md)，推进状态见 [执行台账](docs/delivery/status.md)。

## 开发与文档入口

- AI Agent 与程序员先读 [AGENTS.md](AGENTS.md)，按任务触发相关规则。
- 人类开发入门见 [CONTRIBUTING.md](CONTRIBUTING.md)，代码评审见 [REVIEW.md](REVIEW.md)，界面开发见 [DESIGN.md](DESIGN.md)。
- 文档权威、生命周期和变更流程见 [文档治理](docs/governance/documentation-policy.md)；确认与假设见 [决定台账](docs/decisions/open-questions.md)。
- 本地执行 `node scripts/verify.mjs`（文档 + 依赖方向 + 类型检查）。完整 M0 自动验证：`node scripts/verify-m0.mjs`。环境和检查边界见 [质量门禁](docs/dev-rules/quality-gates.md)。
- 仓库为 [chialecode/manga](https://github.com/chialecode/manga)，采用本地验证优先、必要 PR CI 为辅；分支保护、低频协作与 GitBook 准备见 [Git 与 GitHub](docs/dev-rules/git-and-github.md)，安全报告见 [SECURITY.md](SECURITY.md)。

## 产品与设计文档

- [文档导航与决策状态](docs/README.md)
- [可组合、可拆卸与 AI-Native 架构方案](docs/design/composable-ai-native-architecture.md)
- [外部动漫数据库与下载扩展](docs/design/external-providers-and-acquisition.md)
- [产品需求文档](docs/product/requirements.md)
- [总体架构设计](docs/design/architecture.md)
- [领域模型与数据设计](docs/design/domain-model.md)
- [Agent、上下文与插件协议](docs/design/agent-and-plugins.md)
- [界面与工作流设计](docs/design/interaction-and-workflows.md)
- [交付阶段与验收计划](docs/delivery/roadmap-and-acceptance.md)

## 已确认的设计原则

1. Agent 原生接入各模块的状态与能力；用户界面和 Agent 共用业务服务。
2. 所有业务功能按模块提供，可以不安装、启用、停用和替换；能力依赖与组合配置支持拆分为独立应用。
3. 阅读位置、笔记、素材和创作结果具有稳定、可追溯的关联。
4. 基础阅读、播放、编辑和数据管理本地可用，AI 按配置接入。
5. 业务模型、阅读交互、格式解析与引用逻辑优先自主实现，必要的底层技术通过适配器使用。
6. 设计问题从模型和边界修正；架构重构同时提供已有用户数据的迁移路径。
7. 外部动漫数据库按来源与字段策略组合，本地作品身份独立于网站；下载通过可选的获取源、传输和导入能力接入。

组合架构方案定义功能中心、依赖绑定、插件生命周期、多源资料和下载恢复。M0 使用统一契约和场景验证运行时候选，按可靠性与维护成本选择一个生产实现；职责与验证要求见[组合方案第 2 节](docs/design/composable-ai-native-architecture.md#2-组合运行时的职责与验证)。

实现前先完成文档中的技术验证与范围锁定，再按完整工作流分阶段交付。

项目采用 [Apache License 2.0](LICENSE)。已确认的 M1 顺序为 Agent 与基础配置优先；当前仍是 M0 验证工程，正式功能进度见 [执行状态](docs/delivery/status.md)。
