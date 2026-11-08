# MANGA

<p align="center">
  <strong>读、看、记、写，在同一个工作区里接着做。</strong><br />
  面向小说、漫画与动漫的本地桌面工作台，内置可审计的 AI Agent。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2011%20x64-lightgrey.svg" alt="Platform: Windows 11 x64" />
  <img src="https://img.shields.io/badge/status-开发中-orange.svg" alt="Status: 开发中" />
</p>

<p align="center">
  <a href="docs/delivery/status.md">执行状态</a> ·
  <a href="docs/README.md">文档导航</a> ·
  <a href="https://github.com/chialecode/manga/discussions">反馈与讨论</a> ·
  <a href="CONTRIBUTING.md">参与开发</a> ·
  <a href="SECURITY.md">安全报告</a>
</p>

MANGA 取自 **Manga、Anime、Novel、Game、Agent**。它把阅读观看、随手记录、素材整理和辅助创作放进同一个工作区：项目和“最近”各有自己的标签页、分屏、对话与阅读进度，可以一边看原作一边写。阅读器、播放器、笔记、白板、思维导图和创作工具共享稳定的内容引用，内置 Agent 通过结构化上下文和与界面相同的业务命令参与工作。

> [!NOTE]
> **开发中，尚无正式发行版。** 下面列出的能力已经在 `main` 上实现，并通过了自动化测试与打包窗口观察；人工检查与产品验收尚未完成。首版只面向**本地单用户、Windows 11 x64**，基础功能不需要登录。各项能力的验证状态与已知限制见[执行状态](docs/delivery/status.md)。

## 能做什么

- **读小说与漫画**：TXT、EPUB、MOBI、PDF 与图片目录、CBZ；翻页或滚动、目录、查找与书签、双页与方向、以指针为中心缩放；框选区域可以直接引用到对话里或存为截图。
- **看动漫**：原生播放加 FFmpeg 探测与重封装；ASS 特效字幕与按国标版式排的文本字幕、双语与次字幕；逐帧与关键帧操作；弹幕匹配、过滤与偏移。
- **随手记录**：笔记、录音与转写，每条记录都能回到原作的页码或时间点；剧透保护按已读位置生效。
- **资源库与元数据**：资源库位置后台扫描，按作品整理；Bangumi 元数据手动匹配、差异预览与字段锁定；文件移走后用户内容保留，再出现时自动重新关联。
- **创作**：项目、白板、思维导图、文稿及其版本与建议，彼此可以互嵌；无转码粗剪（关键帧对齐、导出前说明实际切点）；可选的本地语义检索。
- **内置 Agent**：自带模型密钥（BYOK），两套运行时可切换；按项目范围读取上下文；删除、重命名、导出、粗剪编辑这类操作只由 Agent 提出，在对话里经你确认后才执行。
- **插件与获取**：签名插件包、独立进程运行；随应用提供可选的 BitTorrent 获取插件，下载后校验并入库。

## 快速开始

需要 Windows 11 x64、Node.js 24.19+ 和 [`package.json`](package.json) 锁定版本的 pnpm。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 会自动准备并校验 Electron 所需的 SQLite 原生模块，以开发版运行：数据放在开发版自己的位置（`%LOCALAPPDATA%\manga-dev`，以及“文档”和“下载”里的 `manga-dev`），与正式版 `manga` 分开；`pnpm dev --isolated` 则把数据全部放在 `dist/desktop/development` 下。首次准备要下载依赖，失败时停止并显示原因；不要手动替换 `node_modules` 里的原生文件来回切环境。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发版桌面应用 |
| `node scripts/verify.mjs` | 离线统一检查：文档与公开内容、依赖边界、类型检查、未使用代码、Vitest；开发者、pre-push hook 与 CI 共用 |
| `node scripts/stage.mjs gate` | 阶段门禁：依次运行测试、打包烟测、安装包、性能基准与报告，跳过结果仍有效的步骤 |

打包输出在 `dist/desktop/packages`，构建资产与缓存都是生成物。环境要求与检查边界见[质量门禁](docs/dev-rules/quality-gates.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | Electron 宿主：主进程、渲染层界面与打包烟测 |
| `packages/*` | 共用业务包：契约、应用核心、组合运行时、存储、模型协议、插件 SDK、多语言文案 |
| `plugins/*` | 随应用的第一方插件源码（BitTorrent 获取） |
| `scripts/` | 检查、阶段门禁、样本生成与开发启动脚本 |
| `tests/` | 按能力组织的 Vitest 用例 |
| `docs/` | 产品、设计、规则、决策、交付与证据 |

各目录的职责与依赖方向见[仓库地图](docs/dev-rules/repo-map.md)。

## 技术栈

Electron 45、React 19、TypeScript 7、Vite、Tailwind CSS 与 Radix UI、dockview（标签页与分屏）、Tiptap / CodeMirror、SQLite（better-sqlite3 + Drizzle ORM，FTS5，可选 sqlite-vec）、Zod 4、PDF.js、FFmpeg（LGPL）+ JASSUB、Vitest。选型理由与使用边界见 [ADR-0007](docs/decisions/0007-technology-stack.md)，当前版本见[执行状态](docs/delivery/status.md)。

## 设计原则

1. Agent 原生接入各模块的状态与能力；用户界面和 Agent 共用业务服务。
2. 所有业务功能按模块提供，可以不安装、启用、停用和替换；能力依赖与组合配置支持拆分为独立应用。
3. 阅读位置、笔记、素材和创作结果之间有稳定、可追溯的关联。
4. 基础阅读、播放、编辑和数据管理本地可用，AI 按配置接入。
5. 业务模型、阅读交互、格式解析与引用逻辑由项目掌握，通用基础优先组合成熟的开源方案并经适配器接入。
6. 设计问题从模型和边界修正；架构调整同时提供已有用户数据的迁移路径。
7. 外部动漫数据库按来源与字段策略组合，本地作品身份独立于网站；下载通过可选的获取源、传输和导入能力接入。

## 文档

| 想了解 | 入口 |
| --- | --- |
| 全部文档与决策状态 | [文档导航](docs/README.md) |
| 产品需求与验收 | [产品需求](docs/product/requirements.md)、[交付与验收计划](docs/delivery/roadmap-and-acceptance.md) |
| 架构与数据 | [总体架构](docs/design/architecture.md)、[可组合与 AI-Native 架构](docs/design/composable-ai-native-architecture.md)、[领域模型](docs/design/domain-model.md) |
| Agent 与插件 | [Agent、上下文与插件协议](docs/design/agent-and-plugins.md)、[外部数据源与下载扩展](docs/design/external-providers-and-acquisition.md) |
| 界面 | [界面与工作流](docs/design/interaction-and-workflows.md)、[设计规则](DESIGN.md) |
| 进度 | [执行状态](docs/delivery/status.md)、[当前阶段计划](docs/delivery/stage-plan.md)、[已确认的决定](docs/decisions/confirmed-decisions.md) |

## 参与开发

- **维护者：**需要你做的事（人工检查、待决定、授权与外部配置）只记在 [USER-ACTIONS.md](USER-ACTIONS.md)。
- **AI Agent 与程序员：**先读 [AGENTS.md](AGENTS.md)，再按任务读取相关规则；入门见 [CONTRIBUTING.md](CONTRIBUTING.md)，评审口径见 [REVIEW.md](REVIEW.md)。
- **协作方式：**一个阶段一个分支、一个提交、一个 PR；本地验证优先，PR 只用 squash 合并，所有提交带 DCO 签名。详见 [Git 与 GitHub](docs/dev-rules/git-and-github.md)。
- **文档规则：**权威文档、生命周期与变更流程见[文档治理](docs/governance/documentation-policy.md)。
- **反馈：**缺陷、建议和使用问题请在 [Discussions](https://github.com/chialecode/manga/discussions) 提出。为避免 AI 批量生成的垃圾内容和难以处理的低质量 Issue，仓库关闭了 Issues，PR 只接受协作者创建。

## 安全与许可证

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开披露可利用细节、真实密钥或私人内容。

项目采用 [Apache License 2.0](LICENSE)。随包的 FFmpeg（LGPL）、JASSUB、Silero VAD 等第三方组件按各自许可证附带声明，项目许可证不改变它们的义务。
