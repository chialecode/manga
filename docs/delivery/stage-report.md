# 当前阶段报告（M11）：首个正式版、更新的退路与轻量打开

日期：2026-11-11（门禁完成于 2026-11-12）。分支：`feat/m11-release-light-open`（基于 `main@cfe76d4`）。角色：B 实施与自检完成；A 集中审查于 2026-11-12 收敛（结论见[第 14 节](#a-review)，A 的修复已在最终源码上重跑全套门禁与本地发布演练）。唯一计划见[当前阶段计划](stage-plan.md)。`productAcceptance` 恒为 `not-run`。

## 1. C0 阶段开始的整理与 D1 依赖盘点

### 1.1 C0 整理记录（计划 5.1）

| 对象 | 处置结果 |
| --- | --- |
| 上一阶段报告 `docs/delivery/stage-report.md` | 已提炼进 [执行状态](status.md) 并由固定归档链接引用，旧文件已删除；本文件为本阶段新建报告（`retireAfter: "m11"`） |
| `.env.local` | 原样保留，未读取与本阶段无关的配置值 |
| `dist/design-refs/`、`dist/samples/` | 原样保留；为轻量上下集与多卷补充合成样本生成逻辑（`scripts/samples/generate-media-samples.mjs`） |
| `dist/tools/` | FFmpeg 按 R1 切换为月末保留构建 `autobuild-2026-10-31-12-59`（`n8.1.3-27-g8dca1586f4`）并校验 SHA-256 与 `LICENSE.txt`；Silero VAD 与字幕字体保留 |
| `%APPDATA%\manga-release\` | 两把签名私钥（`plugin-signing.key`、`update-signing.key`）原样保留在仓库外，未读取明文、未输出、未重新生成；仓库内旧路径引用已统一同步为 `%APPDATA%\manga-release\` |
| `dist/evidence-runs/` 与系统临时目录 `manga-*` | 确认无运行中门禁后清理遗留零散目录与旧阶段快照；最终门禁与发布演练证据已同步至 `docs/evidence/gate/`（24 个文件，约 `2.29 MiB` ≤ `5 MiB`），测试、打包与发布演练后系统临时目录 `manga-*` 残留均为 `0` |
| 本地备份分支（`rebuild/m1`—`rebuild/m8`、`feat/m6-project-workspace`、`backup/main-pre-rewrite`） | 按用户 2026-11-09 决定原样保留，未触碰 |
| 以前阶段标签（A-57） | 运行 `node scripts/check-docs.mjs` 与 `node scripts/check-publication.mjs` 通过，永久正本零旧阶段标签、零本机绝对路径 |

### 1.2 D1 依赖盘点记录（计划 5.2，A-35）

按最小发行龄策略（`minimumReleaseAge: 20160` 分钟不绕过、不写豁免、**零新增依赖**）执行 `pnpm outdated -r`，将已满 14 天的同主版本稳定补丁/次版本精确更新进 `package.json` 与 `pnpm-lock.yaml`，并同步登记于 [ADR-0007](../decisions/0007-technology-stack.md)：

| 包 | 更新前 | 更新后 | 核验结论 |
| --- | --- | --- | --- |
| `electron` | `45.0.0` | `45.1.0` | 已满 14 天的 45.x 稳定版；SQLite 原生模块 ABI、打包烟测与沙箱预加载一致 |
| `dockview-react` | `8.6.1` | `8.7.1` | 同主版本满龄稳定版（2026-10-27 发行，同步锁定配套 `dockview` / `dockview-core` `8.7.1`；未满 14 天的 `8.9.0` 不采用）；标签页与四宫格分屏走查通过 |
| `lucide-react` | `1.61.0` | `1.63.0` | 同主版本满龄稳定版；完整应用与轻量界面图标正常通过类型检查 |
| `@tanstack/react-virtual` | `3.14.22` | `3.14.23` | 同主版本满龄补丁；5000 条长对话与提议卡片动态行高一致 |
| `onnxruntime-web` | `1.30.0` | `1.31.1` | 同主版本满龄稳定版；Silero VAD WASM 人声筛选契约通过 |
| `mdast-util-to-markdown` | `2.2.0` | `2.2.1` | 同主版本满龄补丁；笔记单向导出 Markdown 通过 |
| `linkedom` | `0.18.13` | 保持 `0.18.13` | 已登记例外不变（`0.18.14` 依赖 `@acemir/cssom` CommonJS 导出限制未变） |
| 其余直接依赖 | 现锁定精确版本 | 保持不变 | 高于当前锁定的候选发行未满 14 天，或 `@types/node` 随 Node 24 运行时固定在 24.x |

- 门禁前第二次 `pnpm outdated -r` 核对：已复跑核实，除已登记例外 `linkedom@0.18.13` 外，其余满 14 天的同主版本可升级项为 `0`。

## 2. 工作包 / 需求 / 验收追踪矩阵

| 工作包 | 需求 / 决定 / LOOP | 验收编号 | 主要实现位置 | 自动化与打包验证证据 | 状态与限制 |
| --- | --- | --- | --- | --- | --- |
| C0 阶段整理 | A-56、A-57 | 文档检查 | `docs/delivery/status.md`、`docs/decisions/0007-technology-stack.md`、`scripts/pack-plugin.mjs` 等密钥路径同步 | `node scripts/check-docs.mjs`、`node scripts/check-publication.mjs` | 自动化 passed |
| D1 依赖盘点 | A-35、ADR-0007 | 全量回归 | `apps/desktop/package.json`、`packages/app-core/package.json`、`pnpm-lock.yaml` | `verify`、`stage gate`、`pnpm outdated -r` 双次核对 | 自动化与打包门禁 passed（零新增依赖） |
| R1 发布流水线修复 | A-126、A-127 | AT-164 | `scripts/tools/ffmpeg.lock.json`、`scripts/tools/check-tool-links.mjs`、`scripts/verify.mjs`、`.github/workflows/release.yml`、`scripts/check-workflows.mjs` | `check-tool-links.mjs --pins`（含反例自测）、`tests/package/bundled-assets.test.ts`、打包 `media` 与 `light` 阶段 | 自动化与打包门禁 passed；合并后待授权 `dry_run=true` 试跑一次 `release.yml` |
| R2 启动失败的退路 | DATA-07、A-127、LOOP-32 | AT-165 | `apps/desktop/src/main/launch-guard.ts`、`apps/desktop/src/main/bootstrap.ts`、`packages/app-core/src/update/service.ts`、`packages/app-core/src/commands/settings.ts`、`apps/desktop/src/renderer/pages/settings/update-page.tsx`、`scripts/stage/rollback-rehearsal.mjs` | `tests/update/launch-guard.test.ts`、`tests/update/update-service.test.ts`、`stage installer` 的 `update-rollback` 真实 NSIS 回退演练 | 自动化与打包门禁 passed；产品验收 `not-run` |
| L1 独立入口与三包边界 | READ-05、A-128 | AT-170 | `apps/desktop/src/main/bootstrap.ts`、`apps/desktop/vite.bootstrap.config.ts`、`apps/desktop/vite.main.config.ts`、`apps/desktop/vite.light.config.ts`、`apps/desktop/vite.light-renderer.config.ts`、`apps/desktop/forge.config.ts`、`scripts/check-deps.mjs` | `checkLightClosure`（含反例自测）、`tests/shell/main-process.test.ts`、`tests/contracts/media-contracts.test.ts`、打包 `light-boundary` | 自动化与打包门禁 passed |
| L2 轻量媒体服务 | READ-05、A-128 | AT-167、AT-168 | `packages/app-core/src/light/index.ts`、`service.ts`、`positions.ts`、`image-size.ts`、`packages/app-core/src/video/play-copy-store.ts`、`frames.ts`、`packages/app-core/src/domain/natural-sort.ts` | `tests/light/*.test.ts`、`tests/contracts/media-contracts.test.ts`、打包 `light-writes-only-its-folder` | 自动化与打包门禁 passed |
| L3 轻量视频播放器 | READ-05、A-128 | AT-167 | `apps/desktop/src/light/light-video-player.tsx`、`light-app.tsx`、`light-host.ts`、`apps/desktop/src/main/light/main.ts`、`apps/desktop/src/preload/preload-light.ts` | `tests/light/*.test.ts`、打包 `light-video`、`light-video-episodes`、`light-video-playcopy`、`light-empty-window`、`light-unsupported-file` | 自动化与打包门禁 passed；人工检查 [H-97](../../USER-ACTIONS.md#h-97) `not-run` |
| L4 轻量漫画阅读器 | READ-05、A-128 | AT-168 | `apps/desktop/src/light/light-comic-reader.tsx`、`light-app.tsx` | `tests/light/*.test.ts`、打包 `light-comic`、`light-comic-volumes`、`light-image-start-page` | 自动化与打包门禁 passed；人工检查 [H-98](../../USER-ACTIONS.md#h-98) `not-run` |
| L5 “打开方式”注册与卸载 | READ-05、DATA-06、A-128 | AT-166 | `scripts/stage/installer-lib.mjs`、`scripts/stage/installer.mjs`、`scripts/check-deps.mjs`（`checkInstallerConfig`） | `tests/runtime/installer-config.test.ts`、`stage installer` 的 `HKCU` 注册、默认值保护、卸载清理与真实身份快照核对 | 自动化与打包门禁 passed；人工检查 [H-96](../../USER-ACTIONS.md#h-96)、[H-101](../../USER-ACTIONS.md#h-101) `not-run` |
| L6 轻量进程生命周期与更新握手 | READ-05、A-128 | AT-169 | `apps/desktop/src/main/light/main.ts`、`apps/desktop/src/main/light-runtime.ts`、`packages/app-core/src/update/service.ts`、`scripts/stage/install-dev.mjs` | `tests/update/release-and-install-dev.test.ts`、打包 `light-multi-one-process`、`light-separate-lock`、`light-update` | 自动化与打包门禁 passed；人工检查 [H-99](../../USER-ACTIONS.md#h-99)、[H-100](../../USER-ACTIONS.md#h-100) `not-run` |
| V1 录音悬浮框 | VOICE-05、A-129 | AT-172 | `apps/desktop/src/main/overlay.ts`、`overlay-model.ts`、`packages/app-core/src/voice/settings.ts`、`apps/desktop/src/renderer/voice/use-recorder.ts`、`apps/desktop/src/renderer/pages/settings-media.tsx` | `tests/voice/voice-commands.test.ts`、`tests/shell/settings-media.test.tsx`、打包 `voice-overlay` | 自动化与打包门禁 passed；真实鼠标与双屏拖动见 [H-102](../../USER-ACTIONS.md#h-102) `not-run` |
| P1 从“最近”移除与资源库最远进度 | UI-10、LIB-03、DATA-01、A-129 | AT-173 | `packages/storage-drizzle/src/sql.ts`、`schema.ts`、`store.ts`、`packages/app-core/src/sidebar-service.ts`、`works-service.ts`、`progress-service.ts`、`commands/library.ts` | `tests/library/schema-v15-migration.test.ts`、全套 v7→v15 迁移用例、侧栏与作品主页单元用例、打包 `migrate-v15` 与 `recent-remove` | 自动化与打包门禁 passed；人工检查 [H-103](../../USER-ACTIONS.md#h-103) `not-run` |
| G1 门禁提速与小问题 | LOOP-33、LOOP-34 | AT-171 | `packages/app-core/src/creative/proposals.ts`、`apps/desktop/src/renderer/pages/settings/update-page.tsx`、`scripts/stage/bench.mjs`、`apps/desktop/src/main/smoke/bench-reader.ts` | `tests/agent/proposals.test.ts`、`proposals-walk.ts`、`update-walk.ts`、`stage bench`（门槛与样本数不变） | 自动化与打包门禁 passed |
| T1 / W1 验证与文档同步 | A-53、A-57、计划第 7—9 节 | 文档检查 + 全门禁 | 正本 10 份、`USER-ACTIONS.md`（H-96—H-103）、`docs/delivery/status.md`、`docs/delivery/stage-report.md`、`docs/governance/document-registry.json` | `node scripts/check-docs.mjs`、`node scripts/check-publication.mjs`、`stage gate` | 自动化与打包门禁 passed |

## 3. L1 三个主进程构建包的分工与边界核验

1. **三份主进程构建包与独立轻量前端：**
   - **`.vite/build/main.cjs`（`apps/desktop/src/main/bootstrap.ts`，`vite.bootstrap.config.ts`）：** Electron `package.json` 的唯一 `main` 入口，只导入 Node 内置模块、Electron 与 `./launch-paths.ts`、`./launch-guard.ts`。当参数含 `--manga-light`（且非完整版 `--quit-for-update` 或非轻量 `--manga-smoke`）时直接 `require("./light-main.cjs")`；其余常规启动、`--manga-smoke` 完整阶段与 `--quit-for-update` 先经 `launch-guard.ts` 检查正式版启动状态，再 `require("./full-main.cjs")`。
   - **`.vite/build/full-main.cjs`（`apps/desktop/src/main/index.ts`，`vite.main.config.ts`）：** 完整工作区主进程，承载 SQLite 单写入宿主、`MangaProductApp`、插件子进程、Agent 与 `electron-updater`。完整版 `VideoPlayer` 与 `ComicReader` 未掺入任何轻量分支，既有行为与窗口走查完全保持不变。
   - **`.vite/build/light-main.cjs`（`apps/desktop/src/main/light/main.ts`，`vite.light.config.ts`）+ `preload-light.cjs`（`src/preload/preload-light.ts`）+ `light_window`（`src/light/`，`vite.light-renderer.config.ts`）：** 轻量打开专用主进程、窄预加载桥与独立前端包，业务侧仅调用 `@manga/app-core/light` 与 `@manga/contracts`、`@manga/i18n`。
2. **双重闭包边界核验（AT-170）：**
   - **静态源码闭包检查（`scripts/check-deps.mjs` 的 `checkLightClosure`）：** 从 `bootstrap.ts`、`src/main/light/`、`src/preload/preload-light.ts`、`src/light/` 与 `packages/app-core/src/light/` 递归追踪传递依赖，禁止触达 `better-sqlite3`、`drizzle-orm`、`@manga/storage-drizzle`、`product-app`、`plugins`、`agent`、`electron-updater`、`locations.ts`、`danmaku`、`voice`、`notes`、`creative`、`semantic`、`acquisition`（内置反例自测验证引入任一禁止模块即报错退出）。
   - **打包产物扫描（`scripts/stage/light-open.mjs` 的 `light-boundary`）：** 解读真实打包产物 `app.asar` 中的 `.vite/build/main.cjs`、`light-main.cjs`、`preload-light.cjs` 及 `.vite/renderer/light_window/**`，确认编译后字节中不含上述任何禁止模块标识。
   - **共享命令契约核验（`tests/contracts/media-contracts.test.ts`）：** 核对轻量 `LIGHT_COMMANDS`（10 条命令）的输入输出 Zod schema 与完整应用同名媒体命令完全同一份定义，无分叉契约。

## 4. V1 录音悬浮框：位置没记住的原因

**查证方式。** 用一个与上一版悬浮框窗口参数完全相同的最小 Electron 窗口（无边框、透明、`focusable: false`、不可调整大小、整块 `-webkit-app-region: drag`，280×84），在 150% 缩放的主屏上用系统输入（`SetCursorPos` 与 `mouse_event`，不用 `setBounds`）拖动，记录 `move`、`moved` 事件与 `getBounds()`。同一脚本连跑 4 次，每次两段：拖动后等 1 s 再关；拖动后立即关（模拟拖完马上停止录音）。

**观察（2026-11-11）。**

- 4 次里有 3 次第一段拖动**根本没有移动窗口**：只有打开时的一次 `move`，没有 `moved`。原生的标题栏拖动依赖窗口收到非客户区按下；`focusable: false`（`WS_EX_NOACTIVATE`）的透明窗口上它不可靠。
- 拖动生效的几次里，窗口**不跟手**：鼠标向左下移动 (-200, +120)，窗口却向右上漂移几个到几十个像素；并且每次拖动后宽高变成 281×84 或 281×85。这是小数缩放下 DIP 与物理像素来回换算的取整误差，在原生拖动的每一步累积。旧代码把宽高一并存下，下次打开时位置与大小都跟着漂。
- `moved` 只在松开后触发一次；旧代码在它之后还要等 400 ms 才写设置，而 `close()` 会清掉这个计时器：拖完 400 ms 内停止录音，位置一定丢失。

**结论。** 用户看到的“拖过之后下次不在原处”由三处叠加：原生拖动在这种窗口上时常不生效；生效时位置和大小漂移；拖完马上停止时那一次保存被丢掉。

**修法**（`apps/desktop/src/main/overlay.ts`）。不再用 `-webkit-app-region: drag`：主进程从 `webContents` 的 `input-event` 读鼠标的按下、移动和松开，自己算位移再 `setPosition`，不经过原生拖动，所以 `focusable: false` 也能拖，并且只用整数 DIP，不会漂移。松开、`moved` 与关闭时都立即写设置，`close()` 先写还没写的那次保存再关窗口。设置只存 `x`、`y`，窗口固定为 116×36。旧的 280×84 设置按右上角对齐换算（`packages/app-core/src/voice/settings.ts`）。

**之后的验证。** 用户要求尽量不影响前台的工作，探查到此为止，不再用系统输入。打包窗口的 `voice` 观察用 `sendInputEvent` 走同一条 `input-event` 路径，验证拖完记住、拖完马上停止也记住。用真实鼠标拖动、包括拖到第二块屏幕，列为人工检查。

## 5. P1 Schema v15 迁移、“从最近移除”与资源库最远进度（AT-173）

1. **Schema v14 → v15 增量（`packages/storage-drizzle/src/sql.ts`）：**
   - 迁移前自动生成一致快照备份 `manga.sqlite.premigrate-v14`；单事务内建表与视图并写入 `user_version = 15`。
   - 新增 `recent_dismissals(key TEXT PRIMARY KEY, dismissed_at TEXT NOT NULL)`（`key` 为 `work:<id>` 或 `resource:<id>`，与侧栏列表项的键相同），配套 `AFTER DELETE ON works`（`recent_dismissals_work_gone`）与 `AFTER DELETE ON resources`（`recent_dismissals_resource_gone`）触发器自动清理已删目标的移除记录。
   - 新增只读视图 `progress_furthest`：对每个（`resource_id`、`resource_revision_id`）跨所有上下文（“最近”与各项目）按 `(completion_state = 'completed') DESC, percent DESC, last_interaction_at DESC, context_id` 选出走得最远的一行；原有的 `progress_latest` 视图原样保留供“最近打开”时间排序使用。
2. **业务行为与命令：**
   - `workspace.dismissRecent` 与 `workspace.undismissRecent`（`packages/app-core/src/sidebar-service.ts`、`commands/library.ts`）：在主页、小说、漫画、动漫视图的“最近”分组右键选择“从最近移除”仅写入 `recent_dismissals`、弹出带“撤销”的底部提示，不改动 `progress`、笔记、书签或项目材料；在项目上下文里继续阅读不会让它回到“最近”；在“最近”里再次产生阅读观看动作时，这次动作的时间晚于 `dismissed_at`，列表项随之重新出现（移除记录本身保留，列表只列最后动作晚于它的项）。
   - 资源库卡片、“按进度”排序与作品主页改读 `progress_furthest`（任一上下文读完即标为已读/已看，否则显示最高百分比并注明来源上下文）；作品主页同时列出各上下文的独立位置（如 `最近：… · 项目 A：…`）。
3. **迁移验证：** `tests/library/schema-v15-migration.test.ts` 与打包观察 `migrate-v15`、`recent-remove` 验证 v14 升级前备份、故障回滚、中断续跑、重复启动幂等，以及旧版（最高认识 v14）打开 v15 数据库时明确报版本过高而拒绝。

## 6. L2—L4 轻量媒体服务复用模块与界面行为（AT-167、AT-168）

1. **`@manga/app-core/light` 复用的仓内模块：**
   - `media/ffmpeg.ts`（`FfmpegService`、`locateFfmpeg`：统一探测与子进程调用）；
   - `media/handles.ts` 与 `media/serve.ts`（`MediaHandleTable` 与 `manga-media:` HTTP `206/416` Range 流式读取）；
   - `media/job-queue.ts`（受控并发任务队列）；
   - `media/zip-pool.ts`（`ZipPool`：按需解压 CBZ/ZIP 条目，原样执行路径穿越、压缩炸弹与加密条目拒绝）；
   - `media/subtitle-font.ts`（随包 Noto Sans SC 回退字体定位）；
   - `comic/comicinfo.ts`（`parseComicInfo` 阅读方向提示）与 `domain/natural-sort.ts`、`domain/text.ts`；
   - `video/playback.ts`（`decidePlayback`、`listTracks`、`mediaTypeFor`）、`video/sidecars.ts`（同目录外挂字幕发现）、`video/frames.ts`（按需关键帧时间表与逐帧步进）、`video/font-names.ts`、`video/play-copy.ts` 与 `video/play-copy-store.ts`（`JsonPlayCopyStore`：2 GiB 上限 LRU 播放副本缓存，不依赖 SQLite）。
2. **暴露的 10 条媒体命令（`LIGHT_COMMANDS`）：** `video.playbackPlan`、`video.playCopy`、`video.handle`、`video.subtitles`、`video.subtitleHandle`、`video.fonts`、`video.frameIndex`、`video.cancelFrameIndex`、`comic.pages`、`comic.pageHandles`；未列出的任何命令在轻量桥接层直接拒绝。
3. **严格 `<应用数据根>\light\` 隔离：**
   - 所有状态只写 `%LOCALAPPDATA%\manga\light\`（开发版 `manga-dev\light\`）下的 `runtime/`、`positions.json`（键仅为路径+大小+修改时间的 `SHA-256` 摘要，漫画页只存页面 id 的 `SHA-256`，零明文文件名/路径/页面名，上限 500 条 LRU，视频距结尾 ≤ 5 秒下次从头开始）、`window.json`、`cache/`（播放副本 2 GiB LRU 与会话临时目录）和 `logs/`。
   - 打包观察 `light-writes-only-its-folder` 核对启动前后的资料库目录、“文档”、“下载”、漫游 `%APPDATA%` 与完整应用启动指针均零改动，且 `positions.json` 里只有摘要：键与漫画页都是 64 位十六进制，不含任何样本文件、文件夹或页面的名字（A 审查时加严，见第 14 节 F-02）。

## 7. L5 Windows“打开方式”`HKCU` 注册表清单与卸载清理（AT-166）

安装脚本（`scripts/stage/installer-lib.mjs`）不使用 `electron-builder` 的 `fileAssociations`（由 `checkInstallerConfig` 强制拦截），仅在 `HKCU` 下为 21 个扩展名（视频 13 个：`.avi .flv .m2ts .m4v .mkv .mov .mp4 .mpeg .mpg .ogv .ts .webm .wmv`；漫画 1 个：`.cbz`；图片 7 个：`.avif .bmp .gif .jpeg .jpg .png .webp`）注册“打开方式”与“默认应用”候选：

| 注册表键（均在 `HKCU` 下，零 `HKLM`） | 写入的值与类型 | 卸载时的清理规则 |
| --- | --- | --- |
| `Software\Classes\<ProgID>`（正式版 `MANGA.Video` / `MANGA.Comic` / `MANGA.Image`；开发版 `MANGA.Dev.*`；测试身份 `MANGA.Test.*` / `MANGA.DevTest.*`） | 默认值 = 中文类型名；`DefaultIcon` = `"<exe>,0"`；`shell\open\command` 默认值 = `"\"<exe>\" --manga-light \"%1\""` | 整棵删除本通道自己的 `<ProgID>` 键 |
| `Software\Classes\.<ext>\OpenWithProgids`（21 个扩展名） | 名为 `<ProgID>` 的空字符串值（`REG_SZ` = `""`）；**绝不写 `.<ext>` 的 `(Default)` 默认值与 `UserChoice`** | 仅 `DeleteRegValue` 删除本通道 `<ProgID>` 值名；父键 `OpenWithProgids` 与 `.<ext>` 经 `MangaDeleteBareKey` 仅在无任何子键且无任何值时才删除 |
| `Software\Classes\Applications\<exeName>`（如 `manga.exe`、`manga-dev.exe`） | `FriendlyAppName`、`DefaultIcon`、`SupportedTypes`（21 个 `.ext` 空值）、`shell\open\command` 默认值 = `"\"<exe>\" --manga-light \"%1\""` | 整棵删除本通道自己的 `Applications\<exeName>` 键 |
| `Software\MANGA\<ChannelKey>\Capabilities`（`Release` / `Dev` / `Test` / `DevTest`） | `ApplicationName`、`ApplicationDescription`、`FileAssociations` 子键下 21 个 `.ext` = `<ProgID>` | 整棵删除 `Software\MANGA\<ChannelKey>`；顶层 `Software\MANGA` 经 `MangaDeleteBareKey` 在无其他通道残留时删除 |
| `Software\RegisteredApplications` | 值 `<AppRegName>` = `"Software\\MANGA\\<ChannelKey>\\Capabilities"` | 仅删除本通道 `<AppRegName>` 值名 |
| 外壳刷新通知 | 安装与卸载末尾调用 `shell32::SHChangeNotify(0x08000000, 0, 0, 0)`（`SHCNE_ASSOCCHANGED`） | 同左 |

- **验证结果：** `stage installer` 在安装测试身份（`MANGA Test` / `MANGA Dev Test`）前先在临时测试扩展名与既有扩展名键上记录快照并预设其他程序默认值，验证安装后 5 类键齐全且既有默认值不变、双通道并存互不覆盖、卸载后本通道注册项清零且其他通道与真实本机安装快照前后完全一致。

## 8. L6 轻量进程生命周期与更新退出握手（AT-169）

1. **独立 `userData` 与单实例锁分离：** `apps/desktop/src/main/light/main.ts` 在调用 `app.requestSingleInstanceLock()` 之前先将 `userData` 与 `sessionData` 指向 `<应用数据根>\light\runtime`。因此完整应用（锁在 `<应用数据根>\runtime`）与轻量进程各自持有独立锁：完整应用运行中双击或“打开方式”启动 `--manga-light` 仍进入轻量窗口；连续用 `--manga-light` 打开多个文件复用同一个轻量进程并通过 `second-instance` 新建错开 `28 px` 的轻量窗口；关闭最后一个轻量窗口即触发 `window-all-closed` 退出轻量进程。
2. **更新与 `install-dev` 前 10 秒退出握手：** `apps/desktop/src/main/light-runtime.ts`（`askLightToQuit`）与 `scripts/stage/install-dev.mjs` 在执行开发版自动安装或正式版重启/退出更新前，检测 `light/runtime/light-instance.json` 并写入 `quit-request.json`，等待最多 10 秒让轻量进程落盘当前播放/阅读位置、写出 `quit-ack.json` 并退出；若轻量窗口拒绝或 10 秒未退出，放弃本次安装并提示“请先关闭轻量播放窗口”，绝不强杀进程。轻量进程自身不引入 `electron-updater`，运行期间零联网检查与下载。

## 9. R2 更新后启动失败的退路与回退演练（AT-165、LOOP-32）

1. **更新前留存与启动计数：** `UpdateService` 在执行安装前将当前已验签的安装包连同 `previous.json`（记录旧版本号、文件名、`sha512Hex`、前后 schema 版本、数据库与 `preupdate` 备份路径）留存在 `<应用数据根>\cache\updater\previous\`，并写 `last-installed.json`。打包正式版更新后的前三次启动由极薄入口 `launch-guard.ts` 在加载 `full-main.cjs` 之前跟踪（开发版与 `pnpm dev` 不计数；故障注入环境变量 `MANGA_TEST_FAIL_LAUNCH=1` 仅在 `channel.testIdentity === true` 时生效）；主窗口加载完成后调用 `launchSucceeded()` 清除计数。
2. **第三次启动询问与安全回退：** 连续两次启动未完成时，第三次启动在加载重业务模块前弹出系统原生对话框，**绝不自动静默回退**。仅当 `previous/` 下的旧安装包存在且实时重算 `SHA-512` 与 `previous.json` 完全一致时，才显示 `["回到 <上一版>", "再试一次", "打开下载页"]`（安装包缺失或被篡改 1 字节时只显示 `["再试一次", "打开下载页"]` 并说明原因）。用户选“再试一次”则继续本次启动；选“回到 <上一版>”时：
   - 再次核对旧安装包 `SHA-512`；若新版本已升级过资料库 schema，先将当前 `manga.sqlite`（及 `-wal`/`-shm`）改名为 `manga.sqlite.rolledback-<ISO 时间戳>` 留在原目录不覆盖，再通过 `.restore.part` 原子恢复 `manga.sqlite.premigrate-v<旧 schema>`（不存在时回退到更新前 `preupdate` 备份）；
   - 在数据库所在数据目录写入 `update-skip.json` 跳过该故障版本（后续自动更新不再反复拉取安装该版本；“设置 › 更新”显示 `已跳过 0.1.x` 与“取消跳过”按钮 `update.unskip`）及 `rollback-record.json`（下次启动写入 `operations` 日志）；
   - 拉起独立 PowerShell 辅助脚本再次核对旧安装包 `SHA-512` 后执行静默降级安装并重开旧版。
3. **演练验证：** `tests/update/launch-guard.test.ts` 与 `scripts/stage/rollback-rehearsal.mjs`（集成在 `stage installer` 的 `update-rollback` 步骤）以测试身份完成 `0.1.1 → 0.1.2（带迁移且前两次启动崩溃）→ 第三次弹窗回退 → 恢复到 0.1.1、资料完好、rolledback 文件保留、0.1.2 被跳过` 以及篡改旧包 1 字节隐藏回退按钮的端到端验证。

## 10. R1 发布流水线修复：FFmpeg 月末锁定与工具链接预检（AT-164）

1. **FFmpeg 改钉月末永久保留构建（`scripts/tools/ffmpeg.lock.json`）：**
   - 上游仓库：`https://github.com/FFmpeg-Builds/FFmpeg-Builds`（即计划第 3 节的 BtbN/FFmpeg-Builds：仓库已迁到该组织，旧地址 301 跳转到新地址；A 于 2026-11-12 用 `check-tool-links.mjs` 在线核对 5 个地址均为 200）
   - 发布标签：`autobuild-2026-10-31-12-59`（月末构建，上游策略永久保留，不再使用 14 天后会被清理的每日构建）
   - 版本与资产：`n8.1.3-27-g8dca1586f4` / `ffmpeg-n8.1.3-27-g8dca1586f4-win64-lgpl-shared-8.1.zip`（`80,356,594` 字节）
   - 许可证：`LGPL-3.0-or-later`（`--enable-version3`，不含 GPL 组件；包内 `LICENSE.txt` SHA-256：`da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768`）
   - 压缩包 SHA-256：`5cef7bc48e513f3cee7c881e8b2999d835541edb1846c3e89443a67f8f8556ab`
   - `bin/ffmpeg.exe` SHA-256：`9f3683fc0480bd4b54d42ae44702f6ac6320b3d4a12a36f3a70bfe37d02fd861`
   - `bin/ffprobe.exe` SHA-256：`d93588787cb39d4ea2e74cf9b88998a95d2706add6c1de94a3b021e588cd6bea`
2. **离线锁形态守护与 CI 运行器前在线预检（`scripts/tools/check-tool-links.mjs`）：**
   - 离线模式 `node scripts/tools/check-tool-links.mjs --pins` 已接入 `scripts/verify.mjs`（含反例自测）：强制校验 FFmpeg 标签为月末构建日期、Silero VAD 与字幕字体 URL 固定 40 位完整提交 SHA，改回每日构建或分支名时 `verify` 立即失败。
   - 在线模式 `node scripts/tools/check-tool-links.mjs` 已接入 `.github/workflows/release.yml` 的轻量 Ubuntu `decide` 阶段（当 `should_release == 'true'` 时执行）：在分配昂贵的 `windows-2025` 运行器前对全部随包工具锁地址发 HTTP `HEAD` 核对可达性，任一 404 或不可达即点名锁文件并停止发布流程（由 `scripts/check-workflows.mjs` 静态守护该步骤存在）。

## 11. G1 门禁提速、LOOP-33、LOOP-34 与测试迁移映射（AT-171）

1. **LOOP-33（模块停用时的执行中提议恢复）：** `packages/app-core/src/creative/proposals.ts` 的启动恢复 `ProposalService.recover()` 在检查处于 `applying` 的提议时，若所属功能模块当前已关闭且关机前未执行完毕（含无 `operations` 完成回执的同步提议及尚未到达 `done` 的 `exportRoughcut`），立即将其收敛为终态 `failed`（写入 `reason: "模块已关闭"`、错误码 `CAPABILITY_UNAVAILABLE`），界面显示 `执行失败：模块已关闭`，之后重新启用模块也绝不静默重跑（`tests/agent/proposals.test.ts` 与 `proposals-walk.ts` 验证）。
2. **LOOP-34（“设置 › 更新”的更新内容留白）：** 修正 `apps/desktop/src/renderer/pages/settings/update-page.tsx` 中“更新内容”区域的内边距，与上方各行对齐，由打包 `update` 阶段的深浅色截图核验。
3. **G1 基准与门禁提速：** 门槛未改；去掉了重复的种子准备（基准窗口改用 Node 预先建好的模板资料，扫描与停靠栏的三轮 1000 条笔记测量合并到一个窗口，计划 4.7 允许的“可以合并的窗口启动”）、按需才显示小说控制条、封面计时与视图恢复共用同一次按下。B 交付时还缩短了若干采样参数与样本间等待，A 审查判定为改变样本数与测量方法并回退（第 14 节 F-01）。最终 `stage bench` 的 `records.sectionSeconds` 合计 **`514.1 s`**（上一阶段 `588 s`，缩短 `74 s`），**未达到计划的 `450 s` 目标**：多出的部分是恢复的测量本身——工作区段（含拖动 5 次 × 2 × 90 步、各 2 秒的空闲基线、内存采样前的稳定等待）`143.2 s`、扫描与停靠栏 `92.7 s`、阅读器 `74.2 s`、规模窗口 `66.3 s`、对话 `40 s`；这些等待决定测到的是什么，不能再减。
4. **测试与走查改写的 1 对 1 迁移映射（计划第 11 节第 10 项）：** 本阶段未删除任何既有断言。随 V1 紧凑悬浮框规格（`AT-172` 固定 `116×36`、移除尺寸控件与可见设备名）与双入口烟测隔离（`bootstrap.ts` + `light/main.ts`）更新，`scripts/stage/gate.json` 中 3 个用例组的 11 条正则及 `workspace-walk.ts` 的 1 处走查做了 1 对 1 对齐：

| 用例组 / 走查 | 原用例名匹配 / 原断言语义 | 新用例名匹配 / 替代断言语义 |
| --- | --- | --- |
| `AT-16-layout-keyboard-ime`（`tests/shell/main-process.test.ts`） | `^the floating recording box keeps a saved place that is still on a screen` | `^AT-172 the floating recording box AT-172 keeps a saved place that is still on a screen`（保留原屏幕内位置恢复断言） |
| `AT-16-layout-keyboard-ime`（`tests/shell/main-process.test.ts`） | `^the floating recording box pulls a box that hangs off the edge of its screen back in` | `^AT-172 the floating recording box AT-172 pulls a box that hangs off the edge of its screen back in`（保留越界拉回断言） |
| `AT-54-floating-box-and-hold`（`tests/shell/main-process.test.ts`） | `^the floating recording box goes to the top right of the main screen when no place was saved` | `^AT-172 the floating recording box AT-172 goes to the top right of the main screen at fixed 116×36 when no place was saved`（对齐 `116×36` 固定尺寸） |
| `AT-54-floating-box-and-hold`（`tests/shell/main-process.test.ts`） | `^the floating recording box keeps a saved place that is still on a screen, including a second screen` | `^AT-172 the floating recording box AT-172 keeps a saved place that is still on a screen, including a second screen`（保留双屏恢复断言） |
| `AT-54-floating-box-and-hold`（`tests/shell/main-process.test.ts`） | `^the floating recording box returns to the main screen when its monitor is gone` | `^AT-172 the floating recording box AT-172 returns to the main screen top right when its monitor is gone`（保留外接屏断开回主屏右上角断言） |
| `AT-54-floating-box-and-hold`（`tests/shell/main-process.test.ts`） | `^the floating recording box accepts a well-formed state and clamps what can be out of range` | `^AT-172 the floating recording box accepts a well-formed state and clamps what can be out of range`（保留状态校验与裁剪，外加旧 `280×84` 右上角换算用例） |
| `AT-54-floating-box-and-hold`（`tests/shell/main-process.test.ts`） | `^the floating recording box drops anything that is not a state` | `^AT-172 the floating recording box drops anything that is not a state`（保留非法状态丢弃断言） |
| `AT-54-floating-box-and-hold`（`tests/shell/main-process.test.ts`） | `^the floating recording box shows text with textContent, has no network or storage, and has a stop button` | `^AT-172 the floating recording box AT-172 renders only the clock in visible text, puts status/mode/retention/device in aria-label, freezes clock on stopping, and keeps preload minimal`（按 A-129 将可见文字收紧为计时并把模式/保留/设备移入 `aria-label`，零网络/零存储/极窄预加载与停止按钮断言不变） |
| `AT-54-floating-box-and-hold`（`tests/shell/settings-media.test.tsx`） | `^settings for media, recording and metadata restores the floating box's place and size` | `^settings for media, recording and metadata AT-172 restores the floating box's default position without size controls`（按 A-129 去掉尺寸调节并验证恢复默认位置） |
| `smoke-isolation`（`tests/package/smoke-isolation.test.ts`） | `^test hooks stay out of a normal start the entry point loads it only ` | `^test hooks stay out of a normal start the entry points load smoke only `（同时覆盖 `bootstrap.ts`、`index.ts` 与 `light/main.ts` 全部入口） |
| `smoke-isolation`（`tests/package/smoke-isolation.test.ts`） | `^test hooks stay out of a normal start the smoke directory is not reachable ` | `^test hooks stay out of a normal start the smoke modules are not reachable `（同时覆盖完整应用与 `light/smoke.ts` 隔离） |
| 窗口走查 `same-file-contexts`（`workspace-walk.ts`） | 资源库卡片以前按当前上下文进度断言 | 按 A-129 `progress_furthest` 改为先在未读完样本上核对卡片最远百分比与“来自…”上下文标注，再验证任一上下文读完后覆盖部分进度显示已完成 |

<a id="gate"></a>
## 12. 门禁、基准（基线与对照）、本地发布演练与源码指纹

以下是 A 审查修复后在最终源码上的结果（2026-11-12，Windows x64，Node `v26.12.1`；B 交付时的一轮同样全部通过，被这一轮整体替换）。`node scripts/stage.mjs gate` 全链路 `2329 s`（约 39 分钟，上一阶段 `2149 s`；多出的是新增的 `light` 阶段、34 步安装演练与恢复的基准测量），之后在干净工作树上跑本地发布演练。`docs/evidence/gate/` 替换为这一轮的 12 个 JSON 与 12 张截图（约 `2.29 MiB` ≤ `5 MiB`），截图已逐张看过，不含本机路径。

### 12.1 阶段门禁各步结果

| 步骤 | 状态 | 用时 | 摘要 |
| --- | --- | --- | --- |
| `verify`（不含测试） | `passed` | `27 s` | 语法、JSON、文档、工具锁形态（`--pins`）、工作流安全、公开内容、依赖与轻量闭包（含无法跟踪的导入）、双 `tsc`、`knip`、无未注释 `sleep`、`git diff --check` |
| `test` | `passed` | `95 s` | Vitest `2959` 项（`2949 passed`、`0 failed`、`10 skipped`），`cases.json` `207/207`，临时目录残留 `0` |
| `package`（连续 3 次） | `passed` | `438 s / 397 s / 388 s` | `passStreak: 3`，`scenarios.json` `180/180`，含 `light-*`、`light-boundary`、`light-writes-only-its-folder`（加严后）、`light-update`、`voice-overlay`、`recent-remove`、`migrate-v15`、`update-*` |
| `installer` | `passed` | `449 s` | `34/34` 步：双通道测试身份、21 个扩展名的 `HKCU`“打开方式”（扩展名默认值不变、覆盖安装保留、单通道卸载不影响另一通道、真实身份快照前后一致）、`update-rollback` 真实 NSIS 回退演练、真实 `electron-updater` 整包与差分、真实 `install-dev` |
| `bench` | `passed` | `515 s` | `63/63` 项在门槛内；`sectionSeconds` 合计 `514.1 s`（见第 11 节第 3 项） |
| `report` | `passed` | `< 1 s` | `automationStatus: "self-check-passed"`，`productAcceptance: "not-run"` |
| `install-dev` | `passed` | `16 s` | 本机开发版静默更新到 `0.1.1-dev.202611120027`（含轻量退出握手） |
| 本地发布演练（`stage release`，`publish: false`） | `passed` | `283 s` | 干净工作树上生成 `dist/release/v0.1.1/` 的发布产物（`schemaVersion: 15`，`benchMatchesSource: true`）；首版种子 `0.1.0 → 0.1.1` 真实 NSIS 升级演练（218.3 s：整包 `212,522,140` B、重启就绪 `22.7 s`；差分 `474,376` B、退出时安装）与篡改 1 字节被拒绝全部通过；没有创建标签、没有请求 GitHub，真实安装未被触碰 |

### 12.2 新增轻量基准与对照项

| 指标 | 实测 p95（或记录值） | 门槛 | 说明 |
| --- | --- | --- | --- |
| `lightVideoFirstFrameMs` | **`427 ms`**（5 次 `[408, 427, 414, 409, 413]`） | ≤ 2000 ms | 轻量进程未运行时 `--manga-light` 打开 1080p H.264 合成视频，从启动进程到第一帧 |
| `lightComicFirstPageMs` | **`262 ms`**（`[253, 241, 247, 252, 262]`） | ≤ 1500 ms | 同上，打开合成 CBZ 到第一页 |
| `lightSecondOpenMs` | **`255 ms`**（`[241, 255, 249, 249, 247]`） | ≤ 800 ms | 轻量进程已在运行时再打开一个视频到第一帧 |
| 记录项：新数据根的第一次冷打开 | `477 ms` | 记录项 | 同时建立 Chromium 的配置目录，不计入上面的 5 次 |
| 记录项：轻量进程的工作集 | `[556, 528, 570, 524, 562]` MiB | 记录项 | 打开一个 1080p 视频、第一帧后 1 秒 |
| 记录项：完整应用打开同一视频（对照） | 第一帧 `875 ms`（书架列出 `594 ms`） | 记录项 | 从进程启动、加入资源库位置、扫描、从书架打开到第一帧；约为轻量的 2 倍 |

### 12.3 最终源码与证据指纹（`docs/evidence/gate/report.json`）

- 阶段分支提交：全部改动（带 `Signed-off-by` DCO 签名）在 `feat/m11-release-light-open`（基于 `main@cfe76d4`）上的单个阶段提交里。
- `sourceFingerprint`锛歚dc377aa3dd1b6908973f1b9b6d87f3fa37bba24aeb400d0a45a1d37ce9d9c8c6`
- `smokeScriptFingerprint`锛歚84aea18197957e49a49e8e9c4e4f55cac9ace6e98a212af2b3b5d3f1c1cd4a55`
- `smokeChecksScriptFingerprint`锛歚c1c2ca8355f5436eaea59f327db57acd6a3419b757d63496efc9cba9abc2023f`
- `smokeBenchScriptFingerprint`锛歚1532610373b76fedac5903c47c3350ad4d0e209b853f60015d693de9206ba143`
- `smokeWalkScriptFingerprint`锛歚58fa4c5cdfe4d1187bb6c02cd57b242c1523d81c5ab046d8183439b9926053ce`
- `lockFingerprint`锛歚97e74474b5207dfe933e28f2977cfc9db778c3475cbbf65d56ba4e25bb52c2c3`
- `buildScriptFingerprint`锛歚3cb3dbe850da3702a24a419087d2f8a678b49f319ce5a68e5de61db21b86599b`
- `gateScriptFingerprint`锛歚342b275147cf13da9687ca2a88d32824c5b0a99f35bfaee6b4f22b31391a05fc`
- `testScriptFingerprint`锛歚0d93bca6a89864c7e04ec6b6bcc791fc00808f6046d1da4d57e3ba3d122771c8`
- `packageScriptFingerprint`锛歚9fe76d800c26f18029352ad7a3bd55b55f1dd3085a9754b92dbd3dd352187972`
- `benchScriptFingerprint`锛歚a143abb87f2ecf8de46dec88bda61bbd5b1da23dd0b9ddac625c26e896c4628f`
- `installerScriptFingerprint`锛歚ccf083e32fc67946d607c5ff9911f6b03ac7b75e515929527716e96cea7c11dd`
- `releaseScriptFingerprint`锛歚68a9a41eb30d145a9ee18864651ab0bf45dae245efb9fa9977e48a20693e9665`

## 13. 首选下一步

A 审查已收敛，推荐**请用户授权本阶段的远端操作**（[ACT-20](../../USER-ACTIONS.md#act-20)）：push 阶段分支、创建 PR、CI 通过后 squash 合并，合并后以 `dry_run=true` 手动试运行一次 `release.yml`；试运行通过后，下一个周一的定时运行发布第一个正式版 `0.1.1`。人工检查 [H-96](../../USER-ACTIONS.md#h-96)—[H-103](../../USER-ACTIONS.md#h-103) 与 [Q-39](../../USER-ACTIONS.md#q-39) 不是授权的前提（A-53）。

<a id="a-review"></a>
## 14. A 集中审查结论（2026-11-12）

**范围。** 按 [REVIEW.md](../../REVIEW.md) 与计划第 9 节逐项核对实现、用例与证据：引导入口与三个主进程文件、`checkLightClosure` 与打包产物的 `light-boundary`、轻量的数据位置与单实例锁、`HKCU` 注册与卸载、更新与 `install-dev` 前的 10 秒握手、`launch-guard` 的计数与询问和回退、`UpdateService` 的保留安装包与跳过版本、FFmpeg 锁文件与 `check-tool-links`、`release.yml` 与工作流检查、悬浮框的拖动与保存、v15 迁移、“最近”移除与 `progress_furthest`、LOOP-33、LOOP-34 与基准改动。

**确认无问题的要点。** 轻量的主进程与界面打包后不含资料库、插件、Agent 与更新的代码（静态闭包与产物标记双重检查，标记先在完整应用的产物里找到）；轻量先设 `userData` 再取锁，与完整应用并存；注册只写 `OpenWithProgids` 的命名值与自己的键，`checkInstallerConfig` 拒绝 `fileAssociations` 与写扩展名默认值；退路只在第三次启动询问、默认按钮是“再试一次”，选回退时在改动资料库之前和运行安装包之前各核对一次 SHA-512，现库先改名为 `rolledback-*` 再恢复；开发版、`pnpm dev`、`--quit-for-update` 与 `--manga-light` 不计数，测试开关只认测试身份；FFmpeg 压缩包、`LICENSE.txt`、`ffmpeg.exe`、`ffprobe.exe` 的 SHA-256 与锁文件一致，`-buildconf` 有 `--enable-version3`、没有 `--enable-gpl`；`check-tool-links.mjs` 在线核对 5 个地址均为 200；v15 迁移有备份、中断可重来、旧版拒绝。

**发现与处理**（都已修复并在最终源码上重跑门禁）：

| 编号 | 严重度 | 发现 | 处理与守护 |
| --- | --- | --- | --- |
| F-01 | P2 | G1 改了基准的样本数与测量方法，报告写“不减少样本数”且没有改动前后的比较：拖动 `dragSteps` 90→24、空闲基线 2 s→1 s（两处）、白板样本间由两帧改为一帧并缩短稳定判定、对话输入样本间隔 20→2 ms、翻页与改字号与视图切换样本间去掉一帧等待、内存采样前的稳定等待与播放时长缩短。与上一阶段相比 `whiteboardZoomP95Ms` 2.2→1.1、`whiteboardDragP95Ms` 6.3→3.6、`chatInputP95Ms` 6.7→2.3，属计划 4.7 要求回退的系统性变化 | 全部恢复原值；保留不改变所测内容的提速（模板资料、合并窗口、同一次按下计两个结果、按需显示控制条、轻量基准排除建配置目录的首跑）。恢复后白板回到 2.1 / 6.1；`sectionSeconds` 合计 514.1 s，未达 450 s 目标（第 11 节第 3 项写明原因） |
| F-02 | P2 | `positions.json` 的漫画位置存了明文页面 id，也就是文件夹里图片的文件名或压缩包里的条目名，违反 4.4“不存文件名与路径”；打包观察只查了“第”字 | 页面只存 id 的 SHA-256，按摘要（其次按页码）找回；只保留已知字段；读到旧格式时改写。`tests/light/light-open.test.ts` 新增用例；`light-writes-only-its-folder` 改为要求键与页面都是摘要且不含任何样本文件、文件夹或页面的名字 |
| F-03 | P2 | 从资源管理器打开文件夹中间的一张图片时，若这个文件夹记过位置，会跳到记住的页而不是所点的那张（4.3、H-98） | 打开单张图片时从那一张开始，不套用记住的页；CBZ 与文件夹照常续读。正本（交互设计、数据与安全）同步 |
| F-04 | 建议（已改） | `checkLightClosure` 遇到找不到的导入（例如省略扩展名）会静默跳过，后面的依赖不再检查 | 改为报错；自测加入反例 |
| F-05 | P2（文档） | 报告与正本和代码不符：ProgID 名称、v15 表与视图的定义、需求映射（R2 是 DATA-07，L5 是 DATA-06）、“最近”重新出现的机制；数据与安全、交互设计写了代码里没有的“98% 视为看完”；FFmpeg 仓库地址从 BtbN 改为 `FFmpeg-Builds` 未说明 | 逐处改正；ADR-0007 记下仓库迁移（旧地址 301 跳转） |

**其他核对过、不改的事项。**

- `updater.ts` 的断点续传改为把收到的字节直接写进 `.part`（上游在出错时先关闭写入流会丢掉排队的字节），计划没有列出这项改动，现有的断点续传用例（AT-159）与真实 `electron-updater` 演练覆盖它，保留。
- 选“回到上一版”时，若资料库已恢复而后台安装进程没能启动，会改为打开下载页：此时新版本仍在、资料库是升级前的备份（更新后的改动在 `rolledback-*` 里）、新版本被跳过；下次启动新版本会再次升级这份备份。属可接受的降级路径，记为限制。
- 完整应用还在启动（窗口未就绪）时再次启动它，第二个进程会把第一个的启动标记计为一次失败；下一次正常启动即清零，单独不会触发询问。
- 悬浮框的修法只在打包窗口里用 `sendInputEvent` 验证；`focusable: false` 窗口上的真实鼠标拖动与第二块屏幕按用户要求不在自动化里做，留给 [H-102](../../USER-ACTIONS.md#h-102)。
- 清理了 `dist/evidence-runs/` 里一份遗留的排查目录（结论已在 LOOP-04）。

**结论。** Agent 侧完成：最终源码上 `stage gate` 全部通过、干净工作树本地发布演练通过、文档检查通过；产品验收保持 not-run。
