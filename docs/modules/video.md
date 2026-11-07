# 视频模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.video` / 视频播放 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）：播放器为白灰粉配色，次要控制收进“…”，A-B 片段作为停靠栏引用（A-47、A-48）；没有顶栏和“下一集”按钮，方向键的短按、按住与松开各有含义（A-71）；导入只做容器探测，帧时间表按需构建；ASS 默认字体随包提供；时间在走而没有画面时给出状态并提供播放副本（A-72）；菜单放到顶层、音量改为竖条、全屏时画面不随底栏变化、快捷键与倍速列表移到设置、窗口全屏、截图与弹幕入口（A-76—A-79、A-81）；第三轮返工（A-92）：字幕合成一个按钮与分组菜单、浮层避让浮出的底栏与栏顶、结束时底栏保持显示、截图带字幕；Windows 实机与硬件 HEVC 见[用户待办](../../USER-ACTIONS.md#checks)的 H-09、H-12 |
| 需求 / 设计依据 | LIB-01—03、READ-03、READ-04、NOTE-05；[领域模型](../design/domain-model.md)、[交互设计](../design/interaction-and-workflows.md)、Q-13、Q-17 |
| 包与公开入口 | `packages/app-core/src/video`、`media`；命令 `video.probe`、`video.subtitles`、`video.audioTracks`、`video.frameIndex`、`video.playbackPlan`、`video.playCopy`、`video.handle`、`video.subtitleHandle`、`video.fonts`、`progress.setTime`、`material.frame`、`material.subtitleWindow`；截图见[资料库模块](library.md#screenshots)，弹幕见[弹幕模块](danmaku.md) |

## 1. 责任与依赖

拥有视频探测结果、字幕/音轨清单、帧时间索引、播放路径决定、播放副本，以及时间定位的解析。不拥有作品/进度/笔记身份（归资料库）。Feature `video`；Facet `service`/`ui`；硬依赖 `manga.library`；FFmpeg 缺失只让对应能力显示不可用，库与笔记照常工作。

**后端（Q-14）：** Chromium 原生 `<video>` 负责播放；FFmpeg 8.1 LGPL 共享构建的子进程（`ffprobe`/`ffmpeg`，单次并发上限、超时、路径脱敏）负责探测、字幕与字体提取、重封装、播放副本和单帧；ASS 字幕在渲染进程用 JASSUB（WASM）绘制。视频字节通过只读的 `manga-media://` 协议按 HTTP Range 提供，渲染进程只持有不透明句柄。随包 FFmpeg 的许可与分发为 Q-17。

**播放路径（`decidePlayback`）：** 容器 MP4/MOV/Matroska/WebM 且视频为 H.264（8 位）/VP8/VP9/AV1 且音频为 AAC/MP3/Opus/Vorbis/FLAC/PCM/ALAC 时直接播放；容器不支持或需要换到非默认音轨而画面可播时重封装（不重新编码）；HEVC 在没有硬件解码、10 位 H.264、AC3/DTS 等音频时生成播放副本（视频可复制则复制，否则硬件 H.264 编码 NVENC/AMF/QSV，最后回退 SVT-AV1；不支持的音频转 AAC）。HEVC 是否有硬件解码由渲染进程的 `mediaCapabilities` 报告，Chromium 在 Windows 上没有软件 HEVC 解码器。播放副本的时间轴与原件逐帧比较，最大偏差 ≤ 1 ms 且帧数相同才算通过；副本总量预算 20 GiB，可取消、可删除重建，笔记与进度始终在原件时间轴上。

## 2. 数据与公开能力

- 数据：`media_probes`（探测结果与帧索引缓存，随修订）、`play_copies`（状态、进度、编码器、时间戳检查、错误）、`resource_assets`（外挂字幕、字体）、`resource_revisions.layout_json`（单位 ms、总时长）。修订指纹取大小加三段各 4 MiB 的采样，重新编码或剪辑后的文件视为新修订；外挂字幕按“同目录或 Subs 子目录、与视频同名可带语言后缀”发现，别集的字幕不算。
- 定位：`TemporalLocator`（起止毫秒，原件时间轴，已减去容器起始偏移 `startMs`）；起止超过总时长 1 s 以上拒绝。精确帧：帧号界面从 1 开始，由帧时间戳索引（不是平均帧率）换算，VFR 与非零起点都按时间戳；`video.frameIndex` 返回帧号、时间、总帧数及相邻帧时间。**帧时间表不在导入时建。** 导入只做容器探测与抽样指纹（读几个固定位置的小块，不整读文件，不运行 `ffprobe -show_entries packet`）。第一次需要帧号的操作（逐帧前后、帧号显示）才请求构建：`frameIndexState` 为 `absent`/`building`/`ready`，构建是后台低优先级任务，一次只跑一个，可取消（命令 `video.cancelFrameIndex`）；按“分:秒.毫秒”输入时间的跳转直接定位，不等时间表，落点仍由呈现帧核实。扫描的封面每部作品只取一次，后台媒体子进程以低优先级运行（A-72）。
- 命令：`video.probe(refresh?)`、`subtitles/audioTracks`（只含菜单所需信息，不含路径）、`playbackPlan`（输入 `hardwareHevc`、`audioStreamIndex`）、`playCopy(create|cancel|remove|status)`（可带 `reason` 强制改用副本）、`handle(original|play_copy)`、`subtitleHandle`、`fonts`（提取 MKV 附件字体）、`progress.setTime`（已看区间与位置）。`material.frame` / `material.subtitleWindow` 是用户准备给 Agent 的画面与字幕窗口，仅所有者可用。字幕文本进入 Agent 上下文时只含时间窗内的台词，默认不超过当前位置；开启阅读设置的 `spoilerGuard`（默认关闭）后还不超过已看进度的前沿；只有用户显式放宽（`subtitleAheadMs`）才越过。判定公式：上限 = 当前位置；开启 `spoilerGuard` 时取 min(当前位置, 到达当前位置的已看区间终点，跳读到达时取此前最后一段的终点)；用户放宽时为当前位置 + 放宽量，且只影响这一次任务。窗口之前被跳过的片段仍在当前位置之前，不按剧透处理。Agent 经工具读更早字幕时同样受此上限约束，且只能读本任务的视频（与[领域模型第 6 节](../design/domain-model.md#6-进度与防剧透边界)的“已读约束与防剧透边界分别保存、用户可主动放宽”一致）。
- 错误：越权 `SCOPE_DENIED`；文件缺失 `NOT_FOUND`/缺失状态；不可播放 `UNSUPPORTED_FORMAT`；FFmpeg 缺失、超时或失败有明确错误码，不静默回退。

## 3. Agent 与界面

播放器提供：暂停、时间输入（点击时间显示后输入 `m:ss.mmm`/`h:mm:ss`/秒）、逐帧（`,` / `.`）、倍速（0.25—4，预设 0.5—3，`[` / `]` 步进）、`←/→` 短按快退快进（默认 5 s，设置 1—120）、按住 `→` 超过 300 ms 按设置里的临时倍速播放（默认 2×，松开恢复原速）、按住 `←` 连续快退（每秒约退 4 s；视频不能倒放，所以用反复定位实现，松开停止）、`↑/↓` 音量、`Space/K` 暂停、`M` 静音、`F` 全屏、`I`/`O` 标记 A/B 区间记笔记、`Home` 回到开头；鼠标右键只打开菜单，不做按住倍速；字幕轨与音轨菜单、字幕开关、自动下一集（默认关）；没有“下一集”按钮、片尾也没有跳转，换集用选集列表或作品主页；“改用播放副本”开关在播放器内，生成进度可取消；底部状态区明确显示直接/重封装/副本。进度与已看区间持久化，重启恢复。

**界面精简（A-47）与控制（A-76—A-78）：** 控制条为浅色表面、灰色图标、粉色进度与选中态，颜色只来自 `styles.css` 的语义 Token（`player-tokens` 用例守护）；没有顶栏，作品名在栏顶。底栏左边是播放/暂停、时间与帧号；右边依次是字幕、音轨、选集、倍速四个菜单，以及弹幕、音量、截图、窗口全屏、屏幕全屏和“…”。窄窗时那些菜单收进“…”面板（面板里的菜单同样在顶层弹出）；前后跳步、逐帧、A/B 标记留在“…”面板里。标记的 A-B 区间是停靠栏输入框里的引用标签，记笔记与录音在停靠栏发起，播放器里没有记笔记与录音按钮。

- **顶层弹出：** 所有 `Menu`、右键菜单、音量条和弹幕面板由同一个弹出层组件（`components/popup.tsx`）放进浏览器的顶层（`popover`），用 CSS 锚点按触发元素定位，一侧放不下时翻到另一侧，所以播放器、底栏、滚动区域或全屏元素自己的层叠都裁切不了它；点到外面关闭，Esc 由调用方处理并还焦点。窗口检查用命中测试验证每一项在最上层、点得到（`player-menus`），而不是只检查元素存在。
- **字幕菜单（A-92，AT-107）：** 主字幕与次字幕在同一个“字幕”按钮的菜单里，`components/menu.tsx` 的 `Menu` 新增 `groups`（有组标题的几组，每组自己的单选与“关闭”，方向键从一组的最后一项走到下一组的第一项，Home、End 到全部项的头尾，同一个 id 可以出现在两组里，用 `testId` 区分）；组是“主字幕”与“次字幕（显示在主字幕下方）”。只有一条字幕轨，或没有能做次字幕的轨道（次字幕只能是 SRT 或 VTT 文本轨，且不是主字幕那一条）时，只显示主字幕一组、不显示组标题；窄窗时“字幕”按钮同样收进“…”面板，只有这一个入口。
- **音量：** 点开后是向上的竖条，可以拖动、用滚轮、点击静音；记住音量与静音。
- **全屏：** 屏幕全屏时画面（`video` 元素）的尺寸不随底栏的显示与隐藏而变化——底栏是画面上方的半透明玻璃层，不占布局；字幕层抬高到底栏之上。窗口检查比较底栏显示与隐藏两种状态下画面的尺寸并截图。窗口全屏（默认 W）让阅读器占满应用窗口，栏顶和底栏悬浮其上，三种阅读器都有。
- **浮层避让（A-92，AT-108）：** 浮在画面上的提示不被浮出的底栏与栏顶挡住：结束提示 `.video-end` 与漫画的 `.comic-end` 按底栏高度抬高（阅读器把底栏的实际高度写进 CSS 变量 `--player-lift`、`--comic-footer-h`，窗口全屏与屏幕全屏时才用），层级在底栏之上；播放状态与健康提示 `.video-holding`、`.video-health` 按浮出的栏顶让位（`--player-top`）；播放结束时底栏保持显示，不进入空闲隐藏。窗口检查（`overlays-comic`、`overlays-player`、`overlays-novel`）在普通、窗口全屏、屏幕全屏三种状态下对这些浮层、页码输入、框选截图的按钮与阅读设置面板做命中测试，并检查提示在底栏之上。
- **键位与倍速：** 播放器里没有快捷键说明与倍速输入框。键位表在 `packages/contracts/src/key-bindings.ts`，按键处理（`use-key-bindings`）和“设置 › 键盘快捷键”读同一份；默认新增 R（自定义倍速与 1× 之间切换）、S（截图）、D（弹幕）、W（窗口全屏）。倍速列表（0.25—4，最多两位小数，不重复，1× 固定保留）与自定义倍速在“设置 › 阅读与播放”编辑，随媒体设置保存。
- **截图带字幕（A-92，AT-109）：** 视频的截图默认带着画面上正显示的主字幕与次字幕，“设置 › 阅读与播放”的 `shotSubtitles`（“截图带字幕”，默认开）可以关闭；位置相对画面，不受底栏抬高的影响。ASS（含 SSA）字幕由 `readers/subtitle-ass-shot.ts` 向 JASSUB 要按文件原始分辨率重画的当前画面（`resize` 到文件的尺寸，读出后恢复到屏幕上的尺寸，来不及时用屏幕上的画面拉伸，什么也读不到则不合成并如实记录）；文本字幕由 `readers/subtitle-raster.ts` 按播放器 `SubtitleLayer` 同一份模型（位置、字号、描边、行的堆叠）画在图上。记录里写入当时显示的字幕文本：数据库与 PNG 的 `manga.screenshot` 都有 `subtitleText`、`subtitleTrack`、次字幕的 `subtitleSecondaryText`、`subtitleSecondaryTrack`，以及合成了什么 `composited`（`none`、`subtitles`、`danmaku`、`both`）；关闭“截图带字幕”后文本仍在、`composited` 里没有字幕。自动检查：`tests/reading/subtitle-capture.test.ts`、`subtitle-raster.test.ts`、`video-player.test.tsx`（截图一节）、`tests/library/screenshots.test.ts`；打包烟测的 media 阶段对带 ASS 的样本与带 SRT 主次字幕的样本各截一张，读回应用保存的文件，逐像素比较有字幕与没有字幕的两张，核对字幕的字数、位置与画面上看到的一致。

**画面健康与诊断（A-72）：** 播放器按 `video-health.ts` 判断画面：打开后 2 秒内一帧也没有出，或在连续 2 秒里时间走了至少 1 秒而呈现的帧不足 2 个（`getVideoPlaybackQuality().totalVideoFrames`；暂停、等数据和跳转不算），就在画面上显示状态条（`video-health`）：说明现象，提供“改用播放副本”（已在副本上时则是“重试”）和“忽略”，而不是一片黑。上下文调试面板的“当前”页有一行“视频播放”（`debug-video-*`）：播放方式（原文件或播放副本）、`readyState`/`networkState`、已解码与丢弃的帧数、画面尺寸与健康状态，字幕渲染器及其状态、默认字体来源、本片样式要求而没有的字体。人工遇到黑屏时记下这几行（用户待办 H-30）。

**ASS 字幕的字体（A-72）：** JASSUB 在没有指定默认字体时回退到它自带的只有西文字形的字体，所以样式字体缺失的中文会变成方块。现在渲染器启动时总是指定默认字体：随包的开源中文字体（Noto Sans CJK 简体中文子集，OFL-1.1，`scripts/tools/fetch-subtitle-font.mjs` 按锁定哈希下载、随包放入）作为 `defaultFont` 与 `availableFonts` 预加载；它不可用时才用本机的 CJK 字体（微软雅黑、黑体、思源黑体，且需本机字体查询权限已授予），都没有才交给渲染器。文件内封的附件字体先于这一切。随包字体不含韩文。字幕轨选定后，渲染器就绪时对暂停的画面补画一次当前帧（JASSUB 只在视频帧回调里绘制，暂停的画面不会自己重绘）。

## 4. 生命周期与兼容

停用：递增模块代次使所有视频与字幕句柄失效，取消该模块的后台转码和探测任务，晚到结果丢弃；播放副本文件保留（可在总览清理）。启用后重新探测不丢进度。原件缺失时显示缺失与修复入口，笔记与进度保留。资料包导出包含探测快照与外挂字幕/字体资产，不含播放副本（可重建缓存；副本记录不导出）。未知来源的旧数据由迁移追加表和列，不改写既有内容。

## 5. 验证与未决

自动：`tests/video`（命令、单元）、`tests/media`（FFmpeg 封装、句柄、Range 服务、任务队列）、`tests/reading/video-model.test.ts`、`video-player.test.tsx`、`player-tokens.test.ts`、`tests/samples`（合成样本矩阵：MP4 H.264/AAC、MKV H.264 + ASS 与字体、MKV HEVC 8/10 位、AC3、VFR、非零起点、双音轨）；打包烟测 media 阶段在真实窗口逐样本播放并截图。支持矩阵（容器 × 编码 × 音频 × 字幕 × 播放路径）与实测耗时见[执行状态](../delivery/status.md#support-matrix)。返工新增：`tests/video`（时间表按需构建、导入不整读文件、一次只建一个）、`tests/reading/video-player.test.tsx`（画面健康、按住方向键、字幕就绪后补画、字幕菜单的分组与键盘、截图带字幕）、`overlay-avoid.test.tsx`（浮层避让的样式规则与阅读器交给规则的底栏高度）、`tests/shell/menu-popup.test.tsx`（分组菜单）、`subtitle-fonts.test.ts`；真实库的只读试验记在[执行状态](../delivery/status.md)。未决：Q-13（手感）、Q-17（分发许可、软件解码与播放副本代价）；人工项 H-09、H-12、H-17、H-30、H-31（已列入上文）；有硬件 HEVC 解码的参考机路径尚未实测。
