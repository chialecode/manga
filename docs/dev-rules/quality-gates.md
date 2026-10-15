# 验证与质量门禁

按变更风险选择最小充分检查。已通过后只有新改动、失败或未解决风险才扩大/重复验证。不能为了形式给错字修复增加应用测试，也不能以文档检查代替迁移或运行验证。

## 1. 当前可以执行的检查

前置条件：Git 与 Node.js 24 或更新版本；CI 使用 `.node-version`（Node.js 24.19.0）。从仓库根：

```powershell
pnpm install
node scripts/verify.mjs
```

`verify.mjs` 是本地与 CI 共用的统一入口，依次检查：`scripts/` 顶层 MJS 语法；文档登记表与 GitHub 配置 JSON；文档结构（`check-docs.mjs`）；公开内容检查及其反例；文档检查与阶段报告门禁的反例自测；包依赖方向（`check-deps.mjs`，含内置反例）；根与 `apps/desktop` 两个 `tsc --noEmit`；全部 Vitest；`git diff --check` 与 `git diff --cached --check`。它不安装依赖；缺少 `node_modules` 或 vitest 时非零退出，不使用 `--if-present`。10 MiB TXT 与 30 MiB EPUB 等大文件用例只在 `MANGA_LARGE_FILES=1` 时运行，阶段入口会设置它。需要合成样本、固定 FFmpeg 或语音模型的用例在这些前置缺失时失败；只有声明了 `MANGA_MEDIA_PREREQUISITES=absent` 的环境（CI）才把它们记为跳过，阶段入口会清除这个变量。

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
node scripts/stage.mjs test      # 全部 Vitest + 脚本自测，按必需用例匹配并写 cases.json、test-run.json
node scripts/stage.mjs bench     # 10,000 元数据 / 50,000 检索块的服务与隐藏 Electron 窗口基准，另含 5000 文件后台扫描、封面读取与 1000 条消息右栏、3000 条弹幕的播放、后台保留一个播放器的内存增量、调用追踪的开销与笔记写成 Markdown 文件的耗时
node scripts/stage.mjs package   # Windows 未签名包及其烟测阶段，写 package.json 与 scenarios.json
node scripts/stage.mjs report    # 核对上述结果并写 report.json
```

- 输出默认写到 Git 忽略的 `dist/evidence-runs/<跑次>/`（跑次默认 `current`，`STAGE_RUN` 指定其他）；路径计算正本为 `scripts/desktop-paths.ts`。只把审查需要引用的最终结果复制进 `docs/evidence/gate/`，入库证据不超过 5 MiB，下一阶段的门禁覆盖它。
- 报告门禁核对源码（`packages`、`apps/desktop`、`plugins` 及清单）、锁文件、测试与样本脚本、构建脚本四类指纹；结果缺失、指纹不一致、必需用例缺项/重复/重分类/未通过、基准指标缺失或超目标、规模不足、打包烟测阶段缺失，一律非零退出。已声明的 blocked / not-run 项必须带负责人和复测入口（`limits.json`）。报告固定 `productAcceptance: "not-run"`，不计算阶段验收。
- 必需用例由测试的完整名称（含 `describe`）用正则匹配到用例编号；改测试名要同步 `scripts/stage/gate.json`。`scripts/stage-report.test.mjs` 用夹具验证缺项、旧指纹、失败基准、被重命名的用例和越权的验收声明都会被拒绝。
- 打包烟测用真实 Windows 包在合成样本和隔离 Profile 上驱动：初次启动/重启、Agent 发送与重启恢复（含运行中与停止态、重启后会话恢复）、阅读→记录→来源→重启恢复、四类格式页（含 LOOP-06：选中时页面只绘制一次且节点仍在文档中）、媒体（漫画与视频样本矩阵）、录音（Chromium 假采集设备播放合成语音）、`trace`（调用追踪时间线与复制：受控的假模型走一个带工具调用的任务，对话框、复制出的 JSON 与日志里搜不到密钥、认证头、令牌与本机路径）、`window-walk`（独立的全新 Profile，走过壳与导航、作品主页、右栏聊天窗口、调试面板、设置各页、扫描、手动匹配、快捷任务与三种窗口尺寸（含悬浮胶囊不压住播放器与漫画页的任何控件），每个场景写入 `scenarios.json`，`productAcceptance` 恒为 not-run）；包内缺少随包工具时必须在启动时报错并点名。烟测装置在 `apps/desktop/src/main/smoke/`，只在 `--manga-smoke` 时动态加载，正常启动不加载（`tests/package/smoke-isolation.test.ts`）。
- 合成样本由 `node scripts/samples/generate-media-samples.mjs` 生成到 `dist/samples/media`（含清单与哈希），不提交；随包工具由 `scripts/tools/fetch-ffmpeg.mjs`、`fetch-silero-vad.mjs`、`fetch-subtitle-font.mjs`（ASS 字幕默认回退字体 Noto Sans SC 及其许可，OFL-1.1）按锁定版本与哈希下载到 `dist/tools`。
- 扫描与右栏基准（`scripts/stage/bench-scan-pane.mjs`）：合成 5000 个文件（20 个系列 × 100 + 3000 个零散文件）的后台扫描连续 3 次，门禁要求主进程事件循环延迟 p99 ≤ 100 ms（≥ 1000 个 5 ms 采样）、扫描期间常用操作反馈 p95 ≤ 100 ms（≥ 300 个答复样本），并记录扫描吞吐、200 个封面的图片表读取与句柄冷/热读、1000 条消息的右栏滚动与输入（在打包窗口的 `bench-pane` 阶段测量，页面实际载入 ≥ 1000 条）；原始样本与摘要一致性同样核对。
- 第二轮返工新增的窗口观察由三组检查驱动（`player-menus-walk`：菜单、音量与全屏底栏的命中测试；`danmaku-walk`：弹幕层与假服务；`rework-walk`：设置往返、两种模式、截图进白板），都用真实点击与命中测试，不用只看元素存在的检查。`window-walk` 的视频只有一个文件、一条音轨，没有选集与音轨菜单，这两个菜单由媒体阶段的 `menus:episodes-audio` 用多集文件夹和双音轨样本补上：在普通窗口与屏幕全屏下逐项命中测试，再选另一项并确认生效；`package.mjs` 要求它与 `subtitles:menus-hit-testable` 都跑过并通过。假弹幕服务和凭据泄露检查由 `package.mjs` 在回环地址上跑，请求只能用冒烟专用的假凭据签名。
- 第二轮返工新增的基准：`danmaku3000LateFramePct`（`bench-danmaku` 阶段：20 秒内集中出现的 3000 条弹幕，打包窗口里连播 5 次，到达页面的时间晚于无弹幕时常规帧间隔 1.5 倍的帧占比，取最大）、`readerMemoryIncreaseMiB`（`bench-memory` 阶段，三个各自独立的窗口：设置盖在播放器上时应用各进程工作集比没有播放器时的增量；同一个窗口里第二个播放器几乎不再增加，所以每个样本一个窗口）、`traceOverheadP95Ms`（`bench-creative.mjs` 的 `runTraceBench`：约 80 KiB 的请求，记录开始、首字、完成三次调用的耗时，已有 400 条记录的表，200 次）；原始样本与摘要一致性同样核对，限值由实测后定，不放宽已有限值。
- 第三轮返工新增的检查：（1）**文案检查**（`tests/shell/copy-audit.test.ts`，随 `verify` 运行，A-93）：没有任何地方用的文案键（动态拼出的键名按固定部分识别，不为通过检查而删在用的文案）、同一个键写在两个目录文件里、写着已取消功能的固定说法（导入文件、标题栏、托管）、界面把内部标识原样渲染（`>{x.kind}<` 与 `: String(x.kind)` 这类写法）、渲染进程在文案目录之外写中文（只有发给模型的上下文字段名与调试面板里隐藏值的占位符不在此列）都失败，检查自带自测；（2）窗口观察：`frame-window-controls`（自绘窗口按钮的位置、深浅主题与悬停颜色、点击后窗口状态与页面同步）、`frame-window-fullscreen`（窗口全屏时按钮隐藏、8 px 拖动条的位置与 `app-region`、浮出区、栏顶浮出后按钮出现并点得到）、`overlays-comic`、`overlays-player`、`overlays-novel`（`overlay-walk.ts`：结束提示、播放状态提示、页码输入、框选截图的按钮、阅读设置面板在普通、窗口全屏、屏幕全屏下的命中测试，提示在底栏之上）；媒体阶段新增 `subtitles:shot-text`、`subtitles:shot-setting-off`、`picture:shot-ass-subtitles`（`shot-subtitles.ts`：按播放器的截图按钮存一张图，读回应用保存的文件，逐像素比较有字幕与没有字幕的两张图，核对字的个数、位置与画面上看到的一致，记录里的字幕文本与 `composited`；关闭“截图带字幕”后图里没有字幕）；（3）迁移用例见[领域模型](../design/domain-model.md)，用合成资料；（4）新增基准 `noteFileWriteP95Ms`（`bench-creative.mjs` 的 `runNoteFileBench`：属于一个资源的 200 块笔记，每次改一块文字、立即做排队的写入，200 次的 p95，目标 ≤ 25 ms，写入在保存之后的短暂等待之后、在主进程里，所以这是它占用窗口的时间；保存的答复时间另记在 `detail`、不计入）。A 复核时另加两处断言：（5）`creative-draft` 量文稿页、编辑器与建议面板的宽度，编辑器不足 360 px（文稿页本身更窄时为整页宽度）就失败（LOOP-22 第（1）项）；（6）`danmaku-layer` 的弹幕搜索从点击到列出结果超过 8 s 就失败，17 s 的等待只用于在没有响应时留下记录（`searchMs`，LOOP-21）。
- 窗口性能指标由实际 Electron 原始样本计算，门禁核对有限非负数、p95 阈值、样本数量及摘要一致性；隐藏窗口计时截至 DOM 可用，不是绘制帧或显示器延迟，也不外推到其他设备。
- 打包烟测的窗口显示在开发者自己的桌面上（不抢键盘焦点）。烟测模式（只在 `--manga-smoke` 时）关闭 Chromium 的窗口遮挡检测与渲染进程降级，所以其他窗口盖住它不会让 CSS 过渡与布局停在中途。真实鼠标指针停在哪里取决于人手：停在阅读器底栏上的指针会让自动隐藏的控制栏一直留在屏幕上，所以窗口观察在检查“控制栏隐去”之前先用合成事件把页内指针移到页面中央，不依赖指针原来的位置；跑 `stage package` 时仍请把指针放在窗口之外。基准与烟测仍应在尽量空闲的机器上跑：开发机在持续负载下会降速（一次实测：单线程循环几秒后的耗时是开头的约 1.6 倍），CPU 密集的基准指标（30 MiB EPUB 末尾、导图折叠、语义检索）在这种状态下可慢 2—3 倍而超出门槛，所以基准失败时先确认机器空闲再复跑，不改目标；失败的数字与复跑结果写进交付报告。启动基准的终端或应用也要留在前台：2026-10-09 同一份源码在前台是另一个应用时连跑 3 次都超出（所有指标同时慢 2.5—3.7 倍，连纯 Node 的调用记录开销也是，而当时 CPU、磁盘都空闲），把启动它的应用切到前台后一次通过、数值回到以前通过时的水平，符合 Windows 对后台进程的节能降速（LOOP-13）。

### 2.1 真实服务与本机资源（默认关闭，不进 CI）

| 开关 | 内容与边界 |
| --- | --- |
| `MANGA_LIVE_BANGUMI=1` | Bangumi 只读契约（含条目、角色与人员端点）：不用凭据，每次不超过 10 个请求，证据只含端点、结果与计数；网络不可达记 blocked（可带 `NODE_USE_ENV_PROXY=1` 与代理） |
| `MANGA_LIVE_ASR=1` | 本地忽略的测试配置里的 ASR 服务：只发送样本生成器的合成 TTS 语音，每次不超过 10 个请求，配置缺失记 not-run；配置值不打印、不写入证据 |
| `MANGA_LIVE_MODELS=1` + `node scripts/live-models.mjs` | LLM/Embedding/ASR 的有限短测，只发送合成内容；整条产品路径的真实调用见下一行 |
| `MANGA_LIVE_MODEL_CONTRACT=1`（`tests/real/model-contract.test.ts`） | 本地忽略的测试配置里的文本与 Embedding 服务（`MANGA_TEST_LLM_*`、`MANGA_TEST_EMBEDDING_*`）走产品自己的路径：连接测试、带图片的任务（文本模型不收图时须带原因拒绝）、用工具查书、整理录音、按语义搜索、压缩长对话后保住事实、凭据不落盘。全部内容为合成样本；请求经回环地址上的转发器按类计数，超出预算（默认文本 30、图片 3、Embedding 10、模型列表 4，可用 `MANGA_LIVE_MODEL_BUDGET="text=12,embedding=4"` 调整）即拒绝；证据只含结果、计数、耗时和每个请求的形状（结束原因、回答长度、是否为空、调用的工具名），不含模型写的内容；配置值不打印、不写入证据 |
| `MANGA_LIVE_DANDANPLAY=1`（`tests/real/dandanplay-contract.test.ts`） | 弹弹play 开放接口契约，经产品的客户端签名：搜索一部公开作品、映射公开的 Bangumi 条目、读一集弹幕、用编造的文件描述匹配（须不命中）；每次不超过 `MANGA_LIVE_DANDANPLAY_BUDGET`（默认 7）个请求，第一次被拒即停（记 blocked）；应用凭据取自被忽略的本地配置，不打印、不写入证据，证据只含结果与计数 |
| `MANGA_REAL_SAMPLES=1`，配合 `MANGA_TEST_LIBRARY_NOVEL`、`MANGA_TEST_LIBRARY_MANGA`、`MANGA_TEST_LIBRARY_ANIME` | 开发者自己各媒介资源根的只读打开试验（遍历整库，需数分钟，不进 CI）：路径取自进程环境或被忽略的 `.env.local`（测试只读取这三个键，其余键不读、不打印）；缺哪个就跳过哪个；不复制、不写入源目录，摘要只含数量与类别，不含文件名与路径 |
| `MANGA_REAL_SAMPLES=1`，配合 `MANGA_TEST_LIBRARY_ANIME`（`tests/real/real-import.test.ts`） | 开发者自己的动漫目录的只读导入试验（AT-80）：作为资源库位置加进全新 Profile，扫描固定时长（预算 `MANGA_REAL_IMPORT_BUDGET_MS`，默认 240000 ms）；不复制、不改动源文件，摘要只含数字：第一部作品出现的时间、处理的文件数、媒体工具运行的次数与类型（读遍数据包的运行必须为 0）、卷的读盘量（系统能给出时） |
| `MANGA_SMOKE_ONLY=real`，配合 `MANGA_SMOKE_REAL_ANIME`（要试的根目录，可用 `MANGA_SMOKE_REAL_SKIP` 跳过前若干个符合条件的文件夹），在打包版的 `media` 烟测阶段手动运行，不属于门禁 | 打包版播放器在开发者动漫目录上的只读试验：把一个有多个视频的文件夹加为全新 Profile 的资源库位置，打开最多 4 集各播放几秒，选字幕轨；摘要只含数字：首帧时间、4 秒解码与丢弃的帧数、有没有出“没有画面”状态、字幕渲染器与默认字体来源、样式要求而没有的字体数、字幕轨到渲染器就绪的时间；每集再用播放器的截图按钮在片头附近与中段各存一张图（存进全新 Profile 的内容文件夹，试验结束后随临时目录删除），摘要只记点击到记录出现的耗时、各分辨率的张数、与解码尺寸一致的张数，以及记录里写了已合成字幕的张数与那一刻有台词的张数（按设置默认带字幕）；不保留画面、不记录文件名与路径 |

这些结果只证明被测接口当时的形状与协议，不代表服务的长期可用或产品验收。

## 3. 应用与工程门禁

正式工程的测试工具按 [ADR-0007](../decisions/0007-technology-stack.md) 采用 Vitest、Testing Library/jsdom 和对应浏览器烟测的 playwright-core。jsdom 测试用文件头 `/** @vitest-environment jsdom */`，共享设置在 `tests/helpers/`；jsdom 和浏览器烟测不替代 Electron 原生输入法与设备实测。Vitest 的测试进程带 `--no-wasm-code-gc`：Node 24 所带的 V8 在工作线程结束、回收 WebAssembly 代码时偶发致命错误（[LOOP-08](../delivery/status.md#loop-08)），这个参数只作用于测试进程，不影响应用（应用跑在 Electron 自带的 V8 上）；Node 24.x 发行带上修复后去掉。

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
