# Docs 规范索引

本索引用于发现 `docs/` 下的架构正本、开发规则、产品规则与路线图。

**状态含义**：`authoritative` = 权威，对相应模块有约束力；`参考` = 设计 / 记录 / spike，非约束；`generated` = 由脚本生成，不手改。

| 文档 | 类型 | 状态 | 治理/相关代码 |
|---|---|---|---|
| [README.md](./README.md) | 索引 | — | `docs/` 文档目录 |
| [architecture.md](./architecture.md) | 架构正本 | authoritative | 技术栈、进程拓扑、信任边界、数据模型、依赖清单、合规义务 |
| [roadmap/phase-1.md](./roadmap/phase-1.md) | 路线图 | authoritative（已验收） | 第一阶段的里程碑、交付物与验收标准 |
| [roadmap/phase-2.md](./roadmap/phase-2.md) | 路线图 | authoritative | 第二阶段（高风险验证）的里程碑、交付物与验收标准 |
| [dev-rules/README.md](./dev-rules/README.md) | 开发规则索引 | authoritative | 工程规则总入口 |
| [dev-rules/dependency-admission.md](./dev-rules/dependency-admission.md) | 依赖准入 | authoritative | 任何新增第三方依赖 |
| [dev-rules/repo-map.md](./dev-rules/repo-map.md) | 仓库地图 | authoritative | 新代码归属判断、模块定位 |
| [dev-rules/naming-and-identifiers.md](./dev-rules/naming-and-identifiers.md) | 命名与标识符 | authoritative | 应用名、appId、目录、协议、开发版/正式版隔离 |
| [dev-rules/environment-setup.md](./dev-rules/environment-setup.md) | 开发环境 | authoritative | 首次安装、镜像、`vendor-bin`、native 重编 |
| [dev-rules/architecture-invariants.md](./dev-rules/architecture-invariants.md) | 架构不变量 | authoritative | 依赖方向、`domain` 纯度、进程拓扑 |
| [dev-rules/electron-security-and-process-boundaries.md](./dev-rules/electron-security-and-process-boundaries.md) | Electron 安全规则 | authoritative | Renderer、preload、CSP、Fuses、自定义协议、路径解析 |
| [dev-rules/ipc-contract.md](./dev-rules/ipc-contract.md) | IPC 契约规则 | authoritative | RPC 方法、流式、取消、背压、错误模型 |
| [dev-rules/database-and-migrations.md](./dev-rules/database-and-migrations.md) | 数据库规则 | authoritative | schema、migration、FTS、备份恢复、并发 |
| [dev-rules/engineering-conventions.md](./dev-rules/engineering-conventions.md) | 通用工程规范 | authoritative | 日志、错误、时间单位、i18n、命名 |
| [dev-rules/testing-and-gates.md](./dev-rules/testing-and-gates.md) | 测试与门禁 | authoritative | 测试分层、CI 闸门、性能基准 |
| [product-rules/README.md](./product-rules/README.md) | 产品规则索引 | authoritative | 产品行为与边界总入口 |
| [product-rules/core-product-principles.md](./product-rules/core-product-principles.md) | 产品原则 | authoritative | 本地优先、证据模型、AI 边界、外部能力边界、删除语义 |
| [design-rules/app-shell.md](./design-rules/app-shell.md) | 应用外壳契约 | authoritative | 三栏布局、已打开资源模型、面板注册、主题与字体令牌 |
| adr/ | 决策记录 | authoritative | 每条架构决策的背景、决定、后果与重估触发条件 |

## 计划中的文档

以下文档在对应阶段建立，现在不存在。**不要引用尚未建立的文档。**

| 文档 | 建立阶段 |
|---|---|
| `design-rules/DESIGN.md` | 阶段 3（视觉正本：精确色值、组件规格、间距细则。结构契约已在 `design-rules/app-shell.md` 定稿） |
| `dev-rules/media-storage-and-protocols.md` | 阶段 4（漫画内核，缓存与回收策略成型） |
| `dev-rules/reader-kernels.md` | 阶段 5（EPUB 内核） |
| `dev-rules/playback-and-media-pipeline.md` | 阶段 6（视频内核） |
| `dev-rules/ai-provider-and-tooling.md` | 阶段 8（AI 层） |
| `dev-rules/packaging-and-release.md` | 阶段 10（发布工程） |
| `legal/notices/` | 由 `pnpm licenses:generate` 生成 |
