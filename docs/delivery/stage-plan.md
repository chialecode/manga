# 当前阶段计划（M13）：DeepSeek 插件

日期：2026-11-14。角色：A 规划；B 连续实施与自检；A 集中审查。本文是整个阶段的唯一计划，兼作跨模块变更提案（A-46）。B 的执行 prompt 在[第 11 节](#prompt)，不另建 prompt 文件。路径固定、不带阶段名；下一阶段开始时由 A 按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)改写。上一阶段的计划与报告在合并提交里：[计划归档](https://github.com/chialecode/manga/blob/92d1b0b/docs/delivery/stage-plan.md)、[报告归档](https://github.com/chialecode/manga/blob/92d1b0b/docs/delivery/stage-report.md)。

用户 2026-11-14 要求：下一阶段把 DeepSeek API 作为一个插件接入。DeepSeek 于 2026-11-13 开放了一整套应用 API，包括网页搜索、语音合成、语音识别，以及 DeepSeek 自己的大语言模型，正适合本项目。新增的 DeepSeek 插件启动后，模型列表里就能加入对应的模型。用户把真实 API 密钥放在 `.local/` 下，并授权做真实 API 测试。

范围记为 **A-133**，插件的形态与各项能力的接法记为 **A-134**。A 没说到的细节先定了默认值，登记为[用户待办的 Q-41](../../USER-ACTIONS.md#q-41)，B 按默认实现，用户以后可以改。真实 API 测试的授权范围登记为 [ACT-23](../../USER-ACTIONS.md#act-23)。新增需求 PLUG-07、MODEL-06、MODEL-07、VOICE-18、VOICE-19、SEARCH-03，验收为 [AT-184—AT-193](roadmap-and-acceptance.md#at-deepseek)。

本计划一次列出本阶段的全部交付、退出条件和收尾流程。B 连续完成全部工作包后一次交付，A 一次集中审查。人工检查与待决问题按 A-53 记在用户待办，不阻塞开发。

## 1. 范围与退出条件

| 项目 | 约定 |
| --- | --- |
| 阶段 | 阶段开始的整理（C0）；依赖盘点（D1）；声明式提供者插件与 `model.provider` 位置（P1）；从提供者加入模型、提供者账户与 schema v17（M1）；DeepSeek 对话模型的思考模式与工具循环（L1）；原生联网搜索（N1）；网页搜索工具与材料搜寻（G1）；DeepSeek 语音识别接入识别引擎（A1）；语音合成与回答朗读（R1）；小说朗读（R2）；服务的测试、用量与费用估算（U1）；真实 API 契约（X1）；测试、走查与基准（T1）；文档（W1） |
| 代码基线 | `main @ 2726b0e`（上一阶段的 [PR #21](https://github.com/chialecode/manga/pull/21) 于 2026-11-14 squash 合并为 `92d1b0b`，#22 只改文档）；没有未合并的前置分支 |
| 工作分支 | `feat/m13-deepseek-plugin`，A 已从基线创建。本计划所在的提交是阶段提交的起点；B 的实施、A 的审查修复与人工反馈修复全部 amend 进同一提交 |
| 关联需求 | 新增 PLUG-07、MODEL-06、MODEL-07、VOICE-18、VOICE-19、SEARCH-03。受影响的既有行为：MODEL-01、MODEL-02 新增“语音合成”与“网页搜索”两种用途；MODEL-05 的推理等级加上 `max`（只对声明了它的模型显示），“原生联网搜索”第一次有实际接法；VOICE-13 的外部引擎加上 DeepSeek 语音识别；AGENT-04 按任务加上的外部调用加上“联网搜索”；资料库结构升到 v17 |
| 关联验收 | 新增 AT-184—AT-193；既有的全部窗口观察、`installer` 步骤与基准照常重跑 |
| 可连续执行 | 本地实现；合成样本与本机假服务；测试、打包（含用开发机上的第一方私钥签名新插件）、基准、文档同步；第 5.1 节的整理；阶段提交与 amend；**在 ACT-23 的额度内调用真实的 DeepSeek API** |
| 外部操作 | 未授权：push、PR、合并、触发 workflow。A 审查收敛后在用户待办登记一项授权请求（push、PR、合并）。真实 API 只按 ACT-23 调用；其余测试只用本机的假服务 |

**退出条件与覆盖**

| 条件 | 做法 | 工作包 | 验收证据 |
| --- | --- | --- | --- |
| DeepSeek 是一个可装、可停、可卸的插件 | 第一方签名的声明式插件 `manga.provider-deepseek` 随应用提供；不起进程；只能引用宿主已有的接法；停用或卸载后它的连接保留但不可用，零网络请求 | P1 | AT-184 |
| 插件启用后，模型列表里能加入 DeepSeek 的模型 | “设置 › 模型”出现“从 DeepSeek 加入”；填一次密钥，按 `GET /models` 列出模型（离线时用插件里的目录），连同语音识别、语音合成、网页搜索一起勾选加入；模型配置自动填好；同一账户共用一把密钥；schema v17 | M1 | AT-185 |
| DeepSeek 对话模型能带工具干活 | 两个运行时都能正确开关思考、设推理等级（含 `max`），工具循环里回传 `reasoning_content`；后台小任务关思考；对话里可展开思考过程 | L1 | AT-186 |
| 联网搜索可用、来源可见 | 按任务勾选“联网搜索”：DeepSeek 对话模型用内置搜索（自动开思考），显示搜索进度与引用来源，下一轮原样回传；其他模型用网页搜索工具 | N1、G1 | AT-187、AT-188 |
| 网页搜索是一种服务 | 网页搜索工具 `web.search` 按任务开放给 Agent；项目的材料搜寻可以搜网页，再抓取保存 | G1 | AT-188 |
| DeepSeek 语音识别能听写、能转录 | 作为外部转录引擎；不送热词与提示；按上限分块；失败不换服务 | A1 | AT-189 |
| 能把文字读出来 | 语音合成是一种用途；回答的“朗读”边合成边播放；小说从当前位置朗读、高亮当前段、翻页跟随 | R1、R2 | AT-190、AT-191 |
| 服务能测试、用量能看到 | 识别、合成、搜索各有“测试”；使用记录记识别秒数、合成计费字数、搜索次数与估算费用；错误分类（密钥、余额、限流、繁忙） | U1 | AT-192 |
| 真实服务上走通 | 在 ACT-23 的额度内，用合成内容在最终源码上跑一次真实契约，只记聚合结果 | X1 | AT-193 |
| 阶段开始的整理 | 上一阶段的报告提炼后删除；去掉以前阶段的标签；按内容整理文件 | C0 | 文档检查；报告的整理记录 |
| 依赖盘点 | 先处理开着的 Dependabot PR，再按 `node scripts/deps.mjs` 升级满 7 天的版本（A-35、A-132） | D1 | ADR-0007 版本表；完整回归 |

**阶段完成的判定。** 以下依次满足后，Agent 侧完成，可以请求用户授权 push、PR 与合并（A-24、A-53）：（1）B 自检的必需用例与门禁全部通过，X1 在最终源码上跑过；（2）A 集中审查收敛。人工检查与待答复问题记在用户待办，不是合并的前提；`productAcceptance` 保持 not-run。

## 2. A 已核对的现场

| 项目 | 现状（2026-11-14 核对） | 对本阶段的影响 |
| --- | --- | --- |
| 插件 | `packages/contracts/src/plugin.ts`：位置只有 `acquisition.engine`，界面部分只有 `acquisition`；`entry: null` 的包不能填位置。宿主开放给插件的请求只有 `log`。打包脚本 `scripts/pack-plugin.mjs` 打包并签名 `plugins/` 下的每个插件，私钥取 `MANGA_PLUGIN_SIGNING_KEY` 或开发机上的 `%APPDATA%\manga-release\plugin-signing.key`；随包插件列在 `apps/desktop/src/main/bundled-assets.ts` | 新增声明式位置 `model.provider`，允许无 `entry` 的包填它（4.1） |
| 模型连接 | 契约 `packages/contracts/src/model.ts`（用途 `text`、`transcription`、`embedding`、`vision`）与 `inputs-models.ts`（模型配置：窗口、输出、输入类型、能力、推理等级 `minimal`—`high`、转录接口）；命令 `packages/app-core/src/commands/connections.ts`；表 `provider_connections` 每行一个模型、各自一把密钥；界面 `apps/desktop/src/renderer/pages/settings/models-page.tsx`、`connection-dialog.tsx`；测试连接时已会读 `/models`（`packages/app-core/src/model-probe.ts`） | 加提供者账户与两种用途；DeepSeek 的推理等级与思考开关（4.2、4.3） |
| 自研运行时 | `packages/model-protocol/src/openai-http.ts` 只发 `reasoning_effort`，不发 `thinking`，也不读不回传 `reasoning_content` | DeepSeek 默认开思考：带工具的第二次请求会返回 400，必须修（4.3） |
| pi 运行时 | `@earendil-works/pi-ai` 1.4.0 已按地址识别 DeepSeek（`thinkingFormat: "deepseek"`、`requiresReasoningContentOnAssistantMessages`、`max_tokens`）。1.5.0 已满 7 天，按 D1 升级 | 升级后重新核对；B 核实 MANGA 自己转成 pi 上下文时没有丢掉思考块（4.3） |
| 原生联网搜索 | `inputs-models.ts` 的能力里有 `web_search`（界面叫“联网搜索”），但没有任何代码用它 | 本阶段第一次接上（4.4） |
| 按任务加上的外部调用 | `AGENT_OPT_IN_COMMANDS` 为 `metadata.search`、`semantic.search`、`webpage.fetch`（`packages/app-core/src/commands/access.ts`；输入 `packages/contracts/src/inputs.ts` 最多 3 项；界面 `apps/desktop/src/renderer/workspace/agent.tsx`） | 加“联网搜索”（4.4、4.5） |
| 识别引擎 | `packages/app-core/src/voice/engine/asr-engine.ts` 的能力描述决定送热词、提示还是上下文；外部接口为 `audio_transcriptions` 与 `chat_input_audio` | 加 DeepSeek 语音识别的接法（4.6） |
| 语音合成 | 产品里没有任何语音合成或朗读 | 新功能（4.7、4.8） |
| 资料库 | `PRODUCT_SCHEMA_VERSION = 16`（`packages/storage-drizzle/src/sql.ts`） | 升到 v17（4.2） |
| 本地参考索引 | 找到。按“插件化、模块化设计”与“Agent 的 BYOK”两个条目看过：提供者插件带一份“建议的模型目录”，再用 `GET /models` 的实时列表覆盖；密钥按提供者账户保存。A 另在索引的建议文件里追加了一条（搜索过程、引用来源与朗读的界面，P-07，见用户待办的本地参考建议） | 4.1、4.2 采用“目录 + 实时列表”和“账户共用密钥” |

## 3. 官方接口与真实探测（2026-11-14）

**官方文档**（查询日期 2026-11-14）：[构建聊天应用](https://api-docs.deepseek.com/guides/build_a_chatbot)、[更新日志](https://api-docs.deepseek.com/updates)（2026-11-13“发布全套应用 API”）、[模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)、[联网工具](https://api-docs.deepseek.com/guides/web_tools)、[搜索与抓取](https://api-docs.deepseek.com/guides/search)、[语音识别](https://api-docs.deepseek.com/guides/asr)、[语音合成](https://api-docs.deepseek.com/guides/tts)、[OCR](https://api-docs.deepseek.com/guides/ocr)。

| 能力 | 接口与限制（官方文档） | 本阶段 |
| --- | --- | --- |
| 对话模型 | `POST https://api.deepseek.com/chat/completions`（另有 Responses 与 Anthropic 格式）；`deepseek-flash`（V4.1 Flash，文本与图片）与 `deepseek-v4-pro`（只收文本）；上下文 1M；思考默认开、默认等级 `high`，开关为 `thinking: {type}`，等级 `reasoning_effort` 为 `low`/`high`/`max`；带工具时之后的每次请求都要原样回传 `reasoning_content`，否则 400；思考模式下 `temperature` 等无效 | 用 Chat Completions；两种模型都进目录 |
| 内置联网工具 | `tools` 里加 `{"type":"deepseek_web_search"}`、`{"type":"deepseek_read_url"}`；回答带 `annotations`（`url_citation`）与 `server_tool_calls`，流式时进度在 `server_tool_event`；多轮时要把 `server_tool_calls` 原样带回；`tool_choice` 不能点名联网工具 | 用作“原生联网搜索” |
| 网页搜索 | `POST /v1/tools/search`：`query` 1—128 字符，`count` 1—50；结果有标题、链接、摘要、日期、权威度；按成功的请求计费，每千次 0.75 美元；每账户 100 QPS | 用作网页搜索服务 |
| 网页抓取 | `POST /v1/tools/fetch`：返回 Markdown | 不在本阶段（LOOP-44） |
| 语音识别 | `POST /v1/tools/asr`，`multipart/form-data` 的 `file`；16 位 PCM WAV 或 Ogg Opus；≤ 8 MiB、≤ 120 s；自动识别 21 种语言，没有语言、热词或提示参数；不支持流式；返回 `text` 与 `duration_ms`；按秒计费，每小时 0.116 美元（限时半价） | 外部转录引擎 |
| 语音合成 | `POST /v1/tools/tts`：`text`（≤ 10,000 计费字符、请求体 ≤ 64 KiB，汉字算 2 个）、`voice_id`（`stella` 女声默认、`tide` 男声）、`format`（`wav` 默认、`pcm` 为 24 kHz 16 位单声道）、`filter_markdown`（默认开）；边合成边返回；中途失败时响应被截断，提前结束按失败处理；不能调语速；另有 WebSocket 流式接口；每万计费字符 0.45 美元（限时半价） | 用 HTTP 接口；WebSocket 不在本阶段（LOOP-45） |
| OCR | `POST /v1/tools/ocr`：PDF、Word、PowerPoint 与图片；≤ 100 MiB、≤ 1000 页 | 不在本阶段（LOOP-43） |

**A 用真实密钥做的探测**（ACT-23 授权内，共 7 个请求，只用合成内容，密钥与返回内容不进仓库）：

1. `GET /models` 返回 200：`deepseek-flash` 与 `deepseek-v4-pro`，都有 `context_window: 1048576`、`max_output_tokens: 393216`、`effort.supported_levels: ["low","high","max"]`、`default_level: "high"`；`input_modalities` 前者为文本与图片、后者只有文本。**模型目录可以完全由这个接口填出。**
2. 关思考时把 `deepseek_web_search` 与一个函数工具放在一起：400，原因是“函数工具只有在思考模式下才能与 `deepseek_web_search`、`deepseek_read_url`、`safety_check`、`title` 同时使用”。
3. 开思考（`low`）时同样的组合：200，模型调用了函数工具，回答带 `reasoning_content`。**结论：原生联网搜索可以和 MANGA 的工具同用，但必须开思考。**
4. 语音合成一句 13 个汉字：200，`audio/wav`，24 kHz、单声道、16 位。（为排查一个本机路径问题多发了 1 次。）
5. 把这段合成语音送语音识别：200，文字与原句逐字相同，`duration_ms: 3280`。
6. 网页搜索 1 次（`count: 2`）：200，结果字段与文档一致。

**选型与开源查证（A-40）。** 本阶段不新增第三方依赖：
- 对话：继续用仓内的自研运行时与 pi-ai（1.4.0 已识别 DeepSeek，按 D1 升到 1.5.0 后重新核对）。DeepSeek 没有官方的 JavaScript SDK，官方示例用 OpenAI 兼容接口；不为此引入 `openai` 包。
- 语音合成的播放：用 Chromium 的 Web Audio（`AudioWorklet`），仓内已有 `apps/desktop/src/renderer/voice/pcm-worklet.ts` 可以参照。npm 上的 PCM 播放小库多年未维护，平台接口足够。
- 分句：用 `Intl.Segmenter`。
- 界面：按第 4、6 节的行为说明实现。本地参考索引里有一条对应功能领域（搜索过程与引用来源的显示、边合成边朗读）的新建议 P-07 待用户确认，确认前 B 不看。

## 4. 设计

<a id="design-plugin"></a>
### 4.1 声明式提供者插件（P1）

- **新位置 `model.provider`。** `PLUGIN_SLOTS` 加 `model.provider`。它是声明式的：`entry: null` 的包可以填它（其他位置仍要求 `entry`）。清单加一个可选字段 `provider`：载荷里的提供者文件名（例如 `provider.json`），只在填了 `model.provider` 时允许、并且必填。提供者文件和其他载荷文件一样受签名覆盖。
- **提供者文件（`manga-provider-v1`，Zod 校验，≤ 64 KiB）：** `id`、名称、`baseUrl`（必须是 https）、`hosts`（允许访问的主机，`baseUrl` 的主机必须在里面）、密钥申请页的链接、`discovery`（`openai-models`：用 `GET /models` 列模型）、`models`（建议目录：模型编号、名称、说明、窗口、最大输出、输入类型、能力、推理等级列表与默认、可选的价格）、`services`（语音识别、语音合成、网页搜索各一项：接法编号、名称、限制、可选的价格）、价格的查询日期。
- **只能引用宿主已有的接法。** 接法编号是宿主里的一张白名单：`openai-chat-completions`（加方言 `deepseek`）、`deepseek-asr@1`、`deepseek-tts@1`、`deepseek-search@1`。引用不认识的接法、`baseUrl` 不是 https、主机不在 `hosts` 里的包，`plugin.inspect` 以新的拒绝原因 `provider` 拒绝，不能安装。
- **不起进程，密钥不离开主进程。** 请求都由 MANGA 自己按接法发出，只发往 `hosts` 里的主机，走已有的网络规则（不发往私网、重定向只在允许的主机之间）。插件声明权限 `network`，安装界面写明“由 MANGA 代它访问 api.deepseek.com”。
- **插件包。** `plugins/provider-deepseek/`：`plugin.json`（`id: "manga.provider-deepseek"`、`entry: null`、`provides: [{slot: "model.provider", id: "deepseek"}]`、`permissions: ["network"]`、`facets: []`）与 `provider.json`。目录里的数字取自第 3 节的 `GET /models` 与价格页，写明查询日期。由 `pack-plugin.mjs` 签名，加进随包插件，与 BitTorrent 一样“只提供，不自动安装”（Q-41 第 1 项）。
- **启停的效果。** 启用后提供者立即出现在“设置 › 模型”（`settings.changed` 通知，不用重启）；停用、卸载或信任被移除时，这个提供者的连接保留（含密钥），标为“插件已停用”，所有调用在发请求前以新的错误 `PROVIDER_UNAVAILABLE` 拒绝，网络请求为 0；正在进行的请求取消；重新启用后恢复。卸载时不删连接，用户可以自己删除。
- **插件页。** 声明式插件显示“声明式（不运行代码）”，没有进程占用一栏；其余与现有插件相同。

<a id="design-models"></a>
### 4.2 从提供者加入模型、提供者账户与 schema v17（M1）

- **提供者账户。** 新表 `provider_accounts`（编号、提供者引用 `插件编号/提供者编号`、名称、`credential_ref`、创建时间）。从提供者加入的连接带 `account_id` 与 `provider_model`（目录里的编号），密钥存在账户上：改一次密钥，这个账户下的所有连接都用新密钥；删除连接不删账户；删除账户要先删它的连接，删除时一起删除凭据。手动添加的连接不变。
- **两种新用途。** 用途加 `speech`（语音合成）与 `search`（网页搜索）。转录接口加 `deepseek_asr`。连接的 `adapter_id` 记录接法编号（现有连接迁移为 `openai-http`）。
- **schema v17 迁移。** 新表与新列；迁移前备份、失败回滚、中断后可以重来、较新的库由旧版本拒绝打开；已有连接、密钥与模型配置一条不少。备份与资料包对凭据的处理与现在相同。
- **加入流程。** “设置 › 模型”的“添加模型”变成菜单：“手动添加…”（现在的弹窗）与每个已启用的提供者一项“从 DeepSeek 加入…”。没有安装提供者插件时，列表上方提示“安装 DeepSeek 插件后可以直接加入 DeepSeek 的模型”，并链到插件页。加入弹窗：
  1. 选已有账户，或填一把新密钥（密钥框不回显；链到密钥申请页）；
  2. 点“读取模型列表”：用这把密钥请求 `GET /models`，按返回的窗口、最大输出、输入类型与推理等级显示模型；请求失败时按错误分类说明，并可以“按插件里的目录继续”（标注“未联网核对”）；
  3. 勾选要加入的：对话模型逐个列出，另有“语音识别”“语音合成”“网页搜索”三项服务；默认勾选见 Q-41 第 3 项；
  4. 确认后一次创建账户与各连接（一个事务），模型配置按实时列表填好，来源记为 `detected`；`deepseek-flash` 同时可以用于“视觉”。
- **模型配置。** 推理等级的枚举加上 `max`，只对目录里声明了它的模型显示；DeepSeek 的模型显示“低、高、最高”与“关闭思考”。窗口与最大输出按实时列表；预算计算不变（可用 = 窗口 − 最大输出 − 余量），B 核实 1M 窗口下的压缩与预算用例。
- **默认用途。** 新加入的连接只在该用途还没有选定时成为它的默认，不改用户已有的选择（Q-41 第 4 项）。
- **列表。** 连接按账户分组，组头显示提供者、账户名与插件状态；停用时整组标“插件已停用”，编辑与测试不可用，删除可用。

<a id="design-thinking"></a>
### 4.3 DeepSeek 对话模型的思考模式与工具循环（L1）

- **方言。** 连接的方言来自提供者目录（`deepseek`）；手动添加且地址在 `api.deepseek.com` 的连接也按 `deepseek` 处理，与 pi-ai 的识别一致。方言只在两个运行时的请求构造与回答解析里起作用，不进领域协议。
- **思考开关与等级。** `deepseek` 方言下总是显式发送 `thinking: {type: "enabled" | "disabled"}`：推理等级为“关闭”时发 `disabled`（因为服务默认开），否则发 `enabled` 并发 `reasoning_effort`（`low`/`high`/`max`；`minimal` 映射为 `low`，`medium` 映射为 `high`）。思考开着时不发 `temperature`。
- **回传 `reasoning_content`。** 自研运行时解析流式与非流式回答里的 `reasoning_content`，存进运行记录里那条助手消息；之后的请求按 DeepSeek 的规则原样带回。规则以真实契约为准：B 先用真实 API 确认“跨用户轮次是否也必须带回”（X1 的第 3 项），再定实现，结论写进报告。pi 运行时：核实 MANGA 转成 pi 上下文时保留了思考块，pi-ai 能带回；不能时在转换层补上。假服务对缺少 `reasoning_content` 的请求返回与真实服务相同的 400，两个运行时都要在假服务上走完 3 步以上的工具循环。
- **后台小任务关思考。** 听写润色、录音整理、对话命名、压缩摘要等不需要推理的调用，对 `deepseek` 方言发 `disabled`（Q-41 第 5 项），保证延迟；润色的四道防线与 5 s 超时不变。
- **显示思考过程。** 对话里的回答上方有默认折叠的“思考过程”，展开后显示文字；不进笔记、材料与项目包；调用记录按现有规则记录（可只记大小）。上下文压缩时，旧轮次的思考内容按 DeepSeek 允许的范围最先被丢弃。
- **错误。** `content_filter` 显示为“内容被服务拒绝”；流式中途的 `error` 块按失败处理，可以重试；402（余额不足）归为新的失败分类 `billing`，说明“账户余额不足”。

<a id="design-native-search"></a>
### 4.4 原生联网搜索（N1）

- **入口。** “本次任务”菜单加“联网搜索”，与“抓取网页”等一样按次勾选、重试沿用、下一轮清除。所选对话连接的模型配置勾了能力 `web_search`、方言是 `deepseek` 时走原生搜索；否则配置了网页搜索服务时走 4.5 的工具；两样都没有时菜单项不可用并说明原因。DeepSeek 的目录给 `deepseek-flash` 与 `deepseek-v4-pro` 勾上 `web_search`。
- **请求。** 在函数工具之外加 `{"type": "deepseek_web_search"}`；推理等级为“关闭”时这次任务改为“低”，并在任务开始时说明“联网搜索需要开启思考”。不加 `deepseek_read_url`（抓取用户给的网址仍走 `webpage.fetch`，按项目保存）。
- **显示。** 流式的 `server_tool_event` 显示为回答上方的进度（“正在搜索：关键词”“正在阅读：网站名”）；结束后回答下方列出引用来源（标题、网站、日期），正文里引用的位置可以点开对应来源；来源链接用系统浏览器打开。
- **多轮。** 助手消息原样保存 `server_tool_calls` 与 `annotations`，下一轮按官方规则带回；压缩时与思考内容一同处理。
- **记录。** 调用记录写搜索的次数与关键词（与发送内容同等的脱敏规则）；使用记录写计费的搜索次数（`usage.server_tool_use`）。
- **范围。** 联网搜索不放宽资料范围；不把用户资料库里的文件名、路径或正文自动放进搜索词，搜索词由模型根据对话生成，这一点在菜单项的说明里写明。

<a id="design-web-search"></a>
### 4.5 网页搜索工具与材料搜寻（G1）

- **服务。** `deepseek-search@1`：`query` 去掉首尾空白后 1—128 个字符（超长时截断并在结果里注明），`count` 默认 8、最大 10，`need_content: false`；返回标题、链接、网站、日期、摘要（`snippet`）与较长的摘要（`summary`）。只发往服务的主机。
- **Agent 工具 `web.search`。** 加进 `AGENT_OPT_IN_COMMANDS`（输入契约的上限从 3 改为 4）。只有用户在“本次任务”勾了“联网搜索”、所选模型不走原生搜索、并且配置了搜索服务时才出现在工具清单里；模块或插件停用时命令层拒绝。结果只返回给模型，不自动保存；在项目里，模型可以接着用 `webpage.fetch` 抓取并保存某个结果。
- **材料搜寻面板。** 项目的“材料搜寻”加“搜索网页”：输入关键词，列出结果（标题、网站、日期、摘要），每条可以“抓取并保存”（走现有的 `webpage.fetch`）或在浏览器打开。没有搜索服务时显示怎样配置。
- **错误。** 401、402、429、5xx 与超时分别说明；408、429 与 5xx 按服务端建议有限重试（最多 2 次），其他 4xx 不重试。空结果显示“没有找到”，不算失败。

<a id="design-asr"></a>
### 4.6 DeepSeek 语音识别（A1）

- **接法。** `deepseek-asr@1`：`multipart/form-data` 只有 `file` 一个字段，送 16 kHz 单声道 16 位 PCM WAV（与现在送外部转录的格式相同）；读 `text` 与 `duration_ms`。
- **能力描述。** 不收热词、提示、语言与上下文（全部为 0）；上传上限 8 MiB、时长上限 120 s。所以当前作品的词条只用于识别之后的确定性替换与润色，设置页的引擎说明写明“不支持热词”。
- **分块。** 听写：去除静默后超过 110 s 的，按静默处切成不超过 110 s 的几段依次识别再拼接（听写本身最长 5 分钟）。录音笔记：块长不超过 60 s（Q-41 第 10 项），位置映射与现在相同。
- **失败。** 400（格式）、413、408、504 不重试；429、503 有限重试（最多 2 次，退避）；都失败时保留临时音频供同次重试，不换引擎、不回退到别的服务（VOICE-13 的规则不变），其他服务收到的请求为 0。
- **选择。** 加入后出现在听写与录音笔记的引擎列表里；默认选择按 Q-41 第 9 项。

<a id="design-tts"></a>
### 4.7 语音合成与回答朗读（R1）

- **服务。** `deepseek-tts@1`：主进程发请求（`format: "pcm"`，`filter_markdown: true`，所选声音），读响应体的同时把 PCM 块经 `MessagePort` 交给页面；页面用 `AudioWorklet` 按 24 kHz 播放，收到第一块就开始播。响应提前结束或读流出错按失败处理，已经播出的部分保留，提示“朗读中断，可以重试”。一次请求不超过 10,000 计费字符（汉字算 2 个），超长的按句切成几次请求依次播放。
- **朗读控制器。** 一个应用级的朗读队列：同一时间只朗读一处；开始新的朗读会停掉旧的；有“暂停、继续、停止”；关闭对应的标签或停用插件时停止。听写或录音开始时暂停朗读，结束后不自动继续（Q-41 第 14 项）。朗读时 MANGA 里正在播放的视频不自动暂停。
- **回答朗读。** 对话里每条已完成的回答有“朗读”按钮（只读正文，不读思考过程与来源列表），再点停止；不自动朗读（Q-41 第 12 项）。
- **声音。** “设置 › 语音转录”加“朗读”一节：选语音合成连接、声音（`stella` 女声默认、`tide` 男声）、试听。没有语音合成连接时，朗读按钮不出现，设置里说明怎样加入。
- **缓存。** 合成的音频不写盘；同一段文字在 10 分钟内重复朗读时用内存里的结果（每段上限 8 MiB，总计 64 MiB，最近最少使用淘汰）。

<a id="design-read-aloud"></a>
### 4.8 小说朗读（R2）

- **范围。** TXT、EPUB、MOBI 的小说阅读器（翻页与滚动两种排版）。PDF 与漫画不朗读（LOOP-46）。
- **入口。** 阅读器底栏加“朗读”按钮（窄窗收进“…”），快捷键在单一键位表里加一项（默认不绑定，Q-41 第 13 项）。从当前页第一段开始；有选区时从选区所在段开始。
- **分段与预取。** 按阅读器的段落切分，超过上限的段落用 `Intl.Segmenter` 按句再切；正在读第 n 段时预取第 n+1 段，段与段之间不留可感知的停顿（基准 `readAloudGapMs`）。
- **跟随。** 当前段高亮（用阅读器现有的高亮层，不改正文、不建笔记）；读到当前页之外时自动翻页或滚动；跨章继续；读到书末停止。用户手动翻页时朗读继续，底栏出现“回到朗读位置”。
- **位置。** 朗读不改阅读进度，停止时问一次“把阅读位置移到这里？”（默认是）；不在后台标签继续朗读：标签不可见时暂停，回来时点继续。
- **费用提示。** 第一次在一本书上开始朗读时提示“按字数计费，汉字算 2 个字”，并显示这一章的估算费用；可以勾“不再提示”。

<a id="design-usage"></a>
### 4.9 服务的测试、用量与费用估算（U1）

- **测试。** 识别、合成、搜索连接的“测试”：识别送一段内置的合成 WAV（已有的 `syntheticWav`），合成读一句固定的短句并试播，搜索查一个固定的词（取 1 条）；都只在用户点击时发生，结果与对话连接一样分类显示并保存。
- **用量。** 使用记录按任务与服务列出：对话的 Token（含 DeepSeek 的缓存命中数）、识别的秒数、合成的计费字符、搜索次数；费用按提供者文件里的价格估算，标“估算”与价格的查询日期，不区分高峰与低谷时段（说明里写明）；服务没给的数值显示“未提供”。
- **错误分类。** 连接失败的分类加 `billing`（402）；503 与 429 区分为“服务繁忙”与“请求太多”。

<a id="design-live"></a>
### 4.10 真实 API 契约（X1）

- 契约测试放在 `tests/real/deepseek-contract.test.ts`（与现有的 `tests/real/*-contract.test.ts` 同一做法），只有设置了 `MANGA_LIVE_DEEPSEEK_KEY_FILE` 时运行；B 运行时指向 `.local/deepseek.key`。密钥只从文件读，不打印、不写进日志、证据、快照与报告；所有输出过一遍把密钥替换为 `<key>` 的过滤。
- 只用合成内容：合成的短句、合成图片、虚构的人名；不发送资源库里的任何东西。
- 用例（每次完整运行不超过 40 个请求）：（1）`GET /models` 与目录核对；（2）关思考的普通对话；（3）开思考的 3 步工具循环，两个运行时各一次，并核对跨用户轮次是否必须回传 `reasoning_content`；（4）`deepseek-flash` 看一张合成图片；（5）原生联网搜索加一个函数工具，核对进度事件、引用与下一轮回传；（6）`max` 等级一次；（7）语音合成一句并识别回来（往返相似度）；（8）合成约 2,000 计费字符的一段，核对流式首块时间与提前结束的检测；（9）识别一段约 100 s 的合成语音（分块前的上限附近）；（10）网页搜索 2 次；（11）错误：错误的密钥 401、不存在的模型、空文字合成 400。
- 结果写进报告与执行状态的“真实服务”一节：只记状态码、接口形状、延迟、计费单位与相似度，不记回答全文。
- 额度见 ACT-23：整个阶段（含 A 规划时的 7 个与 A 审查）不超过 300 个请求、估算费用不超过 2 美元；B 在报告里列出实际用量。

## 5. 工作包与顺序

### 5.1 C0 阶段开始的整理（先做）

按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)执行，结果写进报告的“整理记录”。

**A 已做（在本计划所在的提交里）：**

- 上一阶段的报告提炼后删除：仍有效的内容（门禁与评测结果、本地推理的分工、纠错门槛）已在执行状态与各正本里。入链改为归档链接 `https://github.com/chialecode/manga/blob/92d1b0b/docs/delivery/stage-report.md#<锚点>`（`92d1b0b` 已确认在 `origin/main` 的历史里）；`README.md`、`docs/README.md` 与 `docs/SUMMARY.md` 去掉报告（B 新建后加回）。
- 登记表 `currentStage` 改为 `m13`，本计划的 `retireAfter` 改为 `m13`，报告的条目去掉。
- 文档检查报出的上一阶段标签已去掉：执行状态与文档导航里的旧分支名；代码里的四处注释与一个测试名（`dictation-walk.ts`、`commands/voice.ts`、`dictation-integration.test.ts`、`scripts/voice-eval/audio-dsp.mjs`），以及 `scripts/stage/gate.json` 里引用那个测试名的五个用例匹配式（只删去标签，匹配的用例不变）。
- 新增 A-133、A-134；需求 PLUG-07、MODEL-06、MODEL-07、VOICE-18、VOICE-19、SEARCH-03；验收 AT-184—AT-193 与追踪矩阵；交付路线 2.2 改为本阶段，上一阶段移入 2.1；执行状态的当前阶段、分支与下一步；用户待办新增 Q-41 与 ACT-23；后续 loop 新增 LOOP-43—LOOP-46。

**B 执行时再核对一遍：**

| 位置 | 是否入库 | 内容判断 | 处理 |
| --- | --- | --- | --- |
| `.env.local` | 否 | 开发者的本地配置与凭据，必需 | 保留；不读取与任务无关的值 |
| `.local/deepseek.key` | 否 | 用户放的真实密钥（ACT-23） | 保留；只由契约测试按 4.10 读取，不复制、不输出 |
| `.local/gate-run.log`、`.local/loop-phase.log` | 否 | 以前门禁与循环的运行日志 | 看过没有未提炼的结论后删除 |
| `dist/a-review-dict-*.log`、`dist/a-review-gate*.log` | 否 | 上一阶段 A 审查的日志，结论已在归档报告与执行状态里 | 删除 |
| `dist/design-refs/`、`dist/samples/` | 否 | 用户提供的界面参考、合成样本与评测集 | 原样保留 |
| `dist/tools/` | 否 | 固定版本的工具与本地语音模型 | 保留 |
| `dist/desktop/`、`dist/plugins/` | 否 | 上一阶段最后的打包产物 | 阶段末重新打包时覆盖 |
| `dist/evidence-runs/` | 否 | 上一阶段门禁的运行目录 | 本阶段第一次门禁时覆盖；其中的旧日志删除 |
| `%APPDATA%\manga-release\` | 否 | 两把签名私钥（ACT-08） | 原样保留，不读不输出私钥，不得重新生成；新插件用其中的插件私钥签名 |
| 系统临时目录里的 `manga-*` | 否 | 以前失败运行留下的现场 | 确认没有正在运行的门禁后删除，只记数量 |
| `apps/desktop/.vite/`、`tsconfig.tsbuildinfo` | 否 | 构建缓存 | 保留，打包时重建 |
| `docs/evidence/gate/` | 是 | 上一阶段最后一次门禁的证据 | 本阶段最后一次门禁时整体替换 |

**去掉以前阶段的标签（A-57）。** A 已运行文档检查；B 交付前再运行一次。Git 提交信息与固定归档链接里的路径不改。

### 5.2 D1 依赖盘点（A-35、A-132）

按[开发流程 2.6](../dev-rules/development-workflow.md#dependency-inventory)执行：

1. **还开着的 Dependabot PR。** A 2026-11-14 用 `gh pr list` 核对：没有开着的 PR。B 开始时再看一次，有的逐个处理（内容并入本阶段提交、PR 关闭，或写明原因关闭）。
2. **盘点。** A 2026-11-14 运行 `node scripts/deps.mjs`：直接依赖里有 26 项满 7 天的更新，其中 24 项是同主版本（例如 Electron 45.1.0 → 45.2.3、pi-ai 1.4.0 → 1.5.0、Vitest 5.0.5 → 5.1.0、pdfjs-dist 6.4.299 → 6.5.438、Tiptap 3.32.1 → 3.33.0），两项是主版本（`@types/node` 26、jsdom 31）。B 实施开始时重跑一次：同主版本默认全部升级并跑完整回归；pi-ai 升级后重新核对第 2 节所说的 DeepSeek 识别（思考格式、`reasoning_content` 回传、`max_tokens`）；两个主版本单独升级并跑相关回归，失败回退并在 ADR-0007 登记例外。最小发行龄不绕过。
3. **漏洞。** `node scripts/deps.mjs --audit`；有修复版本的先升级，不能修的登记到 `scripts/deps-exceptions.json`（写明原因与复查日期）并写进报告。
4. **门禁前复跑**盘点；结果记入报告与 ADR-0007 的版本记录。

本阶段不新增第三方依赖；确实需要时，先在报告里写明理由与同样的查证。

### 5.3 工作包

| 包 | 内容 | 关键失败路径 | 验收 |
| --- | --- | --- | --- |
| P1 声明式提供者插件 | 4.1 | 提供者文件被改一个字节（签名失败）；引用不认识的接法；`baseUrl` 为 http 或主机不在 `hosts`；`entry` 不为空却填 `model.provider`；停用时有正在进行的对话与朗读；卸载后再装；信任被移除 | AT-184 |
| M1 加入模型与 v17 | 4.2 | v16 资料迁移、中断、旧版本打开；`GET /models` 401、超时、返回目录里没有的模型、少了某个字段；同一把密钥加两次；改密钥后各连接都用新的；删除最后一个连接后删账户；用户已有对话默认时不被改 | AT-185 |
| L1 思考与工具循环 | 4.3 | 关闭思考时服务仍收到 `disabled`；缺 `reasoning_content` 的 400；流式中途 `error`；`content_filter`；402；后台小任务关思考；压缩时丢弃顺序；两个运行时结果一致 | AT-186 |
| N1 原生联网搜索 | 4.4 | 推理等级为关闭时自动改为低并说明；非 DeepSeek 连接不走原生；`server_tool_calls` 下一轮带回；没有引用时不显示来源区；重试沿用勾选；下一轮清除 | AT-187 |
| G1 网页搜索工具与材料搜寻 | 4.5 | 没勾选时工具不在清单、服务收到 0 个请求；超长关键词；空结果；402、429；插件停用时拒绝；从结果抓取保存 | AT-188 |
| A1 DeepSeek 语音识别 | 4.6 | 不送热词与提示；超过 110 s 的听写分段；录音笔记 60 s 一块且位置映射不变；413、429、503；失败时其他服务收到 0 个请求 | AT-189 |
| R1 合成与回答朗读 | 4.7 | 响应提前结束；400 内容风险；超长文字分次；同时点两处朗读；听写开始时暂停；关标签与停插件时停止；内存缓存上限 | AT-190 |
| R2 小说朗读 | 4.8 | 跨页、跨章、书末；手动翻页；标签不可见时暂停；停止时移动阅读位置的询问；滚动排版；选区起读；只有标点的段落跳过 | AT-191 |
| U1 测试、用量与费用 | 4.9 | 三种服务的测试成功与失败；用量里的“未提供”；费用标“估算”；`billing` 分类 | AT-192 |
| X1 真实契约 | 4.10 | 没有密钥文件时记为 not-run；输出里没有密钥；请求数超过上限时停止 | AT-193 |
| T1 测试、走查与基准 | 第 7 节 | — | 第 7 节 |
| W1 文档 | 需求 PLUG-07、MODEL-06、MODEL-07、VOICE-18、VOICE-19、SEARCH-03 按实现改为“已实现”，MODEL-01、MODEL-02、MODEL-05、VOICE-13、AGENT-04 补充；领域模型（v17 的表与关系、两种用途）；插件模块规格（`model.provider` 位置、提供者文件、拒绝原因、启停效果）；新的模块规格“提供者”或在 Agent 模块规格里补一节（按模块规格模板）；语音模块规格（DeepSeek 引擎、朗读）；Agent 协议（联网搜索、`web.search`、思考内容的保存与回传）；外部扩展设计（提供者插件）；交互设计（加入模型的弹窗、思考过程、来源、朗读控件）；数据与安全（提供者账户与凭据、只访问声明的主机、朗读音频不写盘）；质量门禁（新的观察、契约与基准）；仓库地图（新插件目录）；执行状态；README 的模型与插件一节 | — | 文档检查 |

### 5.4 顺序

1. C0；D1 的第一次盘点。
2. L1 的最小验证：在假服务与真实 API 上各让自研运行时走通一次“开思考 + 3 步工具循环”，确认 `reasoning_content` 的回传规则（X1 第 3 项）。这一步决定对话的数据结构，最先做；结论写进报告。
3. P1 → M1（插件、目录、账户、加入流程，打通“启用插件 → 模型列表加入模型”）。
4. L1 其余部分 → N1 → G1（对话、联网搜索与网页搜索）。
5. A1 → R1 → R2（识别、合成与朗读）。
6. U1；X1 在最终源码上完整运行一次；T1、W1；门禁前的 `node scripts/deps.mjs` 复跑；`stage gate`；`stage install-dev`；报告与整理记录。

可以按依赖调整顺序，但不得跳过任何一个工作包。

## 6. 界面要点

- “设置 › 模型”：“添加模型”菜单；按账户分组的列表；“从 DeepSeek 加入”弹窗（账户或密钥、读取模型列表、勾选模型与服务、按实时列表显示的窗口与输入类型）；连接的用途、接法、插件状态显示中文名称。沿用现有弹窗与列表的控件。
- 对话：回答上方折叠的“思考过程”与联网搜索的进度；回答下方的来源列表；每条回答的“朗读”按钮；“本次任务”菜单的“联网搜索”（不可用时说明原因）。
- 阅读器：底栏的“朗读”按钮与朗读中的“暂停、停止、回到朗读位置”；当前段的高亮用主题变量，在深浅主题下都可读。
- 材料搜寻：“搜索网页”与结果列表。
- 所有新控件有可访问名称，可以用键盘操作；朗读状态对读屏软件可见（`aria-live`）；系统开启“减少动态效果”时，朗读的进度提示不做动画。
- 文案用中文，说清原因与下一步，例如“插件已停用：去插件页启用”“账户余额不足”“联网搜索需要开启思考，这次任务已改为低”“朗读中断，可以重试”。

## 7. 样本、门禁与基准

**样本。** 全部合成：虚构的人名与作品名；合成图片；语音由 Windows 自带的语音合成或假服务生成。**假 DeepSeek 服务**在 `packages/model-protocol/src/mock-server.ts`（或同目录新文件）里实现：`GET /models`；`/chat/completions` 的思考、`reasoning_content` 回传检查（缺少时 400，文字与真实服务一致）、`server_tool_event`、`server_tool_calls`、`annotations`、流式中途 `error`、`content_filter`；`/v1/tools/asr`、`/v1/tools/tts`（可配置为中途截断）、`/v1/tools/search`；可配置的 401、402、429、503。测试与打包走查通过测试专用的覆盖把提供者的 `baseUrl` 指到假服务（沿用现有假 Bangumi 的做法，产品构建里不生效）。

**单元与集成用例（新增，必需）：** 提供者文件的校验与拒绝原因；`model.provider` 的启停效果与零网络；v17 迁移（备份、中断、旧版拒绝、连接与密钥一条不少）；账户与凭据的引用与删除；`GET /models` 的映射；两个运行时的思考开关、等级映射与 `reasoning_content` 回传；后台任务关思考；原生联网搜索的请求、解析与回传；`web.search` 的可见性与命令层拒绝；ASR 的请求格式、分块与失败不换服务；TTS 的分次、提前结束检测与内存缓存；朗读队列的互斥、暂停与停止；小说朗读的分段、跟随与位置询问；用量与费用估算；契约测试在没有密钥文件时跳过、输出过滤掉密钥。

**窗口与安装观察（新增，必需；新的走查文件加进 `scripts/stage/gate.json` 的走查分组）：**

| 观察 | 内容 |
| --- | --- |
| `deepseek-plugin` | AT-184：插件页里随包提供而未安装；安装对话框写明声明式与网络权限；安装启用后“设置 › 模型”不重启就出现“从 DeepSeek 加入”；停用后连接标“插件已停用”、对话里选它时拒绝且假服务收到 0 个请求；再启用恢复 |
| `deepseek-models` | AT-185：用假服务加入两个模型与三项服务，模型配置按 `/models` 填好；改密钥；按账户分组的列表；截图（浅色与深色） |
| `deepseek-chat` | AT-186、AT-187：一次 3 步工具循环（假服务检查回传）；展开思考过程；勾“联网搜索”后的进度、来源与下一轮回传 |
| `web-search` | AT-188：材料搜寻里搜索网页并抓取保存一条；Agent 的 `web.search` 在勾选时出现、不勾时不在 |
| `read-aloud` | AT-190、AT-191：回答朗读（假服务的 PCM，检查播放开始与停止）；小说朗读跨页跟随、听写开始时暂停 |
| `dictation` 阶段（已有）扩展 | AT-189：用假 DeepSeek 识别听写一次，热词与提示没有发送 |

上一阶段全部的窗口观察保留。截图只留关键状态，不含本机路径与密钥。

**基准（新增门槛，用假服务，排除网络）：** `ttsFirstAudioMs`：回答朗读从点击到第一块音频进入播放，p95 ≤ 300 ms；`readAloudGapMs`：小说朗读段与段之间的静默，p95 ≤ 150 ms。**记录项：** X1 里真实服务的首块时间、识别用时与搜索用时（不设门槛）。B 先测出基线；门槛达不到时先优化，仍达不到就在报告里写明原因交 A 决定，B 不自行放宽。

**门禁（两级，[质量门禁](../dev-rules/quality-gates.md#gate-tiers)）。** 阶段内的修改只跑快速门禁 `node scripts/quick-gate.mjs [--phases …]`，修复先用子集确认（`MANGA_PACKAGE_PHASES` 与 `MANGA_PACKAGE_REUSE_BUILD`、单个测试文件）。B 把整个阶段交给 A 时，在最终源码上跑一次 `node scripts/stage.mjs gate`：跑前确认机器空闲、启动它的应用在前台、不锁屏，并先在聊天里告诉用户（门禁会打开窗口）；跑的过程中不改工作树。证据整体替换 `docs/evidence/gate/`，总量不超过 5 MiB，复制前先看过新截图。安装包的内容变了（新随包插件），`installer` 步骤照常运行；不做本地发布演练。门禁通过后执行 `node scripts/stage.mjs install-dev`，把装好的版本写进报告。

## 8. 人工检查

B 在用户待办里新增人工检查（编号从 H-112 起），写到用户能直接照做：用自己的 DeepSeek 密钥在插件页安装启用插件、在“设置 › 模型”加入模型（看读取模型列表与默认勾选）；用 DeepSeek 对话模型做一次带工具的任务并展开思考过程；勾“联网搜索”问一个最近的事，看进度与来源；在材料搜寻里搜索网页并保存一条；用 DeepSeek 语音识别听写几句（含作品里的角色名，与本地模型比较）；朗读一条回答、换另一个声音；朗读一本小说几页（听停顿、看跟随与翻页、开始听写时是否暂停）；停用插件后看连接与对话的表现，再启用；在使用记录里看用量与估算费用。真实的鼠标、键盘与麦克风只在人工检查里用，自动观察不移动用户的鼠标、不抢焦点。人工检查保持 not-run，不由脚本代填。

## 9. B 交付与 A 审查

- B 新建本阶段报告 `docs/delivery/stage-report.md`（并加回登记表、`README.md`、`docs/README.md` 与 `docs/SUMMARY.md`）：按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射；写明 L1 最小验证的结论（`reasoning_content` 跨轮回传的规则）；提供者文件的结构与接法白名单；v17 迁移的结果；X1 的结果与实际请求数、估算费用；基准数值与门禁各步用时；依赖盘点结果；整理记录与源码指纹；装到本机的开发版版本。
- B 交付前自检：第 1 节的退出条件逐条有证据；`stage gate` 通过；文档检查通过；暂存内容核对过（不含密钥、本机路径与真实回答全文）；一个带 DCO 签名的阶段提交（amend 本计划所在的提交，消息按最终结果重写）。
- A 审查时重点看：插件停用、卸载或信任移除时零网络请求；提供者只能引用白名单里的接法、只访问声明的主机，密钥不离开主进程、不进日志与证据；v17 迁移有备份、可重来、旧版拒绝，已有连接与密钥一条不少；两个运行时在真实服务上都能走完工具循环；联网搜索不把资料库的内容自动放进搜索词，`web.search` 没勾选时不可用；音频只发往所选的一个引擎；朗读不写盘、听写时暂停；费用标为估算；基准的门槛与测量方法没有被改动；既有观察全部保留。

## 10. 待处理事项入口

- 需要用户的：[Q-41](../../USER-ACTIONS.md#q-41)（本阶段先用的默认值）；[ACT-23](../../USER-ACTIONS.md#act-23)（已授权的真实 API 测试的范围）；本地参考建议 P-07；仍待答复的 [Q-40](../../USER-ACTIONS.md#q-40)、[Q-39](../../USER-ACTIONS.md#q-39)、[Q-38](../../USER-ACTIONS.md#q-38)；[ACT-08](../../USER-ACTIONS.md#act-08)（备份两把私钥）；[ACT-18](../../USER-ACTIONS.md#act-18)。都不阻塞本阶段。
- 新增的后续项：DeepSeek OCR（LOOP-43）、DeepSeek 网页抓取与文件解析（LOOP-44）、边生成边朗读的流式合成（LOOP-45）、PDF 朗读与更多提供者插件（LOOP-46）。留在[执行状态的后续 loop](status.md#followup-loops)。
- 顺延的 Agent 侧后续项保持不变。

<a id="prompt"></a>
## 11. 交给 B 的执行 prompt

```text
你是 Agent B，在本仓库的分支 feat/m13-deepseek-plugin 上连续完成当前阶段（DeepSeek 插件）。

依据：AGENTS.md；docs/delivery/stage-plan.md（本阶段唯一计划，全部工作包 C0、D1、P1、M1、L1、N1、G1、A1、R1、R2、U1、X1、T1、W1，设计 4.1—4.10）；确认记录 A-133、A-134；需求 PLUG-07、MODEL-06、MODEL-07、VOICE-18、VOICE-19、SEARCH-03；验收 AT-184—AT-193；用户待办 Q-41（按其中的默认实现；用户答复后以答复为准）与 ACT-23（真实 API 的授权范围）。

要求：
1. 先核对现场（git status、分支基于 main@2726b0e、计划所在的提交），再按计划第 5.4 节的顺序连续实施，不逐工作包询问。
2. 先做 L1 的最小验证：自研运行时在假服务与真实 API 上走通“开思考 + 3 步工具循环”，用真实 API 确认 reasoning_content 跨用户轮次的回传规则，结论写进报告后再定数据结构。
3. 插件按 4.1：声明式、不起进程；只能引用宿主白名单里的接法、只访问提供者文件声明的 https 主机；密钥只在主进程；停用、卸载或信任移除后连接保留但所有调用零网络请求。新插件由 scripts/pack-plugin.mjs 用开发机上的第一方私钥签名，不读不输出私钥。
4. schema v17 按 4.2：迁移前备份、失败回滚、中断可重来、旧版本拒绝打开，已有连接、密钥与模型配置一条不少。
5. 不新增第三方依赖；依赖盘点按 5.2（先看开着的 Dependabot PR，再跑 node scripts/deps.mjs 与 --audit），最小发行龄不绕过。
6. 真实 API 只按 ACT-23 与计划 4.10：密钥只从 .local/deepseek.key 读（经 MANGA_LIVE_DEEPSEEK_KEY_FILE），不打印、不进日志、证据与报告；只用合成内容；整个阶段的请求数与估算费用不超过 ACT-23 的上限（A 规划时已用 7 个），报告里列实际用量。其余测试只用本机的假 DeepSeek 服务。
7. 联网搜索不放宽资料范围，不把资料库的内容自动放进搜索词；web.search 只在用户为这次任务勾选“联网搜索”时出现。音频只发往所选的一个引擎，失败不换服务。朗读音频不写盘，听写或录音开始时暂停朗读。
8. 基准按第 7 节：两个新门槛先测基线；不改任何既有门槛、样本数与测量方法。
9. 自动观察不移动用户的鼠标、不抢焦点；真实输入与真实账户的检查写进用户待办（计划第 8 节，从 H-112 起）。
10. 改写测试与走查时断言不减，删除的断言在迁移映射里写明由什么替代；新的走查文件加进 scripts/stage/gate.json 的走查分组。阶段内只跑快速门禁 node scripts/quick-gate.mjs；交付前在最终源码上跑一次 node scripts/stage.mjs gate（跑前确认机器空闲、启动它的应用在前台、不锁屏，并先在聊天里告诉用户；跑的过程中不改工作树），通过后执行 node scripts/stage.mjs install-dev；证据替换 docs/evidence/gate/（≤ 5 MiB，截图不含本机路径与密钥，复制前先看过新截图）。
11. 新建本阶段报告 docs/delivery/stage-report.md（计划第 9 节，并加回登记表、README.md、docs/README.md 与 docs/SUMMARY.md），更新用户待办、执行状态与各正本；把全部改动 amend 进本阶段唯一的 DCO 签名提交，消息按最终结果写。不 push、不触发 workflow。
12. 结束时按开发流程 2.4 给出首选下一步：推荐交给 A 集中审查，并附审查 prompt。
```
