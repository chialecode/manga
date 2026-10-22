# 阶段交付报告：单一工作区——项目、标签页与分屏

计划：[阶段计划](stage-plan.md)。上一阶段的报告在合并提交里：[归档](https://github.com/chialecode/manga/blob/c22d886/docs/delivery/stage-report.md)。本文由 B 在交付时一次收齐；A 的集中审查与复核结果追加在第 11 节之后。产品验收 not-run。

## 目录

1. dockview 试验
2. 阶段开始的整理（C0）
3. 依赖盘点（D1）
4. 工作包、需求与验收的映射
5. 进度读取点的三类归类
6. 迁移映射（测试与走查）
7. 基准与验证基线
8. 源码指纹
9. 实施中发现并修复的问题
10. 已知限制与登记的后续项
11. 人工检查、待用户事项与 A 的审查要点
12. A 审查
13. 试用反馈的返工（图标栏、侧栏、搜索与设置）
14. A 复核试用反馈的返工

<a id="dockview"></a>
## 1. dockview 试验（W1 第一步）

**结论：六项全部满足，分屏与标签页建在 `dockview-react` 8.6.1 上**（MIT，核心 `dockview-core` 零依赖）。注意包名：React 绑定是 `dockview-react`，`dockview` 是不含 React 的入口。选型记录在 [ADR-0007 的开源选型记录](../decisions/0007-technology-stack.md#open-source-record)。

试验在隔离页里做（临时目录，不入库）：Electron 44.5.1（Chromium 152）、React 19.3.0、`<Activity>`、门户；视频用 `dist/samples/media/video/h264-aac.mp4`，漫画用图片目录样本的页面，文稿用 `textarea`；用 playwright-core 的 Electron 启动器驱动真实指针拖放与键盘，共 28 项检查全部通过。试验页用的是底层元素（`video`、滚动容器、`textarea`）而不是应用里的三个阅读器组件——移动不重载取决于 DOM 是否被重新挂载，与组件内部无关；用真实阅读器组件的同类检查是窗口观察 `split-move-video`。

| 条件 | 结果 |
| --- | --- |
| 1 四种布局可程序摆出、互相切换，标签不丢 | 单栏、左右两栏、三栏、四宫格用 `panel.api.moveTo` 摆出，8 次来回切换后 5 个标签齐全，每种布局的栏数正确 |
| 2 播放中的视频移动后继续、`currentTime` 连续、无重新加载 | 面板用 `renderer: "always"`：dockview 把内容放在一个覆盖层里，只改位置，不移动 DOM。8 次布局切换 + 真实拖放（拖进另一栏、拖到栏边形成新栏）+ 栏内换位置：50 ms 采样的 `currentTime` 与 `getVideoPlaybackQuality().totalVideoFrames` 全程单调不减，元素是同一个，没有 `emptied`、`loadstart`、`abort`、`error`，React 的挂载次数不变；漫画滚动位置与文稿选区不变；标签被隐藏再显示后滚动偏移也保留 |
| 3 布局与标签可序列化、恢复，未知类型原样保留 | `toJSON` → `clear` → `fromJSON` 后分组、标签、激活标签与面板记录逐字相同（尺寸随容器按比例变）。未知的 `contentComponent` 会让 `fromJSON` 抛错并回滚，所以保存时由我们的标签模型把未知类型映射到占位组件、原名与参数留在 `params` 里，写回时还原，往返后逐字相同 |
| 4 主题用 CSS 变量接 MANGA token，深浅都对 | `--dv-*` 全部映射到 `--color-*`；切换 `data-theme` 后标签条、内容区、当前栏与非当前栏的标签文字都按新的 token 重新解析 |
| 5 键盘 | dockview 自带 `tablist`/`tab` 角色与滚动 `tabindex`：每栏一个 Tab 停靠点（当前标签），方向键、`Home`、`End` 移动焦点，`Enter` 激活。`Ctrl+Tab` / `Ctrl+Shift+Tab` 不是内置的，由应用级处理（用 `webContents.sendInputEvent` 与 CDP 按键都有效）。自定义标签组件不要再嵌套 `role="tab"` 与 `tabindex`，否则每个标签有两个停靠点 |
| 6 Electron 44 + React 19，与 `<Activity>`、门户共存，隐藏事件可暂停视频 | 无页面错误。`<Activity>` 隐藏再显示整个停靠区：布局、标签、视频元素不变，无重新加载。面板可见性事件在移动标签时会在同一任务里 false → true 抖动（8 次切换产生 16 个事件），直接响应会让视频暂停又播放；改为收到事件后等一帧、再读 `api.isVisible`，移动期间视频没有任何 `pause`/`play`，真正切走标签时暂停、切回时从同一位置恢复 |

附带的发现，进设计：

- 默认渲染方式（`onlyWhenVisible`）下，标签不可见时内容元素从文档摘下，媒体因此暂停；稳定宿主节点加门户的退路写法在“可见时移动”下视频连续，但整个读写要自己维护。所以阅读器类标签一律用 `always`，由应用自己的挂载策略（可见 + 最近两个）决定不可见的阅读器是否卸载。
- 增加的体积：压缩后约 400 KB（核心 + React 绑定），样式约 160 KB。
- 退路（`react-resizable-panels` + 自写标签条）不需要启用。

## 2. 阶段开始的整理（C0）

按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)。A 在计划里列出了清单，B 执行时按内容再核对一遍。

**不入库的文件。**

| 位置 | 处理 |
| --- | --- |
| `.env.local` | 保留，没有读取与任务无关的值 |
| `dist/design-refs/`、`dist/tools/`、`dist/samples/media/`、`dist/keys/`、`dist/plugins/` | 原样保留（用户的参考图、固定版本的工具、测试在用的合成样本、签名私钥、第一方插件包）；`dist/desktop/` 保留并在本阶段最后一次打包时覆盖 |
| `dist/evidence-runs/` | 删除上一阶段的运行目录（`a-review`、`before-rework`、`iterate*`、`real*`、`live-*`、`l1-*`），只留 `current`（本阶段第一次门禁运行时覆盖）与推送前钩子自己保留的日志 |
| `dist/tmp/` | 本阶段的打包与基准日志只在调试时用，门禁通过后删除 |
| `apps/desktop/.vite/` | 构建缓存，最后一次打包后删除 |
| 系统临时目录里的 `manga-bench-*` | 本阶段基准运行留下的 192 个目录，已删除。同目录下的 `manga-test-*` 等测试遗留（11 万个）不是本阶段造成的，登记为 [LOOP-25](status.md#loop-25) |

**已入库的文件。**

| 位置 | 内容判断 | 处理 |
| --- | --- | --- |
| `docs/delivery/stage-report.md`（上一阶段） | 交付、审查与复核报告；仍有效的是已知限制、测量值、真实服务与真实库试验的聚合结果、整理与迁移记录、用户反馈的结论 | 提炼进[执行状态](status.md)（验证基线、真实试验、后续 loop）、确认记录、交付路线、用户待办与模块规格后删除；入链改为正本或归档链接 `https://github.com/chialecode/manga/blob/c22d886/docs/delivery/stage-report.md#<锚点>`；本文件是本阶段的新报告 |
| 执行状态、用户待办、交付路线、确认记录、`docs/README.md` | 长期正本，含上一阶段按轮次追加的过程叙述 | 精炼为当前结论与链接；去掉“第 N 轮返工”的说法（交互设计 3.6—3.8 的标题、模块规格、领域模型的增量说明、LOOP-14/21/22、真实试验的版本说明） |
| `smoke/rework-walk.ts` | 名字说明出自哪一轮；其中的 `modes-two-overviews` 观察属于模式 | 改名为 `retention-walk.ts`，`RETENTION_OBSERVATIONS` 只留 `settings-round-trip` 与 `screenshots-into-whiteboard`（按能力并入窗口走查）；“返工烟测项目”“返工烟测作品笔记”改成按用途命名；模式观察在第 6 节的迁移映射里逐个写明替代 |
| 注释里的轮次说法（`management-walk.ts`、`bench-reader.ts`、`window-walk.ts` 第 9 节、`reading-loop.test.ts`、`source-repair.test.ts`、`workspace-flows.test.tsx`） | 描述历史 | 改写成对当前行为的说明 |
| `scripts/stage/gate.json` 的 `requirement` 文字 | 写着“返工 W2”“第二轮返工计划 15.7”“第三轮返工计划 16.7”，指向已不存在的小节 | 改写为需求与验收编号（AT-26、AT-27、AT-33、AT-56、AT-80、AT-88、AT-94、AT-97、AT-98、AT-102） |
| `scripts/check-docs.test.mjs` | `currentStage: "m3"` 的样例 | 按 `m4` 更新，断言不减 |
| `docs/evidence/gate/` | 上一阶段最后一次门禁的证据 | 本阶段最后一次门禁后整体替换 |

**去掉以前阶段的标签（A-57）。** 登记表 `currentStage` 改为 `m4`，本阶段计划与本报告的 `retireAfter` 为 `m4`；文档检查（含阶段标签规则）通过，没有留下 `M3` / `m3` 标签。Git 提交信息与固定归档链接里的路径没有改。

<a id="dependencies"></a>
## 3. 依赖盘点（D1，2026-10-22，`pnpm outdated -r`）

同一主版本内升级（精确固定，没有用发行龄豁免；`pnpm dedupe` 把 `@codemirror/*` 的重复副本合并）：electron 44.5.1 → 44.9.3、react / react-dom 19.3.1、vite 8.3.5、vitest 5.0.5、@vitejs/plugin-react 6.1.2、zod 4.6.7、@tanstack/react-virtual 3.14.21、@tiptap/* 3.32.0、@radix-ui/react-dialog 1.3.1 / scroll-area 1.4.0 / slot 1.5.0 / tabs 1.2.1、drizzle-orm 0.45.4、@napi-rs/canvas 1.0.13、@testing-library/user-event 14.6.8、playwright-core 1.64.1、jassub 2.5.23、mdast-util-to-markdown 2.2.0、@codemirror/state 6.7.6 / view 6.43.15 / commands 6.11.1（`codemirror` 元包 6.0.2 已是最新）。新增 dockview-react 8.6.1。

主版本与 ADR-0007 例外的复试：

| 依赖 | 结果 |
| --- | --- |
| pdfjs-dist 6.3.289 → 6.4.299 | 通过。代码里断言版本的五处常量与解析器编号随之更新；PDF 文本层、字体宽度、拖选相关的全部用例通过 |
| jsdom 26.1.0 → 30.1.3 | 通过，改了两处测试环境：jsdom 30 自带 `[popover]` 的默认隐藏规则却没有 Popover API，共享的 `tests/helpers/setup-dom.ts` 加一条更高优先级的显示规则（顶层绘制仍由打包窗口核对）；它也按浏览器的启发式回答 `:focus-visible`，`reader-layout` 里“键盘焦点留住控制条”的用例原来靠 jsdom 不支持该选择器时的回退为真，现在显式替身，断言不变 |
| lucide-react 0.544.0 → 1.61.0 | 通过。代码与测试里用到的 114 个图标名在 1.x 全部存在（逐个 `import` 核对），类型检查与全量用例通过；新外壳的图标栏与标签图标在这一版上选定。`pnpm add` 没有写入任何发行龄豁免 |
| linkedom 0.18.13 → 0.18.14 | **回退并保持 0.18.13。** 0.18.14 依赖 `@acemir/cssom`，主进程打包（`tests/danmaku/credential-leak.test.ts` 里的 Vite 构建）报 `"parse" is not exported by "node_modules/@acemir/cssom/build/CSSOM.js"`（CommonJS 的具名导出 Rolldown 认不出）。复查条件：linkedom 或 `@acemir/cssom` 发行带有 ESM 入口，或主进程打包能识别该导出 |

本阶段不升（复查条件在 ADR-0007）：electron 45.0.0（2026-10-21 发行，太新）、`@earendil-works/pi-ai` 0.85.1 → 1.4.0（涉及 runtime 适配，随顺延的 Agent 工程循环一起做，A-98）、`@types/node` 24.5.2（随 Node 24）；Node 本身（本机 24.19.0）不换，[LOOP-08](status.md#loop-08) 的上游缺陷仍未关闭。升级后的 `pnpm outdated -r` 只剩这三项加 linkedom。

## 4. 工作包、需求与验收的映射

状态一栏只写自动化与窗口观察；人工检查与产品验收一律 not-run（第 11 节）。重跑的验收（计划第 1 节所列）对应 `gate.json` 里原有的 `AT-*` 用例，表示的用例名按新界面改过，见第 6 节。

| 包 | 需求 | 验收 | 实现位置 | 验证证据 | 状态与限制 |
| --- | --- | --- | --- | --- | --- |
| C0 整理 | — | 文档检查 | 第 2 节 | `check-docs` passed（70 份文档，需求 83 条，验收 118 条） | 完成 |
| D1 依赖 | — | — | `package.json`、`pnpm-lock.yaml`、[ADR-0007](../decisions/0007-technology-stack.md) | 第 3 节；类型检查、全量用例、打包烟测通过 | 完成；四项保留旧版本，条件已写明 |
| W1 外壳 | UI-01、UI-06、UI-07、UI-08 | AT-110、AT-111（AT-81、AT-82、AT-86 重跑） | `renderer/workbench.tsx`、`shell.tsx`、`sidebar.tsx`、`styles-frame.css`、`lib/shell-model.ts`、`packages/i18n/src/messages-shell.ts`、`packages/app-core/src/domain/shell-layout.ts`（外壳偏好 version 2） | `tests/shell/window-frame`、`shell-ui`、`sidebar-ui`、`window-fullscreen`；窗口观察 `workspace-frame`、`workspace-menu`；`gate.json` 用例 `AT-111-frame-and-sidebar` | 顶部一行、四个菜单、图标栏、侧栏、对话栏、浮层、宽窄矮三种窗口；没有模式切换 |
| W2 标签页与阅读器实例 | UI-09、UI-08 | AT-112、AT-118 | `renderer/workspace/{model,controller,openers,host,marks,drafts,intent}`、`workspace/views/*`（资源库、阅读器、笔记、项目、对话、记录、对象管理、下载等） | `tests/shell/workspace-model`、`workspace-controller`；窗口观察 `tabs-open-restore`；基准 `tabSwitch`、`mountedReaders` | 12 种标签（原 15 种：搜索、设置、插件、键位取消，对象管理新增，第 13 节）；同目标不重复；每个标签自己的历史；关闭保留会话；最近关闭 10 个；视频不可见时暂停 |
| W3 分屏 | UI-09 | AT-113 | `workspace/layout.ts`、`workspace/host.tsx`（dockview）、控制器的栏与焦点 | `tests/shell/workspace-model`（栏的分配）、`workspace-controller`；窗口观察 `split-presets`、`split-move-video`、`split-focus-keys`；基准 `quadLateFrame`、`quadMemory` | 四种布局、栏间拖动与栏边新栏、焦点栏快捷键、全屏只显示焦点标签、放不下时侧栏先折叠 |
| W4 上下文 | BASE-02、UI-10 | AT-114 | `packages/app-core/src/workspace-service.ts`、`packages/contracts/src/{workspace-state,inputs-workspace}.ts`、表 `workspace_contexts`、`sidebar.tsx` | `tests/library/workspace-state`、`tests/shell/sidebar-ui`、`state-retention`；窗口观察 `context-switch`、`workspace-restart`；基准 `contextSwitch`、`contextRestore` | 项目与“最近”各自的标签与布局，启动回到上次的上下文；归档保留布局、删除一并删除 |
| W5 数据 | LIB-03、DATA-01 | AT-110、AT-115、AT-117 | `packages/storage-drizzle/src/{sql,migrate-workspace}.ts`（schema v12）、`app-core/src/progress-service.ts`、`reading-service.ts`、`works-service.ts`、`creative/{bundle,projects}.ts`、`domain/library-package.ts` | `tests/library/schema-v12-migration`（合成 v11 由 `tests/helpers/legacy-v11.ts` 造出）、`progress-contexts`、`context-sessions`；窗口观察 `migrated-profile`、`same-file-contexts` | 第 4.8 节的 7 项全部；真实 Profile 的重放待授权（ACT-11） |
| W6 对话与项目材料 | AGENT-06、AGENT-01 | AT-114、AT-116 | `app-core/src/conversations.ts`、`creative/projects.ts`（材料来源与排除）、`renderer/agent-surface.ts`、`workspace/agent.tsx`、`lib/materials.ts` | `tests/agent/context-binding`、`surface-binding`、`tests/creative/project-materials-origin`、`conversations`、`conversation-delete`；窗口观察 `dock-follows-focus` | 停靠栏按焦点标签取对话；对话标签获得焦点时收起；项目命令只给项目上下文里的对话；自动加入材料可被排除 |
| W7 页面适配 | UI-07、UI-08 | AT-100（重跑）、AT-111 | `renderer/pages/*`、`workspace/views/*`、`packages/i18n/src/messages-*.ts` | 文案检查 `tests/shell/copy-audit.test.ts`（A-93）；窗口观察全部宽窄矮三种窗口 | 总览、媒介页、作品主页、项目页、记录、对象管理、下载是标签；搜索是弹出的框，设置是工作区之外的视图（第 13 节）；原“设置是独立界面”等去掉 |
| W8 走查、测试与基准 | — | 计划第 7 节 | `apps/desktop/src/main/smoke/*`、`scripts/stage/*`、`tests/*` | 第 6、7 节 | 新增 9 项必需窗口观察与 2 个重启阶段；6 项新基准；LOOP-22 第（2）项已做 |
| W9 文档 | — | 文档检查 | `docs/*`、`README.md`、`USER-ACTIONS.md` | `check-docs`、`check-publication`、`git diff --check` | 交互设计第 2、4、5 节重写；设计规则补标签页与分屏；领域模型补工作上下文与按上下文的进度；质量门禁、执行状态、交付路线、用户待办同步 |

## 5. 进度读取点的三类归类

`progress` 的主键是（`context_id`、`resource_id`、`resource_revision_id`）；视图 `progress_latest` 给出每个修订在所有上下文里最近一次的那份（[领域模型 6.1](../design/domain-model.md)）。下面是 `packages/` 与 `apps/` 里每一处读写 `progress` 的位置，逐个归类。

| 类别 | 读取处 | 归属与原因 |
| --- | --- | --- |
| **A 当前上下文的** | `progress-service.ts` 的 `setProgress`/`setPageProgress`/`setTimeProgress`（读已有行再合并、写回）与 `getProgress`；`reading-service.ts` 里 `library.read` 取恢复位置与已读区间（`progressRow`）；`product-app.ts` 里 `workspace.sessions` 给会话行带的位置 | 阅读器恢复与保存位置、已读区间、续读续看、手动标记与重置都是“我在这里读到哪”，必须按上下文分开，否则两个项目里同一集的位置会互相覆盖 |
| **B 所有上下文里最近一次的** | `works-service.ts`：卡片百分比与排序（`progressExpr`）、“已读/已看”判断、继续阅读（`last`）、作品主页的恢复；`works-versions.ts`：换版本时按同一集对齐的位置；`resource-content.ts`：“资源不可用”视图里的位置与来源上下文；`works-delete.ts` 的 `lastOpenedAt`（所有行的最大时间） | 资源库卡片、最近打开与继续阅读是跨上下文的“我最近读到哪”；不是当前上下文的，卡片注明来自哪个上下文。`works-delete.ts` 的预览数 `progress` 计数与上述都是只读统计 |
| **C 所有上下文里最远的（前沿）** | `progress-service.ts` 的 `frontierProgress`/`frontierConsumed`；调用方：`agent-materials.ts` 的 `consumed()`（字幕窗口、材料提取、弹幕附近评论的范围）、`reading-service.ts` 的 `rangeConsumed`（防剧透过滤 `filterUnread`）、`product-app.ts` 的 `screenshotVisible`（任务能否看到一张截图）；`elsewhereProgress`（“在「某上下文」看到某位置，跳过去”的提示）取别处最近一次 | 防剧透按“看得最远的位置”：在任何一处看过的内容都算看过（Q-33 第 4 项）。提示条要的是“别处读到哪”，取最近一次的 |
| 不分上下文的维护 | `reading-service.ts` 的 `relocationMutations`（修订变化后移动指针，对所有上下文的行同样处理，主键里的 `context_id` 原样带着） | 不是读位置，是修复指向 |
| 包与项目的整体操作 | `creative/bundle.ts` 项目包（该项目的行，导入时 `INSERT OR REPLACE`）；`domain/library-package.ts` 资料包（只含“最近”的行，导入时较新者保留）；`creative/projects.ts` 删除项目时删该上下文的行 | 项目包带该项目的进度与布局；资料包带“最近”的进度；旧版本导出的包照常导入，进度归入“最近” |

守护：`tests/library/progress-contexts.test.ts`（“一个位置是一个上下文里的位置”“进度的三种读法”，各含用例：同一修订在两个上下文各有各的位置、重复报告相同位置不抬高最近一次、在新上下文提供别处最近一份、三种读法各取其所需、字幕窗口落在最远位置之后、删项目只删自己的行）。

## 6. 迁移映射（测试与走查）

**原则。** 依赖模式的单元测试与走查改写后断言不减；删除的模式断言给出替代的上下文断言。机械统计：`tests/` 里 `expect(` 的总数从 10 908 增到 11 493；单个文件里减少的有 6 个（下面逐个说明），其余文件持平或增加。

**测试：删除的两个文件。**

| 原用例 | 去向 |
| --- | --- |
| `rail-close.test.ts`（5 个）：关闭左栏条目保留会话与位置；关闭项目会话与工作模式会话后可恢复；再说话时重新列出；只关闭栏里列出的、其他的说明原因；Agent 不能关闭 | `tests/library/context-sessions.test.ts` 的 5 个用例：关闭阅读器标签后会话、文件位置与重新打开的路径都在；项目对话与一般对话在标签关闭后各自能打开或续上；说话后即刻列出且没有“已关闭”状态可隐藏；不再提供关闭会话的命令，作品页的会话与一般对话与其他的一样列出；Agent 读不到也改不了人的标签 |
| `nav-history.test.ts`（4 个）：开始为空、第二个位置之前无处可去；沿访问过的位置前进后退，新位置丢掉前方；不重复同一位置并取较新的描述；超过上限保留最近的 | `tests/shell/workspace-model.test.ts` “一个标签自己的后退前进”（去到一个位置、丢掉前方、前进后退；最多 50 个位置；改名与改目标不产生新位置）与 `workspace-controller.test.ts`（在一个标签内前进后退不动别的标签、并说明能不能走） |

**测试：改写的文件。** 其余改动的测试文件主要是把“经左栏导航打开作品、阅读器”的步骤换成标签与资源库标签，把 `shell-left/right`、`column-top-*` 换成 `shell-sidebar/dock`、`shell-top`。断言减少的 6 个文件：

| 文件 | 减少 | 原因与替代 |
| --- | --- | --- |
| `shell-ui.test.tsx`（150 → 125） | 25 | 模式切换的两个用例（模式按钮的名称、按下状态、方向键、保存的模式，约 14 条）由“没有模式切换：顶部一行以侧栏开关、后退、前进、菜单开头，侧栏里没有开关”与“保存的偏好：隐藏的侧栏保持隐藏，开关是普通按钮”替代；左栏“已打开的资源”按媒介分组、位置、关闭，以及工作模式的项目会话分组的三个用例（约 24 条）由 `sidebar-ui.test.tsx` 的 7 个用例（项目与“最近”的对话、折叠记忆、五条加“更多”、切换上下文、右键菜单、归档、模块关闭时的隐藏）和 `workspace-flows.test.tsx` 的位置断言替代 |
| `danmaku-ui.test.tsx`（82 → 78）、`agent-send-media.test.tsx`（54 → 51）、`screenshot-ui.test.tsx`（74 → 70）、`window-fullscreen.test.tsx`（82 → 81） | 4、3、4、1 | 减少的都是 `waitFor(nav-video / nav-comic / open-… / page-work)` 这样的前置等待，被共享的 `tests/helpers/workspace-ui.ts` 的打开作品、打开阅读器辅助函数取代；每个用例对行为的断言不变（`window-fullscreen` 的栏标识断言换名并增加了 `shell-rail`、`styles-frame.css` 里 `immersive` 规则的检查） |
| `workspace-flows.test.tsx`（279 → 277） | 2 | 左栏会话行的位置断言 `session-position-…`（“1/6”“3/6”）改为在阅读器里断言位置（`comic-position` 含“3 / 6”），并增加标签标题与焦点断言 |

**走查（窗口观察）。**

| 删除的观察 | 替代 |
| --- | --- |
| `modes-two-overviews`（两个模式的总览互相独立） | `context-switch`（两个项目与“最近”轮流切换，标签与布局各自恢复）+ `workspace-frame`（项目总览是图标栏上的一个入口，不再是“工作模式首页”） |
| `frame-title-segments`（三栏各自的栏顶） | `workspace-frame`（宽、窄、矮三种窗口下顶部一行、图标栏、侧栏、主区、停靠栏的位置与命中测试） |
| `frame-close-entry`（关闭左栏已打开的资源） | `tabs-open-restore`（关闭标签、重新打开回到原位、重启后恢复） |
| 窗口走查与基准里的其他模式步骤 | `nav-agent` 页 → 对话标签；左栏 `session-position` → 阅读器自己的位置与卡片的来源标注（`same-file-contexts`）；`settings-back` → 关闭标签与切回标签；`conv-mode` 过滤 → `conv-project`（按项目过滤）；`shell-left/right` → `shell-sidebar/dock`；`Ctrl+W` 关闭标签（窗口全屏仍是 `W`）；键位表删去 `nav.overview`、`nav.agent` |
| `rework-walk` 的 `modes-two-overviews` | 同上；其余两项（`settings-round-trip`、`screenshots-into-whiteboard`）保留在 `retention-walk` |

新增的必需观察：`workspace-frame`、`workspace-menu`、`tabs-open-restore`、`split-presets`、`split-move-video`、`split-focus-keys`、`context-switch`、`same-file-contexts`、`dock-follows-focus`、`workspace-restart`、`migrated-profile`（两个新阶段 `workspace-restart`、`workspace-migrated` 各用独立 Profile）。上一阶段的其余必需观察保持必需，必需窗口观察 66 → 74（共记录 69 → 78 项，含内部的 `workspace-restart-prepared` 等不计入必需的记录）。

**基准的迁移。** `bench-window`（冷启动到可操作、页面切换反馈、笔记保存、对话栏载入）、`bench-reader`（设置盖在阅读器上的内存增量，设置现在是盖住工作区的视图，播放器标签在它下面保持挂载）、`bench-canvas`（经项目标签打开白板、导图）三份原基准的步骤换成标签与上下文的写法，目标与测量方法不变；新增 `bench-workspace`（第 7 节）。

## 7. 基准与验证基线

A 复核的修复之后的最终源码上 `node scripts/verify.mjs`、`stage test`、`package`、`bench`、`report` 全部通过（2026-10-24，Windows 开发机，Node 24.19.0，Electron 44.9.3，不是基准参考机），入库证据是这一轮的结果；过程（`package` 第一遍有一项拖动观察在用户使用机器时失败、源码不变重跑通过，基准开跑时的空闲与前台）见 14.1。第 12 节的复跑对返工之前的源码有效，第 13 节 B 的复跑对 A 复核之前的源码有效。

| 检查 | 结果 |
| --- | --- |
| `verify` | 通过：类型检查、文档检查（70 份文档、83 个需求、122 条验收用例）、发布检查、依赖边界与 Vitest 2666 个用例（2654 passed、12 skipped） |
| `stage test` | 必需用例 156/156 passed；Vitest 2666 个用例：2656 passed、0 failed、10 skipped（默认关闭的真实服务与真实样本探针） |
| `stage package` | passed：Electron 44.9.3 未签名本地包，不访问外网，16 个阶段（新增 `workspace-restart`、`workspace-migrated`）与缺资产负例；80 个必需窗口观察（共记录 84 项，全部通过） |
| `stage bench` | passed：42 项门槛全部在目标内（原有 33 项 + 本阶段新增 6 项 + 返工新增 3 项） |
| `stage report` | 退出码 0，`automationStatus` 为 `self-check-passed`，`productAcceptance` 恒为 not-run |

**本阶段新增的六项基准**（p95，除标明外单位 ms；窗口 1920×1040，真实指针按下标题或侧栏行，计时在页面内，从按下到目标内容被画出）：

| 指标 | 结果 | 门槛 | 测量 |
| --- | --- | --- | --- |
| 切换标签（目标已挂载）到内容可见 | 15.4 | ≤ 100 | 一栏里 9 个标签轮流按，90 次采样；其中有阅读器 |
| 切换上下文到焦点标签可见（上下文都已挂载） | 14.3 | ≤ 300 | 三个访问过的上下文轮流按，36 次 |
| 切换上下文（重启后首次恢复） | 22.7 | ≤ 2000 | 重新载入页面，每个非当前上下文按一次，16 次 |
| 四宫格（两路视频其一播放、漫画、文稿）晚到帧占比（%，五次取最大） | 0 | ≤ 2 | 页面拿到的帧里，间隔超过单栏同一视频的 1.5 倍的占比（五次各 6 秒） |
| 四宫格相对单栏视频的应用工作集增量（MiB，三次取最大） | 38.0 | ≤ 600 | 每个采样一个独立窗口 |
| 打开 10 个阅读器标签并轮流切换后，挂载的阅读器数比可见栏数多几个 | 2 | ≤ 2 | 单栏里 10 个阅读器标签，轮流按两遍后内容在页面里的有 3 个，其余按需休眠 |

**原有 33 项门槛**（目标与测量方法不改，窗口基准的步骤换成标签与上下文的写法（第 6 节），再换成图标栏、侧栏与设置视图的写法（第 13.2 节））：检索 / 上下文构建 / 已索引首屏 0.7 / 0.9 / 1.9；笔记保存 / 进度保存 / 冷启动 1.7 / 2.4 / 22；窗口导航 → 页面 / 书架 → 正文可见 / 输入 → 保存回执 / 导入 → 可读 22 / 354 / 484 / 839；规模 Profile 启动 → 资源库可操作 983，页面切换反馈 17.7，10 MiB TXT 末尾 468.1，30 MiB EPUB 末尾 726.7，保存回执 556.8，后台解析期间页面切换 14.9、保存回执 746.6；5000 个文件的后台扫描期间主进程事件循环延迟 p99 22.1、常用操作答复 17.0；白板 500 张卡片打开 38.2、拖动 4.3、缩放 8.2；导图 1000 个节点折叠展开 56.3；语义检索 1 万分段 21.2（无扩展的回退 66.6）；粗剪导出开销 21.7；BT 未校验分片 0；视频导入 50 个到整季列为一部作品 2100 ms、读遍数据包 0 次；弹幕一集 3000 条评论的晚到帧 0.1%；阅读器设置盖在视频上的工作集增量 166.1 MiB；调用追踪开销 3.1；笔记文件写入 3.4。返工新增的三项：点图标切换视图 6.1、搜索框名字结果 3.5、进出设置 24.3（13.3）。

记录项（不设门槛）：扫描吞吐 207—214 文件/秒（5000 个文件耗时 23.4—24.1 s）；封面缩略图冷读 p95 10.7、热读 0.6；右栏载入 1000 条消息后输入到提交并布局 p95 28.3。门槛靠近的两项对机器状态敏感：30 MiB EPUB 末尾（门槛 2000 ms，本次 727 ms）与 1000 个导图节点折叠展开（门槛 100 ms，本次 56 ms，比上一阶段的 40 ms 高，仍在门槛的六成以内；导图现在在项目标签里，页面更大）。后台解析期间的保存回执本次 746.6 ms（门槛 1000 ms），也随机器状态起伏（B 的两遍是 601 ms 与 755 ms）。

## 8. 源码指纹

四份指纹在 `test`、`package`、`bench`、`report` 的证据里一致（`report` 复核）。下表是 A 复核的修复之后的最终源码，与 `docs/evidence/gate/` 一致：

| 指纹 | 值 |
| --- | --- |
| 源码（`packages`、`apps/desktop`、`plugins`、根清单） | `154b65590a277e6396496d96771f441466bcbfaacf52244d2504e206a17f72dd` |
| 锁文件 | `f4c9a5ebe492c4162531407f4c9f4a4b080e020a6f342edbfde4d8c5b2a0f0a4` |
| 测试与阶段脚本（`tests`、`scripts/stage*`、`scripts/samples`、`vitest.config.ts`） | `3e1306fc8a2ad2cff3cdda1ae103125b7190911f54ba96b5f5da82000565575f` |
| 构建配置（Forge、Vite 等） | `ce748e107ee92e4f8c2a5eba2a17784490b7a6bb9821a95ca619b4a0c23a9e90` |

提交之后改动这四类文件中的任何一类，证据都要重跑（A 审查时直接修复也一样）。

## 9. 实施中发现并修复的问题

| 现象 | 根因与修复 | 守护 |
| --- | --- | --- |
| 在上下文之间来回切换会改变资源库卡片上显示的来源 | 阅读器每次载入都报告同一个位置，`last_interaction_at` 随之更新，“最近一次”在两个上下文之间跳来跳去。位置、已读区间与完成状态都没变时不再写入也不抬高时间 | `tests/library/progress-contexts.test.ts`（“不因重复说出已有的位置而成为最近的上下文”） |
| 点标签标题后播放器听不到空格键 | 键盘焦点留在标签标题上。切到一个标签（按标题、`Ctrl+N`、`Ctrl+Tab`）后把焦点交给它的内容 | `tests/shell/state-retention.test.tsx`（“hands the keyboard to the tab's content…”） |
| 重启走查读错上下文的标签 | `workspace-restart` 走查切换上下文后仍以开始时的上下文为准；改为随切换更新 | 窗口观察 `workspace-restart` |
| 对话重启走查（`agent-restart`）找不到刚才的对话 | 证据截图的收尾步骤点了“新对话”，下次启动回到的就是新的空对话。截图不再改变状态，只拍阶段结束时的对话 | 阶段 `agent-restart` |
| 阅读阶段（`reading`）偶发找不到总览的分区 | 资源库为空时总览用一句空状态代替各分区，原检查靠载入过程中分区短暂出现才通过；改为检查空状态本身 | 阶段 `reading` |
| 内存基准的单栏视频阶段挂起 | 四宫格里播放器还没就绪就读 `video` 元素，页面脚本里未处理的拒绝使阶段不退出；加入就绪等待与保护 | `bench-workspace-memory` |
| 截图拍到读取中的一帧（LOOP-22 第（2）项） | `capturePage` 不等页面画出；现在可带页面标志，等到它画出再等两帧才取图，创作走查的项目页与窗口走查的作品主页都带标志 | 走查截图 |
| 控制器测试环境里的 jsdom 30 差异 | 见第 3 节 | `tests/helpers/setup-dom.ts` |
| 不在前面的标签页的内容透过前面的页面画出来（白板、导图的节点） | dockview 对 `renderer: "always"` 的非活动标签只在叠加层上设 `visibility: hidden`，而白板、导图的节点自己设了 `visibility: visible`，不受父级隐藏影响。样式表里给被隐藏的叠加层下的所有后代加 `visibility: hidden !important`（选择器不能带主题类：叠加层不在主题元素之内） | 窗口观察 `dock-follows-focus`（数出隐藏叠加层里仍被画出的部件，必须为 0） |
| 窗口走查在标签刚切到前面时点击或输入落空 | 隐藏的烟测窗口没有 rAF，dockview 约每秒一次才把标签放到前面，刚挂载的内容有一刻是 `visibility: hidden`。烟测的点击与输入先等元素被画出（`waitDrawn`）：`formats` 点“位置”、`reading-loop` 重启后的正文、`trace-walk` 等通知条收起后再点“复制”，窗口基准用 `view.showInactive()` | 阶段 `formats`、`reading-loop-restart`、`trace`；`bench-window` |
| 窗口走查里拖动或按键后立刻取宽度会少一步（`frame-resize` 偶发） | 页面在输入事件之后才渲染，第一次取值可能还是上一步的宽度（拖到 296、期望 320）。取值前等宽度稳定（连续三次相同，至多 2 秒），断言不变 | 窗口观察 `frame-resize` |
| 基准的进度写入缺 `contextId` | 契约改为必须带上下文后，`bench` 与 `bench-scale` 两个脚本还在用旧输入，只有 `stage.mjs bench` 才会跑到；两处都补上 `contextId: null`；打包阶段不跑基准，所以跑最终链之前先单独跑一遍 `bench` 找这类破损 | `scripts/stage/bench*.mjs` |
| 工作区基准的四宫格准备步骤偶发 `videoB has no tab` | 标签栏在页面画出之后才加上新标签的标题，准备步骤一画出就读标签列表，偶尔读空。准备步骤最多等 5 秒等标题出现（只在准备阶段，不进任何计时） | `bench-workspace` |
| 发布检查拦下窗口观察记录里的本机路径 | `split-focus-keys` 为查“按键被谁吞了”记录了 `play`、`pause` 与 `preventDefault` 的调用栈原文，其中带着打包应用的位置；改为只记函数名 | `scripts/check-publication.mjs`（扫描 `docs/evidence/gate/`） |
| `electron-forge package` 偶发 `fetch failed` | 打包复制文件时的网络瞬断，与源码无关；整体重跑即可 | 重跑 |

## 10. 已知限制与登记的后续项

- **窗口关闭时最后半秒的保存可能丢失**（[LOOP-23](status.md#loop-23)）：布局保存在最后一次变化后约 500 ms 发出，页面卸载时的补发在主进程已销毁窗口时可能没有送达。
- **工作区的小限制**（[LOOP-24](status.md#loop-24)）：关闭最后一个标签后重新加载是否仍为空只由控制器用例覆盖；“重新打开”放到焦点栏末尾；焦点在 dockview 标签上时 Delete / Backspace 会关闭标签；资源库标签从书架打开阅读器时会累积；四宫格基准里的“文稿”用笔记标签代替；搜索框在媒介范围下的资源正文命中不按媒介过滤；侧栏何时重新读取按命令清单决定（后两条是 A 复核时记的，第 14 节）。
- **测试临时目录没有清干净**（[LOOP-25](status.md#loop-25)）。
- 真实 Profile 的 v12 迁移在副本上重放没有做（[ACT-11](../../USER-ACTIONS.md#act-11)，A 审查时一次授权）。真实资源库的只读试验（计划要求可选）本阶段没有做，没有记录聚合结果。
- 没有任何真实模型、弹弹play 或 Bangumi 调用；所有样本合成。
- 顺延的 Agent 侧后续项（LOOP-05、LOOP-07、LOOP-09、LOOP-17、LOOP-20）与 pi-ai 1.x 的升级按计划保留在[执行状态的后续 loop](status.md#followup-loops)。
- 项目概览卡上的“会话数”只统计已经说过话的对话（新对话在第一句话之前不入库），所以刚建好的项目显示 0 个会话而侧栏已有“新对话”入口，这是预期。

## 11. 人工检查、待用户事项与 A 的审查要点

**人工检查（[用户待办](../../USER-ACTIONS.md#checks)）。** 新增 H-58—H-66（窗口框架与菜单、标签页的打开与恢复、四种分屏与拖动、一边看原作一边写文稿、项目与“最近”的切换、同一文件在两个项目里的进度、对话栏跟随焦点、升级后的对话与已打开资源、内存与流畅度的主观感受），全部 not-run；旧项里 H-19、H-26、H-27、H-35 标“作废”并写明由哪项取代，H-46、H-47 等受影响的标“需重测”。试用反馈的返工（第 13 节）又新增 H-67—H-70（功能视图与主页、隐藏图标与悬浮卡片和侧栏色、搜索框、设置视图）并改写 H-58、H-59、H-62、H-64，H-15、H-51 里“设置 › 记录”的说法改成对话管理与笔记管理，状态都是 not-run。

**待用户。** [Q-33](../../USER-ACTIONS.md#q-33)（B 先按推荐值实现，以后都可以改）；[ACT-11](../../USER-ACTIONS.md#act-11)（真实 Profile 的 v12 迁移在副本上重放，A 审查时一次授权）；远端操作授权（push、PR、合并）在 A 审查收敛后登记。

**A 审查时重点看**（计划第 9 节）：

1. 迁移的数据正确性与回滚：`schema-v12-migration.test.ts` 的 7 个用例与 `migrate-workspace.ts` 对“两种模式下同一（kind、target）各有一段对话”的处理；v11 合成资料由 `tests/helpers/legacy-v11.ts` 造出而不是由新代码造出。
2. 进度三类用途有没有归错：第 5 节的表与 `progress-contexts.test.ts`。
3. 项目命令与材料自动加入的授权边界：`tests/agent/context-binding.test.ts`、`tests/creative/project-materials-origin.test.ts`。
4. 分屏下的快捷键路由与全屏：窗口观察 `split-focus-keys`、`window-fullscreen.test.tsx`。
5. 资源占用：第 7 节的六项基准。
6. 走查断言没有被放宽：第 6 节的迁移映射（断言总数增加，减少的文件逐个说明）。
7. 不在前面的标签不透出：`styles-frame.css` 里对隐藏叠加层的规则与窗口观察 `dock-follows-focus` 的计数（第 9 节第一条）；以及烟测里新增的“等元素被画出”（`waitDrawn`）是否只是等待、没有放宽断言。

<a id="a-review"></a>
## 12. A 审查（2026-10-23）

> 本节记录的是返工之前的源码上的审查与复跑；用例与观察的数量、基准与指纹以第 7、8、13 节（返工后的最终源码）为准。

A 按计划第 9 节与第 11 节的七个要点审查阶段提交：逐项读代码、测试与 `docs/evidence/gate/` 的证据，核对迁移、归类与授权的边界，以及改写的测试与走查有没有放宽。**结论：审查收敛。** 发现两处数据与授权的局部缺陷、一处设计文档的冲突，并加强了一项窗口观察的计数；都由 A 直接修复并补了守护，没有需要交回 B 的跨模块缺口。A 的修复改了源码与测试，所以门禁在最终源码上重跑，`docs/evidence/gate/` 换成重跑的结果。

### 12.1 复跑结果（最终源码）

| 检查 | 结果 |
| --- | --- |
| `verify` | passed：类型检查、文档检查（70 份文档、83 个需求、118 条验收用例）、发布检查、依赖边界与 Vitest 2564 个用例（2552 passed、12 skipped），比第 7 节多 1 个，是 A 新增的迁移用例 |
| `stage test` | passed：必需用例 152/152；Vitest 2564 个用例，2554 passed、0 failed、10 skipped |
| `stage package` | passed：Electron 44.9.3，16 个阶段与缺资产负例；窗口观察 78 项全部通过（必需 74 个）。`dock-follows-focus` 的计数：隐藏的标签 8 个，其中白板卡片 2 张，透出的部件 0（12.3 的第 4 条） |
| `stage bench` | passed：39 项门槛全部在目标内，目标与测量方法没有改。六项新基准：切换标签 16.1 ms、切换上下文 16.4 ms、重启后首次恢复上下文 22.0 ms、四宫格晚到帧 0%、四宫格工作集增量 37.9 MiB、挂载的阅读器比可见栏数多 2 个；对机器状态敏感的两项：30 MiB EPUB 末尾 775 ms（2000 ms）、导图折叠 p95 58.6 ms（100 ms）。开跑前用户已空闲约 54 分钟、CPU 约 3%，启动基准的应用在前台；每 15 s 记一次前台，32 次里 23 次是它，9 次是基准自己打开的应用窗口，没有别的应用（LOOP-13） |
| `stage report` | 退出码 0（`automationStatus: self-check-passed`，`engineeringReviewable: true`，错误列表为空）；四份指纹在各份证据里一致，见第 8 节 |

`productAcceptance` 仍是 not-run。

### 12.2 逐项核对

| 要点 | 核对结果 |
| --- | --- |
| 1 v12 迁移 | **合成资料独立于新代码：** 用 `c22d886` 的建表语句按旧版的迁移顺序建一个新库，与 `tests/helpers/legacy-v11.ts` 造出的 v11 资料逐个比较表、索引、视图与触发器，去掉空白差异后完全相同（比较用的临时用例审查后已删除）。**备份、回滚与重复执行：** 备份在事务之前复制，不含 `agent_requests`；`migration-before-version` 处中断后库仍是 v11 的形状与行，重试得到与直接迁移相同的结果、只有一份备份；用备份还原后再迁移结果相同；第二次启动不改动；较新版本被拒绝且不被改动。`migrateWorkspace` 在迁移事务内运行，每一步可重复。**发现：** v11 删除项目时只清空项目会话的 `project_id`，迁移按 `target_id` 把它补回已不存在的项目，侧栏和“最近”都找不到这段对话。A 已修复，见 12.3 的第 1 条 |
| 2 进度的三类归类 | 第 5 节的表与代码一致：阅读器恢复、保存、已读区间与续读取当前上下文（A 类）；卡片百分比、“已读／已看”标记、“最近打开”与作品主页的继续阅读取 `progress_latest`（B 类）；防剧透前沿、Agent 的已看范围与字幕窗口取最远（C 类，`frontierProgress` / `frontierConsumed`）；“在别处看到”的提示单独取（`elsewhereProgress`）。资料包只导出“最近”的位置，项目里的位置随项目的部分走；导入时目标资料没有那个项目的位置归入“最近”，同一修订已有位置时留较新的一个。`progress-contexts.test.ts` 覆盖了这三类，没有归错的 |
| 3 项目命令与材料 | 项目命令只在会话的 `project_id` 指向一个存在的项目时授予；`contextId` 由任务按对话所在的上下文填入，模型看不到也改不了；“最近”里的对话没有项目命令。自动加入的材料尊重排除记录，用户手动加入会清除排除。**发现：** `project.addMaterial` 对模型隐藏了 `origin`，但命令层不拒绝它：模型传 `origin: "auto"` 时，它的添加被标成“自动”，碰到用户排除过的材料还会被静默跳过（修复前用例实测得到 `{ skipped: "excluded" }`）。A 已修复，见 12.3 的第 2 条 |
| 4 快捷键路由、全屏与资源占用 | 漫画、视频、小说三个阅读器的按键处理在标签不在焦点时直接返回；窗口全屏只放大获得焦点的那个面板。六项新基准的测量方法与第 7 节一致（真实指针、页面内计时、到目标内容被画出），门槛没有放宽 |
| 5 断言与等待 | 第 6 节的迁移映射与代码一致：`tests/` 的 `expect(` 总数增加，6 个减少的文件逐个对应被删除的模式断言或改为在阅读器里断言位置。`waitDrawn`、`PICK`、`DRAWN` 只决定什么时候点、点哪个，不改变断言；`settledWidth` 只等宽度连续三次相同（至多 2 秒），比较时的容差与原来相同 |
| 6 隐藏标签不透出 | 根因确认：白板与导图的节点由 `@xyflow/react` 写了内联的 `visibility: visible`，不随 dockview 隐藏的叠加层一起隐藏，所以 `styles-frame.css` 的规则必须用 `!important`。规则依赖 dockview 把隐藏写成内联样式，这一点由窗口观察守护。**加强：** 原来的观察只要求“有隐藏的标签、透出的部件为 0”，没有要求白板卡片在隐藏的标签里；如果卡片还没挂载，0 也会通过。A 加了这一条，见 12.3 的第 4 条 |
| 7 截图 | 抽看了工作区、菜单、同一文件、项目页与对话栏的截图，扫描了证据里的全部 JSON：没有本机路径与用户名。重跑后换入的截图同样核对过（12.4） |

另外核对了交互设计文档与界面的一致性，**发现** 3.5—3.7 仍按旧外壳描述顶部一行与菜单，而 3.6 声明与第 2 节冲突时以它为准。A 已修复，见 12.3 的第 3 条。

### 12.3 A 直接修复的

| 编号 | 问题 | 修复与守护 |
| --- | --- | --- |
| M4-A01（P2） | v11 删除过的项目留下的项目会话，迁移后挂在不存在的项目下，界面上找不到 | `packages/storage-drizzle/src/migrate-workspace.ts`：项目已不存在的项目会话改为“最近”里的普通对话（`kind = 'shared'`，清空 `target_id` 与 `project_id`），与 v12 删除项目的处理相同；数目记在迁移结果的 `fromDeletedProjects`。**守护：** `schema-v12-migration.test.ts` 新增用例：在 v11 资料里加一段项目已删除的项目会话，迁移后它是“最近”的普通对话、没有指向不存在项目的项目会话，应用里“最近”的历史列出它。修复前这个用例失败。领域模型、计划 4.8、H-65 与 Q-33 第 8 条同步 |
| M4-A02（P3） | Agent 调用 `project.addMaterial` 时可以带上对它隐藏的 `origin` | `packages/app-core/src/creative/agent-access.ts`：带 `origin` 的调用以 `FORBIDDEN`（`agent-option`）拒绝，与 `draft.suggest` 对隐藏参数的处理一致；Agent 添加的材料都是“手动”。**守护：** `tests/agent/creative-tools.test.ts`：Agent 添加的材料来源是 `manual`；带 `origin`（`auto` 或 `manual`）都被拒绝且不写入；工具清单里没有 `origin`。修复前用例失败 |
| M4-A03（文档） | 交互设计 3.5—3.7 仍写“中间是当前标签的标题”和旧菜单（设置、扫描资源库、调试面板、关于、退出），3.6 声明与 2.x 冲突时以它为准；2.5 的文件菜单漏了“扫描资源库” | `docs/design/interaction-and-workflows.md`：第 2 节写明它是应用壳的正本、3.4—3.8 冲突时以第 2 节为准；3.5、3.6、3.7 的顶部一行改为按 2.1 与 2.5；标题在标签上；指向 2.3、2.5 的旧编号改为 2.6；2.5 的文件菜单补上“扫描资源库”（与界面一致） |
| M4-A04（观察） | `dock-follows-focus` 的“透出 0”没有证明白板卡片真的在隐藏的标签里 | `apps/desktop/src/main/smoke/workspace-walk.ts`：另数隐藏叠加层里的 `.react-flow__node`，为 0 时观察失败，并记为 `boardCards`。重跑结果为 2 |

### 12.4 证据

- `docs/evidence/gate/` 换成重跑的结果：全部 JSON 与原来保留的 30 张截图，共 4,443,995 字节（4.24 MiB），四份指纹见第 8 节。
- 换入前看过新的截图（项目页与对话栏、迁移后的资料、截图后的提示、调用记录、删除对话的确认、带嵌入的笔记），保留的截图里没有本机路径与用户名，JSON 里也没有；`check-publication` 扫描通过。运行目录里的 `ui-walk-library-paths-wide.png` 画着临时资源库的完整路径（含用户名），它不在保留的 30 张里，没有换入。
- 跑基准时 A 的一个检查命令误把工作区的改动暂存了几秒（`git stash`），随即恢复，文件内容没有变化。为了不让那几秒里启动的子进程读到旧源码，基准在恢复后的源码上整体重跑，入库的是重跑的结果。

### 12.5 限制

- 第 10 节的限制沿用。真实 Profile 的 v12 迁移重放仍待 [ACT-11](../../USER-ACTIONS.md#act-11)；真实资源库的只读试验本阶段没有做。
- 产品验收仍是 not-run：人工检查 H-58—H-66 与标了“需重测”的旧项都没有执行。
- 隐藏叠加层的样式规则依赖 dockview 把隐藏写成内联的 `visibility: hidden`；dockview 改写法时规则会失效，由 `dock-follows-focus` 发现。

### 12.6 同步的文档

- 交互设计：第 2 节的正本声明，3.5—3.7 的顶部一行与菜单，2.5 的文件菜单。
- 领域模型与阶段计划：v12 迁移对已删除项目的项目会话的处理。
- 用户待办：H-65 加上“旧版本里删除过的项目”的步骤与预期，Q-33 第 8 条同步；登记 [ACT-12](../../USER-ACTIONS.md#act-12)（本阶段的 push、PR 与合并）。
- 执行状态：当前阶段、验证基线、已处理的审查发现与推荐下一步。
- 文档登记表：上面几份文档的核对日期。

### 12.7 下一步

审查收敛时的推荐是请用户授权 [ACT-12](../../USER-ACTIONS.md#act-12)（push、PR 与合并）。同日用户看了新外壳，提了 8 条试用反馈（A-99—A-101），改为本阶段的返工 M4-U01—M4-U08，见[阶段计划第 12 节](stage-plan.md#feedback-shell)；ACT-12 暂缓到返工复核收敛。本节的复跑与修复对 `a5db653` 有效，返工后的门禁与复核由 B 的返工报告和 A 的复核另记。

<a id="rework-shell"></a>
## 13. 试用反馈的返工：图标栏、侧栏、搜索与设置（A-99—A-102）

计划第 12 节的返工，B 连续完成 R1—R9，amend 进同一个阶段提交；没有新增依赖（搜索框用已在依赖里的 Radix Dialog，悬浮卡片用现有的悬停状态机，右键菜单、“…”与图标沿用 `workspace/context-menu.tsx`、`components/menu.tsx`、lucide-react）。依据与默认值：[A-99—A-102](../decisions/confirmed-decisions.md)、[Q-34](../../USER-ACTIONS.md#q-34)（用户答复“按推荐”）。产品验收 not-run。

### 13.1 问题 → 实现位置 → 验证 → 状态

| 编号 | 实现位置 | 验证 | 状态 |
| --- | --- | --- | --- |
| M4-U01 标签与布局按项目 | 本来就是这样：`packages/app-core/src/workspace-service.ts` 的 `workspace.loadContext` / `saveContext`、`renderer/workspace/controller.ts` 的上下文切换。让人觉得不是的原因是资源库、搜索、记录、设置从图标栏打开时都落进当前项目的标签里；新外壳里保持的办法：从侧栏点一项时先切到它所在的上下文再打开（`workspace/openers.ts` 的 `item` 在 `contextId` 与当前不同时先 `switchContext`），搜索与设置不再是标签（`search-box.tsx`、`shell-state.ts`），管理入口是各上下文自己的标签 | 窗口观察 `context-switch`（含从视图点别的项目的一项）、`rail-views`（对话、笔记、白板各从“最近”或别的项目点一项，窗口落在它的上下文并打开了标签）、`search-popup`（项目的对话与白板从搜索框打开，窗口落在项目里）；`tests/shell/sidebar-ui.test.tsx`、`workspace-flows.test.tsx` | 保持，已验证 |
| M4-U02 每种功能一个图标，侧栏只列这一类 | R1 数据：`packages/contracts/src/sidebar.ts`（`RAIL_VIEWS`、`RailPreference`、视图列表的输入输出）、`inputs-workspace.ts`（`workspace.sidebar`、`workspace.items`、`workspace.objects`、`workspace.find`，只放进 `OWNER_COMMANDS`）、`packages/app-core/src/sidebar-service.ts`；R2 图标栏：`renderer/rail.tsx`；R3 侧栏：`renderer/sidebar.tsx`、`sidebar-data.ts`（分页与刷新）、`workspace/views/records-tab.tsx`（对话管理、笔记管理）、`objects-tab.tsx`（白板、导图、文稿、粗剪的对象管理）、`lib/object-kinds.ts` | `tests/library/sidebar-lists.test.ts`（列表命令：分组、分页、已删除与打不开的不列、项目被删或归档后即时更新）、`tests/shell/rail-ui.test.tsx`、`sidebar-ui.test.tsx`；窗口观察 `rail-views`；基准 `scaleRailSwitchP95Ms` | 完成 |
| M4-U03 右键隐藏、“…”找回 | `rail.tsx`（右键菜单、“…”、图钉、键盘可达）、`packages/app-core/src/domain/shell-layout.ts` 的 `railLayout`（按实际高度算哪些放得下）、外壳偏好 `RailPreference.hidden`（v2 里的可选字段，旧记录照常读） | `tests/shell/rail-layout.test.ts`、`rail-ui.test.tsx`；窗口观察 `rail-hide-more`（隐藏两个、“…”里点进入、图钉放回、矮窗放不下的进“…”、重载后保留）与 `workspace-restart` 阶段（重启后隐藏与设置页记忆） | 完成 |
| M4-U04 侧栏收起时悬停图标浮出卡片 | R4：`shell.tsx` 与 `domain/shell-layout.ts` 的悬停状态机（目标从“侧栏”推广为 `card:<视图>`）、`styles-frame.css`；窄窗自动收起用同一张卡片；侧栏行的信息小卡在 `sidebar.tsx` | `tests/shell/rail-ui.test.tsx`、`shell-ui.test.tsx`；窗口观察 `rail-hover-card`（真实鼠标与键盘：悬停、斜移进卡片、点图标与点卡片里的一项后侧栏仍收起、Enter 与 Esc 还焦点、点外面收起） | 完成 |
| M4-U05 主页与按类型的小组 | `sidebar-service.ts` 的主页视图、`sidebar.tsx` 的项目分组、类型小组与“最近” | `sidebar-lists.test.ts`、`sidebar-ui.test.tsx`；窗口观察 `rail-views`（主页的两个分组、展开项目、四个入口） | 完成 |
| M4-U06 侧栏色 | `renderer/styles.css` 的 `--color-sidebar`（浅 `#F9FAFB`、深 `#1A1D27`）、`styles-frame.css`（侧栏、悬浮卡片、设置目录）；数值与对比度写进设计规则第 8 条 | `tests/shell/sidebar-tokens.test.ts`（介于窗框色与页面色之间、对比度、没有另写色号）；窗口观察 `frame-flat-chrome`（计算后的底色）、`rail-hover-card`；截图 `sidebar-dark` | 完成 |
| M4-U07 搜索框 | `renderer/search-box.tsx`（Radix Dialog，范围标记、即时名字结果、回车搜正文、语义组）、`shell-state.ts`（`Ctrl+K`、范围规则）、键位 `global.search`（`Ctrl+K`）；删除 `SearchTab` 与图标栏的搜索 | `tests/shell/search-box-ui.test.tsx`、`shell-state.test.ts`；窗口观察 `search-popup`；基准 `scaleSearchNamesP95Ms` | 完成 |
| M4-U08 设置视图 | `renderer/shell-state.ts`（设置状态与后退前进）、`workbench.tsx`（`workspace-area` 保持挂载、`settings-area`）、`pages/settings/settings-nav.tsx`（图标加文字、筛选）、`settings-pane.tsx`（滚动记忆）、`lib/shell-model.ts`；取消 `workspace/views/settings-tab.tsx`，记录移出设置 | `tests/shell/settings-view-ui.test.tsx`、`shell-state.test.ts`；窗口观察 `settings-view`（`currentTime` 连续、`emptied` 与 `loadstart` 都是 0）、`legacy-tabs-dropped`、`settings-pages-reachable`（3 组 17 页）；基准 `scaleSettingsP95Ms` | 完成 |

**设置进出不重新载入的证明（要求 4）。** 打包窗口里 `settings-view` 在 `data-testid="video-element"` 上做记号后进入设置：`workspace-area` 为 `data-suspended="true"`、`inert`、`visibility: hidden`，元素仍在文档里；进入、后退前进、离开的全过程里 `emptied` 与 `loadstart` 计数都是 0，`currentTime` 在离开后与进入时相差在 2.5 秒内（本次进入前 1.28 s、设置里 1.287 s、离开后 1.29 s，是同一个视频元素，没有重新载入）；离开后标签、布局与停靠栏的序列化结果与进入前完全相同。

### 13.2 迁移映射与断言不减

| 原 | 新 |
| --- | --- |
| 图标栏 `nav-library` | `nav-home` + 侧栏 `sidebar-entry-library`（资源库标签）；各媒介书架是对应视图的 `sidebar-manage` |
| `nav-projects` | 主页的 `sidebar-entry-projects`（项目总览标签） |
| `nav-records` | 对话视图与笔记视图的 `sidebar-manage`，打开 `records-tab[data-type]` |
| `nav-search` | 侧栏的 `sidebar-search` 与 `Ctrl+K`，打开 `search-box`（不是标签） |
| `nav-downloads` | 下载视图（安装了下载插件时才有图标）的 `sidebar-manage`，打开下载标签 |
| 设置标签与 `settings-tab`、插件标签、键位标签 | 设置视图 `settings-area[data-page]`；插件与键盘快捷键是设置页；载入旧布局时去掉这三种与搜索标签（`legacy-tabs-dropped`） |
| 设置分组 4 个（基础、Agent、记录、日志） | 3 个（基础、Agent 能力、日志），记录页移出（`settings-pages-reachable` 17 页，原 18 页含记录） |
| 侧栏色 = 窗框色 | `--color-sidebar`；`frame-flat-chrome` 的“侧栏”一项比较侧栏色，其余仍是窗框色，主区仍是页面色 |
| `frame-rail` 的“更多/收起” | 侧栏的“更多”只增不减：断言改为再点一次不会变少、图标与设置按钮不动，其余（矮窗不滚、设置按钮在窗口里、侧栏自己滚动）不变 |
| `manage-conversation-delete`（设置 › 记录 › 对话） | 对话视图 `sidebar-manage` → 对话管理标签；逐项断言（行布局、确认框三段、删一条总数减一、笔记不丢）不变 |
| `manage-copy-titles` 的设置页标题 | 在 `settings-area` 里找页标题；其余页仍在标签的前景里找，泄漏检查与六行数量不变 |
| `workspace-frame` 的 `gone` 清单（窗口里不该再有的部分） | 去掉 `nav-comic`、`nav-video`、`nav-novel`（新图标栏有它们，改为在 `frame-rail` 里要求存在）；加上 `nav-library`、`nav-projects`、`nav-search`、`nav-records`，另在 `frame-rail` 里断言图标栏没有这四个旧入口 |

测试：`tests/` 里 `expect(` 的总数从 11517 增到 12092，用例从 2134 增到 2222；没有任何一个原有文件的断言数减少（改动的 14 个文件逐个核对：新增或持平）。新增文件：`sidebar-lists`（109 条断言）、`rail-layout`、`rail-ui`、`search-box-ui`、`settings-view-ui`、`shell-state`、`sidebar-tokens`。`scripts/stage/gate.json` 里沿用的用例，凡测试名随改写变了的，匹配式都改成新的用例名（匹配不到的用例会让 `stage test` 判为 not-run），并新增 AT-119—AT-122 四个用例；`workspace-frame`、`tabs-open-restore`、`dock-follows-focus`、`workspace-menu`、`context-switch` 五个观察改写后断言不减，`dock-follows-focus` 的白板卡片计数（M4-A04）与另三处 A 的修复及守护测试保留。新增必需观察六项：`rail-views`、`rail-hide-more`、`rail-hover-card`、`search-popup`、`settings-view`、`legacy-tabs-dropped`；`workspace-restart` 阶段增加隐藏图标与设置页记忆的核对。必需窗口观察 74 → 80（共记录 78 → 84 项）。

### 13.3 基准与验证

| 指标 | 结果 | 门槛 |
| --- | --- | --- |
| 点图标切换视图到侧栏列表画好 p95（规模样本） | 6.1 ms | ≤ 100 |
| 搜索框里输入后名字结果出现 p95（规模样本） | 2.8 ms | ≤ 200 |
| 进入设置与离开设置回到工作区画好 p95 | 24.5 ms | ≤ 150 |

B 在返工后的源码上跑的 `verify`、`stage test`、`package`、`bench`、`report` 全部通过（Vitest 2664 个用例，三项基准 6.1 / 2.8 / 24.5 ms）；A 复核的修复之后重跑的结果与四份指纹见第 7、8 节与 14.1。

`docs/evidence/gate/` 换成这次最终源码的结果（A 复核后又换成 14.4 的那一轮，文件不变）：全部 8 份 JSON 与 35 张截图，共 4,990,399 字节（4.76 MiB，上限 5 MiB）。截图是上一阶段保留的 30 张里的 26 张（为了放进上限，去掉了小说阅读（宽）、视频截图、播放器窗口全屏与文件菜单四张）加 9 张新的：主页视图、白板视图、悬浮卡片、“更多”菜单、矮窗口的图标栏、矮窗口的外壳、搜索框、设置视图与深色侧栏。换入前每张新截图都看过，没有本机路径与用户名；`check-publication` 扫描通过。

### 13.4 没做与限制

- 人工检查 H-67—H-70 与改写后的 H-58、H-59、H-62、H-64 都是 not-run；悬浮卡片的手感、侧栏色的观感、搜索框的输入法行为只有窗口观察，没有人试过。
- 下载视图只有在安装了下载插件时才有图标；`window-walk` 的资料没有装插件，所以侧栏内容与“管理”入口由 `plugins` 阶段（`viaSidebar(…, "downloads", "sidebar-manage")`）和 `sidebar-lists.test.ts` 覆盖，`rail-views` 里断言它没有图标。
- 侧栏的“更多”只增不减（没有“收起”），列表的上限是 25 条一页的累加；超出时用管理标签。
- 设置页的滚动位置只在这次运行内记忆（`settings-pane.tsx` 的模块变量），重启后回到页顶；上次所在的页名保存在外壳偏好里。交互设计 2.12 已按此改写。

### 13.5 返工中发现并修复的问题

| 问题 | 根因与修复 | 守护 |
| --- | --- | --- |
| 搜索框弹层被压成一行，看不到结果；资源库页自己的搜索字段飘到页面上方、盖住筛选标签 | 弹层与书架共用 `.search-box` 类名，`styles-frame.css` 与 `styles-shelf.css` 的两份样式互相覆盖。只读 DOM 的窗口观察没有发现，是换入证据前看新截图时发现的。弹层改用 `.search-popup`（`search-box.tsx`、`styles-frame.css`），书架保留原类名 | `tests/shell/search-box-ui.test.tsx` 新增“类名只在一份样式里定义”的用例（唯一的例外是原有的 `danger-button`）；`search-popup` 观察新增“第一条名字结果在框内且无物遮挡”，`rail-views` 观察新增“资源库的搜索字段在页面里、不是固定定位” |
| 返工前就有、没跟着新外壳改的烟测：`agent` 与 `trace` 阶段直接点侧栏的“新对话”，没有先经图标栏与侧栏（侧栏不在时点不到）；`reading-loop`、`creative` 与证据截图从设置里找已经移走的“记录”页 | 只有完整的 `package` 才会跑到它们（`window-walk` 里没有）：`agent` 与 `trace` 改用 `viaSidebar(…, "home", "sidebar-new-conversation")`，记录页改用 `openRecords`（笔记视图的“管理”入口，`driver.ts`）；断言一条没有改 | `package` 全部 16 个阶段通过 |
| 基准里两处写法停在旧外壳：规模样本的“切换视图”要求列表里有名字行，白板、导图、文稿、粗剪在规模样本里没有项目，侧栏只有那句“还没有项目”；内存基准用设置标签找回播放器 | 等待改为“名字行或那句空列表的话”画好（`bench-window.ts` 的 `railSwitch` 说明已写明）；内存基准先用返回箭头离开设置视图再切回播放器（`bench-reader.ts`）。目标与测量方法没有改 | `bench` 通过 |
| `apps/desktop/src/renderer/rail.tsx` 末尾多一个空行：新文件在暂存前不受 `verify` 里 `git diff --cached --check` 的检查，第一遍门禁链是在它还没暂存时跑的 | 暂存全部新文件后检查查出，删掉空行（四份指纹随之改变）；整条门禁链在暂存后的树上重跑 | 之后收尾时先 `git add -A` 再跑最终链，`verify` 的两条 `--check` 才覆盖新文件 |

<a id="rework-review"></a>
### 13.6 给 A 的复核要点

1. M4-U01—M4-U08：按 13.1 的表逐项读实现、测试与窗口观察；M4-U01“本来就是这样”的解释要核对 `workspace.loadContext` / `saveContext` 与“先切上下文再打开”确实成立。
2. 断言不减与迁移映射（13.2）：改动的测试文件的 `expect(` 数都是新增或持平；五个改写的窗口观察与 A 的四处修复（M4-A01—M4-A04）及守护测试都在；`scripts/stage/gate.json` 的匹配式只随测试名改，没有删用例。
3. 设置进出不重新载入（要求 4）：`settings-view` 观察里同一个视频元素、`emptied` 与 `loadstart` 都是 0、离开后标签与布局序列化相同。
4. 13.5 的四项：搜索框与书架共用类名的修复与守护、`agent` 等阶段的导航迁移、基准两处写法、`rail.tsx` 的空行与门禁链重跑（四份指纹是第二遍的）；看一眼 `docs/evidence/gate/screenshots/ui-walk-search-box.png` 与 `ui-walk-workspace-frame-wide.png`。
5. 没有新增依赖（锁文件指纹与上一阶段相同）；搜索框用已有的 Radix Dialog。
6. 限制：人工检查 H-58—H-70 not-run；产品验收 not-run。

可复制的复核 prompt：

```text
你是 Agent A。在仓库根目录的分支 feat/m4-project-workspace 上复核 B 完成的试用反馈返工（A-99—A-102，一个带 DCO 签名的阶段提交，没有推送）。
先读 AGENTS.md、docs/delivery/status.md、阶段计划第 12 节与阶段报告第 13 节，按阶段报告 13.6 的六点逐项核对，不凭报告下结论：读代码、测试、窗口观察与 docs/evidence/gate/ 的证据，抽查断言数没有减少、A 之前的四处修复与守护都在、没有新增依赖。
局部问题直接修复并补守护，较大缺口一次性反馈给 B；改了源码、测试或阶段脚本的，在最终源码上重跑 node scripts/verify.mjs、node scripts/stage.mjs test、package、bench、report（bench 开跑时机器空闲、启动基准的应用在前台，期间不运行改变工作树的 git 命令），换入新的 docs/evidence/gate/（不超过 5 MiB，先看新截图，不含本机路径），把全部改动 amend 进同一个带 DCO 签名的提交并重写消息。不要 push。
结束时按开发流程 2.4 给出首选下一步：复核收敛则在用户待办里推荐 ACT-12（push、PR 与合并）。
```

<a id="rework-a-review"></a>
## 14. A 复核试用反馈的返工（2026-10-24）

A 按 13.6 的六点复核 R1—R9：逐项读代码、测试、窗口观察与 `docs/evidence/gate/` 的证据，不以第 13 节的叙述为准。**结论：复核收敛。** M4-U01—M4-U08 都已实现，断言不减、A 之前的四处修复与守护都在、没有新增依赖；发现三处界面的局部缺陷与几处文档的旧说法，都由 A 直接修复，缺陷都补了去掉修复即失败的守护，没有需要交回 B 的缺口。A 的修复改了源码与测试，所以门禁在最终源码上重跑，`docs/evidence/gate/` 换成重跑的结果；第 7、8 节的数字与指纹已改为这一轮的。

### 14.1 复跑结果（最终源码）

暂存全部改动（`git add -A`）后在最终源码上跑完整条链（2026-10-24，Windows 开发机，Node 24.19.0，Electron 44.9.3，不是基准参考机）：

| 检查 | 结果 |
| --- | --- |
| `verify` | passed：类型检查、文档检查（70 份文档、83 个需求、122 条验收用例）、发布检查、依赖边界与 Vitest 2666 个用例（2654 passed、12 skipped），比第 13 节多 2 个，是 A 新增的两个守护用例 |
| `stage test` | passed：必需用例 156/156；Vitest 2666 个用例，2656 passed、0 failed、10 skipped |
| `stage package` | 第一遍失败一项：`frame-resize` 里真实鼠标拖动停靠栏的分隔线停在 407 px（要求 440），松开后宽度没有保存；同一遍里侧栏的拖动通过，其余观察全部通过。当时用户正在这台机器上玩游戏（前台是游戏，键鼠空闲 0 秒，CPU 约 20%—30%），A 的修复不涉及停靠栏与拖动。源码不变重跑一遍：passed，16 个阶段与缺资产负例，窗口观察 84 项全部通过（必需 80 个），`frame-resize` 保存的停靠栏宽度是 440。入库的是第二遍 |
| `stage bench` | passed：42 项门槛全部在目标内，目标与测量方法没有改。开跑前用户已空闲 5 分钟以上、CPU 约 11%，游戏已关闭，启动基准的应用在前台；每 15 s 记一次前台，基准运行期间 32 次里 20 次是它、12 次是基准自己打开的应用窗口，没有别的应用，空闲时间从 328 s 一直增长到 794 s（LOOP-13） |
| `stage report` | 退出码 0（`automationStatus: self-check-passed`，`engineeringReviewable: true`，错误列表为空）；四份指纹在各份证据里一致，见第 8 节 |

`productAcceptance` 仍是 not-run。

### 14.2 逐项核对

| 要点 | 核对结果 |
| --- | --- |
| 1 M4-U01—M4-U08 | 逐项读了 13.1 表里的实现与测试。M4-U01 成立：`workspace.loadContext` / `saveContext` 按上下文分开保存标签与布局；`openers.item` 在目标上下文与当前不同时先 `await switchContext`，控制器的 `activate` 先载入那个上下文的布局再打开，所以项目乙与“最近”各自恢复（`context-switch` 观察含从视图点别的项目的一项）。图标栏、视图列表（`sidebar-service.ts` 只在 `OWNER_COMMANDS`）、隐藏与“…”、悬浮卡片的状态机（`card:<视图>`）、主页的类型小组、侧栏色、搜索框（`Ctrl+K`、范围标记、回车搜正文）与设置视图都与交互设计 2.1—2.12 一致。**发现**三处：对象管理标签的图标是“问号”；侧栏不随阅读器自动加入材料、笔记的新建与改名等变化刷新；模块停用后仍记在“隐藏”里的视图让图标栏多算一个格子。见 14.3 |
| 2 断言与迁移映射 | 逐文件比较 `c22d886` 之后改动的测试文件的 `expect(` 数：没有一个减少。`scripts/stage/gate.json` 只把随改写变名的用例匹配式换成新名，新增 AT-119—AT-122 的用例、3 项基准门槛与 6 项必需观察，没有删用例。五个改写的窗口观察都是加强（例如 `workspace-frame` 的 `gone` 清单换成新外壳里不该再有的四个入口，并另在 `frame-rail` 断言它们不在）。M4-A01—M4-A04 的修复与守护都在：`migrate-workspace.ts` 的 `fromDeletedProjects` 与迁移用例、`agent-access.ts` 对 `origin` 的拒绝与用例、交互设计第 2 节的正本声明、`dock-follows-focus` 的 `boardCards` |
| 3 设置进出不重新载入 | `scenarios.json` 的 `settings-view`：同一个带记号的视频元素，进入前在播放，`emptied` 与 `loadstart` 都是 0，`currentTime` 连续；离开后标签、布局与停靠栏的序列化与进入前相同。`workbench.tsx` 让工作区保持挂载（`data-suspended`、`inert`、`visibility: hidden`），不是重新渲染 |
| 4 13.5 的四项 | 弹层改用 `.search-popup`、书架保留 `.search-box`，守护用例检查类名只在一份样式里定义；`agent`、`trace` 改经 `viaSidebar`，记录页改用 `openRecords`，断言没改；`railSwitch` 等待“名字行或空列表那句话”画好，测量的仍是用户看到的内容，内存基准用返回箭头离开设置；`rail.tsx` 的空行已删。看了 `ui-walk-search-box.png` 与 `ui-walk-workspace-frame-wide.png`：搜索框结果在框内、资源库的搜索字段在原位 |
| 5 依赖 | 锁文件指纹与上一阶段相同，`package.json` 没有新增依赖；搜索框用已有的 Radix Dialog |
| 6 限制 | 人工检查 H-58—H-70 not-run、产品验收 not-run，与用户待办一致 |

### 14.3 A 直接修复的

| 编号 | 问题 | 修复与守护 |
| --- | --- | --- |
| M4-A05（P2） | 侧栏与对象管理标签不随“背后”的变化刷新：阅读器在项目里打开资源时自动加入材料、写一篇笔记、在对象自己的标签里改名、在“最近”里读到另一个资源，侧栏都要换个视图再回来才看得到（交互设计 2.10 要求列表随数据变化刷新） | 新增 `apps/desktop/src/renderer/lib/lists-changed.ts`：`lib/api.ts` 的 `call` 在命令成功后报告；改变列表的命令（材料的加入与移除，笔记与白板、导图、文稿、粗剪的新建、改名、删除）与“最近”里另一个资源的进度保存触发一次窗口事件，0.25 秒内的连续变化合并为一次；`App.tsx` 把它记为 `listsVersion`，`sidebar-data.ts` 与 `objects-tab.tsx` 据此重新读取。项目里的进度不触发（项目的列表是材料，不按进度排）。小说阅读器的进度直接走 `window.manga.command`，在那里同样报告。**守护：** `sidebar-ui.test.tsx` 新增用例：外部加入一项后不点任何东西新行就出现，加入材料与写笔记连在一起只多问一次；项目里的进度不问；“最近”里同一资源的连续进度只问一次。去掉 `listsVersion` 依赖时用例失败 |
| M4-A06（P3） | 对象管理标签（白板、导图、文稿、粗剪的管理）的标签图标是表示“这个版本打不开的类型”的问号 | `workspace/tab-icon.tsx`：`objects` 用侧栏“管理”入口的同一个图标。**守护：** `workspace-controller.test.ts` 新增用例：`WORKSPACE_TAB_KINDS` 的每一种都有自己的图标、互不相同，问号只给未知类型，阅读器按媒介三种。去掉这一行时用例失败 |
| M4-A07（P3） | 模块停用后，仍记在外壳偏好“隐藏”里的视图让 `railLayout` 多算一个“…”的格子：窗口高度刚好放下全部可见图标时，也会多出一个空的“…” | `packages/app-core/src/domain/shell-layout.ts`：只把还在 `views` 里的隐藏项计入。**守护：** `rail-layout.test.ts`：高度刚好时、隐藏项的模块已停用，全部图标放下、“…”为空 |
| M4-A08（文档） | 几处说法与实现不符：设计规则第 8 条与 `styles.css` 的注释像是已有可选的深色主题（实际只有备好的值，由窗口观察打上 `data-theme` 核对），H-58、H-68 与 AT-120 让用户在深色主题下查看；领域模型、H-11、H-49 与两处源码注释仍写“设置 › 记录”；H-69 的“一篇笔记里的一个词”应是标题里的词（正文要回车才搜） | 设计规则第 8 条、`styles.css` 注释、H-58、H-68、AT-120 写明深色值已备好、应用里还不能选（主题范围待 Q-08）；“设置 › 记录”改为记录标签（笔记管理、对话管理）；H-69 改为“标题里的一个词”；交互设计 2.10 写明哪些变化让列表重新读取 |

另记两点，不改：搜索框在媒介范围（如“漫画”）下回车搜正文时，正文结果去掉了笔记，但资源的正文命中不按这个媒介过滤（别的媒介的资源也会列出），名字结果已按范围过滤；`workspace.find` 的查询只有空白时匹配全部（界面上空白查询不发请求）。都不影响 M4-U07，第一点与列表刷新的清单记进 [LOOP-24](status.md#loop-24)（第 10 节）。

### 14.4 证据

- `docs/evidence/gate/` 换成这一轮的结果：全部 8 份 JSON 与原来那 35 张截图（同名换成这一轮的），共 4,998,592 字节（4.77 MiB，上限 5 MiB），四份指纹见第 8 节。
- 换入前看过新的截图（主页视图、白板视图、搜索框、设置视图与标签条），没有本机路径与用户名；全部 JSON 扫描过本机路径与用户名，没有；`check-publication` 扫描通过。
- 跑基准期间没有运行改变工作树的 git 命令；`package` 第一遍的失败与重跑见 14.1。

### 14.5 限制

- 第 10 节与 13.4 的限制沿用。真实 Profile 的 v12 迁移重放仍待 [ACT-11](../../USER-ACTIONS.md#act-11)。
- 产品验收仍是 not-run：人工检查 H-58—H-70 与标了“需重测”的旧项都没有执行。
- 列表刷新按命令名判断（`lib/lists-changed.ts` 的清单）：以后新增改变列表的命令时要加进清单，否则侧栏要换视图才刷新。

### 14.6 同步的文档

- 设计规则第 8 条、交互设计 2.10、领域模型的已删除作品、交付路线 AT-120。
- 用户待办：H-11、H-49、H-58、H-68、H-69 的步骤与预期；[ACT-12](../../USER-ACTIONS.md#act-12) 改回推荐。
- 执行状态：当前阶段、验证基线、已处理的审查发现与推荐下一步；本报告第 7、8、10 节与目录。
- 文档登记表：上面几份文档的核对日期。

### 14.7 下一步

复核收敛，推荐请用户授权 [ACT-12](../../USER-ACTIONS.md#act-12)：把本地阶段分支（一个带 DCO 签名的提交）push 到 `origin`、创建到 `main` 的 PR、CI 通过后 squash 合并。人工检查 H-58—H-70 不是前提（A-53），可以在合并前后任何时候做。
