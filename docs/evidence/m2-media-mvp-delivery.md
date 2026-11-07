# M2 交付报告：小说、漫画、动漫与语音定位

本报告是 [M2 全阶段计划](../delivery/m2-media-mvp-plan.md)第 10 节要求的唯一交付报告，按“任务/需求 → 实现位置 → 验证证据 → 状态与限制”映射。它记录 B 的自检结果，**不计算产品验收**：所有 AT 的产品验收均为 not-run，下文的 passed 只表示该自动化子场景在本提交上通过。第 1—13 节是人工试用返工（W1—W10）完成后的事实；第 14、15 节是 A 的审查与试用发现记录，保持原文；返工的逐项交付见[第 16 节](#16-返工交付2026-10-06)；A 对返工的复核、复核中的直接修复与重跑后的证据见[第 17 节](#17-a-复核返工2026-10-06)，第 1—13 节的数字与状态已按复核后的证据更新。阶段提交的 SHA 以交付回复和 `git log -1` 为准（提交内容不能包含自己的 SHA）。

## 1. 结论

> 2026-10-06：用户试用 `e09802f` 后的反馈使 M2 进入返工，发现见[第 15 节](#15-人工试用反馈与返工发现2026-10-06)，计划见[计划第 14 节](../delivery/m2-media-mvp-plan.md#14-人工反馈返工2026-10-06)。B 已一次完成 W1—W10；A 复核后直接修复了复核中发现的局部缺陷，并在修复后的代码上重跑 `test`、`bench`、`package`、`report` 四份证据（[第 17 节](#17-a-复核返工2026-10-06)）；下表是复核后的结果，W 逐项映射在[第 16 节](#16-返工交付2026-10-06)。第 14 节“无返工”的结论已被第 15 节取代。

| 项目 | 结果 |
| --- | --- |
| 范围 | C0—C6、U1、P0—P9、R1—R4、L1 与返工 W1—W10 全部实施；无工作包整体 blocked |
| 基线 | `main@5504c97`（M1b 已合并）；本阶段是同一分支上的一个提交：A 的计划提交 `8e2ac3f` 与 B 的返工提交 `fab27be` 已按 A-21 合并为一个阶段提交（返工前的阶段提交 `a5c90e1`），A 的复核修复 amend 进同一提交；推送后 F-37、F-38 的修复是 [PR #4](https://github.com/chialecode/manga/pull/4) 上的追加提交（已推送的提交不改写），squash 合并后在 main 上仍是一个提交 |
| 自动化（`stage m2 test`） | 必需用例 81/81 passed（原 54 个不删、不减，返工新增 27 个：R-01—R-21 与 AT-63—68；A 复核新增的 8 个用例并入 AT-10、AT-23、AT-64、R-02、R-14 等已有用例的匹配）；Vitest 1192 个用例：1185 passed、0 failed、7 skipped（7 个是默认关闭的真实模型探针 4 个、ASR 契约、Bangumi 契约、真实库只读试验各 1 个，见第 9、11 节；两个大文件用例由阶段入口以 `MANGA_LARGE_FILES=1` 开启，所以 `verify.mjs` 里显示 9 个 skipped） |
| 打包烟测（`stage m2 package`） | passed：Electron 44.5.1 未签名本地包，不访问外网（录音阶段用本机回环的假 ASR 服务），11 个阶段（initial、restart、agent、agent-restart、reading、closure、closure-restart、formats、media、voice、rework）；返工阶段 `rework` 在全新 Profile 上走过 21 个窗口观察（`scenarios.json`，含漫画 3 种窗口 × 3 种适配的页面尺寸、播放器与小说页控件在宽/窄/矮窗的可达性、悬浮胶囊及其展开的笔记框不遮挡控件——复核后加入框选提示条上的按钮，并在每个控件中心做命中测试），formats 阶段断言 LOOP-06 的单次绘制；缺资产时启动即报错的负例也通过 |
| 基准（`stage m2 bench`） | passed（19 项门槛全部在目标内，新增 5000 文件后台扫描的主进程事件循环延迟 p99 15.6 ms 与常用操作答复 p95 7.9 ms，目标均 ≤ 100 ms；30 MiB EPUB 末尾可见 p95 944.1 ms。复核中有一次运行的重负载项整体慢约 2 倍、EPUB 末尾达到 1960.8 ms，差异来自机器状态，见第 8 节与 17.5）；另有扫描吞吐、封面读取与 1000 条消息右栏的记录项；原始数据见第 8 节 |
| 报告门禁（`stage m2 report`） | 退出码 0（`errors: []`、`automationStatus: self-check-passed`、`engineeringReviewable: true`）；`productAcceptance` 恒为 not-run |
| CI（PR 的 `repository-quality`） | 首次运行失败（F-37：Linux runner 缺少 Windows 媒体前置）；第二次只剩一个依赖字体的断言失败（F-38）。两项都修复后在 PR 上重跑，结果以 PR 检查为准，通过后才合并。CI 跳过需要这些前置的 138 个用例，它们由本地 `verify.mjs` 与 `stage m2 test` 覆盖 |
| 真实服务 | Bangumi 只读契约 9 个请求 passed（返工增加角色与人员两个端点）；ASR 契约 3 个请求（合成 TTS 语音）passed；LLM 整理与视觉/OCR 的真实调用未授权（ACT-05），not-run |
| 阻塞与未执行 | 见第 11 节：返工后的人工检查 H-M2-01—10 与 H-01 复核、设备与硬件项（H-M2-06/07）、真实 LLM/视觉（ACT-05）均 not-run，已列入[用户待办](../../USER-ACTIONS.md)，按 A-53 不阻塞合并与下一阶段 |
| 产品验收 | **not-run**。M2 的人工检查（[用户待办](../../USER-ACTIONS.md#checks)）尚未执行 |

## 2. 启动命令、样本与证据入口

```bash
pnpm install                                         # 锁文件已更新，安装后应无改动
pnpm dev                                             # 开发模式启动桌面应用（Electron + Vite）
node scripts/samples/generate-media-samples.mjs      # 生成合成样本到 dist/samples/m2
node scripts/stage.mjs m2 test                       # 必需用例清单与 Vitest
node scripts/stage.mjs m2 package                    # 打包并跑 11 阶段真实窗口烟测（不访问外网）
node scripts/stage.mjs m2 bench                      # 基准（服务层 + 真实窗口 + 规模 Profile）
node scripts/stage.mjs m2 report                     # 严格报告：缺项、旧指纹、失败用例均非零退出
node scripts/verify.mjs                              # 推送前完整检查
```

- **合成样本** 位于 `dist/samples/m2`（不入库；生成器 `scripts/samples/`，指纹写入样本清单，缺失或指纹不符时测试失败而不是跳过；生成器产不出的可选样本记为 unavailable 并写明原因）：图片目录（非连续编号、重复名、超长条、超大尺寸、损坏页）、CBZ（正常、ComicInfo、路径穿越、压缩炸弹、加密条目）、全图片 PDF/EPUB/MOBI、视频（MP4 H.264/AAC；MKV H.264 + 内封 ASS + 附件字体 + 双音轨；外挂 ASS/SRT；MKV HEVC 8/10 位；VFR；非零起点；AC3；剧集目录）、开发机 SAPI 合成语音与音乐/噪声混成的 30 分钟录音（含真值区间）和全程无人声样本、合成封面。
- **运行输出** 在 `dist/evidence-runs/m2/<跑次>/`（不入库）；**最终结果** 复制到 [`docs/evidence/m2/`](m2/)：`report.json`（严格报告）、`cases.json`（逐用例结果）、`test-run.json`、`bench.json`（性能原始数据）、`package.json`（打包烟测）、`scenarios.json`（返工窗口观察）、`media-smoke.json`（支持矩阵的原始探测）、`dependency-inventory.json`、`live-asr.json`、`live-bangumi.json`、`l1-combining-marks/`、`screenshots/`（打包窗口的关键截图）。
- 真实服务用例默认关闭：`MANGA_LIVE_BANGUMI=1`（≤10 个请求，只读）、`MANGA_LIVE_ASR=1`（≤10 个请求，只发合成语音，使用本机 `.env.local` 的测试配置，凭据值不写入任何输出）。

## 3. 工作包映射

状态：done = 实现并通过自检；其余见各行。

| 任务 | 实现位置 | 证据 | 状态与限制 |
| --- | --- | --- | --- |
| **C0** 规则机械化 | `scripts/check-docs.mjs`（`currentStage`、`retireAfter`）、`scripts/desktop-paths.ts`（`evidenceRunDir`）；登记表 `docs/governance/document-registry.json` | `scripts/check-docs.test.mjs`（反例：过期文档在当前阶段失败，在自己的阶段通过，未知阶段名被拒）；用例 `C0-stage-gates-and-registry` | done |
| **C1** 计划/prompt/报告提炼 | `docs/evidence/m0-summary.md`、`m1a-summary.md`、`m1b-summary.md`；仍有效的内容写回 ACT-01、LOOP-03、Git 规则第 5 节、M2 计划第 3 节与 Q-14 | 三份总结 76/68/101 行；已删文档清单见第 5 节 | done |
| **C2** 轮次证据目录 | 删除 `docs/evidence/` 下全部轮次目录 | `git ls-files docs/evidence` 只剩总结、本报告与 `m2/`；体积见第 5 节 | done |
| **C3** 脚本与测试整理 | `scripts/stage.mjs`、`scripts/stage/*`、`scripts/stages/m2.json`；测试按能力分到 `tests/<能力>/`；夹具在 `tests/fixtures/` | 迁移映射 [M1b 总结](m1b-summary.md#迁移映射)；`scripts/stage-report.test.mjs`（门禁反例通用化） | done |
| **C4** 原型与依赖 | 移除 `epubjs`、`@readium/shared`；删除 `experiments/m0-desktop`；`experiments/m0` 保留并写明退出条件（M4 获取替代 POC-09 后删除）；POC-02/08 的 4 个测试文件随产品测试替代而删除 | `pnpm install` 后锁文件干净；类型检查通过；`experiments/m0/README.md` | done。POC-03 的 `experiments/m0/src/tests/review-formats.test.ts` 在 PATH 上没有 libx264/libx265 时跳过（随包 FFmpeg 是 LGPL 构建，无这两个编码器），记录在第 11 节 |
| **C5** 生产代码中的测试装置 | `apps/desktop/src/main/smoke/`（`index.ts` 分发，各阶段分文件：`agent.ts`、`closure.ts`、`formats.ts`、`media.ts`、`voice.ts`、`rework.ts`、`bench-window.ts`，公共 `common.ts`、`driver.ts`），仅在测试参数/环境变量存在时由 `index.ts` 动态加载 | 用例 `C5-smoke-isolation`（`tests/package/smoke-isolation.test.ts`：目录外无静态导入、入口恰好一处动态导入）；打包烟测仍通过 | done |
| **C6** 正本瘦身 | `docs/README.md`、`docs/SUMMARY.md`、`delivery/status.md`、`dev-rules/quality-gates.md`、`dev-rules/repo-map.md`、`decisions/open-questions.md`、`governance/documentation-policy.md`、`docs/modules/*.md` | `node scripts/check-docs.mjs` 通过（63 个文档） | done；A 抽查有无结论丢失 |
| **U1** 运行时与依赖刷新 | 版本表与例外见第 6 节和 [ADR-0007](../decisions/0007-technology-stack.md)；`scripts/inventory-deps.mjs` | 升级后盘点 `m2/dependency-inventory.json`（升级前的版本在 ADR 表）；完整回归与打包烟测通过；Electron 版本在支持矩阵中 | done；LOOP-02 由 A 审查关闭（第 14 节）；例外 8 项 |
| **P0** 入口与样本 | `scripts/stage*`、`scripts/samples/*`（`generate-media-samples.mjs`、`media-writers.mjs`、`media-draw.mjs`、`media-manifest.mjs`、`pdf-embedded-font.ts`）、`tests/helpers/samples.ts` | `tests/samples/media-samples.test.ts`（样本缺失或指纹不符失败） | done |
| **P1** 数据与契约 | schema v7（返工追加 v8，见第 16 节）：`packages/storage-drizzle/src/sql.ts`（`V7_SCHEMA_SQL`）、`store.ts`；契约 `packages/contracts/src/{media,metadata,capture,inputs-media,inventory,library-package}.ts`；资料包与备份往返 | `tests/library/schema-v7-migration.test.ts`（v6 库迁移、中断后重复执行）、`tests/package/media-roundtrip.test.ts`、`tests/contracts/media-contracts.test.ts` | done |
| **P2** 媒体协议、子进程与 worker | `packages/app-core/src/media/*`（句柄、Range 服务、FFmpeg 包装、任务队列、zip 池、缩略图）、`apps/desktop/src/main/media-protocol.ts` | `tests/media/*`；用例 `P2-media-protocol-and-workers`；打包烟测 media 阶段在真实窗口逐样本跳帧（经 Range 读取） | done |
| **P3** 漫画阅读 | `packages/app-core/src/comic/*`、`apps/desktop/src/renderer/readers/comic-*`、`hooks/use-comic.ts` | `tests/comic/*`、`tests/reading/comic-*.test.*`；AT-22；打包烟测逐样本开窗 | done；真实库试验见第 9 节；加密 PDF 放宽见第 10 节 |
| **P4** 动画播放 | `packages/app-core/src/video/*`、`readers/video-*`、`readers/use-video-*`、`hooks/use-video.ts` | `tests/video/*`、`tests/reading/video-*`；AT-23；打包烟测逐样本播放、帧号落点核对 | done；开发机有硬件 HEVC，无硬件解码路径的副本播放见 H-M2-07 |
| **P5** 封面与元数据 | `packages/app-core/src/metadata/*`（Bangumi、`local-file`、封面、字段投影、相关作品） | `tests/metadata/*`、`tests/helpers/fake-bangumi.ts`；AT-39—41、AT-56；真实只读契约 passed | done；Q-15、Q-19、Q-20 待决 |
| **P6** 资源库与界面 | `apps/desktop/src/renderer/`（`App.tsx` 由 1693 行降到返工后的 991 行，壳与导航在 `shell.tsx`、`lib/shell-model.ts`，页面在 `pages/` 与 `pages/settings/`，组件在 `components/`，数据在 `hooks/`、`lib/`） | `tests/shell/*`；AT-16、AT-60—62；打包窗口截图；返工后的导航、作品主页与设置界面见第 16 节 | done；LOOP-01 由 A 审查关闭（第 14 节）；Q-08、Q-18 待用户评审 |
| **P7** Agent 上下文与命令 | `packages/app-core/src/agent-materials.ts`、`components/chat/`（返工后取代 `pages/agent-media-panel.tsx`）、`packages/app-core/src/quick-tasks.ts`、模型路由的视觉能力 | `tests/agent/media-context.test.ts`、`tests/shell/agent-send-media.test.tsx`、`chat-composer.test.tsx`；AT-24；用例 `P7-agent-media-context` | done；真实视觉模型调用 not-run（ACT-05）；语义取舍见第 10 节 |
| **P8** 模块启停与恢复 | `manga.comic/video/metadata/voice` 四个模块与停用时的代次、句柄、worker 释放 | `tests/runtime/module-toggle.test.ts`；AT-14、AT-37、AT-38 | done |
| **P9** 自检、打包与交付 | 随包资产与清单 `apps/desktop/src/main/bundled-assets.ts`、`scripts/tools/*`（FFmpeg 与 Silero 锁定版本与哈希）、`scripts/stage/package.mjs` | `tests/package/bundled-assets.test.ts`；缺资产启动即报错；本报告 | done；Q-17 待决 |
| **R1** 采集与位置事件 | `packages/app-core/src/voice/capture.ts`、渲染进程 `voice/*`、悬浮框 `main/overlay*.ts` | `tests/voice/*`；AT-06、AT-54 | done；设备项 H-M2-06 |
| **R2** 人声筛选、分块与转写 | `voice/{vad-*,chunks,transcribe,organize,ports}.ts`（Silero VAD、onnxruntime-web、worker） | `tests/voice/vad-*`、`chunks`、`timeline-30min`；AT-57；ASR 真实契约 passed | done；整理的真实 LLM 调用 not-run（ACT-05） |
| **R3** 保留与回顾 | `voice/audio-files.ts`、`renderer/voice/review-panel.tsx` | `tests/voice/review-panel.test.tsx`、`capture-service`；AT-58 | done |
| **R4** 来源映射 | `voice/position-map.ts` | `tests/voice/position-map.test.ts`、`timeline-30min.test.ts`；AT-59；映射误差 0 ms（确定性时间线） | done；设备时钟误差只能人工（H-M2-06） |
| **W1—W10** 人工试用返工 | 见第 16 节的逐项映射 | 见第 16 节 | done；产品验收与人工检查 not-run |
| **L1** PDF 组合字符（LOOP-04） | `scripts/samples/pdf-embedded-font.ts`、`scripts/samples/build-reading-samples.py` | 用例 `LOOP-04-combining-marks`；[复现与对比](m2/l1-combining-marks/)；结论见第 10 节 | done；用户在稳定包上复查（H-01）后由 A 关闭 LOOP-04 |

## 4. 验收用例映射

“用例数”是该必需用例按名称模式匹配到的 Vitest 用例数，全部在 `docs/evidence/m2/cases.json` 中逐条列出。所有行的产品验收均为 not-run。

| 验收 / 工作包 | 必需用例 ID | 范围 | 用例数 | 自动化结果 | 限制与人工项 |
| --- | --- | --- | --- | --- | --- |
| AT-03（新媒介路径） | `AT-03-media-progress` | 三种媒介的最后位置、已看区间与作品汇总；不同修订不混用进度 | 13 | passed | 视频重启恢复的真实窗口复核归 H-M2-04 |
| AT-06 | `AT-06-capture-devices` | 麦克风选择、权限被拒、无设备、设备丢失；不显示假计时与假成功 | 12 | passed | 耳机/外放对照与真实拔设备只能人工（H-M2-06） |
| AT-07（含 M2 追加） | `AT-07-recording-positions` | 录音中翻页、选区、暂停、倍速、跳转、资源切换的位置事件；ASR 晚到仍按请求时位置；不连续区间分别保存 | 14 | passed | — |
| AT-08 | `AT-08-asr-and-draft-failures` | ASR 失败、整理失败、取消、重试；重试不重复提交逻辑段，不覆盖用户编辑 | 15 | passed | 整理的真实 LLM 调用 not-run（ACT-05），用假端点覆盖失败路径 |
| AT-09 | `AT-09-commands-and-validation` | 界面与 Agent 走同一套命令，输入运行时校验，越界参数被拒，无旁路写库 | 215 | passed | — |
| AT-10 | `AT-10-run-stability` | Agent 生成期间切页与改目标不漂移，幂等请求只产生一个结果 | 11 | passed | — |
| AT-11 | `AT-11-scope-and-injection` | 范围限制下的越界检索与伪装指令；字幕窗口防剧透 | 12 | passed | — |
| AT-14 | `AT-14-module-switching` | 漫画/视频/元数据/语音模块启停，无残留订阅，晚到回调被拒 | 16 | passed | — |
| AT-16（新页面） | `AT-16-layout-keyboard-ime` | 资源库、阅读器、播放器、录音控件的键盘可达与中文输入法组合输入不被命令打断 | 26 | passed | 125%/150% 缩放与窄窗/矮窗的真实窗口归 H-M2-05 |
| AT-17 | `AT-17-crash-and-replay` | 提交前后中断与重放：迁移、录音恢复、重复事件无额外副作用 | 10 | passed | — |
| AT-18（M2 对象） | `AT-18-m2-package-round-trip` | 封面、关联、快照、录音、锚点随备份与资料包往返；v6 → v7 迁移与中断重复执行 | 9 | passed | — |
| AT-19 | `AT-19-search` | 中日文检索、范围过滤、缓存清理后重建索引 | 6 | passed | — |
| AT-20 | `AT-20-scale-and-background` | 长条漫画只渲染近页、任务队列分道、书架分页与首页缓存；后台任务不阻塞交互 | 10 | passed | 真实窗口基准见第 8 节 |
| AT-22 | `AT-22-comic-reading` | 目录/CBZ/PDF/EPUB/MOBI 页面清单、方向、单双页、缩放、区域锚点与旧修订引用 | 35 | passed | 真实阅读手感归 H-M2-03 |
| AT-23 | `AT-23-video-playback` | 播放路径判定、字幕/音轨、帧号跳转（CFR/VFR/非零起点）、倍速、长按右键、快进快退、A-B 区间 | 68 | passed | 真实窗口逐样本验证见第 7 节；手感归 H-M2-04 |
| AT-24 | `AT-24-agent-materials` | 漫画区域、字幕窗口、视频帧材料；缺少视觉能力时明示缺失，不声称已理解 | 41 | passed | 真实视觉模型调用 not-run（ACT-05） |
| AT-37 | `AT-37-module-races` | 模块启停与事务/任务/子进程晚到的竞态；停用后旧代次无写入 | 9 | passed | — |
| AT-38 | `AT-38-comic-module-off` | 有进度与笔记的漫画库停用阅读器、重启、导出、重新启用；资源与记录保留，引用恢复 | 7 | passed | — |
| AT-39 | `AT-39-field-sources` | 多来源字段投影、语言、评分、集数与用户覆盖/锁定；字段来源可见 | 12 | passed | — |
| AT-40 | `AT-40-limits-offline` | 限流、部分失败、断网、停用来源；确认资料与人工编辑仍可用，恢复后不覆盖 | 10 | passed | — |
| AT-41 | `AT-41-source-swap-and-candidates` | 换源、同名/续季/跨媒介候选、备份往返；身份与进度不变 | 9 | passed | — |
| AT-47（M2 查询部分） | `AT-47-query-boundaries` | 私网/回环与白名单外重定向被拒、路径越界、超额下载、凭据不回显；桌面网络栈的手动重定向、跨主机跳转不带凭据 | 17 | passed | M4 的 BT 部分不在本阶段 |
| AT-53 | `AT-53-format-samples` | 图片目录/CBZ/PDF/EPUB/MOBI 漫画与 MP4/MKV、H.264/HEVC、AAC、ASS、多音轨、VFR 合成样本矩阵 | 24 | passed | 10 位 HEVC 样本需 NVENC 生成（见第 11 节） |
| AT-54 | `AT-54-floating-box-and-hold` | 按住/切换录音、失焦与丢键抬起自动停止、悬浮框位置与大小的保存与屏幕内恢复 | 13 | passed | 多显示器与真实移动/缩放归 H-M2-06 |
| AT-56（Bangumi 部分） | `AT-56-bangumi-contract` | 客户端限流/重定向/大小/认证、字段冲突、候选与关联；本地假服务契约 | 26 | passed | 真实只读契约在第 9 节（环境变量开启） |
| AT-57 | `AT-57-voice-filtering` | 30 分钟合成录音的人声筛选边界、余量、分块大小、取消/重试、全程无人声不上传 | 34 | passed | — |
| AT-58 | `AT-58-audio-retention` | 保留/不保留成功、失败、取消、重启与清理失败；回顾与回放入口真实 | 14 | passed | — |
| AT-59（三种媒介） | `AT-59-source-mapping` | 小说/漫画/视频的翻页、暂停、倍速、跳转、换集、ASR 晚到、清理暂存音频后的分段映射无漂移 | 24 | passed | 设备时钟误差归 H-M2-06 |
| P2 | `P2-media-protocol-and-workers` | 伪造/过期句柄被拒、Range 越界 416、停用后旧句柄失效、句柄表满时保留正在读取的句柄、子进程被杀状态真实、中文与空格路径 | 69 | passed | — |
| P7 | `P7-agent-media-context` | 漫画/视频/资源库会话上下文、冻结材料、快捷任务可见消息、视觉路由能力检测 | 27 | passed | 真实视觉调用 not-run（ACT-05） |
| P9 | `P9-bundled-assets` | 随包资产清单：缺失、大小或哈希不符时启动即报错 | 13 | passed | — |
| LIB-04 | `LIB-04-media-inventory` | 资源总览新增漫画、视频、录音与封面类别及占用 | 12 | passed | — |
| LOOP-04 / L1 | `LOOP-04-combining-marks` | 带真实字形与组合定位的嵌入字体生成 PDF，复现并判定组合字符问题 | 4 | passed | H-01 复核 not-run |
| C0 | `C0-stage-gates-and-registry` | 登记表的 `currentStage`/`retireAfter` 反例与报告门禁反例 | 2 | passed | — |
| C5 | `C5-smoke-isolation` | 测试装置不进入正常启动路径 | 3 | passed | — |
| R-01（W1） | `R-01-comic-zoom-layout` | 漫画页尺寸 = 适配基准 × 缩放（所有适配 × 缩放，±1 px）、整页适配时整页可见、缩放不改变所量的框、窗口与侧栏变化重新适配、滚动条占位后按剩余宽度适配、框无尺寸时的回退 | 13 | passed | 真实窗口的几何见 AT-68 与 `scenarios.json` |
| R-02（W2） | `R-02-nav-shelf-and-restore` | 导航始终打开书架、返回时筛选/搜索/排序/页签保留、空库起始于资源库路径页、会话行显示封面标题与位置 | 4 | passed | — |
| R-03（W2） | `R-03-work-home-open` | 点卡片进作品主页，“阅读/观看”才打开文件，卡片菜单保留继续阅读，返回先到作品页再到书架 | 3 | passed | — |
| R-04（W2、W7） | `R-04-profile-fields-edit-lock-restore` | 作品资料的空字段可填、锁定、恢复来源值 | 3 | passed | — |
| R-05（W7） | `R-05-ref-parse-accept-reject` | 条目编号与链接（含 `subject/<ID>`）的接受、拒绝与原因；向来源核对一次；条目缺失/类型不符/已被他作使用；任务不可用 | 5 | passed | — |
| R-06（W7） | `R-06-diff-preview-keeps-user-edits` | 关联与刷新的差异预览；逐项选择；用户覆盖与锁定优先；远端缺字段不清空本地 | 9 | passed | — |
| R-07（W7） | `R-07-credits-and-avatar-cap` | 角色（含声优）与制作人员的保存；头像只取 grid/small 尺寸、每条目 ≤ 20；失败不影响关联 | 5 | passed | — |
| R-08（W7） | `R-08-images-table-and-v8` | 图片表（封面原图与头像）、v6/v7 → v8 迁移与哈希校验、中断重试、资料包往返与可取消导出 | 10 | passed | — |
| R-09（W6） | `R-09-scan-partition-incremental-unavailable-move` | 资源库路径与扫描：作品划分、增量跳过、不可用标记（不删除）、移动重关联、取消、计划与定时；读目录不占主线程 | 16 | passed | — |
| R-10（W3） | `R-10-note-bubbles-four-sources` | 四种来源（小说位置/选区、漫画页/区域、视频时间点/A-B 区间、作品级）的笔记气泡与跳回；消息流分页（一个来源超过一页时仍可逐页取回更早的消息） | 8 | passed | — |
| R-11（W3） | `R-11-note-soft-delete-restore` | 笔记软删除、隐藏但保留修订与引用、恢复 | 2 | passed | — |
| R-12（W3） | `R-12-floating-capsule` | 悬浮胶囊：与右栏相同的笔记与麦克风，只在右栏收起时出现 | 6 | passed | 真实多显示器归 H-M2-06 |
| R-13（W4） | `R-13-debug-panel-redaction` | 调试面板内容来自既有快照与命令；凭据、本机路径、图像字节脱敏 | 7 | passed | — |
| R-14（W5） | `R-14-settings-ui-and-return` | 设置独立界面：导航替换、返回原页面、依赖模块的页面按模块启停显示 | 17 | passed | — |
| R-15（W5） | `R-15-records-filter` | 记录页按作品、媒介、类型、状态、关键字与已删除筛选并分页（1 万条笔记） | 3 | passed | — |
| R-16（W5） | `R-16-log-write-retention` | 操作日志：写操作提交后统一写入、不含凭据与正文、180 天/5 万条保留 | 4 | passed | — |
| R-17（W5） | `R-17-usage-records` | 使用记录：模型、令牌、耗时、结果；缺失显示“未提供/未记录” | 2 | passed | — |
| R-18（W8） | `R-18-quick-task-validate-and-send` | 快捷任务：占位符校验、渲染（缺内容的说明）、不改变授权、发送为可见用户消息 | 11 | passed | — |
| R-19（W4） | `R-19-chat-page-no-right-pane` | 对话页无右栏与胶囊、会话列表在左栏下部、从对话页发送并重启恢复 | 3 | passed | — |
| R-20（W9） | `R-20-player-light-tokens` | 播放器浅色控制条的颜色只来自语义 Token；记笔记与录音按钮已移除，A-B 区间成为右栏引用标签 | 10 | passed | 与参考图并排对比只在本机进行 |
| R-21（W6、W10） | `R-21-scan-scale-and-loop` | 任务队列在不等待的任务之间让出事件循环、被取消的任务仍启动并看到中止信号、v8 索引覆盖扫描重复查询、PDF 页只在打开宽度绘制一次（LOOP-06） | 4 | passed | 5000 文件扫描的实测见第 8 节 |
| AT-63 | `AT-63-library-paths-and-scan` | 资源库路径、扫描、取消、计划；读大目录时事件循环仍转 | 11 | passed | 5000 文件扫描门槛见第 8 节；真实机器上的扫描归 H-M2-01 |
| AT-64 | `AT-64-note-bubbles-and-capsule` | 笔记气泡四种来源、悬浮胶囊、右栏麦克风与语音气泡回顾、从句子跳到视频时间 | 10 | passed | 耳机/外放与设备归 H-M2-06 |
| AT-65 | `AT-65-work-home-and-matching` | 作品主页、编辑/锁定/恢复、编号与链接匹配、差异预览、相关作品在作品页 | 11 | passed | 真实 Bangumi 只读契约见第 9 节；断网重启归 H-M2-02 |
| AT-66 | `AT-66-settings-records-logs-quick-tasks` | 设置各页、记录、日志、使用记录、快捷任务 | 16 | passed | 归 H-M2-09、H-M2-10 |
| AT-67 | `AT-67-debug-panel` | 调试面板：当前/上次任务、事件、复制脱敏 | 7 | passed | 窗口里的面板未由打包烟测驱动，归 H-M2-08 |
| AT-68 | `AT-68-comic-and-player-layout` | 漫画页尺寸不变量与播放器浅色控制条的组件级断言 | 12 | passed | 真实窗口的三种尺寸 × 三种适配 × 缩放见 `scenarios.json`（第 16 节） |

M1a/M1b 行为回归（必须在新媒介与新界面上继续通过）：

| 回归项 | 必需用例 ID | 用例数 | 自动化结果 |
| --- | --- | --- | --- |
| F-24—F-32（M1a 位置、写入屏障、幂等、运行 ID、双运行时、用途隔离、初始化盘点、规模报告、快照重试） | `F-24-owned-rollback`, `F-25-write-barrier`, `F-26-actor-idempotency`, `F-27-immediate-run-id`, `F-28-dual-runtime`, `F-29-purpose-isolation`, `F-30-setup-inventory`, `F-31-scale-report`, `F-32-snapshot-retry` | 50 | passed |
| G-01（M1b 格式矩阵） | `G-01` | 42 | passed |
| G-05 | `G-05` | 7 | passed |
| G-06 | `G-06` | 15 | passed |
| AT-04 | `AT-04` | 9 | passed |
| AT-05 | `AT-05` | 5 | passed |
| AT-18（M1b 包依赖） | `AT-18` | 22 | passed |
| AT-52 | `AT-52` | 14 | passed |
| AT-60 | `AT-60` | 3 | passed |
| AT-61 | `AT-61` | 2 | passed |
| AT-62 | `AT-62` | 2 | passed |

## 5. 清理记录（C1—C4）

| 项 | 内容 |
| --- | --- |
| 归档提交 | M0 `dc925e9`、M1a `a688713`、M1b `5504c97`（均在 `origin/main` 历史中，可用 `git show <提交>:<路径>` 取回） |
| 删除 | 相对计划提交删除 1761 个文件、新增 222 个文件（含 A 审查新增的 `apps/desktop/src/main/net-fetch.ts`）：`docs/delivery/` 下 M0/M0 收尾/M1a/M1b 的计划与 prompt；`docs/evidence/` 下 2026-09-19 的报告、三份 `m1a-*.md`、`m1b-reading-notes-delivery.md` 与全部轮次目录（含约 187 MB 的 `m1b-reading-notes`）；`docs/design/modules/`；`experiments/m0-desktop`；一次性审查脚本与 `m0/m1a/m1b` 阶段入口 |
| 提炼 | 每个已合并阶段一份总结（M0/M1a/M1b）；有效内容写回正本，见第 3 节 C1 |
| 测试迁移映射 | 旧 → 新的完整表见 [M1b 总结](m1b-summary.md#迁移映射)；本阶段追加：POC-02 与 POC-08 的 4 个原型测试文件由产品测试替代而删除（录音、转写与映射 → `tests/voice/`；元数据契约 → `tests/metadata/`）；`experiments/m0` 的 `closure-review.test.ts` 与 `review-formats.test.ts` 保留（后者条件跳过） |
| 体积 | `docs/evidence/` 现为总结、本报告和 `m2/`（2.52 MiB，低于 5 MiB；`screenshots/` 含返工阶段宽/窄/矮窗下的漫画页、播放器与小说页，宽窗的资源库、作品主页与设置，以及对话页、媒体与录音的关键页面；与参考图的对比只在本机） |

## 6. 依赖升级与例外

完整版本表、例外与复查条件在 [ADR-0007 的 M2 依赖刷新结果](../decisions/0007-technology-stack.md)。要点：

- **升级**：Electron 37.4.0 → 44.5.1、Forge 7.11.2 → 8.0.1、Vite 7.1.5 → 8.3.2、plugin-react 5.0.3 → 6.1.1、Vitest 3.2.4 → 5.0.3、TypeScript 5.9.2 → 7.0.2（开启 `erasableSyntaxOnly`）、better-sqlite3 12.2.0 → 13.0.3、drizzle-orm 0.44.5 → 0.45.3、esbuild 0.25.10 → 0.28.2、Tiptap 2.26.1 → 3.31.4（唯一代码迁移是 `setContent` 选项；`extension-history` 随之移除）、parse5 8、`@types/better-sqlite3` 9.6.0，另有测试工具与其他次版本。
- **移除**：`epubjs`、`@readium/shared`、`@tiptap/extension-history`。
- **新增（M2 返工）**：`use-stick-to-bottom` 1.1.6（MIT，2026-06-04 发行，无依赖，精确固定），右栏消息流在流式输出时贴底、用户上滚后不被拉回；聊天界面的结构参照 Vercel ai-elements（Apache-2.0）为 MANGA 的消息类型重写，源码注明来源与许可，不引入其运行时。选型证据与未采用方案见[计划 14.3](../delivery/m2-media-mvp-plan.md#143-开源查证a-402026-10-06)，ADR-0007 已登记。其余返工能力（目录遍历、扫描、日志、用量、快捷任务、差异预览）用已有依赖与 Node 内置能力完成，没有新增依赖。
- **新增（M2 使用方）**：jassub 2.5.16、onnxruntime-web 1.30.0、sharp、yauzl、anitomy、`@napi-rs/canvas`、`@tanstack/react-virtual`；随包的 FFmpeg 8.1 LGPL 共享构建与 Silero VAD v6.2.3 模型由 `scripts/tools/*.lock.json` 锁定来源与哈希。
- **保留旧版本的例外（复查条件见 ADR）**：jsdom 26.1.0（30.1.2 未满最小发行龄）、lucide-react 0.544.0（1.52.0 同）、`@earendil-works/pi-ai` 0.85.1（1.0.2 同）、jassub 2.5.16（2.5.18 同）、CodeMirror 三个子包保持 6.5.2/6.38.1/6.8.1（只升这三者会与元包产生两份实例）、`@types/node` 24（随 Node 24.19）、pdfjs-dist 6.3.289 精确固定并有版本断言（6.4.299 需重测文本层并由用户复核 H-01）。`openapi-typescript` 因 TypeScript 7 不再提供其依赖的编译器 API，只在隔离目录里用 TypeScript 5.9 运行，生成结果入库并固定到官方规格提交。pnpm 的最小发行龄策略没有被绕过：遇到版本太新时一律回退，不接受自动写入的豁免。
- 依赖盘点（`m2/dependency-inventory.json`，2026-10-04 查询 npm，早于返工）共 90 行直接依赖（含工作区内部引用），最新稳定版落后的有 11 行（9 个包），全部在上述例外之内（pdfjs-dist 在三个清单里各出现一次）。返工只新增 `use-stick-to-bottom` 一项，已精确固定在其当时的最新稳定版，不在该盘点内。

## 7. 支持矩阵

在升级后的 Electron 44.5.1（Chromium 内核）真实窗口里，对合成样本逐个播放并核对帧号落点（原始数据 `m2/media-smoke.json`）。“无硬件 HEVC”列是 `decidePlayback` 在渲染进程报告无硬件解码时的决定；开发机有硬件 HEVC，所以窗口里实际走原件。

| 样本 | 容器 / 视频 / 音频 / 字幕 | 无硬件 HEVC 的决定 | 有硬件 HEVC 的决定 | 窗口实测路径 | 帧号落点（3 个采样） |
| --- | --- | --- | --- | --- | --- |
| `video-mkv-ass-fonts` | MKV / H.264 / AAC ×2 轨 / 内封 ASS + 附件字体 | 直接播放 | 直接播放 | 原件 / passed | 36✓ / 180✓ / 357✓（原件起点偏移 0 ms） |
| `video-mp4-h264-aac` | MP4 / H.264 / AAC / — | 直接播放 | 直接播放 | 原件 / passed | 57✓ / 288✓ / 573✓（原件起点偏移 0 ms） |
| `video-mkv-hevc-8bit` | MKV / HEVC 8 位 / AAC / — | 播放副本（无硬件 HEVC） | 直接播放 | 原件 / passed | 24✓ / 120✓ / 237✓（原件起点偏移 0 ms） |
| `video-mkv-hevc-10bit` | MKV / HEVC Main10 / AAC / — | 播放副本（无硬件 HEVC） | 直接播放 | 原件 / passed | 24✓ / 120✓ / 237✓（原件起点偏移 0 ms） |
| `video-ac3` | MKV / H.264 / AC3 / — | 播放副本（音频不支持） | 播放副本（音频不支持） | 播放副本（副本就绪） / passed | 24✓ / 120✓ / 237✓（原件起点偏移 0 ms） |
| `video-vfr` | MP4 / H.264 可变帧率（30 → 10 fps）/ 无音频 / — | 直接播放 | 直接播放 | 原件 / passed | 32✓ / 160✓ / 317✓（原件起点偏移 0 ms） |
| `video-nonzero-start` | MKV / H.264 / AAC / —（起始偏移 2.5 s） | 直接播放 | 直接播放 | 原件 / passed | 24✓ / 120✓ / 237✓（原件起点偏移 2500 ms） |

- 帧号落点：输入帧号跳转后，元素呈现帧的媒体时间与按帧时间戳索引算出的时间一致（“落点”）且经呈现帧回调核实（“核实”）。VFR 与非零起点（起始偏移 2500 ms）按时间戳处理。
- ASS 字幕（含内封附件字体）在 MKV 样本上用 JASSUB 绘制，打开与关闭时的画面有 10250 个像素差异。
- AC3 音轨需要播放副本：副本构建耗时 440 ms（合成短样本），时间戳逐帧比较通过。
- 漫画：目录、CBZ、图片 PDF 三类样本在窗口里逐页翻页并重启恢复。
- 窗口实测耗时（打包烟测原始统计）：漫画翻页 p50 28 ms / p95 30 ms（8 次）；视频首帧 p50 44 ms / p95 517 ms（7 个样本）；帧号跳转落点 p50 117 ms / p95 129 ms（21 次）。
- 返工后的整套运行里，VFR 样本落点后读到的帧号读数（`video-frame` 的 `data-frame`）为空，落点与核实均为真；单独运行该样本 3 次读数均为 33/161/318。读数来自异步的帧索引查询，整套运行时可晚于落点核对；烟测断言的是落点与核实，不是读数，该差异记在 `media-smoke.json` 里，不影响支持矩阵的结论。
- 隐藏窗口不呈现帧，所以 media 阶段把窗口显示在屏幕上（不抢键盘焦点）；渲染进程崩溃会被记为该样本失败并重载继续，不会静默通过。无硬件解码机器上的 HEVC 副本播放尚未实测（H-M2-07）。

## 8. 性能与基准原始数据

原始数据：`docs/evidence/m2/bench.json`（目标、样本、规模 Profile 的窗口测量、每项的原始数组）。以下是 p95（毫秒），目标沿用 M1b 使用的需求 6.2 门槛：

| 指标 | 统计 | 结果（ms） | 目标（ms） |
| --- | --- | --- | --- |
| 检索（服务层） | p95 | 0.6 | ≤ 500 |
| 上下文构建（服务层） | p95 | 0.7 | ≤ 150 |
| 已索引首屏（服务层） | p95 | 0.9 | ≤ 2000 |
| 笔记保存（服务层） | p95 | 1.7 | ≤ 1000 |
| 进度保存（服务层） | p95 | 2.3 | ≤ 1000 |
| 冷启动（服务层） | p95 | 16.2 | ≤ 5000 |
| 窗口：导航 → 页面 | p95 | 5.0 | ≤ 8000 |
| 窗口：书架 → 阅读正文可见 | p95 | 11.0 | ≤ 2000 |
| 窗口：输入 → 保存回执 | p95 | 484.0 | ≤ 1000 |
| 窗口：导入 → 可读 | p95 | 135.0 | ≤ 5000 |
| 规模 Profile：进程启动 → 资源库可操作 | p95 | 1308.0 | ≤ 5000 |
| 规模 Profile：页面切换反馈 | p95 | 6.0 | ≤ 100 |
| 规模 Profile：10 MiB TXT 末尾可见 | p95 | 694.1 | ≤ 2000 |
| 规模 Profile：30 MiB EPUB 末尾可见 | p95 | 944.1 | ≤ 2000 |
| 规模 Profile：保存回执 | p95 | 558.1 | ≤ 1000 |
| 规模 Profile：后台解析期间页面切换反馈 | p95 | 5.8 | ≤ 100 |
| 规模 Profile：后台解析期间保存回执 | p95 | 616.0 | ≤ 1000 |
| 规模 Profile：5000 个文件的后台扫描期间，主进程事件循环延迟 | p99 | 15.6 | ≤ 100 |
| 规模 Profile：5000 个文件的后台扫描期间，常用操作答复 | p95 | 7.9 | ≤ 100 |

- 规模 Profile：1 万条元数据、5 万个检索块、10 MiB TXT 与 30 MiB EPUB 的尾部、后台解析 10 MiB 文本期间的界面与保存样本；每次都是新进程冷启动。
- 本阶段发现并处理的两件事：（1）阅读页在已有打开的书时直接显示阅读器而不是书架，基准驱动要先返回书架再点击卡片，否则 4 s 的点击等待会被算进“内容可见”；已改驱动。（2）后台解析时从其他页切到书架要等主进程应答（它被导入的索引批处理阻塞 50—140 ms，最长约 300 ms），p95 一度为 138 ms；现在书架保留上次的首页结果，再次显示时立即绘制并在后面刷新（`WorksCacheContext`，用例见 AT-20）。
- 本表是自检，不是产品验收；机器：win32 x64，Node v24.19.0，开发机（不是基准参考机）。本表是 A 复核修复（含 F-36—F-38）后的最终一次运行，与 B 自检时的水平相当。复核中的前一次运行里，重负载项（10/30 MiB 末尾、规模保存回执、扫描、封面缩略图、右栏输入）比 B 自检时慢约 1.5—2.5 倍，30 MiB EPUB 末尾可见 p95 达到 1960.8 ms、离门槛只剩 39 ms；当时在同一台机器上把复核对服务层的两处改动撤回再测 5000 文件扫描，耗时相同（31.6 s 对 30.1 s，p99 31.9 对 31.0 ms），这次重跑又回到 B 自检的水平，所以差异来自机器状态而不是代码。EPUB 末尾在较慢的机器上仍可能接近门槛，记在 17.5。

返工新增（plan 14.6，`scripts/stage/bench-rework.mjs`；合成数据，原始样本在 `bench.json` 的 `rework` 与 `measurements`）：

- **5000 个文件的后台扫描**（20 个系列文件夹 × 100 个文件 + 3000 个零散文件，每次一个全新 Profile，连续 3 次）：事件循环延迟用 5 ms 间隔的计时器采样（共 6065 个样本），p99 为 15.6 ms，最大 86.7 ms；扫描期间每隔一段时间读取书架页（`works.list`）、扫描状态与路径列表，共 1913 个答复样本，p95 为 7.9 ms，最大 19.0 ms；三次扫描都登记了全部 5000 个文件、没有失败，耗时 14.0, 14.5, 14.2 秒，吞吐量 356.1, 345.0, 351.7 文件/秒（记录项，不设门槛；B 自检时为 13 秒左右、约 390 文件/秒；复核中前一次运行慢的那次约 32 秒、约 155 文件/秒，差异见上）。测量位置是 Node 进程里与桌面主进程相同的服务与 worker，不是 Electron 主进程本身（第 11 节）。
- **封面读取（记录项）**：200 个封面存入图片表后，读取一个封面的字节接近计时器分辨率（原始样本按 0.1 ms 取整，200 个里 198 个为 0.0 ms，p95 0.0 ms，最大 0.1 ms）；`covers.handles` 为一个封面生成网格缩略图（冷）p95 11.6 ms，缩略图已存在（热）p95 0.6 ms。
- **右栏 1000 条消息（记录项，真实窗口）**：打包窗口载入 1000 条笔记气泡（经“更早的消息”逐页取回，每次运行载入 1000 条，约 26006 个 DOM 节点，可滚动高度 138033 px），设置滚动位置并强制布局读取 p95 1.3 ms，向输入框输入到 React 提交并布局 p95 41.1 ms（3 次窗口运行合并；B 自检时为 26.4 ms，复核中慢的那次运行为 61.6 ms）。隐藏窗口不绘制，所以这是布局成本，不是帧时间；消息列表没有虚拟化（登记为 LOOP-07）。
- 本阶段的返工发现了三件事，处理见第 16 节：扫描时主进程循环被占住约 38 秒（缺两个索引、任务队列不让出循环，修复后见上表）；右栏消息流 `hasMore` 在满页时为假；基准最初量错了滚动元素。

## 9. 真实服务契约测试与真实库只读试验

**Bangumi 只读契约**（`tests/real/bangumi-contract.test.ts`，`MANGA_LIVE_BANGUMI=1`）：9 个请求（预算 10），passed——搜索（动画、书籍）、条目详情、关联条目、剧集、角色（含声优）、人员（含职位）、封面图片；应答形状与 OpenAPI 类型一致，图片经主进程下载。返工新增的角色与人员两个端点中，首个搜索结果没有角色条目，测试回退到固定的参考条目（编号 253）再取一次角色，所以角色端点共 2 个请求。摘要 `m2/live-bangumi.json`（只含端点、结果与计数）。

**ASR 契约**（`tests/real/asr-contract.test.ts`，`MANGA_LIVE_ASR=1`）：3 个请求，只发开发机合成的中文语音，passed——纯文本（相似度 1）、带时间戳（0.926，1 个时间戳片段）、带提示词与时间戳（1，1 个片段）。结论：服务返回 1 个整块时间戳片段，所以产品的“粗定位、待校准”路径是常态而非例外。摘要 `m2/live-asr.json`。

**真实库只读试验**（仅开发者本机，环境变量开启，不进 CI；不复制任何文件，不记录名称与路径，下面只是聚合特征）：

- 动画目录（36 个 MKV、4 个 `.7z`）：抽样探测 5 个均成功（中位约 35 ms）；格式一致为 Matroska + HEVC Main 10、1080p、AAC，均带内封字幕，其中 3 个带附件；36/36 个剧集文件名解析出集号。`.7z` 不支持。
- 小说目录（36 个 EPUB、2 个 TXT、4 个 ZIP、1 个 `.rar`、4 个未完成下载文件）：EPUB 与 TXT 按小说规划；抽样的 3 个 ZIP 以漫画方式扫描都得到“无可读页面”的明确错误，这是正确的，因为它们不是图片包；`.rar` 与未完成下载文件不支持。
- 漫画目录（1173 个 PDF、114 个 MOBI、129 个 EPUB、7 个图片目录、1 个 CBZ 等）：PDF 中位 57 MB、最大 462 MB；抽样的 21 本全部可读，页数中位 182；扫描耗时中位 339 ms、p95 2.6 s、最大 6.2 s；导入后页面句柄的取图耗时中位 1—4 ms。`.rar`、`.7z`、`.exe` 不支持。**1173 个 PDF 中有 72 个只设置了所有者密码**：漫画路径不再因 `/Encrypt` 字样预先拒绝，这些文件现在可以打开（见第 10 节问题 A）。
- Silero VAD 在 30 分钟合成样本上约为实时的 94 倍；映射误差 0 ms（合成时间线）。

## 10. 实施决定与发现（A 审查关注）

**决定（可逆，已按推荐值实现）**

1. 漫画默认阅读方向从右到左（可在设置改）；默认页是“总览”；“移出资源库”返工后仍未提供（计划未列，如需要请 A 另列条目）。
2. 录音快捷键：F9 按住录音、F8 切换录音（只在应用内有效）；录音期间视频降到约 30%（常量 `DUCK_FACTOR = 0.3`，可改暂停或不变）；保留默认“保留”；边界余量 300 ms。均为 Q-05 的推荐值。
3. 原“副驾驶”独立页并入阅读/播放页的右栏，与 Agent 页共享同一会话；AT-49 的文字已改为“切到右栏副驾驶继续同一会话并取消任务”。返工后（A-48）右栏是聊天窗口，对话页不显示右栏，决定的细节见第 16 节。
4. 视频：换到非默认音轨而画面可播时走重封装（不重新编码，P4 实施中补入判定表）；`video.playbackPlan` 与 `video.playCopy` 带 `hardwareHevc` 参数；“改用播放副本”开关在播放器内（不是设置页），H-M2-07 以此为准；自动下一集是设置项，默认关。
5. 四个模块各有启停命令；随包 FFmpeg 约 178 MB（LGPL 共享构建，不含 ffplay）。
6. P7：`spoilerGuard` 默认关闭（开启后字幕窗口还不超过已看进度的前沿）；字幕窗口默认不超过当前位置，只有用户显式放宽才越过；视觉/OCR 路由未配置或模型不支持图像时请求返回缺少能力，不声称已理解；在线元数据搜索需要模块启用且任务授权包含该命令（默认关闭，opt-in）。
7. 作品/资源的“媒介类型”属于资源，导入时系统给出建议、用户可改；改类型不新建修订、不搬迁锚点（领域模型 4.3）。

**需要 A 确认的问题**

- **A. 加密 PDF 放宽。** 真实库里约 6% 的 PDF 只设所有者密码，漫画路径现在不再预先拒绝它们（需要打开密码的仍由 PDF.js 报告后以 `UNSUPPORTED_FORMAT` 失败）。请确认保持放宽。
  **A 结论：保持放宽**，理由与回写见第 14.4 节。
- **B. 快照里的图片字节。** 带图片的 Agent 任务把图片字节放在 `snapshot_json` 中（每张 ≤ 1.5 MB、每个任务 ≤ 4 MB），历史快照会随之变大；是否改为附件引用留给 A 决定。
  **A 结论：M2 保持在快照中**，改为附件引用登记为 LOOP-05，见第 14.4 节。
- **C. 字幕窗口语义。** 位置判定为 `position`，开启 `spoilerGuard` 时取 `min(position, frontier)`，用户显式放宽（`subtitleAheadMs`）时扩大；确认这与防剧透意图一致。
  **A 结论：一致，确认**，判定公式写入视频模块，见第 14.4 节。

**发现与修复**

1. 视频时间原点：非零起始时间的容器需要把起始偏移从元素时钟里扣除，已修正（`originMs`），非零起点样本（起始 2500 ms）的帧号落点在窗口里核实通过。
2. 帧号竞态：跳到某一帧后，界面不应再按旧画面向帧索引追问帧号（会报出旧帧），已改为跳帧后以已命名的帧号为准，直到播放器呈现新画面并核实。
3. 打包：PDF.js 与 `@napi-rs/canvas` 的原生文件需要解包，`onnxruntime-common` 需要显式随包；缺失由启动时的资产清单检查报出，而不是运行中才失败。
4. 视频元数据事件竞态：`loadedmetadata` 可能在监听器挂上之前触发（缓存文件或本地快速打开），之前会让播放器永远不就绪；现在挂上监听器时补查 `readyState`（全套件下出现过的偶发失败，已用定位测试复现并修复）。
5. L1（LOOP-04）结论：PDF.js 按文件内容忠实绘制；裸的 `e` + U+0301 序列需要生成者提供标记定位（GPOS），所以问题在**样本生成器**而不是阅读器或文本层。已改生成器：预组合字符与带定位的分解序列在 PDF.js 里的重音居中偏移分别为 0.081 em 与 0.031 em，而裸序列为 0.632 em（见 `m2/l1-combining-marks/measurements.json` 与 `comparison.png`）。产品代码没有改动。
6. 测试装置：`tests/helpers/setup-dom.ts` 把 jsdom 里 `waitFor` 的默认等待提高到 5 s（全套件并行时一次渲染可超过 1 s），需要更短等待的用例自带超时。
7. 基准驱动与书架缓存见第 8 节。

## 11. 限制、blocked 与 not-run

| 编号 | 内容 | 状态 | 负责人 / 复测入口 |
| --- | --- | --- | --- |
| ACT-05 | LLM 整理与视觉/OCR 的真实调用；真实 Profile 迁移 | not-run（未授权） | 用户授权后由 B 或 A 复测；测试用假端点覆盖了失败路径与能力缺失 |
| ACT-06 / H-M2-01—10 | 返工后稳定包上的人工检查（步骤与状态在[用户待办](../../USER-ACTIONS.md#checks)），含空库起始与扫描、手动匹配、漫画缩放手感、播放器配色、耳机与外放、多显示器悬浮框、拔麦克风、有硬件 HEVC 的参考机、调试面板与快捷任务、记录页 | not-run | 用户；用户待办 |
| H-01 复核 | PDF 行首/行尾拖选与组合字符样本、撇号显示 | not-run | 用户（[用户待办 H-01 复核](../../USER-ACTIONS.md#h-01)）；通过后 A 关闭 LOOP-04 |
| 无硬件 HEVC 的副本播放 | 窗口里没有无硬件解码的机器；决定表与副本构建由单元与 AC3 副本窗口实测覆盖 | not-run（设备条件） | H-M2-07 |
| 窄窗/矮窗与缩放的真实窗口 | 原 reading 阶段读到的窗口尺寸在缩小后仍是宽窗值，不能作窄窗证据；返工的 `rework` 阶段改为设置内容尺寸后读回并断言（宽 1280×840、窄 360×780、矮 1100×460，`scenarios.json` 的 `windowSizes`），漫画页尺寸、播放器与小说页控件在三种尺寸下的位置都由该阶段量出。系统 125%/150% 缩放与手感仍需人工 | 窗口尺寸已自动化；缩放与手感 not-run | 用户；H-M2-05 |
| 扫描基准的测量位置 | 5000 个文件的扫描基准在 Node 进程里用与桌面主进程相同的服务与 worker 测量事件循环延迟与答复时间（`scripts/stage/bench-rework.mjs`），不是 Electron 主进程本身；窗口里的扫描由 `scenarios.json` 的 `library-paths-add-scan`（扫描中界面可操作、进度可见）覆盖，真实机器与真实收藏上的体验归 H-M2-01 | 如实记录 | 用户；H-M2-01 |
| 调试面板在真实窗口 | AT-67 由组件与服务测试覆盖，打包烟测的 `rework` 阶段没有驱动调试面板 | 人工 | 用户；H-M2-08 |
| 已加载的更早消息 | 右栏消息流超过一页（200 条）时，向上翻页取回更早的消息；之后主机通知触发的整页刷新会把列表折回最新一页，需再点一次“更早的消息”。属于体验上的限制，不丢数据 | 已知限制；A 复核决定不在本阶段处理，与右栏不做虚拟化一起登记为 LOOP-07 | 开发者；[执行状态 LOOP-07](../delivery/status.md#loop-07) |
| LOOP-06 | 记录选中与失败时渲染代次的诊断、等文本层稳定后再选、PDF 页只在打开宽度绘制一次的修复已实施；formats 阶段在 20 个线程满载下连续 10 次通过，完整 `package` 通过（第 16 节）；A 复核后的完整 `package` 再次通过，`loop06` 为单次绘制、选中节点仍在文档中 | 已关闭（17.4） | — |
| POC-03 的 x264/x265 用例 | 随包 FFmpeg 是 LGPL 构建，无这两个编码器；`experiments/m0/src/tests/review-formats.test.ts` 在 PATH 上没有它们时跳过 | not-run（已记入 `limits.json`） | 开发者：在 PATH 上放带 libx264/libx265 的 FFmpeg 后运行 `node scripts/m0.mjs test`；`experiments/m0` 随 M4 的 POC-09 一起删除 |
| 真实服务用例 | Vitest 里默认关闭：Bangumi 契约、ASR 契约、真实库只读试验、真实模型探针（4 个）；10 MiB/30 MiB 大文件读取只在阶段入口开启 | skipped（有意；Bangumi、ASR 与真实库试验已在开发者本机各跑一次，见第 9 节） | 开发者，用对应环境变量复跑 |
| 10 位 HEVC 合成样本 | 用 `hevc_nvenc` 编码，没有对应 GPU 的机器上不生成（样本为可选） | not-run（设备条件） | 开发者：在有 NVENC 的机器上运行样本生成器 |
| 凭据 | `.env.local` 的测试配置只在本机使用，值不进入任何输出 | — | — |

## 12. 稳定包后的人工步骤

2026-10-06 起（A-53），H-M2-01—10 与 H-01 复核的准备（稳定包、合成样本、检查用资源库目录、独立资料启动）、步骤、预期与状态只在[用户待办的人工检查](../../USER-ACTIONS.md#checks)维护，由用户在任何阶段逐项执行，本节不再保留副本；A 复核时的版本见 Git 历史。原计划 14.8 中 H-M2-07 写作“强制播放副本”，实际控件文案是“改用播放副本”，位于播放器状态区，用户待办已按实际文案书写。

## 13. 集中待决事项与下一步

待用户答复或授权的项（编号、当前默认与推荐时机见[用户待办](../../USER-ACTIONS.md)，按 A-53 不绑定阶段）：**Q-05**（录音默认值）、**Q-08**（最终视觉）、**Q-10**（游戏入口）、**Q-11**（会话休眠预算；基准里没有 1/10/30 会话的实测，留给媒体会话验收）、**Q-12**（阅读偏好）、**Q-13**（播放器细节）、**Q-14**（引擎选型记录）、**Q-15**（自动匹配阈值）、**Q-17**（FFmpeg/JASSUB/模型的分发许可与播放副本代价）、**Q-18**（左栏分组名称）、**Q-19**（Bangumi 网络与凭据）、**ACT-01**、**ACT-05**、**ACT-06**（H-M2-01—10 与 H-01 复核）；LOOP-06 已由 A 复核关闭，右栏长会话的两处限制登记为 LOOP-07。Q-20、Q-21 已由 A-51、A-52 决定并按 W7、W8 实现，用户在稳定包上复核即可。第 10 节的 A、B、C 三个问题和 LOOP-01/02/04 的状态见下。

第 10 节的 A、B、C 三个问题已由 A 审查答复，LOOP-01/02 已由 A 关闭（第 14 节）。

A 已按[计划 14.9](../delivery/m2-media-mvp-plan.md#149-交付与复核)复核返工并收敛（第 17 节）。首选下一步见 17.6。

## 14. A 集中审查（2026-10-05）

按[交接模板第 3 节](../templates/agent-handoff.md#3-a--用户或-b集中审查)记录。A 直接修复的局部问题与本节一起 amend 进同一阶段提交；新提交的 SHA 见审查回复（提交不能包含自己的 SHA）。

### 14.1 基点、范围与三个判断

- **基点**：B 的阶段提交 `a11caa8`（父提交是计划提交 `8e2ac3f`，主线基线 `main@5504c97`）。按[同一计划](../delivery/m2-media-mvp-plan.md)核对 C0—C6、U1、P0—P9、R1—R4、L1 的代码、失败路径与证据。
- **重点**：v6 → v7 迁移与资料包往返；快照图片预算（每张 ≤ 1.5 MB、每任务 ≤ 4 MB）；媒体协议的句柄、Range 与路径安全；视频起点偏移、帧号竞态、播放判定与副本、JASSUB 字体；录音与位置事件；Agent 上下文的 `spoilerGuard` 与缺视觉能力时的如实回答；模块启停与晚到回调；随包资产清单。
- **三个判断分开**：
  - **实现完成度**：计划内工作包全部实现。唯一缺口是 P4 要求的 1/10/30 会话实测没有做（F-05），转入 Q-11，不返工。
  - **技术审查结论**：收敛，**没有交回 B 的返工**。A 直接修复 F-01—F-04、F-06 与 F-09，并重跑全部证据；F-05、F-07、F-08 转入对应事项，F-10（打包烟测偶发失败一次）登记为 LOOP-06。
  - **产品验收**：**not-run**。所有 AT 的产品验收、第 12 节的人工检查（ACT-06）与 H-01 复核都未执行；`productAcceptance` 恒为 not-run。

### 14.2 实际运行的验证

| 时点 | 命令或方法 | 结果 |
| --- | --- | --- |
| 原提交 `a11caa8` | `node scripts/verify.mjs` | 通过：Vitest 1053 个用例 1044 passed、9 skipped；文档、公开与依赖检查通过 |
| 原提交 | `node scripts/stage.mjs m2 report`（B 的跑次目录） | 退出码 0；入库证据与跑次目录逐文件一致 |
| 原提交 | 用 `git worktree` 干净检出 `a11caa8`，按 `scripts/stages/m2.json` 重算指纹 | **不一致**：源码、测试、构建三个指纹都与证据不同，原因是工作区里 89 个指纹内文本文件为 CRLF（F-04） |
| 用例映射 | 逐个检查 54 个必需用例的名称模式与匹配结果；对照 M1b 的 242 个旧用例标题 | 模式都具体，没有用宽泛模式凑数，断言未见弱化。旧标题缺 4 个，均有解释：组合字符用例改名但内容相同、“copilot”改称“Agent page”、整库分页用例由书架用例替代 |
| F-01 复现 | 在 Electron 44.5.1 主进程里对本机回环服务做一次性实验（脚本未入库） | `net.fetch` 带 `redirect: "manual"` 直接抛出 “Redirect was cancelled”。新适配器得到 302 与 `Location`，目标未被请求；请求头、POST 正文、300 KB 响应正文与中途取消都正确 |
| 新增用例 | 暂存修复后单跑 F-01—F-03 的新用例 | 无修复时失败，有修复时通过 |
| 修复 F-09 后的第一轮 | `test` → `package` | `test` 退出码 0；`package` 退出码 1：formats 阶段的 PDF 选区没有让“记笔记”按钮启用（F-10） |
| F-10 复现 | 用全新隔离资料单独运行打包版的 formats 阶段 10 次 | 10 次全部通过，未复现 |
| 修复后（最终证据） | `node scripts/stage.mjs m2 test` | 退出码 0：必需用例 54/54 passed；Vitest 1056 个用例 1049 passed、0 failed、7 skipped |
| 修复后（最终证据） | `node scripts/stage.mjs m2 package` | 退出码 0：10 个阶段与缺资产负例通过 |
| 修复后（最终证据） | `node scripts/stage.mjs m2 bench` | 退出码 0：17 项 p95 全部在目标内（第 8 节已按新数据更新） |
| 修复后（最终证据） | `node scripts/stage.mjs m2 report` | 退出码 0：`errors: []`，`productAcceptance: not-run` |
| 修复后（最终证据） | `node scripts/verify.mjs` | 通过：Vitest 1056 个用例 1047 passed、9 skipped（两个大文件用例只在阶段入口开启）；文档、公开与依赖检查通过 |
| amend 后 | 用 `git worktree` 干净检出新提交，重算四个指纹 | 一致：源码 `d8e09787…`、锁文件 `207cbe6b…`、测试 `d6f06453…`、构建 `61a9191a…` 与 `m2/report.json` 及工作区相同 |

### 14.3 发现与处理

| 编号 / 严重度 | 触发与实际结果 | 预期与依据 | 位置/证据 | 修复验收与状态 |
| --- | --- | --- | --- | --- |
| F-01 / P2 | 打包版访问 Bangumi 时遇到任何重定向，包括白名单内的跳转：Electron 44 的 `net.fetch` 对 `redirect: "manual"` 直接抛错，客户端报 `PROVIDER_UNAVAILABLE:network`，看起来像断网。真实契约测试用的是 Node 的 fetch，所以没有发现 | 白名单内的重定向逐跳检查后继续，白名单外与私网地址拒绝（[元数据模块](../modules/metadata.md)、AT-47、AT-56）；桌面版走系统代理（Q-19） | `apps/desktop/src/main/index.ts` 的 `netFetch`。修复：`apps/desktop/src/main/net-fetch.ts`，手动重定向改走 `net.request` 的 `redirect` 事件，作为 3xx 交回客户端检查，不自动跟随 | `tests/metadata/bangumi-client.test.ts` 新用例：允许的重定向继续、到 `169.254.169.254` 被拒且不发请求、只有第一跳带令牌；Electron 实验见 14.2。**A 已核实关闭**；真实网络在 H-M2-02 观察 |
| F-02 / P3 | API 请求被重定向到白名单内的另一主机（例如图片主机）时，`Authorization` 令牌也随之发出 | 凭据只发给配置的 API 源（[数据与安全](../dev-rules/data-and-security.md)） | `packages/app-core/src/metadata/bangumi.ts` 的 `send()`：只有 `url.origin` 等于 API 源时才附加令牌 | 新用例 “follows an API redirect to another allowed host without taking the token along”。**A 已核实关闭** |
| F-03 / P3 | 句柄表满（8192 个）时按发放顺序淘汰，正在播放的视频句柄可能被淘汰，之后的 Range 请求失败，播放中断 | 正在读取的句柄优先保留（计划 P2） | `packages/app-core/src/media/handles.ts`：`resolve()` 时把记录移到最新端，改为最近最少使用淘汰 | `tests/media/serve.test.ts` 新用例 “keeps a handle that is still being read when the table fills up”。**A 已核实关闭** |
| F-04 / P2 | 干净检出提交后重算的指纹与证据不一致，审查者无法证明证据属于这个提交。原因：工作区有 89 个文本文件为 CRLF，而仓库按 `.gitattributes` 存 LF | 证据指纹必须能从提交复现（[质量门禁](../dev-rules/quality-gates.md)） | `scripts/stage/lib.mjs`：新增 `storedBytes`，按仓库保存的字节（LF）计算；含 NUL 字节的二进制文件不变 | `scripts/stage-report.test.mjs` 新用例：LF 与 CRLF 同指纹、改内容指纹变、二进制不改写。修复后重跑四份证据，amend 后干净检出的指纹见 14.2。**A 已核实关闭** |
| F-05 / P3（证据缺口） | 计划 P4 要求的 1/10/30 个视频会话的 CPU、内存与恢复时延实测没有执行 | 计划 P4 | 渲染进程只挂载当前资源的 `VideoPlayer`，切走即卸载并释放解码，非活动会话只保留位置，所以占用与会话数无关 | 不返工，转入 [Q-11](../../USER-ACTIONS.md#q-11)：推荐不后台播放、切走即释放；若 H-M2-04 中切换资源的等待不可接受，再补实测。**转入 Q-11** |
| F-06 / P3（文档） | 智能体与设置模块文档仍引用已迁移的 `tests/m1a/...`；本报告 C4 行与第 11 节的 POC-03 路径写错；POC-03 未记入 `limits.json` | 正本路径须真实；每个 not-run 项在 `limits.json` 与第 11 节都有负责人与复测入口 | `docs/modules/agent.md`、`docs/modules/settings.md`、本报告第 3、11 节、`m2/limits.json` | 已改正，`check-docs` 通过；`limits.json` 现 6 条，均有负责人与复测入口，报告门禁通过。**A 已关闭** |
| F-07 / P3（流程） | jsdom、lucide-react、pi-ai、jassub 四个例外因最新版未满最小发行龄而退回基线版本，没有取满足发行龄的最新版本 | ADR-0007 的升级口径 | [ADR-0007](../decisions/0007-technology-stack.md) 例外说明 | 不影响 M2 功能；已在 ADR 记录，下一次依赖盘点按此执行。**记录，不返工** |
| F-08 / 文案 | 动漫页的书架页签、状态与卡片进度沿用小说的“在读/想读/已读、已读 x%” | 文案贴合媒介（[设计规则](../design-rules/DESIGN.md)） | `packages/i18n/src/messages-media.ts` 的 `shelf.*`、`card.read` | 文案取舍需要用户决定，转入 [Q-18](../../USER-ACTIONS.md#q-18)，推荐“在看/想看/看过、已看 x%”。**转入 Q-18** |
| F-09 / P3（如实说明） | Agent 右栏附图提示写“不会保存”，但图片字节随任务快照存入 `agent_runs.snapshot_json`（重试与继续需要），也随完整备份保存 | 界面不对数据去向作不实陈述（[产品原则](../product-rules/core-product-principles.md)）；问题 B 的结论 | `packages/i18n/src/messages-media.ts` 的 `rp.attach.hint` | 改为“会随这次任务的记录保留，以便重试和继续，但不会存为附件，也不会进入资料包”，并重跑证据。**A 已关闭** |
| F-10 / P3（门禁稳定性） | A 的三次完整打包烟测中有一次失败，发生在完整 Vitest 刚跑完、机器负载高的时候：formats 阶段的 PDF 已绘制，文本层里也有含标记的那个 span，但脚本一次性选中后 4 s 内“记笔记”按钮没有启用（`pdfDebug.selected: false`）。紧接着的完整重跑通过；单独运行该阶段 10 次全部通过 | 阶段门禁应当稳定，失败能定位原因（[质量门禁](../dev-rules/quality-gates.md)） | `apps/desktop/src/main/smoke/index.ts` 的 formats 阶段只选一次，不等文本层稳定；`apps/desktop/src/renderer/pdf-page.tsx` 在宽度或 `storedText` 变化时重绘页面并清空文本层。推测是首次绘制后的重绘移除了刚选中的节点，**未证实**。入库证据来自通过的那一轮 | 不放宽门禁、不加重试，登记为 [LOOP-06](../delivery/status.md#loop-06)：先在烟测里记录选中时与失败时的 `data-pdf-epoch`、节点是否仍在文档中，再决定是等文本层稳定后再选，还是消除阅读器打开时的重复绘制；复测为负载下连续运行 formats 阶段与完整 `package`。**转入 LOOP-06** |

核对后无问题、不列发现的项：悬浮窗复用主窗口的 preload，但每个 IPC 处理都断言来自主窗口的主框架；CSP 未放宽；启动时的随包资产检查只比大小，哈希在打包时核对；v7 迁移在事务内执行，迁移前有备份；zip 池的条目预算、压缩比、不安全名称与加密条目拒绝都有反例；缺视觉能力时插入如实说明的回复并以 `MODEL_CAPABILITY_MISSING` 结束；提交里没有凭据，也没有真实资源的名称或路径。

### 14.4 问题 A/B/C、B 的实施决定与计划外改动

- **问题 A（加密 PDF 放宽）：保持放宽。** 所有者密码限制打印、复制等权限，不阻止打开，也不是 DRM。漫画路径交给 PDF.js 判定，需要打开密码的仍以 `UNSUPPORTED_FORMAT` 拒绝；加密的压缩包、EPUB 与 MOBI 照旧拒绝；文本 PDF 路径仍预先拒绝 `/Encrypt`。已写入[需求 5.3](../product/requirements.md)。
- **问题 B（快照里的图片字节）：M2 保持在快照中。** 字节有上限（最多 4 张、每张 ≤ 1.5 MB、每任务 ≤ 4 MB），同一任务重试或继续必须发出同一画面；列表不读取，公开的运行详情去掉 base64，资料包不含运行记录，完整备份包含。改为附件引用登记为 [LOOP-05](../delivery/status.md#loop-05)；界面文案同步修正（F-09）。已写入[智能体模块](../modules/agent.md)。
- **问题 C（字幕窗口语义）：确认。** 上限默认为当前位置；开启 `spoilerGuard` 时取当前位置与“到达当前位置的已看区间末端”中较小的一个；用户显式放宽时为当前位置加放宽量，只对该次任务有效。跳过的前段不算剧透来源，工具路径用同一上限且只读该任务的视频。已写入[视频模块](../modules/video.md)。
- **B 的实施决定（第 10 节），全部接受**：
  - 漫画默认从右到左：符合主要样本，设置可改，偏好归 Q-12。
  - F9 按住、F8 切换：只在应用内生效，不注册全局热键；默认值归 Q-05。
  - 录音时视频降到 30%：可改为暂停或不变，归 Q-05。
  - 副驾驶并入右栏：与 Agent 页共享同一会话，AT-49 文字已同步。
  - 换音轨走重封装：不重新编码，原文件不动，副本在缓存可删；代价归 Q-17。
  - 媒介类型属于资源：与[领域模型](../design/domain-model.md) 4.3 一致，改类型不新建修订、不搬迁锚点。
- **计划外改动，全部接受**：
  - `WorksCacheContext`：按窗口缓存书架首页结果（最多 24 个查询），再次显示时立即绘制并在后面刷新；不跨窗口，不替代主进程的权威数据。
  - `readyState` 补查：处理监听器挂上前 `loadedmetadata` 已触发的标准做法，有定位测试。
  - `waitFor` 默认 5 s：只是等待上限，断言没有改动；需要更短等待的用例自带超时。
  - `check-deps` 规则细化：允许包内上级目录的相对导入，离开包的相对导入改为报错（有自测反例）；`app-core` 新允许 `sharp`、`yauzl`、`anitomy`、`zod`，都有实际使用方，`electron` 仍禁止。
  - `check-publication` 未放宽：攻击用例的字符串在运行时拼接，样本都是合成名称，检查规则本身没有改动。

### 14.5 LOOP 与限制

- **LOOP-01 关闭**：资源库、三种阅读/播放页与右栏已按参考图重做，`App.tsx` 由 1693 行拆到 861 行；最终视觉仍由 Q-08 评审。
- **LOOP-02 关闭**：Electron 44.5.1 等主版本升级后完整回归与打包烟测通过；保留旧版的 8 项例外及复查条件在 ADR-0007，F-07 的口径用于下一次盘点。
- **LOOP-04 等用户**：L1 已定位到样本生成器，用户在稳定包上做 H-01 复核后由 A 关闭。
- **LOOP-05 新增**：快照图片改附件引用（问题 B）。
- **LOOP-06 新增**：打包烟测 formats 阶段 PDF 选区的偶发失败（F-10）。
- `m2/limits.json` 共 6 条 not-run，均有负责人与复测入口：ACT-05、ACT-06、H-01、无硬件 HEVC 的副本播放、10 位 HEVC 样本、POC-03 的 x264/x265。第 11 节的表与之一致。

### 14.6 给用户的集中清单与下一步

**启动稳定包（隔离资料）**：打包版由最后一次 `node scripts/stage.mjs m2 package` 生成，对应本提交。用一个临时文档目录启动，资料与启动指针都写到 `dist/manual-m2/MANGA/release/` 下，不碰真实“文档”目录；重来时删掉该目录即可。Electron 自己的缓存仍在系统用户数据目录。

```bash
MANGA_DOCUMENTS_DIR="$PWD/dist/manual-m2" ./dist/desktop/packages/MANGA-win32-x64/MANGA.exe
```

合成样本在 `dist/samples/m2/`（没有时运行 `node scripts/samples/generate-media-samples.mjs`）。

1. **ACT-06**：按第 12 节执行 H-M2-01—07 与 H-01 复核，逐项记 passed/failed 与现象；外放误收录、设备断开、切换资源等待等观察写清条件。
2. **答复**：Q-05、Q-08、Q-10—Q-15、Q-17—Q-21（推荐见[用户待办](../../USER-ACTIONS.md)）；ACT-01 的 H-01 复核并入 ACT-06；ACT-05 是否授权合成文本与合成图片各不超过 10 次的真实 LLM/视觉调用（不授权也不阻塞）。
3. **LOOP 确认**：LOOP-01/02 已由 A 关闭；LOOP-04 在 H-01 通过后关闭；LOOP-05、LOOP-06 新增。
4. **远端动作只作推荐**：人工检查通过并回写后，推荐 push `feat/m2-media-mvp` 并创建到 `main` 的 PR。只有用户明确要求才执行。

**首选下一步：用户在稳定包上集中执行 ACT-06 并答复上面的问题。** 依据：技术审查已收敛，没有交回 B 的返工；剩下的都需要人、设备或授权。若人工检查发现缺陷，由 A 按编号列出交 B 返工；全部通过后再决定 push/PR。

## 15. 人工试用反馈与返工发现（2026-10-06）

用户 2026-10-06 在 `e09802f` 的打包版上试用后分四条消息提出反馈。A 按[交接模板第 3 节](../templates/agent-handoff.md#3-a--用户或-b集中审查)整理为下表：先在打包版上用合成样本与独立临时资料复现，再读对应代码；复现脚本与截图留在 A 的临时目录，未入库。这次试用是用户的整体反馈，不是按第 12 节逐步执行的人工检查，所以 H-M2-01—07 仍为 not-run；返工后的人工步骤见[计划 14.8](../delivery/m2-media-mvp-plan.md#148-返工后的人工检查)。

用户的决定已写入 A-47—A-52（含 Q-20、Q-21 的答复）。返工计划是[计划第 14 节](../delivery/m2-media-mvp-plan.md#14-人工反馈返工2026-10-06)，由 B 一次完成，A 复核。下表“类别”区分两种情况：缺陷是已交付行为不符合需求、计划或参考；新需求是用户这次提出、原计划没有的要求。

### 15.1 发现清单

| 编号 / 严重度 / 类别 | 触发与实际结果 | 预期与依据 | 位置/证据 | 返工与验收 |
| --- | --- | --- | --- | --- |
| F-11 / P1 / 缺陷 | 漫画缩放到 75% 后页面消失：舞台高度塌到 18 px，页面只剩 1×2 px。同一根因的其他表现：125% 时页面高 1209 px 而不是 875 px；100% 适配整页时页面高度固定在 700 px（回退值），与窗口大小无关，大窗口下页面被裁切 | 缩放与铺满可用，页面身份与视图独立（READ-02、AT-22）；交互设计 3.4 | `readers/comic-reader.tsx` 量舞台尺寸来算页面大小，而舞台高度又随页面变化（`styles-reader.css` 的 `.comic-stage` 上层没有确定高度），形成反馈。A 在打包版上测得上述数值 | W1；AT-68 的尺寸不变量 |
| F-12 / P2 / 缺陷 | 打开一个漫画或动漫后，点“漫画”或“动漫”导航仍回到正在打开的资源，书架无法到达，也就没有入口打开另一部作品 | 导航到书架，资源会话从左栏恢复（UI-07；交互设计 3.4 的共享壳） | `App.tsx` 的 `goPage` 只在再次点击同一导航时关闭阅读器；书架页在有打开的资源时总是渲染阅读器 | W2；AT-65 |
| F-13 / P2 / 缺陷 | 未关联外部资料的作品，资料页签几乎为空，作者、简介等字段无法手动填写 | 手动修正作品信息（LIB-02、META-02 的用户覆盖） | `pages/work-detail.tsx` 不渲染值为空且未锁定的字段 | W2、W7；AT-65 |
| F-14 / P2 / 缺陷 | 导入目录时窗口卡顿；检查文件的阶段没有进度，看不出进行到哪里 | 导入有进度、可取消（LIB-01）；界面反馈 p95 ≤ 100 ms（需求 6.2） | `comic/scan.ts` 的 `planDirectory` 用 `readdirSync`，`importNovelDirectory` 与 `inspectFile` 同步读文件，都在主进程执行；`import.progress` 只在目录导入时发出 | W6；AT-63 与 bench 的事件循环延迟门槛 |
| F-15 / P3 / 缺陷 | 动漫播放器的控制条是深蓝底白字，与应用的白灰粉不一致 | 白灰粉主题（UI-03）；按参考统一视觉（A-44） | `styles-video.css` 使用 `--color-player: #151925` | W9；AT-68 的控件检查 |
| F-16 / P3 / 缺陷 | 标题栏有一个麦克风按钮，点击打开录音回顾，用户看不出它的用途 | 标题栏只显示真实录音状态与停止（VOICE-01） | `App.tsx` 的 `titleExtra` | W2：删除，录音入口移到右栏 |
| F-17 / P3 / 缺陷 | 左栏会话行显示“标题 · 资料 · 0”之类的内部计数，没有封面与位置 | 会话行显示小封面、标题与当前话/页（交互设计 3.4） | `shell.tsx` | W2 |
| F-18 / P2 / 缺陷与新需求 | 漫画页按钮多，不如参考图简洁（缺陷：未按 3.4 精简）；用户进一步要求所有主页面只留常用操作，其余收进“…”，例如漫画阅读方向（新需求，A-47） | 交互设计 3.4 与 3.5 | 漫画工具栏、播放器与小说工具栏 | W9；AT-68 |
| F-19 / P2 / 新需求 | 导入移到设置：添加资源库路径并按间隔后台扫描，有进度；主面板不显示导入，资源库为空时才跳到设置（A-50） | 交互设计 3.5；领域模型 4.4 | 现为书架页的导入对话框 | W6、W2；AT-63 |
| F-20 / P2 / 新需求 | 右栏应是聊天窗口：笔记是关联当前位置的气泡，录音与记笔记在输入框或悬浮胶囊，“尚未配置模型”提示在右栏；阅读时主面板只读（A-48） | 交互设计 3.5；领域模型 7.1 | `pages/agent-pane.tsx`、`agent-media-panel.tsx` 为状态列表 | W3；AT-64 |
| F-21 / P3 / 新需求 | 标题栏按钮打开主面板下方的上下文调试面板（A-47） | 交互设计 3.5 | 无 | W4；AT-67 |
| F-22 / P2 / 新需求 | 对话页不显示右栏，整页是对话，类似 Codex、Claude（A-47） | AGENT-06；交互设计 3.5 | `App.tsx` 中对话页 `hasRight` 为真 | W4；AT-67 |
| F-23 / P2 / 新需求 | 点击作品进入作品主页（类似 Bangumi 条目页），按“阅读/观看”才打开文件，不直接跳进资源会话（A-47） | LIB-02；交互设计 3.5 | `openWork` 直接打开最后的资源 | W2；AT-65 |
| F-24 / P2 / 新需求 | Bangumi 匹配只在作品主页手动发起，可按条目 ID 关联（如 `subject/464376`），不自动同步，防止覆盖本地修改（A-51） | META-02；交互设计 3.5 | `pages/work-match.tsx` 只能关键词搜索；书架有“为未匹配作品查找”批量入口 | W7；AT-65 |
| F-25 / P2 / 新需求 | 设置改为独立界面，分组为基础设置、Agent 能力（模型、使用记录）、日志；另有统一管理与筛选笔记和录音的页面；录音归属作品（A-49） | 交互设计 3.5；VOICE-07、MODEL-03、DATA-02 | `pages/settings-pane.tsx` 为平铺页；没有日志与用量记录 | W5；AT-66 |
| F-26 / P2 / 新需求（Q-20） | 网络同步的作品资料、封面原图、角色与声优等都存进数据库（A-51） | META-03；领域模型 4.3、11.1 | 现为封面原图存附件文件，未保存角色与人员 | W7；AT-65、迁移测试 |
| F-27 / P3 / 新需求（Q-21） | 快捷任务由用户在设置中配置，每个是一个提示词模板（A-52） | AGENT-06；交互设计 3.5 | `agent-media-panel.tsx` 的 `quickTasksFor` 写死 | W8；AT-66 |
| F-28 / P3 / 流程 | 返工会改动三种阅读器与打包烟测，满足 LOOP-06 的触发条件 | [LOOP-06](../delivery/status.md#loop-06) | `apps/desktop/src/main/smoke/index.ts`、`pdf-page.tsx` | W10 |

### 15.2 A 审查为什么没有发现 F-11、F-12

第 14 节的审查集中在代码、失败路径与证据，没有在打包版上做缩放小于 100% 和“打开资源后切换导航”这两个操作。现有 Electron 场景只断言漫画页加载完成与页码，没有断言页面几何；导航场景只覆盖首次进入。返工增加 AT-68 的几何不变量与导航回到书架的场景（计划 14.6），A 复核时在打包版上逐项操作 14.8 的步骤后再给结论。

### 15.3 状态

- 第 14 节的技术审查结论（无返工）被本节取代：M2 进入返工，B 按计划第 14 节一次完成，A 复核。
- 四份证据（test、bench、package、report）仍对应 `e09802f` 的代码；本节只改文档，不使它们失效。B 返工后四份证据全部重跑。
- `productAcceptance` 保持 not-run；ACT-06 的正式人工检查在返工复核收敛后进行。

## 16. 返工交付（2026-10-06）

B 按[计划第 14 节](../delivery/m2-media-mvp-plan.md#14-人工反馈返工2026-10-06)一次连续完成 W1—W10，没有逐包等待确认；A-47—A-52 与[交互设计 3.5](../design/interaction-and-workflows.md)是依据，[第 15 节](#15-人工试用反馈与返工发现2026-10-06)的 F-11—F-28 是发现来源。本节只记 B 的自检结果，**不计算产品验收**：`productAcceptance` 仍为 not-run，H-M2-01—10 与 H-01 复核均未执行。第 1—13 节已按返工后的事实更新，第 14、15 节未改写。

### 16.1 结论

| 项目 | 结果 |
| --- | --- |
| 范围 | W1—W10 全部实施，没有整体 blocked 的工作包；返工前的行为（计划 14.1）与 A 审查修复（F-01—F-04、F-06、F-09）保留，原 54 个必需用例一个不删、不减 |
| 自动化（`stage m2 test`） | passed：必需用例 81/81（原 54 + 返工 27），Vitest 1184 个用例：1177 passed、0 failed、7 skipped（均为默认关闭的真实服务探针）；`scripts/stage-report.test.mjs` 门禁反例 14/14 |
| 打包烟测（`stage m2 package`） | passed：11 个阶段；`rework` 阶段 21 个窗口观察全部 passed（`scenarios.json`，`productAcceptance` 为 not-run） |
| 基准（`stage m2 bench`） | passed：原 17 项加 2 项新门槛全部在目标内；5000 文件扫描：主进程事件循环延迟 p99 13.3 ms（≤ 100）、扫描期间常用操作答复 p95 7.4 ms（≤ 100）；记录项：吞吐量 378.5/392.7/394.9 文件/秒、封面与 1000 条消息的右栏（第 8 节） |
| 报告门禁（`stage m2 report`） | 退出码 0（`errors: []`、`automationStatus: self-check-passed`、`engineeringReviewable: true`）；`productAcceptance` 恒为 not-run |
| `verify.mjs` | passed（退出码 0）：文档检查（63 篇文档、719 个本地链接、75 条需求、68 个验收用例）、公开内容检查（567 个文件、1063 份快照）、依赖边界、类型检查与单元/集成测试、`stage-report` 与 `check-docs` 的脚本测试；与阶段 `test` 的区别是不开启 10 MiB/30 MiB 大文件读取，所以跳过数多 2 个 |
| 真实服务 | Bangumi 只读契约 9 个请求 passed（新增角色与人员端点）；ASR 契约沿用；LLM 整理与视觉/OCR 的真实调用未授权（ACT-05） |
| LOOP-06 | 已按 W10 处理：formats 阶段在 20 个线程满载下连续 10 次通过，完整 `package` 通过；关闭由 A 复核后决定（16.7） |
| 人工检查与产品验收 | **not-run**（H-M2-01—10、H-01 复核；步骤见第 12 节） |

### 16.2 W1—W10：实现位置、验证证据与状态

下表的文件路径相对 `apps/desktop/src/renderer/`（以 `app-core/`、`contracts/`、`storage/` 开头的相对 `packages/app-core/src/`、`packages/contracts/src/`、`packages/storage-drizzle/src/`）。

| 工作包 | 实现位置 | 验证证据 | 状态与限制 |
| --- | --- | --- | --- |
| **W1** 漫画缩放与页面布局（F-11） | `readers/comic-model.ts`（`pageBoxes`：页面尺寸 = 适配基准 × 缩放，基准只由舞台尺寸决定）、`readers/comic-reader.tsx`（阅读器根占满主面板；量舞台，不量内容；滚动条占位后按剩余宽度适配）、`styles-reader.css`。小说双页与播放器量的是外框而不是自己的内容，没有同类反馈；PDF 页在滚动条出现时改变所量宽度的问题是 LOOP-06 的根因（16.7） | R-01（13 个用例）、AT-68（12）；窗口：`rework` 阶段 `comic-layout-{wide,narrow,short}-{page,width,height}` 9 个观察，每个按 100%/125%/200%/75%/50% 断言页面 = 基准 × 缩放（±1 px）、舞台尺寸不变、缩小居中、放大可滚动、整页适配时整页可见、不出现侧向滚动 | done，窗口观察 9/9 passed；AT-68 捕获并修复了一处 W1 自身缺陷（16.6 第 5 条）；手感归 H-M2-03 |
| **W2** 壳、导航与作品主页（F-12、F-13、F-16、F-17、F-23） | `shell.tsx`、`lib/shell-model.ts`（导航与设置分组）、`pages/work-home.tsx`、`pages/shelf.tsx`、`lib/shelf-memory.ts`（返回时保留筛选/搜索/排序/页签）、`components/toast.tsx`（短暂通知取代常驻横幅）、`components/title-actions.tsx`、`App.tsx` | R-02（4）、R-03（3）、R-04（3）、AT-60—62（回归）；窗口：`starts-on-library-paths`、`work-home-open` 观察 passed | done；删除标题栏回顾按钮、“笔记”导航；空库起始于设置的“资源库”；键盘可达与滚动保留的手感归 H-M2-05 |
| **W3** 右栏聊天窗口（F-20） | `components/chat/{chat-pane,chat-view,composer,messages,capsule,materials-dialog}.tsx`、`hooks/use-chat.ts`、`hooks/use-session-stream.ts`、`lib/chat-model.ts`、`lib/quote-tags.ts`；`app-core/ops/stream.ts`（`session.stream`）、`notes.delete`/`notes.undelete`（软删除）；依赖 `use-stick-to-bottom` 1.1.6 | R-10（8）、R-11（2）、R-12（6）、R-19（3）、AT-64（10）；窗口：`right-pane-note` 观察 passed；voice 阶段的麦克风步骤 | done；一个来源超过一页时更早的消息逐页取回（16.6 第 8 条）；设备相关与长按行为归 H-M2-06 |
| **W4** 对话页与调试面板（F-21、F-22） | `pages/debug-panel.tsx`、`lib/debug-redact.ts`；`debug.context`（`app-core/product-app.ts`） | R-13（7）、R-19（3）、AT-67（7） | done；窗口里没有驱动调试面板（第 11 节），归 H-M2-08 |
| **W5** 设置独立界面（F-25） | `pages/settings/*`（常规、外观、阅读、录音、资源库、来源、存储与备份、模块、快捷键、模型、快捷任务、使用记录、记录、日志，共 14 页，4 组）、`pages/settings-media.tsx`；`app-core/ops/{operation-log,records,usage}.ts`（`log.query`、`records.list`、`usage.query`）；schema v8 的 `operation_log` 与 `agent_runs` 用量列 | R-14（17）、R-15（3）、R-16（4）、R-17（2）、AT-66（16）；窗口：`settings-pages-reachable` 观察（4 组、14 页逐页进入） | done；日志保留 180 天或 5 万条；资源总览在“存储与备份” |
| **W6** 资源库路径与后台扫描（F-14、F-19） | `app-core/library-scan/{walker,plan,service}.ts`（worker 遍历、比对计划、调度/进度/取消）、`hooks/use-scan.ts`、`pages/settings/library-page.tsx`、`pages/import-dialog.tsx`（检查阶段异步、有进度）；`app-core/media/job-queue.ts`（任务之间让出事件循环）；`storage/sql.ts`（扫描相关表与两个索引） | R-09（16）、R-21（4）、AT-63（11）；bench：5000 文件扫描 3 次（第 8 节）；窗口：`library-paths-add-scan` 观察（添加三类路径、扫描中进度可见并结束） | done；扫描基准在 Node 进程里测，不是 Electron 主进程本身（第 11 节）；真实收藏上的体验归 H-M2-01 |
| **W7** 元数据：手动匹配与数据库存储（F-24、F-26） | `app-core/metadata/ref.ts`（编号与链接解析）、`images.ts`（图片表）、`service.ts`（`metadata.resolveRef`/`preview`/`characters`，角色与人员保存）、`pages/work-match.tsx`、`pages/work-home.tsx`；`storage/sql.ts`（`V8_SCHEMA_SQL`：`images`、`subject_characters`、`subject_persons`、`covers.image_hash`）；资料包导出附带封面原图且可取消 | R-04—R-08（共 32 个）、AT-65（11）；v6 与 v7 合成库迁移；真实只读契约 9 个请求（第 9 节） | done；书架的“为未匹配作品查找”入口已移除（命令保留，只生成候选）；Q-20 按原推荐实现；真实收藏与断网重启归 H-M2-02 |
| **W8** 快捷任务模板（F-27） | `app-core/quick-tasks.ts`、`contracts/quick-tasks.ts`、`pages/settings/quick-tasks-page.tsx`、`components/chat/composer.tsx`；schema v8 的 `quick_tasks` 表（内置默认带 `builtinKey`，可修改、可恢复） | R-18（11）、AT-66 | done；占位符：作品、作者、当前位置、选区、字幕窗口、用户输入，未知占位符保存时拒绝，缺内容时渲染为空并在消息里说明 |
| **W9** 阅读器与播放器精简（F-15、F-18） | `reader/toolbar.tsx`、`readers/comic-reader.tsx`、`readers/video-player.tsx`、`reading.tsx`、`styles.css`（语义 Token）、`styles-video.css`、`styles-reader.css`；`lib/quote-tags.ts`（选区、区域、时间点与 A-B 区间成为右栏引用标签） | R-20（10）、AT-68；窗口：`player-controls-*`、`novel-controls-*` 共 6 个观察（控件条在窗口内、播放/“…”可达、“…”面板不被裁切、无侧向滚动）；AT-22、AT-23、AT-52、AT-53 重跑 | done；三种页面移除记笔记与录音按钮；与参考图并排对比只在本机进行，未入库 |
| **W10** LOOP-06、回归与交付 | `pdf-page.tsx`、`apps/desktop/src/main/smoke/{formats,rework}.ts`；`scripts/stage/*`、`scripts/stages/m2.json`（81 个必需用例）；各模块文档 | 四份证据全部重跑；formats 阶段负载下连续 10 次通过；测试改写映射（16.5） | done；LOOP-06 由 A 复核后关闭 |

### 16.3 AT-63—68 与重跑 AT 的结果

“自动化”指本提交上的 Vitest 用例；“窗口”指打包烟测在真实窗口里的观察。所有产品验收为 not-run，passed 只表示自动化子场景。

| AT | 自动化 | 窗口 | 状态 |
| --- | --- | --- | --- |
| AT-63 资源库路径与扫描 | passed（11） | `starts-on-library-paths`、`library-paths-add-scan` passed；5000 文件扫描的事件循环与答复门槛 passed（Node 进程内测量） | 自动化 passed；真实收藏与扫描中退出/移除路径/定时扫描的手感 not-run（H-M2-01） |
| AT-64 笔记气泡与胶囊 | passed（10） | `right-pane-note` passed；voice 阶段麦克风与语音气泡步骤 passed | 自动化 passed；设备与长按 not-run（H-M2-06） |
| AT-65 作品主页与匹配 | passed（11） | `work-home-open` passed；匹配、差异预览用假 Bangumi 服务端测试，窗口里未驱动 | 自动化 passed；真实匹配与断网重启 not-run（H-M2-02） |
| AT-66 设置、记录、日志、快捷任务 | passed（16） | `settings-pages-reachable` passed（4 组、14 页） | 自动化 passed；not-run（H-M2-09、H-M2-10） |
| AT-67 调试面板 | passed（7） | 窗口里未驱动 | 自动化 passed；窗口 not-run（H-M2-08） |
| AT-68 漫画与播放器布局 | passed（12） | 9 个页面尺寸观察 + 6 个控件观察 + 1 个胶囊不遮挡观察（6 次量取，含笔记框展开）passed（宽 1280×840、窄 360×780、矮 1100×460） | 自动化与窗口 passed；系统 125%/150% 缩放与手感 not-run（H-M2-03/05） |
| AT-03 进度 | passed（13） | media 阶段重跑 passed；rework 的作品主页打开与恢复 | 自动化 passed |
| AT-16 布局/键盘/输入法 | passed（26） | rework 的控件观察 passed | 自动化 passed；真实输入法 not-run |
| AT-22 漫画阅读 | passed（35） | media 阶段逐样本开窗 passed；AT-68 窗口观察 | 自动化 passed |
| AT-23 视频播放 | passed（68） | media 阶段逐样本播放与帧号落点 passed | 自动化 passed；手感 not-run（H-M2-04） |
| AT-39、AT-40、AT-41 来源字段、限流/断网、换源 | passed（12、10、9） | — | 自动化 passed |
| AT-53 格式矩阵 | passed（24） | media 阶段支持矩阵（第 7 节） | 自动化 passed |
| AT-56 Bangumi | passed（26） | 真实只读契约 9 个请求 passed（第 9 节） | 自动化 passed；真实契约 passed（有限范围） |
| AT-58 音频保留 | passed（14） | voice 阶段重跑 passed | 自动化 passed；设备 not-run（H-M2-06） |
| AT-59 来源映射 | passed（24） | voice 阶段重跑 passed | 自动化 passed |
| AT-60、AT-61、AT-62 壳与导航 | passed（3、2、2） | rework 阶段；原烟测阶段 passed | 自动化 passed；真实窗口缩放 not-run（H-M2-05） |

没有 failed 或 blocked 的项目；blocked 只可能来自网络（Bangumi 真实契约，本次可达）与设备（H-M2-06/07），均已在第 11 节列明。

### 16.4 第 15 节各发现的处理结果（F-11—F-28）

| 编号 | 处理 | 位置 / 证据 | 结果 |
| --- | --- | --- | --- |
| F-11 缩放后页面消失 | W1：舞台量框、页面 = 基准 × 缩放 | R-01、AT-68；窗口 9 观察 | 已修复；自动化与窗口 passed |
| F-12 导航回不到书架 | W2：导航始终打开书架，资源会话从左栏恢复 | R-02；窗口 `work-home-open` | 已修复；自动化与窗口 passed |
| F-13 资料页签空字段不可填 | W2/W7：空字段可填、锁定、恢复来源值 | R-04、AT-65 | 已修复；自动化 passed |
| F-14 导入卡顿且无进度 | W6：遍历与探测移出主进程，检查阶段有进度，进度通知节流 | R-09、AT-63、bench 扫描 | 已修复；自动化与 bench passed |
| F-15 播放器深蓝控制条 | W9：浅色表面、灰图标、粉色进度，颜色只用语义 Token | R-20；窗口控件观察 | 已修复；自动化与窗口 passed；与参考图对比仅本机 |
| F-16 标题栏麦克风按钮 | W2：删除；录音入口在右栏与胶囊 | `media-flows` 改写用例、AT-64 | 已修复；自动化 passed |
| F-17 会话行内部计数 | W2：小封面、标题与位置 | R-02 | 已修复；自动化 passed |
| F-18 按钮多、主页面只留常用操作 | W9：阅读方向等收进“…” | R-20、AT-68、窗口控件观察 | 已实现；自动化与窗口 passed；视觉评审归 Q-08 |
| F-19 导入移到设置并后台扫描 | W6 | AT-63、R-09 | 已实现；自动化 passed；not-run（H-M2-01） |
| F-20 右栏聊天窗口 | W3 | AT-64、R-10—R-12 | 已实现；自动化 passed；not-run（H-M2-06） |
| F-21 上下文调试面板 | W4 | AT-67、R-13 | 已实现；自动化 passed；not-run（H-M2-08） |
| F-22 对话页无右栏 | W4 | R-19 | 已实现；自动化 passed |
| F-23 作品主页 | W2 | R-03、窗口 `work-home-open` | 已实现；自动化与窗口 passed |
| F-24 手动匹配、按 ID/链接关联 | W7：匹配只从作品主页发起，编号与链接解析，差异预览 | R-05、R-06、AT-65；真实契约 9 个请求 | 已实现；自动化 passed；not-run（H-M2-02） |
| F-25 设置独立界面、记录与日志 | W5 | R-14—R-17、AT-66；窗口 14 页 | 已实现；自动化与窗口 passed |
| F-26 资料入库（封面原图、角色、人员） | W7：图片表、角色/人员表、v7 → v8 迁移 | R-07、R-08、AT-65 | 已实现；自动化 passed |
| F-27 可配置快捷任务 | W8 | R-18、AT-66 | 已实现；自动化 passed；not-run（H-M2-09） |
| F-28 / LOOP-06 | W10：诊断与单次绘制修复 | R-21、formats 阶段 ×10 负载 | 已处理；待 A 复核后关闭（16.7） |

### 16.5 测试改写映射（旧 → 新，断言不减，减少的有理由）

所有原有测试保留；因流程变化而改写的，旧用例与新用例一一对应如下。未列出的原有用例没有改动。

| 旧（文件 · 用例） | 新（文件 · 用例） | 说明 |
| --- | --- | --- |
| `tests/shell/agent-media-panel.test.tsx` 整个文件（13 个 + 4 个用例，右栏“媒体”区） | `tests/shell/chat-composer.test.tsx`（同一批断言，入口由右栏状态列表改为聊天输入框与“+”菜单；加上快捷任务占位符、笔记锚点、引用标签等新用例） | “says so when no reader is open…”→“offers no picture or subtitle choice when no reader is open…”；“follows the comic page…”→“offers the comic page's quick tasks and attach-page, and sends…”；“follows the video moment…”→同名前缀改为引用标签；“lists attached pictures…”→“…as tags…”；字幕范围、在线搜索、时钟不重绘、录音材料 ≤ 3 个、上下文构建三项原样保留；相关作品 3 个用例改为作品主页上的同样断言 |
| 同上 · “disables the quick tasks and the attach button while a task runs” | `chat-composer` · “holds the quick tasks that send while a task runs, and lets the ones that only fill the input through” | 减少一条断言：运行中“附加”按钮不再禁用（用户可为下一次任务准备材料，发送仍被挡住）；理由见 16.6 第 1 条 |
| `tests/shell/agent-send-media.test.tsx` · “sends the page the user is on, with a picture of it, …” | 同文件 · “…with a picture of it from the \"+\" menu, …” | 入口改为“+”菜单，断言不变；另增 2 个用例（区域标签发送、A-B 区间发送） |
| `tests/shell/app-restore.test.tsx` · “sends from the composer, shows the history in the side Agent, stops, and restores after remount” | 同文件 · “sends from the chat page, shows the history in the side pane, …” | 对话页发送、右栏显示历史；断言不变；另增“空库起始于资源库路径页，有作品时起始于书架” |
| `tests/shell/media-flows.test.tsx` · 10 个用例（从书架直接打开、笔记按钮、标题栏录音入口、作品详情） | 同文件 · 同序用例，名称里的“shelf”改为“work's page”，“note the interval”改为“turns a marked interval into a tag in the right pane, and a note typed there into a time-located note”，“record control in the player”改为“microphone in the right pane, not in the player or the title bar” | 打开资源改走作品主页；播放器与标题栏上被移除的控件，由“不存在”的断言取代原点击断言（A-47/A-48） |
| `tests/shell/shelf.test.tsx` · “shows the empty library once, with an import entry…” | 同文件 · “…with a way to add a library path and no import button…” | 导入入口移到设置（A-50）；另增 3 个用例（空类别说明、卡片进作品页、书架返回时保持） |
| `tests/shell/shell-ui.test.tsx` · “shows the opened resource sessions under the left navigation” | 同文件 · “…grouped by medium, with where each one is” | 会话行显示封面与位置；另增 4 个用例（对话页会话列表、设置导航、胶囊、当前页标记） |
| `tests/shell/settings-media.test.tsx` · 13 个用例（`MediaSettings` 一个面板） | 同文件 · 同 13 个用例，改为同时渲染 `Modules`、`MediaPrefs`、`Recording`、`Providers` 四个页面组件 | 设置拆成独立页面；每个选择的断言不变；另增“只在模块停用时从设置导航里去掉对应页面”1 个用例 |
| `tests/reading/comic-reader.test.tsx` · “turns a drag on the page into a note on that region…” 与工具栏/“…”相关的 2 个用例 | 同文件 · “…into a quote tag for that region, with the page it is on, and leaves the frame drawn until the user is done” 与先打开“…”再断言的同 2 个用例 | 阅读器只读，没有记笔记按钮，区域成为右栏引用标签（`onNote` 的调用断言由标签断言与按钮不存在断言取代）；另增 W1 的 6 个尺寸用例 |
| `tests/reading/video-player.test.tsx` · “marks A and B with the keys, orders them, and notes the interval” 与 “notes the moment now”，以及 ~16 个需要“…”面板的控件用例 | 同文件 · “…and makes the interval a quote tag for the right pane”，“clears the marks when the tag is removed in the right pane”，“has no note button for the moment now, in the controls or in the right-click menu, and leaves no tag behind when it closes”；其余用例先 `openMore()` 再断言 | 播放器没有记笔记与录音按钮（A-47）；次要控件收进“…”面板；`onNote` 的点击断言由引用标签断言与按钮不存在断言取代 |
| `tests/library/schema-v7-migration.test.ts` · `describe("schema v7 migration")` | `describe("schema v7 migration (a v6 library, now carried on to the current version)")` | 迁移现在一直走到 v8；用例本身不变；`tests/helpers/legacy-db.ts` 相应补充 |
| `scripts/stages/m2.json` 的必需用例匹配模式 | 同 id，模式随上面的名称改写（F-27、AT-03、AT-10、AT-14、AT-17、AT-18、AT-22、AT-24、AT-59、P7 共 10 个用例，AT-06 增加 1 个模式） | 用例 id 与数量不变；`scripts/stage-report.test.mjs` 增加两个反例（扫描与窗格、打包阶段） |

### 16.6 计划外的决定与发现

1. **快捷任务与附件在运行中。** 旧版运行时禁用所有快捷任务与“附加”；新版只挡会发送的快捷任务，仅填入输入框的任务与“附加”照常可用（见 16.5）。快捷任务按页面始终列出，在没有选区或字幕时占位符渲染为空并说明。
2. **相关作品在作品主页**，不在右栏（右栏只剩对话）。
3. **录音作为材料**放在“+”菜单的材料对话框里，沿用最多 3 条的限制。
4. **没有新增“清除缓存”与“移出资源库”命令**（计划未列）；扫描到的不可用文件只标记，不删除。
5. **AT-68 抓到的 W1 缺陷。** 适配宽度时，纵向滚动条占去舞台宽度而页面仍按含滚动条的宽度计算，导致舞台出现侧向滚动。改为在舞台上预留滚动条位置（`scrollbar-gutter`），按剩余宽度适配；对应用例“fits a page to the width the stage has left once its scrollbar's room is taken…”。
6. **LOOP-06 的原因与处理**（16.7）。
7. **扫描基准发现的两处性能缺陷**：5000 个文件的首次扫描让主进程循环被占住约 38 秒。原因是 `resource_revisions` 与 `file_locations` 缺少两个索引（扫描的比对与关联查询成了 O(n²)），以及任务队列在不等待的任务之间没有让出事件循环。已加两个索引（`resource_revisions_resource`、`file_locations_revision`，v8 与迁移库一致，用例用 `EXPLAIN QUERY PLAN` 断言）并在任务之间 `setImmediate` 让出（被取消的任务仍会启动并看到中止信号，用例覆盖）；修复后事件循环延迟 p99 为 13.3 ms。
8. **右栏消息流分页缺陷**（右栏基准发现）：`session.stream` 的每个来源只取一页，满页时 `hasMore` 为假，导致一个作品超过 200 条笔记时更早的消息取不回来。每个来源改取一页加一条，用例“says there are older messages when a source holds more than a page, and pages back through every one of them”（没有修复时失败）。同一次排查还发现基准最初量错了滚动元素（滚动元素是 `chat-log` 的子元素，不是祖先），已改为按真实滚动元素测量，并要求内容高度大于可视高度才算有效。
9. **标题栏录音指示恢复输入电平。** 紧凑指示曾为省空间去掉电平条，voice 阶段的“麦克风”步骤因此找不到电平；改为录音时始终显示电平，窄窗下缩小，仅保留提示去掉保留说明（用例见 AT-06 的新模式）。
10. **调试面板“事件”页的时间**原来按 UTC 一天内的毫秒数格式化，改为本地时间。
11. **真实 Bangumi 契约**：首个搜索结果没有角色条目，测试回退到固定参考条目（编号 253）取角色，总计 9 个请求。
12. **返工没有新增运行时依赖**，除 `use-stick-to-bottom` 1.1.6（第 6 节）。右栏 1000 条消息不做虚拟化（约 26 000 个节点，滚动与输入延迟见第 8 节），消息再多时需要虚拟化，登记为后续项而不是本阶段缺陷。
13. **悬浮胶囊压住控件与窄窗标题挤压（看截图发现）。** 窄窗里右栏收起时，右下角的悬浮胶囊压在播放器的音量与进度条末端、漫画页底栏上；宽窗收起右栏时会压在播放器的全屏与“…”按钮上。漫画页工具栏里的作品标题在窄窗被挤成一个粉色小块压在页码输入框后。处理：带底栏的页面（漫画页、播放器，全屏除外）上胶囊停在右上角、标题栏之下，笔记框向下展开；阅读器标题裁切而不是重叠（标题栏已显示同一标题）。新增窗口观察 `capsule-clear-of-controls`（宽/窄/矮窗 × 漫画页/播放器共 6 次量取，每次含笔记框展开，右栏展开时先收起再还原，要求至少 4 次量到控件且没有任何重叠）；`scenarios.json` 由 20 项增为 21 项。视觉是否满意仍归 H-M2-05（Q-08）。
14. **一个负载下的测试超时。** `tests/reading/video-player.test.tsx` 的 `ready()` 等待“可播放”状态原先 5 秒，全量 88 个测试文件并行时偶发超时（单独运行 44 个用例全部通过，不涉及产品代码）；等待改为 20 秒，断言不变。

### 16.7 LOOP-06

**诊断与来源。** formats 阶段现在在选中前等页面的绘制代次（`data-pdf-epoch`）与宽度（`data-pdf-width`）稳定，记录选中时与结束时的代次、文本节点数与被选节点是否仍在文档中（`loop06`，含时间线），失败时这些值可定位第二次绘制。第二次绘制的来源在代码里是确定的：页面按打开时量到的宽度绘制，随后纵向滚动条出现、侧栏安顿都会改变所量宽度，宽度变化即触发重绘并替换文本层——刚选中的节点随之消失。组件测试复现了这一路径（打开后宽度再变一次就绘制第二次）。审查时的偶发失败本次没有在窗口里再现，所以这里不声称“已观察到失败样本”。

**处理。** 不加重试：（1）`.reader-scroll` 与漫画舞台预留滚动条位置（`scrollbar-gutter: stable`），滚动条出现不再改变宽度；（2）打开时的宽度立即绘制，之后的宽度变化经 150 ms 去抖，宽度静止后才绘制一次，真实缩放仍会重绘；（3）渲染节点带 `data-pdf-width`，烟测据此判断“稳定”。用例“paints a page once at its opening width and again only after the width has held still (LOOP-06)”。

**验证。** formats 阶段在 20 个线程满载下连续 10 次通过（单次绘制代次 0 → 1、宽度稳定、`repainted` 为假、选中节点仍连接、选区变成引用标签）；完整 `package` 通过（含 formats）；压力运行用的是胶囊修复之前的打包，此后 formats 阶段与 PDF 渲染代码没有改动，最终 `package` 里 formats 阶段再通过一次（未重跑压力）。这证明没有再次出现失败，不是对偶发问题的统计排除。**LOOP-06 保持“待 A 复核”**，由 A 决定关闭；`open-questions.md` 已写明现状。

### 16.8 启动、样本与待决事项

```bash
pnpm dev                                          # 开发模式启动（独立开发 Profile）
node scripts/samples/generate-media-samples.mjs   # 合成样本在 dist/samples/m2（不入库）
node scripts/stage.mjs m2 package                 # 生成 dist/desktop/packages/MANGA-win32-x64 并跑 11 阶段烟测
```

人工检查 H-M2-01—10 与 H-01 复核的步骤在第 12 节；集中待决事项：**ACT-06**（人工检查）、**ACT-05**（真实 LLM/视觉与真实 Profile 迁移，未授权）、**ACT-01**（H-01 复核）、**Q-05、Q-08、Q-10—Q-15、Q-17—Q-19**、**LOOP-06**（A 复核后关闭）；Q-20、Q-21 已决定并实现。**首选下一步：交给 A 复核**（先读本节，再按 14.8 在打包版上逐项操作）。不 push、不创建 PR、不合并，除非用户在复核收敛后明确要求。

## 17. A 复核返工（2026-10-06）

A 按[计划 14.9](../delivery/m2-media-mvp-plan.md#149-交付与复核)与 `REVIEW.md` 复核 B 的返工（复核开始时的提交 `fab27be`）。本节只记复核本身；第 14—16 节保持原文，第 1—13 节的数字与状态已按本节最后一次重跑的证据更新。**不计算产品验收**：`productAcceptance` 仍为 not-run，H-M2-01—10 与 H-01 复核均未执行。

### 17.1 基点、范围与方法

| 项目 | 内容 |
| --- | --- |
| 提交 | 用户要求把同一阶段的两个提交合并：A 的计划提交 `8e2ac3f` 与 B 的返工提交 `fab27be` 按 A-21 与 [Git 规则 1.5](../dev-rules/git-and-github.md#1-本地优先与工作节奏)合并为一个阶段提交（父提交 `5504c97`，树与 `fab27be` 相同；合并前的状态留在本地备份分支，不推送）。A 的复核修复与本节 amend 进同一提交，最终 SHA 以交付回复和 `git log -1` 为准 |
| 范围 | A-47—A-52 与[交互设计 3.5](../design/interaction-and-workflows.md)对照实现；16.4 的 F 号处理、16.5 的测试改写映射、16.6 的计划外决定、16.7 的 LOOP-06；`docs/evidence/m2/` 与报告数字是否一致 |
| 方法 | 读对应代码与测试；在 `stage m2 package` 生成的打包版上，用 `dist/samples/m2` 的合成漫画、视频、小说副本建三个资源库路径，在全新的临时 Profile 上经调试端口驱动窗口逐项走查，并在宽窗与 360×780 窄窗下量控件与胶囊的位置。走查脚本、Profile 与截图在 A 的临时目录，未入库；没有使用真实资源，也没有调用真实模型 |

### 17.2 走查确认

以下返工在打包窗口里按计划兑现（只记自动化与走查的事实，手感与视觉仍归人工检查）：

| 发现 | 走查结果 |
| --- | --- |
| F-11 漫画缩放 | 整页、宽度、高度三种适配下按 50%、75%、100%、200% 缩放：页面 = 适配基准 × 缩放，舞台尺寸不变，缩小居中、放大可滚动 |
| F-12 导航与恢复 | 漫画打开时点导航回到书架；左栏会话恢复到离开时的第 3 页 |
| F-13 资料编辑 | 编辑模式显示全部字段（含空字段）；保存后标为“你自己填写”，可锁定与恢复 |
| F-15、F-18 播放器 | 控制条白底、灰色图标、粉色进度；次要控制在“…”里 |
| F-19 空库与扫描 | 空 Profile 打开到设置的“资源库”；三个路径添加后后台扫描，进度可见，分别登记 3、9、5 个文件 |
| F-21、F-22 调试面板与对话页 | 面板有“当前 / 上次任务 / 事件”与复制 JSON；面板打开时阅读器重新适配；对话页没有右栏与胶囊 |
| F-23、F-24 作品主页与匹配 | 六个页签与“阅读/观看”按钮；编号/链接解析对 `character/123`、外站链接、`subject/abc` 给出正确的拒绝原因 |
| 小说选区 | 选区成为“选区 12 字”引用标签；三种阅读页上没有记笔记与录音按钮 |
| 设置各页 | 记录、日志、使用记录、快捷任务、存储与备份都能进入并显示内容 |

### 17.3 复核发现与处理

较小的缺口由 A 直接修复（A 的流程），没有需要退回 B 的较大缺口。每项修复都带有去掉修复即失败的用例，并按所属 AT/R 编入 `scripts/stages/m2.json` 已有用例的匹配（用例数仍为 81）。F-36 是推送前最后一次 `verify.mjs` 暴露的，F-37、F-38 是推送后 PR 的 CI 暴露的，都按同一方式处理；它们的修复作为追加提交推到同一 PR（已推送的提交不改写），合并时 squash 成一个提交。

| 编号 | 级别 | 发现 | 处理 | 用例 |
| --- | --- | --- | --- | --- |
| F-29 | P2 | “笔记 / 问 Agent”的选择是全局记住的：在资源里选过“笔记”后，对话页与书架右栏的输入框也默认写笔记。对话页上发出的“笔记”建出“会话 1”和一条不属于任何资源或作品的笔记，对话里看不到，只能在设置的“记录”里找到 | 笔记只在有归属的地方可写：打开的资源与作品主页。其他页面不显示切换、只问 Agent，也不改动记住的选择；胶囊在这些页面只有麦克风（`hooks/use-chat.ts`、`components/chat/{chat-view,composer,capsule}.tsx`） | `rework-flows`：“where a note can be written…”与“has no note button where a note would belong to nothing”；`app-restore` 对话页用例改为断言没有切换 |
| F-30 | P2 | 扫描与单本导入的 TXT 以正文首行命名：作品名成了“第一章”，同一系列各卷的资源名都是首行。原因是解析器把首行当书名，写库时它优先于文件名 | TXT 与 PDF 没有书名元数据，改为以文件名（扫描时为文件夹/文件名）命名，首行只作缺省；EPUB/MOBI 仍用书内元数据（`app-core/reading-service.ts` 的 `documentTitle`）。规则写入[领域模型 4.4](../design/domain-model.md#44-资源库路径与后台扫描m2-返工) | `library-scan`：“names a text book after its file, not after its first line, whether scanned or imported” |
| F-31 | P3 | 左栏会话的位置只在重新打开该会话时更新：读到第 3 页回到书架，左栏仍写第 1 页 | 阅读器关闭后（它在卸载时写入最后位置），等进度写完再读一次会话列表（`App.tsx`，`use-comic`/`use-video` 的 `settled`） | `rework-flows`：“shows the page a comic was left at once the reader closes…”（并入 R-02） |
| F-32 | P3 | 360×780 窄窗、右栏收起时，右上角的胶囊压住框选提示条的“取消”。B 的胶囊检查没有量标题栏下的提示条；复核中重跑时又发现展开的笔记框比胶囊宽，同样压住它 | 标题栏下的提示条（框选提示、警告、来源卡）与字幕提示让出胶囊的角；胶囊在右上角时笔记框落到最低一条提示条之下；胶囊容器本身不接收指针，只有胶囊条与笔记框接收。窗口观察 `capsule-clear-of-controls` 在漫画页另开框选工具量提示条上的按钮，并在每个控件中心做命中测试（`styles-rework.css`、`capsule.tsx`、`main/smoke/rework.ts`）。规则写入交互设计 3.5 | 打包烟测 `rework` 阶段：6 组量取（漫画页每组 13 个控件、播放器 8 个，含笔记框展开）均无遮挡 |
| F-33 | P3 | 日志被阅读器的视图操作刷屏：漫画每点一次缩放或适配都写一条“修改了阅读与播放设置”，走查一分钟内 30 多条 | 同一操作者对 `settings.setMedia` 的连续修改在 60 秒内合并为一行并更新时间；失败或中间插入其他操作时另起一行，其他操作从不合并（`app-core/ops/operation-log.ts`）。写入[设置模块](../modules/settings.md) | `operations`：“keeps a run of reader view changes as one line…” |
| F-34 | — | 走查时日志里的扫描条目显示“novel”，疑为未本地化的媒介值 | **撤回**：日志显示的是资源库文件夹名，走查用的合成样本文件夹恰好叫 `novel`；代码只记录目录名，没有缺陷 | — |
| F-35 | P3 | 从作品主页的“记录”页签打开一条笔记，笔记页的“返回”去了设置的“记录”，而不是作品主页 | 笔记页记住打开它的页面（含作品主页的状态），“返回”回到那里，与设置的返回一致；没有来源时仍回到设置的“记录”（`App.tsx`）。写入交互设计 3.5 | `rework-flows`：“returns from a note to the page it was opened from…”（并入 R-14） |
| F-36 | P2 | 视频播放器偶尔永远不进入“可播放”：换源时重置状态的副作用在 `useEffect` 里运行，晚于元素拿到新地址；缓存或很快的文件在这之前就报告了时长（`loadedmetadata`），已置好的“可播放”随即被重置清掉，之后不会再有事件把它置回。表现为 17.5 记录的偶发超时，在机器负载高时出现 | 换源时的重置改在 `useLayoutEffect` 中运行，与给元素地址的那次提交同步完成，早于元素能报告任何关于新地址的事（`renderer/readers/use-video-playback.ts`） | `video-player`：“stays ready when the file reports its metadata as soon as the player points at it”（地址一出现就派发元数据；改动前稳定失败，并入 AT-23） |
| F-37 | P2 | 推送后 PR 的必需检查 `repository-quality` 失败：CI 的 Linux runner 上没有固定版本的 Windows FFmpeg、语音模型和用它们生成的合成样本，12 个测试文件在收集时失败，另有 3 个用例失败。本地和 pre-push 的 `verify.mjs` 一直有这些前置，所以推送前没有暴露。[质量门禁](../dev-rules/quality-gates.md)写明 CI 不覆盖 Windows 专属集成，却没有规定这些用例在 CI 上怎么处理 | CI 以 `MANGA_MEDIA_PREREQUISITES=absent` 声明前置缺席，只有这时需要它们的 138 个用例记为跳过；其他环境缺少前置仍然失败。阶段入口会清除该变量，证据不会因此缺项（`tests/helpers/prerequisites.ts`、`.github/workflows/ci.yml`、`scripts/stage/test.mjs`）。规则写入质量门禁与 [Git 规则第 2 节](../dev-rules/git-and-github.md#2-ci-的范围与触发)；改用 Windows runner 让 CI 也跑这些用例，记为可选的后续决定（[用户待办](../../USER-ACTIONS.md#agent-defaults)） | 本机移走样本与工具并设该变量后运行 Vitest：1045 passed、147 skipped、0 failed；同样条件下不设该变量时失败，与 CI 首次运行一致。有前置时的完整运行见 17.5 |
| F-38 | P3 | 修复 F-37 后 PR 的 CI 第二次运行，只剩 `pdf-combining-marks` 的绘制用例失败：Linux 上嵌入的是 Noto/DejaVu，未做标记定位的 e + U+0301 中，重音离字母 0.155 em；用例要求大于 0.4 em，这个数值只对 Windows 上的 Cascadia Mono 成立（0.632 em）。用例的字体候选本来就包括这两种 Linux 字体，但断言写成了单一字体的数值。首次运行因 F-37 在收集时就失败，没有走到这里 | 断言改为与字体无关的预测：把字母和标记分别单独绘制，标记按文件里字母的前进宽度平移，再按同样的带区测量，得到的位置应与实际绘制一致（误差小于 0.05 em）。这正是 LOOP-04 结论的核心：PDF.js 按文件给的笔位绘制。用例名同步改为“未定位时画在字母之后的笔位” | 本机分别用 Cascadia Mono、Arial、Segoe UI、Times、Consolas 与 Noto Sans SC 运行该用例，均通过。另外观察到：用候选之外的 Segoe UI 或 Consolas 时，另一条“读出同样的组合文本”用例会丢掉定位标记旁的空格。这两种字体不在候选里，CI 的 Noto/DejaVu 与默认的 Cascadia 都通过，所以本次不改，随 [LOOP-04](../delivery/status.md#loop-04) 复查 |
| 16.5 | — | 运行中“附加”不再禁用，旧断言被删除，但没有新的正向断言证明附图不会混进正在运行的任务 | 补用例：运行中可以附图，附图不进入正在运行的任务，随下一次发送带上 | `agent-send-media`：“lets a picture be attached while a task runs, keeps it out of that task, and sends it with the next one”（并入 AT-10） |

证据与报告的出入（已更正）：

- 第 8 节写“200 个封面里 196 个为 0.0 ms”，B 的 `bench.json` 实为 197 个；现以最后一次运行为准（198 个）。
- `screenshots/ui-smoke-agent.png` 是 agent 阶段结束时的画面（资源库路径页），不是对话页；已换成对话页 `ui-smoke-agent-agent.png`，并补上返工阶段窄窗、矮窗的漫画页、播放器与小说页截图（共 22 张，`docs/evidence/m2/` 2.52 MiB）。
- 第 1 节的基线仍写计划提交 `8e2ac3f`，已按合并后的事实改写。
- [资源库模块](../modules/library.md)的扫描基准数字（p99 18.3 ms、p95 10.2 ms、约 19 s）与报告（13.3、7.4 ms）不一致，已改为引用两次运行的范围。

### 17.4 三个判断

1. **LOOP-06 关闭。** B 修复的是代码里确定存在的第二次绘制路径（滚动条出现或侧栏安顿改变所量宽度 → 重绘替换文本层），没有加重试；烟测记录绘制代次、宽度时间线与选中节点是否仍在文档中，在页面稳定后才选中；formats 阶段在负载下连续 10 次通过。复核后的完整 `package` 再次通过，`loop06` 为单次绘制（代次 0 → 1、宽度不变）、选中节点仍连接、`repainted` 为假。审查时的失败样本没有再现，所以这是“消除了已确认的路径并通过压力验证”，满足[执行状态](../delivery/status.md#loop-06)写明的退出条件。
2. **悬浮胶囊移到右上角、窄窗标题裁切：接受。** 带底栏的页面上，右下角会压住音量、全屏、“…”与漫画底栏，移到右上角、标题栏之下是更小的代价；条件是它也不能压住标题栏下的提示条，这一点由 F-32 补上并纳入窗口观察。窄窗里阅读器顶部的标题裁切而不是与页码、按钮重叠，完整标题仍在应用标题栏，信息不丢。两条规则写入交互设计 3.5；视觉是否满意仍归 Q-08 / H-M2-05。
3. **16.5 的断言减少：接受。** 任务的材料在发送时冻结（P7、AT-10 的快照与重试用例），运行中附图不会改变正在运行的任务，所以不必禁用“附加”；会发送的快捷任务仍被挡住。被删去的“附加被禁用”断言由 17.3 表中“16.5”一行补上的正向用例替代，断言总数不减。

### 17.5 复核后的验证

全部在 A 的修复之后、同一份源码指纹上运行（Windows 开发机，Node v24.19.0）：

| 检查 | 结果 |
| --- | --- |
| 类型检查 | passed |
| `stage m2 test` | passed：必需用例 81/81；Vitest 1192 个用例：1185 passed、0 failed、7 skipped（同第 1 节） |
| `stage m2 package` | passed：Electron 44.5.1，11 个阶段；`rework` 阶段 21/21 个窗口观察；`capsule-clear-of-controls` 6 组量取无遮挡；formats 阶段 LOOP-06 单次绘制；缺资产负例通过。第一次运行 `capsule-clear-of-controls` 失败（窄窗笔记框压住框选“取消”，见 F-32），修复后通过 |
| `stage m2 bench` | passed：19 项门槛全部在目标内（第 8 节）。最终一次运行与 B 自检时的水平相当（30 MiB EPUB 末尾可见 p95 944.1 ms）。复核中的前一次运行重负载项慢约 1.5—2.5 倍，**EPUB 末尾达到 1960.8 ms，离 2000 ms 门槛只剩 39 ms**；同机撤回复核的服务层改动后 5000 文件扫描耗时相同，差异来自机器状态。较慢的机器上仍可能接近门槛，这不是本次复核引入的，留给参考机上的基准与 Q-11 的会话预算一起看 |
| `stage m2 report` | 退出码 0：`errors: []`、`automationStatus: self-check-passed`、`engineeringReviewable: true`、`productAcceptance: not-run` |
| PR 的 CI | 首次运行失败（F-37），3 个用例失败，另有 12 个文件在收集时失败，都因缺少 Windows 媒体前置；修复后本机模拟 CI 条件（移走样本与工具并设 `MANGA_MEDIA_PREREQUISITES=absent`）运行 Vitest：1045 passed、147 skipped、0 failed。第二次运行只剩 F-38 一个用例失败，修复后的重跑结果以 PR 检查为准 |
| `verify.mjs` | passed（退出码 0）：文档检查（63 篇文档、808 个本地链接、75 条需求、68 个验收用例）、公开内容检查（571 个文件、1142 份快照）、依赖边界、类型检查与单元/集成测试（1192 个用例：1183 passed、0 failed、9 skipped，比阶段 `test` 多跳过 2 个大文件用例）、`stage-report` 门禁反例 14/14 |
| 偶发 → F-36 | 复核中一次单独的 `pnpm test`（试用用的打包应用仍在运行）里，`tests/reading/video-player.test.tsx` 有一个用例等待“可播放”超时，当时单独重跑 44/44 通过。推送前的 `verify.mjs` 再次出现同一超时，查明是播放器本身的时序缺陷而不是测试的等待条件（F-36）；修复并补用例后 `video-player` 连续 3 次 45/45 通过，`test`、`package`、`bench`、`report` 四份证据在最终源码指纹上（含 F-37、F-38）全部重跑 |

### 17.6 仍未执行与下一步

- not-run：产品验收；人工检查 H-M2-01—10 与 H-01 复核（步骤见[用户待办](../../USER-ACTIONS.md#checks)）；ACT-05（真实 LLM 整理、视觉/OCR、真实 Profile 迁移，未授权）；设备与硬件项（H-M2-06/07）；调试面板的窗口驱动（H-M2-08）。
- 待答复：Q-05、Q-08、Q-10—Q-15、Q-17—Q-19。
- 已登记：LOOP-04（待 H-01 复核）、LOOP-05、LOOP-07（右栏长会话）。
- **首选下一步（2026-10-06 按 A-53 更新）：用户授权 [ACT-07](../../USER-ACTIONS.md#act-07)，即 M2 的 push、PR 与合并；授权后由 Agent 执行，再转入 M3 的 A 规划。** 用户已于 2026-10-06 授权（A-54）。 人工检查与待答复问题都列在用户待办里，用户可以在任何阶段逐项处理，不是授权的前提。push、创建 PR 与合并只在用户明确授权后进行。
