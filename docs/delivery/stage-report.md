# 当前阶段报告（M12）：类 Typeless 的听写

日期：2026-11-13（B 的全链路门禁完成于 `2026-11-12T22:51:27Z`；A 审查修复后在最终源码上重跑，完成于 `2026-11-13T02:16:38Z`）。分支：`feat/m12-voice-dictation`（基于 `main@3b9d498`）。角色：B 连续实施、评测与门禁自检完成；A 集中审查已收敛（结论与修复见[第 11 节](#a-review)）。唯一计划见[当前阶段计划](stage-plan.md)。门禁汇总状态：`automationStatus: "self-check-passed"`、`engineeringReviewable: true`；`productAcceptance` 恒为 `not-run`，可选真实服务契约 [ACT-21](../../USER-ACTIONS.md#act-21) 与新增人工检查 [H-104](../../USER-ACTIONS.md#h-104)—[H-111](../../USER-ACTIONS.md#h-111) 均保持 `not-run`。

<a id="c0-d1"></a>
## 1. C0 阶段开始的整理与 D1 依赖盘点

### 1.1 C0 整理记录（计划 5.1）

| 对象 | 处置结果 |
| --- | --- |
| 上一阶段报告 `docs/delivery/stage-report.md` | 有效结论均已提炼进[执行状态](status.md)、[ADR-0007](../decisions/0007-technology-stack.md) 与确认记录，并由固定归档链接（`f9aea92`）引用；旧文件已在阶段开始时移除并取消旧登记，本文件为本阶段新建报告（`retireAfter: "m12"`） |
| `dist/evidence-runs/l1-combining-marks/`（`22,944` B） | 排查结论早已记入 [LOOP-04](status.md#loop-04)，旧目录已删除；`tests/reading/pdf-combining-marks.test.ts` 每次运行都会重新写出该目录（测量与对比图），属于测试输出，不是遗留 |
| `dist/release/v0.1.1/`（约 `229 MB`） | 首个正式版 `v0.1.1` 已发布至 GitHub Releases，本地演练结论已记入[执行状态](status.md)，构建产物目录已删除 |
| `dist/evidence-runs/` 旧排查日志（`review-*.log`、`fix-*.log`）与系统临时目录 `manga-*` | 确认无运行中门禁后清理旧阶段日志与遗留 `manga-*` 临时目录；本阶段门禁运行输出位于 `dist/evidence-runs/current/`，脱敏门禁证据已同步至 [`docs/evidence/gate/`](../evidence/gate/)（`28` 个文件，`3,498,776` B = `3.34 MiB` ≤ `5 MiB`），`stage test` 与 `stage package` 前后统计系统临时目录 `manga-*` 残留均为 `0` |
| `.env.local` 与 `%APPDATA%\manga-release\` | `.env.local` 与仓库外两把签名私钥（`plugin-signing.key`、`update-signing.key`）原样保留，未读取无关配置值、未输出私钥明文 |
| `dist/design-refs/`、`dist/samples/`、`dist/tools/` | 原样保留；`dist/tools/` 新增按锁文件校验拉取的 `gtcrn/`（随包语音增强模型与 MIT 许可）及 `asr/sense-voice-funasr-nano-int8/`（仅供本机离线烟测与基准使用，绝不打入安装包） |
| 本地备份分支（`rebuild/*`、`backup/main-pre-rewrite`） | 按用户既有决定原样保留，未触碰 |
| 以前阶段标签与公开内容检查（A-57） | `node scripts/check-docs.mjs` 与 `node scripts/check-publication.mjs`（扫描 `1,123` 个文件，`0` 项违规）全部通过：永久正本与代码零旧阶段标签、零本机绝对路径、零外部未采用参考工程名 |

### 1.2 D1 依赖盘点记录（计划 5.2，A-35）

阶段开始与最终门禁前各执行一次 `pnpm outdated -r`，严格遵守最小发行龄策略（`minimumReleaseAge: 20160` 分钟不绕过、不写豁免），核对日期 `2026-11-13`，结果已同步登记至 [ADR-0007](../decisions/0007-technology-stack.md)：

| 包 | 变更前 | 变更后 | 核验依据与结论 |
| --- | --- | --- | --- |
| `@tanstack/react-virtual` | `3.14.23` | `3.14.24` | `2026-10-29 10:55 UTC` 发行（已满 14 天；`3.14.28` 未满龄）；5000 条长对话虚拟列表与动态行高通过 |
| `@tiptap/core`、`extension-document`、`extension-text`、`pm`、`react` | `3.32.0` | `3.32.1` | `2026-10-28 19:47 UTC` 发行（已满 14 天；`3.33.0` 未满龄）；笔记与文稿富文本编辑、听写插入与分步撤销通过 |
| `dockview-react`（含配套 `dockview` / `dockview-core`） | `8.7.1` | `8.8.0` | `2026-10-28 21:10 UTC` 发行（已满 14 天；`8.9.0` 未满龄）；多视图标签页与四宫格分屏走查通过 |
| `lucide-react` | `1.63.0` | `1.64.0` | `2026-10-29 06:10 UTC` 发行（已满 14 天；`1.66.0` 未满龄）；完整应用、听写胶囊与轻量界面图标类型及渲染通过 |
| `sherpa-onnx-node`、`sherpa-onnx-win-x64` | 新增（`apps/desktop`） | `2.0.1` | Apache-2.0，`2026-10-26` 发行（内置 ONNX Runtime `1.28.2`，N-API 预编译免重编）；平台包置于 `optionalDependencies` 兼容 Linux CI `--frozen-lockfile`，打包解包至 `app.asar.unpacked` 且仅由 `asr-host.cjs` 加载 |
| `pinyin-pro`、`wanakana`、`opencc-js` | 新增（`packages/app-core`） | `3.29.5`、`5.3.1`、`1.4.2` | 精确锁定（发行日期分别为 `2026-10-10`、`2023-11-20`、`2026-08-22`；前两者 MIT，`opencc-js` 代码 MIT、OpenCC 词表 Apache-2.0）；分别承担中文拼音规整、日文假名/罗马字归一与主进程简繁转换 |
| `.tar.bz2` 解压实现 | — | 零新增 npm 包 | 直接调用 Windows 11 系统内置 `%SystemRoot%\System32\tar.exe`（`bsdtar`）完成两步归档安全检查与解压，**未引入任何第三方 JS tar/bzip2 解压依赖** |
| `linkedom` | `0.18.13` | 保持 `0.18.13` | 已登记例外不变：`0.18.14` 依赖 `@acemir/cssom` CommonJS 具名导出限制未变，`0.18.15`（`2026-11-01` 发行）未满 14 天 |
| 其余直接依赖（`electron` `45.1.0`、`@types/node` `24.19.2`、`electron-builder` `26.18.0`、`electron-updater` `6.8.11` 等） | 现锁定精确版本 | 保持不变 | `@types/node` 随 Electron 45 的 Node 24.22 固定在 24.x；`electron-builder` 与 `electron-updater` 的 npm `latest` 仍为现版本；`electron` `45.3.1`、`vite` `8.3.8`、`vitest` `5.1.0`、`knip` `6.45.1`、`@earendil-works/pi-ai` `1.5.2` 等候选均于 `2026-10-30` 后发行，未满 14 天。门禁前复跑 `pnpm outdated -r` 确认除 `linkedom` 外满龄同主版本待升项为 `0` |

<a id="mapping"></a>
## 2. 工作包、需求、验收与断言迁移映射

### 2.1 工作包交付映射（计划第 5.3 节）

| 工作包 | 实现位置（仓库相对路径） | 验证命令与证据 | 状态与边界 |
| --- | --- | --- | --- |
| `C0` 阶段开始整理 | `docs/governance/document-registry.json`、清理旧构建与日志目录 | `node scripts/check-docs.mjs`、`node scripts/check-publication.mjs` | `passed` |
| `D1` 依赖盘点与新依赖接入 | `package.json`、`apps/desktop/package.json`、`packages/app-core/package.json`、`pnpm-lock.yaml`、`docs/decisions/0007-technology-stack.md` | `pnpm outdated -r`、`node scripts/verify.mjs` | `passed`（升级 4 组、仅新增计划批准的 5 个包） |
| `U1` 应用内听写与六处输入目标 | `apps/desktop/src/renderer/voice/use-dictation.ts`、`editable-target.ts`、`dictation-capsule.tsx`、`dictation-pill.tsx`、`apps/desktop/src/renderer/styles-voice.css`、对话栏/笔记/文稿/白板/导图/搜索框挂载 | `tests/shell/dictation-keys.test.ts`、`tests/shell/editable-target.test.ts`、`tests/shell/dictation-ui.test.tsx`；烟测 `dictation-insert`、`dictation-revert`；截图 `ui-dictation-capsule-recording.png`、`ui-dictation-capsule-recognizing.png`、`ui-dictation-pill.png` | `passed`；真实麦克风与实体右 `Alt` 手感见 [H-104](../../USER-ACTIONS.md#h-104)、[H-105](../../USER-ACTIONS.md#h-105) |
| `A1` 采集前端、系统回声消除与 GTCRN 回混 | `packages/contracts/src/dictation.ts`、`apps/desktop/src/renderer/voice/mic.ts`、`recorder.ts`、`apps/desktop/src/main/asr-host.ts`（`0.75 * wet + 0.25 * dry`）、`scripts/tools/gtcrn.lock.json`、`scripts/desktop-assets.ts` | `tests/voice/asr-service.test.ts`、`tests/package/bundled-assets.test.ts`、烟测 `voice`（`audio-constraints`）、`scripts/voice-eval/run-eval.mjs`（§4.2 五档对比） | `passed`（`AT-175`）；Windows Loopback 实机回声消除见 [H-108](../../USER-ACTIONS.md#h-108) |
| `S1` 去除静默与质量诊断 | `packages/app-core/src/voice/silence-trimmer.ts` | `tests/voice/silence-trimmer.test.ts`；烟测 `dictation-insert`（全静音 `no_speech` 不插入、零外部请求） | `passed`（`AT-176`） |
| `E1` 识别引擎能力描述与外部接口（零跨引擎静默回退） | `packages/app-core/src/voice/engine/asr-engine.ts`、`prompt-builder.ts`、`packages/model-protocol/src/openai-http.ts`、`transcription.ts`、`packages/contracts/src/inputs-models.ts`、`packages/app-core/src/voice/dictation/service.ts`、`packages/app-core/src/commands/voice.ts` | `tests/voice/asr-engine.test.ts`、`tests/agent/models-page.test.tsx`、`tests/voice/dictation-integration.test.ts`；打包烟测 `dictation-insert` | `passed`（`AT-177`，假服务闭环且失败保留临时音频供重试）；真实端点契约 [ACT-21](../../USER-ACTIONS.md#act-21) `not-run` |
| `N1` 本地推理进程 `utilityProcess` 隔离与闭包 | `apps/desktop/src/main/asr-host.ts`、`asr-protocol.ts`、`asr-service.ts`、`apps/desktop/forge.config.ts`、`apps/desktop/vite.main.config.ts`、`scripts/check-deps.mjs` | `tests/voice/asr-service.test.ts`；打包烟测 `dictation-local`、`dictation-boundary`、`voice`（`local-capture`）；静态 `checkMainClosure` 与 `checkLightClosure` | `passed`（`AT-179`，详见[第 3 节](#n1)与[第 4 节](#models)） |
| `M1` 模型目录、下载、续传、校验与导入 | `packages/app-core/src/voice/models/catalog.ts`、`downloader.ts`、`tar-extract.ts`、`service.ts` | `tests/voice/model-downloader.test.ts`；打包烟测 `dictation-local`、`dictation-settings` | `passed`（`AT-178`）；真实外网下载体验见 [H-106](../../USER-ACTIONS.md#h-106) |
| `X1` 词库、Schema v16 迁移与 Bangumi 角色/人物补全 | `packages/storage-drizzle/src/schema.ts`、`sql.ts`、`store.ts`、`packages/app-core/src/voice/dictionary.ts`、`packages/app-core/src/metadata/bangumi.ts`、`apps/desktop/src/renderer/pages/settings/dictionary-editor.tsx` | `tests/library/schema-v16-migration.test.ts`、`tests/voice/dictionary-bangumi.test.ts`；打包烟测 `migrated-profile`、`dictation-settings` | `passed`（`AT-180`）；真实 Bangumi 详情契约 [ACT-21](../../USER-ACTIONS.md#act-21) `not-run` |
| `R1` 发音规整、2-gram 音近召回与确定性替换 | `packages/app-core/src/voice/correct/phonemes.ts`、`align.ts`、`index-2gram.ts`、`corrector.ts`（`HaujetZhao/asr-hotword` MIT TS 移植） | `tests/voice/phonetic-correct.test.ts`、`tests/voice/correction-eval-gate.test.ts`（`252` 对真实模型输出）；基准 `dictationCorrectionMs` | `passed`（`AT-181`、`AT-183`：召回率 `0.9521` ≥ `0.85`，误改率 `0.0000` ≤ `1%`，1 万词 `p95 = 0.63 ms` ≤ `30 ms`） |
| `P1` 三档 LLM 润色、四道防线与简繁保护 | `packages/app-core/src/voice/polish/polisher.ts`、`guards.ts`、`prompts.ts`、`opencc.ts` | `tests/voice/polish-guards.test.ts`、`tests/voice/dictation-integration.test.ts`；打包烟测 `dictation-revert` | `passed`（`AT-181`） |
| `H1` 听写记录、备份/资料包剔除与 60s 从修改中学词 | `packages/app-core/src/voice/dictation/history.ts`、`learn.ts`、`packages/storage-drizzle/src/store.ts`（`copyForBackup`）、`packages/app-core/src/commands/access.ts`、`apps/desktop/src/renderer/pages/settings/voice-page.tsx` | `tests/voice/dictation-history-learn.test.ts`、`tests/voice/dictation-integration.test.ts`；打包烟测 `dictation-settings`、`dictation-boundary`；截图 `ui-dictation-settings-dark.png`、`ui-dictation-settings-light.png`、`ui-dictation-dictionary.png`、`ui-dictation-history.png` | `passed`（`AT-182`） |
| `Q1` 240 条离线评测集、前端开关对比与纠错回归集 | `scripts/voice-eval/generate-corpus.mjs`、`corpus.json`、`audio-dsp.mjs`、`sherpa-runner.mjs`、`metrics.mjs`、`run-eval.mjs`、`tests/fixtures/voice-correction.json` | `node scripts/voice-eval/run-eval.mjs`、`tests/voice/correction-eval-gate.test.ts` | `passed`（`AT-183`，详见[第 8 节](#eval)） |
| `T1` 测试、打包窗口走查与听写基准 | `apps/desktop/src/main/smoke/dictation-walk.ts`、`voice.ts`、`bench-dictation.ts`、`scripts/stage/bench-dictation.mjs`、`gate.json`、`package.mjs`、`bench.mjs`、`report.mjs`、`scripts/stage-report.test.mjs` | `node scripts/stage.mjs gate`（`test`、`package` × 3、`installer`、`bench`、`report`、`install-dev`） | `passed`（计划第 7 节，详见[第 9 节](#gate)） |
| `W1` 正本同步、许可证声明与人工检查步骤 | `docs/product/requirements.md`、`docs/delivery/roadmap-and-acceptance.md`、`docs/design/*.md`、`docs/modules/voice.md`、`docs/dev-rules/*.md`、`docs/decisions/0007-technology-stack.md`、`README.md`、`USER-ACTIONS.md`、`docs/delivery/status.md`、`docs/delivery/stage-report.md` | `node scripts/verify.mjs --skip-tests`、`evaluateStageEvidence` | `passed` |

### 2.2 需求与验收用例追踪（`VOICE-10`—`VOICE-17` 及联动项，`AT-174`—`AT-183`）

| 需求 / 验收编号 | 自动化与打包验证覆盖 | 门禁状态 | 产品验收 / 人工检查 |
| --- | --- | --- | --- |
| `VOICE-01`、`VOICE-03`、`VOICE-06`、`VOICE-09`（联动更新） | 默认 `echoCancellation: true, noiseSuppression: false, autoGainControl: true`；统一 `AsrEngine`（本地 + 外部双接口）；对话栏麦克风 `agent` 听写不自动发送 / `note` 录音笔记；五分区“设置 › 语音转录” | `passed` | `not-run`（[H-11](../../USER-ACTIONS.md#h-11)、[H-102](../../USER-ACTIONS.md#h-102)、[H-104](../../USER-ACTIONS.md#h-104)） |
| `VOICE-10` → `AT-174` 应用内听写的入口与插入 | `tests/shell/dictation-keys.test.ts`、`tests/shell/editable-target.test.ts`、`tests/shell/dictation-ui.test.tsx`；打包观察 `dictation-insert`、`dictation-revert` | `passed` | `not-run`（[H-104](../../USER-ACTIONS.md#h-104)、[H-105](../../USER-ACTIONS.md#h-105)、[H-110](../../USER-ACTIONS.md#h-110)） |
| `VOICE-11` → `AT-175` 采集前端：回声消除、降噪与媒体压低 | `tests/voice/asr-service.test.ts`、打包观察 `voice`（`audio-constraints`）、`scripts/voice-eval/run-eval.mjs` 五档开关对比 | `passed` | `not-run`（[H-108](../../USER-ACTIONS.md#h-108)） |
| `VOICE-12` → `AT-176` 去除静默与无效结果 | `tests/voice/silence-trimmer.test.ts`；打包观察 `dictation-insert`（全静音 `no_speech` 不插入、零请求） | `passed` | `not-run`（[H-104](../../USER-ACTIONS.md#h-104)） |
| `VOICE-13` → `AT-177` 识别引擎的能力描述与外部接口 | `tests/voice/asr-engine.test.ts`、`tests/agent/models-page.test.tsx`、`tests/voice/dictation-integration.test.ts`；打包观察 `dictation-insert` | `passed` | `not-run`（[ACT-21](../../USER-ACTIONS.md#act-21)、[H-107](../../USER-ACTIONS.md#h-107)） |
| `VOICE-14` → `AT-178`、`AT-179`、`AT-183` 本地模型的下载、校验与推理 | `tests/voice/model-downloader.test.ts`、`tests/voice/asr-service.test.ts`、`scripts/check-deps.mjs`；打包观察 `dictation-local`、`dictation-boundary`、`voice`（`local-capture`）；基准 `dictationLocalReleaseToTextMs = 389.4 ms` | `passed` | `not-run`（[H-106](../../USER-ACTIONS.md#h-106)） |
| `VOICE-15` → `AT-180` 词库的别名、读音与 Bangumi 补全 | `tests/library/schema-v16-migration.test.ts`、`tests/voice/dictionary-bangumi.test.ts`；打包观察 `migrated-profile`、`dictation-settings` | `passed` | `not-run`（[ACT-21](../../USER-ACTIONS.md#act-21)、[H-107](../../USER-ACTIONS.md#h-107)） |
| `VOICE-16` → `AT-181`、`AT-183` 音近纠错、润色与防过度纠错 | `tests/voice/phonetic-correct.test.ts`、`tests/voice/correction-eval-gate.test.ts`（`252` 对）、`tests/voice/polish-guards.test.ts`；打包观察 `dictation-revert`；基准 `dictationCorrectionMs = 0.63 ms` | `passed` | `not-run`（[H-107](../../USER-ACTIONS.md#h-107)、[H-110](../../USER-ACTIONS.md#h-110)） |
| `VOICE-17` → `AT-182` 恢复原文、听写记录与从修改中学词 | `tests/voice/dictation-history-learn.test.ts`、`tests/voice/dictation-integration.test.ts`；打包观察 `dictation-revert`、`dictation-settings`、`dictation-boundary` | `passed` | `not-run`（[H-109](../../USER-ACTIONS.md#h-109)、[H-110](../../USER-ACTIONS.md#h-110)、[H-111](../../USER-ACTIONS.md#h-111)） |

### 2.3 断言迁移核对（0 断言损失）

- **临时 N1 验证脚本 → 正式打包烟测与单测**：Wave 1 用于最早验证打包态 `utilityProcess` 的临时探针模块（覆盖 `asr-host.cjs` 派生、`sense-voice-funasr-nano-int8` 载入与识别、GTCRN `denoise` 长度不变与有限值、模拟崩溃后主进程存活并自动重拉起、空闲自动退出、主进程/轻量入口闭包与零随包 ASR 模型）已完整迁入正式打包烟测 `apps/desktop/src/main/smoke/dictation-walk.ts`（`dictation-local`、`dictation-boundary`）、单元契约 `tests/voice/asr-service.test.ts` 以及静态门禁 `scripts/check-deps.mjs`（`checkMainClosure` 与 `checkLightClosure`），断言只增不减。
- **既有 `voice.ts` 烟测扩展**：`apps/desktop/src/main/smoke/voice.ts`（`12 / 12` 步）完整保留原有紧凑录音悬浮框（`116×36` DIP、整数拖动记忆、无设备名、转写与时间线锚点）与录音笔记全部断言，新增 `audio-constraints`（核验 `echoCancellation: true, noiseSuppression: false, autoGainControl: true`）与 `local-capture`（使用本地模型 `sense-voice-funasr-nano-int8` 完成录音笔记采集转写，`cloudUploadsDelta: 0`）；对话栏麦克风在问答（`ask`）与笔记（`note`）双模式下的分流由 `dictation-walk.ts`（`dictation-insert`）核验。
- **既有测试套件**：全仓原有测试零删减、零放宽门槛；`bench.json` 原有 `63` 项基准门槛与样本数保持不变，新增 `2` 项听写门槛合计 `65` 项全部通过。

<a id="n1"></a>
## 3. N1 最小验证与本地推理子进程隔离

1. **进程形态与通信协议**：本地语音识别与 GTCRN 语音增强完全运行在 Electron `utilityProcess.fork` 派生的独立子进程 `resources/asr-host.cjs`（`serviceName: "MANGA speech"`）中，主进程 `AsrService`（`apps/desktop/src/main/asr-service.ts` + `asr-protocol.ts`）经 `MessageChannelMain`（`MessagePort`）发送结构化请求（`ping`、`load`、`transcribe`、`denoise`、`unload`、`status`、`shutdown`）。主进程、渲染进程与轻量窗口进程均不加载任何 ONNX 原生插件。
2. **打包解包与 Electron V8 内存笼兼容**：
   - `apps/desktop/forge.config.ts` 的 `stageUnpackedSpeechRuntime` 将 `sherpa-onnx-node@2.0.1` 与 `sherpa-onnx-win-x64@2.0.1`（内置 `onnxruntime.dll` `1.28.2`）解包至 `resources/app.asar.unpacked/node_modules/`，`asr-host.cjs` 通过自定义 `createRequire` 定位解包目录加载 N-API 原生绑定，无需 `@electron/rebuild` 重编 C++。
   - **关键实测发现（Electron 45 V8 Memory Cage）**：Electron 45 启用 V8 指针压缩与外部缓冲沙箱笼，`sherpa-onnx-node` 默认通过 `napi_create_external_arraybuffer` 返回音频样本会在 Electron `utilityProcess` 中触发致命错误。`apps/desktop/src/main/asr-host.ts` 在调用 `OfflineSpeechDenoiser.run(samples, sampleRate, false)` 及波形读取接口时显式传入 `enableExternalBuffer: false`，使原生层拷贝进受管 `ArrayBuffer`，打包态实测 `6.54 s` 语音 GTCRN 增强耗时 `355.61 ms`、输出采样数精确一致且零崩溃。
3. **故障隔离、空闲释放与干净退出**：
   - 子进程异常退出时主进程与窗口不受影响，当前请求立即以中文错误收敛，下一次听写自动重新拉起；若 `60 s` 内连续崩溃达 `2` 次则进入 `load_failed` 停止自动重启，直至用户重新选择模型或点击重试。
   - 默认闲置 `10 分钟`（`600,000 ms`，设置范围 `1..120` 分钟）无请求自动释放识别器并退出 `asr-host` 子进程；应用触发 `before-quit` 时同步关闭子进程，无残留进程。
4. **闭包与体积红线核验**：`scripts/check-deps.mjs` 的 `checkMainClosure`、`checkLightClosure` 与 `checkTree` 静态扫描确认主进程入口、轻量入口及 `@manga/app-core` 零引用 `sherpa-onnx-node` 或 `asr-host.ts`；打包观察 `dictation-boundary` 核验构建产物 `main.cjs`、`light-main.cjs`、`preload-light.cjs` 与轻量页面不含 `sherpa-onnx` 与 `asr-host` 字样，`full-main.cjs` 不含对 `sherpa-onnx-node` 的 `require` 或 `import`（它只按路径 fork `asr-host.cjs`），且安装包 `resources/` 除随包的 `gtcrn/gtcrn_simple.onnx`（`535,638` B）与 `gtcrn/LICENSE`（`1,069` B）外零本地 ASR 模型泄漏（`bundledModelLeaks: []`）。

<a id="models"></a>
## 4. 三个本地 ASR 模型的配置键名、热词设置与本机 CPU 实测

基于打包态 `Electron 45.1.0` `utilityProcess` + `sherpa-onnx-node@2.0.1`（CPU `numThreads = min(4, max(1, cpus - 1))`，`provider: "cpu"`）逐一完成三个官方 int8 模型的配置核对与本机实测（该开发机非参考机，用于验证功能闭环与量级）：

| 模型 ID | `OfflineRecognizer` 实测配置键与流级选项 | 热词能力 | 冷载入耗时 | 子进程常驻 / 峰值工作集 | 10 s 合成语音识别耗时（3 次中位数） |
| --- | --- | --- | --- | --- | --- |
| `qwen3-asr-0.6B-int8`（默认推荐） | `modelConfig.qwen3Asr = { convFrontend, encoder, decoder, tokenizer, hotwords: "" }`；每次请求 `stream.setOption("hotwords", csv)` | 支持（最多 `50` 词，逗号分隔；评测集 A 组配合音近纠错专名召回达 `100%`） | `2,458.0 ms`（评测批跑 `2,957.4 ms`） | 空载 `95.7 MiB` → 载入 `1,129.8 MiB`（增量 `+1,034.1 MiB`，推理峰值 `1,666.4 MiB`） | `1,404.8 ms`（`[1405.1, 1404.8, 1394.8]`） |
| `sense-voice-funasr-nano-int8`（极速轻量） | `modelConfig.senseVoice = { model, language: "auto", useInverseTextNormalization: 1 }`，`modelConfig.tokens`；`stream.setOption("use_itn", "1")` | 不支持（`hotwordsMax: 0`，CTC 结构无热词槽，专名完全走第 2 层确定性音近替换与第 3 层候选召回） | `858.5 ms`（门禁基准实测 `795.7 ms`，含派生 `835.0 ms`） | 空载 `98.6 MiB` → 载入 `426.3 MiB`（增量 `+327.7 MiB`，门禁工作集 `423.6 MiB` / 峰值 `453.1 MiB`） | `201.2 ms`（`[208.1, 201.2, 200.5]`；门禁 4 s 热态松键到出字 `p95 = 392.1 ms`） |
| `funasr-nano-int8`（中文/方言备选） | `modelConfig.funasrNano = { encoderAdaptor, llm, embedding, tokenizer, systemPrompt: "You are a helpful assistant.", userPrompt: "语音转写：", maxNewTokens: 512, temperature: 1e-6, topP: 0.8, seed: 42, itn: 1, hotwords: "" }`；每次请求 `stream.setOption("hotwords", csv)` 与 `stream.setOption("itn", "1")` | 支持（最多 `50` 词；实测显式开启 `itn: 1` 可稳定输出中文标点，默认 `0` 则无标点） | `3,658.0 ms`（评测批跑 `4,533.9 ms`） | 空载 `95.9 MiB` → 载入 `1,164.9 MiB`（增量 `+1,069.0 MiB`，推理峰值 `1,294.6 MiB`） | `1,944.9 ms`（`[1944.9, 1797.6, 1990.9]`） |

<a id="catalog"></a>
## 5. 本地模型目录、SHA-256 清单与 ModelScope 核验结论

### 5.1 固定目录与精确 SHA-256 清单（核对日期：`2026-11-13`）

所有本地模型均固定在 `packages/app-core/src/voice/models/catalog.ts`（ASR 模型存放于 `<应用数据根>\models\<id>\`）与 `scripts/tools/gtcrn.lock.json`（随包 `resources/gtcrn/`）：

1. **`qwen3-asr-0.6B-int8`**（Apache-2.0）
   - 下载地址：`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`
   - 归档大小与 SHA-256：`878,702,423` B / `393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96`
   - 必需内部文件校验：
     - `conv_frontend.onnx`：`44,148,281` B / `d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e`
     - `encoder.int8.onnx`：`182,491,662` B / `60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9`
     - `decoder.int8.onnx`：`755,914,231` B / `4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771`
     - `tokenizer/vocab.json`：`2,776,833` B / `ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910`
     - `tokenizer/merges.txt`：`1,671,853` B / `8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5`
     - `tokenizer/tokenizer_config.json`：`12,487` B / `4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c`
2. **`sense-voice-funasr-nano-int8`**（Apache-2.0）
   - 下载地址：`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17.tar.bz2`
   - 归档大小与 SHA-256：`187,693,225` B / `257936ea9a64cbe33200274e6367fc26d373ff6ca58b996b15108ffd6b9f6148`
   - 必需内部文件校验：
     - `model.int8.onnx`：`263,531,902` B / `9dc6e72aa8bc6f5966cf2857a0ce3a425b1d72e91500e147d66329f407c017a1`
     - `tokens.txt`：`939,815` B / `2db4bb25d046e8849e336c9465e248e1694914d996c58c71bdeca18cfb722992`
3. **`funasr-nano-int8`**（Apache-2.0）
   - 下载地址：`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2`
   - 归档大小与 SHA-256：`841,730,611` B / `eb43d7ccc2e86b243f6a03b7df361033dda66db9523d1a92bf6aca2b50c9476b`
   - 必需内部文件校验：
     - `encoder_adaptor.int8.onnx`：`238,277,200` B / `d0246c823f2c34133ae0efee395d8a189c8f92643e3432f866939ee34d34492c`
     - `llm.int8.onnx`：`600,339,316` B / `7f0c5a508b41474b1b1ec1cdbdefafd2cf8b3642c6915a0a425265b7b7d2c960`
     - `embedding.int8.onnx`：`155,583,106` B / `a05d2816e284fcca29a5dccb2c14b9edeb638fd983a84cd4a447248889b6a408`
     - `Qwen3-0.6B/vocab.json`：`2,776,833` B / `ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910`
     - `Qwen3-0.6B/merges.txt`：`1,671,853` B / `8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5`
     - `Qwen3-0.6B/tokenizer.json`：`11,422,654` B / `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4`
4. **随包 GTCRN 16 kHz 语音增强模型**（MIT，锁文件 `scripts/tools/gtcrn.lock.json`）
   - `gtcrn_simple.onnx`：`https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx`（`535,638` B / `e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534`）
   - `LICENSE`：`https://raw.githubusercontent.com/Xiaobin-Rong/gtcrn/502ebfab64da7c4a9af78dcb9c6ceef1ebb01c73/LICENSE`（`1,069` B / `c467165e5860b4a7494ef4a6e2788e4115d95b5b8989bb5f86287089adddf794`）

### 5.2 ModelScope 镜像核验与未收录依据（计划第 3 节）

`2026-11-13` 对官方维护者同源 ModelScope 仓库 `csukuangfj/asr-models` 逐一发起真实探测：

- `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`：HTTP `404`（未镜像上传）；
- `sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17.tar.bz2`：HTTP `404`（未镜像上传）；
- `sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2`：HTTP `200`/`206`（跳转至 `cdn-lfs-cn-1.modelscope.cn`，仓库提交 `aaa5ba79578cfa70554580e132d1d512649fbb1d`），实测归档体积为 `750,635,863` B、SHA-256 为 `c1e1bf4b31249e7f4b1af9c0e7682efa72aed939e04274cbc969ba3cb60a0c60`（旧版 `llm_prefill` + `llm_decode` 拆分权重构建），与 GitHub Release `checksum.txt` 公布的 `841,730,611` B 合并 `llm.int8.onnx` 归档（`eb43d7cc...`）不一致。

按计划第 3 节“仅当两边文件完全一致（同一 SHA-256）时才把两个地址都写进该模型的候选源”的安全规则，`catalog.ts` 当前只收录 GitHub Releases 官方源；下载器保留完整的 HTTPS 重定向主机白名单、`.part` HTTP `Range` 断点续传（正确处理 `206` 追加、`200` 重头覆盖与 `416` 恢复）、`%SystemRoot%\System32\tar.exe` 两步清单预检（`-tvf` 核验类型前缀、声明的解压总量不超过按模型推算的上限（必需文件总量 × 2 + 32 MiB、压缩包 × 4、64 MiB 三者取大）与条目数不超过 `2,000`，配合 `-tf` 纯路径列表规避中文 Windows `bsdtar 3.8.9` 月份 GBK 字节导致的误判，拒绝符号链接、硬链接、绝对路径与 `..`）及内部权重逐文件 SHA-256 核验，无法直连 GitHub 的环境可直接通过“从文件导入”（`asrModel.importFile`）走同一套离线校验启用。

<a id="shortcut"></a>
## 6. 右 `Alt`（`AltRight`）快捷键与输入法实测结论

- **Windows 原生菜单栏焦点拦截修复**：应用启动与建窗时执行 `Menu.setApplicationMenu(null)` 与 `window.removeMenu()`，消除 Windows 单独按下 `Alt` 键激活系统菜单栏抢走输入框光标与键盘事件的问题（界面顶部四个应用内自绘菜单不受影响）。
- **状态机与按键区分**：`use-dictation.ts` 与按键状态机精确匹配 `event.code === "AltRight"`（物理右 `Alt`）：
  - 按住达到 `250 ms`（`HOLD_THRESHOLD_MS`）才进入录音；短按 `< 250 ms` 静默忽略（零音频缓冲、零识别请求、零胶囊闪烁）；
  - `350 ms`（`DOUBLE_TAP_WINDOW_MS`）内快速双击进入免提锁定录音，再按一次结束并送识别；
  - 按住期间按下其他键组合（如 `Alt+Tab` 或编辑器快捷键）立即标记 `comboUsed` 并放弃本次触发；
  - `Esc` 立即取消当前听写、丢弃缓冲、不改输入框内容与选区；
  - 输入法组合输入期（`compositionstart` 至 `compositionend` 或 `keyCode === 229`）屏蔽快捷键触发与插入动作，不打断候选词上屏。
- **结论**：单元状态机与打包态真实 Electron 窗口（`dictation-insert`、`dictation-revert`、`dictation-local`）全部验证通过，**保留右 `Alt`（`RightAlt`）作为默认听写快捷键**，未回退至 `F7`；各品牌实体键盘与真实中文/日文输入法手感由 [H-105](../../USER-ACTIONS.md#h-105) 覆盖。

<a id="pipeline"></a>
## 7. Schema v16 迁移、词库补全、音近纠错、润色防线与隐私边界

1. **Schema v15 → v16 迁移**：
   - `dictionary_terms` 新增 `category`（`character` / `actor` / `work` / `term` / `other`）、`disabled`、`blocked_json`，同时保留原 `heard` 列确保旧资料包导入导出向前向后兼容，迁移时已有手写词条保持优先、不覆盖；
   - 新增 `dictionary_aliases`（级联外键）、`dictionary_suggestions`、`dictation_history`、`bangumi_details` 四张表及索引；
   - 迁移前自动生成 `premigrate` 一致备份，支持中断后重入恢复，旧版本遇到 `v17+` 明确拒绝打开（`tests/library/schema-v16-migration.test.ts`、打包观察 `migrated-profile` 与 `dictation-walk.ts`）。
2. **Bangumi 角色与人物别名顺序补全**：`packages/app-core/src/voice/dictionary.ts` 与 `packages/app-core/src/metadata/bangumi.ts` 对当前作品按主要角色优先顺序逐个请求 `/v0/characters/{id}` 与 `/v0/persons/{id}`（单作品上限 `60` 个请求、严格串行不并发洪泛），结果缓存在 `bangumi_details`；完整兼容 `infobox: null`、多个同名 `"简体中文名"` / `"别名"` 项、无子键 `{ v }` 数组元素，以及以 `"简体中文名"` 升为正名并将原日文 `name` 降为 `alias` 的归一化逻辑。
3. **发音规整与音近纠错（`HaujetZhao/asr-hotword` MIT TS 移植）**：`packages/app-core/src/voice/correct/` 基于 `HaujetZhao/asr-hotword`（提交 `7e282137e780ac4096cac537bef360235d2efe43`）移植 2-gram 增量倒排索引与音素编辑距离，修复上游同音不同调代价不对称缺陷（统一对称 `0.4` 声调代价）并扩展日文假名/罗马字对齐。相似度 `>= 0.9`（至少双音节/双假名且无同分冲突）直接确定性替换，`0.75–0.9` 召回最多 `15` 个候选供润色参考。在 `tests/fixtures/voice-correction.json`（由本阶段三个真实本地模型跑出的 `252` 对样本）上实测专名召回率 **`0.9521`**（门槛 `>= 0.85`，原始 ASR 仅 `0.1470`）、非实体近音句误改率 **`0.0000`**（门槛 `<= 1%`）。
4. **LLM 三档润色、四道防线与简繁保护**：支持 `off`（原文）、`light`（默认轻度）与 `formal`（书面）三档及自定义提示词；强制执行四道防线（`temperature: 0.1` 且不支持该参数的模型自动去掉重试、`5 s` `AbortSignal` 超时回退第 2 层文本、输出长度比越出 `[0.4, 1.4]` 丢弃回退、引入原文与候选表均不存在的新词库实体时拦截回退）；`opencc-js` 在主进程惰性初始化，转换前切分并保护个人词典正名区间不被简繁二次改写。
5. **听写记录、60 秒学词与隐私隔离**：
   - 听写文本记录本机最多保留 `30 天`；可选音频保留 `24 小时`（位于 `<应用数据根>\dictation-audio\`，启动与定时清理过期文件并支持换引擎 `dictation.retranscribe`）；
   - 插入后 `60 s` 内用户在同处手动改词将生成词条建议（内联胶囊与设置页均可一键确认入库或永久忽略）；
   - `copyForBackup` 在生成 `premigrate` 与 `preupdate` 备份时删除 `dictation_history` 与 `agent_requests` 并执行 `VACUUM` 擦除空闲页，资料包与项目包导出同样不含这两张表；
   - `dictation.*`、`asrModel.*`、`dictionary.suggestions.*` 全部列入 `OWNER_COMMANDS`，Agent 工具列表、全文检索与材料上下文均完全不可见（`dictation-boundary` 实测验证）。

<a id="eval"></a>
## 8. 离线评测集（`scripts/voice-eval`）与采集前端开关对比

### 8.1 240 条合成评测集三模型实测（计划第 6 节）

评测集由 `80` 条虚构二次元测试句（A 组 `40` 条含中文/日文译名/声优专名、B 组 `20` 条含语气词与句中自我改口、C 组 `20` 条不含任何专名的近音干扰句，配 `40` 个词典词条）经 Windows SAPI 合成 `clean`、风扇稳态噪声 `fan10db`、旁人说话干扰 `speech10db` 三组共 `240` 个 16 kHz 单声道 WAV（净语音时长 `410.07 s`）。未开启在线文本连接（`llmPolishStatus: "not-run"`），以下为三个本地模型在离线门禁下的完整对比：

| 模型 | 管线层级 | 总体 CER | 专名召回率（命中 / 总计） | C 组近音误改率 | 单句延迟 p95 |
| --- | --- | --- | --- | --- | --- |
| `sense-voice-funasr-nano-int8` | 仅原始 ASR（`asr_only`） | `16.73%` | `10.78%`（`33 / 306`） | `0.00%` | `291.47 ms` |
| `sense-voice-funasr-nano-int8` | ASR + 音近确定性纠错（`asr_plus_correct`） | **`6.42%`** | **`91.83%`**（`281 / 306`，直接替换 `87.58%`） | **`0.00%`**（`0 / 60`） | `0.13 ms`（仅纠错层） |
| `qwen3-asr-0.6B-int8` | 仅原始 ASR（`asr_only`） | `17.43%` | `15.69%`（`48 / 306`） | `0.00%` | `3,272.87 ms` |
| `qwen3-asr-0.6B-int8` | ASR + 音近确定性纠错（`asr_plus_correct`） | **`8.66%`**（`clean` `3.24%`） | **`92.48%`**（`283 / 306`，`clean` `98.04%`；A 组叠加热词达 **`100%`** `70/70`） | **`0.00%`**（`0 / 60`） | `0.12 ms`（仅纠错层） |
| `funasr-nano-int8` | 仅原始 ASR（`asr_only`） | `13.29%` | `16.99%`（`52 / 306`） | `0.00%` | `1,938.52 ms` |
| `funasr-nano-int8` | ASR + 音近确定性纠错（`asr_plus_correct`） | **`4.54%`**（`clean` `2.40%`） | **`94.44%`**（`289 / 306`，A 组叠加热词 CER **`2.26%`** / 召回 **`97.14%`**） | **`0.00%`**（`0 / 60`） | `0.12 ms`（仅纠错层） |

### 8.2 采集前端开关五档对比与默认值核定（计划第 4.2 节）

在 `sense-voice-funasr-nano-int8` + 音近纠错管线上对五种采集前端配置跨四种声学条件（`clean`、`fan10db`、`speech10db`、小音量 `quietClean`）逐一跑完对比（记录于 `bench.json` 的 `records.voice.evaluation.switchComparison`）：

| 配置档位 | `clean` CER / 专名召回 | `fan10db` CER / 专名召回 | `speech10db` CER / 专名召回 | `quietClean` CER / 专名召回 | C 组误改率 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `capture_default`（`browserNS=off, AGC=on, GTCRN=off`，当前默认） | `4.74%` / `92.16%` | `5.52%` / `93.14%` | **`8.58%`** / **`92.16%`** | `4.92%` / `92.16%` | `0.00%` | 各条件最均衡，旁人干扰下最稳 |
| `browser_ns_on`（`browserNS=on, AGC=on, GTCRN=off`） | `4.86%` / `92.16%` | `5.52%` / `94.12%` | `9.72%` / **`88.24%`** | `4.92%` / `93.14%` | `0.00%` | 强谱减压伤辅音，`speech10db` 专名召回下降 `3.92` 个百分点 |
| `agc_off`（`browserNS=off, AGC=off, GTCRN=off`） | `4.80%` / `92.16%` | `5.52%` / `93.14%` | `8.94%` / `90.20%` | `4.92%` / `92.16%` | `0.00%` | 弱音细节略逊于开启自动增益 |
| `gtcrn_mix_075`（`browserNS=off, AGC=on, GTCRN=0.75*wet+0.25*dry`） | **`4.62%`** / **`94.12%`** | `5.76%` / `93.14%` | `10.32%` / `90.20%` | `5.16%` / `93.14%` | `0.00%` | 干净与稳态风扇环境专名召回最高，相比 `100%` 湿信号显著避免过抑制 |
| `gtcrn_full_100`（`browserNS=off, AGC=on, GTCRN=1.0*wet`） | `5.10%` / `94.12%` | `7.44%` / `94.12%` | **`16.63%`** / **`79.41%`** | `5.28%` / `93.14%` | `0.00%` | 纯湿信号严重损伤人声与专名音素，不采用 |

**核定结论**：实测数据完全印证计划 4.2 节与 A-131 的判断——保持默认 `echoCancellation: true`、`browserNoiseSuppression: false`、`autoGainControl: true`、`gtcrnDenoise: false`，并将可选“环境降噪（GTCRN）”固定采用 `0.75 * enhanced + 0.25 * raw` 干湿回混，无需修改默认值。

<a id="gate"></a>
## 9. 阶段门禁、基准数值与源码指纹

### 9.1 全链路 `stage gate` 每步结果与耗时

- **环境**：Windows 11 `win32 x64`、Node `v26.12.1`、Electron `45.1.0`。
- **哪一次**：下表是阶段内追加（[第 12 节](#stage-additions)）后在最终源码上的整套门禁，`2026-11-14` 完成，`package.passStreak` 已改为 2。
- **之前各次**：B 交付时的一次 `2,373 s`；2026-11-13 追加后的一次 `passStreak 3`。
- **两次运行的关系**：
  - 2026-11-14 第一次运行到第二次 `package` 时失败：`agent-media-native` 的“查看发送记录”按钮在合成点击前被虚拟列表移出页面。
  - 修复窗口观察后，第二次运行沿用了仍然有效的 `test`、`installer`、`bench` 结果，其余步骤重跑并通过。

| 门禁步骤 | 状态 | 耗时 | 覆盖与关键结果 |
| --- | --- | --- | --- |
| `verify` | `passed` | `34 s` | `tsc --noEmit`、`knip`、`check-docs.mjs`、`check-tool-links.mjs --pins`、`check-publication.mjs`、`check-workflows.mjs`、`check-deps.mjs`、`findUncommentedSmokeSleeps` |
| `test` | `passed` | `105 s`（第一次运行，第二次沿用） | Vitest 共 `3,047` 项：`3,037 passed`、`0 failed`、`10 skipped`（仅已知前置跳项）；`cases.json` `217 / 217 passed`；`tempDirs.left = 0` |
| `package`（连续 2 次） | `passed` | `489 s / 440 s` | `passStreak: 2`；`scenarios.json` `185 / 185 passed`；第二次沿用同一构建与安装包 |
| `installer` | `passed` | `453 s`（第一次运行，第二次沿用；原来约 `535 s`） | `38 / 38` 步全绿。4 个测试身份安装包同时打出，共 `162 s`（原来逐个约 `4 × 52 s`）；其余同上一次：双通道安装、并存、覆盖、卸载，“打开方式”注册，`update-rollback`，真实 `electron-updater` 整包与差分下载验签及 NSIS 升级演练，真实安装快照前后一致 |
| `bench` | `passed` | `560 s`（第一次运行，第二次沿用） | **`65 / 65` 项性能门槛全部达标**；最慢分段：工作区 `145.5 s`、扫描与停靠栏 `107.4 s`、阅读器 `74.5 s`、规模窗口 `69 s`、对话 `33.3 s` |
| `report` | `passed` | `< 1 s` | `automationStatus: "self-check-passed"`，`errors: []`，`productAcceptance: "not-run"` |
| `install-dev`（不是门禁步骤） | `passed` | `16 s` | 门禁通过后、请用户人工检查前单独执行：本机 `MANGA Dev` 从 `0.1.2-dev.202611131511` 静默更新至 `0.1.2-dev.202611131924`（`releaseUntouched: true`，更新前未运行） |

### 9.2 新增听写基准与关键对照指标（[`docs/evidence/gate/bench.json`](../evidence/gate/bench.json)）

| 指标 | 实测结果 | 门槛 | 测量口径与记录值 |
| --- | --- | --- | --- |
| `dictationLocalReleaseToTextMs` | **`442.7 ms`** | ≤ `1500 ms` | 打包窗口已载入本地极速模型 `sense-voice-funasr-nano-int8` 热态下，约 `4 s` 合成语音从松开右 `Alt` 到编辑框文字出现（B 交付时 `p95 = 392.1 ms`，A 重跑 `389.4 ms`） |
| `dictationCorrectionMs` | **`0.76 ms`** | ≤ `30 ms` | `10,000` 个词典词条（含拼音与假名读音）对一段约 `200` 字中文的 2-gram 音近召回与确定性替换 `p95`（50 次运行） |
| 记录项：`migrationV14`（v13 → v16 连续迁移） | `63.4 ms` | 记录项 | 100 次运行（含 `premigrate` 备份及 v14—v16 的表与视图变化） |
| 其余 63 项既有性能门槛 | 全部在目标内 | 见[执行状态验证基线](status.md) | 检索 `0.78 ms`、冷启动 `61.1 ms`、规模冷启动 `649 ms`、扫描事件循环 `p99 = 45.9 ms`、白板打开 `34.1 ms`、导图折叠 `48.4 ms`、四宫格晚到帧 `0%`、对话打开 `61.4 ms`、轻量视频首帧 `463 ms`、轻量漫画首页 `302 ms` |

### 9.3 最终源码与证据指纹（[`docs/evidence/gate/report.json`](../evidence/gate/report.json)）

- 阶段分支：`feat/m12-voice-dictation`（基于 `main@3b9d498`，全部本阶段变更收敛为单个带 `Signed-off-by` DCO 签名的阶段提交）。下列指纹来自阶段内追加后在最终源码上的整套门禁（2026-11-14）。之后只加了不在指纹范围内的 `scripts/quick-gate.mjs` 与文档。
- `sourceFingerprint`: `5e200d35cdf0098a4bcc45afa16dfd0a2c79948a7cbe43293a555f2cde4174c2`
- `smokeScriptFingerprint`: `b2c8e77be997469010ec989d106cb874f233023dcfec344114f7b4e51b4455dc`
- `smokeChecksScriptFingerprint`: `c1c2ca8355f5436eaea59f327db57acd6a3419b757d63496efc9cba9abc2023f`
- `smokeBenchScriptFingerprint`: `c7277cf4a5547e093413e230654d58262c5cbe67302569e4ba1d469b884f892c`
- `smokeWalkScriptFingerprint`: `35f236c7c11de47ca86e6c106e61e9bed48c281e54ad613ebbee15a5258575f4`
- `lockFingerprint`: `f66f660c5687fac3a2e0305de6149de2a874d456b2c452a41204271501f8a951`
- `buildScriptFingerprint`: `8d89734043d4054648698ec4d01802964ff9a3f30a08114a4ed7362a59af5cda`
- `gateScriptFingerprint`: `b5b8efb0fa24dc6fbb91e3abab596c2964b11ac511ce8d5f0a9de73efc1febd4`
- `testScriptFingerprint`: `6c4bfbbfd2e16cc5a7680f6239b21cc21eeccffd99cda43bf51df861e2c85212`
- `packageScriptFingerprint`: `681cc0f80c931e687b1419b5a5ca82233cb05e5b2f2135ce2f4baa6f2ffd1ca6`
- `benchScriptFingerprint`: `61ced7ba4b65523a5727540ddb0b417d7f8ac367dfa99e64736b83e9960804ec`
- `installerScriptFingerprint`: `e71dac1ced8d95d9c7c00cc8eb5eea061836c9553a34650d7695b69e29f23a09`
- `releaseScriptFingerprint`: `305a24bbbd8a8a61ccb9da3d626c5db276597fd63f64ad941bbeab1fed19ccab`

<a id="next-step"></a>
## 10. 已知限制、待用户事项与首选下一步

### 10.1 已知限制与后续登记

- **产品验收与真实外部调用未执行**：`productAcceptance` 保持 `not-run`；真实麦克风、实体右 `Alt` 与系统级输入法、真实外网模型下载体验、Windows 应用回声消除等留给用户待办 [H-104](../../USER-ACTIONS.md#h-104)—[H-111](../../USER-ACTIONS.md#h-111)；Bangumi 角色/人物详情与外部转录 / `input_audio` 连接的真实在线契约留给可选授权 [ACT-21](../../USER-ACTIONS.md#act-21)（`not-run`）；评测集的在线 LLM 润色对比（`MANGA_LIVE_VOICE_EVAL_LLM=1`）默认不联网，记为 `not-run`。
- **本阶段明确不做的后续项（已登记于[执行状态后续 loop](status.md#followup-loops)）**：跨应用全局听写（[LOOP-36](status.md#loop-36)）、边说边出字流式识别与私有协议适配器（[LOOP-37](status.md#loop-37)）、应用内本地大语言模型润色（[LOOP-38](status.md#loop-38)）、Bangumi 全量离线词表与无假名日文汉字自动注音（[LOOP-39](status.md#loop-39)）、选中文字说语音指令改写（[LOOP-40](status.md#loop-40)）。

### 10.2 首选可执行下一步：请用户授权 push、PR 与 squash 合并

- **阶段判断**：B 自检的必需用例与门禁全部通过，A 集中审查已收敛（[第 11 节](#a-review)），修复后在最终源码上重跑的完整 `stage gate` 通过。按计划第 1 节，Agent 侧已完成。
- **首选动作**：按用户 2026-11-14 的授权执行 [ACT-22](../../USER-ACTIONS.md#act-22)：push 阶段分支、创建到 `main` 的 PR、CI 通过后 squash 合并并清理分支。
- **不是前提的事项**：[Q-40](../../USER-ACTIONS.md#q-40) 的答复、可选的 [ACT-21](../../USER-ACTIONS.md#act-21) 与人工检查 [H-104](../../USER-ACTIONS.md#h-104)—[H-111](../../USER-ACTIONS.md#h-111) 都不阻塞合并（A-53），`productAcceptance` 保持 `not-run`。

<a id="a-review"></a>
## 11. A 集中审查（2026-11-13）

依据 `AGENTS.md`、`REVIEW.md` 与计划第 1、4、5、7、9 节逐项复核代码、测试与门禁证据。B 交付时的证据指纹（`sourceFingerprint` `34b5d838…`）与审查开始时的 `HEAD` 全部一致。

### 11.1 复核通过的项

| 审查项 | 核对方式与结论 |
| --- | --- |
| 音频只发往所选的一个引擎；Agent 碰不到听写 | `AsrEngine` 按所选引擎发送，失败直接报错，不换服务；润色连接取不到时按原文处理，不换文本连接。`dictation.*`、`asrModel.*`、`dictionary.suggestions.*`、`dictionary.observeEdit` 只在 `OWNER_COMMANDS`，`AGENT_COMMANDS` 是白名单且不含它们；听写不写操作日志的正文。**发现一处缺口，已修复（11.2 第 1 项）** |
| 推理进程隔离 | `asr-host.ts` 只由 `utilityProcess.fork` 运行；`check-deps.mjs` 的 `checkMainClosure`（从 `src/main/index.ts` 沿相对、`@manga/*` 与 `require` 追踪）与 `checkLightClosure` 都禁止 `sherpa-onnx*` 与 `asr-host`，自测覆盖；打包观察 `dictation-boundary` 再查构建产物与安装包（`bundledModelLeaks: []`）。GTCRN 的 `run` 传 `enableExternalBuffer: false`；崩溃记账、1 分钟两次标为载入失败与闲置卸载有单测与打包观察 |
| 模型下载 | `asrModel.download` 的输入要求 `confirmed: true`，服务与下载器各再检查一次；每一跳重定向都过 HTTPS 与主机允许列表（拒绝凭据、IP 字面量与回环）；Range 续传前重算已有部分的哈希，ETag 或 `Content-Range` 不符、`416` 时从头下载；超过目录声明的大小立即失败；`tar.exe` 只按 `%SystemRoot%` 的绝对路径调用、环境变量最小化，先 `-tvf` 拒绝链接与特殊条目并累计声明大小，再 `-tf` 拒绝绝对路径、盘符、`..`、保留设备名与大小写冲突；压缩包与每个必需文件都核对大小与 SHA-256；任何失败都清空该模型的暂存。ModelScope 只有 funasr-nano 一个文件，且哈希与 GitHub 不同，按计划不收，结论成立 |
| Schema v16 | 迁移在单事务内，`ALTER TABLE` 前查列，可重入；迁移前备份 `premigrate-v15`，旧版遇到 v17 拒绝打开；旧 `heard` 回填为 heard 别名、类别按来源推出，用例核对行数不少、手写优先不变 |
| Bangumi 补全 | 按主角、配角、声优排序去重，串行，每部作品按传输层计数不超过 60 次；`infobox` 为 null、同名键多次、别名项没有 `k` 三种边界都有用例。限制：最后一个请求遇到 429 时，客户端已有的退避重试（最多 2 次）可能让该作品多出 1—2 次请求，随后整个任务报错停止，记在 11.3 |
| 去除静默 | 首段前与末段后各留 300 ms；≤ 1 s 的停顿原样保留；更长的停顿两侧各留 200 ms、合计 400 ms；8 ms 渐变只落在静音余量里，不会切到字头字尾；整段无声为 `no_speech` 且不送识别 |
| 音近纠错与样本集 | 阈值是有用例的常量（直接替换 0.9、候选 0.75、候选最多 15 个）；上游提交 `7e28213`（2026-06-10）在 GitHub 上存在，文件头保留 MIT 许可与来源。样本集 252 对里 218 对标为模型输出，A 在本机评测缓存 `dist/samples/voice-eval/asr-cache.json` 里逐条找到了相同文字；全量 720 条评测（三模型 × 三声学条件）的召回率为 91.8%—94.4%，误改率 0，与样本集的结果一致，看不出为通过门槛挑样本 |
| 润色四道防线与简繁 | 跳过条件、只带候选的提示、温度 0.1（不支持时去掉重试）、5 s 超时、长度比 0.4—1.4、新出现的词条、拉丁字母与片假名词都会退回替换后的文字并记原因；OpenCC 转换前用私用区占位保护词条写法 |
| 备份与资料包 | `premigrate` 与 `preupdate` 都经 `copyForBackup` 删除 `agent_requests` 与 `dictation_history` 后 `VACUUM`；资料包与项目包不导出听写记录、建议词与 Bangumi 详情缓存。**备份的取快照方式已改（11.2 第 2 项）** |
| 既有行为与基准 | 录音笔记的提示复述处理与以前一致（识别结果只复述提示时按 `prompt-echo` 重试不带提示）；既有 63 项基准的门槛、样本数与测量方法未改，只新增两项；`gate.json` 只删了一个已不存在的截图名并补了新观察；全部既有观察保留并通过 |

### 11.2 A 的修复（已并入阶段提交）

1. **“自动选择”时载入失败的本地模型会被跳过，音频改发外部连接（隐私）**：听写引擎为“自动选择”（默认）时，`resolveDictationEngine` 只挑 `ready` 或 `installed` 的本地模型；已装模型处于 `loading` 或 `load_failed` 时会落到第一个转录连接，音频在用户没有选择的情况下离开本机，与“所选引擎不可用时不换服务”和界面文案“优先已安装的本地模型”都不符。改为已装的本地模型（`ready`、`loading`、`installed`、`load_failed` 依次）总是优先，载入失败时说明原因，不发给连接（`packages/app-core/src/product-app.ts`）。`tests/voice/dictation-integration.test.ts` 的 AT-177 用例新增断言：自动选择加载入失败时 `dictation.start` 报 `model_load_failed`，转录与对话接口收到 0 个请求；去掉修复时该断言失败（原先返回 `ok`，音频发给了转录连接）。
2. **备份不再把整个资料库读进内存**：B 把 `premigrate` 备份从“检查点后复制文件”改成了 `sqlite.serialize()`（`preupdate` 原本就是），大资料库升级时主进程要多占一份整库大小的内存。改为 `VACUUM INTO`：同样包含已提交的 WAL 页，逐页写盘（`packages/storage-drizzle/src/store.ts`）；`tests/update/update-service.test.ts` 注入备份失败的位置相应改为 `copyForBackup`。
3. **偶发的 `dictation-local` 观察**：A 第一次重跑门禁时，“结束推理进程后再听写”的一步失败了一次（单独复跑 3 次都通过，B 的 3 次也都通过），根因无法从现场确定。走查改为等主进程确认进程已退出再开始下一次听写（最多 5 s，替代固定的 200 ms），并在失败时记下第二次按键是否开始、输入框字数与胶囊文字，以便下次定位；没有加重试。修复后的完整门禁里三次打包都通过（`exitObserved: true`、`respawnStarted: true`）。
4. **文档与配置的更正**：报告与 ADR-0007 里五个新依赖的发行日期按 npm 注册表改正（`sherpa-onnx-node` 与 `sherpa-onnx-win-x64` 2.0.1 为 2026-10-26，`pinyin-pro` 3.29.5 为 2026-10-10，`wanakana` 5.3.1 为 2023-11-20，`opencc-js` 1.4.2 为 2026-08-22，都已满 14 天）；报告里解压的上限（实为按模型推算的上限与 2,000 个条目，不是“4 GiB / 256”）、词条类别名（`actor` / `other`）、`full-main.cjs` 的检查口径与 `l1-combining-marks` 目录的来由（测试每次重新生成）按代码改正；`knip.json` 去掉三个已被实际引用、不需要忽略的依赖。

修复后：受影响的测试子集通过（语音、v16 迁移与命令登记 37 个文件 323 项；备份、迁移与更新 15 个文件 138 项）；`node scripts/verify.mjs --skip-tests` 通过；完整 `stage gate` 在最终源码上通过（第 9 节），证据整体替换了 `docs/evidence/gate/`（28 个文件，3.33 MiB）。

### 11.3 遗留限制（不阻塞合并）

- Bangumi 补全遇到 429 时，客户端已有的退避重试可能让一部作品多出最多 2 次请求，随后任务停止并提示稍后再试；如果要严格按“每部作品 60 次”计数，需要把剩余预算传进客户端的重试，登记为 [LOOP-41](status.md#loop-41)。
- 模型下载只给每次连接设了 30 s 的建立超时，数据流中途停住时不会自己超时，用户可以暂停或取消；计划没有要求，登记为 [LOOP-42](status.md#loop-42)。
- `dictation-local` 第一次偶发失败的根因未确定，已加诊断字段；再出现时按证据里的字段判断是没开始、失败还是没听到声音。

<a id="stage-additions"></a>
## 12. 阶段内追加（用户 2026-11-13、11-14 要求，已并入阶段提交）

A 审查收敛后，用户在同一阶段内追加了以下要求；它们不改变听写功能，按 Git 规则 amend 进本阶段提交，并在最终源码上重跑完整门禁（第 9 节）。

| 要求 | 实现位置 | 验证 |
| --- | --- | --- |
| **安装快捷方式**：静默安装（无人参与）首次安装时两个通道都创建桌面与开始菜单快捷方式；覆盖安装或自动更新时正式版不新建，开发版每次重新创建桌面快捷方式（提示有新版本）、不新建开始菜单快捷方式；有人参与的安装在向导里两项都可选 | `scripts/stage/installer-lib.mjs` 的 `shortcutsNsis`（NSIS 自定义页与 `customInit` / `customInstall` / `customUnInstall`，`createDesktopShortcut` 与 `createStartMenuShortcut` 关闭，由 include 自己创建与删除）；`checkInstallerConfig` 核对 | `tests/runtime/installer-config.test.ts`；`stage installer` 首装两项都在、正式版覆盖安装保留开始菜单且不重建已删的桌面快捷方式、开发版覆盖安装重建桌面且不建开始菜单；另用会删除快捷方式的旧卸载程序做过一次升级，快捷方式被恢复 |
| **应用图标**：正式版与开发版都是深灰底 `#3C4043` 白色 “M”（字母高度 250–780、笔画 110，按 1024 单位），开发版另加右下角琥珀色 “DEV” 角标、一眼区分（2026-11-14 再次调整）。用户指出小尺寸下角标粗细不一后，`generateAppIcons` 改为先把 SVG 渲染成 1024 像素，再按面积平均缩成 512 与 16—256 各尺寸，不再用 `sharp` 的 lanczos3 直接缩小 | `apps/desktop/assets/icon-dev.svg/.png/.ico`；`installer-lib.mjs` 的 `channelIcons` 用于安装包、卸载项、可执行文件与 `resources/icon.*`，并同步 `assets.manifest.json` 里两个图标的大小与哈希（否则启动自检报“安装不完整”，`stage installer` 的开发版首次启动发现并已修复）；源码运行时窗口按通道取图标 | `installer-config.test.ts` 新用例（含 `averageDown` 的面积平均）；`stage installer` 两通道“可执行文件与窗口用本通道的图标”；`stage package` 的安装信息观察核对开发版图标的尺寸 |
| **开发版安装时机**：每次需要用户人工检查时由 Agent 自动安装（B 交付整个阶段、A 审查修复或返工后、按用户反馈修复后请用户复查），用户不用自己装；小功能做完、只为自动验证的打包与门禁不装（2026-11-14 用户纠正） | `scripts/stage/package.mjs` 与 `gate.mjs` 不再调用 `install-dev`；[开发流程](../dev-rules/development-workflow.md#dev-install-at-handoff)、[质量门禁](../dev-rules/quality-gates.md)、[Q-38](../../USER-ACTIONS.md#q-38) 第 3 项与 DATA-07 同步 | 门禁运行中本机开发版未被改动；门禁通过后单独执行 `stage install-dev` 一次（第 9.1 节） |
| **烟测窗口不受真实鼠标干扰**（修复 `workspace-restart`、`frame-resize` 偶发失败）：观察窗口显示后，人手移动鼠标经过窗口会混进合成的拖动与点击 | `apps/desktop/src/main/index.ts`、`light/main.ts` 在 `--manga-smoke` 时 `setIgnoreMouseEvents(true)` | 诊断时指针落在显示中的烟测窗口内的采样占 `770 / 859`；修复后 `stage package` 单独 1 次与门禁内 2 次全部通过 |
| **门禁提速**（2026-11-14 用户要求） | `scripts/stage/installer.mjs` 一开始同时打出 4 个测试身份安装包（两个通道、`0.1.2` 升级包、更新演练的下一个开发版，各用自己的工作目录）；`gate.json` 的 `package.passStreak` 从 3 改为 2 | `installer` `535 s → 453 s`（打包 `4 × 52 s → 162 s`）；第三次 `package` 每次约 7 分钟，不再跑 |
| **两级门禁**（2026-11-14 用户决定）：整套 `stage gate` 只在 B 交付整个阶段时跑一次，其余修改都只跑约 5 分钟内的快速门禁 | 新增 `scripts/quick-gate.mjs`：`verify --skip-tests`、与改动文件相关的 Vitest、`--phases` 点名的打包烟测阶段，超过 300 秒提示；[质量门禁](../dev-rules/quality-gates.md#gate-tiers)、[开发流程](../dev-rules/development-workflow.md#gate-tiers)、仓库地图与 README 同步 | 在本阶段工作树上实测：不点阶段 `81 s`，点 `loop` 阶段（沿用现有构建）`125 s` |
| **窗口观察偶发失败**：2026-11-14 第一次门禁的第二次 `package` 中，`agent-media-native` 找到“查看发送记录”按钮后，对话记录又自己滚向最新消息，虚拟列表把那一行移出页面，合成点击落空 | `apps/desktop/src/main/smoke/loop-media.ts` 的 `openTraceStep`：没点到时重新滚回那条运行再点，最多 3 次，像人一样操作 | 先单独跑 `loop` 阶段通过（13 / 13），再跑整套门禁通过（第 9.1 节） |

人工检查：[H-84](../../USER-ACTIONS.md#h-84)、[H-85](../../USER-ACTIONS.md#h-85) 已写明新的快捷方式规则；开发版图标在 H-84 的安装界面与桌面快捷方式上即可看到。
