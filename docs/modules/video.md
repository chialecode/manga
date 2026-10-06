# 视频模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.video` / 视频播放 / 开发者 |
| 文档状态 / 实现状态 | M2 已实现并自检（产品验收 not-run，见 [M2 交付报告](../evidence/m2-media-mvp-delivery.md)）；Windows 实机与硬件 HEVC 见[用户待办](../../USER-ACTIONS.md#checks)的 H-M2-04/07。**M2 返工已实施并自检**（产品验收 not-run）：播放器改为白灰粉配色，次要控制收进“…”，A-B 片段作为右栏引用（A-47、A-48），实施与证据见[M2 交付报告第 16 节](../evidence/m2-media-mvp-delivery.md#16-返工交付2026-10-06) |
| 需求 / 阶段 / 设计依据 | LIB-01—03、READ-03；M2；[领域模型](../design/domain-model.md)、[交互设计](../design/interaction-and-workflows.md)、Q-13、Q-17 |
| 包与公开入口 | `packages/app-core/src/video`、`media`；命令 `video.probe`、`video.subtitles`、`video.audioTracks`、`video.frameIndex`、`video.playbackPlan`、`video.playCopy`、`video.handle`、`video.subtitleHandle`、`video.fonts`、`progress.setTime`、`material.frame`、`material.subtitleWindow` |

## 1. 责任与依赖

拥有视频探测结果、字幕/音轨清单、帧时间索引、播放路径决定、播放副本，以及时间定位的解析。不拥有作品/进度/笔记身份（归资料库）。Feature `video`；Facet `service`/`ui`；硬依赖 `manga.library`；FFmpeg 缺失只让对应能力显示不可用，库与笔记照常工作。

**后端（M2 选定，Q-14）：** Chromium 原生 `<video>` 负责播放；FFmpeg 8.1 LGPL 共享构建的子进程（`ffprobe`/`ffmpeg`，单次并发上限、超时、路径脱敏）负责探测、字幕与字体提取、重封装、播放副本和单帧；ASS 字幕在渲染进程用 JASSUB（WASM）绘制。视频字节通过只读的 `manga-media://` 协议按 HTTP Range 提供，渲染进程只持有不透明句柄。随包 FFmpeg 的许可与分发为 Q-17。

**播放路径（`decidePlayback`）：** 容器 MP4/MOV/Matroska/WebM 且视频为 H.264（8 位）/VP8/VP9/AV1 且音频为 AAC/MP3/Opus/Vorbis/FLAC/PCM/ALAC 时直接播放；容器不支持或需要换到非默认音轨而画面可播时重封装（不重新编码）；HEVC 在没有硬件解码、10 位 H.264、AC3/DTS 等音频时生成播放副本（视频可复制则复制，否则硬件 H.264 编码 NVENC/AMF/QSV，最后回退 SVT-AV1；不支持的音频转 AAC）。HEVC 是否有硬件解码由渲染进程的 `mediaCapabilities` 报告，Chromium 在 Windows 上没有软件 HEVC 解码器。播放副本的时间轴与原件逐帧比较，最大偏差 ≤ 1 ms 且帧数相同才算通过；副本总量预算 20 GiB，可取消、可删除重建，笔记与进度始终在原件时间轴上。

## 2. 数据与公开能力

- 数据：`media_probes`（探测结果与帧索引缓存，随修订）、`play_copies`（状态、进度、编码器、时间戳检查、错误）、`resource_assets`（外挂字幕、字体）、`resource_revisions.layout_json`（单位 ms、总时长）。修订指纹取大小加三段各 4 MiB 的采样，重新编码或剪辑后的文件视为新修订；外挂字幕按“同目录或 Subs 子目录、与视频同名可带语言后缀”发现，别集的字幕不算。
- 定位：`TemporalLocator`（起止毫秒，原件时间轴，已减去容器起始偏移 `startMs`）；起止超过总时长 1 s 以上拒绝。精确帧：帧号界面从 1 开始，由帧时间戳索引（不是平均帧率）换算，VFR 与非零起点都按时间戳；`video.frameIndex` 返回帧号、时间、总帧数及相邻帧时间。
- 命令：`video.probe(refresh?)`、`subtitles/audioTracks`（只含菜单所需信息，不含路径）、`playbackPlan`（输入 `hardwareHevc`、`audioStreamIndex`）、`playCopy(create|cancel|remove|status)`（可带 `reason` 强制改用副本）、`handle(original|play_copy)`、`subtitleHandle`、`fonts`（提取 MKV 附件字体）、`progress.setTime`（已看区间与位置）。`material.frame` / `material.subtitleWindow` 是用户准备给 Agent 的画面与字幕窗口，仅所有者可用。字幕文本进入 Agent 上下文时只含时间窗内的台词，默认不超过当前位置；开启阅读设置的 `spoilerGuard`（默认关闭）后还不超过已看进度的前沿；只有用户显式放宽（`subtitleAheadMs`）才越过。判定公式：上限 = 当前位置；开启 `spoilerGuard` 时取 min(当前位置, 到达当前位置的已看区间终点，跳读到达时取此前最后一段的终点)；用户放宽时为当前位置 + 放宽量，且只影响这一次任务。窗口之前被跳过的片段仍在当前位置之前，不按剧透处理。Agent 经工具读更早字幕时同样受此上限约束，且只能读本任务的视频（A 审查对交付报告问题 C 的结论：与[领域模型第 6 节](../design/domain-model.md#6-进度与防剧透边界)的“已读约束与防剧透边界分别保存、用户可主动放宽”一致）。
- 错误：越权 `SCOPE_DENIED`；文件缺失 `NOT_FOUND`/缺失状态；不可播放 `UNSUPPORTED_FORMAT`；FFmpeg 缺失、超时或失败有明确错误码，不静默回退。

## 3. Agent 与界面

播放器提供：暂停、时间输入（`m:ss`/`h:mm:ss`/秒）、帧号跳转与逐帧（`,` / `.`）、倍速（0.25—4，预设 0.5—3，`[` / `]` 步进）、右键按住 300 ms 临时倍速（默认 2×，松开恢复，短按仍是菜单）、`←/→` 快退快进（默认 5 s，设置 1—120）、`↑/↓` 音量、`Space/K` 暂停、`M` 静音、`F` 全屏、`I`/`O` 标记 A/B 区间记笔记、`Home` 回到开头；字幕轨与音轨菜单、字幕开关、跨集上一集/下一集和自动下一集（默认关）；“改用播放副本”开关在播放器内，生成进度可取消；底部状态区明确显示直接/重封装/副本。进度与已看区间持久化，重启恢复。

**界面精简（A-47 W9）：** 控制条为浅色表面、灰色图标、粉色进度与选中态，颜色只来自 `styles.css` 的语义 Token（`player-tokens` 用例守护）；常驻只留进度条、播放/暂停、时间与帧号、倍速菜单、静音与音量、下一集（有下一集时）、全屏和“…”；前后跳步、逐帧、字幕/音轨/选集菜单、A/B 标记、时间/帧号/自定义倍速输入与快捷键说明收进“…”面板（矮窗里不被裁切）；标记的 A-B 区间是右栏输入框里的引用标签，记笔记与录音在右栏发起，播放器里没有记笔记与录音按钮；全屏时控制条保持可读，键盘快捷键不变。

## 4. 生命周期与兼容

停用：递增模块代次使所有视频与字幕句柄失效，取消该模块的后台转码和探测任务，晚到结果丢弃；播放副本文件保留（可在总览清理）。启用后重新探测不丢进度。原件缺失时显示缺失与修复入口，笔记与进度保留。资料包导出包含探测快照与外挂字幕/字体资产，不含播放副本（可重建缓存；副本记录不导出）。未知来源的旧数据由 v6/v7 迁移追加表和列，不改写既有内容。

## 5. 验证与未决

自动：`tests/video`（命令、单元）、`tests/media`（FFmpeg 封装、句柄、Range 服务、任务队列）、`tests/reading/video-model.test.ts`、`video-player.test.tsx`、`player-tokens.test.ts`、`tests/samples`（合成样本矩阵：MP4 H.264/AAC、MKV H.264 + ASS 与字体、MKV HEVC 8/10 位、AC3、VFR、非零起点、双音轨）；打包烟测 media 阶段在真实窗口逐样本播放并截图。支持矩阵（容器 × 编码 × 音频 × 字幕 × 播放路径）与实测耗时见 [M2 交付报告](../evidence/m2-media-mvp-delivery.md)。未决：Q-13（手势与跨集默认值）、Q-17（分发许可、软件解码与播放副本代价）；人工项 H-M2-04、H-M2-07；有硬件 HEVC 解码的参考机路径尚未实测。
