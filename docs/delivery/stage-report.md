# 当前阶段报告（M13）：DeepSeek 插件

日期：2026-11-15（B 在最终源码上的全链路门禁完成于 `2026-11-15T08:37:03Z`）。分支：`feat/m13-deepseek-plugin`（基于 `main@2726b0e`）。角色：B 连续实施与门禁自检完成；A 集中审查已收敛（[第 10 节](#a-review)）；同日按用户试用反馈完成 7 项修复并通过快速门禁、真实密钥契约与本机开发版更新（[第 11 节](#user-feedback-fixes)）。2026-11-17 按用户反馈追加标题栏、托盘、对话模型选择与本周发布失败的修复（[第 13 节](#feedback-2026-11-17)，A-136、A-137）。唯一计划见[当前阶段计划](stage-plan.md)；需求 PLUG-07、MODEL-06、MODEL-07、VOICE-18、VOICE-19、SEARCH-03，验收 [AT-184—AT-193](roadmap-and-acceptance.md#at-deepseek)，确认记录 A-133、A-134、A-132。产品验收保持 not-run：自动化通过不等于产品验收，人工检查 [H-112](../../USER-ACTIONS.md#h-112)—[H-123](../../USER-ACTIONS.md#h-123) 未执行。

<a id="cleanup"></a>
## 1. C0 阶段开始的整理与 D1 依赖盘点

### 1.1 C0 整理记录（计划 5.1）

| 对象 | 处置结果 |
| --- | --- |
| 上一阶段报告与标签 | A 在计划提交里已提炼后删除，入链改为归档链接；B 交付前文档检查通过（`check-docs` 69 份文档、1070 个本地链接），没有以前阶段的标签。新增的测试名与注释不带阶段标签（`schema-v17-migration.test.ts` 里的旧标签已去掉）；文档检查对 GHSA 编号里的字母数字串（如 `m249`）不再误报为阶段标签（`scripts/check-docs.mjs`，补了用例） |
| `.env.local`、`.local/deepseek.key` | 保留；密钥只由契约测试按计划 4.10 从文件读取，没有复制、打印或写进日志与证据 |
| `.local/gate-run.log`、`.local/loop-phase.log`、`dist/a-review-*.log`、`dist/evidence-runs/` 里的旧日志 | 看过没有未提炼的结论后删除 |
| 系统临时目录里的 `manga-*` | 确认没有门禁在运行后删除 31 个 |
| `dist/design-refs/`、`dist/samples/`、`dist/tools/` | 原样保留 |
| `dist/desktop/`、`dist/plugins/`、`dist/evidence-runs/current/` | 由本阶段的打包与门禁覆盖 |
| `%APPDATA%\manga-release\` | 原样保留，没有读取或输出私钥；DeepSeek 插件由打包脚本用其中的插件私钥签名 |
| `docs/evidence/gate/` | 整体替换为本阶段最后一次门禁的结果（2.5 MiB，见第 8 节） |
| Dependabot | 开始时没有开着的 PR |

### 1.2 D1 依赖盘点（A-35、A-132）

阶段开始时 `node scripts/deps.mjs` 列出 26 项满 7 天的更新，不绕过最小发行龄（`minimumReleaseAge: 10080`），没有新增第三方依赖。逐项结果写在 [ADR-0007 的本阶段一节](../decisions/0007-technology-stack.md)：同主版本 23 项升级（Electron 45.2.3、Vite 8.3.6、Vitest 5.1.0、pdfjs-dist 6.5.438、pi-ai 1.5.0、Tiptap 3.33.0 等）；`@types/node` 升到 26.6.6；`dockview`/`dockview-core` 用覆盖固定在 8.8.3（锁文件里有不满 7 天的 8.9.0）；`@napi-rs/canvas` 1.1.0 与 jsdom 31.0.0 回退（前者 PDF 渲染用例崩溃，后者界面用例启动即报错）。漏洞 17 条：有修复版本的用覆盖升级，`ip`、`glob`、`minimatch` 三条登记为例外（`scripts/deps-exceptions.json`，复查 2027-02-14，原因见 ADR）。

门禁前复跑：knip 6.44.1 → 6.44.2（期间新满 7 天的补丁）；canvas 与 jsdom 没有新发行，保持。门禁的依赖审计通过。

**升级的遗留，在门禁里发现并修复：** pdfjs-dist 升级时漏改了 `apps/desktop/src/renderer/pdf-page.tsx` 里写死的版本断言，打包版的 PDF 阅读器因此拒绝加载新版库（单元用例用的假 pdf.js 也写着旧版本号，所以没有发现）。现在两处 PDF 视图共用 `readers/pdf-doc.ts` 的 `EXPECTED_VERSION`；解析器标识随之改为 `pdfjs-dist@6.5.438`（只记录、不参与比较，以前升级时也一样改）。

<a id="mapping"></a>
## 2. 工作包、需求与验收映射

| 工作包 | 需求 / 验收 | 实现位置 | 验证证据 | 状态与限制 |
| --- | --- | --- | --- | --- |
| P1 声明式提供者插件 | PLUG-07 / AT-184 | `packages/contracts/src/provider.ts`、`plugin.ts`（`model.provider`、`DECLARATIVE_SLOTS`、拒绝原因 `provider`）；`packages/app-core/src/plugins/`；`providers/registry.ts`；`plugins/provider-deepseek/` | `tests/plugins/provider-plugin.test.ts`；观察 `deepseek-plugin`、`deepseek-network`（停用期间 0 个请求） | 已实现 |
| M1 加入模型、账户、v17 | MODEL-06 / AT-185 | `commands/providers.ts`；`providers/access.ts`；`storage-drizzle/src/sql.ts`（v17）；`renderer/pages/settings/provider-dialog.tsx`、`models-page.tsx` | `schema-v17-migration.test.ts`、`provider-plugin.test.ts`、`models-providers.test.tsx`；观察 `deepseek-models`（浅色与深色截图） | 已实现 |
| L1 思考与工具循环 | MODEL-07 / AT-186 | `model-protocol/src/openai-http.ts`、`pi-ai.ts`；`commands/agent-run.ts`；`components/chat/messages.tsx`（思考过程） | `deepseek-thinking.test.ts`、`deepseek-agent.test.ts`；观察 `deepseek-chat`；真实契约 `tool-loop-native`、`tool-loop-pi` | 已实现 |
| N1 原生联网搜索 | MODEL-07 / AT-187 | `openai-http.ts`（`deepseek_web_search`、`server_tool_event`、`annotations`、`server_tool_calls`）；`agent-run.ts`（下一轮带回）；`composer.tsx` | `deepseek-agent.test.ts`（含下一个任务带回）；观察 `deepseek-chat`、`deepseek-network`；真实契约 `native-search`、`native-search-passback` | 已实现；PI 运行时下只发起搜索（LOOP-47） |
| G1 网页搜索 | SEARCH-03 / AT-188 | `providers/web-search.ts`；`model-protocol/src/deepseek-services.ts`；`research/finder-panels.tsx` | `tests/research/web-search.test.ts`；观察 `web-search`；真实契约 `web-search` | 已实现；走查不点“抓取并保存”（会访问真实网站），留给 H-115 |
| A1 DeepSeek 语音识别 | VOICE-18 / AT-189 | `voice/engine/asr-engine.ts`（`deepseek_asr`，按静默分段 ≤ 110 s，429/503 再试两次） | `deepseek-asr.test.ts`；观察 `dictation-deepseek`、`deepseek-network`（只有 `file` 字段）；真实契约 `asr-100s` | 已实现 |
| R1 合成与回答朗读 | VOICE-19 / AT-190（基准门槛见 AT-191） | `providers/speech.ts`；`main/index.ts`（`manga:speak`）；`renderer/voice/read-aloud.ts`、`speech-worklet.ts`；`voice-page.tsx` | `deepseek-speech.test.ts`、`read-aloud.test.ts`；观察 `read-aloud`；基准 `ttsFirstAudioP95Ms`；真实契约 `speech-round-trip`、`speech-long` | 已实现 |
| R2 小说朗读 | VOICE-19 / AT-191 | `renderer/reader/use-read-novel.ts`；`reading.tsx` | `read-aloud.test.ts`（分段、计费字数）；观察 `read-aloud`；基准 `readAloudGapP95Ms` | 已实现；跨窗口与跨章继续没有自动观察，在 H-118 里看 |
| U1 用量与费用 | MODEL-03 联动 / AT-192 | `providers/usage.ts`；`ops/usage.ts`；`usage-page.tsx`；`agent-run.ts`（`costEstimated`） | `tests/research/usage-services.test.ts` | 已实现；费用标为估算 |
| X1 真实 API 契约 | AT-193 | `tests/real/deepseek-contract.test.ts` | 第 5 节 | 已实现 |
| T1 测试、走查与基准 | 全部 | `apps/desktop/src/main/smoke/deepseek-walk.ts`、`bench-read-aloud.ts`；`scripts/stage/bench-read-aloud.mjs`；`scripts/stage/package.mjs` 的 `deepseekTraffic` | 第 7、8 节 | 已实现 |
| W1 文档 | — | 需求、领域模型、模块规格、协议、外部扩展、交互、数据与安全、质量门禁、仓库地图、执行状态、README、用户待办 | 文档检查通过 | 已实现 |

<a id="l1"></a>
## 3. L1 最小验证的结论：`reasoning_content` 的回传规则

先在假服务与真实 API 上让自研运行时走通“开思考 + 3 步工具循环”（真实探测 12 + 4 个请求，flash 与 v4-pro 各自核对），结论：

- 思考模式下，**最后一条用户消息之后**、带工具调用的每个助手消息，在之后的每次请求里都要原样带回 `reasoning_content`；缺少时服务返回 400（文字与假服务一致）。
- **更早轮次**的助手消息不需要带回思考内容（契约 `next-turn-without-reasoning` 通过），所以下一轮只带回答文字，节省上下文。
- 模型自己搜索时，回答带的 `server_tool_calls` 在多轮里原样带回；本阶段既在同一任务的下一步带回，也在同一会话的下一个任务里随这条回答带回（门禁走查时发现会话历史漏带，已修复并补了用例）。
- 内置联网搜索只在开启思考时能与函数工具同用，所以“联网搜索”在推理等级为关闭时把这次任务改为“低”并说明。

数据结构因此是：思考内容与 `server_tool_calls` 作为助手消息的一部分存进 `agent_messages.payload_json`，发送时按方言与轮次决定是否带上；不另建表。

<a id="provider-file"></a>
## 4. 提供者文件、接法白名单与 v17 迁移

- **提供者文件**（`manga-provider-v1`，≤ 64 KiB）：`id`、`name`、`baseUrl`（https）、`hosts`（≤ 8，地址的主机必须在其中）、`keyUrl`、`discovery: "openai-models"`、`models`（窗口、输出、输入类型、能力、推理等级、默认勾选、价格）、`services`（种类、接法、限制、声音、价格与单位）、价格的核对日期。
- **接法白名单**：`openai-chat-completions`（方言 `deepseek`）、`deepseek-asr@1`、`deepseek-tts@1`、`deepseek-search@1`。引用其他接法、非 https 地址、未声明的主机、文件缺失或无效、与清单不符、缺网络权限的包，`inspect` 以 `provider` 拒绝。
- **v17 迁移**：备份 `manga.sqlite.premigrate-v16`；新增 `provider_accounts`、`service_usage`，`provider_connections` 增 `account_id`、`provider_model`，旧连接的 `adapter_id` 回填为 `openai-http`。用例覆盖：已有连接与密钥一条不少、中断后完成、第二次不改动、与新建资料结构一致、只认识 v16 的版本拒绝打开。

<a id="x1"></a>
## 5. X1 真实 API 契约（ACT-23）

在最终源码上完整运行一次，15 项全部通过，24 个请求（结果只记状态、形状、耗时、计费单位与相似度，不含回答正文；密钥只从文件读取，输出经过滤，结果文件里没有密钥）：

| 用例 | 结果 |
| --- | --- |
| `models` | 200，列出两个声明的模型 |
| `chat-thinking-off` | 首字 270 ms，整次 640 ms |
| `tool-loop-native` | 4 次请求（3 步工具 + 回答），每步都有思考内容，单次 616—1071 ms |
| `next-turn-without-reasoning` | 不带上一轮思考，通过 |
| `tool-loop-pi` | 4 次请求，通过（PI 运行时不报告缓存命中的令牌数） |
| `vision` | 通过（flash 收图） |
| `native-search` / `native-search-passback` | 4 与 2 个搜索事件、各 2 个引用；带回后的下一轮通过 |
| `effort-max` | 通过 |
| `speech-round-trip` | 56 个计费字，首块 785 ms，识别回来的相似度 1 |
| `speech-long` | 2048 个计费字（237.6 s 音频），首块 878 ms |
| `asr-100s` | 100 s 合成语音，相似度 0.952 |
| `web-search` ×2 | 各 3 条结果，280 / 654 ms |
| `errors` | 错误密钥 401、不存在的模型 400、空文本合成 400 |

**阶段用量**：A 规划的 7 个探测之外，B 合计 73 个请求（L1 探测 12、N1 探测 3、L1 走通 4、契约第一次 23、最终契约 24），估算约 0.25 美元（按插件里的价格），在 ACT-23 的 300 个请求、2 美元以内。用量记在被忽略的 `.local/deepseek-usage.log`。第一次契约的原生搜索因为提示词没有触发搜索，改了提示词后在最终运行里触发并通过。

<a id="decisions"></a>
## 6. Q-41 默认值与实现中的取舍

- 按 Q-41 的默认实现：插件随应用提供、由用户安装一次；不加 `safety_check` 与服务端标题；加入时默认勾选目录里推荐的模型与全部服务；新连接只在该用途未选定时成为默认；后台小任务关思考；思考过程默认折叠；联网搜索按次勾选；朗读声音默认 `stella`。
- **朗读费用提示**：实现为开始朗读时都提示，直到用户选“不再提示”（设置 `novelCostHint`），比“第一次朗读一本书时说明”更保守。
- **录音笔记的识别块**沿用 30 s（计划允许 ≤ 60 s），位置映射不变；听写超过上限时按静默分段（≤ 110 s）。
- **模型配置的来源标签**“测试读到”改为“自动读到”：提供者的模型列表填入的配置也用这个标记。
- **`dictation-deepseek`** 放在 `deepseek` 阶段里，而不是扩展已有的 `dictation` 阶段：DeepSeek 引擎需要插件、账户与假服务，与本阶段其他观察共用一套准备。

<a id="gate"></a>
## 7. 门禁、基准与源码指纹

### 7.1 `stage gate`（最终源码）

| 步骤 | 结果 | 用时 |
| --- | --- | --- |
| 依赖审计 | 通过 | 3 s |
| verify（类型、knip、文档、公开内容、依赖边界） | 通过 | 31 s |
| 测试（全量：253 个文件通过、8 个按条件跳过；3095 个用例通过、11 个跳过） | 通过 | 92 s |
| 打包与窗口观察（第 1 遍 / 第 2 遍） | 通过 | 451 s / 456 s |
| 安装包 | 通过 | 449 s |
| 基准 | 通过 | 603 s（最慢：scanPane 134.8 s、workspace 128.3 s、reader 74.4 s） |
| 报告 | 通过 | 0 s |

过程记录：第一次门禁停在打包（上面的 pdf.js 版本断言）；修复后通过，但看截图时发现三处界面问题（来源标签、网页结果的日期显示原始时间戳、标题与网站名挤在一行），修复后重跑；那一次的第 2 遍打包里 `workspace-restart` 的“把书的标签切到前面”失败一次（合成点击后 3 秒内焦点没有切过去），这一项在同一源码上的其他四遍都通过，重跑后连续两遍通过。它在负载下偶发，没有改动走查本身。

### 7.2 新增基准（[`docs/evidence/gate/bench.json`](../evidence/gate/bench.json)）

| 指标 | 门槛 | 结果 | 样本 |
| --- | --- | --- | --- |
| `ttsFirstAudioP95Ms`（点击回答的“朗读”到第一块音频交给播放，假服务、不走缓存） | ≤ 300 ms | 51 ms | 10 条不同的回答（第一条含打开 AudioWorklet） |
| `readAloudGapP95Ms`（小说段间静默，下一段先到记 0） | ≤ 150 ms | 0 ms | 24 段、23 个段界 |

基准的走查里，回答改为每条答完就朗读：对话列表是虚拟列表，朗读控件的高度变化之后列表可能不再贴底，新回答落在可见区下方（与用户需要点“回到底部”的情况一致，登记为 LOOP-48）。测量方法、门槛与样本数没有改。

### 7.3 指纹（[`docs/evidence/gate/report.json`](../evidence/gate/report.json)）

源码 `c9721ce4c999a90a60638d3886678ed8e83c5e2f45b6488e1c2de85702ca66ce`；锁文件 `a85080e7e45dcc90f64f147885fb5d5580b67d3c61499090c89e659bf0c9fb6c`；走查脚本 `af435457fc0f21cd0e36553e979217aa08a1dcfb214edf918a364febadf8b54a`；基准脚本 `b9445a0df7293308b0cb9970e0825acbb169375f7a07a9bc39c41814b1217690`。

**装到本机的开发版**：`0.1.2-dev.202611150750`（`stage install-dev` 通过，前一版 `0.1.2-dev.202611131924`，正式版未动）。

<a id="evidence"></a>
## 8. 证据

`docs/evidence/gate/` 整体替换为最终门禁的结果：`bench.json`、`cases.json`、`install-dev.json`、`installer.json`、`media-smoke.json`、`package.json`、`report.json`、`scenarios.json`（192 项观察）、`test-run.json`、`voice-smoke.json`，以及截图 `ui-deepseek-models-light/dark`、`ui-deepseek-chat-thinking`、`ui-deepseek-chat-sources`、`ui-deepseek-novel-reading`、`ui-deepseek-research-web`、`ui-launch-guard-dialog`（复制前看过，不含本机路径与密钥）。共 2.5 MiB。

<a id="next-step"></a>
## 9. 已知限制与下一步

- **限制**：PI 运行时下内置搜索不显示进度与来源、不带回 `server_tool_calls`（LOOP-47）；朗读后对话列表可能不贴底（LOOP-48）；小说跨窗口与跨章继续、网页“抓取并保存”没有自动观察（H-115、H-118）；DeepSeek 的 OCR、网页抓取与文件解析、边生成边朗读、PDF 朗读没有接入（LOOP-43—LOOP-46）。
- **需要用户的**：人工检查 H-112—H-120（需要自己的 DeepSeek 密钥）；Q-41 的答复（以答复为准再调整）。都不阻塞审查。
- **结果**：已按用户 2026-11-21 的授权执行 [ACT-24](../../USER-ACTIONS.md#act-24) 第 1—3 步：[PR #28](https://github.com/chialecode/manga/pull/28) squash 合并为 `main@3e9a9af`，阶段分支已清理。下一步是用户开启下一阶段。

<a id="a-review"></a>
## 10. A 集中审查（2026-11-15）

按计划第 9 节的审查重点逐项读了实现与用例，结论：**收敛，可以请求授权 push、PR 与合并**。局部问题已由 A 直接修复并 amend 进同一个阶段提交，在最终源码上重跑了整套 `stage gate`（10.3）。

### 10.1 逐项结论

| 审查重点 | 结论与依据 |
| --- | --- |
| 停用、卸载、信任移除时零网络请求 | 成立。对话、后台小任务、识别、合成、搜索与服务测试都先经过 `providers/access.ts` 的 `connectionAccess`/`providerOf`：插件不可用时在发请求前以 `PROVIDER_UNAVAILABLE` 拒绝，进行中的调用由 `cancelUnavailable` 取消。A 补了两处：见 10.2 的第 1、2 项 |
| 只用白名单接法、只访问声明的主机 | 成立。`ProviderFileSchema` 只认四种接法与 https 地址，`baseUrl` 的主机必须在 `hosts` 里；每次调用前 `checkAddress` 再核对主机与私网；提供者连接不能改地址、模型或用途。测试用的假服务地址只在 `--manga-smoke` 且设了环境变量时生效 |
| 密钥不离开主进程、不进日志与证据 | 成立。朗读经 `manga:speak` 只把 PCM 交给页面，密钥只在主进程读取；ASR、TTS 与搜索的请求 `redirect: "error"`。A 用 `.local/deepseek.key` 的内容（及其前缀）检索了阶段提交的全部文件，没有命中 |
| v17 迁移 | 成立。沿用迁移前备份（`premigrate-v16`）、同一事务、版本最后发布；只补缺少的列，第二次启动不改动；只认识 v16 的版本拒绝打开。四个用例覆盖备份、连接与密钥一条不少、中断后完成与结构一致 |
| `reasoning_content` 与 `server_tool_calls` 的回传 | 成立。两个运行时都只在最后一条用户消息之后的助手消息里带回思考内容；`server_tool_calls` 在同一任务与同一会话的下一个任务里带回（`sessionHistoryForNewRun`），只在 `deepseek` 方言下发送 |
| PI 下搜索的限制（LOOP-47） | 可以接受。A 在 ACT-23 内做了真实探测：一步里模型先内置搜索、再调用函数工具，下一步按 PI 的做法不带 `server_tool_calls` 发回，服务照常接受（200）并给出回答。所以 PI 下只是没有进度、来源与搜索上下文，工具循环不会因此失败。结论已写进 LOOP-47 |
| 联网搜索不放进资料库内容；`web.search` 的可用性 | 成立。搜索词只由模型或用户在面板里给出，没有代码把文件名、路径或正文拼进搜索词；`web.search` 只在本次任务勾了“联网搜索”、配置了搜索服务时进工具清单，模型自己能搜索时不提供。界面判断可用性的一处不精确登记为 LOOP-49 |
| 音频只发往所选的一个引擎；朗读不写盘、听写时暂停 | 成立。DeepSeek 识别只送 `file`，429/503 有限重试后报错，不换引擎；合成的 PCM 只在内存里缓存（10 分钟、单段 8 MiB、总计 64 MiB）；`openMicrophone` 开始时暂停朗读，不自动继续 |
| 费用标为估算 | 成立。对话按提供者文件的价格估算时记 `costEstimated` 与价格核对日期，使用记录显示“约”与说明 |
| 门禁后的修复 | pdf.js 两处视图共用 `EXPECTED_VERSION`，但与 app-core 的 `PDFJS_VERSION` 仍是两份手写常量，A 补了与实际安装版本核对的用例（10.2 第 3 项）；模型来源标签已改为“自动读到”；网页结果的日期只显示年月日、网站与日期另起一行。基准的门槛、测量方法与样本数没有改；基准走查改为逐条朗读回答的理由（LOOP-48）成立 |
| knip 的配置提示 | 实际是 9 条，归为两类：`apps/desktop` 的 8 个入口已由 knip 的 Electron Forge 与 Vite 插件识别，属于多余；`.css` 不在 `project` 里，样式文件的导入没有被跟踪。A 删去多余入口、把 `.css` 加进 `project`，knip 不再有提示；用一个临时的未使用文件确认它仍会报出 |

### 10.2 A 的修复

1. **视觉识读也经过插件闸门**（`commands/agent-run.ts`）：另配的视觉连接读图时原来直接读取密钥，没有经过 `connectionAccess`。目前提供者连接不能改成“视觉”用途，所以还走不到这条路径；修复后任何视觉连接都与对话连接一样受插件启停约束，停用时也会取消。
2. **插件停用后朗读不再从内存播放**（`providers/speech.ts`）：命中缓存时原来跳过了插件检查，停用后同一段文字仍能读出（不发请求）。现在先核对提供者，再查缓存；补了用例（`tests/voice/deepseek-speech.test.ts`）。
3. **pdf.js 版本与安装版本一致**（新用例 `tests/reading/pdfjs-version.test.ts`）：渲染端的 `EXPECTED_VERSION`、主进程的 `PDFJS_VERSION` 与解析器标识都要等于实际安装的 `pdfjs-dist`。以后升级漏改会在单元测试里失败，不用等打包后的 `formats`。
4. **knip 配置**（`knip.json`）：见 10.1。
5. **网页链接打不开**（`apps/desktop/src/main/permissions.ts`）：主进程的 `manga:open-external` 原来只放行 Bangumi 的条目页，计划要求用系统浏览器打开的三处（联网搜索的引用来源、材料搜寻结果的“在浏览器打开”、加入弹窗里的密钥申请页）点了没有反应；走查没有点这些链接（会打开真实浏览器），所以没有发现。现在另放行普通网页：http 或 https、默认端口、不带用户名与密码、公开的域名，IP 地址、本机、单段名称与保留名仍拒绝，其他协议照旧拒绝。规则写进[数据与安全第 2 节](../dev-rules/data-and-security.md)，用例在 `tests/shell/main-process.test.ts`。

### 10.3 验证

A 修复后，在最终源码上重跑了整套 `node scripts/stage.mjs gate`，全部通过：

| 步骤 | 结果 | 用时 |
| --- | --- | --- |
| 依赖审计 | 通过 | 2 s |
| verify（类型、knip、文档、公开内容、依赖边界） | 通过，knip 没有配置提示 | 33 s |
| 测试（254 个文件通过、8 个按条件跳过；3098 个用例通过、11 个跳过） | 通过 | 98 s |
| 打包与窗口观察（第 1 遍 / 第 2 遍） | 通过 | 518 s / 452 s |
| 安装包 | 通过 | 447 s |
| 基准（最慢：workspace 128.5 s、scanPane 102.4 s、reader 74.4 s） | 通过；`ttsFirstAudioP95Ms` 42 ms（门槛 300），`readAloudGapP95Ms` 0 ms（门槛 150） | 556 s |
| 报告 | 通过 | 0 s |

第一次重跑在测试一步停下：所有用例都通过，但门禁用例 `AT-47-query-boundaries` 按名字匹配的一个测试被 A 改了名（`tests/shell/main-process.test.ts`），这一项因此没有匹配到测试。A 在 `scripts/stage/gate.json` 里改了这条匹配式，并把新增的“普通网页”用例加进同一项，第二次重跑全部通过。

证据整体替换为这次门禁的结果（同第 8 节的文件，共 2.5 MiB，截图复制前看过，没有本机路径与密钥）。源码指纹 `1468c2afba52b2f8a6e569d01afb9e1c516e8d7189ec65bcaeaa7a7ef24ed2ef`。`stage install-dev` 通过，本机的开发版更新为 `0.1.2-dev.202611150931`（前一版 `0.1.2-dev.202611150750`）；人工检查请用这个版本。

### 10.4 真实 API 用量（ACT-23）

A 审查的探测不超过 8 个请求（两次提示没有触发搜索，换了提示后触发），探测用的临时用例已删除，只记了状态与形状。整个阶段合计：A 规划 7 个、B 73 个、A 审查不超过 8 个，共不超过 88 个，估算不到 0.3 美元，在 300 个请求、2 美元以内。用量记在被忽略的 `.local/deepseek-usage.log`。

### 10.5 不阻塞的后续

- **LOOP-49（新增）**：对话框判断“联网搜索”是否可用时，按第一个文字连接判断；项目另选了模型时，菜单项可能显示为可用或不可用而与实际不符。服务端按任务实际用的连接判断，不会多发请求，只是勾选可能不生效或没法勾选。
- LOOP-47、LOOP-48 照旧；人工检查 H-112—H-120 与 Q-41 的答复不是合并的前提（A-53）。

<a id="user-feedback-fixes"></a>
## 11. 用户试用反馈的 7 项修复与快速门禁验证（2026-11-15）

同日用户试用开发版后提出 7 项反馈，已全部在 `feat/m13-deepseek-plugin` 修复并合入同一阶段提交：

| 编号 | 用户反馈与根因 | 修复位置 | 回归测试与窗口观察 |
| --- | --- | --- | --- |
| 1 | 删掉本地文件后手动“扫描资源库”，总览里仍残留已删作品/资源 | `packages/app-core/src/library-scan/cleanup.ts`、`service.ts`、`commands/library-io.ts`、`works-service.ts`、`works-versions.ts`、`sidebar-service.ts`；`apps/desktop/src/renderer/pages/shelf.tsx`、`sidebar-data.ts`：手动扫描（`trigger = "manual"`，含将排队中的启动/定时扫描升级为手动及整库扫描时对账 `managed = 1` 下载位置）清理源文件缺失且无任何用户内容（笔记、书签、录音、截图、对话、词典、字段覆盖、已确认弹幕、粗剪片段）的资源与空作品（离线盘与不可读目录不清理），作废媒体/封面句柄并发出刷新通知；含用户内容但无可用资源的作品按 AT-77 保留，不再以空白卡片占用总览架面、侧栏与未归入列表 | `tests/library/manual-rescan-cleanup.test.ts`、`tests/library/shelf-overview-and-portrait.test.tsx`；观察 `library-in-locations`、`scan-incremental` |
| 2 | 关联 Bangumi 后封面没有变成同步的竖版，动漫页与总览仍裁成横版卡片 | `packages/app-core/src/metadata/covers.ts`、`service.ts`；`apps/desktop/src/renderer/lib/covers.ts`、`pages/shelf.tsx`、`work-card.tsx`、`work-home.tsx`、`sidebar.tsx`、`styles-shelf.css`：非 `file` 来源封面按 `>=` 等级更新（重匹配或刷新 Bangumi 时替换为最新竖版封面，锁定封面不动）；`covers.handles` 命中缩略图缓存时返回按比例缩放后的纵向宽高；总览架面、动漫书架、作品卡片、作品主页与侧栏封面格按竖版比例展示 | `tests/metadata/bangumi-portrait-cover.test.ts`、`tests/library/shelf-overview-and-portrait.test.tsx`；观察 `media-view-covers` |
| 3 | 窗口全屏下移动鼠标唤不出底栏，隐藏底栏区域仍可误点 | `apps/desktop/src/renderer/reader/use-auto-hide.ts`、`reading.tsx`、`readers/comic-reader.tsx`、`video-player.tsx`、`editable-number.tsx`、`video-time.tsx`、`styles-reader.css`、`styles-video.css`：小说、漫画、视频三种阅读器在窗口全屏下捕获 `pointermove`/`mousemove`/`dragover` 唤醒底栏；隐藏态底栏设 `pointer-events: none` 并拦截误触；页码与时间输入框卸载前主动释放焦点避免自动隐藏卡死 | `tests/shell/reader-fullscreen-capsule.test.tsx`；观察 `frame-window-fullscreen`、`overlays-comic`、`overlays-player`、`overlays-novel` |
| 4 | 开启系统代理 TUN 模式时，DeepSeek 读取模型列表与调用被 DNS 私网检查拦截 | `packages/app-core/src/providers/registry.ts`：`checkAddress` 在生产环境执行主机白名单与 `dns.lookup` 校验，继续拦截字面量 IP、本机后缀、回环、RFC 1918 局域网、IPv6 ULA 与 NAT64，同时放行已声明 https 主机在本地代理 TUN 模式下的 RFC 2544 Fake-IP（`198.18.0.0/15`）与运营商级 NAT（`100.64.0.0/10`） | `tests/plugins/provider-plugin.test.ts`、`tests/real/deepseek-contract.test.ts` |
| 5 | DeepSeek 插件已启用但连接仍标“插件已停用”，测试错误分类失真、模型页状态不即时同步 | `packages/app-core/src/plugins/service.ts`、`product-app.ts`、`model-probe.ts`、`commands/connections.ts`、`commands/providers.ts`；`apps/desktop/src/renderer/pages/settings/models-page.tsx`：启动与 `restore`/`plugin.changed` 先加载声明式 `model.provider` 文件并清除已可用连接上陈旧的 `"provider"` 错误；`probeConnection` 按 `failureOf` 精确映射非插件错误；`secretFor` 正常 `release()` 访问计数；停用时展示清单显示名；模型页在挂载与 `plugin.changed`/`settings.changed` 时实时对账（另顺手修复 `App.tsx` 与 `tests/shell/settings-view-ui.test.tsx` 初始挂载时 `savedRail` 尚未刷入 `railRef` 的竞态） | `tests/plugins/provider-plugin.test.ts`、`tests/shell/models-providers.test.tsx`、`tests/shell/settings-view-ui.test.tsx`；观察 `deepseek-plugin`（停用再启用并完成连接测试） |
| 6 | 最小化窗口时没有收进系统托盘图标 | `apps/desktop/src/main/tray.ts`、`index.ts`、`packages/i18n/src/messages-shell.ts`：Windows 主窗口最小化时隐藏任务栏按钮（`setSkipTaskbar(true)`）并创建按通道区分的系统托盘图标（`icon.ico` / `icon-dev.ico`，提示 `MANGA` / `MANGA Dev`）；单击、双击、右键中文菜单（“显示主窗口”“退出 MANGA”）、外部还原与二次启动（`second-instance`）均还原并聚焦窗口（保留最大化状态）且移除托盘图标；退出、重启与 `--quit-for-update` 时调用 `destroyWindowTray()` 清理 | `tests/runtime/tray.test.ts`；观察 `window-minimize-tray` |
| 7 | 对话栏收起时右上角录音/笔记胶囊遮挡阅读画面与右上区域 | `apps/desktop/src/renderer/components/chat/capsule.tsx`、`shell.tsx`、`workspace/host.tsx`、`styles-frame.css`、`styles-workspace.css`：将 `.chat-capsule` 停靠进主区 34 px 标签条右侧（高 28 px），在标签栏与分栏切换器预留 `--capsule-bar-w` 宽度，笔记输入浮层避开阅读器顶部提示条且在切换离可记笔记页面时自动收起，完全不压住下方正文或视频画面 | `tests/shell/reader-fullscreen-capsule.test.tsx`；观察 `capsule-clear-of-controls` |

### 11.1 两级门禁与证据对应关系（[质量门禁 2](../dev-rules/quality-gates.md#gate-tiers)）

- **整套门禁证据（[`docs/evidence/gate/`](../evidence/gate/)）**：对应第 10.3 节 A 集中审查完成时的整套 `node scripts/stage.mjs gate` 运行，源码指纹为 `1468c2afba52b2f8a6e569d01afb9e1c516e8d7189ec65bcaeaa7a7ef24ed2ef`（锁文件 `a85080e7e45dcc90f64f147885fb5d5580b67d3c61499090c89e659bf0c9fb6c`）。
- **最终源码上的验证（阶段内用户反馈修复，按两级门禁执行 `quick-gate.mjs`）**：最终源码指纹为 `8570c724047f3b7ddc30df5b862895e0707566db0f269795c519fd400c2842f5`（走查脚本指纹 `d8006806425e32f98da6cd1391b1b7a8cbc9be14cf1a550de232df2b3cbb9a2d`，锁文件不变）：
  1. `node scripts/verify.mjs`：通过（根与桌面端 `tsc --noEmit`、`knip` 零提示、70 份文档 / 1092 个本地链接、公开内容检查、依赖与闭包检查、Vitest 259 个文件 / 3129 个用例通过）。
  2. `node scripts/quick-gate.mjs --phases deepseek,voice`：通过，用时 `175 s`（`overBudget: false`，预算 300 s：`verify` 44 s、关联测试 88 s、重新打出 Electron Forge 桌面包并跑 `deepseek,voice` 42 s；7 项观察全部通过，含停用后再启用并重跑探针的 `deepseek-plugin`、`deepseek-models`、`deepseek-chat`、`web-search`、`read-aloud`、`dictation-deepseek`、`deepseek-network`，临时目录残留 0）。
  3. `MANGA_PACKAGE_REUSE_BUILD=1 node scripts/quick-gate.mjs --all-tests --phases window-walk,media`：通过，用时 `276 s`（`overBudget: false`，预算 300 s：`verify` 44 s、全量测试 `--all-tests` 260 个文件通过 / 8 个按条件跳过 95 s、沿用同指纹桌面包跑 `window-walk,media` 137 s；86 项观察全部通过，含新增的 `window-minimize-tray`、`frame-window-fullscreen`、`capsule-clear-of-controls`、`overlays-comic`/`player`/`novel`、`media-view-covers`、`library-in-locations`、`scan-incremental`、`menus:episodes-audio`，临时目录残留 0）。
  4. **真实 DeepSeek API 契约（ACT-23）**：在最终源码上执行 `tests/real/deepseek-contract.test.ts -t "installs the bundled DeepSeek plugin"`（零 `testOrigin` 与零 DNS 覆盖，走生产 `MangaProductApp` 安装随包插件、读取模型列表、加入 5 个连接、重开 Profile、探测 `deepseek-flash` 并测试转录/合成/搜索三项服务），`4.68 s` 全部通过，共 9 个请求。本轮修复验证合计 27 个请求（子任务自检 18 + 最终合入复核 9），整个阶段累计不超过 115 个请求（此前 ≤ 88 + 本轮 27）、估算低于 0.35 美元，在 ACT-23 授权的 300 个请求、2 美元以内；密钥与本机路径未出现在任何输出、证据或提交中。
  5. **更新本机开发版（`node scripts/stage.mjs install-dev`）**：从上述最终桌面包构建开发版按用户安装包后执行通过（`13.57 s`），正在运行的 `MANGA Dev`（`0.1.2-dev.202611150931`）经 `--quit-for-update` 保存退出，静默覆盖安装并重新启动就绪为 **`0.1.2-dev.202611151303`**（正式版零触碰，`releaseUntouched: true`）。产品验收与 [USER-ACTIONS.md](../../USER-ACTIONS.md#checks) 中各项 `H-*` 保持 `not-run`。

<a id="a135"></a>
## 12. 阶段内追加：开发版装完常驻托盘（A-135，2026-11-16）

用户要求把其他项目开发版的同一规范同步到本阶段：开发版常驻运行，每次本机重装后都要在后台（托盘）把它打开（[A-135](../decisions/confirmed-decisions.md)）。

| 要求 | 实现位置 | 验证 |
| --- | --- | --- |
| 每次安装成功后都在托盘打开 `MANGA Dev`，不论原来是否在运行；门禁演练用的测试身份保持“原来在运行才按原参数重开” | `scripts/stage/install-dev.mjs`：`background` 默认对真实开发版为真，安装后总启动并加 `--background`（`launchArgsAfterInstall`）；`install-dev.json` 新增 `background`、`inJob` | `tests/update/install-dev-recovery.test.ts`：原来在运行 / 没运行两种都在托盘打开、只加一次 `--background`；测试身份默认不启动 |
| 脱离 Agent 命令沙箱的作业对象；不允许脱离时照常启动并如实报告 | `launchOutsideJob`：Node 不能请求 `CREATE_BREAKAWAY_FROM_JOB`，由一段 PowerShell 调 `CreateProcessW`，被拒（拒绝访问）时去掉该标志重试，再用 `IsProcessInJob` 判断；`inJob` 时命令输出提示从开始菜单打开一次 | 同一测试文件在 Windows 上真实启动一个不开窗口的控制台进程并读回 `pid`、`inJob`；按 Windows 规则引用参数（空格、引号、结尾反斜杠） |
| `--background` 启动不显示窗口，只出现托盘图标 | `apps/desktop/src/main/index.ts`：`startInTray` 时窗口 `show: false`、`skipTaskbar: true`，再 `windowTray.parkInTray()`；建不了托盘图标时照常显示窗口。`apps/desktop/src/main/tray.ts`：新增 `parkInTray()` | `tests/runtime/tray.test.ts`：从未显示的窗口进托盘、不重复建图标，点托盘图标后显示、获得焦点并回到任务栏；建不了图标时 `parkInTray()` 返回假 |

验证：上述两个测试文件 20 项通过（连同 `tests/update/release-and-install-dev.test.ts` 共 30 项）；`node scripts/check-publication.mjs` 通过；根 `tsconfig` 类型检查通过。整套 `stage gate` 未重跑（按[两级门禁](../dev-rules/quality-gates.md#gate-tiers)）；门禁里调用 `runInstallDev` 的三处（包观察、升级演练、轻量窗口）都用测试身份，行为不变。本机已装的 `MANGA Dev` 仍是 `0.1.2-dev.202611151303`，要到下一次需要你人工检查、Agent 执行 `stage install-dev` 时才带上这项改动。

<a id="feedback-2026-11-17"></a>
## 13. 阶段内追加：标题栏、托盘、对话模型与本周发布失败（A-136、A-137，2026-11-17）

用户 2026-11-17 的四项反馈，按 [A-136](../decisions/confirmed-decisions.md)、[A-137](../decisions/confirmed-decisions.md) 实现并合入同一阶段提交；没说到的细节按用户待办 Q-42 的默认值。

| 反馈 | 实现位置 | 验证 |
| --- | --- | --- |
| 去掉标题栏的后退、前进与“文件、编辑、视图、帮助”，主区的标签挪进标题栏（类 Obsidian），其他图标跟着侧栏与对话栏变化 | `apps/desktop/src/renderer/shell.tsx`：没有横贯的一行，图标栏顶部是侧栏开关，`TitleEnd`（状态、停止、对话栏开关、窗口按钮）停靠栏常驻时放在它的顶部，否则放在主区右上并量出宽度（`--title-end-w`）；主区窄到右端旁边不足 200 px 放标签时（接近手机比例的窄窗）标题栏在主区上方单独占一行、标签移到下面（`data-title-row="own"`）；`styles-frame.css`：各栏顶部 36 px，标签条空白、侧栏标题行、对话栏顶部与设置的空白条是拖动区，`styles.css` 让弹出的菜单、对话框与胶囊不被拖动区盖住；拖动区只算屏幕上的视图（别的视图的标签条隐藏着仍排在下面，Chromium 也收它们的拖动区）；`workbench.tsx` 去掉菜单、关于弹窗与只在菜单里的屏幕全屏；`settings/update-page.tsx` 加许可证与“复制版本信息” | `tests/shell/window-frame.test.tsx`（右端随停靠栏移动、窄窗、拖动区规则）、`shell-ui`、`window-fullscreen`、`reader-fullscreen-capsule`、`settings-view-ui`、`media-flows`、`workspace-flows`、`update-ui`；窗口观察 `workspace-frame`、`frame-*`、`version-about` 与 `rail-walk`、`bench-window` 改为按新结构测量（标签在窗口顶边、窄窗标签在单独一行之下、标签不伸到右端按钮下、`Alt+←/→`、版本信息在“设置 › 更新”、悬停卡片从标题栏之下开始）；`workspace-menu` 改为核对菜单里的命令从现在的位置都能用（标签条的布局菜单、标签键、侧栏的新对话与新项目、搜索、三个开关、设置的快捷键页与版本），分屏与上下文的观察改用标签条的布局菜单 |
| 对话页选模型（没有 DeepSeek 模型可选）、思考强度与上下文窗口 | `workspace/model-choice.tsx`：选择器列出对话模型与提供者目录里可加入的模型，选中即加入；`AgentChatSettingsSchema` 存在 `settings.agent.chat`；`commands/agent.ts` 选连接（项目的模型优先、选定的不在时退回第一个）并把选择冻结进运行快照，`agent-context.ts` 的 `withChoice` 改窗口、最大输出与思考档，`agent-run.ts` 重试沿用 | `tests/agent/chat-model-choice.test.ts`（假 DeepSeek 上的请求体、预算、重试、退回）、`tests/shell/chat-model-picker.test.tsx` |
| 真实对话返回 400 | 原因：DeepSeek 只接受 `^[a-zA-Z0-9_-]+$` 的函数名，命令名带点（`library.find`）。`packages/model-protocol/src/tool-names.ts` 在发出前换成合规且不重复的线上名、回来时换回，`pi-ai.ts` 三条路径都经过它；`http.ts` 的 4xx 错误带上提供者的原因（去掉请求号与密钥形状的内容）；假服务按真实规则拒绝 | `tests/agent/deepseek-thinking.test.ts`、`acceptance-regressions`（脱敏）；真实对话见下 |
| 本周测试发布失败（定时 Release 在 `check` 失败） | 原因：`settings-view-ui.test.tsx` 偶发失败，暴露真实竞态：工作区控制器在保存的外壳偏好读到之前就改了图标栏，保存还在路上时读到的偏好被跳过，保存的设置页、隐藏的图标与顺序在界面上丢掉。`App.tsx` 改为记下每个还在保存的改动，读到保存的偏好后把它们叠上去 | 新增的回归测试先在旧代码上失败、修复后通过；修复要合并进 `main` 后才对发布生效（ACT-24 第 4 步） |
| 托盘图标常驻；最小化不进托盘；关闭按钮进托盘，设置可改为退出 | `apps/desktop/src/main/tray.ts`：启动即建图标、不随还原销毁，新增 `hideToTray()`；`main/index.ts`：关闭时读外壳偏好 `window.closeToTray`（默认真），收进托盘或照原流程保存后退出，`before-quit` 与系统结束会话时一律退出；`settings/general-page.tsx`：“窗口 › 关闭按钮”（只在有托盘图标时显示）；A-135 的 `--background` 不变 | `tests/runtime/tray.test.ts`（13 项）、`tests/shell/close-button-setting.test.tsx`、`tests/library/sidebar-lists.test.ts`（偏好的默认、修改与旧记录）；窗口观察 `window-minimize-tray` 改为核对常驻图标、最小化与关闭进托盘再带回；`workspace-restart` 的真实关闭先选“退出 MANGA” |

**真实 API（ACT-23）：** 先用 1 个请求复现 400（带点的函数名，“does not match pattern”），修复后在 `MangaProductApp` 里带全部 Agent 工具各做一次 Flash 默认、Pro 最高思考 128K、Flash 关闭思考的对话，三次都成功。本阶段累计 ≤ 119 个请求、估算不到 0.36 美元，在 300 个与 2 美元之内；输出与证据里没有密钥。

**验证：** `node scripts/verify.mjs` 通过（全量 vitest 262 个文件、3147 项通过，15 项跳过；根与桌面类型检查）。快速门禁（`quick-gate --phases window-walk,update,workspace-restart,workspace-closed`）的打包观察：`window-walk` 与 `update` 全部通过；`workspace-restart`、`workspace-closed` 在随后单跑（`window-walk,workspace-restart,workspace-closed`）中通过。门禁里查出并修好的问题：窄窗时标签伸到右端按钮下（改为单独一行）；隐藏视图的标签条拖动区可能吞掉可见标签上的点击；走查的点击助手会点到隐藏视图或还在布局中的标签（改为只找屏幕上的视图、位置稳定后再点）。`workspace-restart` 重启后注入的点击在这台机器上按旧的缩放落点（发往 835 的点击到了 669，只影响注入的输入），这时走查在页面里按下标签并在证据里记下 `injectedClickMissed`。本机开发版用 `stage install-dev` 更新到 `0.1.2-dev.202611191320`（提交 `e5be8ed` 的源码，在托盘打开）；这次起 `install-dev` 在没有当前安装包时自己打包、做安装包，不先跑门禁（2026-11-19 用户要求）。整套 `stage gate` 没有重跑；产品验收保持 not-run：人工检查 [H-121](../../USER-ACTIONS.md#h-121)—[H-123](../../USER-ACTIONS.md#h-123) 未执行。

<a id="pre-merge-cleanup-2026-11-21"></a>
## 14. 合并前全仓审查重构、无用代码与文档清理及依赖刷新（2026-11-21）

合并前按用户授权，将全仓多领域代码审查重构、无用代码与文档清理，以及远端 Dependabot PR 依赖刷新一并收敛至当前阶段分支 `feat/m13-deepseek-plugin` 的单一 DCO 提交：

1. **全仓审查与质量重构（7 个领域并行核验）：** 修复基础契约/存储/网络与协议、应用核心/Agent/插件/提供者、媒介/视频/漫画/弹幕/元数据/扫描/创作工作区、语音与听写、桌面渲染层外壳/设置/阅读器/聊天，以及 Electron 主进程/预加载/轻量窗口/门禁与烟测脚本中的安全、并发、资源释放与边界缺陷；主进程 `apps/desktop/src/main/index.ts` 拆分为 `ipc-handlers.ts`、`quit-for-update.ts`、`detached-installer.ts`、`window-assets.ts`，门禁脚本抽取 `scripts/stage/win-process.mjs` 并登记进 `scripts/stage/gate.json`；`apps/desktop/tsconfig.json` 打开 `erasableSyntaxOnly: true`；生产与烟测代码清零显式 `any` 与 `eslint-disable`，补齐 25 个定向回归测试文件，全量测试期间 React 与应用侧 stderr 警告清零。另将 `tests/voice/vad-worker.test.ts` 与 `tests/voice/timeline-30min.test.ts` 对合成 30 分钟录音句数的断言改为相对 `truth.json` 实际生成句数（`>= 100` 且漏检 `<= 1`），避免本机 Windows SAPI 语音包语速差异导致固定句数误报。
2. **无用代码、文档与工作区残留清理（遵循[文档治理第 8.4 节](../governance/documentation-policy.md#stage-cleanup)）：**
   - 确认全部 70 份受控 Markdown 均有效登记且无过期文件；修正 `docs/modules/metadata.md` 失效测试路径（改为 `tests/metadata/bangumi-matching.test.ts`）、[ADR-0007](../decisions/0007-technology-stack.md) 已替代脚本注记、[`docs/README.md`](../README.md)、[`docs/delivery/status.md`](status.md)、[`docs/dev-rules/repo-map.md`](../dev-rules/repo-map.md) 与 [`USER-ACTIONS.md`](../../USER-ACTIONS.md)（`ACT-08`、`ACT-24`）。当前阶段计划、报告与 `docs/evidence/gate/` 按规则保留至合并后。
   - 删除死文件与死导出：`apps/desktop/vite.parse-worker.config.ts`、`scripts/inventory-deps.mjs`、`packages/contracts/src/report.ts`；清理 `packages/contracts/src/{ids,location}.ts`、`packages/model-protocol/src/deepseek-services.ts`、`packages/app-core/src/domain/note-document.ts`、`scripts/desktop-paths.ts`、`scripts/samples/pdf-embedded-font.ts`、`scripts/tools/{fetch-ffmpeg,fetch-speech-asr}.mjs` 中的零引用符号；移除无引用的 `@electron-forge/plugin-fuses` 及其 `knip.json` 忽略项。
   - 删除 3 份安全可弃的本机临时残留（`tsconfig.tsbuildinfo` 31.7 KB、`dist/a-review-gate.log` 766.6 KB、`dist/a-review-install-dev.log` 1.5 KB，合计 ~800 KB）；严格保留 `.env.local`、`.local/`、开发 Profile、随包工具、合成样本与当前门禁运行目录。
3. **远端 Dependabot PR 与合并前依赖刷新（A-132，严格遵守 7 天 `minimumReleaseAge: 10080`）：**
   - **PR `#23`**：并入 `actions/setup-node` `7.0.0 → 7.1.0`（完整 SHA `949feb2413d6458794dcd2491c4babbbce0c15c1`），`scripts/check-workflows.mjs` 通过。
   - **PR `#26`**：`@types/node 26.6.6` 已在 2026-11-14 盘点并入本分支，合并后关闭。
   - **PR `#27`**：并入全部 17 项满 7 天同主版本更新（含 `@napi-rs/canvas 1.0.13 → 1.1.1` 复试通过、原例外关闭，以及 `dockview-react 8.8.3 → 8.9.0` 并移除 `pnpm-workspace.yaml` 临时覆盖）；其中 4 项未满 7 天的候选按发行龄规则采用已满龄版本（`user-event 14.6.10`、`better-sqlite3 13.1.1`、`electron 45.3.2`、`lucide-react 1.72.0`）。
   - **PR `#25`（`jsdom 30.1.3 → 31.0.1`）**：单独试用后因 `tests/voice/record-ui.test.tsx:171` 脱离文档节点 `pointerUp` 冒泡行为变化失败，回退至 `30.1.3` 并记录复查条件于 [ADR-0007](../decisions/0007-technology-stack.md)。
   - `node scripts/deps.mjs --audit` 通过（0 条未处理漏洞，3 条已登记例外均未过期）。详细版本记录见 [ADR-0007](../decisions/0007-technology-stack.md)。
4. **验证：** 为 `tests/library/unassigned-recover.test.ts` 与 `tests/shell/roughcut-ui.test.tsx` 的临时目录清理补齐 Windows `EPERM` 重试参数（`maxRetries: 10, retryDelay: 100`，与 `tests/helpers/global-temp.ts` 一致），消除并行 Vitest 卸载时的句柄偶发抖动；合并前最终 `node scripts/verify.mjs` 覆盖全量门禁（语法、70 份文档与 1130 处本地链接、49 项脚本反例、公开内容、工作流与随包工具锁、依赖方向与轻量/语音闭包、根与桌面 `tsc --noEmit`、`knip` 零提示、Vitest 287 个文件通过 / 9 个按条件跳过、3,305 项用例通过 / 15 项跳过、0 项失败、0 条 React/应用侧 stderr 警告、`git diff --check`）。产品验收与人工检查 [H-112](../../USER-ACTIONS.md#h-112)—[H-123](../../USER-ACTIONS.md#h-123) 保持 not-run（A-53）。
