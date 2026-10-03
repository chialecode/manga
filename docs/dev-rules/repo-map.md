# 仓库地图与环境事实

核对日期：2026-09-23。本文区分真实文件与目标结构。

## 当前存在

| 位置 | 职责 |
| --- | --- |
| 根 README / AGENTS / CONTRIBUTING / DESIGN / REVIEW | 产品、开发、设计与评审入口；CLAUDE 引用 AGENTS |
| `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `tsconfig.json` | M0 验证 monorepo；当前包管理锁定 pnpm 11.24.0；Node 24.19.0 |
| `packages/contracts` | 公开 DTO、命令/错误/定位/模块 schema |
| `packages/plugin-sdk` | 模块激活接口 |
| `packages/kernel` | 已定稿的自研组合运行时（ADR-0005）；产品验收另行记录 |
| `packages/storage-sqlite` | `node:sqlite` 单写入适配器（M0 实验候选，保留回归） |
| `packages/storage-drizzle` | better-sqlite3 + Drizzle + FTS5 产品存储 |
| `packages/i18n` | 中文消息键、测试语言、日期数字 |
| `packages/model-protocol` | OpenAI Responses/Chat/转录适配与本地 mock |
| `packages/app-core` | UI 与 Agent 共用的产品应用服务 |
| `apps/desktop` | React + Vite + Electron Forge Windows 宿主 |
| `docs/modules/` | M1a 内置模块规格 |
| `experiments/m0` | POC 领域、应用服务、样本、测试与 Node 宿主 |
| `experiments/m0-desktop` | Electron 人工窗口；不进入 CI 依赖 |
| `docs/product/`、`docs/design/` | 需求和详细设计评审稿 |
| `docs/product-rules/`、`docs/dev-rules/`、`docs/design-rules/` | 按任务触发的持续约束 |
| `docs/governance/`、`docs/decisions/` | 文档登记、治理和决定 |
| `docs/delivery/`、`docs/evidence/`、`docs/templates/` | 计划、当前状态、验证记录与模板 |
| `scripts/check-docs.mjs` | 无第三方依赖的文档校验 |
| `scripts/check-deps.mjs` | 包依赖方向；内置反例自测 |
| `scripts/m0-report.mjs` / `m0-report.test.mjs` / `m0-required-cases.json` | 原型必需证据/指纹/包与性能检查及反例；不计算产品验收 |
| `scripts/m1a-report.mjs` / `m1a-report.test.mjs` / `m1a-required-cases.json` | M1a 必需证据/指纹/10k·50k 规模与包烟测检查及反例；不计算产品验收 |
| `scripts/m1b.mjs`、`scripts/verify-m1b.mjs`、`scripts/m1b-report.mjs` | M1b 阅读/笔记测试、性能、Windows 包与指纹报告；不计算产品验收 |
| `scripts/review-m1b-ui.mjs`、`scripts/review-m1b-reading.mjs` | 打包后真实窗口的合成 UI 复核：A 的局部修复，以及 B 的阅读→记录→来源、书签、冻结材料、会话与包决策；原生对话框被桩替换，不使用真实资料 |
| `scripts/audit-m1b-recheck.mjs`、`scripts/review-m1b-recheck.mjs` | A 独立服务/格式及真窗反例；失败非零退出；只用合成样本和隔离 Profile |
| `scripts/audit-m1b-b6-review.mjs`、`scripts/review-m1b-b6-ui.mjs` | A 本轮混合导入来源、资源列表完整可达性反例，以及首版界面/动画演示隔离复核；失败保留，正式 H 不自动通过 |
| `apps/desktop/src/renderer/animation-demo.tsx`、`brand.tsx`、`assets/` | A-37 共享壳品牌与静帧演示；无真实视频导入、字幕解析或模型调用，演示笔记只在内存中 |
| `scripts/build-m1b-review-samples.py` | 用 ReportLab/Pillow/zipfile 生成独立 PDF/EPUB 合成样本与工具版本/哈希清单；日常审计可复用已提交样本 |
| `scripts/m0.mjs`、`scripts/verify-m0.mjs`、`scripts/verify.mjs` | M0 命令、完整自动验证、治理+类型+契约/修复回归门禁 |
| `.node-version` | CI 与本地 Node 版本 |
| `.github/workflows/ci.yml` | PR/手动检查，job 名 `repository-quality`；Corepack pnpm 安装锁文件后跑 verify |
| `.github/rulesets/`、`.github/*settings.json`、`.github/actions-policy.json` | 可审阅的远端期望配置 |
| `.githooks/pre-push`、`.githooks/prepare-commit-msg`、`.gitattributes`、`.gitignore`、`.editorconfig` | 本地验证提醒、提交 DCO 签名与文本规范 |
| `.gitbook.yaml`、`docs/SUMMARY.md` | GitBook 准备配置 |
| `SECURITY.md` | 私密安全报告说明 |

产品目录 `apps/desktop` 是 M1a/M1b 共用宿主；`packages` 是业务源码，`experiments/m0` 与 `experiments/m0-desktop` 是需保留回归的 M0 原型源码，不是生成目录。不按里程碑复制一套 `experiments/m1`。

### 生成物约定

| 位置 | 内容与生命周期 |
| --- | --- |
| `dist/desktop/native` | 与 Electron 版本/架构匹配的 native binding 和下载 staging；不覆盖 Node 测试 binding |
| `dist/desktop/packages` | 当前未签名桌面包；M1a/M1b 打包共用入口，最新指针 `dist/desktop/latest-package.json` 带源码指纹 |
| `dist/desktop/development` | `pnpm dev` 的开发 Profile、运行日志和指针；不会访问正式 Profile |
| `dist/desktop/samples` | 本地人工复测使用的合成导入样本；不提交私人收藏或真实资料 |
| `dist/desktop/review-runs` | A 的 Electron 合成审查运行目录，逐跑次独立 |
| `apps/desktop/.vite` | Forge/Vite 工具管理的编译缓存；保留其约定，不是业务数据 |
| OS 临时目录中的 `manga-m0-*` / `manga-m1a-*` / `manga-m1b-*` | 自动化合成夹具与故障子进程数据；每次独立，不提交 |
| `docs/evidence/<阶段>/<跑次>` | 经脱敏、可审阅的 JSON/截图/结论；源码变化选新跑次，不覆盖历史 |

路径计算正本为 `scripts/desktop-paths.ts`。旧 `dist/m1a-package`、`dist/m1a-native` 和历史 M0 产物不搬动、不删除，不再作为新产品命令的默认输出。生成目录在 Git 忽略范围内；包含 Profile 的目录不是可随意自动删除的缓存。

## 可运行命令

前置：Node.js 24.19+，仓库根 `pnpm install`。测试数据默认在 OS 临时目录 `manga-m0/`，可用 `MANGA_M0_DIR` 覆盖。

| 命令 | 状态 | 作用 |
| --- | --- | --- |
| `pnpm install` | 可用 | 按锁文件安装 workspace |
| `pnpm dev` | Windows 可用 | 检查 Electron SQLite ABI 后以独立开发 Profile 启动；无须手工 rebuild |
| `node scripts/verify.mjs` | 可用 | 文档治理 + 依赖方向 + 类型检查 + M1a/M1b Vitest + 契约/修复回归 |
| `node scripts/m1b.mjs test` | 可用 | M1b 阅读、笔记、壳与大文件场景；写 `M1B_EVIDENCE_DIR` |
| `node scripts/m1b.mjs bench` | 可用 | 10k 元数据 / 50k 块服务与同规模隐藏 Electron 窗口，含大书末段、后台解析及保存；DOM 可用计时，不代替绘制帧/实机验收 |
| `node scripts/m1b.mjs package` | Windows 可用 | 生成 `dist/desktop/packages` 的本地包，并增加阅读页烟测 |
| `node scripts/audit-m1b-b5-review.mjs` | 可用；最新 A 跑次通过 | PDF Unicode 与资料包 skip 依赖图独立审计；需设置新 `M1B_EVIDENCE_DIR` |
| `node scripts/audit-m1b-b6-review.mjs` | 可用；当前三项通过 | 混合策略不得改写被跳过笔记的来源、不得删除来源关系，以及第 101 条资源可达性 |
| `node scripts/review-m1b-b6-ui.mjs` | Windows 包可用；5 组通过 | 观测者/造物主、静帧和临时笔记、无真实业务写入、响应布局与原页面入口 |
| `node scripts/review-m1b-b5-h-checks.mjs` | Windows 包可用 | H-01/H-03/H-04 自动子集、Unicode 摘录/重启、内容缩放与键盘；正式人工项仍单列 |
| `node scripts/audit-m1b-b7-rework.mjs` | 可用；5 项通过 | B 对前轮混合策略、页面模型及 101 条访问的自检 |
| `node scripts/audit-m1b-a-b7-review.mjs`、`node scripts/review-m1b-a-b7-ui.mjs` | 可用；8.18 独立复跑通过，8.16 失败保留历史 | A 补查实际排版、作者样式、显式依赖矩阵与搜索续页；先跑前者生成合成 PDF，后者使用同源码 Windows 包；新证据目录不覆盖历史 |
| `node scripts/review-m1b-a-b8.mjs` | 可用；8.18 为 7 passed / 7 failed，真实退出 1 | 同源码包上的字体宽度/水平缩放、包外与复制引用依赖、完整来源链/索引/历史、明确拒绝和椭圆几何；同时含服务与窗口检查，先打包，设置新证据目录；已纳入报告门禁 |
| `node scripts/m1a.mjs test` | 可用 | M1a Vitest（授权、存储、协议、界面服务） |
| `node scripts/verify-m1a.mjs` | 可用 | 运行 M1a 测试；证据齐全时核验报告门禁 |
| `node scripts/m1a.mjs package` | Windows 可用 | Electron Forge 本地包与启动烟测 |
| `node scripts/m1a.mjs bench` | 可用 | 新栈服务检索/保存抽样；不宣称 10,000 元数据全集 |
| `node scripts/m0.mjs doctor` | 可用 | 工具与环境探测 |
| `node scripts/m0.mjs fixtures` | 可用 | 生成合成样本 |
| `node scripts/m0.mjs typecheck` | 可用 | 类型检查 |
| `node scripts/m0.mjs test` | 可用 | POC 自动测试（串行） |
| `node scripts/m0.mjs report` | 可用 | 核对 `M0_EVIDENCE_DIR` 的必需文件/用例、包、性能和当前源码指纹；缺项/失败非零退出 |
| `node scripts/verify-m0.mjs` | 可用 | 环境/依赖/类型/样本/全部 Node 场景与报告；包与性能须先单独运行；不判定里程碑退出 |
| `node scripts/m0.mjs desktop` | 缺则在 `experiments/m0-desktop` 安装 electron | 打开人工窗口 |
| `node scripts/m0.mjs bench` | 可用 | 当前参考机检索、输入状态、进程启动、自动保存实测；保留原始数据 |
| `node scripts/m0.mjs package` | Windows 可用 | 自带 Node/Electron 的本地解包原型；独立环境双启动烟测 |
| `node scripts/check-deps.mjs` | 可用 | 含反例自测 |

Windows 打包和基准独立运行；以同一个 `M0_EVIDENCE_DIR` 先运行 package、再 bench、最后 verify-m0，具体见[质量门禁](quality-gates.md)。该变量覆盖所有结果路径；未设置仍兼容默认 `docs/evidence/m0-closure/`，新版本应指定新目录保留历史。本轮完整证据在 `docs/evidence/m0-final-review/`。真实跨卷由 `M0_VOL_A` / `M0_VOL_B` 指定已授权目录后随测试运行。

已有包用 `scripts/open-m0-package.ps1` 打开；该脚本读取 `dist/latest-package.json`。原生输入法的受影响路径与真实声学需要人工，尚未实现的校准/设备恢复由开发者先补齐，不要求用户代替工程验证。当前 UI/回放和资料包边界见[最终复核](../evidence/2026-09-19-m0-closure-review.md)。

## 目标代码归属

[总体架构](../design/architecture.md#3-monorepo-组织)是分层入口，[组合方案第 11 节](../design/composable-ai-native-architecture.md#11-工程结构与约束)细化新增责任，以下只用于选址。

| 目标路径 | 应放置的内容 |
| --- | --- |
| `apps/desktop/`、`apps/reader-host/` | Electron 产品宿主、最小独立宿主（产品阶段；M0 用 experiments 验证） |
| `packages/contracts`、`plugin-sdk` | 公共 DTO、版本、schema 与插件接口 |
| `packages/kernel` | 运行时契约的自研候选；正式生产只保留一个实现 |
| `packages/storage-sqlite` | 持久化接口的 SQLite 实现 |
| `modules/` | 资源、引用、格式/阅读、记录等（产品阶段再建） |
| `providers/` | 可替换实现（M0 假源在 experiments） |

按场景建立实际需要的包，不提前生成所有空目录。

## 建立工程时登记

Electron、TypeScript、monorepo 为已确认方向；Windows 11 x64 为首发基线。UI、编辑、SQLite 驱动及对应工程基础已按 [ADR-0007](../decisions/0007-technology-stack.md)选定，当前实际目录/依赖按上表，React/Forge 与产品存储已经接入，产品验收另行记录。数据默认 Documents、全部生成位置可配置与通道隔离已确认；需要验证的是实现和启动定位机制。组合运行时、写入宿主与媒体后端的技术定稿见[决定台账](../decisions/open-questions.md)。密钥示例用占位值，实际依赖由锁文件维护。
