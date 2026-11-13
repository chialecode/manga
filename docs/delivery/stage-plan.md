# 当前阶段计划（M12）：类 Typeless 的听写

日期：2026-11-13。角色：A 规划；B 连续实施与自检；A 集中审查。本文是整个阶段的唯一计划，兼作跨模块变更提案（A-46）。B 的执行 prompt 在[第 11 节](#prompt)，不另建 prompt 文件。路径固定、不带阶段名；下一阶段开始时由 A 按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)改写。上一阶段的计划与报告在合并提交里：[计划归档](https://github.com/chialecode/manga/blob/f9aea92/docs/delivery/stage-plan.md)、[报告归档](https://github.com/chialecode/manga/blob/f9aea92/docs/delivery/stage-report.md)。

用户 2026-11-12 要求下一阶段细化语音功能，做类似 Typeless 的体验：对语音降噪、去除静默，交给 ASR 模型得到文本，再按文本与词库优化内容。词库可以预先准备，也可以是看动画时从 Bangumi 等处取得的专有名词（主角名、CV 名等）。同时要提供本地模型下载，并以标准的公共 API 形式接入外部模型。2026-11-13 用户提供了选型调研并要求继续。

范围记为 **A-130**，管线与选型记为 **A-131**。A 没说到的细节先定了默认值，登记为[用户待办的 Q-40](../../USER-ACTIONS.md#q-40)，B 按默认实现，用户以后可以改。待答的 Q-23 由这次要求答复：采用第 1—6 项。需求是 VOICE-10—VOICE-17（新增），验收是 [AT-174—AT-183](roadmap-and-acceptance.md#at-dictation)。

本计划一次列出本阶段的全部交付、退出条件和收尾流程。B 连续完成全部工作包后一次交付，A 一次集中审查。人工检查与待决问题按 A-53 记在用户待办，不阻塞开发。

## 1. 范围与退出条件

| 项目 | 约定 |
| --- | --- |
| 阶段 | 应用内听写的会话、入口与插入（U1）；采集前端（A1）；去除静默（S1）；识别引擎的能力描述与外部接口（E1）；本地推理进程（N1）；模型目录、下载与导入（M1）；词库扩展、schema v16 与 Bangumi 补全（X1）；音近召回与确定性替换（R1）；润色、防过度纠错与简繁（P1）；听写记录与从修改中学词（H1）；评测集与基准（Q1）；测试与走查（T1）；文档（W1）；阶段开始的整理（C0）；依赖盘点与新增依赖（D1） |
| 代码基线 | `main @ 3b9d498`（上一阶段的 [PR #11](https://github.com/chialecode/manga/pull/11) 于 2026-11-12 squash 合并为 `f9aea92`，#12—#20 是发布流水线的追加修复，同日发布 v0.1.1）；没有未合并的前置分支 |
| 工作分支 | `feat/m12-voice-dictation`，A 已从基线创建。本计划所在的提交是阶段提交的起点；B 的实施、A 的审查修复与人工反馈修复全部 amend 进同一提交 |
| 关联需求 | 新增 VOICE-10—VOICE-17；受影响的既有行为：VOICE-03、VOICE-06 的转写可以改用本地引擎（块的切法与位置映射不变）；VOICE-09 的词典扩展为别名与读音；VOICE-01 的采集约束改为浏览器降噪默认关（录音笔记与听写共用）；资料库结构升到 v16 |
| 关联验收 | 新增 AT-174—AT-183；既有的全部窗口观察、`installer` 步骤与基准照常重跑 |
| 可连续执行 | 本地实现；新增第 3 节列出的依赖；下载钉住版本与哈希的模型与工具到 `dist/tools/`；合成样本、测试、打包、基准、文档同步；第 5.1 节的整理；阶段提交与 amend |
| 外部操作 | 未授权：push、PR、合并、触发 workflow；真实服务的契约（[ACT-21](../../USER-ACTIONS.md#act-21)，可选）。A 审查收敛后在用户待办登记一项授权请求（push、PR、合并）。测试只用本地的假服务 |

**退出条件与覆盖**

| 条件 | 做法 | 工作包 | 验收证据 |
| --- | --- | --- | --- |
| 在 MANGA 里任何能打字的地方听写 | 按住快捷键说话、松开插入光标处；锁定免提；取消；焦点变化与输入法组合的处理；对话栏“问 Agent”的麦克风是听写；Agent 没有入口 | U1 | AT-174 |
| 声音前端不伤识别 | 回声消除开、浏览器降噪关；可选系统回声消除与 GTCRN 回混降噪；媒体压低；音量过低与削波提示 | A1 | AT-175 |
| 只送有声音的部分 | 首尾静音裁掉、长停顿压短、两侧留余量；整段无声不送；复述热词按无效 | S1 | AT-176 |
| 本地与外部引擎同一套用法 | 能力描述决定送热词、提示还是上下文；OpenAI 兼容转录与对话接口的音频输入；听写与录音笔记各选引擎；不自动换服务 | E1 | AT-177 |
| 本地模型可下载、可信、可删 | 用户确认后下载；Range 续传；固定 SHA-256；越界条目拒绝；本地导入；删除；不进安装包 | M1 | AT-178 |
| 本地推理稳定 | `utilityProcess` 里的 sherpa-onnx；崩溃隔离与重启；闲置释放；完整应用与轻量入口不加载它 | N1 | AT-179 |
| 词库认得作品里的人名 | 别名、误写、读音、类别、停用、批量导入；Bangumi 补全中文名、别名、假名与罗马字；当前作品的热词；v16 迁移 | X1 | AT-180 |
| 纠错准而不乱改 | 音近召回与确定性替换；润色档位与可改的提示词；四道防过度纠错；简繁 | R1、P1 | AT-181 |
| 改得回来、学得会 | 恢复原文与 Ctrl+Z；听写记录；从修改中学词 | U1、H1 | AT-182 |
| 效果与速度可衡量 | 合成评测集与评测脚本；纠错样本集的门槛；两项新基准门槛与记录项 | Q1 | AT-183；`bench.json` |
| 阶段开始的整理 | 上一阶段的报告提炼后删除；去掉以前阶段的标签；按内容整理文件 | C0 | 文档检查；报告的整理记录 |
| 依赖盘点 | 按 A-35 与 ADR-0007 的复查条件逐项处理；新增依赖按第 3 节 | D1 | ADR-0007 版本表；完整回归 |

**阶段完成的判定。** 以下依次满足后，Agent 侧完成，可以请求用户授权 push、PR 与合并（A-24、A-53）：（1）B 自检的必需用例与门禁全部通过；（2）A 集中审查收敛。人工检查、ACT-21 的契约与待答复问题记在用户待办，不是合并的前提；`productAcceptance` 保持 not-run。

**阶段完成后，用户可以：**

- 在对话栏、笔记、文稿、白板、导图和搜索框里按住右 Alt 说话，松开就得到加好标点、去掉口水词、人名写对的文字；不满意可以一步回到原文；
- 在“设置 › 语音转录”里一键下载本地模型，离线、免费地听写，也可以继续用自己的转录服务，或者接入阿里云百炼这类用对话接口识别音频的服务；
- 看哪部作品，就自动用那部作品的角色名与声优名帮助识别；名字被写错后改一次，确认后下次就对了；
- 外放看番时听写，MANGA 自己的视频声音不会被识别进去；
- 录音笔记也可以改用本地模型转写。

## 2. A 已核对的现场

- **采集**（`apps/desktop/src/renderer/voice/mic.ts:13`）：`getUserMedia` 的约束是 `{ channelCount: 1, echoCancellation: true, noiseSuppression: true }`，没写 `autoGainControl`（Chromium 默认开）。`pcm-worklet.ts` 转 16 kHz 单声道 16 位 PCM，经 `capture.append` 分块交给主进程。录音笔记与对话栏麦克风共用这条链路。
- **静默与转写**（`packages/app-core/src/voice/`）：`vad-client.ts` 在 `worker_threads` 里用 onnxruntime-web 跑 Silero VAD；`vad-segmenter.ts` 两侧各留 300 ms、1.5 s 内合并；`chunks.ts` 单块不超过 30 s；`transcribe.ts` 每块带词典提示（`dictionary.prompt(workId, limit)`），识别结果只复述提示时记为 `prompt-echo` 并在重试时不带提示。
- **端口**（`voice/ports.ts`）：`AsrPort` 只有 `resolve` 与 `transcribe(connection, { fileName, bytes, mimeType, prompt, language, timestamps, signal })`，由 `product-app.ts` 的 `asrPort(this)` 实现为 OpenAI 格式的 multipart 转录；`LlmPort.complete` 只收 `system` 与 `user`，没有温度等选项。注释写明：音频只经所选的一个转录连接离开本机，不回退到别的服务，不送给文本模型。
- **词典**（`voice/dictionary.ts`）：表 `dictionary_terms`（`scope`、`work_id`、`term`、`heard`、`source`，上限 5000 条）；`termsFromMetadata` 从作品已缓存的 Bangumi 快照取作品名、别名、角色名（`subject_characters.name`，即 `/v0/subjects/{id}/characters` 返回的日文原名）与声优名；手写词条优先，刷新只增删自动词条。
- **Bangumi**（`metadata/bangumi.ts`、`metadata/bangumi-openapi.ts`）：客户端已有 `characters(subjectId)`；OpenAPI 类型里有 `/v0/characters/{id}` 与 `/v0/persons/{id}`，但客户端还没调用它们。
- **子进程与打包**：`apps/desktop/src/main/plugin-process.ts` 用 `utilityProcess.fork` 运行插件，可作为推理进程的样板；`apps/desktop/vite.main.config.ts` 的 `NATIVE` 列表（`better-sqlite3`、`sharp`、`@napi-rs/canvas`、`electron-updater`）不打进包，`bundleWorker` 把独立运行的 worker 打成单个 CJS 文件；轻量打开有 `checkLightClosure` 与打包的 `light-boundary` 两道检查。
- **可输入文字的地方**：对话栏 `components/chat/composer.tsx` 与收起时的 `capsule.tsx`（textarea）、笔记 `note-editor.tsx` 与文稿 `pages/projects/copy/draft-editor.tsx`（Tiptap 与 CodeMirror 共用块状态和输入法屏障）、白板 `canvas/whiteboard-nodes.tsx` 与导图 `canvas/mindmap-tab.tsx`（textarea）、搜索框 `search-box.tsx`。键位在单一键位表里，“设置 › 键盘快捷键”是 `pages/settings/shortcuts-page.tsx`；录音的 `holdKey`（F9）与 `toggleKey`（F8）只在应用内有效。
- **资料库**：`packages/storage-drizzle/src/sql.ts` 的 `PRODUCT_SCHEMA_VERSION = 15`；迁移的备份、可中断重做与旧版拒绝打开都有现成机制。
- **合成语音**：`scripts/samples/generate-media-samples.mjs` 已用 Windows 自带的 `System.Speech` 合成 16 kHz 单声道语音；打包烟测的 voice 阶段用 Chromium 的假采集设备播放它。
- **系统工具**：Windows 自带 `%SystemRoot%\System32\tar.exe`，本机为 bsdtar 3.8.9（libarchive，含 bz2lib 1.0.8）。

## 3. 开源查证（2026-11-12、2026-11-13）

依据是用户 2026-11-13 提供的选型调研（查询日期 2026-11-12，各项附官方链接），A 在 2026-11-13 复核了下表中的版本、许可与模型哈希：npm 注册表，以及 sherpa-onnx `asr-models` 与 `speech-enhancement-models` 两个 Release 的 `checksum.txt`。调研中标为“未证实”的项目，由 B 在本机实测补齐（见表中的“B 实测”）。

| 需要 | 候选与依据 | 判断 |
| --- | --- | --- |
| 本地推理运行时 | [`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node) 2.0.1 与 `sherpa-onnx-win-x64` 2.0.1（Apache-2.0，2026-10-26 发布，已满 14 天）；Node-API 插件，win-x64 解压约 23 MB（含 onnxruntime 1.28.2）；npm 包只有 CPU；Electron ≥ 21 的 V8 内存笼要求返回音频的接口传 `enableExternalBuffer: false` | **采用**，在 `utilityProcess` 里运行。**B 实测**：打包后的 Electron 45 能否在 `utilityProcess` 里载入并识别。证明不了就停下来报告 A，不改用别的猜测方案 |
| 本地 ASR 模型 | sherpa-onnx 的 [Qwen3-ASR](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/index.html)、[Fun-ASR-Nano](https://k2-fsa.github.io/sherpa/onnx/funasr-nano/index.html) 文档；权重许可：Qwen3-ASR-0.6B 与 Fun-ASR-Nano-2512 都是 Apache-2.0；公开评测见 Qwen3-ASR 技术报告（arXiv:2601.21337）与 Fun-ASR-Nano 模型卡。`checksum.txt`（2026-11-13 复核）：`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2` `393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96`；`sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17.tar.bz2` `257936ea9a64cbe33200274e6367fc26d373ff6ca58b996b15108ffd6b9f6148`；`sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2` `eb43d7ccc2e86b243f6a03b7df361033dda66db9523d1a92bf6aca2b50c9476b` | **目录收这三个**：Qwen3-ASR-0.6B int8（推荐，热词经 `stream.setOption("hotwords", …)`）；sense-voice-funasr-nano int8（极速，CTC，无热词）；Fun-ASR-Nano int8（热词与提示）。**不收**：2024 版 SenseVoice-Small 与 Paraformer（权重为 FunASR `MODEL_LICENSE v1.1`，含“仅供参考与学习”的条款）、FireRedASR（不支持日语）、Whisper（sherpa-onnx 的 C 接口不能传 `initial_prompt`）。**B 实测**：三个模型在本机 CPU 上的载入时间、内存、10 s 语音的用时，以及 Node 接口的配置键名与每次识别时设置热词的方法 |
| 模型分发 | sherpa-onnx [GitHub Releases `asr-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)（覆盖全部三个模型与 `checksum.txt`；国内不稳定）；ModelScope `csukuangfj/asr-models`（国内直连，调研称含 funasr-nano-int8、不含 qwen3-asr，API 返回 SHA-256，支持 Range）；Hugging Face 的部分新仓库匿名访问返回 401 | **GitHub 是每个模型的基准来源**，哈希以它的 `checksum.txt` 为准；ModelScope 上的文件只有在 SHA-256 与 GitHub 完全相同时才列为另一个来源（**B 实测**后写进目录）；不用 Hugging Face。不自建镜像（需要额外的发布授权） |
| 解压 `.tar.bz2` | Windows 10 1803 起自带的 `tar.exe`（bsdtar，libarchive，本机 3.8.9 含 bz2）；npm 上的 bz2 解压库较旧 | **用系统的 `tar.exe`**，按绝对路径调用；先 `-tvf` 列出条目，拒绝绝对路径、盘符、`..` 与链接，再解压。没有 `tar.exe` 时说明原因，并提示改为导入解压好的文件夹 |
| 降噪 | [GTCRN](https://github.com/Xiaobin-Rong/gtcrn)（模型 MIT，`gtcrn_simple.onnx` 536 KB，16 kHz，sherpa-onnx 内置 `OfflineSpeechDenoiser`；`speech-enhancement-models` 的 `checksum.txt` 中哈希为 `e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534`）；RNNoise（固定 48 kHz）；DeepFilterNet（官方 2023 年后未再发版、无官方 npm 包）。公开实验（arXiv:2501.02452、arXiv:2512.17562、arXiv:2607.11157）显示全强度单通道降噪会让现代 ASR 变差，与原声混合可以挽回 | **GTCRN 作为可选项，默认关**，在推理进程里运行，输出按 75% 降噪与 25% 原声混合；随安装包附带（536 KB，附许可声明）。不采用 RNNoise 与 DeepFilterNet |
| 浏览器音频处理 | Chromium 的 `echoCancellation: true` 以本应用的音频输出为参考信号（覆盖 MANGA 自己播放的视频）；`echoCancellation: "all"` 自 M141 起在 Windows 上可用（系统回环为参考，源码固定增加 170 ms 延迟）；`noiseSuppression: true` 在源码里固定为 `kHigh`，没有强度可调；`voiceIsolation` 依赖硬件，不可靠 | 回声消除默认 `true`；“消除其他应用的声音”打开时用 `"all"`；**降噪默认关**；不用 `voiceIsolation`。**B 实测**：Electron 45 里 `"all"` 被接受（`getSettings()` 的回显），以及类型声明的补充 |
| 中文读音 | [`pinyin-pro`](https://github.com/zh-lx/pinyin-pro) 3.29.5（MIT，2026-10-10；官方基准的多音字准确率 99.846%，可拆声母、韵母与声调） | **采用** |
| 日文读音 | [`wanakana`](https://github.com/WaniKani/WanaKana) 5.3.1（MIT，2023-11-20 之后没有新版本，但功能单一且稳定：假名与罗马音互转）；日文汉字注音的 `lindera-wasm-nodejs-ipadic` 2.0.0（MIT，gzip 约 4 MB）；`kuroshiro` 加 `kuromoji`（多年未维护，载入后内存很大） | **采用 `wanakana`**。汉字注音本阶段不做（Bangumi 的“纯假名”“罗马字”别名已能覆盖多数角色），登记为 LOOP-39；不采用 kuromoji |
| 音近召回 | [`HaujetZhao/asr-hotword`](https://github.com/HaujetZhao/asr-hotword)（MIT，Python，最近提交 2026-06）：声母、韵母、声调的模糊匹配（平翘舌、前后鼻音），音节 2-gram 倒排粗筛，加权编辑距离局部对齐，黑名单。npm 上没有宽松许可的同类 JS 库 | **把算法移植为 TypeScript**，文件头与第三方声明里保留 MIT 许可与来源（含所依据的提交）。编辑距离与多模式匹配自己写在移植里，不另加库 |
| 简繁 | [`opencc-js`](https://github.com/nk2028/opencc-js) 1.4.2（代码 MIT、词典 Apache-2.0，2026-08-22） | **采用** |
| 外部接口 | OpenAI `/v1/audio/transcriptions`（`prompt` 有效；Groq、硅基流动、whisper.cpp 服务兼容，后两者不支持或不用 `prompt`）；阿里云百炼兼容模式**没有** `/audio/transcriptions`，`qwen3-asr-flash` 走 `/chat/completions` 的 `input_audio`，热词与背景写在 system 消息里；火山引擎是私有的 WebSocket 协议 | **支持两种标准形态**：已有的转录接口，新增对话接口的 `input_audio`。私有协议与流式识别登记为 LOOP-37 |
| 润色与防过度纠错 | HyPoradise（arXiv:2309.15701）、SoftCorrect（arXiv:2212.01039）、RobustGER：只把可疑位置交给模型、高置信的字照抄，能减少误改 | **润色走已有的文本连接**，加四道防线（4.9）。本地 LLM（`node-llama-cpp` 3.22.3，MIT）不在本阶段（LOOP-38） |
| 全量 ACG 词库 | [`bangumi/Archive`](https://github.com/bangumi/Archive)（每周构建，压缩约 330 MB；维基数据 CC BY-SA，要求署名并开放派生数据） | 本阶段不做（LOOP-39）。只在用户的作品上用 API 补全 |

## 4. 设计

### 4.1 听写会话、入口与插入（U1）

- **与录音笔记分开。** 新增 `packages/app-core/src/voice/dictation/` 与命令 `dictation.start`、`dictation.append`、`dictation.stop`、`dictation.cancel`、`dictation.status`；不写 `capture_sessions`，没有位置事件。属于模块 `manga.voice`（Facet `service`/`ui`），模块停用时听写不可用，迟到的结果按代次丢弃。这些命令只给界面用，Agent 的工具与命令访问里都没有，由用例证明。
- **阶段：** recording → trimming → recognizing → correcting → polishing → done，另有 no_speech、failed、cancelled；每步通过 `dictation.changed` 通知界面，带原文、替换后的文字、最终文字与退回原因。音频留在内存里，单次最长 5 分钟，到时自动结束并说明。
- **按键：** 在单一键位表里新增“按住听写”（默认右 Alt）、“锁定听写”（快速按两下）与“取消”（Esc，只在听写时生效）。B 先实测右 Alt：单独按下不能触发菜单、不能打断输入法、按住时不能反复触发；做不到时默认改为 F7，并在 Q-40 第 2 项写明。录音笔记的 F8、F9 不变。
- **插入目标：** 按下听写键时，记下获得焦点的可编辑元素与选区。界面新增一个插入适配层：textarea 与 input 用 `setRangeText` 并派发 `input` 事件，让 React 状态跟上；Tiptap 与 CodeMirror 用各自的事务。每个插入都返回一个句柄，可以整段替换（原文换成润色结果，或恢复原文），每次替换是一个撤销步骤。结束时元素还在，就插回记下的选区（那里的文字被改过时，插到当前光标处）；元素已经不在（标签关了），就在提示里显示结果并提供“复制”。输入法正在组合时，等组合结束才开始录音。
- **对话栏：** `composer.tsx` 与 `capsule.tsx` 的麦克风在“问 Agent”时是听写，文字填进输入框、不发送；在“笔记”时仍是现在的录音笔记。
- **出字：** 默认先插入识别的原文，再原地换成最终文字；设置里可以改为等最终文字再插入。插入后 10 s 内，出字处有一个小提示：“已润色 · 恢复原文”（有替换时还可以展开，看每处替换依据的词条）。
- **指示：** 获得焦点的面板底部中间显示一个小胶囊：录音时是随音量变化的麦克风图案与时长，之后依次是“识别中”“润色中”；锁定时多一个“结束”按钮。录音悬浮框（VOICE-05）只属于录音笔记，听写不用它。

### 4.2 采集前端（A1）

- `mic.ts` 的约束改为：`echoCancellation` 取设置（默认 `true`，“消除其他应用的声音”打开时为 `"all"`）、`noiseSuppression: false`、`autoGainControl: true`、`channelCount: 1`。补 `MediaTrackConstraints` 的类型声明。录音笔记与听写共用，开始采集后用 `getSettings()` 记下实际生效的值，写进调试面板。
- 环境降噪（GTCRN）默认关，打开后在推理进程里处理裁剪后的音频，输出为 `0.75 × 降噪 + 0.25 × 原声`，混合比是一个有单元用例的常量。外部引擎也先经过这一步（推理进程要先启动）。
- 听写与录音笔记期间，压低或暂停 MANGA 里正在播放的视频，沿用现有的 `duckPlayback`。
- 音量提示：整段人声的峰值低于 −30 dBFS 时提示“声音很小”，超过 1% 的样本到达满幅时提示“声音过大”。提示不阻止识别。
- 评测（4.11）比较浏览器降噪开与关、自动增益开与关、环境降噪开与关，结果写进报告。评测显示默认值不合适时，交给 A 决定是否改，B 不自行改。

### 4.3 去除静默（S1）

- 结束后用现有的 Silero VAD 对整段音频做一次筛选，复用 `vad-segmenter` 的参数：两侧各留 300 ms，长于 1 s 的停顿压成 400 ms 的静音，拼成一段送识别。
- 没有任何人声段：不送识别，提示“没有听到声音”，记为 no_speech。
- 识别结果只复述热词、提示或词条（沿用 `prompt-echo` 的判断，推广到热词列表）时按无效处理：不插入，提示“没有听清，请再说一次”。
- 锁定免提时不会因为停顿自动结束，只有单次 5 分钟的上限。

### 4.4 识别引擎的能力描述与外部接口（E1）

- 新增 `AsrEngine`，统一本地引擎与外部连接。每个引擎有一份能力描述：`hotwords`（最多几个，0 为不支持）、`promptChars`（提示的上限，0 为不支持）、`context`（能否在 system 消息里写背景）、`language`、`timestamps`、`maxUploadBytes`、`maxSeconds`。
- 按能力生成词库提示：热词（本地的 Qwen3-ASR 与 Fun-ASR-Nano，用逗号分隔，最多 50 个）；提示（OpenAI 兼容转录，沿用现有按模型限制截取的提示）；背景（对话接口，system 消息写“可能出现的专有名词：…”，最多 50 个）。都不支持的引擎不送任何提示。
- 外部连接：转录连接新增一个“接口形态”选项。“转录接口”是现有的 multipart `/audio/transcriptions`；“对话接口的音频输入”是 `/chat/completions`，消息里带 `input_audio`（WAV 的 base64），取回复的文本。连接测试对两种形态都用一段合成语音。
- 现有的 `AsrPort` 改为基于 `AsrEngine`：录音笔记也可以选本地引擎，块仍不超过 30 s，位置映射不变。
- 设置分别选“听写用的引擎”与“录音笔记用的引擎”，可选项是已装的本地模型与已配置的转录连接。所选引擎不可用（没配置、连接失败、模型没装或载入失败）时说明原因并给出设置入口，不换到另一个服务。

### 4.5 本地推理进程（N1）

- 新入口 `apps/desktop/src/main/asr-host.ts`，由 `bundleWorker` 打成 `asr-host.cjs`。第一次需要时用 `utilityProcess.fork` 启动（`serviceName: "MANGA speech"`），经 MessagePort 通信。`sherpa-onnx-node` 加进 `NATIVE`，打包时 `sherpa-onnx-node` 与 `sherpa-onnx-win-x64` 两个包都放在 asar 之外。
- 请求：`load(modelId, kind, files)`、`recognize(samples, { hotwords, language })`、`denoise(samples)`、`unload`、`ping`。一次一个请求，排队处理。取消听写只丢弃结果；正在识别时退出应用，就结束这个进程。
- 每种模型的 `OfflineRecognizer` 配置与“每次识别设置热词”的方法，由 B 按 sherpa-onnx 2.0.1 的源码与示例核实后写进报告。所有返回音频的接口都传 `enableExternalBuffer: false`。
- 闲置 10 分钟（可设置）后卸载模型，进程随之退出。进程崩溃时这次听写失败并说明原因，下一次重新启动进程；同一个模型 1 分钟内崩溃两次，就标为“载入失败”，在设置里说明。
- 边界：完整应用的主进程包与轻量打开的闭包都不得包含 `sherpa-onnx-node`，由 `check-deps.mjs` 与打包产物检查共同保证。推理进程不访问资料库与网络。

### 4.6 模型目录、下载与导入（M1）

- 目录写在代码里（`packages/app-core/src/voice/models/catalog.ts`）。每个模型记：编号、名称、类型（`qwen3Asr`、`funasrNano`、`senseVoice` 等，以 sherpa-onnx 的配置键为准）、语言、热词能力、许可与链接、压缩包名、大小、SHA-256、各来源的地址，以及解压后每个必需文件的相对路径、大小与 SHA-256。B 先按第 3 节的哈希从 GitHub 下载并校验压缩包，再计算各文件的哈希，写明查询日期。
- 下载：在主进程里用现有的网络层（跟随系统代理），只允许目录里写明的主机。先写到 `<应用数据根>\models\.staging\<编号>.part`，旁边的状态文件记已下载的字节数与 ETag。按 Range 续传；续传前先重算已有部分的哈希，校验通过才继续。可以暂停与取消，进度走现有的任务机制（新任务类型 `model-download`）。用户在确认框里看过大小、许可与来源，点了下载才发请求。默认先试 ModelScope 来源（有时），失败或没有时用 GitHub；可以手动选。
- 校验与解压：大小与 SHA-256 都相符后，用 `%SystemRoot%\System32\tar.exe` 先列出条目、拒绝越界，再解压到暂存目录；逐个核对必需文件的大小与哈希；全部通过后整体改名为 `<应用数据根>\models\asr\<编号>\`，原子地更新 `models\installed.json`。任何一步失败都清空这个模型的暂存，不启用。
- 导入：可以导入一个压缩包（与下载同样校验），或一个解压好的文件夹（逐个核对必需文件的哈希）。
- 删除：模型正在载入或使用时先让推理进程卸载它，再删目录、更新清单，显示释放的空间。
- 数据位置：`<应用数据根>\models\` 不进备份与资料包；卸载时按现有应用数据的规则处理（B 核对并写进数据与安全）。
- 门禁用的模型：极速模型（sense-voice-funasr-nano int8）与 `gtcrn_simple.onnx` 记进工具锁文件（固定的 Release 资产名加 SHA-256），由现有的工具下载脚本放到 `dist/tools/`；`check-tool-links.mjs --pins` 扩展规则，接受“固定资产名加哈希”的形态。GTCRN 随安装包附带并附许可声明；ASR 模型不随安装包。

### 4.7 词库扩展、schema v16 与 Bangumi 补全（X1）

- **schema v16**：`dictionary_terms` 加 `category`（character、actor、work、term、other，从来源推出初值）与 `disabled`；新表 `dictionary_aliases`（词条、文字、种类：alias、heard、kana、romaji、english，来源）。现有的 `heard` 迁移为 heard 种类的别名；B 决定保留还是重建去掉这一列，但不得丢任何数据。另有新表 `dictionary_suggestions`（建议词）、`dictation_history`（听写记录）、`bangumi_details`（角色与人物详情的缓存，键为种类与编号）。迁移沿用现有机制：迁移前备份、中断后重做、较新版本的资料不被旧版本打开。
- **读音**：载入词库时在内存里生成，不入库。汉字用 `pinyin-pro` 按整个词条取读音（多音字按词处理）；假名用 `wanakana` 转罗马音；拉丁字母转小写。
- **Bangumi 补全**：客户端新增 `character(id)` 与 `person(id)`。“从 Bangumi 资料加入”与“刷新”时，按主角、配角、他们的声优的顺序读取详情，每部作品最多 60 个请求，一个接一个发，沿用现有的 User-Agent、限流与退避；作为可取消的任务，显示进度；结果存入 `bangumi_details`。解析 `infobox` 时：同名键（“简体中文名”“别名”）可能出现多次，要全部遍历；“别名”的值里有的项没有 `k`；`infobox` 可能是 null，此时回退到顶层的 `name`。映射：有简体中文名时，它成为自动词条的正式写法，日文原名降为别名；“纯假名”为 kana，“罗马字”为 romaji，“英文名”为 english，其余为 alias。手写词条不受影响。
- **当前作品与热词**：当前作品取自获得焦点的标签所属的作品（没有时只用全局词典）。热词顺序为手写的、主角、配角、声优、其他；去掉停用的；最多 50 个。
- **批量导入**：一行一条，或用逗号、顿号分隔；`词条 | 别名1, 别名2` 写法可选；跳过重复与空行，报告新增与跳过的数量。
- **界面**：词典列表增加别名、类别、停用与来源的显示和编辑。

### 4.8 音近召回与确定性替换（R1）

- 把 asr-hotword 的核心移植到 `packages/app-core/src/voice/correct/`：音素表示（声母、韵母、声调；罗马音；拉丁字母），模糊规则（z/zh、c/ch、s/sh、n/l、an/ang、en/eng、in/ing，声调不同的代价较低），音节 2-gram 倒排粗筛，加权编辑距离的局部对齐精排，黑名单（每个词条可以写“不要替换的写法”）。
- 输出：每处候选的起止位置、原文、词条、得分（0—1）。规则：与词条或别名完全相同的直接替换；得分 ≥ 0.9、且词条属于当前作品或是手写的，直接替换；0.75—0.9 的作为候选交给润色（最多 15 个）；更低的忽略。阈值是有单元用例的常量，由 B 在纠错样本集上调好，写进报告。
- 索引在词库变化时增量更新。1 万条词条时，替换一句话的 p95 ≤ 30 ms（基准 `dictationCorrectionMs`）。

### 4.9 润色、防过度纠错与简繁（P1）

- **档位**：原文（不请求文本模型）；轻度（加标点、去口水词、句中改口时只留改后的说法、按候选纠正专名，不改意思、不扩写）；书面（再整理成书面语）。默认轻度；没有文本连接时按原文处理。提示词在“设置 › 语音转录”里可以查看、修改、恢复默认，默认值放在代码里。
- **四道防线**：（1）原文档，或轻度档下没有候选、也没有口水词与改口的迹象时，跳过模型；（2）提示只带召回的候选（“正式写法 | 读音或原名 | 类别与作品”，最多 15 个），并写明“没有读音相近的片段时不得套用候选、不得改变语气”；（3）低温度（`LlmPort.complete` 增加可选的 `temperature`，连接不支持时忽略）；（4）检查结果：长度与替换后文字之比超出 0.4—1.4，出现了替换后文字与候选里都没有的词典词条或拉丁字母、片假名词，失败，或超过 5 s，都退回替换后的文字并记下原因。
- **简繁**：最后用 `opencc-js` 统一成简体（可选繁体或不转）。与词条完全相同的片段在转换前后保持词条的写法。

### 4.10 听写记录与从修改中学词（H1）

- **记录**：每次听写在 `dictation_history` 里记时间、引擎与模型、原文、替换后的文字、最终文字、档位、退回原因、各步用时、当前作品。保留 30 天，在启动时与之后每天清理一次。“设置 › 语音转录 › 听写记录”可以复制原文或结果、删除一条、清空。不进备份与资料包，Agent 读不到。打开“保留最近的听写音频 24 小时”后，音频以 WAV 存在 `<应用数据根>\dictation-audio\`，过期删除；有音频的记录可以换一个引擎“重新识别”。
- **学词**：插入后的 60 s 内，插入适配层跟踪这段文字的范围（textarea 按输入事件调整偏移，Tiptap 与 CodeMirror 用各自的位置映射；跟踪不了就放弃）。失焦或到时后，比较插入的文字与现在的文字。被改的片段是 2—16 个字、新写法不是已有的词条或别名、旧写法与新写法的读音得分 ≥ 0.6 时，生成一条建议：“把「新写法」加入词典？（识别成了「旧写法」）”。出字处的小提示与设置里的“建议词”都能看到。确认后：新写法已是词条，就把旧写法加为它的 heard 别名；否则新建手写词条（当前作品，没有作品时全局），旧写法为 heard 别名。忽略后，同一组写法不再提示。

### 4.11 评测集与基准（Q1）

- **评测集**：`scripts/voice-eval/` 生成约 80 句合成语音，全部用 Windows 自带的语音合成；没有中文语音时脚本说明原因、记为 not-run。人名与作品名全部虚构，不用真实的人名。句子分三组：40 句含专名（中文音译的日式人名、作品名、少量英文词）；20 句含口水词与句中改口；20 句不含专名、但有和词条读音相近的普通词（用来量误改）。每句有三个版本：干净的、加 10 dB 合成风扇噪声的、加 10 dB 另一个合成人声的（模拟外放对白）。
- **评测脚本**：对每个已下载的模型，分别跑只识别、加替换、加润色（润色只在本地环境文件配置了文本连接时跑）三步，输出字错率、专名召回率、误改率与各步用时，写进基准的记录项。另外跑 4.2 的开关对比。只在开发机运行，CI 不跑。
- **纠错样本集**：`tests/fixtures/voice-correction.json`，至少 200 对“识别文字 → 期望文字”，每对写明来源（某个模型在评测集上的实际输出，或手写的混淆）。单元用例的门槛：确定性替换加候选的专名召回率 ≥ 0.85，不含专名的句子误改率 ≤ 1%。B 先测出基线；达不到时先改进，仍达不到就写进报告交 A 决定，不自行放宽。

## 5. 工作包与顺序

### 5.1 C0 阶段开始的整理（先做）

按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)执行，结果写进报告的“整理记录”。

**A 已做（在本计划所在的提交里）：**

- 上一阶段的报告提炼后删除：仍有效的内容（门禁与发布演练的结果、三个主进程文件的分工、悬浮框位置的根因、v15 迁移的结果）已在执行状态与各正本里。入链改为归档链接 `https://github.com/chialecode/manga/blob/f9aea92/docs/delivery/stage-report.md#<锚点>`（`f9aea92` 已确认在 `origin/main` 的历史里）；`README.md`、`docs/README.md` 与 `docs/SUMMARY.md` 去掉报告（B 新建后加回）。
- 登记表 `currentStage` 改为 `m12`，本计划的 `retireAfter` 改为 `m12`，报告的条目去掉。
- 改为 `m12` 后文档检查报出的上一阶段标签（确认记录、执行状态、文档导航与用户待办里的“M11”和旧分支名）已去掉；文档检查通过。
- 新增 A-130、A-131；需求 VOICE-10—VOICE-17；验收 AT-174—AT-183 与追踪矩阵；交付路线 2.2 改为本阶段；执行状态的当前阶段与分支；用户待办新增 Q-40 与 ACT-21，Q-23 移入“最近处理完的”；后续 loop 新增 LOOP-36—LOOP-40。

**B 执行时再核对一遍：**

| 位置 | 内容判断 | 处理 |
| --- | --- | --- |
| `.env.local` | 开发者的本地配置与凭据，必需 | 保留；不读取与任务无关的值。ACT-21 需要的连接变量由用户自己加，B 只在报告里写变量名 |
| `dist/design-refs/`、`dist/samples/` | 用户提供的界面参考、合成样本 | 原样保留；评测集生成到 `dist/samples/voice-eval/` |
| `dist/tools/` | 固定版本的工具 | 保留；按 4.6 加入极速模型与 GTCRN |
| `dist/desktop/`、`dist/plugins/` | 上一阶段最后的打包产物与安装包 | 阶段末重新打包时覆盖 |
| `dist/release/v0.1.1/` | 上一阶段的本地发布演练产物；v0.1.1 已在 GitHub 上发布 | 删除；本阶段不做发布演练 |
| `dist/gate-review.log`、`dist/release-review.log` | 上一阶段审查时的日志，结论已在归档报告里 | 删除 |
| `dist/evidence-runs/` | `current/`（上一阶段最后一次门禁）、按日期命名的 `pre-push-*.log`、`l1-combining-marks/`（上一阶段的排查目录） | `current/` 在本阶段第一次门禁时覆盖；先看 `l1-combining-marks/` 的内容，仍有用的结论提炼进执行状态或对应的 LOOP，然后删除；日志删除 |
| `%APPDATA%\manga-release\` | 两把签名私钥（ACT-08） | 原样保留，不读不输出私钥，不得重新生成 |
| 系统临时目录里的 `manga-*`（A 盘点时有 2 个） | 以前失败运行留下的现场 | 确认没有正在运行的门禁后删除，只记数量 |
| `apps/desktop/.vite/`、`tsconfig.tsbuildinfo` | 构建缓存 | 保留，打包时重建 |
| `docs/evidence/gate/` | 上一阶段最后一次门禁的证据 | 本阶段最后一次门禁时整体替换 |

**去掉以前阶段的标签（A-57）。** A 已运行文档检查；B 交付前再运行一次。`docs/evidence/gate/` 里的 `stage` 字段随本阶段最后一次门禁整体替换。Git 提交信息与固定归档链接里的路径不改。

### 5.2 D1 依赖盘点与新增依赖

B 在实施开始与门禁之前各跑一次 `pnpm outdated -r`，按“满 14 天的最新版本”处理；主版本或行为变化的升级先单独做并跑对应的回归，失败时回退，并在 ADR-0007 的例外表写明尝试的版本、失败的命令、上游限制与复查条件。最小发行龄策略不绕过。

新增依赖只限第 3 节判定为采用的：`sherpa-onnx-node` 与 `sherpa-onnx-win-x64`（只在推理进程）、`pinyin-pro`、`wanakana`、`opencc-js`，精确版本写进 manifest 与锁文件，并登记进 ADR-0007 的版本表与第三方许可声明。确实需要别的依赖时，先在报告里写明理由与同样的查证，再加。

### 5.3 工作包

| 包 | 内容 | 关键失败路径 | 验收 |
| --- | --- | --- | --- |
| U1 听写会话、入口与插入 | 4.1 | 右 Alt 触发菜单或打断输入法；识别中标签被关；插入处的文字在识别时被改过；输入法组合中按键；Esc；锁定后切换应用；模块停用时结果迟到；Agent 试图调用 | AT-174、AT-182 |
| A1 采集前端 | 4.2 | `"all"` 不被接受时说明并退回 `true`；没有麦克风；设备在听写中断开；视频在听写中被关 | AT-175 |
| S1 去除静默 | 4.3 | 整段静音；只有呼吸与键盘声；开头就是话；5 分钟上限；复述热词 | AT-176 |
| E1 识别引擎 | 4.4 | 能力为 0 的引擎不收任何提示；连接认证失败、超时、超过上传上限；所选引擎不可用时其他服务收到 0 个请求；本地引擎转写 3 分钟的录音笔记 | AT-177 |
| N1 本地推理进程 | 4.5 | 打包后载入失败（停下报告）；识别中进程被结束；1 分钟内两次崩溃；闲置卸载后再用；应用退出时进程退出；闭包检查 | AT-179 |
| M1 模型目录、下载与导入 | 4.6 | 下载到一半断网与重启应用后续传；ETag 变化时从头下载；哈希不符；越界条目与链接；磁盘空间不够；没有 `tar.exe`；文件夹导入缺文件；删除正在用的模型 | AT-178 |
| X1 词库、v16 与 Bangumi 补全 | 4.7 | v15 资料迁移、中断、旧版本打开；`infobox` 的三种边界；超过请求预算；403 或 429；手写词条与自动词条重名；停用的词条不进热词 | AT-180 |
| R1 音近召回与替换 | 4.8 | 不含专名的句子里读音相近的普通词；词条是另一个词条的一部分；拉丁字母与罗马音；黑名单；1 万条词条的速度 | AT-181、AT-183 |
| P1 润色、防线与简繁 | 4.9 | 过长、新专名、超时、错误；原文档不请求；改过的提示词与恢复默认；繁体输入；词条写法在简繁转换中不变 | AT-181 |
| H1 记录与学词 | 4.10 | 30 天过期；音频 24 小时过期；备份与资料包不含记录；跟踪不了的范围；同一组写法忽略后不再提示；建议的新写法已是词条 | AT-182 |
| Q1 评测与基准 | 4.11 | 没有中文语音时评测记为 not-run；没有模型时只跑能跑的；纠错样本集的门槛 | AT-183 |
| T1 测试、走查与基准 | 第 7 节 | — | 第 7 节 |
| W1 文档 | 需求 VOICE-10—VOICE-17 按实现改为“已实现”，VOICE-01、VOICE-09 补充；领域模型（v16 的表与关系、听写的阶段）；语音模块规格（听写、引擎、模型、词库与纠错，按模块规格模板补全）；交互设计（听写胶囊、出字处的提示、“设置 › 语音转录”的新分区、快捷键）；总体架构（推理进程与边界）；数据与安全（模型与听写音频的位置、下载的主机允许列表、哈希校验、不进备份、卸载）；Agent 与插件（听写不对 Agent 开放）；质量门禁（新的观察、评测与基准）；仓库地图（新目录与脚本）；第三方许可声明（asr-hotword 的移植、GTCRN、新依赖）；执行状态；README 的听写一节 | — | 文档检查 |

### 5.4 顺序

1. C0；D1 的第一次盘点与新增依赖。
2. N1 的最小验证：打包后的 `utilityProcess` 能载入 `sherpa-onnx-node` 并用极速模型识别一段合成语音。这一步决定后面的本地路线，最先做；证明不了就停下来报告 A，其余不依赖本地推理的工作包继续做。
3. M1 → E1 → S1、A1（引擎与模型就绪后，打通录音到文字的路径）。
4. X1 → R1 → P1（词库、替换与润色）。
5. U1 → H1（界面、插入、恢复与学词）。
6. Q1；T1、W1；最后一次 `pnpm outdated -r`；`stage gate`；报告与整理记录。

可以按依赖调整顺序，但不得跳过任何一个工作包。

## 6. 界面要点

- “设置 › 语音转录”分为：听写（快捷键、出字方式、档位、提示词）、识别引擎（听写与录音笔记各自的选择；本地模型列表，含语言、热词、许可、大小、来源、下载进度、暂停、删除、导入；外部连接的接口形态）、声音（回声消除、消除其他应用的声音并注明延迟、环境降噪、录音时视频的声音）、词典（别名、类别、停用、批量导入、从 Bangumi 资料加入与刷新、建议词）、听写记录（保留音频的开关）。沿用现有设置页的控件与布局。
- 听写胶囊与出字处的提示用现有的主题变量；不显示设备名；系统开启“减少动态效果”时，音量图案改为有声与无声两档。
- 所有新控件有可访问名称，可以用键盘操作；听写的状态变化对读屏软件可见（`aria-live`）。
- 文案用中文，说清原因与下一步，例如“没有听到声音”“本地模型还没下载：去下载”“润色超时，已保留原文”。

## 7. 样本、门禁与基准

**样本。** 全部合成：评测集与观察用的语音由 Windows 自带的语音合成生成；人名与作品名虚构；假转录服务、假对话接口、假模型下载服务（提供一个小的合成模型包，用于下载、续传、篡改与越界的用例）与假 Bangumi（加入 `/v0/characters/{id}` 与 `/v0/persons/{id}`）都在本机。

**单元与集成用例（新增，必需）：** 能力描述与提示生成；对话接口的请求格式；去除静默的长度计算；下载的续传、哈希、越界与清理；目录的完整性（每个模型的哈希与必需文件都有）；v16 迁移（备份、中断、旧版拒绝）；`infobox` 解析；热词顺序；音近召回的规则与阈值；纠错样本集的门槛；四道防线；简繁与词条保护；听写记录的保留与导出排除；学词的比较规则；命令访问里 Agent 看不到听写命令。

**窗口与安装观察（新增，必需）：**

| 观察 | 内容 |
| --- | --- |
| `dictation-insert` | AT-174：五处输入的听写（假转录服务）、锁定、Esc、切换标签、输入法组合、对话栏两种模式的麦克风 |
| `dictation-local` | AT-179：打包应用用 `dist/tools/` 里的极速模型做一次真实的本地听写；结束推理进程后再听写；闲置卸载（测试里把闲置时间设短） |
| `dictation-revert` | AT-182：恢复原文、Ctrl+Z、出字处的提示、改一个人名后出现建议并确认 |
| `dictation-settings` | 本地模型的下载（假下载服务：进度、暂停、续传、校验失败）、词典的别名与建议词、听写记录；截图（浅色与深色） |
| `dictation-boundary` | 打包产物：`sherpa-onnx-node` 只在 `asr-host.cjs` 里；轻量打开的闭包检查通过；安装包里没有 ASR 模型 |
| `voice` 阶段（已有）扩展 | 采集约束的实际值；录音笔记改用本地引擎转写一段合成录音 |

上一阶段全部的窗口观察保留。截图只留关键状态：听写胶囊（录音、识别中）、出字处的提示、本地模型列表（下载中与已装）、词典的别名、听写记录。截图不含本机路径与设备名。

**基准（新增门槛）**：`dictationLocalReleaseToTextMs`：打包应用里极速模型已载入，假采集设备播放约 4 s 的合成语音，从松开到文字插入，5 次的 p95 ≤ 1500 ms；`dictationCorrectionMs`：1 万条词条时替换一句话，p95 ≤ 30 ms。**记录项**：各模型的载入时间与推理进程的内存（推荐模型在开发机上下载了时才记）；评测脚本的字错率、专名召回率、误改率与各步用时；4.2 的开关对比。B 先测出基线；门槛达不到时先优化，仍达不到就在报告里写明原因交 A 决定，B 不自行放宽。

**门禁。** 修复先用子集确认（`MANGA_PACKAGE_PHASES` 与 `MANGA_PACKAGE_REUSE_BUILD`、单个测试文件）；只改走查时只重跑 package。最后在最终源码上跑一次 `node scripts/stage.mjs gate`。跑前确认机器空闲、启动它的应用在前台、不锁屏，跑的过程中不改工作树；门禁会打开窗口，开跑前先在聊天里告诉用户。证据整体替换 `docs/evidence/gate/`，总量不超过 5 MiB，复制前先看过新截图，不含本机路径。本阶段不做本地发布演练（没有改安装与更新）；如果改到了安装包的内容（GTCRN 与新的原生模块），`installer` 步骤照常运行。

## 8. 人工检查

B 在用户待办里新增人工检查（编号从 H-104 起），写到用户能直接照做：用真实的麦克风在五处输入里听写；右 Alt 在用户的键盘与输入法下是否好用；在“设置 › 语音转录”里真实下载推荐模型与极速模型（看速度、暂停、续传）；用自己资料库里一部关联了 Bangumi 的作品，说出角色名与声优名，比较本地模型与自己的转录连接；外放播放 MANGA 里的视频时听写（回声消除），以及用别的播放器外放时打开“消除其他应用的声音”；改错一个名字后确认建议，再说一次；恢复原文；听写记录。真实的鼠标、键盘与麦克风只在人工检查里用，自动观察不移动用户的鼠标、不抢焦点。人工检查保持 not-run，不由脚本代填。

## 9. B 交付与 A 审查

- B 新建本阶段报告 `docs/delivery/stage-report.md`（并加回登记表、`README.md`、`docs/README.md` 与 `docs/SUMMARY.md`）：按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射；写明 N1 的最小验证结果（含 `enableExternalBuffer` 的处理）；三个模型的配置键名、热词的设置方法与本机实测（载入时间、内存、用时）；目录里每个模型的来源、哈希与查询日期；右 Alt 的实测结论；v16 迁移的结果；音近召回的阈值与纠错样本集的结果；评测脚本的结果与 4.2 的开关对比；基准数值与门禁各步用时；依赖盘点结果；整理记录与源码指纹。
- B 交付前自检：第 1 节的退出条件逐条有证据；`stage gate` 通过；文档检查通过；暂存内容核对过（不含模型文件与本机路径）；一个带 DCO 签名的阶段提交（amend 本计划所在的提交，消息按最终结果重写）。
- A 审查时重点看：音频只发往所选的一个引擎，失败时不换服务，Agent 碰不到听写；下载只在用户确认后发生、只访问目录里的主机，哈希不符与越界条目一定被拒、暂存清空；推理进程不进完整应用主进程与轻量闭包，崩溃不影响应用；去除静默不切掉字头字尾；纠错的门槛与样本来源是真实的、没有为通过而挑样本；四道防线确实生效，退回时保留了原文；v16 迁移有备份、可重来、旧版拒绝，旧词条一条不少；听写记录不进备份与资料包；基准的门槛与测量方法没有被改动；录音笔记的既有行为与全部既有观察不变（除了降噪默认关）。

## 10. 待处理事项入口

- 需要用户的：[Q-40](../../USER-ACTIONS.md#q-40)（本阶段先用的默认值）；[ACT-21](../../USER-ACTIONS.md#act-21)（可选的真实契约）；仍待答复的 [Q-39](../../USER-ACTIONS.md#q-39)、[Q-38](../../USER-ACTIONS.md#q-38)、[Q-37](../../USER-ACTIONS.md#q-37)；[ACT-08](../../USER-ACTIONS.md#act-08)（备份两把私钥）；[ACT-18](../../USER-ACTIONS.md#act-18)。都不阻塞本阶段。
- 新增的后续项：全局听写（LOOP-36）、流式与私有协议（LOOP-37）、本地润色模型（LOOP-38）、全量离线词库与日文汉字注音（LOOP-39）、语音改写选区（LOOP-40）。留在[执行状态的后续 loop](status.md#followup-loops)。
- 顺延的 Agent 侧后续项保持不变（LOOP-10、11、12、14、15、16、18、21、30、31、35）。

<a id="prompt"></a>
## 11. 交给 B 的执行 prompt

```text
你是 Agent B，在本仓库的分支 feat/m12-voice-dictation 上连续完成当前阶段（类 Typeless 的听写）。

依据：AGENTS.md；docs/delivery/stage-plan.md（本阶段唯一计划，全部工作包 C0、D1、U1、A1、S1、E1、N1、M1、X1、R1、P1、H1、Q1、T1、W1，设计 4.1—4.11）；确认记录 A-130、A-131；需求 VOICE-10—VOICE-17；验收 AT-174—AT-183；用户待办 Q-40（按其中的默认实现；用户答复后以答复为准）。

要求：
1. 先核对现场（git status、分支基于 main@3b9d498、计划所在的提交），再按计划第 5.4 节的顺序连续实施，不逐工作包询问。
2. 新增依赖只限第 3 节判定采用的（sherpa-onnx-node 与 sherpa-onnx-win-x64、pinyin-pro、wanakana、opencc-js），精确版本，登记 ADR-0007 与第三方许可声明；依赖盘点按 5.2。asr-hotword 的移植保留 MIT 许可与来源提交。
3. 先做 N1 的最小验证：打包后的 Electron 45 在 utilityProcess 里载入 sherpa-onnx-node，并用极速模型识别一段合成语音。证明不了就停下来报告 A（写明错误与尝试过的做法），只继续不依赖本地推理的工作包。
4. 音频只发往用户所选的一个引擎，不自动换服务；听写命令不对 Agent 开放；推理进程不进完整应用主进程与轻量闭包（check-deps 与打包产物双重检查）。
5. 模型下载按 4.6：用户确认后才发请求；只访问目录里的主机；Range 续传并重算已有部分的哈希；压缩包与每个必需文件都核对 SHA-256；用系统 tar.exe 前先列出条目并拒绝越界与链接；失败时清空暂存；安装包不含 ASR 模型。目录里的哈希以 sherpa-onnx GitHub Release 的 checksum.txt 为准，ModelScope 只在哈希相同时列为来源。
6. 采集按 4.2（降噪默认关、回声消除默认开）；开关对比的结果写进报告，不自行改默认值。
7. 词库按 4.7：schema v16 迁移有备份、可重来、旧版本拒绝打开，旧词条与“手写优先”一条不少；Bangumi 补全每部作品最多 60 个请求，测试只用假 Bangumi。
8. 纠错与润色按 4.8、4.9：阈值与门槛写成有用例的常量；纠错样本集每对写明来源，不为通过而挑样本；四道防线退回时保留原文；门槛达不到先改进，仍达不到写进报告交 A 决定，不自行放宽。
9. 听写记录与学词按 4.10：不进备份与资料包，Agent 读不到；学词经用户确认才加入。
10. 基准按第 7 节：两个新门槛先测基线；不改任何既有门槛、样本数与测量方法。
11. 只用合成样本与虚构的人名；测试只用本地的假服务；ACT-21 没有授权时真实契约记为 not-run。自动观察不移动用户的鼠标、不抢焦点；真实输入的检查写进用户待办。
12. 改写测试与走查时断言不减，删除的断言在迁移映射里写明由什么替代。修复先用子集确认；最后在最终源码上跑一次 node scripts/stage.mjs gate（跑前确认机器空闲、启动它的应用在前台，不锁屏，并先在聊天里告诉用户；跑的过程中不改工作树）；证据替换 docs/evidence/gate/（≤ 5 MiB，截图不含本机路径与设备名，复制前先看过新截图）。
13. 新建本阶段报告 docs/delivery/stage-report.md（计划第 9 节，并加回登记表、README.md、docs/README.md 与 docs/SUMMARY.md），更新用户待办的人工检查（计划第 8 节，从 H-104 起）、执行状态与各正本；把全部改动 amend 进本阶段唯一的 DCO 签名提交，消息按最终结果写。不 push、不触发 workflow。
14. 结束时按开发流程 2.4 给出首选下一步：推荐交给 A 集中审查，并附审查 prompt。
```
