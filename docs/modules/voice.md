# 语音与定位模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.voice` / 语音记录与听写 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）：包含带来源位置的长录音笔记（`capture.*`）与应用内低延迟听写、本地离线识别引擎及二次元词库（`dictation.*`、`asrModel.*`、`dictionary.*`，A-130、A-131）。ASR 契约测试已用合成 TTS 语音覆盖（≤ 10 次请求）；Bangumi 角色详情与多协议转录真实契约见[用户待办](../../USER-ACTIONS.md#act-21)（ACT-21，not-run）；设备、声学与输入法项见 H-11、H-102、H-104—H-111 |
| 需求 / 设计依据 | VOICE-01—17、AT-06—08、AT-54、AT-57—59、AT-76、AT-172、AT-174—183；[领域模型第 9 节](../design/domain-model.md#9-语音采集与位置映射)、[交互设计第 7 节](../design/interaction-and-workflows.md#7-工作流-b口述感想与异步整理)、[架构设计](../design/architecture.md)、Q-05、Q-40 |
| 包与公开入口 | `packages/app-core/src/voice`（`models/`、`engine/`、`correct/`、`polish/`、`dictation/` 及录音会话）、`apps/desktop/src/main/asr-host.ts` / `asr-service.ts`、`apps/desktop/src/renderer/voice/`；命令 `capture.*`、`dictation.start/append/stop/cancel/status`、`dictation.history.list/delete/clear/retranscribe`、`asrModel.list/download/pause/cancel/import/delete`、`dictionary.list/removedWorks/add/update/remove/importBatch/importMetadata/cancelImportMetadata/prompt/observeEdit`、`dictionary.suggestions.list/decide`、`settings.getRecording/setRecording` |

## 1. 责任与依赖

模块同时承载两条独立的口述链路，共用统一的识别引擎（`AsrEngine`）、前端声学处理与个人/作品两级词库：

1. **带位置的录音笔记（`capture.*`）：** 拥有录音会话、采集时钟与位置事件、长录音人声筛选、分块识别、来源锚点映射、整理草稿与音频保留策略。不拥有笔记本身（草稿确认后经笔记服务建档）与资源/进度身份。
2. **应用内听写（`dictation.*`）：** 面向 MANGA 内六个可输入区域按住或免提说话、松手把文字插回原光标处；拥有听写会话、静音裁剪与长停顿压缩、个人/作品词库音近替换、受控文本模型润色与简繁转换、一步恢复原文、从修改中学词建议与 30 天本机听写记录。单次最长 5 分钟，不写 `capture_sessions`、不生成位置锚点，默认音频只在内存流转。

Feature `voice`；Facet `service`/`ui`；硬依赖 `manga.library`。识别支持三类引擎：本地离线模型（`sherpa-onnx`）、OpenAI 兼容转录接口（`/audio/transcriptions`）与 OpenAI 兼容对话音频输入（`/chat/completions` 的 `input_audio`）；润色与笔记整理复用已配置的文本连接。所选引擎缺失、未安装或失败时直接向用户报告明确原因，**零跨引擎自动回退**，音频绝不发往用户未选定的其他连接。

### 管线与子系统

- **采集前端与降噪：** 渲染进程按 `deviceId` 调 `getUserMedia`（默认 `echoCancellation: true`、`noiseSuppression: false`、`autoGainControl: true`；开启“消除其他应用的声音”时请求 Chromium `echoCancellation: "all"`，设置页标明约 170 ms 延迟，不支持时回退 `true`），经 `AudioWorklet` 输出 16 kHz 单声道 16-bit PCM。听写与录音期间，MANGA 内正在播放的视频按 `duckPlayback` 压低至 30% 或暂停，结束后恢复。可选环境降噪在识别前用随包 `gtcrn_simple.onnx`（MIT，约 523 KB）做 `0.75 × 降噪 + 0.25 × 原声` 干湿混合，避免擦音被过度抹除。
- **静音裁剪与回声过滤（`SilenceTrimmer` / `isHintEcho`）：** 录音笔记由独立 worker 里的 Silero VAD（ONNX，`onnxruntime-web` WASM，MIT）增量筛选（滞后超 120 s 改为停止后整段筛选），按 1.5 s 内合并、单块 ≤ 30 s 切分；听写松键后同样用 Silero VAD 裁除首尾静音（两侧各留 300 ms 余量），将 > 1000 ms 的句中停顿压缩为 400 ms 静音（≤ 1000 ms 保持原样），无人声直接返回 `no_speech` 且不发识别请求。同时检测人声峰值 `< -30 dBFS`（`low_volume`）与满幅采样占比 `≥ 1%`（`clipping`）给出非阻塞提示。识别结果若命中四类提示词/热词复述模式（原样回显 `Vocabulary:` 前缀、纯词表拼接等），自动去掉提示重试一次；仍为回显则按无效结果丢弃（听写提示“没有听清，请再说一次”且不插入）。
- **统一识别引擎（`AsrEngine`）：** 用 `AsrCapabilities` 统一描述热词条数上限（`hotwords`）、提示文本上限（`prompt`）、语言、时间戳与单次字节/时长上限：
  - 本地 `qwen3-asr-0.6B-int8`（`qwen3Asr`，推荐，支持 `stream.setOption("hotwords", csv)` 最多 50 条）与 `funasr-nano-int8`（`funasrNano`，显式 `itn: 1`，支持 50 条热词）；
  - 本地 `sense-voice-funasr-nano-int8`（`senseVoice`，轻量多语种 CTC，不支持流级热词，完全依赖后置词典纠错）；
  - 外部 `/audio/transcriptions`：注入 `Vocabulary: …` 提示（受 `promptChars` 截断并报告未放入条数）；
  - 外部 `/chat/completions`（`transcriptionInterface: "chat_input_audio"`）：发送 base64 WAV `input_audio` 与仅含“只输出逐字转写及参考专名列表”的系统消息。
  录音笔记选本地引擎时同样按 ≤ 30 s 语音块送 `AsrEngine`，来源时间映射不变。
- **独立推理子进程（`asr-host`）：** `apps/desktop/src/main/asr-host.ts` 单独打包为 `resources/asr-host.cjs`，由主进程 `AsrService` 通过 `utilityProcess.fork`（`serviceName: "MANGA speech"`）与 `MessagePortMain` 按需拉起，仅在该子进程内加载解包于 `app.asar.unpacked` 的 `sherpa-onnx-node` / `sherpa-onnx-win-x64`（2.0.1，Apache-2.0）；`main.cjs`、`full-main.cjs` 与 `light-main.cjs` 的静态及打包闭包均不含 `sherpa-onnx`（由 `scripts/check-deps.mjs` 与烟测 `dictation-boundary` 守护）。所有返回音频缓冲的原生调用强制传 `enableExternalBuffer: false` 以兼容 Electron V8 内存笼。子进程内部串行队列执行、零数据库与零网络访问；默认闲置 10 分钟（可在 1—120 分钟间配置）卸载模型并退出进程；意外崩溃不影响主窗口，下一次请求自动拉起，60 秒内连续崩溃 2 次则将该模型标为 `load_failed` 停止拉起循环。
- **本地模型目录与安全下载（`AsrModelService`）：** 目录固定三款 Apache-2.0 模型，不随安装包分发，未收到 `confirmed: true` 绝不发起请求。生产下载源限定 HTTPS 白名单主机（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`，手动逐跳核对重定向，最多 5 跳、禁凭据与字面量 IP），暂存于 `<应用数据根>\models\.staging\<modelId>.part` 与 `.state.json`；断点续传前先重算 `.part` 的 SHA-256 与状态比对，再用 `Range`（`206`）续传，`ETag` 变化或返回 `200` 时从零重下。整包 SHA-256 通过后，用系统固定路径 `%SystemRoot%\System32\tar.exe` 做两步校验：先跑 `-tvf` 拒绝非普通文件/目录权限位、任何 `->` / `link to` 符号链接或硬链接及解压总大小超过压缩包 4 倍的归档，再跑 `-tf` 拒绝绝对路径、盘符、`..` 穿越与 Windows 保留设备名；解压后逐个核对 `requiredFiles` 的字节数与 SHA-256，全部通过才原子移入 `<应用数据根>\models\asr\<modelId>\` 并登记 `models/installed.json`，任一步失败立即清空对应 `.staging` 文件。支持本地压缩包或文件夹校验导入；删除正在加载的模型时先通知 `asr-host` 卸载释放句柄再删目录。
- **二次元词库与 Bangumi 补全（`DictionaryService`）：** 全局与作品两级词条支持类别（`character`、`actor`、`work`、`term`、`other`）、多读音别名（`alias`、`heard`、`kana`、`romaji`、`english`）、停用开关、误改黑名单 `blocked` 与按行批量导入（跳过空行与重复并统计数量）。内存维护 `pinyin-pro`（3.29.5，MIT）与 `wanakana`（5.3.1，MIT）生成的音素序列。“从资料加入”除读取已同步的角色与声优外，可按顺序拉取 Bangumi 角色与人物详情（单次最多 60 个请求、携带规定 `User-Agent`、支持取消，响应缓存于 `bangumi_details`），解析简体中文名、多个“别名”项、无 `k` 键嵌套别名数组、日文假名与罗马字写入自动别名（兼容 `infobox: null`），且永不覆盖手写词条。识别热词优先取当前焦点标签所属作品的手写词条、作品自动词条，再取全局手写词条（最多 50 条）；纠错阶段合并当前作品与全局全部启用词条。
- **确定性音近纠错（`PhoneticCorrector`）：** `packages/app-core/src/voice/correct/` 为 `HaujetZhao/asr-hotword`（MIT，提交 `7e282137e780ac4096cac537bef360235d2efe43`）的 TypeScript 移植与改进：基于中文声韵调模糊代价（前后鼻音 `an/ang`、`en/eng`、`in/ing`，平翘舌 `z/zh`、`c/ch`、`s/sh`，鼻边音 `n/l`，以及修正后的双侧声调代价 `0.4`）与日文片假名/平假名/罗马字归一，配合增量更新的音素 2-gram 倒排索引在毫秒级粗筛（10,000 词条单句替换 `p95 ≤ 30 ms`）。命中词条 `blocked` 列表的原词一律跳过；字面完全匹配或当前作品/手写词条相似度 `≥ 0.9` 直接确定性替换并记录依据词条；相似度 `0.75—0.9` 的最多 15 个词条作为候选交给润色层。
- **受控润色与简繁转换（`DictationPolisher`）：** 提供 `raw`（原文）、`light`（轻度，默认：去口头禅与口误重复、补标点、结合上下文确认候选专名）与 `formal`（书面）三档，轻度与书面提示词可在设置自定义并一键恢复默认。内置四道防过度纠错护栏：（1）`raw` 档或 `light` 档在 0 个召回候选且无口头禅/重复痕迹时跳过文本模型调用；（2）提示词只附本次召回的 ≤ 15 个候选（`正式写法 | 读音或原名 | 类别与作品`）并明确禁止强行套用；（3）请求固定 `temperature: 0.1`（若模型接口报不支持 `temperature` 自动去掉该参数重试一次）；（4）5 秒硬超时（`POLISH_TIMEOUT_MS = 5000`），且输出长度比须在 `[0.4, 1.4]` 内、不得凭空引入原文与候选之外的词典专名/拉丁词/片假名词、不得整句复读，任一违反或报错立即回退到 `correctedText` 并记录 `fallbackReason`。最后由主进程惰性加载 `opencc-js`（1.4.2，代码 MIT、词表 Apache-2.0）按设置统一为简体（默认）、繁体或保持原样，转换时保护已命中的词典正式写法区间不被改字。

## 2. 数据与公开能力

- **数据表（Schema v16）：**
  - 录音笔记：`capture_sessions`、`capture_events`、`transcript_segments`、`capture_drafts`、`work_terms`（阶段：`recording → recorded → filtering → awaiting_asr → transcribing → done`，及 `pending`、`no_speech`、`failed`、`cancelled`）。
  - 词库与补全：`dictionary_terms`（保留 `heard` 列兼容旧资料包，新增 `category`、`disabled`、`blocked_json`）、`dictionary_aliases`（级联外键关联 `dictionary_terms`）、`dictionary_suggestions`（`pending` / `accepted` / `ignored`）、`bangumi_details`（按 `(kind, external_id)` 缓存角色与人物详情）。
  - 听写记录：`dictation_history`（保留最近 30 天，记录引擎、档位、`raw_text`、`corrected_text`、`final_text`、`fallback_reason`、各步耗时 `timings_json`、替换依据 `replacements_json` 及可选 24 小时音频相对路径 `audio_rel_path` 与 `audio_expires_at`；阶段：`recording → trimming → recognizing → correcting → polishing → done | no_speech | failed | cancelled`）。
- **从修改中学词（`LearnFromEditsService`）：** 插入后 60 秒窗口（失焦或计时器触发）内，若用户在同一输入处将一段 2—16 字文本改为词典未收录的新写法且音素相似度 `≥ 0.6`（`dictionary.observeEdit`），生成 `pending` 建议词；用户点“加入词典”（`dictionary.suggestions.decide` 的 `accept`）才写入当前作品或全局词典，点“忽略”（`ignore`）后同一组不再提示。
- **听写历史与重转写（`DictationHistoryService`）：** 支持列出、复制原文/结果、单条删除与一键清空；开启“保留最近 24 小时的听写音频”时将 16 kHz WAV 写入 `<应用数据根>\dictation-audio\`，24 小时内可用 `dictation.history.retranscribe` 换另一引擎重新识别比对，过期自动删文件并清空路径字段。
- **主要设置（`settings.getRecording` / `setRecording`）：** 录音键 `holdKey`（默认 `F9`）/ `toggleKey`（默认 `F8`）、听写键 `dictationHoldKey`（默认 `RightAlt`，登记在快捷键表 `global.dictationHold`）、`dictationInsertMode`（`stream_replace` 默认先插原文再换润色结果 / `final_only`）、`polishMode`（`light` 默认 / `raw` / `formal`）、`polishPrompts`、`polishConnectionId`、`chineseVariant`（`simplified` 默认 / `traditional` / `none`）、独立的 `dictationEngine` 与 `captureEngine`、`localIdleMinutes`（默认 `10`）、`echoCancellation`（默认 `true`）、`systemLoopbackAec`（默认 `false`）、`browserNoiseSuppression`（默认 `false`）、`autoGainControl`（默认 `true`）、`gtcrnDenoise`（默认 `false`）、`duckPlayback`（默认 `lower`）、`retention`（录音笔记默认 `keep`）、`retainDictationAudio24h`（听写默认 `false`）以及录音悬浮框坐标。模型档案 `ModelProfileSchema` 另含 `transcriptionInterface`（`audio_transcriptions` 默认 / `chat_input_audio`）。

## 3. Agent 与界面

- **严格的权限隔离：** `capture.*`、`dictation.*`、`asrModel.*`、`dictionary.*` 与 `dictionary.suggestions.*` 全部属于 `OWNER_COMMANDS`（命令入口强制核验 `owner(envelope)`），不暴露给任何 Agent 工具或提议；`dictation_history` 不建 FTS 索引、不进 `library.search`、不进上下文材料与会话流，Agent 既不能启动听写或录音，也不能读取听写音频与历史记录。
- **应用内听写界面：** 覆盖六个可输入表面（对话栏/悬浮胶囊输入框、笔记富文本 Tiptap 与源码 CodeMirror 6、文稿编辑器、白板卡片文字、思维导图节点文字、搜索框）。按住 `RightAlt` ≥ 250 ms 开始说话、松手插入（单独按放 `RightAlt` 时抑制菜单栏抢焦点，不拦截 `Alt+字母`）；`< 350 ms` 双击锁定免提（胶囊提供“结束”按钮）；`Esc` 立即取消且零插入、零请求；IME `compositionstart` 期间按键排队至 `compositionend` 后启动。对话栏麦克风在“问 Agent”模式下走听写（填入输入框、不自动发送），在“笔记”模式下保持带位置的录音笔记。焦点所在分栏底部居中显示紧凑 `DictationCapsule`（使用语义主题 token，不显示麦克风设备名，支持 `prefers-reduced-motion` 有声/无声两档切换与 `aria-live="polite"` 播报，按钮 `onMouseDown` 阻止抢走原编辑器焦点）；原输入处关闭时弹出带“复制”按钮的通知保留结果。插入后若发生替换或润色，就近浮现 10 秒 `DictationPill`（“已润色 · 恢复原文”、点击展开本次替换依据词条、失焦后若产生学词建议就地提供确认/忽略），编辑器把“插入原文”与“替换为润色结果”记为独立撤销步，支持 `Ctrl+Z` 逐级退回。
- **五节“设置 › 语音转录”：** 按“听写”（快捷键、插入方式、润色档位、自定义提示词、简繁转换）、“识别引擎”（听写与录音各自选择引擎、三款本地模型的大小/语言/热词支持/许可展示、确认下载、暂停续传、本地导入、删除与闲置卸载时长）、“声音”（输入设备与电平测试、回声消除、消除其他应用声音、浏览器降噪、环境降噪、播放压低、录音保留策略）、“词典”（全局/作品词条、类别筛选、别名与屏蔽词编辑、批量导入、Bangumi 角色详情补全进度与待确认建议词）、“听写记录”（最近 30 天记录、复制/删除/清空、24 小时音频保留开关与换引擎重转写）组织。

## 4. 生命周期与兼容

- **模块停用与恢复：** 停用 `manga.voice` 时，正在进行的录音笔记先落盘再停止，正在进行的听写会话立即取消并释放内存缓冲，通知 `AsrService` 停止 `asr-host` 子进程释放原生内存，迟到的识别、纠错、润色或整理结果按代次（epoch）丢弃；已保存的录音、词库与历史数据完整保留。重新启用后恢复未完成的录音转录队列，本地已安装模型无需重下即可按需加载。
- **备份、导出与迁移隔离：** Schema v15 → v16 在单事务内迁移词库表并回填类别与旧 `heard` 别名，升级前生成备份，中断可续、幂等、旧版本拒绝打开新库。升级前备份（`premigrate`）与更新前备份（`preupdate`）均清除 `agent_requests` 与 `dictation_history` 后执行 `VACUUM`；资料包（`.manga-bundle`）与项目包（`.manga-project.zip`）导出均不包含 `dictation_history`、`dictionary_suggestions` 与 `bangumi_details`（资料包词典条目在兼容旧版严格 schema 的同时可选携带 v16 类别、停用、屏蔽词与别名）。卸载应用按 `DATA-06` 保留 `%LOCALAPPDATA%\manga`（含 `models/`），用户可在设置中单独删除本地模型。

## 5. 验证与未决

- **自动化验证：** `tests/voice/` 覆盖采集与位置映射、VAD 裁剪与长停顿压缩、回声过滤、统一 `AsrEngine` 三类接口与零跨引擎回退、模型下载白名单/`Range` 续传/`tar.exe` 两步防穿越与炸弹校验、`asr-host` 子进程隔离/崩溃恢复/闲置卸载、`PhoneticCorrector` 固定纠错集（`tests/fixtures/voice-correction.json` 252 条样本，专名召回率 ≥ 0.85、非专名误改率 ≤ 1%）、`DictationPolisher` 四道护栏与简繁保护、恢复原文与 60 秒学词闭环、听写记录备份/导出剔除及 Agent 零暴露；`tests/library/schema-v16-migration.test.ts` 覆盖 v15 → v16 迁移与回滚；离线评测管线 `scripts/voice-eval/`（80 句虚构二次元语料 × 3 声学变体）与基准 `scripts/stage/bench-dictation.mjs` 守护 `dictationLocalReleaseToTextMs`（极速模型松键到上屏 `p95 ≤ 1500 ms`）与 `dictationCorrectionMs`（1 万词条替换 `p95 ≤ 30 ms`）；打包烟测覆盖 `voice`、`dictation-insert`、`dictation-local`、`dictation-revert`、`dictation-settings` 与 `dictation-boundary`。
- **限制与人工检查：** 真实麦克风声学、扬声器外放与系统回环回声消除体感、物理键盘 `RightAlt` 与真实中日文输入法组合兼容、真实网络下载本地模型速度以及 Bangumi 关联作品实测由人工检查 H-11、H-102、H-104—H-111 覆盖；Bangumi 角色详情与外部双协议转录的有限真实契约由 ACT-21 控制（默认 `not-run`）。未决默认值见 Q-05、Q-40。
