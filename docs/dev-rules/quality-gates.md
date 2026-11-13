# 验证与质量门禁

按变更风险选择最小充分检查。已通过后只有新改动、失败或未解决风险才扩大/重复验证。不能为了形式给错字修复增加应用测试，也不能以文档检查代替迁移或运行验证。

## 1. 当前可以执行的检查

前置条件：Git 与 Node.js 24 或更新版本；CI 使用 `.node-version`（Node.js 24.19.0）。从仓库根：

```powershell
pnpm install
node scripts/verify.mjs
```

`verify.mjs` 是本地与 CI 共用的统一入口，依次检查：`scripts/` 顶层 MJS 语法；文档登记表与 GitHub 配置 JSON；文档结构（`check-docs.mjs`）；随包工具与门禁模型锁文件引用形态（`check-tool-links.mjs --pins`：离线核对 FFmpeg 锁定月末保留标签而非会被清理的每日标签，Silero VAD、字幕字体与 GTCRN 许可锁定 40 位完整提交 SHA，GTCRN 模型与门禁离线 ASR 模型锁定明确 GitHub Release 标签、同名资产、64 位十六进制 SHA-256 与字节数，含反例自测）；GitHub Actions 工作流静态安全检查（`check-workflows.mjs`）；公开内容检查及其反例；文档检查与阶段报告门禁的反例自测；包依赖方向、主进程与轻量入口闭包边界（`check-deps.mjs`，含 `checkLightClosure`、`sherpa-onnx-node` / `asr-host.ts` 仅限推理子进程加载、安装包配置禁止 `fileAssociations` 及内置反例）；根与 `apps/desktop` 两个 `tsc --noEmit`；未使用代码与依赖（`knip`）；烟测无未注释 `sleep(` 检查（`findUncommentedSmokeSleeps()`）；全部 Vitest；`git diff --check` 与 `git diff --cached --check`。它不安装依赖；缺少 `node_modules` 或 vitest 时非零退出，不使用 `--if-present`。10 MiB TXT 与 30 MiB EPUB 等大文件用例只在 `MANGA_LARGE_FILES=1` 时运行，阶段入口会设置它。需要合成样本、固定 FFmpeg 或语音模型的用例在这些前置缺失时失败；只有声明了 `MANGA_MEDIA_PREREQUISITES=absent` 的环境（CI）才把它们记为跳过，阶段入口会清除这个变量。

开发启动用 `pnpm dev`，自动检查 Electron SQLite ABI 并隔离开发 Profile；目录约定见 [仓库地图](repo-map.md#生成物约定)。人工检查的启动、样本、操作和预期写在[用户待办](../../USER-ACTIONS.md#checks)，写到用户能直接照做，不只引用本页。

### 1.1 公开内容检查

统一入口已包含 `node scripts/check-publication.mjs` 和其回归测试。脚本枚举 Git 已跟踪文件与未忽略的新文件，分别检查工作树与暂存版本，防止清理工作树后仍提交旧敏感内容。它检查个人绝对路径、常见凭据、含凭据 URL 和私有数据文件；报错只显示文件/行号/类别，不回显匹配值。反例测试覆盖暂存泄漏、未跟踪报告及可移植示例。

这是一组有限规则，不是全量密钥或语义识别器。外部工程叙述、设备标识、私密正文、二进制/图片、任意格式的新令牌，以及待推送提交中被后来删除的内容仍需人工/Agent 检查；脚本不扫描 Git 历史。推送前核对最终待推送提交/变更集和公开候选文件名，必要时补查相关历史；失败时修复后再验证。第三方库/官方接口链接与合法许可证声明保留。

报告生成后重新运行公开检查；性能报告只输出平台/架构/版本，不采集具体 CPU/内存标识到公开报告。真实资源根只用于开发者本机的只读试验，证据里只写数量与类别，不写文件名、标题或路径。

### 1.2 文档检查

只检查文档时执行 `node scripts/check-docs.mjs`。根目录按脚本自身位置解析，不依赖机器盘符。返回码 0 表示声明的检查通过，1 表示失败；输出具体文件和原因。修改治理脚本时用 `scripts/check-docs.test.mjs` 的临时夹具验证失败传播，修改 workflow/ruleset 时另外解析配置并核对必需 job 名与 GitHub 返回结果。

| 当前自动覆盖 | 边界 |
| --- | --- |
| 仓库自有 Markdown 与登记表相互覆盖，状态/角色/日期等字段、替代目标合法 | 不识别真实用户审批；不检查第三方依赖和构建输出 |
| 登记表 `currentStage` 与条目 `retireAfter`：当前阶段晚于 `retireAfter` 而文件仍存在则失败 | 阶段顺序固定在脚本中；不判断提炼是否充分，由 A 抽查 |
| Markdown 行内相对链接、引用式定义和本地锚点存在，目标不逃逸仓库 | 不访问网络链接，不充当完整 Markdown/HTML 解析器；不检查代码块内示例路径 |
| CLAUDE 只引用 AGENTS | 不验证所有宿主是否自动加载仓库指令 |
| PRD 需求 ID 唯一、交付矩阵完整且不引用不存在需求/AT、AT/POC 定义唯一 | 不证明测试覆盖深度或需求合理性，不推断阶段子场景已通过 |
| 执行台账完整登记 POC 定义 | 不证明报告里的实际结果真实 |

链接采用仓库相对路径、ATX 标题或显式 HTML `id` 锚点；避免在文件名/链接内使用空格或嵌套括号。复杂 HTML 导航、外部 URL、Mermaid 语义和视觉渲染人工核对。

## 2. 阶段证据入口

阶段门禁的配置是 `scripts/stage/gate.json`（指纹覆盖范围、必需用例、基准目标与规模、包烟测阶段与窗口场景），当前阶段取自登记表的 `currentStage`，所以命令不带阶段名；每个阶段开始时 A 改写这份配置，统一入口为：

```powershell
node scripts/quick-gate.mjs [--phases a,b] # 日常的快速门禁（约 5 分钟内，见下方“两级门禁”）：verify、与改动相关的测试、点名的打包烟测阶段；不写证据
node scripts/stage.mjs gate        # 整套门禁（只在 B 交付整个阶段时跑一次），按最早暴露失败的顺序跑，结果仍然有效的步骤不重跑；不更新本机开发版
node scripts/stage.mjs test        # 全部 Vitest + 脚本自测，按必需用例匹配并写 cases.json、test-run.json
node scripts/stage.mjs bench       # 10,000 元数据 / 50,000 检索块的服务与隐藏 Electron 窗口基准，另含 5000 文件后台扫描、封面读取与 1000 条消息停靠栏、3000 条弹幕的播放、后台保留一个播放器的内存增量、调用追踪的开销与笔记写成 Markdown 文件的耗时，以及更新与发布的记录项
node scripts/stage.mjs package     # Windows 未签名包及其烟测阶段，写 package.json 与 scenarios.json，做出本通道的按用户安装包；不更新本机开发版
node scripts/stage.mjs installer   # 两个通道以测试安装身份（MANGA Test / MANGA Dev Test）装到临时目录、启动、0.1.1→0.1.2 覆盖升级演练、卸载，核对真实安装快照前后一致
node scripts/stage.mjs install-dev # 每次需要用户人工检查时由 Agent 执行（B 交付整个阶段、A 审查修复或返工后、按用户反馈修复后请用户复查；见开发流程）：若本机已安装开发版（MANGA Dev），让运行中的开发版保存并退出、静默更新并重开，写 install-dev.json，绝不碰正式版；已装的就是这个构建（版本相同且 app.asar 内容相同）时跳过，不请开发版退出
node scripts/stage.mjs release     # 在门禁通过的干净 main 上生成正式版安装包、块图、latest.yml、.sig、SHA256SUMS、发布说明并完成升级演练，写 release.json（无当次授权时不发布）
node scripts/stage.mjs report      # 核对上述结果并写 report.json
```

- 输出默认写到 Git 忽略的 `dist/evidence-runs/<跑次>/`（跑次默认 `current`，`STAGE_RUN` 指定其他）；路径计算正本为 `scripts/desktop-paths.ts`。只把审查需要引用的最终结果复制进 `docs/evidence/gate/`，入库证据不超过 5 MiB，下一阶段的门禁覆盖它。
- <a id="gate-tiers"></a>**两级门禁（2026-11-14 用户决定）。** 整套 `stage gate` 一次要 35—40 分钟，所以不再在每次修改后跑：
  - **整套门禁**：只在 B 把整个阶段交给 A 审查时跑一次。每周的发布流程在发布前仍按 `release.yml` 核对。
  - **快速门禁 `node scripts/quick-gate.mjs`**：其余时候都用它，包括阶段内的修改、A 审查的修复、返工、按用户反馈的修复与阶段内追加。目标 5 分钟内，依次跑：
    - `verify --skip-tests`；
    - 与自上次提交以来改动的文件相关的 Vitest（`vitest related`；`--all-tests` 跑全部）；
    - `--phases` 点名的打包烟测阶段（同 `MANGA_PACKAGE_PHASES`，只点改动涉及的，默认不跑）。
  - 快速门禁超过 300 秒时会提示，下次少点几个阶段；它不写证据，不能代替整套门禁。
  - 交付报告写清楚：整套门禁证据对应哪一份源码，之后的修改用快速门禁验证了什么。
- **`stage gate` 的顺序与跳过（LOOP-27）。** 依次是：`verify --skip-tests`（类型、knip、文档、发布与依赖边界，不跑测试）→ `test` → `package` → `installer` → `bench` → `report` 之前先把 `package` 补到连续通过的次数（`gate.json` 的 `package.passStreak`，现为 2：两次已能暴露偶发的窗口观察失败，第三次每次多花约 7 分钟，2026-11-14 改）→ `report`。一步要退出码为 0、且它的结果文件对现在的输入是 passed 才算通过；第一个失败就停。`report` 之前还核对真实的 `%LOCALAPPDATA%`：正式版与开发版的启动指针不能指向临时目录，测试安装身份的 `manga-test`、`manga-dev-test` 目录不能出现（门禁开始时已有的不算），否则门禁失败（A-06）。某一步在运行目录里的结果已通过、且它依赖的输入没变，就不再跑：只改了基准自己的代码时只重跑 `bench` 与 `report`，只改了测试时只重跑 `test`；改了产品源码、锁文件、构建脚本或门禁公共代码时全部重跑。基准排在第二次 `package` 之前，因为它最慢暴露失败，失败了后面的打包结果也要作废。每步用时写进运行目录的 `gate-run.json`（不是证据）；基准跑完后再列出它最慢的 5 段（`bench.json` 的 `records.sectionSeconds`，记录项，不设门槛），下一步提速先看这里。最终门禁开始后不再改工作树；修改先用 `MANGA_PACKAGE_PHASES`（加 `MANGA_PACKAGE_REUSE_BUILD=1`）只跑相关阶段确认，再跑 `stage gate`。跑门禁期间不要锁屏：锁屏时 Windows 的剪贴板被锁屏界面占住，读剪贴板的窗口观察会一直等。
- **发布流水线的检查（`stage test --ci`、`stage package --ci`）。** `release.yml` 的 check 在 GitHub 的 Windows 运行器上运行，那里生成不了三个可选样本：HEVC 10-bit 视频要 NVIDIA 编码器，30 分钟录音与短语音片段要 Windows 的中文语音。打包烟测同理：`gate.json` 的 `optionalSamplePhases` 列出的阶段（现为录音 `voice`，用短语音片段做假麦克风输入）在 `--ci` 下且样本确实“未生成”时不运行，`package.json` 的 `excusedPhases` 写明阶段与原因，其他阶段照常必须通过。用到它们的测试在样本缺失时报告为跳过。只有加 `--ci` 时，`gate.json` 的 `optionalSampleTests` 为必需测试列出的样本在样本清单里确实是“未生成”，这个测试的未运行才被接受：证据里它仍是 `not-run` 并写明原因，`test-run.json` 的 `excusedCases` 列出这些用例；其他未运行与任何失败照常让检查失败。阶段证据不用 `--ci`，`report` 仍要求每个必需用例都通过，所以开发机上的门禁必须生成全部样本。
- **指纹按结果区分。** `gate.json` 的 `fingerprint` 把输入分成组：产品源码（`packages`、`apps/desktop`、`plugins` 及清单，以 `!` 开头的条目从组里排除）、窗口走查装置（`apps/desktop/src/main/smoke/` 虽然打进包里，但只在 `--manga-smoke` 时运行，不算产品源码，按谁运行它分四组：各入口共用的 `smoke`（调度、驱动与基准也用的合成夹具 `fixtures.ts`）、测试也导入的 `smokeChecks`、只有基准运行的 `smokeBench`、只有 `package` 运行的 `smokeWalk`；只改一个走查时只重跑 `package`）、锁文件、构建脚本、门禁公共代码（`scripts/stage.mjs`、`lib.mjs`、`gate.json`、`gate.mjs`）、测试（含测试会导入的样本与安装配置脚本）、打包、基准、安装各自的脚本（`tests/helpers` 同时算在打包与基准里，因为它们用到这些替身）。每份结果记下全部组的指纹，报告只比较 `fingerprintOf` 为这份结果列出的组；`scripts/stage`、`scripts/samples` 与走查装置目录下没有归组的文件直接报错。`gate.json` 的 `packaged` 列出打进包里的全部组：`installer`、`install-dev` 与 `release` 判断一个包是不是当前输入打出的，核对的就是这些组。三个入口都在开始时取指纹，运行期间的修改会让结果判为过期，而不是记成修改后的状态。
- **连续通过与安装。** `package.json` 记下在同一组输入上连续通过的次数（`passStreak`）：完整运行开始时先删掉旧结果，失败就不留结果、下次从 1 数起；分阶段运行不写结果、也不影响计数。连续的几次运行要证明的是窗口观察稳定，不是重新打包：打包后在打包目录写 `build-stamp.json`（`packaged` 各组的指纹、构建环境的摘要与打包目录全部文件的摘要），下一次运行时这三项都没变就直接用这份包，同一份包打出的安装包也在字节与配置核对一致后沿用；用一次性插件签名密钥打的包不沿用。`package.json` 的 `build` 写明本次是否沿用。`installer` 一开始就同时打出它要用的 4 个测试身份安装包（两个通道、`0.1.2` 升级包与更新演练的下一个开发版，各用自己的工作目录），不再一个一个打；它只接受用当前输入打出的包，结果 `installer.json` 也由报告核对。
- **Electron 的校验和。** 打包时用已安装的 `electron` 包自带的 `checksums.json` 校验 Electron 压缩包，不再每次从 GitHub 取 `SHASUMS256.txt`，GitHub 出错不会让缓存里已有压缩包的打包失败。
- 报告门禁核对上述指纹；结果缺失、指纹不一致、必需用例缺项/重复/重分类/未通过、基准指标缺失或超目标、规模不足、打包烟测阶段缺失，一律非零退出。已声明的 blocked / not-run 项必须带负责人和复测入口（`limits.json`）。报告固定 `productAcceptance: "not-run"`，不计算阶段验收。
- 必需用例由测试的完整名称（含 `describe`）用正则匹配到用例编号；改测试名要同步 `scripts/stage/gate.json`。`scripts/stage-report.test.mjs` 用夹具验证缺项、旧指纹、失败基准、被重命名的用例和越权的验收声明都会被拒绝。
- 打包烟测用真实 Windows 包在合成样本和隔离 Profile 上驱动：初次启动/重启、Agent 发送与重启恢复（含运行中与停止态、重启后会话恢复）、阅读→记录→来源→重启恢复、四类格式页（含 LOOP-06：选中时页面只绘制一次且节点仍在文档中）、媒体（漫画与视频样本矩阵）、录音（Chromium 假采集设备播放合成语音）、`trace`（调用追踪时间线与复制：受控的假模型走一个带工具调用的任务，对话框、复制出的 JSON 与日志里搜不到密钥、认证头、令牌与本机路径）、`window-walk`（独立的全新 Profile，走过壳与导航、作品主页、停靠栏聊天窗口、调试面板、设置各页、扫描、手动匹配、快捷任务与三种窗口尺寸（含悬浮胶囊不压住播放器与漫画页的任何控件），再走工作区的窗口观察（`workspace-walk.ts`）：`workspace-frame`、`workspace-menu`、`tabs-open-restore`、`split-presets`、`split-move-video`、`split-focus-keys`、`context-switch`、`same-file-contexts`、`dock-follows-focus`，再走图标栏、侧栏、搜索框与设置视图的窗口观察（`rail-walk.ts`，A-99—A-102）：`rail-views`（主页与每个视图的侧栏内容，管理入口，点一项先切上下文再打开）、`rail-hide-more`（右键隐藏、“…”、图钉放回、矮窗、重启后保留）、`rail-hover-card`（真实鼠标与键盘走过侧栏收起时的悬浮卡片）、`search-popup`（范围、即时名字结果、正文结果、打开到正确的上下文、Esc 还焦点）、`settings-view`（进入与离开设置时工作区保持挂载，播放中的视频 `currentTime` 连续且没有 `emptied`）、`legacy-tabs-dropped`（保存了搜索、设置、插件、键盘快捷键标签的旧布局载入后去掉这些标签），每个场景写入 `scenarios.json`，`productAcceptance` 恒为 not-run）、`workspace-restart`（`workspace-restart.ts`：重启 `window-walk` 用过的那份 Profile，核对两个上下文的标签、布局与获得焦点的标签原样恢复；写完报告后换一种布局，60 ms 后用窗口自己的关闭真的关窗）、`workspace-closed`（再启动同一份 Profile，核对关窗前选的布局在库里与窗口里，页面在关窗之前回执，`close-saves-layout`）、`workspace-migrated`（用测试夹具 `tests/helpers/legacy-v11.ts` 在启动前做出的合成 v11 资料第一次启动，核对对话、已打开的资源与进度的去向，`migrated-profile`）；包内缺少随包工具时必须在启动时报错并点名。烟测装置在 `apps/desktop/src/main/smoke/`，只在 `--manga-smoke` 时动态加载，正常启动不加载（`tests/package/smoke-isolation.test.ts`）。
- 合成样本由 `node scripts/samples/generate-media-samples.mjs` 生成到 `dist/samples/media`（含清单与哈希），离线语音评测集由 `node scripts/voice-eval/generate-corpus.mjs` 生成到 `dist/samples/voice-eval`，均不提交；随包工具与门禁离线模型由 `scripts/tools/fetch-ffmpeg.mjs`、`fetch-silero-vad.mjs`、`fetch-subtitle-font.mjs`（ASS 字幕默认回退字体 Noto Sans SC 及其许可，OFL-1.1）、`fetch-gtcrn.mjs`（随包 16 kHz GTCRN 降噪模型 `gtcrn_simple.onnx` 及其 MIT 许可）与 `fetch-speech-asr.mjs`（仅缓存到 `dist/tools/asr/sense-voice-funasr-nano-int8/` 供本地测试、打包烟测与基准使用，绝不打进安装包）按锁定版本与哈希下载到 `dist/tools`。
- 扫描与停靠栏基准（`scripts/stage/bench-scan-pane.mjs`）：合成 5000 个文件（20 个系列 × 100 + 3000 个零散文件）的后台扫描连续 3 次，门禁要求主进程事件循环延迟 p99 ≤ 100 ms（≥ 1000 个 5 ms 采样）、扫描期间常用操作反馈 p95 ≤ 100 ms（≥ 300 个答复样本），并记录扫描吞吐、200 个封面的图片表读取与句柄冷/热读、1000 条消息的停靠栏滚动与输入（在打包窗口的 `bench-pane` 阶段测量，页面实际载入 ≥ 1000 条）；原始样本与摘要一致性同样核对。
- 播放器与保留的窗口观察由三组检查驱动（`player-menus-walk`：菜单、音量与全屏底栏的命中测试；`danmaku-walk`：弹幕层与假服务；`retention-walk`：设置往返、截图进白板），都用真实点击与命中测试，不用只看元素存在的检查。`window-walk` 的视频只有一个文件、一条音轨，没有选集与音轨菜单，这两个菜单由媒体阶段的 `menus:episodes-audio` 用多集文件夹和双音轨样本补上：在普通窗口与屏幕全屏下逐项命中测试，再选另一项并确认生效；`package.mjs` 要求它与 `subtitles:menus-hit-testable` 都跑过并通过。假弹幕服务和凭据泄露检查由 `package.mjs` 在回环地址上跑，请求只能用冒烟专用的假凭据签名。
- 基准 `danmaku3000LateFramePct`（`bench-danmaku` 阶段：20 秒内集中出现的 3000 条弹幕，打包窗口里连播 5 次，到达页面的时间晚于无弹幕时常规帧间隔 1.5 倍的帧占比，取最大）、`readerMemoryIncreaseMiB`（`bench-memory` 阶段，三个各自独立的窗口：设置盖在播放器上时应用各进程工作集比没有播放器时的增量；同一个窗口里第二个播放器几乎不再增加，所以每个样本一个窗口）、`traceOverheadP95Ms`（`bench-creative.mjs` 的 `runTraceBench`：约 80 KiB 的请求，记录开始、首字、完成三次调用的耗时，已有 400 条记录的表，200 次）；原始样本与摘要一致性同样核对，限值由实测后定，不放宽已有限值。
- 视图、侧栏与小说的窗口观察：`view-walk`（`view-main-linkage`、`hidden-layers`、`tab-reopen-place`、`quit-saves-layout`）、`shell-walk`（`shell-corner`、`sidebar-drag-collapse`、`menu-hover`、`rail-reorder`、`sidebar-home-list`、`sidebar-counts`、`media-view-covers`，真实鼠标与取色）、`novel-walk`（`novel-paginate`、`novel-side-panel`）、`danmaku-walk` 的 `danmaku-window-top`、`hold-walk` 的 `hold-rate-hint-only` 与 `hold-rate-recovers`、`library-walk` 的 `library-in-locations` 与 `scan-incremental`；每个视图的布局与“封面 / 列表”在重启后的恢复由 `workspace-restart` 核对。基准增加视图切换、封面、拖动晚到帧与小说翻页、改字号、开章（`bench-polish`）。无用代码由 knip 在 `verify` 里检查，入口见 `knip.json`。
- 文案、窗口按钮与笔记文件的检查：（1）**文案检查**（`tests/shell/copy-audit.test.ts`，随 `verify` 运行，A-93）：没有任何地方用的文案键（动态拼出的键名按固定部分识别，不为通过检查而删在用的文案）、同一个键写在两个目录文件里、写着已取消功能的固定说法（导入文件、标题栏、托管、娱乐模式、工作模式）、界面把内部标识原样渲染（`>{x.kind}<` 与 `: String(x.kind)` 这类写法）、渲染进程在文案目录之外写中文（只有发给模型的上下文字段名与调试面板里隐藏值的占位符不在此列）都失败，检查自带自测；（2）窗口观察：`frame-window-controls`（自绘窗口按钮的位置、深浅主题与悬停颜色、点击后窗口状态与页面同步）、`frame-window-fullscreen`（窗口全屏时按钮隐藏、8 px 拖动条的位置与 `app-region`、浮出区、栏顶浮出后按钮出现并点得到）、`overlays-comic`、`overlays-player`、`overlays-novel`（`overlay-walk.ts`：结束提示、播放状态提示、页码输入、框选截图的按钮、阅读设置面板在普通、窗口全屏、屏幕全屏下的命中测试，提示在底栏之上）；媒体阶段新增 `subtitles:shot-text`、`subtitles:shot-setting-off`、`picture:shot-ass-subtitles`（`shot-subtitles.ts`：按播放器的截图按钮存一张图，读回应用保存的文件，逐像素比较有字幕与没有字幕的两张图，核对字的个数、位置与画面上看到的一致，记录里的字幕文本与 `composited`；关闭“截图带字幕”后图里没有字幕）；（3）迁移用例见[领域模型](../design/domain-model.md)，用合成资料；（4）新增基准 `noteFileWriteP95Ms`（`bench-creative.mjs` 的 `runNoteFileBench`：属于一个资源的 200 块笔记，每次改一块文字、立即做排队的写入，200 次的 p95，目标 ≤ 25 ms，写入在保存之后的短暂等待之后、在主进程里，所以这是它占用窗口的时间；保存的答复时间另记在 `detail`、不计入）。A 复核时另加两处断言：（5）`creative-draft` 量文稿页、编辑器与建议面板的宽度，编辑器不足 360 px（文稿页本身更窄时为整页宽度）就失败（LOOP-22 第（1）项）；（6）`danmaku-layer` 的弹幕搜索从点击到列出结果超过 8 s 就失败，17 s 的等待只用于在没有响应时留下记录（`searchMs`，LOOP-21）。
- 依赖与 Agent 工程循环这一阶段加的窗口观察与基准：`loop` 阶段（独立 Profile）走 `workspace-last-tab-empty`、`library-tab-single`、`chat-long-session`（5000 条消息：首屏 ≤ 60 个消息节点、到顶自动载入、通知刷新与删除时视口不动、流式回答时贴底与不被拉回）、`agent-media-native`（四个假模型档案下 PDF 与视频按什么发送、超过上限的退回原因、调用记录不含内容）、`agent-media-retain`（同一张图存一份、把时钟拨过保留期后的占位、按来源重新提取、来源变了停下）；`credentials-async` 与重启（Electron 44 的打包产物保存过三种凭据的 Profile，见 `scripts/samples/build-legacy-credentials.mjs`；假模型、假弹弹play、假 Bangumi 核对收到的密钥、签名与令牌，数据库里没有明文）；`migrate-v13`、重启与 `migrate-v13-newer`（300 次运行的 v12 资料：备份、哈希多重集合、重试发送冻结的字节、第二次不再改动、较新的资料被拒绝）；`data-locations-fresh`（正式版与开发版各用临时的 `LOCALAPPDATA`、`APPDATA`、主目录、文档与下载启动一次：各分区的位置，漫游目录与主目录里没有文件；正式版的截图在盘符根下的临时目录里拍，路径不含账户名）与 `data-locations-upgrade`（旧版本放在“文档”里的 Profile：复制中途结束、完成升级、第二次启动、按旧指针启动跟着标记）。基准 `chatOpenP95Ms`、`chatInputP95Ms`、`chatLateFramePct`、`chatOlderPageP95Ms`（打包窗口的 `bench-chat` 阶段）、`clip60P95Ms`、`freeze4mbP95Ms`（`bench-agent-media.mjs`）；v13 迁移、500 MB 升级复制与 1000 / 5000 条消息时的内存是记录项（`bench.json` 的 `records`）。
- Agent 的待审操作与门禁提速这一阶段加的窗口观察、基准与门禁规则：（1）`loop` 阶段新增 7 条观察：`proposal-delete-rename`（删除被引用白板与重命名导图的卡片、确认与拒绝、下一轮带回结果）、`proposal-stale-once`（提议后改动文稿确认判为已失效、停靠栏与对话标签同时确认只执行一次）、`proposal-roughcut`（5 步粗剪编辑提议、确认后整步撤销、粗剪导出提议与输出校验）、`proposal-export-project`（项目包导出提议、往返一致性、取消保存对话框退回待确认）、`proposal-restart`（`pending` 与 `applying` 重启恢复）、`agent-opt-in`（按任务勾选 `webpage.fetch` 与 `semantic.search`、“最近”对话不显示抓取网页）、`migrate-v14`（v13 → v14 备份、迁移、幂等与旧版拒绝），以及 5 张截图（`ui-proposal-delete-light.png`、`ui-proposal-delete-dark.png`、`ui-proposal-decided.png`、`ui-chat-opt-in-menu.png`、滚到“模型能力”一节的 `ui-model-limits.png`）；（2）基准新增 `proposalProposeP95Ms`（500 个对象的项目里提出含反向引用查询的删除提议 p95 ≤ 150 ms）与 `proposalApplyP95Ms`（确认提议到对象与卡片更新 p95 ≤ 300 ms，`bench-creative.mjs` 的 `runProposalBench`），`records` 新增 `migrationV14`；（3）**烟测条件等待检查（LOOP-29）：** `apps/desktop/src/main/smoke/` 中等待元素出现/消失、状态更新或命令完成的固定 `sleep(` 一律换为条件等待（`driver.ts` 的 `waitUntil`、`waitForTestId`、`waitText`、`waitFrames`、`waitDrawn`），只保留按真实时间流逝的等待并必须在同行或上一行写明 `// real time: <原因>`，`verify.mjs` 调用 `findUncommentedSmokeSleeps()` 强制未注明原因的 `sleep(` 为 0（`tests/package/smoke-isolation.test.ts`）；（4）**测试临时目录计数（LOOP-28）：** `tests/helpers/global-temp.ts` 创建全局测试临时根并设置 `MANGA_TEST_TMP_ROOT`，同时把 `LOCALAPPDATA`、`APPDATA`、`MANGA_DOCUMENTS_DIR`、`MANGA_DOWNLOADS_DIR` 指到该根下（测试不写真实的启动指针与资料位置，`tests/runtime/test-places-isolation.test.ts`），`plugin-fixtures.ts` 与 `tests/helpers/app.ts` 的临时目录建在该根下并随测试结束统一清理；`stage test` 前后各统计一次系统临时目录里 `manga-*` 的数量并写入 `test-run.json`（`tempDirs`），Vitest、脚本自测与必需用例都通过后才清除本轮独立根，并要求实际 `before/after` 计数存在且 `left === 0`；失败保留本轮现场。新尝试在检查 runner 前立即作废旧通过结果，缺 runner 或缺报告不能复用旧证据。`package.json` 必须记录各阶段的实际 `phaseTimings`，`windowWalk.seconds` 与该阶段样本一致且不超过 240 秒，缺失或超限算失败。
- 阶段入口清理自己在系统临时目录留下的目录（LOOP-26，`scripts/stage/temp-dirs.mjs`）：只认 `manga-package-`、`manga-smoke-library-`、`manga-bench-`、`manga-cold-`、`manga-installer-`、`manga-release-rehearsal-`、`manga-release-build-`、`manga-update-`、`manga-smoke-key-` 这几个前缀，只删这次运行开始后出现的；通过时删除并在证据里记数量（`tempDirs`），失败时保留并在日志里列出名字。还有剩下的就算失败。
- 安装与自动更新的证据（A-124、A-125、A-126）：`scripts/stage/installer-lib.mjs` 定义保留的测试身份 `MANGA Test` / `MANGA Dev Test`；安装、更新演练与打包窗口观察只用这些身份。真实安装的卸载项、可执行文件、快捷方式和资料目录在运行前后快照比对，任何变化即失败。
- `package` 的 `update` 阶段是标明 `kind: "service-fixtures"` 的状态与界面夹具，覆盖版本与“关于”、提示及繁忙确认、拒绝路径、离线、开发版握手和工作流规则，并保留四张脱敏截图。它不作为真实安装或更新性能证据。
- `installer.json.updateRehearsal` 必须是 `kind: "electron-nsis"`：真实桌面与上游 `NsisUpdater` 下载，执行的 Test 安装包与已验签文件相同，核对安装后的 `app.asar`；完整下载后重启、从当前版本缓存差分下载后退出安装、Ed25519 拒绝被篡改文件、未保存笔记与工作区恢复、备份含已保存笔记、只提示一次。开发版还须证明真实保存退出、安装重开、正式版进程仍在运行，以及 30 秒退出超时撤回请求后写入完成也不退出。服务夹具、丢失草稿、执行文件不一致或虚构时序均被报告门禁拒绝。
- `bench.json.records.update` 的下载字节数、重启至就绪与 `installDev` 时间只取指纹匹配的真实安装演练；`stageReleaseMs` 只取实际 `release.json` 的真实演练，未运行时写 `null` 和 `status: "not-run"`。它们是记录项，不设门槛。发布存在上一版标签时先下载、验签和提取原发布包，再以 Test 身份演练；没有上一版标签时使用明确标记的首版种子，不能冒充已发布旧版本。
- 首个正式版、更新退路与轻量打开新增的窗口观察、安装演练与基准（A-127、A-128、A-129）：（1）`package` 新增独立的 `light` 烟测阶段（`scripts/stage/light-open.mjs` + `apps/desktop/src/main/light/smoke.ts`），驱动真实 `--manga-light` 进程核对 `light-boundary`（扫描 `app.asar` 内轻量构建产物不含重模块）、`light-video` / `light-video-episodes` / `light-video-playcopy`、`light-comic` / `light-comic-volumes` / `light-image-start-page`、`light-empty-window`、`light-unsupported-file`、`light-writes-only-its-folder`（`<应用数据根>\light\` 外零写入，`positions.json` 不含明文路径）、`light-multi-one-process`、`light-separate-lock`（与完整应用并存不抢锁）、`light-update`（更新与 `install-dev` 前 10 秒退出握手保存位置）以及深浅色截图；（2）`loop` 阶段新增 `voice-overlay`（116×36 悬浮框输入事件拖动、关闭前落盘恢复与麦克风图标音量深浅）、`recent-remove`（右键“从最近移除”、撤销、项目上下文隔离、资源库与作品主页显示 `progress_furthest`）与 `migrate-v15`（v14 → v15 备份、迁移、幂等与旧版拒绝），`update` 阶段核对“更新内容”气泡留白（LOOP-34）与已跳过版本的取消跳过；（3）`installer` 新增真实 `HKCU`“打开方式”注册表校验（验证 `OpenWithProgids`、`ProgID`、`Applications`、`Capabilities`、`RegisteredApplications` 写入，预设的既有 `.<ext>` 默认值原封不动，卸载后测试身份键零残留）以及启动失败回退演练 `update-rollback`（`scripts/stage/rollback-rehearsal.mjs`：测试身份安装 `0.1.1` 写库 → 升级到带 schema 迁移且设 `MANGA_TEST_FAIL_LAUNCH=1` 的 `0.1.2` → 前两次崩溃不弹窗、第三次弹出退路框 → 校验 `SHA-512`、将已升级库改名为 `rolledback-*` 后恢复 `premigrate` 备份并重装回 `0.1.1` → 验证数据完好并跳过 `0.1.2`；篡改旧安装包 1 字节时隐藏回退按钮）；（4）基准新增轻量冷启动指标 `lightVideoFirstFrameMs`（p95 ≤ 2000 ms）、`lightComicFirstPageMs`（p95 ≤ 1500 ms）、已开轻量进程再开第二个文件 `lightSecondOpenMs`（p95 ≤ 800 ms），并在 `light.records` 与 `records` 记录轻量进程工作集内存、完整应用打开同一文件的对照耗时及 `v13 → v15` 迁移耗时（`migrationV14`）；`bench` 分段总耗时目标控制在 450 秒内。
- 应用内听写、本地离线语音引擎与二次元词库新增的窗口观察、评测与基准（A-130、A-131）：（1）打包烟测扩展 `voice` 阶段与听写观察：`dictation-insert`（在对话栏输入框、笔记、文稿、白板卡片文字与搜索框按住听写插入、双击免提锁定、`Esc` 取消零请求、输入法组合屏障、识别中切走焦点仍插回原处、原输入处已关闭时给出可复制结果、对话栏“问 Agent”与“笔记”双模式麦克风及 Agent 工具零听写暴露）、`dictation-local`（`asr-host` `utilityProcess` 载入门禁锁定的 `sense-voice-funasr-nano-int8` 完成合成语音识别、强杀推理子进程后提示并在下次听写自动拉起、闲置超时卸载释放内存）、`dictation-revert`（插入后 10 秒提示条点“恢复原文”与 `Ctrl+Z` 分步退回、60 秒内修改专名触发学词建议的确认与忽略、听写记录复制/删除/清空以及备份与资料包剔除核验）、`dictation-settings`（五节“设置 › 语音转录”、本地模型确认下载/Range 断点续传/本地校验导入/删除、词典别名与假 Bangumi 角色详情补全、模型连接弹窗的转录接口单选）、`dictation-boundary`（核验打包产物中 `sherpa-onnx-node` 只出现在 `asr-host.cjs` 闭包，`main.cjs`、`full-main.cjs` 与 `light-main.cjs` 零引用，且安装包内不含任何离线 ASR 模型文件）；（2）固定纠错回归门槛：`tests/fixtures/voice-correction.json`（252 条识别文本与期望文本对，标明来源与错误类别）由 `tests/voice/correction-eval-gate.test.ts` 守护专名召回率 ≥ 0.85、非专名句子误改率 ≤ 1%；（3）离线评测与基准：`scripts/voice-eval/run-eval.mjs` 在 80 句虚构二次元语料 × 3 种声学条件（安静、风扇底噪、人声干扰，共 240 条合成 WAV）上输出各已装本地模型在“仅识别 → 加音近替换 → 加润色”三步的字错率、专名召回率、误改率及前端降噪开关（`browserNoiseSuppression`、`autoGainControl`、GTCRN 75% 混合 vs 100% vs 关闭）对照；`scripts/stage/bench-dictation.mjs` 守护硬门槛 `dictationLocalReleaseToTextMs`（极速模型已载入、约 4 s 合成语音从松键到文字上屏 `p95 ≤ 1500 ms`）与 `dictationCorrectionMs`（10,000 条词条单句替换 `p95 ≤ 30 ms`），并在 `bench.json` 的 `records` 中记录模型载入时间、`asr-host` 进程工作集内存、评测指标与 v15 → v16 迁移耗时。
- 三条窗口观察按页面内的时间判断（LOOP-27）：`hold-rate-hint-only` 与 `hold-rate-recovers` 读页面记下的按键与倍速变化的时刻（`performance.now()`），按住时长与门槛不变，脚本的等待只用来等结果；`frame-window-controls` 取色前确认窗口有焦点、指针命中按钮且处于 `:hover`，被抢走时重新聚焦重做一次并记下次数。
- 窗口性能指标由实际 Electron 原始样本计算，门禁核对有限非负数、p95 阈值、样本数量及摘要一致性；隐藏窗口计时截至 DOM 可用，不是绘制帧或显示器延迟，也不外推到其他设备。
- 打包烟测的窗口显示在开发者自己的桌面上（不抢键盘焦点）。烟测模式（只在 `--manga-smoke` 时）关闭 Chromium 的窗口遮挡检测与渲染进程降级，所以其他窗口盖住它不会让 CSS 过渡与布局停在中途。真实鼠标指针停在哪里取决于人手：停在阅读器底栏上的指针会让自动隐藏的控制栏一直留在屏幕上，所以窗口观察在检查“控制栏隐去”之前先用合成事件把页内指针移到页面中央，不依赖指针原来的位置。烟测窗口还让系统鼠标穿过（`setIgnoreMouseEvents`，同样只在 `--manga-smoke` 时）：窗口观察的点击与拖动都是发给页面的合成事件，人手移动鼠标经过窗口时，真实的移动不会混进拖动或点击而让它随机失败（2026-11-13 实测：指针在显示出来的烟测窗口内的采样占 770/859，同一观察时过时不过），跑 `stage package` 时不必避开窗口。基准与烟测仍应在尽量空闲的机器上跑：开发机在持续负载下会降速（一次实测：单线程循环几秒后的耗时是开头的约 1.6 倍），CPU 密集的基准指标（30 MiB EPUB 末尾、导图折叠、语义检索）在这种状态下可慢 2—3 倍而超出门槛，所以基准失败时先确认机器空闲再复跑，不改目标；失败的数字与复跑结果写进交付报告。启动基准的终端或应用也要留在前台：2026-10-09 同一份源码在前台是另一个应用时连跑 3 次都超出（所有指标同时慢 2.5—3.7 倍，连纯 Node 的调用记录开销也是，而当时 CPU、磁盘都空闲），把启动它的应用切到前台后一次通过、数值回到以前通过时的水平，符合 Windows 对后台进程的节能降速（LOOP-13）。

### 2.1 真实服务与本机资源（默认关闭，不进 CI）

| 开关 | 内容与边界 |
| --- | --- |
| `MANGA_LIVE_BANGUMI=1` | Bangumi 只读契约（含条目、角色与人员端点）：不用凭据，每次不超过 10 个请求，证据只含端点、结果与计数；网络不可达记 blocked（可带 `NODE_USE_ENV_PROXY=1` 与代理） |
| `MANGA_LIVE_ASR=1` | 本地忽略的测试配置里的外部转录服务（含标准 `/audio/transcriptions` 与 `/chat/completions` `input_audio` 对话音频输入，[ACT-21](../../USER-ACTIONS.md#act-21)）：只发送合成语音与虚构人名提示，每个连接不超过 5 个请求（总计不超过 10 个），配置缺失或未授权记 not-run；只记录请求是否被接受及返回文字与期望相似度，配置值与密钥不打印、不写入证据 |
| `MANGA_LIVE_VOICE_EVAL_LLM=1`（`scripts/voice-eval/run-eval.mjs`） | 离线语音评测脚本的真实文本模型润色对照：仅在显式开启且 `.env.local` 配有 `MANGA_TEST_LLM_*` 时对虚构二次元语料调用文本模型验证轻度润色与四道防线；默认关闭时仅跑离线确定性润色，绝不读取无关环境变量或打印凭据 |
| `MANGA_LIVE_MODELS=1` + `node scripts/live-models.mjs` | LLM/Embedding/ASR 的有限短测，只发送合成内容；整条产品路径的真实调用见下一行 |
| `MANGA_LIVE_MODEL_CONTRACT=1`（`tests/real/model-contract.test.ts`） | 本地忽略的测试配置里的文本与 Embedding 服务（`MANGA_TEST_LLM_*`、`MANGA_TEST_EMBEDDING_*`）走产品自己的路径：连接测试、带图片的任务（文本模型不收图时须带原因拒绝）、用工具查书、整理录音、按语义搜索、压缩长对话后保住事实、凭据不落盘。全部内容为合成样本；请求经回环地址上的转发器按类计数，超出预算（默认文本 30、图片 3、Embedding 10、模型列表 4，可用 `MANGA_LIVE_MODEL_BUDGET="text=12,embedding=4"` 调整）即拒绝；证据只含结果、计数、耗时和每个请求的形状（结束原因、回答长度、是否为空、调用的工具名），不含模型写的内容；配置值不打印、不写入证据 |
| `MANGA_LIVE_DANDANPLAY=1`（`tests/real/dandanplay-contract.test.ts`） | 弹弹play 开放接口契约，经产品的客户端签名：搜索一部公开作品、映射公开的 Bangumi 条目、读一集弹幕、用编造的文件描述匹配（须不命中）；每次不超过 `MANGA_LIVE_DANDANPLAY_BUDGET`（默认 7）个请求，第一次被拒即停（记 blocked）；应用凭据取自被忽略的本地配置，不打印、不写入证据，证据只含结果与计数 |
| `MANGA_REAL_SAMPLES=1`，配合 `MANGA_TEST_LIBRARY_NOVEL`、`MANGA_TEST_LIBRARY_MANGA`、`MANGA_TEST_LIBRARY_ANIME` | 开发者自己各媒介资源根的只读打开试验（遍历整库，需数分钟，不进 CI）：路径取自进程环境或被忽略的 `.env.local`（测试只读取这三个键，其余键不读、不打印）；缺哪个就跳过哪个；不复制、不写入源目录，摘要只含数量与类别，不含文件名与路径 |
| `MANGA_REAL_SAMPLES=1`，配合 `MANGA_TEST_LIBRARY_ANIME`（`tests/real/real-import.test.ts`） | 开发者自己的动漫目录的只读导入试验（AT-80）：作为资源库位置加进全新 Profile，扫描固定时长（预算 `MANGA_REAL_IMPORT_BUDGET_MS`，默认 240000 ms）；不复制、不改动源文件，摘要只含数字：第一部作品出现的时间、处理的文件数、媒体工具运行的次数与类型（读遍数据包的运行必须为 0）、卷的读盘量（系统能给出时） |
| `MANGA_SMOKE_ONLY=real`，配合 `MANGA_SMOKE_REAL_ANIME`（要试的根目录，可用 `MANGA_SMOKE_REAL_SKIP` 跳过前若干个符合条件的文件夹），在打包版的 `media` 烟测阶段手动运行，不属于门禁 | 打包版播放器在开发者动漫目录上的只读试验：把一个有多个视频的文件夹加为全新 Profile 的资源库位置，打开最多 4 集各播放几秒，选字幕轨；摘要只含数字：首帧时间、4 秒解码与丢弃的帧数、有没有出“没有画面”状态、字幕渲染器与默认字体来源、样式要求而没有的字体数、字幕轨到渲染器就绪的时间；每集再用播放器的截图按钮在片头附近与中段各存一张图（存进全新 Profile 的内容文件夹，试验结束后随临时目录删除），摘要只记点击到记录出现的耗时、各分辨率的张数、与解码尺寸一致的张数，以及记录里写了已合成字幕的张数与那一刻有台词的张数（按设置默认带字幕）；不保留画面、不记录文件名与路径 |

这些结果只证明被测接口当时的形状与协议，不代表服务的长期可用或产品验收。

## 3. 应用与工程门禁

正式工程的测试工具按 [ADR-0007](../decisions/0007-technology-stack.md) 采用 Vitest、Testing Library/jsdom 和对应浏览器烟测的 playwright-core。jsdom 测试用文件头 `/** @vitest-environment jsdom */`，共享设置在 `tests/helpers/`；jsdom 和浏览器烟测不替代 Electron 原生输入法与设备实测。Vitest 按文件并行，工作进程数是逻辑处理器的一半（开发机上全部用例约 70 s，逐个文件跑时约 480 s）；等渲染的界面用例要用 `findBy*` / `waitFor` 等到元素出现，不能在首次渲染后同步取。Vitest 的测试进程带 `--no-wasm-code-gc`：Node 24 所带的 V8 在工作线程结束、回收 WebAssembly 代码时偶发致命错误（[LOOP-08](../delivery/status.md#loop-08)），这个参数只作用于测试进程，不影响应用（应用跑在 Electron 自带的 V8 上）；Node 24.x 发行带上修复后去掉。

产品 AT 仍按阶段执行，不能用 POC 子集标为 passed。

| 变更范围 | 必需验证 |
| --- | --- |
| 文档 | 本地文档检查；确认正本、决定和验收语义一致 |
| 业务代码 | 受影响包类型检查、静态检查与有意义的场景测试 |
| 公共契约、依赖或构建 | 使用方兼容、依赖边界、相关集成与打包冒烟 |
| 数据、锚点、迁移、备份 | 旧数据夹具、版本/引用保持、失败恢复、备份往返 |
| Agent、插件、装配 | 可控提供者、范围限制、取消/重试、激活失败、停用竞态与旧代次拒绝 |
| 媒体、录音、外部适配器 | 固定样本、设备/时钟、格式组合、限流/断网与必要真实服务契约 |
| UI | 键盘/输入法、窗口/DPI、完整状态、已承诺主题与最终界面证据 |
| 发布 | 当前阶段 AT、目标平台安装包、升级/恢复、支持矩阵与已知限制 |

应用相关命令存在后必须运行相应检查；命令不存在时补齐实现或明确记录阻塞，不能使用 `--if-present` 静默把缺少关键检查当成成功。合理低风险豁免写明不适用原因。

## 4. 证据与失败处理

按 [报告模板](../templates/validation-report.md)记录输入、版本、环境、实际结果和限制，更新 [执行状态](../delivery/status.md)。检查基础设施变化至少验证能检出一个真实反例，避免脚本永远返回成功。

已合并阶段的过程证据按[阶段开始的整理](../governance/documentation-policy.md#stage-cleanup)在下一阶段提炼进执行状态等不分阶段的正本后删除，`docs/evidence/gate/` 只留最近一次门禁的结果，Git 历史是归档。

环境失败、业务失败和未执行分别报告。不能删测试、弱化断言、重写旧结果或改验收目标来制造通过；合理需求调整由有效决定驱动并同步正本。模型、网络和设备的非确定性场景使用可控故障夹具验证协议，有限真实测试验证实际适配。

## 5. CI 接线与扩展

`.github/workflows/ci.yml` 在面向 main 的 PR 更新及手动触发时运行统一入口，必需状态名称为 `repository-quality`。不设置路径过滤、main push 重复检查或定时全量扫描；触发、权限、Ruleset 与失败处理见 [Git 与 GitHub](git-and-github.md)，实际远端结果以对应 PR 为准。

当前 CI 安装锁定依赖并运行 `verify.mjs`。Windows 包、完整阶段测试与性能走阶段入口，不纳入无 Windows 桌面的 CI；CI 以 `MANGA_MEDIA_PREREQUISITES=absent` 运行，需要合成样本、固定 FFmpeg 或语音模型的用例（约 140 个）在 CI 记为跳过，由本地 `verify.mjs` 与 `stage test` 覆盖（`tests/helpers/prerequisites.ts`）；真实服务与设备项不进 CI。人工评审仍负责语义和证据质量。不把 CI 成功当作阶段退出或产品发布验证。新增 Actions 需同时更新远端 allowlist，新增必需 job 需先验证真实产出再切换 Ruleset。

门禁反例：`scripts/check-deps.mjs` 内置错误导入自测（含越出包目录的相对导入必须报错、包内相对导入必须通过）；`scripts/stage-report.test.mjs` 检查报告对缺项、陈旧指纹、失败包和性能的拒绝；`scripts/check-docs.test.mjs` 检查过期文档与登记缺口会被拒绝。失败必须非零。
