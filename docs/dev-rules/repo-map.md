# 仓库地图与环境事实

核对日期：2026-11-11。本文区分真实文件与目标结构。

## 当前存在

| 位置 | 职责 |
| --- | --- |
| 根 README / AGENTS / CONTRIBUTING / DESIGN / REVIEW | 产品、开发、设计与评审入口；CLAUDE 引用 AGENTS |
| `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `tsconfig.json` | pnpm 11 hoisted workspace；Node 24.19；TypeScript 7（`erasableSyntaxOnly`：不用 enum、命名空间与参数属性） |
| `packages/contracts` | 公开 DTO、命令输入/错误、定位、媒体/元数据/录音契约、模块 schema（Zod 4） |
| `packages/plugin-sdk` | 模块激活接口 |
| `packages/kernel` | 自研组合运行时（ADR-0005） |
| `packages/storage-drizzle` | better-sqlite3 + Drizzle + FTS5 产品存储与迁移 |
| `packages/i18n` | 中文消息键、伪本地化、日期数字 |
| `packages/model-protocol` | OpenAI Responses/Chat/转录适配、视觉输入与本地 mock |
| `packages/app-core` | UI 与 Agent 共用的产品应用服务（命令注册按领域在 `src/commands/`：`access`、`agent`、`agent-run`、`connections`、`creative`、`inventory`、`library`、`library-io`、`media`、`notes`、`settings`、`voice`，`product-app.ts` 只负责装配，由命令注册快照守护）：资料库/阅读/进度/笔记/Agent，以及独立子入口 `light/`（`index.ts`、`service.ts`、`positions.ts`、`image-size.ts`：供 `--manga-light` 复用的无数据库轻量视频与漫画服务）、`version.ts`（版本号计算与 `build.json`）、`update/`（`service.ts` 正式版更新状态机、块图差分下载与上一版安装包留存、`signature.ts` Ed25519 分离签名校验）、`comic/`（扫描、页面、ComicInfo）、`media/`（FFmpeg、句柄与自定义协议、任务队列、缩略图、zip 池）、`video/`（探测、字幕/音轨、帧索引、播放副本与 `play-copy-store.ts`）、`metadata/`（Bangumi、本地文件元数据、封面、多来源、`ref.ts` 链接/ID 解析、`images.ts` 图片表）、`library-scan/`（资源库路径扫描：`walker.ts` 在 worker 遍历、`plan.ts` 比对计划、`service.ts` 调度/进度/取消）、`ops/`（操作日志、记录列表、使用记录、会话消息流、调试脱敏）、`quick-tasks.ts`（快捷任务模板）、`voice/`（录音会话、人声筛选、转录、整理、位置映射）、`creative/`（项目、白板、导图、互嵌、文稿、材料搜寻、粗剪及项目包）、`semantic/`（语义索引与检索）、`plugins/`（插件包、信任、独立进程运行）、`acquisition/`（获取任务、发布与入库）、`net/`（网络代理：只放行 http/https，每跳重定向检查私网） |
| `apps/desktop` | React + Vite + Electron Forge Windows 宿主：`assets/`（应用图标 `icon.svg`、`icon.png`、多尺寸 `icon.ico`），三主入口配置（`vite.bootstrap.config.ts` → `main.cjs`、`vite.main.config.ts` → `full-main.cjs`、`vite.light.config.ts` → `light-main.cjs` 及 `vite.light-renderer.config.ts` → `light_window`），`src/main`（极薄路由入口 `bootstrap.ts`、启动失败守卫与回退 `launch-guard.ts`、`launch-paths.ts`、轻量退出握手 `light-runtime.ts`、轻量主进程 `light/main.ts` 与 `light/smoke.ts`、完整主进程窗口与权限、`overlay.ts` 紧凑录音悬浮框、`updater.ts` 的 `NsisUpdater` 校验接入、自定义媒体协议、解析 worker、`bundled-assets.ts`、仅测试用的 `smoke/`，按检查内容分文件：`agent`、`reading-loop`、`formats`、`media`、`voice`、`window-walk`、`creative-walk`、`plugins-walk`、`trace-walk`、`update-walk`、`player-menus-walk`、`danmaku-walk`、`rework-walk`、`bench-window`、`bench-canvas`、`bench-reader`），`danmaku-credentials.ts` 与构建注入 `danmaku-define.ts` 只在主进程里给弹幕签名，`plugin-process.ts` 把插件作为 Electron utility process 启动，`src/preload`（完整桥与 `preload-light.ts` 窄桥），`src/light`（轻量视频播放器与漫画阅读器前端），`src/renderer`（`shell.tsx` 与 `lib/shell-model.ts` 的壳与导航、`hooks/use-update.ts` 更新状态、`components/chat/` 右栏聊天窗口、`pages/` 的书架/作品主页/调试面板/导入与匹配、`pages/settings/` 的独立设置各页（含 `update-page.tsx`）、阅读器与播放器、`voice/` 录音界面、按领域拆分的样式） |
| `tests/` | 按能力分目录：`acquisition`、`agent`、`comic`、`contracts`、`creative`、`library`、`media`、`metadata`、`net`、`notes`、`package`、`plugins`、`reading`、`runtime`、`samples`、`semantic`、`shell`、`update`、`video`、`voice`、`real`（默认关闭的真实服务/本机资源）；`helpers/`、`fixtures/` 为共享件。不按阶段或审查轮次命名 |
| `plugins/` | 随应用的第一方插件源码（`acquisition-bt`：BitTorrent 获取引擎，含构建时替换原生库的桩）；`scripts/pack-plugin.mjs` 构建并用第一方私钥签名到 `dist/plugins`，打包时随包放进 `resources/plugins` |
| `docs/modules/` | 内置模块规格（agent、library、notes、settings、inventory、comic、video、metadata、voice、projects、whiteboard、mindmap、embeds、copywriting、research、semantic、roughcut、plugins、acquisition） |
| `docs/product/`、`docs/design/` | 需求和详细设计评审稿 |
| `docs/product-rules/`、`docs/dev-rules/`、`docs/design-rules/` | 按任务触发的持续约束 |
| `docs/governance/`、`docs/decisions/` | 文档登记、治理和决定 |
| `docs/delivery/`、`docs/evidence/gate/`、`docs/templates/` | 当前阶段计划、报告与状态；最近一次阶段门禁的最终证据；模板 |
| `scripts/verify.mjs` | 统一入口：语法、文档、工具锁引用形态、公开内容、依赖方向与轻量边界、类型、全部 Vitest、`git diff --check` |
| `scripts/stage.mjs`、`scripts/stage/` | 阶段门禁与发布入口：`gate`/`test`/`bench`/`package`/`installer`/`install-dev`/`release`/`report`（含 `version-lib.mjs`、`installer-lib.mjs`、`install-dev.mjs`、`light-open.mjs`、`rollback-rehearsal.mjs`、`release.mjs`、`release-decide.mjs`、`release-publish-verify.mjs`）；当前阶段取自登记表的 `currentStage`，门禁定义在 `scripts/stage/gate.json`（按输入分组的指纹与每份结果依赖哪些组、必需用例、基准目标、包烟测阶段与窗口场景） |
| `scripts/check-docs.mjs`、`check-deps.mjs`、`check-publication.mjs`、`check-workflows.mjs` 及其 `.test.mjs` | 文档与登记、包依赖方向与轻量入口闭包、公开内容检查及反例、GitHub Actions 工作流安全检查；`stage-report.test.mjs` 为阶段报告门禁反例 |
| `scripts/samples/` | 合成样本生成：媒体（`generate-media-samples.mjs`，输出 `dist/samples/media`）、阅读样本（`build-reading-samples.py`）与扫描页 PDF（`build-scan-pdf-sample.py`，需要本机 Python 与 PDF 库） |
| `scripts/tools/` | 随包工具的下载、锁定与链接预检（月末保留标签的 FFmpeg LGPL 构建、40 位提交 SHA 的 Silero VAD 模型与字幕字体及其哈希，`check-tool-links.mjs`） |
| `scripts/desktop-assets.ts`、`desktop-paths.ts`、`dev-desktop.mjs`、`verify-electron-sqlite.mjs` | 打包资产暂存、生成物路径（正本）、开发启动、Electron SQLite ABI 校验 |
| `scripts/inventory-deps.mjs`、`generate-bangumi-types.mjs`、`live-models.mjs`、`pack-plugin.mjs`、`desktop-plugins.ts` | 依赖盘点、Bangumi OpenAPI 类型再生、模型有限真实短测、插件构建与签名 |
| `.node-version` | CI 与本地 Node 版本 |
| `.github/workflows/ci.yml`、`release.yml` | `ci.yml` 为 PR/手动检查（job 名 `repository-quality`）；`release.yml` 为每周一 00:00 UTC 定时与手动触发的正式版构建、演练与发布（`decide` → `check` → `build` → `publish`） |
| `.github/rulesets/`、`.github/*settings.json`、`.github/actions-policy.json`、`dependabot.yml` | 可审阅的远端期望配置 |
| `.githooks/pre-push`、`.githooks/prepare-commit-msg`、`.gitattributes`、`.gitignore`、`.editorconfig` | 本地验证提醒、提交 DCO 签名与文本规范 |
| `.gitbook.yaml`、`docs/SUMMARY.md` | GitBook 准备配置 |
| `SECURITY.md` | 私密安全报告说明 |

产品目录 `apps/desktop` 是共用宿主；`packages` 是业务源码，`plugins` 是随应用的插件源码，都不是生成目录。不按里程碑复制一套原型目录，测试、脚本与模块按能力命名而不是阶段命名。

### 生成物约定

| 位置 | 内容与生命周期 |
| --- | --- |
| `dist/desktop/native` | 与 Electron 版本/架构匹配的 native binding 和下载 staging；不覆盖 Node 测试 binding |
| `dist/desktop/packages` | 当前未签名桌面包；最新指针 `dist/desktop/latest-package.json` 带源码指纹 |
| `dist/desktop/installer` | `stage package` 用 electron-builder 做出的本通道按用户安装包（未签名，不发布） |
| `dist/desktop/development` | `pnpm dev --isolated` 的开发 Profile、文档、下载与指针；不带 `--isolated` 时开发版用 `%LOCALAPPDATA%\manga-dev` 等自己的位置。两种都不访问正式版的数据 |
| `dist/release/v0.1.x` | `node scripts/stage.mjs release` 生成的正式版发布包、块图 `.blockmap`、`latest.yml`、Ed25519 分离签名 `.sig`、`SHA256SUMS`、`RELEASE-NOTES.md` 与 `release.json` |
| `dist/plugins` | 构建并签名的随包插件 `.manga-plugin`；打包时复制到 `resources/plugins` |
| `dist/samples/media` | 合成媒体/阅读/录音样本与清单；人工复测和包烟测使用，不提交私人收藏或真实资料 |
| `dist/tools` | 锁定版本的随包工具缓存（FFmpeg、Silero）与类型再生工作区；缺失时打包明确失败 |
| `dist/evidence-runs/<跑次>` | 阶段测试、基准、打包、报告、推送前钩子日志与实机截图的输出；被 Git 忽略，只把最终结果复制进 `docs/evidence/gate/` |
| `apps/desktop/.vite` | Forge/Vite 工具管理的编译缓存；保留其约定，不是业务数据 |
| OS 临时目录中的 `manga-*` | 自动化合成夹具与故障子进程数据；每次独立，不提交 |
| `docs/evidence/gate/` | 最近一次阶段门禁的经脱敏、可审阅的 JSON/截图（≤ 5 MiB）；下一阶段的门禁覆盖它 |

签名密钥不在仓库里：第一方插件签名私钥 `%APPDATA%\manga-release\plugin-signing.key`（公钥在 `packages/app-core/src/plugins/trust.ts`），正式版更新签名私钥 `%APPDATA%\manga-release\update-signing.key`（公钥 `update-signing.pub` 内置在 `packages/app-core/src/update/signature.ts`）；须自行备份（见[用户待办](../../USER-ACTIONS.md)）。

路径计算正本为 `scripts/desktop-paths.ts`。生成目录在 Git 忽略范围内；包含 Profile 的目录不是可随意自动删除的缓存。开发机本地的界面参考图放在 `dist/design-refs`，不进入仓库，文字正本见[交互设计 3.4](../design/interaction-and-workflows.md#34-三媒介界面2026-10-03-参考)。

更新与发布脚本的职责：`scripts/stage/update-rehearsal.mjs` 驱动真实 Test 桌面、上游下载、NSIS 安装与重启；`release-previous.mjs` 下载、验证并提取上一版原发布包；`release-publish-verify.mjs` 独立核对完整发布清单后才允许发布。

## 可运行命令

前置：Node.js 24.19+，仓库根 `pnpm install`。测试数据默认在 OS 临时目录。

| 命令 | 状态 | 作用 |
| --- | --- | --- |
| `pnpm install` | 可用 | 按锁文件安装 workspace |
| `pnpm dev` | Windows 可用 | 检查 Electron SQLite ABI 后以独立开发 Profile 启动；无须手工 rebuild；媒体功能需要 `dist/tools` 中的随包工具 |
| `node scripts/verify.mjs` | 可用 | 统一入口，范围见[质量门禁](quality-gates.md) |
| `node scripts/stage.mjs gate` | Windows 可用 | 整套门禁：verify（不跑测试）→ test → package → installer → bench → package 补到连续 3 次 → report，第一个失败就停，结果仍有效的步骤不重跑，每步用时写进 `gate-run.json`（`scripts/stage/gate.mjs`） |
| `node scripts/stage.mjs test` | 可用 | 全部 Vitest + 脚本自测，按必需用例匹配写入跑次目录 |
| `node scripts/stage.mjs bench` | 可用 | 10k 元数据 / 50k 块的服务与隐藏 Electron 窗口基准，另含 5000 文件后台扫描、200 封面读取与 1000 条消息停靠栏的打包窗口测量（`scripts/stage/bench-scan-pane.mjs`，需先有打包产物），再加语义检索（1 万片）、粗剪导出开销、本机回环 BT 下载 200 MB（`bench-creative.mjs`、`bench-bt.mjs`）与白板/导图交互（`bench-canvas.mjs`，隐藏窗口），5000 条消息的对话（打包窗口的 `bench-chat` 阶段）与任务媒体（60 s 片段、4 MB 图像、v13 迁移与 500 MB 升级复制，`bench-agent-media.mjs`），保留原始样本 |
| `node scripts/stage.mjs package` | Windows 可用 | Forge 未签名包及打包烟测（含媒体、录音、`window-walk`、创作工作区 `creative` 与插件下载 `plugins` 阶段，以及长对话与任务媒体 `loop`、旧版凭据 `credentials-async`、schema v13 迁移 `migrate-v13`、数据位置 `data-locations-*` 并写 `scenarios.json`；再用 electron-builder 做出本通道的按用户安装包（不签名）。需先生成合成样本与旧版凭据 Profile（`scripts/samples/build-legacy-credentials.mjs`），并有第一方私钥来签随包插件） |
| `node scripts/stage.mjs installer` | Windows 可用 | 把打好的包做成两个通道的测试身份安装包（`MANGA Test` / `MANGA Dev Test`），真实安装到临时目录、启动、做 `0.1.1` → `0.1.2` 覆盖升级演练、卸载，并核对本机真实安装的快照前后完全一致（`scripts/stage/installer.mjs`） |
| `node scripts/stage.mjs install-dev` | Windows 可用 | 若本机装了开发版（`MANGA Dev`），请运行中的开发版保存并退出（`--quit-for-update`），用刚打出的开发版安装包静默更新并重新打开，写 `install-dev.json`；绝不碰正式版，`MANGA_DEV_AUTO_INSTALL=0` 或 CI 上跳过 |
| `node scripts/stage.mjs release` | Windows 可用 | 在门禁通过的干净 `main` 上打包正式版、签发 `.sig`、生成 `latest.yml` / `.blockmap` / `SHA256SUMS` / `RELEASE-NOTES.md` 并完成升级演练，输出到 `dist/release/v0.1.x/`；无当次发布授权时不创建标签或调用 `gh release create` |
| `node scripts/stage.mjs report` | 可用 | 核对必需文件/用例/指纹（每份结果只比它依赖的组）/基准/包（连续通过次数）/安装；缺项或失败非零退出，不计算产品验收 |
| `node scripts/samples/generate-media-samples.mjs` | 可用 | 生成合成漫画/视频/字幕/录音样本到 `dist/samples/media` |
| `node scripts/tools/fetch-ffmpeg.mjs`、`fetch-silero-vad.mjs`、`fetch-subtitle-font.mjs` | 需网络 | 按锁文件下载并校验随包工具 |
| `node scripts/inventory-deps.mjs` | 需网络 | 依赖版本盘点（npm 与锁文件） |
| `node scripts/pack-plugin.mjs [目录] [--out 目录]` | 需第一方私钥 | 构建 `plugins/` 下的插件并签名到 `dist/plugins`；私钥取自 `MANGA_PLUGIN_SIGNING_KEY` 或 `%APPDATA%\manga-release\plugin-signing.key`，不输出私钥 |
| `node scripts/check-docs.mjs`、`check-deps.mjs`、`check-publication.mjs` | 可用 | 文档/依赖方向/公开内容，含反例自测 |

真实服务与本机资源的开关见[质量门禁 2.1](quality-gates.md#21-真实服务与本机资源默认关闭不进-ci)。原生输入法的受影响路径与真实声学需要人工，尚未实现的校准/设备恢复由开发者先补齐，不要求用户代替工程验证。

## 目标代码归属

[总体架构](../design/architecture.md#3-monorepo-组织)是分层入口，[组合方案第 11 节](../design/composable-ai-native-architecture.md#11-工程结构与约束)细化新增责任，以下只用于选址。

| 目标路径 | 应放置的内容 |
| --- | --- |
| `apps/desktop/` | Electron 产品宿主；最小独立宿主（`apps/reader-host/`）到需要时再建 |
| `packages/contracts`、`plugin-sdk` | 公共 DTO、版本、schema 与插件接口 |
| `packages/kernel` | 运行时契约；正式生产只保留一个实现 |
| `packages/app-core` | 按能力分目录的产品服务；UI 与 Agent 共用同一服务 |
| `modules/`、`providers/` | 按需建立；元数据来源在 `packages/app-core/src/metadata` 通过提供者接口接入 |

按场景建立实际需要的包，不提前生成所有空目录。

## 建立工程时登记

Electron、TypeScript、monorepo 为已确认方向；Windows 11 x64 为首发基线。UI、编辑、SQLite 驱动及对应工程基础已按 [ADR-0007](../decisions/0007-technology-stack.md) 选定，当前实际目录/依赖按上表，产品验收另行记录。数据位置按 A-118 分两个根（应用数据在 `%LOCALAPPDATA%\manga`，用户文件在系统登记的“文档”下的 `manga`，下载在“下载”下的 `manga`；开发版各用 `-dev` 后缀，所有路径统一用小写的 `manga`），全部生成位置可配置、通道隔离，启动定位在 `packages/app-core/src/locations.ts`。组合运行时、写入宿主与媒体后端的技术定稿见[用户待办](../../USER-ACTIONS.md)与 [ADR-0007](../decisions/0007-technology-stack.md)。密钥示例用占位值，实际依赖由锁文件维护。
