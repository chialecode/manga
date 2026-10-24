# 阶段交付报告：体验与代码整理

日期：2026-10-29 至 2026-11-03。角色：B 实施与自检，A 集中审查（第 10 节）。计划见[当前阶段计划](stage-plan.md)；本报告按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射。产品验收保持 not-run；人工检查 H-71—H-79 与需重测的 H-58、H-62、H-67、H-68 在[用户待办](../../USER-ACTIONS.md#checks)。

<a id="cleanup"></a>
## 1. 阶段开始的整理（C0）

- 登记表 `currentStage` 改为 `m5`，计划的 `retireAfter` 改为 `m5`；上一阶段的报告删除（仍有效的内容已在执行状态、ADR-0007、用户待办与确认记录里；原文见[归档](https://github.com/chialecode/manga/blob/b3b468b/docs/delivery/stage-report.md)），本报告在同一路径新建。
- 文档检查报出的以前阶段的标签逐个改写：ADR-0007 的三处、执行状态的两处、`tests/shell/sidebar-ui.test.tsx` 的问题编号；`scripts/check-docs.test.mjs` 的样例按新的当前阶段更新，断言数不变（11 个）。
- 不入库的文件：删除 `dist/evidence-runs/l1-combining-marks` 与构建缓存 `apps/desktop/.vite/`；其余按计划 5.1 的表保留。阶段末又删除了迭代走查用的临时包目录 `dist/gate-package/`。
- 交互设计、设计规则、领域模型、需求与路线图里本阶段的“待实现”说明按实现改写为现行行为；路线图 §2.2 仍描述当前阶段，合并后由下一阶段的整理处理。

<a id="deps"></a>
## 2. 依赖盘点（D1）

2026-11-03 按 A-35 与 ADR-0007 的复查条件重查 `pnpm outdated -r`：

| 依赖 | 现用 | 可用 | 处理 |
| --- | --- | --- | --- |
| `@tanstack/react-virtual` | 3.14.21 | 3.14.22（10-22）、3.14.23（10-26）、3.14.24（10-29） | 都未满 14 天的观察期，不升级 |
| `linkedom` | 0.18.13 | 0.18.14（10-21） | 未满 14 天，不升级 |
| tiptap 3.32.2、mdast-util-to-markdown 2.2.1、@napi-rs/canvas 1.1.0、dockview-react 8.8.3、knip 6.44.1、lucide-react 1.66.0、onnxruntime-web 1.31.1、electron 45.2.1、@types/node 26 | — | 有新版 | 主版本或行为变化需要单独评估，留给下一次依赖循环（与 pi-ai 1.x、LOOP-05/07/09/17 一起规划） |

新增：`knip` 6.41.0（开发依赖，见第 6.3 节）。删除的依赖见第 6.3 节。`packages/app-core` 显式声明它直接导入的 `zod`（此前靠传递依赖）。

<a id="mapping"></a>
## 3. 工作包映射

| 包 | 需求 / 验收 | 实现位置 | 验证证据 | 状态与限制 |
| --- | --- | --- | --- | --- |
| W1 视图与主区联动 | UI-07、UI-08；AT-130 | `packages/contracts/src/workspace-state.ts`（version 2 与 version 1 的转换）、`apps/desktop/src/renderer/workspace/{controller,host,layout,openers,placement,empty-view}.ts(x)` | `tests/shell/workspace-controller.test.ts`（AT-130）、窗口观察 `view-main-linkage`、`workspace-restart`、`legacy-tabs-dropped` | 已实现。路线见第 4 节 |
| W2 侧栏的行与分组 | UI-09；AT-123、AT-124 | `packages/app-core/src/sidebar-service.ts`（混排分页、计数与可打开同口径）、`apps/desktop/src/renderer/sidebar.tsx`、`sidebar-data.ts`、`styles-workspace.css` | `tests/library/sidebar-activity.test.ts`、`tests/shell/sidebar-ui.test.tsx`、`tests/shell/sidebar-tokens.test.ts`；窗口观察 `sidebar-home-list`、`sidebar-counts` | 已实现 |
| W3 拖动收起 | UI-01；AT-125 | `apps/desktop/src/renderer/shell.tsx`、`rail.tsx`、`styles-frame.css` | `tests/shell/window-frame.test.tsx`、`tests/shell/rail-ui.test.tsx`；窗口观察 `sidebar-drag-collapse` | 已实现；走查发现并修复了第 8 节的 3 项 |
| W4 媒介视图的封面 | LIB-01；AT-124、AT-126 | `sidebar.tsx` 的封面网格、`packages/contracts/src/sidebar.ts` 的新字段、`works-service.ts` | `tests/shell/sidebar-ui.test.tsx`；窗口观察 `media-view-covers`；基准 `coversShown` | 已实现 |
| W5 图标栏 | UI-01；AT-132 | `rail.tsx`、`shell-state` 外壳偏好、`styles-frame.css` | `tests/shell/rail-ui.test.tsx`、`tests/shell/rail-layout.test.ts`；窗口观察 `rail-reorder`、`menu-hover` | 已实现 |
| W6 对话自动命名 | AGENT-04；AT-127 | `packages/app-core/src/conversations.ts`（`autoTitle`）、`commands/agent.ts` | `tests/creative/conversations.test.ts`（AT-127）；窗口观察 `conversation-auto-title` | 已实现 |
| W7 工作区的小修与隐藏层 | UI-08、NFR-02、CRE-02；AT-128、AT-131 | `workspace/host.tsx`（`data-hidden-layer`）、`controller.ts`（重新打开回原位、关窗前保存）、`search-box.tsx` | `tests/shell/state-retention.test.tsx`、`tests/library/search-scope.test.ts`；窗口观察 `hidden-layers`、`tab-reopen-place`、`quit-saves-layout`、`close-saves-layout`（真的关窗，第 10 节） | 已实现；方法见第 5 节 |
| W8 Agent 的空范围 | AGENT-06；AT-129 | `packages/app-core/src/agent-scope.ts`、`agent-materials.ts` | `tests/agent/empty-scope.test.ts`（两个 runtime） | 已实现 |
| W9 代码整理 | NFR-05 | `packages/app-core/src/commands/*`、`product-helpers.ts`、`knip.json`、`tests/helpers/global-temp.ts` | `tests/runtime/command-registry.test.ts` 与快照；`verify` 的 knip 一步；`stage test` 的临时目录计数 | 已实现；见第 6 节 |
| W10 走查、测试与基准 | — | `apps/desktop/src/main/smoke/*`、`scripts/stage/*` | 第 7、9 节 | 已实现 |
| W11 文档 | — | 交互设计、设计规则、领域模型、需求、路线图、质量门禁、仓库地图、执行状态、用户待办 | 文档检查 | 已实现 |
| W12 播放器 | READ-03、NOTE-05；AT-133、AT-134、AT-135 | `readers/danmaku-layer.tsx`、`danmaku-model.ts`、`screenshot-capture.ts`、`video-keys.ts`、`use-video-playback.ts`、`video-player.tsx` | `tests/danmaku/*`、`tests/reading/video-keys.test.ts`、`video-player.test.tsx`、`subtitle-capture.test.ts`；窗口观察 `danmaku-window-top`、`hold-rate-hint-only`、`hold-rate-recovers` | 已实现；按住路径的复现见第 7 节 |
| W13 外壳与资源库 | UI-01、LIB-01、LIB-02、LIB-03；AT-136、AT-137、AT-138 | `library-locations.ts`、`library-outside.ts`、`works-service.ts`、`library-scan/service.ts`、`pages/settings/outside-section.tsx`、`pages/unassigned-group.tsx` | `tests/library/in-library.test.ts`、`library-scan.test.ts`、`unassigned-recover.test.ts`、`tests/shell/library-outside-ui.test.tsx`；窗口观察 `shell-corner`、`library-in-locations`、`scan-incremental` | 已实现 |
| W14 小说按页阅读 | READ-01、READ-04；AT-139、AT-140 | `reader/{pages,page-offsets,use-pager,side-panel,settings-panel}.ts(x)`、`reading.tsx`、`hooks/use-novel.ts` | `tests/reading/novel-pages.test.tsx`、`reader-layout.test.tsx`；窗口观察 `novel-paginate`、`novel-side-panel`；基准 `novelTurn`、`novelRefont`、`novelOpen` | 已实现；基准发现并修复了第 8 节的阅读位置缺陷 |

<a id="route"></a>
## 4. 视图布局的路线

试验了两条路线（2026-10-24 查证，ADR-0007）：一个 dockview 实例在切换视图时 `fromJSON` 换布局；每个上下文里每个视图一个 dockview 实例。前者切换视图要拆掉并重建全部面板，阅读器与播放器随之重新挂载（视频重新载入、`currentTime` 不连续）。定为后者：沿用 dockview-react 8.6.1，只有当前视图的实例可见，其余挂着、用统一隐藏层藏起；布局各自用 `toJSON` / `fromJSON` 存进工作区状态 version 2。阅读器与编辑器挂在按标签编号的宿主里，一个标签同时出现在主页与它的功能视图时是同一个实例，换视图时只移动宿主节点，不重建。version 1 的状态在读取时转换（`workspace-state.ts`），去掉的标签类型被丢弃（`legacy-tabs-dropped`）。

<a id="hidden-layer"></a>
## 5. 隐藏层

所有“不在眼前”的部分用一个属性：`[data-hidden-layer], [data-hidden-layer] * { visibility: hidden !important }`，外加 `[data-hidden-layer] { pointer-events: none }`（`styles-frame.css`）。设置视图打开时的工作区、视图里不在前面的标签槽（`TabSlot` 在 dockview 告知不可见时立即加上）、不在当前视图的 dockview 实例与标签停车区都用它。白板与导图的节点自己设 `visibility` 也会被 `!important` 盖住，所以不再透出（AT-131，窗口观察 `hidden-layers` 用命中测试与取色验证）。

用 `visibility` 而不是 `display: none` 是为了让阅读器、播放器和画布在后面保留布局与状态；代价是后面的阅读器仍然有布局盒子。本阶段的基准因此发现了第 8 节第 9、10 项：分页器现在由标签的可见状态（`env.visible`）决定是否排版与报告位置，不再依赖有没有盒子。

<a id="cleanup-code"></a>
## 6. 代码整理（W9）

### 6.1 命令注册快照与拆分

先提交快照 `tests/runtime/command-registry.snapshot.json`（激活全部模块的应用里每个命令的模块、编号，以及是否在 `OWNER_COMMANDS`、`AGENT_COMMANDS`、`NOTE_CONTENT_COMMANDS` 里），再拆分；拆分前后快照不变，另有一条测试检查每个所有者命令都拒绝 Agent 的调用。`packages/app-core/src/product-app.ts` 由 5573 行降到 985 行，命令注册按领域移到 `packages/app-core/src/commands/`，共用的辅助函数在 `product-helpers.ts`：

| 文件 | 行数 | 文件 | 行数 |
| --- | --- | --- | --- |
| `access.ts`（三个命令清单） | 45 | `library.ts` | 484 |
| `agent-run.ts` | 536 | `library-io.ts` | 428 |
| `agent.ts` | 497 | `media.ts` | 553 |
| `connections.ts` | 344 | `notes.ts` | 348 |
| `creative.ts` | 342 | `settings.ts` | 309 |
| `inventory.ts` | 453 | `voice.ts` | 241 |

### 6.2 侧栏刷新的命令清单

清单移到契约包 `LIST_CHANGING_COMMANDS`（`packages/contracts/src/sidebar.ts`），渲染进程的 `lib/lists-changed.ts` 照旧用它；`tests/runtime/command-registry.test.ts` 列出所有命令，笔记、白板、导图、文稿、粗剪的新建、改名、删除、恢复与项目材料的增删都必须在清单里或写明例外理由（LOOP-24 第 7 项）。

### 6.3 knip 的试用

试用结论：knip 6.41.0 在本仓库的 pnpm 工作区里能正确识别入口（主进程、预加载、渲染进程、解析与 VAD worker、插件入口与烟测桩），误报集中在通过字符串、打包配置或原生模块用到的依赖，用 `knip.json` 的 `ignoreDependencies` 逐项写明。采用：作为 `verify` 的一步（`node scripts/verify.mjs`），新出现的无用文件、导出或依赖会让检查失败。每一项删除前都查过字符串引用、动态导入与打包入口。

- 删除的文件：`apps/desktop/src/renderer/brand.tsx`、`components/ui/button.tsx`、`components/ui/textarea.tsx`、`pages/projects/project-overview.tsx`、`tests/helpers/pdfjs-reader.ts`。
- 删除的依赖：`apps/desktop` 的 `@radix-ui/react-scroll-area`、`@radix-ui/react-slot`、`@radix-ui/react-tabs`、`class-variance-authority`、`codemirror`、`@manga/kernel`、`@manga/plugin-sdk`；`packages/app-core` 的 `@manga/i18n`。
- 删除或收窄的导出：各模块里只在文件内部使用的导出改为内部函数（`ignoreExportsUsedInFile`），烟测里的 `dragThrough` 删除。

### 6.4 测试临时目录（LOOP-25）

创建临时目录的夹具统一用 `tests/helpers/global-temp.ts`（用例或文件结束时删除；排查时可以用环境变量保留现场）。`node scripts/stage.mjs test` 在 Vitest 前后数一次系统临时目录里本仓库测试前缀的目录，多出来的算失败；这次门禁里它第一次真正跑到收尾，暴露了把 `Set` 当数组用的错误，已修复。

开发机上已有的遗留目录：阶段开始时按前缀逐个确认来自测试或阶段脚本后清理；那次清理删除的数量没有记录下来，这里如实说明。阶段末系统临时目录里还有 179 个 `manga-` 前缀的目录，全部来自打包烟测与基准的运行（`manga-smoke-library-*` 48、`manga-package-*` 43、`manga-package-window-walk-*` 24、`manga-bench-*` 26 等），不来自 Vitest；它们不在 `stage test` 的计数里，登记为 [LOOP-26](status.md#loop-26)。门禁与补充测量跑完后（2026-11-03），按前缀逐个确认来自本仓库的测试、打包烟测与基准，并确认没有 MANGA、Electron 或测试进程还在运行，然后删除了 289 项（打包烟测 207、基准 70（含 9 个冷启动结果文件）、测试辅助目录 12），系统临时目录里不再有 `manga-` 前缀的项。

<a id="walks"></a>
## 7. 走查与测试的迁移

依赖旧结构的断言按计划改写，断言不减：

| 旧断言 | 现在 |
| --- | --- |
| 类型小标题 `sidebar-type-*`、行的前置图标、展开箭头 `context-toggle-*` | 行没有前置图标、名字后面是类型胶囊；项目用打开 / 关闭两态的文件夹图标（`sidebar-ui.test.tsx`、`sidebar-home-list`） |
| “最近”的两个标题、按资源列的“最近” | 一个标题、按作品合并（`sidebar-activity.test.ts`、`media-view-covers`） |
| 主页的“新对话”入口 | 主页没有；从对话视图的侧栏新建（`trace-walk`、`agent` 阶段） |
| 点图标只换侧栏 | 仍断言不新开标签，另断言主区与对话栏跟着换（`rail-views`、`view-main-linkage`） |
| 一个上下文一份布局 | 每个视图一份（`workspace-controller.test.ts`、`workspace-restart`：重启后小说视图、主页的栏与标签、漫画视图的列表方式都恢复） |
| 小说的“继续阅读” `reading-more` 与滚动正文、正文下方的面板 | 按页阅读与左侧面板（`novel-pages.test.tsx`、`novel-paginate`、`novel-side-panel`） |
| 基准里把所有标签放在一栏 | 标签各回自己的视图，切换、四栏与内存在主页里测（主页列出上下文的全部标签） |
| 规模基准“末尾标记在正文里” | 收紧为“末尾标记在显示的那一页上”（一个窗口有几十页） |
| 阶段用例 AT-16、AT-75、AT-83、AT-119 里指向改名测试的 5 个名字 | 指向改写后的测试；主页“新对话”那一条的覆盖由新增的“从对话视图开始一段对话”（`sidebar-ui.test.tsx`）补上，旧测试只断言了按钮存在，新测试断言它真的新建并打开 |

新增的窗口观察（计划第 7 节的 19 项）全部在 `gate.json` 的必需列表里；新增的走查文件为 `view-walk.ts`、`shell-walk.ts`、`hold-walk.ts`、`library-walk.ts`、`novel-walk.ts` 与共用的真实输入 `input.ts`，基准为 `bench-polish.ts`。

按住方向键（AT-135）的三条失败路径在 `hold-rate-recovers` 里用 CDP 复现：`lostKeyUp`（吞掉一次松开后再按住）、`repeatsOnly`（焦点在菜单里按下、关菜单后只收到重复标记的按下）、`sourceChange`（按住中打开播放副本换源）；三种序列下每次按住都在按住时长内进入临时倍速，松开后恢复，第一种不多跳步长。

<a id="found"></a>
## 8. 走查与基准发现的缺陷（均已修复）

窗口走查与基准第一次在打包窗口里跑这些路径时发现，单元测试没有覆盖到；每一项都补了能在旧代码上失败的测试或窗口断言。

1. 小说的“标记读到这里”把窗口的起点存成阅读位置，而不是显示的那一页（`markProgress`）；书签、查找结果与笔记来源打开时，把临时定位存成了阅读位置。
2. 分栏的最小宽度只加在已有的栏上（`workspace/host.tsx`）：随第一个标签出现的栏、从保存的布局读回的栏没有最小宽度，可以被拖得比规定还窄。
3. 右键菜单的行不是整行宽，悬停只有文字部分变色（`.context-menu button { width: 100% }`）。
4. 浅色主题里当前上下文引导线的颜色没有用强调色 token（`--color-guide-current`）。
5. 侧栏拖过阈值后，拖动中的分隔条丢了强调线（`.shell-pullout:active` 盖掉了它）。
6. 焦点在停靠的对话栏里时，图标的悬浮卡片不出来（只有浮层状态的栏应该挡住它）。
7. **有选中文字时按下分隔条、图标、按住录音等需要捕获指针的控件，再一移动就变成浏览器原生的拖动选中文字**（`dragstart` → `pointercancel`），拖动失败，之后的合成鼠标事件也会丢失。这些控件都加了 `onDragStart` 的 `preventDefault`。
8. 走查自身的缺陷：主页列表在 200 px 时“胶囊完整”的检查实际在 260 px 下进行（检查形同虚设）；现在先选中全部文字再拖到 200 px，并断言宽度为 200 ± 2 px。对话自动命名的走查在两段对话同时打开时操作了隐藏的那个输入框，第二句话没有发出也判为通过；现在只操作当前标签，并断言第二句话确实发出并答完。
9. **小说按页阅读时，大章节每次重开都把阅读位置往回挪一点**：窗口从保存位置前 3 万字开始，页的边界随窗口起点而变，保存位置落在页中间时，重开后存下的是更早的页首。现在只要保存的那个字还在当前页上就不改写进度（`pageHolds`）。
10. **同一缺陷的另外两条路径**：后面的标签（统一隐藏层，仍有布局盒子）在栏宽变化时重新分页并存下进度，一次可退回 2 万多字；每次重新排版（收起侧栏、停靠栏出现、改字号）都以当前页的页首为新的锚点，反复几次就一页一页往回退。现在分页器只在标签可见时排版与报告位置，回到前面时重新定位；重新排版时锚点保持原来那个字，只有翻页才换锚点。规模基准连续 3 次启动、每次 3 轮重开都停在末页。小说基准的“改字号”判定相应改为：20 次来回改字号，每次的页都包含改之前翻到的那一页的第一个字（原判定只看上一次改之前的页首，允许每次退一页）。
11. 一次完整门禁里窗口观察 `split-focus-keys` 失败（Ctrl+数字换栏后马上按空格，视频没有暂停），单独重跑两次都通过。原因是三个阅读器在标签变成焦点后的被动 effect 里才挂上键盘监听，标签已显示为焦点而监听还没挂上的那一刻按下的键会丢；现在在同一次提交的 layout effect 里挂上（视频、漫画、小说）。

<a id="gate"></a>
## 9. 门禁与基准

最终源码上的结果（2026-11-03，Windows 开发机，Node 26.12.1，不是基准参考机）。`test`、`package`、`bench` 与 `report` 都是 A 的修复与第 10 节新增的关窗用例之后、在最终源码上跑的：

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify.mjs` | passed：类型检查、knip、文档检查（70 份文档、83 个需求、140 条验收用例）、发布检查、依赖边界与 Vitest 2754 个用例（2742 passed、12 skipped） |
| `node scripts/stage.mjs test` | passed（A 重跑）：必需用例 174/174；Vitest 2754 个用例（2744 passed、0 failed、10 skipped）；系统临时目录里没有多出的测试目录 |
| `node scripts/stage.mjs package` | passed（A 重跑）：Electron 44.9.3 未签名本地包，17 个阶段（新增 `workspace-closed`）；104 个窗口观察全部通过，其中 100 个是必需的。新增的 `close-saves-layout`：关窗前 60 ms 把“最近”从两栏换成单栏，库里仍是两栏；页面在 `close()` 之后 4 ms 回执，窗口 11 ms 关闭，再启动后库里与窗口里都是单栏。A 的第一次重跑停在 `window-walk` 的 `hold-rate-hint-only` 与 `hold-rate-recovers`（机器 CPU 约 51 %，别的应用在跑；这两项的等待只比按住时长多 150 ms），播放器代码自 B 通过的那次以来没有改动，原样重跑一次全部通过，见第 11 节 |
| `node scripts/stage.mjs bench` | passed（2026-11-03 21:06 结束，电脑重启、其他应用关掉后，启动它的应用在前台）：52 项门槛全部在目标内；导图 1000 个节点折叠展开 p95 47.3 ms、调用追踪开销 p95 2.65 ms。之前在同一源码上的一次（20:49，重启之前）是 118.1 ms 与 10.14 ms，见下文 |
| `node scripts/stage.mjs report` | passed：`automationStatus` 为 `self-check-passed`，没有错误；`productAcceptance` 仍为 not-run |

本阶段新增门槛的数值（p95，单位 ms，另注明的除外）：

| 指标 | 结果 | 门槛 |
| --- | --- | --- |
| 点图标切换视图到侧栏与主区画好 / 重启后第一次切到一个视图 | 20.1 / 23.4 | ≤ 150 / 2000 |
| 主页视图切换到列表 / 媒介视图切换到格子（规模样本） | 19.4 / 25.9 | ≤ 100 / 120 |
| 媒介视图第一屏的封面全部显示 | 23.3 | ≤ 600 |
| 拖动分隔条与图标时晚到帧的占比 / 扫描中界面刷新期间晚到帧的占比 | 0.3 % / 0 % | ≤ 2 % |
| 小说翻一页 / 改字号后重新分页并回到原位 / 打开一章（30 万字的一章） | 30.2 / 61.7 / 53.6 | ≤ 50 / 400 / 500 |
| 标签切换 / 上下文切换 / 重启后的上下文切换 | 18.5 / 14.5 / 26.4 | ≤ 100 / 300 / 2000 |
| 四栏的晚到帧 / 四栏多用的内存 / 挂着的阅读器多于栏数 | 0 % / 46 MiB / 2 | ≤ 2 % / 600 MiB / 2 |
| 规模样本：10 MiB TXT 末尾 / 30 MiB EPUB 末尾（标记须在显示的那一页上） | 487.9 / 731.7 | ≤ 2000 |

**导图折叠展开超出门槛的原因。** 这一项本阶段没有改动代码，上一阶段合并时的门禁是 56.3 ms，本阶段早上的试跑也是 56 ms。为了分清是代码变慢还是机器状态，用 git worktree 在 `b3b468b`（上一阶段的合并）上另打一个包，与当前包在同一时段交替各跑两次同一个画布基准：

| 包 | 导图折叠展开 p95 | 中位数 |
| --- | --- | --- |
| `b3b468b`（上一阶段，当时 56.3 ms） | 141 / 138 | 98 / 108 |
| 当前源码 | 118 / 113 | 77 / 78 |

同一时段上一阶段的代码更慢，所以超出的原因是机器状态，不是本阶段的代码。跑基准时前台是资源管理器，而不是启动它的应用；同一时段还有别的应用让 CPU 在 50 % 以上停留了一阵（[LOOP-13](status.md#loop-13) 记录的情形）。门槛与测量方法都没有改；需要在机器空闲、启动它的应用在前台时重跑 `bench` 与 `report`。

四份源码指纹（`test`、`package`、`bench`、`report` 的证据相同，与当前提交的源码一致）：

| 指纹 | 值 |
| --- | --- |
| `sourceFingerprint` | `243bffd08f65270bacb9d18a3b4f6edf4d188764115c01f3a70e42d9b4c09d74` |
| `lockFingerprint` | `b1b59cfe9cec9a65ec3211a39ee6437721fe93fd26bc944e2a181702f21ad791` |
| `testScriptFingerprint` | `75d6500f90f83830b918425deffb84e8bddd51c1ffd247cb4e18e7086dd38f78` |
| `buildScriptFingerprint` | `1c0ce66045a98760c8a86b5b1f9bdc66678733c47cf9d33ac0a859cf132ac689` |

门禁的反复：第一次完整门禁停在 `stage test`（4 个阶段用例指向改名的测试，第 7 节）；第二次停在 `bench`（改字号的判定，第 8 节第 10 项）；第三次停在 `package`（键盘监听挂上的时机，第 8 节第 11 项）；第四次 `verify` 里的搜索框用例在机器忙时超时，单独跑 14/14 通过，机器空下来后重跑通过；第五次即上表。之后在 CPU 占用约 10 %、前台仍是资源管理器时又跑了一次完整的 `bench`（2026-11-03 17:38 结束）：仍然只有导图折叠展开一项超出，p95 105.8 ms，其余 51 项在目标内；源码与门槛都没有改。为了找原因又试了两件事：让导图在折叠时复用没变的节点对象（中位数仍是 76 ms，没有可测的改善，已撤回，不在提交里）；用调试端口连上窗口做 CPU 采样时，同一源码的折叠降到中位数 43、p95 68 ms。基准窗口已经关掉了 Chromium 的后台节流，所以这更像是操作系统对不在前台的窗口的调度，而不是代码的开销（[LOOP-13](status.md#loop-13)）。第三次完整 `bench` 在启动它的应用在前台、CPU 占用约 3 % 时跑：导图折叠展开 p95 100.6 ms，仍以 0.6 ms 超出，其余 51 项在目标内。三次结果 113.7、105.8、100.6 ms 都如实记录；没有继续重跑碰运气。A 在最终源码上、用户确认机器空闲后跑了第四次（上表）：118.1 ms，另有调用追踪开销以 0.14 ms 超出；其余指标与第三次相近（白板拖动 9.3 / 9.4 ms、标签切换 18.1 / 19.7 ms、小说翻页 28.6 / 28.4 ms），所以不是整体变慢。用户随后重启电脑、关掉常驻的其他应用，源码与门槛都没有改，第五次 `bench` 52 项全部通过，导图折叠展开回到 47.3 ms（与上一阶段合并时的 56.3 ms、本阶段早上的 56 ms 同一水平），调用追踪开销 2.65 ms；`report` 通过。超出确实来自机器状态，写进 [LOOP-13](status.md#loop-13) 的情形：跑基准前先重启、关掉常驻应用。这台机器上这一项在最好的条件下也落在门槛附近（上一阶段合并时是 56.3 ms，同一时段上一阶段的代码也更慢），是否接受这份证据、或换一台机器 / 等机器状态恢复后再跑，交给 A 审查判断。

<a id="a-review"></a>
## 10. A 的集中审查（2026-11-03）

按计划第 9 节的重点逐项看了实现：工作区状态 version 1 → 2 的转换与按大小裁剪的顺序、每个视图一份布局的保存与恢复、打开规则（所有入口都经 `workspace/openers.ts` 进 `controller.open`）、统一隐藏层（只剩 `data-hidden-layer` 一条规则，设置、视图、标签槽、停车区都用它）、侧栏的计数与列出同口径（`Scan.openable` 与 `inLibrarySql`）、混排分页的游标、分隔条与图标拖动的取消路径、方向键控制器的两条自愈规则与 `holdStart` / `holdEnd`、移除库外记录时保留的用户内容（库里没有外键，笔记、书签、录音、截图、对话与进度的行都不删）、“重新识别作品”、关窗前的保存、对话自动命名、Agent 空范围的说明。拆分前后的授权清单逐项比对过：`OWNER_COMMANDS` 比上一阶段只多了本阶段新增的 4 个所有者命令（`works.reidentify`、`library.outside`、`library.outsidePreview`、`library.removeOutside`），`AGENT_COMMANDS`（22 个）与 `AGENT_OPT_IN_COMMANDS` 不变；快照里没有消失的命令。`node scripts/verify.mjs` 在 B 交付的源码上重跑通过（2738 passed、12 skipped）。

**A 直接修复的 3 项（都补了在原代码上失败的用例）：**

1. **扫描时，短作品后面跟着长文件夹，前一部作品要等长文件夹导完才显示（A-114）。** “每秒至多一次”的检查只在换到下一个文件夹时做，被这一秒挡下的已完成作品要等再下一个文件夹。现在每导入一个文件后，有待通知的作品且已过一秒就通知（`library-scan/service.ts`）；用例 `tells a finished work within the second even while the next folder is still being read`（1 个文件的作品后接 8 个文件的作品，第一部在 1.6 s 内通知）。
2. **小说翻页后马上关标签或关窗，最后一页的位置丢失。** 本阶段把阅读位置改成停留 600 ms 后才保存，但卸载时只清掉计时器、不保存（上一阶段是立即保存）。现在等待中的保存在卸载与 `pagehide` 时立即发出，只发一次（`hooks/use-novel.ts`）；用例 `tests/reading/novel-position-save.test.tsx`。
3. **媒介视图的书架里，卡片菜单的“详情”跳回主页视图并另开标签（A-107）。** 它打开作品主页时没有带媒介，作品主页被当成只属于主页的标签。现在书架是某一媒介时带上这个媒介，在当前视图的标签里打开（`workspace/views/library-tab.tsx`）。这一行没有单独的界面用例，由 H-71 的人工检查覆盖。

**报告缺的记录（不影响实现，在此补上 A 能确认的部分）：**

- 计划 4.13 要求先复现“未归入作品完全无法操作”并记下原因，报告没有写。从用例看，原因是“未归入作品”里列着库外资源（打不开，也没有去处）：`tests/library/unassigned-recover.test.ts` 断言三种媒介删除条目后都能打开、归入作品、匹配条目，库外的进入“设置 › 资源库”的库外一节。
- 计划 4.8 要求写明 Electron 44 在 `close` 事件里页面还能收发 IPC 的条件：窗口的 `close` 被拦下时页面还没有卸载，可以收发 IPC；主进程等页面回执或 1.5 s 后再关，页面崩溃或已销毁时直接关（`apps/desktop/src/main/index.ts`）。页面只立即保存工作区的标签与布局；阅读位置由上面第 2 项在 `pagehide` 时补发。
- 计划 4.12 要求写明在旧代码上实际复现到哪条按住路径。报告第 7 节只写了修复后的验证；三条路径的单元用例都在 `tests/reading/video-keys.test.ts`，修复都已做。
- 开发机阶段开始时清理的临时目录数量没有记录（报告第 6.4 节已如实说明）。

**B 在 A 审查之后补做的复现（2026-11-03）。** 上面三条按计划本该由 B 在旧代码上实际复现，这里补上实测结果；用的是一次性的工作树与脚本，跑完已删除，没有改动产品代码，也不进提交。

- **“未归入作品无法操作”（4.13）。** 在上一阶段合并 `b3b468b` 的工作树里（它自己的 `@manga/*` 指向旧源码），用合成资料跑与 `tests/library/unassigned-recover.test.ts` 相同的步骤，只记录旧代码的回答：
  - 资源库位置里删除条目的资源：小说、漫画、动漫都列在组里，`library.openable` 为 `open`，能打开（`library.read` / `comic.pages` / `video.playbackPlan` 都成功），“归入作品…”与“匹配条目…”（新建作品）都成功。**这一条在旧代码上没有复现。**
  - 删除条目后又移除了它的资源库位置：组里照样列出这些资源；`library.openable` 为 `outside`，打开失败（`LOCATION_UNAVAILABLE`，文件不在任何资源库位置里）；“归入作品…”与“匹配条目…”返回成功，但归入之后仍然打不开。**这就是实际复现到的路径**：每个操作要么失败，要么看起来成功却什么都没变，与“完全无法操作”吻合。本阶段的修复是这一组只列资源库位置里的资源、库外的进“设置 › 资源库”的库外一节（A-113）。
- **关窗前的保存（4.8）。** 用仓库里的 Electron 44.9.3 写了一个最小的主进程脚本，按 `apps/desktop/src/main/index.ts` 同样的方式拦下 `close`、发请求、等回执或 1.5 s，四种情形各开一个窗口：
  - 主进程 `close()`（标题栏与系统的关闭发的就是它）：页面收到请求并在 54 ms 内回执，回执时页面还没有卸载（`pagehide` 没触发），放行后才卸载。
  - `app.quit()`：同样被拦下，59 ms 回执，回执时未卸载。
  - 页面不回执：1513 ms 后照常关闭。
  - 页面已崩溃：不拦，直接关闭。
  所以条件是：窗口的 `close` 被 `preventDefault` 拦下期间页面完整存活、能收发 IPC，直到放行后才卸载；页面已崩溃或 `webContents` 已销毁时不拦。打包窗口观察 `quit-saves-layout` 只发请求、不真的关窗，这次的脚本补上了真的关窗。
- **按住方向键（4.12）。** 把旧代码的 `readers/video-keys.ts` 与 `readers/use-video-playback.ts` 临时换回工作树，跑本阶段的用例（跑完即还原）：
  - `video-keys.test.ts` 的 AT-135 四条里三条失败：漏掉松开后同一侧再按下，旧控制器忽略这次按下（期望结束旧的按住再开始新的，实际只有第一次的 `hold`）；只收到系统重复的按下时，旧控制器什么都不做，**按住始终不开始**（期望立即 `hold`，实际为空）；按住中窗口失焦后只收到重复的按下，同样不再开始按住。
  - `video-player.test.tsx` 的 AT-135 用例失败在换源一步：按住中载入新的源时，旧的 `loadedmetadata` 把倍速写回保存的 1.25×，临时倍速丢失（期望 2×）。
  三条路径在单元层面都复现了；其中“只有重复的按下”最符合用户描述的“底栏出来了、没有倍速、松开再按一次就好”。打包窗口里的 CDP 复现只在修复后的代码上做了（第 7 节），没有在旧代码的包上做。

<a id="a-recheck"></a>
**A 对补做复现的复核（2026-11-03）。**

- **4.13：与 A-113 的修复对得上，但只解释了一半。** 复现到的路径（删除条目后又移除资源库位置）正是 `unassigned-recover.test.ts` 第二条用例守护的情形：这一组不再列库外资源，它们在库外一节里。用户还说过“在库里的资源也无法操作”（计划 4.13），这一半在旧代码的命令层没有复现，界面层的“打开 / 归入 / 匹配”本阶段也没改动，所以不能说已经与“完全无法操作”吻合；它留给人工检查 [H-78](../../USER-ACTIONS.md#h-78) 的“‘未归入作品’的每项都能操作”，用户在那里再遇到就作为新的反馈处理。
- **4.8：需要正式用例，A 已补上。** 计划第 7 节写的 `quit-saves-layout` 是“移动一个标签后 100 ms 内关闭窗口，重启后标签在新位置”。现有的观察自己发请求、不关窗；B 的脚本也是照着写的另一份实现。两者都没有走到 `apps/desktop/src/main/index.ts` 里真正的 `close` 处理，所以那段代码坏了也没有门禁会发现。A 新增打包阶段 `workspace-closed` 与必需的窗口观察 `close-saves-layout`（`apps/desktop/src/main/smoke/workspace-restart.ts`）：`workspace-restart` 写完报告后，在当前上下文换一种布局，60 ms 后（远早于页面自己 500 ms 的保存停顿，且先确认库里还是旧的布局）用窗口自己的 `close()` 关窗，记下页面回执与窗口关闭的时间；下一次启动同一份 Profile，核对窗口回到这个上下文、库里与窗口里都是关窗前选的布局，页面在关窗之前回执、窗口在 2 s 内关闭。`quit-saves-layout` 保留，测的是回执的时限。这项改动改了源码与阶段脚本，之前的 `test` 与 `package` 证据随之过期，下面的门禁在改动之后的源码上重跑。
- **4.12：接受。** 换回的是旧代码本身的两个模块，三条路径各有用例在旧模块上失败、在新模块上通过，算是在旧代码上复现；按键序列能在真实窗口里出现，由修复后的 `hold-rate-recovers` 用 CDP 在打包窗口里证明。没有必要再为旧代码打一个包。

**基准的判断。** 导图折叠展开 p95 三次是 113.7、105.8、100.6 ms（门槛 100）；同一时段上一阶段的代码更慢，所以不是本阶段的代码变慢。但门槛不放宽，超出就是未通过，不能当作通过写进证据。A 的三项修复与新增的关窗用例改了源码与阶段脚本，A 已在最终源码上重跑整套门禁并替换了证据（第 9 节）：`verify`、`test`、`package` 通过；用户确认机器空闲后跑的第一次 `bench` 仍未通过（导图折叠展开 118.1 ms，调用追踪开销 10.14 ms），重启电脑、关掉其他应用后的第二次 52 项全部通过（47.3 ms、2.65 ms），`report` 通过。

**结论。** 实现与计划一致，审查收敛；整套门禁（`verify`、`test`、`package`、`bench`、`report`）在最终源码上通过，证据已替换（`docs/evidence/gate/`，4.3 MiB）。阶段在 Agent 侧完成；产品验收仍为 not-run，人工检查不是推送的前提（A-53）。已在用户待办登记 push 与 PR 的授权请求 [ACT-13](../../USER-ACTIONS.md#act-13)。

<a id="limits"></a>
## 11. 限制与后续

- 开发机不是基准参考机；基准在启动它的应用位于前台、机器空闲时跑（[LOOP-13](status.md#loop-13)）。一次重跑期间机器进入睡眠，那一轮作废重跑。
- 窗口观察 `frame-window-controls` 的悬停取色在前台被其他窗口抢走时偶尔失败，重跑通过；目标与方法未改。`hold-rate-hint-only` 与 `hold-rate-recovers` 在机器忙时也失败过一次（等待只比按住时长多 150 ms），原样重跑通过；门槛与等待时间都没有放宽。
- 打包烟测与基准留在系统临时目录的运行目录见 [LOOP-26](status.md#loop-26)。
- 依赖的主版本升级留给下一次依赖循环（第 2 节）。
