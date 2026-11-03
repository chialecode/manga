# 当前阶段计划（M6）：依赖升级与 Agent 工程循环

日期：2026-11-03。角色：A 规划；B 连续实施与自检；A 集中审查。本文是整个阶段的唯一计划，兼作跨模块变更提案（A-46）。B 的执行 prompt 在[第 11 节](#prompt)，不另建 prompt 文件。路径固定、不带阶段名；下一阶段开始时由 A 按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)改写。上一阶段的计划与报告在合并提交里：[计划归档](https://github.com/chialecode/manga/blob/e05fda3/docs/delivery/stage-plan.md)、[报告归档](https://github.com/chialecode/manga/blob/e05fda3/docs/delivery/stage-report.md)。

用户 2026-11-03 在上一阶段合并后说“start next stage”，没有提新的产品要求。按 A-39（MVP 已贯通，之后按反馈循环迭代）与[执行状态的后续 loop](status.md#followup-loops)，A 选的范围是三个阶段以来一直顺延的“下一次依赖与 Agent 工程循环”：

1. **依赖的主版本升级。** Electron 45（同步的 `safeStorage` 接口已废弃、46 删除）、pi-ai 1.x（自 0.85.1 起跨了九个有破坏性变更的版本），以及上一阶段报告里留下的其余新版本。
2. **Agent 的工程余项。** 长对话的列表（LOOP-07）、任务图像材料的存放与保留（LOOP-05）、支持 PDF 与视频输入的模型得到原文件与视频片段（LOOP-17）。
3. **工作区与门禁的余项。** LOOP-24 的第 1、4、5 项；打包烟测的临时目录（LOOP-26）；基准对 Windows 节能降速的评估（LOOP-13）；上一阶段门禁里偶发失败的三个窗口观察（新登记的 LOOP-27）。

2026-11-04 用户补充：

4. **规范数据的存放位置。** 现在全部放在用户的“文档”里不好；只有用户创建的文件适合放在那里，数据库与配置应该放到别的文件夹。可选的位置有 `%APPDATA%`、`%USERPROFILE%\.manga` 等，请 A 参考数据目录比较规范的经典项目给出推荐。
5. **默认安装位置。** 正式版默认安装在 `%LOCALAPPDATA%\Programs\manga`，开发版在 `%LOCALAPPDATA%\Programs\manga-dev`。

记为 **A-117**（本阶段的范围，含第 4、5 点）、**A-118**（数据的存放位置，取代 A-16 里“默认系统文档目录”）与 **A-119**（按用户安装与默认安装位置）。A 的推荐与理由见 3.1 与 4.9、4.10。没说到的细节 A 先定了默认值，登记为[用户待办的 Q-36](../../USER-ACTIONS.md#q-36)（第 11—15 项是第 4、5 点的），B 按默认实现，用户以后可以改。**LOOP-09（删除、导出等待审操作开放给 Agent）不在本阶段**：用户没有提出，而且需要一套新的确认界面，单独规划更合适；它留在后续 loop，用户想要时再排。需求是 MODEL-05、AGENT-06、AGENT-07、CTX-02、DATA-01、DATA-04、DATA-06、NFR-01、NFR-03、NFR-05、UI-09（[需求](../product/requirements.md)），验收是 [AT-141—AT-150](roadmap-and-acceptance.md#at-loop)。

本计划一次列出本阶段的全部交付、退出条件和收尾流程。B 连续完成全部工作包后一次交付，A 一次集中审查。人工检查与待决问题按 A-53 记在用户待办，不阻塞开发。

## 1. 范围与退出条件

| 项目 | 约定 |
| --- | --- |
| 阶段 | 依赖升级与 Agent 工程循环：Electron 45 与异步凭据（W1）；pi-ai 1.x（W2）；长对话的虚拟列表与保留已翻出的页（W3，LOOP-07）；任务图像材料的内容寻址与保留期、schema v13（W4，LOOP-05）；原生 PDF 与视频输入（W5，LOOP-17）；工作区余项（W6，LOOP-24 第 1、4、5 项）；门禁工程（W7，LOOP-26、LOOP-13、LOOP-27）；数据的存放位置与旧位置的升级（W10，A-118）；按用户安装的安装包（W11，A-119）；阶段开始的整理；依赖盘点 |
| 代码基线 | `main @ e05fda3`（[PR #7](https://github.com/chialecode/manga/pull/7) 于 2026-11-03 squash 合并）；没有未合并的前置分支 |
| 工作分支 | `feat/m6-deps-agent-loop`，A 已从基线创建。本计划所在的提交是阶段提交的起点；B 的实施、A 的审查修复与人工反馈修复全部 amend 进同一提交 |
| 关联需求 | MODEL-05、AGENT-06、AGENT-07、CTX-02、DATA-01、DATA-04、DATA-06（新增）、NFR-01、NFR-03、NFR-05、UI-09；受影响的既有行为：CTX-03（防剧透范围）、CTX-04（帧与文字的提取）、AGENT-05（两个运行时可替换）、DATA-02（备份、重定位、存储用量）、UI-04（首次启动的路径） |
| 关联验收 | 新增 AT-141—AT-150；AT-51（位置配置与通道隔离）按新的默认位置改写并重跑。Electron 主版本升级要求全部打包烟测、窗口观察与基准重跑；必须重跑的用例：AT-10、AT-11、AT-12、AT-13、AT-17、AT-34、AT-35、AT-44、AT-49、AT-85、AT-95、AT-97、AT-112、AT-116、AT-117、AT-118、AT-127、AT-129 |
| 可连续执行 | 本地实现；第 3 节列出的依赖试用与安装；合成样本、测试、打包、基准、文档同步；第 5.1 节的整理；阶段提交与 amend。不逐工作包询问 |
| 外部操作 | 未授权：push、PR、合并、发布。不需要真实模型、弹弹play 或 Bangumi 的调用：PDF 与视频输入只对本地的假模型服务验证；真实模型的试验是可选的 [ACT-14](../../USER-ACTIONS.md#act-14)，用户授权前不做。数据库 schema 升到 v13（4.4），按数据与安全规则做迁移：迁移前备份、失败回滚、中断后可继续、较旧版本拒绝打开，并有测试。旧位置的升级（4.9）只在隔离的临时目录与合成 Profile 上测；开发者本机的真实 Profile 不由 Agent 搬动，升级后的重放归 ACT-11。安装包（4.10）不签名、不发布；在开发机上真的安装与卸载只装到临时目录，并在结束时卸载、清掉它写下的开始菜单项与注册表项 |

**退出条件与覆盖**

| 条件 | 做法 | 工作包 | 验收证据 |
| --- | --- | --- | --- |
| Electron 45 | 升到满 14 天的最新 45.x；凭据改用异步的 `safeStorage`，旧版加密的凭据照常读出、需要时重新加密；全部打包烟测与基准通过 | W1 | AT-141；`stage package`、`bench` |
| pi-ai 1.x | 升到满 14 天的最新 1.x；工具的参数是普通 JSON Schema，不依赖它转出的 TypeBox；两个运行时的契约用例照旧通过 | W2 | AT-142 |
| 长对话不卡、翻出的页不丢 | 消息列表虚拟化，贴底、跳到来源照旧；整页刷新时保留已翻出的页，期间删掉的消息消失 | W3 | AT-143；新基准 |
| 图像材料可控地增长 | 任务的图像按内容哈希存一份，快照里只放引用；已结束运行的图像到保留期删除，只留来源与尺寸；重试发送同一画面，过期后按来源重新取、来源变了就说明原因；v12 → v13 迁移把旧快照里的图像移出 | W4 | AT-144 |
| PDF 原文件输入 | 模型档案有 PDF 输入、材料是用户放进来的整份 PDF、防剧透范围不截断、大小在上限内时，以文件输入发送原文件；否则照旧发送抽出的文字，并在调用记录里写明原因 | W5 | AT-145 |
| 视频片段输入 | 模型档案有视频输入、协议支持时，把材料对应的一段视频（不越过已看到的位置）无转码截出，以视频输入发送；超出大小或时长上限、协议或运行时不支持时照旧发送帧图，写明原因 | W5 | AT-146 |
| 工作区余项 | 关闭上下文的最后一个标签后重新加载仍是空的（窗口里走过）；同一视图里资源库标签至多一个；四宫格基准用项目的文稿页 | W6 | AT-147 |
| 数据放在该放的地方 | 新装时数据库、配置、凭据密文、启动指针、缓存、日志、运行时与自动备份在 `%LOCALAPPDATA%\manga`（开发版 `manga-dev`）；用户创建的文件在“文档”里的 `MANGA`（开发版 `MANGA-dev`）；下载在“下载”里的 `MANGA`；`%APPDATA%` 与用户主目录下没有 MANGA 的文件；“文档”被重定向时用系统登记的位置 | W10 | AT-148 |
| 旧位置平滑升级 | 旧版本放在“文档”里的 Profile：应用数据复制到新位置、校验后切换，旧位置留下重定位标记、不删除；用户创建的文件不搬动、照常打开；中断或失败时旧位置照常可用，下次启动再试 | W10 | AT-149 |
| 按用户安装 | 不需要管理员权限的安装包，默认装到 `%LOCALAPPDATA%\Programs\manga`（开发版 `manga-dev`），可以改；正式版与开发版可以同时装；卸载只删程序，数据与用户文件保留 | W11 | AT-150 |
| 门禁更可信 | 阶段入口结束时清理打包烟测与基准的临时目录（失败时保留）；评估让基准不受节能降速影响并写结论；三个偶发失败的观察改为按页面内的时间判断，不放宽门槛 | W7 | 临时目录计数；LOOP-13 的评估记录；连续三次 `stage package` |
| 阶段开始的整理 | 上一阶段的报告提炼后删除；去掉以前阶段的标签；按内容整理文件 | C0 | 文档检查；报告的整理记录 |
| 依赖盘点 | 按 A-35 与 ADR-0007 的复查条件逐项处理 | D1 | ADR-0007 版本表；完整回归 |

**阶段完成的判定。** 以下依次满足后，Agent 侧完成，可以请求用户授权 push、PR 与合并（A-24、A-53）：（1）B 自检的必需用例与门禁全部通过；（2）A 集中审查收敛。人工检查与待答复问题记在用户待办，不是合并的前提；`productAcceptance` 保持 not-run。

**阶段完成后，用户可以：**

- 照常使用：窗口、阅读器、播放器、弹幕、插件与下载都在新的 Electron 上工作，已经保存的模型密钥、弹弹play 与 Bangumi 的凭据不用重新填；
- 在一段几千条消息的对话里顺畅地滚动与输入，翻出的更早消息不会因为一条新回复就折回去；
- 让 Agent 反复重试一个看漫画、看视频的任务，资料库不会因为一次次冻结的图像越来越大；
- 给支持 PDF 的模型一份 PDF，它读到的是原文件（含版面与插图），不只是抽出的文字；向支持视频的模型问一段剧情，它看到的是那一段视频，而不是几张截图；
- 在“文档”里的 `MANGA` 文件夹只看到自己的截图、录音、笔记与导出，数据库、缓存与日志在 `AppData\Local\manga`；升级时这些自动搬过去，自己的文件原地不动；
- 用一个不需要管理员权限的安装包把 MANGA 装到 `AppData\Local\Programs\manga`，开发版装在旁边的 `manga-dev`，两者互不干扰；卸载时数据还在。

## 2. A 已核对的现场

- **Electron 与凭据。** 现用 `electron` 44.9.3。`packages/app-core/src/credentials.ts` 的 `CredentialVault` 是同步接口（`available()`、`encrypt()`、`decrypt()`），`ElectronSafeStorageVault` 直接调 `safeStorage.isEncryptionAvailable` / `encryptString` / `decryptString`；`apps/desktop/src/main/index.ts` 第 83 行把它交给应用，第 241 行在 `manga:state` 里报告 `vaultAvailable`。`app.vault` 的调用有 12 处：解密 6 处（`commands/agent-run.ts` 2、`commands/connections.ts` 2、`commands/media.ts` 2），加密与可用检查各 3 处（`connections.ts` 1、`media.ts` 2：弹弹play 与 Bangumi）。测试用的 `tv1` 实现在同一文件。预加载脚本（`apps/desktop/src/preload/preload.ts`）是沙箱化的（`index.ts` 第 159 行、`overlay.ts` 第 69 行），没有用到 `Buffer`、`setImmediate` 或 `events` / `timers` / `url` 模块。原生模块 `better-sqlite3` 按 Electron 的 ABI 重建（`pnpm-workspace.yaml` 的 `@electron/rebuild` 固定为 4.2.0）。
- **pi-ai。** 现用 `@earendil-works/pi-ai` 0.85.1，只在 `packages/model-protocol/src/pi-ai.ts` 里用：`createModels`、`createProvider`、`Type`、`Context`、`Model`、`Tool`，以及按需加载的 `openAICompletionsApi` / `openAIResponsesApi`；工具参数用 `Type.Unsafe` 包一层 JSON Schema（第 69 行）。pi-ai 没有文件（PDF）与视频的消息内容类型。
- **对话的列表。** `apps/desktop/src/renderer/components/chat/messages.tsx` 用 `use-stick-to-bottom` 1.1.6 的 `StickToBottom` 贴底，所有消息都渲染；`hooks/use-session-stream.ts` 每页 200 条（`PAGE`），任务运行中每 600 ms、主机通知后 250 ms 调 `load()` 重新取**最新一页**并整体替换，所以 `loadOlder` 翻出的更早消息在下一次刷新时消失（LOOP-07 第 2 点的原因）。上一阶段的验证基线记录：载入 1000 条消息后输入到提交并布局 p95 28.3 ms（记录项）。`@tanstack/react-virtual` 3.14.21 已在依赖里（虚拟网格在用）。
- **任务的图像材料。** `packages/app-core/src/agent-materials.ts` 的 `FrozenMedia.images`（`FrozenImage` 带 `base64`）写进 `agent_runs.snapshot_json`，每任务 ≤ 4 MB；`commands/agent-run.ts` 重试与恢复时从快照读出原样发送；`publicMedia` 给界面时去掉 `base64`。表结构在 `packages/storage-drizzle/src/sql.ts`，`PRODUCT_SCHEMA_VERSION = 12`；迁移、备份与回滚走 `store.ts` 的现有流程。
- **模型档案与发送。** `packages/contracts/src/inputs-models.ts` 的 `MODEL_INPUT_TYPES` 是文本、图片、视频、PDF、音频，默认只有文本；协议只有 `openai-responses` 与 `openai-chat-completions`（`contracts/src/inputs.ts` 第 201 行）。本地运行时的请求在 `packages/model-protocol/src/openai-http.ts`：图片在 Responses 里是 `input_image`（第 71 行）、在 Chat Completions 里是 `image_url`（第 106 行），没有文件或视频的部分。假模型服务是同目录的 `mock-server.ts`。视频片段可以用随包的 FFmpeg 8.1 LGPL 构建截取（`packages/app-core/src/media/ffmpeg.ts`；粗剪的无转码切割已经在用）；它没有 x264，转码只能用 libvpx、SVT-AV1 或硬件编码。
- **工作区余项**（[LOOP-24](status.md#loop-24)）：第 1 项只有控制器用例；第 4 项从书架打开阅读器时，没有可导航的资源库标签就新开一个；第 5 项四宫格基准的“文稿”是一篇笔记标签。
- **门禁。** 上一阶段末系统临时目录里留下的 `manga-*` 目录，2026-11-03 规划时数到 126 个（打包烟测的资源库位置 48、各基准 33、隔离 Profile 与窗口走查 6、插件 9、测试 8 等），都来自那次门禁与补充测量（[LOOP-26](status.md#loop-26)）。上一阶段 `frame-window-controls` 的悬停取色在前台被别的窗口抢走时失败过；`hold-rate-hint-only` 与 `hold-rate-recovers` 在机器忙时失败过一次，它们的等待只比按住时长多 150 ms，用的是脚本这边的时钟（[LOOP-27](status.md#loop-27)）。基准的节能降速见 [LOOP-13](status.md#loop-13)。
- **数据的存放位置（2026-11-04 核对）。** `packages/app-core/src/locations.ts`：默认根是 `<文档>/MANGA/<通道>`（通道是 `release`、`development`、`test`），11 个分区（`packages/contracts/src/paths.ts` 的 `LOCATION_PARTITIONS`：`data`、`resources`、`works`、`projects`、`attachments`、`downloads`、`cache`、`logs`、`backups`、`exports`、`runtime`）都在它下面；启动指针在 `<文档>/MANGA/<通道>/launcher/pointer.json`，可以记录根与分区的覆盖；已有重定位的做法（`RELOCATED.json` 标记、数据库里的 `relocatedRoot`、`authoritativeRoot` 跟随）。“文档”由 `resolveDocumentsDir` 取 `os.homedir()` 下的 `Documents`，**不是系统登记的“文档”位置**，“文档”被重定向（例如到 OneDrive 或别的盘）时会取错。`apps/desktop/src/main/index.ts` 第 55、56 行把 Electron 的 `userData` 与 `sessionData` 设为 `runtime` 分区，所以 `%APPDATA%` 里没有 MANGA 的文件。开发机上正式版 Profile 的聚合：`data` 488 MB（封面原图在数据库里，A-51）、`runtime` 13 MB、`cache` 1.1 MB，其余分区为空。
- **安装。** `apps/desktop/forge.config.ts` 只有打包（`electron-forge package`，产物在 `dist/desktop`），没有任何 maker，也就没有安装包；交付路线第 9 节“首发安装形式”与 [Q-09](../../USER-ACTIONS.md#q-09) 仍待定。产品名是 `MANGA`，开发版与正式版只靠运行时的通道区分（打包产物默认是 `release`）。
- **LOOP-08**（Node 24 的 V8 缺陷）：[nodejs/node#66366](https://github.com/nodejs/node/issues/66366) 2026-11-03 仍未关闭，`--no-wasm-code-gc` 的缓解保留，不在本阶段处理。

## 3. 开源查证（2026-11-03）

查询来源：npm registry 的发行时间、GitHub 仓库与发行说明、官方文档。“满 14 天”以实施当天计算，B 实施时重查一次。“维护”只指近期有提交或发行，适用性以 B 的试验为准。本地参考索引里“Agent 功能”一项有长对话列表的做法（用 `@tanstack/react-virtual` 的 `useVirtualizer`，配合 `measureElement` 量行高、`getItemKey` 稳定键、`shouldAdjustScrollPositionOnItemSizeChange` 控制行高变化时是否调整滚动位置、`scrollToIndex` 跳转），本地副本的提交日期是 2026-10-30；其余需要在索引里没有对应参考，按开发流程 2.5 记为“未找到对应参考”。

### 3.1 候选

| 需要 | 候选 | 版本与日期 | 许可证 | 判断 |
| --- | --- | --- | --- | --- |
| 桌面运行时 | Electron | 45.0.0（2026-10-21，Chromium 156、Node 24.22）、45.1.0（10-27）、45.2.1（10-31） | MIT | **升级**：45.0.0 2026-11-04 起满 14 天；B 取实施时满 14 天的最新 45.x。破坏性变更（[45 的发行说明](https://www.electronjs.org/blog/electron-45-0)、[破坏性变更表](https://www.electronjs.org/docs/latest/breaking-changes)）里与本仓库有关的：同步的 `safeStorage` 接口废弃、46 删除；沙箱预加载里不再有 `Buffer`、`setImmediate` 与 `events` / `timers` / `url` 模块（现场没有用到）；ASAR 里的文件描述符只能经 `fs` 使用 |
| 凭据加密 | Electron `safeStorage` 的异步接口 | 随 45 | MIT | **照做**（[官方文档](https://www.electronjs.org/docs/latest/api/safe-storage)，2026-11-03 查阅）：`isAsyncEncryptionAvailable(): Promise<boolean>`、`encryptStringAsync(text): Promise<Buffer>`、`decryptStringAsync(buf): Promise<{ shouldReEncrypt, result }>`；同步接口加密的数据可以用异步接口解密；Windows 上两者都用 DPAPI；异步加密器在应用就绪后第一次调用时初始化 |
| 模型运行时 | @earendil-works/pi-ai | 1.3.0（10-15）、1.4.0（10-21）、1.5.0（11-02） | MIT | **升级**：1.4.0 2026-11-04 起满 14 天，1.5.0 11-16 起满 14 天；B 取实施时满 14 天的最新 1.x。CHANGELOG 里与本仓库有关的破坏性变更：0.86 自定义提供者的输入改为 `TranscriptContext`；0.99 图像模型并入 `Provider` / `Models`；1.0.3 Azure 提供者改名；1.1 流函数必须返回 `AssistantMessageEventStream`；1.4 `telemetryContext` 改为 `telemetry`、删除 `getPiUserAgent()`；1.5 主入口不再转出 TypeBox（`Type`、`Static`、`TSchema`），`Tool.parameters` 是任意 JSON Schema、只按 JSON Schema 校验。所以工具参数直接写 JSON Schema，1.4 与 1.5 都能用 |
| 长列表虚拟化 | @tanstack/react-virtual（已在依赖里） | 3.14.21（10-16）；3.14.22（10-22）起的版本还不满 14 天 | MIT | **采用**：动态行高（`measureElement`）、稳定键、`scrollToIndex`；与贴底的配合由 B 试验定（4.3） |
| 贴底 | use-stick-to-bottom（已在依赖里） | 1.1.6（2026-06-04） | MIT | **先沿用**，与虚拟列表共用滚动容器；B 试验后若两者争夺滚动位置，改用虚拟列表的 `scrollToIndex` 自己贴底并删掉这个依赖，理由写进 ADR-0007 |
| 同上（备选） | react-virtuoso | 实施时查 | MIT | 不默认：它自带贴底与向上加载，但要把现有的列表与贴底整体换掉；B 只在上面两条路线都不行时评估 |
| PDF 文件输入 | OpenAI Responses 的 `input_file` / Chat Completions 的 `file` 部分 | 官方文档，2026-11-03 查阅 | — | **照做**：`{ type: "input_file", filename, file_data: "data:application/pdf;base64,…" }`（Responses）与 `{ type: "file", file: { filename, file_data } }`（Chat Completions），单次请求的文件合计 ≤ 50 MB |
| 视频输入 | Chat Completions 的 `video_url` 部分（兼容服务的扩展） | 各服务文档，2026-11-03 查阅 | — | **照做**：`{ type: "video_url", video_url: { url: "data:video/mp4;base64,…" } }`；有的服务限制 base64 后不足 7 MB，常见接受 MP4、MOV、WebM。OpenAI 自己的两个接口不收视频，Responses 协议一律发帧图 |
| 截取视频片段 | 随包的 FFmpeg 8.1 LGPL（已在用） | — | LGPL | **复用**：按关键帧无转码截取（与粗剪同样的做法），不新增依赖；LGPL 构建没有 H.264 编码器，所以不转码，超过上限时退回帧图 |
| 修改 PDF（按页截取） | pdf-lib | 1.17.1（2021-11） | MIT | 不采用：四年没有发行。本阶段不截取 PDF：防剧透范围或材料只覆盖一部分页时，照旧发送抽出的文字（4.5） |
| 内容寻址存放 | Node 的 `crypto`（SHA-256）与现有的 SQLite | — | — | **自写**：一张按哈希为键的表与一张引用表（4.4），不引入对象存储库；理由写进 ADR-0007 |
| 基准不受节能降速 | Windows `SetProcessInformation(ProcessPowerThrottling)` | 官方文档，2026-11-03 查阅 | — | **评估**（4.7）：对基准的 Electron 进程关闭执行速度节流（`PROCESS_POWER_THROTTLING_EXECUTION_SPEED`）。先用 PowerShell 的 `Add-Type` 调用（系统自带，不加依赖）；不行再试 koffi |
| 同上（备选） | koffi | 3.3.3（10-10）满 14 天，3.3.6（10-31） | MIT | 备选，只作开发依赖，只给基准脚本用 |
| 同上（备选） | Chromium 开关 `--disable-features=UseEcoQoSForBackgroundProcess` | 随 Chromium 156 | BSD | 先试：可能已经没有这个特性名，试了无效就记录并去掉 |
| 数据目录的规范 | Windows 已知文件夹（[KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)、[CSIDL](https://learn.microsoft.com/en-us/windows/win32/shell/csidl)） | 官方文档，2026-11-04 查阅 | — | **照做**：`FOLDERID_LocalAppData`（`%LOCALAPPDATA%`）是“本机（不漫游）应用的数据”；`FOLDERID_RoamingAppData`（`%APPDATA%`）是漫游的应用数据；`FOLDERID_UserProgramFiles` 的默认位置就是 `%LOCALAPPDATA%\Programs`（按用户安装的程序）；对用户主目录（`FOLDERID_Profile`）明确写着“应用不应在这一层建文件或文件夹，数据应放在 `CSIDL_APPDATA` 或 `CSIDL_LOCAL_APPDATA` 下”。所以不用 `~\.manga` |
| 同上 | Electron `app.getPath` 的说明（[文档](https://www.electronjs.org/docs/latest/api/app)） | 2026-11-04 查阅 | MIT | **照做**：`userData` 默认在 `%APPDATA%\<名称>`，“不建议在这里写大文件，因为有些环境会把这个目录备份到云端”；`sessionData` 默认同 `userData`，Chromium 可能在里面写很大的磁盘缓存，建议放到别处。MANGA 的数据库已经有几百 MB、还会随封面与任务图像增长，并记着本机的绝对路径（资源库位置），漫游到另一台机器也没有意义，所以整个应用数据放 `%LOCALAPPDATA%`，不用 `%APPDATA%` |
| 同上（对照） | Visual Studio Code 的 Windows 说明（[setup/windows](https://code.visualstudio.com/docs/setup/windows)） | 2026-11-04 查阅 | MIT | 参照它的分法：按用户安装在 `%LOCALAPPDATA%\Programs\Microsoft VS Code`，用户设置在 `%APPDATA%\Code\User`，预览版用另一套名字（`Code - Insiders`）与正式版并存。MANGA 的设置在数据库里、与数据库一起放本机位置；开发版同样用另一套名字（`manga-dev`）并存 |
| 安装包 | electron-builder 的 NSIS 目标 | 26.18.0（2026-10-20，满 14 天）、26.18.1（10-26） | MIT | **采用**（只作开发依赖）：按用户安装（`perMachine: false`）时默认目录是 `$LocalAppData\Programs\<应用文件名>`（模板 `templates/nsis/multiUser.nsh`，2026-11-04 查阅），不要管理员权限；`oneClick: false` 与 `allowToChangeInstallationDirectory: true` 可以让用户改目录。继续用 Forge 打包，再用 electron-builder 的 `--prepackaged` 只把打好的目录做成安装包，不换打包工具 |
| 同上（备选） | @electron-forge/maker-squirrel | 8.0.1（2026-09-29） | MIT | 不采用：Squirrel.Windows 固定装到 `%LocalAppData%\<应用名>`（[安装过程说明](https://github.com/Squirrel/Squirrel.Windows/blob/develop/docs/using/install-process.md)），不能装到 `Programs`，也不能让用户选目录 |
| 同上（备选） | @electron-forge/maker-wix（MSI） | 8.0.1 | MIT | 不默认：要另装 WiX 工具集；B 只在 NSIS 不行时评估 |
| 同上（备选） | @electron-forge/maker-msix | 8.0.1 | MIT | 不采用：MSIX 应用装在 `WindowsApps`，`AppData` 被虚拟化，与本节的目录规范冲突 |

### 3.2 依赖盘点（A-35，D1）

2026-11-03 的 `pnpm outdated -r`，按“满 14 天的最新版本”：

| 依赖 | 现用 | 最新 | 满 14 天的最新（2026-11-03） | 处理 |
| --- | --- | --- | --- | --- |
| electron | 44.9.3 | 45.2.1 | 无（45.0.0 11-04 起） | W1 |
| @earendil-works/pi-ai | 0.85.1 | 1.5.0 | 1.3.0（1.4.0 11-04 起） | W2 |
| dockview-react | 8.6.1 | 8.8.3 | 8.6.1（8.6.2 11-08 起） | 实施末重查；升级后复查标签上的 Delete / Backspace 是否仍要自己拦（LOOP-24 第 3 项的做法） |
| knip | 6.41.0 | 6.44.1 | 6.42.1 | 升级 |
| electron-builder（新增，开发依赖） | — | 26.18.1 | 26.18.0 | W11，只用它的 NSIS 目标 |
| @tanstack/react-virtual | 3.14.21 | 3.14.25 | 3.14.21（3.14.22 11-05 起） | 实施末重查 |
| tiptap、@xyflow/react、mdast-util-to-markdown、@vitejs/plugin-react、onnxruntime-web、pdfjs-dist、linkedom | — | 有补丁或小版本 | 多数还是现用版本 | 实施末重查，满 14 天的补丁与小版本照常升级 |
| lucide-react、@napi-rs/canvas | 1.61.0、1.0.13 | 1.67.0、1.1.0 | 现用版本 11-04 起满 14 天 | 不回退；实施末重查 |
| @types/node | 24.5.2 | 26.x | — | 留在 24.x：与 Electron 45 的 Node 24 和 CI 的 `.node-version`（24.19.0）一致；可以升到满 14 天的最新 24.x |

主版本或行为变化的升级（Electron、pi-ai、dockview 的小版本跨度）先单独做并跑对应的回归，失败时回退到原版本，在 ADR-0007 的例外表写明尝试的版本、失败的命令、上游限制与复查条件。最小发行龄策略不绕过，不接受自动写入的豁免。

## 4. 设计

### 4.1 Electron 45 与异步凭据（W1）

- **凭据接口改为异步。** `CredentialVault` 改为 `available(): Promise<boolean>`、`encrypt(plain): Promise<Buffer>`、`decrypt(cipher): Promise<{ plain: string; renewed?: Buffer }>`。`ElectronSafeStorageVault` 用 `isAsyncEncryptionAvailable`、`encryptStringAsync`、`decryptStringAsync`；`shouldReEncrypt` 为真时再加密一次，把新的密文作为 `renewed` 交回。app-core 里新增一个读取凭据的函数（例如 `readCredential(app, ref)`），解密的 6 处调用都经它：解密、在 `renewed` 存在时写回 `credentials` 表，写回失败不影响这次使用。测试用的 `tv1` 实现同样改为异步，旧密文照常解得开。
- **调用方。** 命令本来就是异步的，只是在调用处加 `await`；不要在模块初始化时同步读凭据。`manga:state` 的 `vaultAvailable` 改为等 `isAsyncEncryptionAvailable()`。应用在 `ready` 之后才创建（B 核对），异步加密器在第一次调用时初始化，第一次的耗时记进报告。
- **兼容。** 用 Electron 44 的同步接口加密的凭据，在 45 上用异步接口解密（官方文档写明可以）；单元用例用 `tv1` 覆盖“旧密文 → 解得开 → 需要时写回新密文”，打包窗口观察 `credentials-async` 用真实的 `safeStorage` 覆盖：在一份由 44 的打包产物保存过凭据的隔离 Profile 上启动 45 的产物（B 用上一阶段留在 `dist/desktop` 的产物生成这份 Profile，或用 git worktree 在 `e05fda3` 上另打一个包）。
- **其余。** 不再用的同步接口一处不留（加一条检查：源码里没有 `isEncryptionAvailable(`、`encryptString(`、`decryptString(` 的调用）；`better-sqlite3` 等原生模块按 45 的 ABI 重建；ASAR 里用文件描述符的地方（如果有）改为经 `fs`；全部打包烟测、窗口观察与基准重跑。升级失败时回退到 44.9.3，写进 ADR-0007 的例外表（复查条件：46 发行前必须完成，因为 46 删除同步接口）；异步凭据的改动保留：44 有这组接口就照用（B 先核对），没有时由同一个异步接口包住同步调用。

### 4.2 pi-ai 1.x（W2）

- 工具参数直接写 JSON Schema，去掉 `Type.Unsafe`，不从 pi-ai 导入 TypeBox；1.4 与 1.5 都能用。
- 按 3.1 列出的破坏性变更逐条核对 `pi-ai.ts`：`createModels` / `createProvider` 的形状、按需加载的两个 API 实现、`Context` 与消息里图片的写法、工具调用的 `arguments` 必须是 JSON 兼容的值、流式事件与中止、遥测参数（若用到）。用法改动只在 `pi-ai.ts` 里，`model-protocol` 对外的接口不变。
- pi 运行时没有文件与视频的内容类型：W5 的原生 PDF 与视频输入只在本地运行时生效，pi 运行时按“不支持”退回文字与帧图，并在调用记录里写明（4.5）。两个运行时用同一套预算与压缩（MODEL-05），用同一组契约用例对假模型服务验证：文本、工具调用、图片、流式、中止、压缩。

### 4.3 长对话的列表（W3，LOOP-07）

- **虚拟化。** 消息列表用 `@tanstack/react-virtual` 的 `useVirtualizer`：行高动态测量（`measureElement`），键是消息的编号（`getItemKey`），上下各多渲染几条（overscan）。正在生成的回答、正在转写的录音所在的行随内容长高；行高变化时只有用户停在底部才保持贴底，用户向上翻看时不跳（`shouldAdjustScrollPositionOnItemSizeChange` 按是否在底部决定）。
- **贴底。** 先保留 `use-stick-to-bottom`，让虚拟列表用它的滚动容器（`scrollRef`）。B 用单元用例与打包窗口试验：新消息到达、回答流式变长、窗口改变高度三种情况下是否仍贴底，向上翻时是否不被拉回。两者争夺滚动位置时改用虚拟列表的 `scrollToIndex(last, { align: "end" })` 自己贴底，删掉 `use-stick-to-bottom`。
- **跳转。** 笔记与引用“跳到这条消息”改为先按编号找到下标、`scrollToIndex` 后再高亮；目标不在已载入的页里时先向上载入到它所在的页。
- **保留已翻出的页。** `session.stream` 增加一个参数（例如 `from`：从这条消息起到最新）。刷新时，只载入了一页就照旧取最新一页；翻出过更早的页就从已载入的最早一条起取到最新（上限 5000 条，超过时从最新起保留 5000 条并恢复“更早的消息”）。期间被删除的消息因为不在结果里自然消失；滚动位置以视口顶端那条消息为锚，刷新后不动。
- **“更早的消息”。** 保留按钮，同时在滚到顶部附近时自动载入下一页（加载中不重复请求）；载入后视口顶端那条消息的位置不变。

### 4.4 任务图像的内容寻址与保留（W4，LOOP-05，schema v13）

- **表。** v13 新增两张表：`agent_media`（`hash` 为 SHA-256 主键、`mime`、`width`、`height`、`size`、`bytes` BLOB、`created_at`）与 `agent_run_media`（`run_id`、`hash`、在快照里的序号；三者为主键，`run_id` 随运行删除而删除）。快照里的 `FrozenImage` 不再带 `base64`，改为 `{ hash, mime, width, height, source }`，`source` 是原来就有的来源（资源、修订、页或时间、区域）。读取快照的代码同时接受旧的内联写法（以防万一），新写入只用引用。
- **写入。** 冻结时按哈希写入 `agent_media`（已存在就只加引用），同一张图在多次运行与重试之间只存一份；每任务 ≤ 4 MB 的上限照旧。
- **保留期。** 默认 30 天（Q-36），可以在“设置 › 智能体”改，范围 1—365 天或“一直保留”。运行结束（成功、失败或取消）满保留期后：删除它的 `agent_run_media` 行，在快照里给这张图加上 `expired: true`（来源与尺寸保留），没有任何引用的 `agent_media` 行随之删除。清理在启动后空闲时与之后每天一次进行，分批、每批一个短事务，不阻塞界面；运行中与未结束的运行不清理。
- **重试与恢复。** 引用还在时发送同一份字节（按哈希取出，哈希一致）。过期后重试：按 `source` 重新提取；来源的修订没变就发送新提取的图像，调用记录写明“图像已过保留期，按来源重新提取”；修订变了或文件不在了，任务以明确的错误停下，说明原因与做法（重新发起任务），不发送不同的画面（CTX-02）。
- **迁移 v12 → v13。** 在现有迁移流程里（迁移前备份、事务、失败回滚、中断后可继续、较旧版本拒绝打开 v13）：建表；分批读出 `agent_runs.snapshot_json` 里的内联图像，写入 `agent_media`（去重）与 `agent_run_media`，把快照改写成引用；迁移时不按保留期删除（第一次清理在迁移后按新规则进行）。迁移前后各算一次所有图像的哈希集合，必须相等；合成规模样本上的耗时与数据库体积写进报告。
- **备份与资料包。** `agent_media` 随运行记录进完整备份；资料包仍不导出运行记录（不变）；调用追踪仍不进备份（AGENT-07，不变）。
- **界面。** 运行详情里过期的图像显示为占位与“已过保留期”，悬停显示来源与尺寸；`publicMedia` 的形状不变，多一个 `expired`。

### 4.5 原生 PDF 与视频输入（W5，LOOP-17）

只在本地运行时生效（pi 运行时没有对应的内容类型，见 4.2）。下表四个条件都满足才发送原文件或视频片段；任何一个不满足就照旧发送文字或帧图，并在调用记录里写明原因：

| 条件 | PDF | 视频 |
| --- | --- | --- |
| 模型档案的输入类型 | 含“PDF” | 含“视频” |
| 协议 | Responses（`input_file`）与 Chat Completions（`file`）都可以 | 只有 Chat Completions（`video_url`）；Responses 发帧图 |
| 材料与防剧透 | 用户为这次任务放进来的整份 PDF（附件或所选材料），不是工具在授权范围里读到的资源；防剧透开启且范围没有覆盖全书时发送文字；只覆盖一部分页的材料（例如“第 10—20 页”）发送文字（本阶段不截取 PDF） | 材料对应的那一段：有区间就是区间；只有一个位置就是这个位置之前的 10 s（Q-36）；**终点不越过当前位置与防剧透范围** |
| 大小与时长 | 文件 ≤ 模型档案的“文件上限”（默认 20 MiB） | 片段 ≤ “视频上限”（默认 5 MiB，base64 后约 6.7 MB）且 ≤ “视频时长上限”（默认 60 s） |

- **模型档案。** `ModelProfile` 增加 `limits`：`fileBytes`、`videoBytes`、`videoSeconds`，带默认值，模型弹窗里在勾了 PDF 或视频时显示；旧档案读取时补默认值（契约里的可选字段，不改表）。测试连接探测不到这两种输入，由用户勾选（与现在一样）。
- **视频片段。** 用随包的 FFmpeg 按关键帧无转码截取（起点向前对齐到关键帧，所以片段可能从更早一点开始，不会越过终点），保留视频与第一条音轨、去掉字幕与数据流，封装为 MP4（源是 MKV 时重封装）；截取结果超过上限、源的编码不能放进 MP4、或截取失败时退回帧图。截取在任务开始时做一次，片段的字节按 4.4 的方式冻结（同一张表，`mime` 是 `video/mp4`，同一个保留期），重试发送同一个片段。
- **PDF 的冻结。** 不复制 PDF 的字节：快照里记资源、修订与文件哈希；重试时读文件并核对哈希，不一致就按 4.4 的规则停下并说明。
- **预算。** 文件与片段的 Token 无法事先精确计算：PDF 按页数乘一个保守的每页估计、视频按时长计入预算，超出可用预算时退回文字或帧图并写明原因（MODEL-05 的预算规则不变）。
- **调用记录。** 记录发送的类型（文件 / 视频片段 / 文字 / 帧图）、大小、页数或时长与退回的原因，不记录内容（AGENT-07 的脱敏不变）。
- **假模型服务。** `mock-server.ts` 接受并记录这两种部分，烟测与契约用例据此断言请求的形状。

### 4.6 工作区余项（W6，LOOP-24 第 1、4、5 项）

- **第 1 项。** 打包窗口观察：关闭一个上下文的最后一个标签，重新加载页面（`webContents.reload()`），主区仍是空的、没有补上初始标签；切到别的上下文再回来也是空的。
- **第 4 项。** 同一上下文的同一视图里资源库标签至多一个：从书架、侧栏的管理入口、搜索框打开资源库页时，已有资源库标签就在它里面导航并切过去，没有才新开。阅读器从书架打开后，资源库标签留在原处，不新开第二个。
- **第 5 项。** 四宫格基准里的“文稿”改为打开项目的文稿页（同一个编辑器，但走文稿页的加载与保存）；门槛不变。

### 4.7 门禁工程（W7）

- **LOOP-26。** `stage package` 与 `stage bench` 结束时，通过的运行删除自己创建的 `manga-package-*`、`manga-package-window-walk-*`、`manga-smoke-library-*`、`manga-bench-*` 与插件临时目录；失败时保留并在日志里写出保留的目录。阶段入口像 `stage test` 一样在前后数一次这些前缀，通过的运行多出来的算失败。开发机上已有的遗留目录按前缀确认来自本仓库、确认没有 MANGA、Electron 或测试进程在运行后删除，报告只写数量。
- **LOOP-13。** 评估三种办法，结论写进执行状态的 LOOP-13 与验证基线：（1）Chromium 开关；（2）基准脚本启动 Electron 后，对它的所有进程调用 `SetProcessInformation` 关闭执行速度节流（PowerShell `Add-Type`，不行再试 koffi）；（3）什么都不做。方法：同一份源码、同一时段，启动它的应用分别在前台与后台，各跑 3 次完整基准，比较导图折叠与 EPUB 末尾两项的 p95。有效的办法接进 `stage bench`（只影响基准进程）；无效的去掉。**门槛与测量方法不改**；跑基准前仍按现有口径确认机器空闲、启动它的应用在前台。
- **LOOP-27。** `hold-rate-hint-only` 与 `hold-rate-recovers` 改为在页面里记录按下与进入临时倍速的时间（`performance.now()`），按页面内的时间差判断“在按住时长内进入”；脚本这边的等待可以更长，只用于等结果出现，判断的条件不变。`frame-window-controls` 的悬停取色先确认窗口在前台、指针确实在按钮上（命中测试），再取色；前台被抢走时重新聚焦后重做一次，并把重做记进观察的结果。三条观察的目标与门槛不变，B 在报告里写明前后的判断方式。Vitest 用例 `tests/shell/search-box-ui.test.tsx` 的“从最后一行绕回第一行”一条在整套用例的负载下偶发找不到 `search-box`（A 2026-11-04 规划时遇到一次，单独连跑 5 次都通过）：改为先等搜索框出现再操作，只改测试，用人为放慢的渲染复现后修复，做法同上一阶段修弹幕界面用例。连续三次完整的 `stage package` 通过作为证据。

### 4.8 命令与契约

- `session.stream` 增加 `from`（4.3）；返回的形状不变。
- 模型档案的 `limits`（4.5），设置的“图像保留天数”（4.4）。
- 运行快照的图像改为引用，`agent_media` 与 `agent_run_media` 两张表（4.4）；`publicMedia` 多一个 `expired`。
- 调用记录多出发送类型、大小与退回原因的字段（4.5）。
- `CredentialVault` 异步（4.1），是 app-core 内部接口，不对插件或 Agent 开放。
- `LocationLayout` 多出两个根（应用数据根与用户文件根，4.9），`documentsRoot` 改为系统登记的“文档”；启动指针的默认位置改变（4.9）。设置里位置一页的返回形状跟着变，命令名不变。
- 不新增 Agent 可以调用的命令；命令注册快照只在 `session.stream` 的参数上变化，B 更新快照并在报告里写明。

### 4.9 数据的存放位置（W10，A-118）

**原则。** 用户自己创建、会去文件管理器里找的东西放“文档”；应用自己管理的东西（数据库、配置、凭据密文、缓存、日志、浏览器运行时、自动备份）放 `%LOCALAPPDATA%`；不用 `%APPDATA%`（漫游，3.1）、不在用户主目录下建 `.manga`（3.1）。

| 内容 | 分区 | 正式版（`release`） | 开发版（`development`） |
| --- | --- | --- | --- |
| 程序 | — | `%LOCALAPPDATA%\Programs\manga`（4.10） | `%LOCALAPPDATA%\Programs\manga-dev` |
| 数据库与配置（含凭据密文） | `data` | `%LOCALAPPDATA%\manga\data` | `%LOCALAPPDATA%\manga-dev\data` |
| 启动指针 | — | `%LOCALAPPDATA%\manga\launcher\pointer.json` | `%LOCALAPPDATA%\manga-dev\launcher\pointer.json` |
| 缓存、日志、浏览器运行时（Electron 的 `userData`、`sessionData`，崩溃转储） | `cache`、`logs`、`runtime` | `%LOCALAPPDATA%\manga\…` | `%LOCALAPPDATA%\manga-dev\…` |
| 自动备份（迁移前与定期） | `backups` | `%LOCALAPPDATA%\manga\backups` | `%LOCALAPPDATA%\manga-dev\backups` |
| 作品内容文件夹（截图、录音、笔记文件、粗剪、导出）、项目、附件、粘贴的文本与恢复的媒体、导出 | `works`、`projects`、`attachments`、`resources`、`exports` | `<文档>\MANGA\…` | `<文档>\MANGA-dev\…` |
| 下载 | `downloads` | `<下载>\MANGA` | `<下载>\MANGA-dev` |

- **测试通道不变：** 必须给隔离的根（现有规则）。
- **系统登记的位置。** “文档”与“下载”用系统登记的位置（主进程在 Electron 初始化前取 `app.getPath("documents")` / `app.getPath("downloads")`，交给 `resolveLaunchLayout`），`%LOCALAPPDATA%` 取环境变量 `LOCALAPPDATA`，缺失时退回 `<主目录>\AppData\Local`。取不到或不可写时照现有规则提示选目录或重试，不猜别的位置。崩溃转储用 `app.setPath("crashDumps", …)` 放进 `logs`。
- **覆盖照旧。** 环境变量 `MANGA_PROFILE_ROOT`、`MANGA_POINTER_FILE`、`MANGA_DIR_<分区>` 与设置里的分区覆盖都照旧可用；用户自己改过的分区不动。文件夹名的大小写只是显示，Windows 不区分。
- **从旧位置升级。** 启动时新位置没有指针、而旧的默认位置（`<文档>\MANGA\<通道>`，或旧的默认指针 `<文档>\MANGA\<通道>\launcher\pointer.json` 指向的根）有资料库，就在打开数据库之前做一次位置迁移，用现有的重定位做法：
  1. 只搬应用数据的分区：`data`、`backups`、`logs`、`runtime` 复制到新的应用数据根，逐个文件比对指纹，数据库做完整性检查；`cache` 不复制，在新位置重建。
  2. 用户文件的分区（`works`、`projects`、`attachments`、`resources`、`exports`、`downloads`）**不搬**：新指针把它们记成分区覆盖，仍指向旧路径，里面的文件、笔记文件与作品内容文件夹照常使用；设置的位置一页显示它们，并提供“移到新的默认位置”（现有的可恢复迁移）。旧指针里已有的覆盖原样带过去。
  3. 都通过后写新指针，在旧根写 `RELOCATED.json` 标记并在旧数据库里记 `relocatedRoot`（所以旧版本再启动也会跟到新位置），旧的应用数据文件不删除；设置里的存储用量一页给出“清理旧位置”的入口，由用户确认后删除。
  4. 中途失败或被强制结束：不写新指针，旧位置照常可用，界面提示一次，下次启动重试；新位置里半复制的文件在重试前清掉。
  5. 顺序：位置迁移先于 v13 的 schema 迁移，schema 迁移的备份写在新位置的 `backups`。
- **首次启动与设置。** 首次启动引导（UI-04）显示两个根与下载的位置，可以改；设置的位置一页按“应用数据”“你的文件”“下载”三组显示每个分区的实际路径。
- **开发版。** 从仓库运行（开发命令）与打包的开发版都是 `development` 通道，用上表的 `-dev` 位置；打包时把通道写进产物（不靠运行时猜），产品名与应用 ID 也随通道（4.10）。凭据的命名空间照旧按通道分开。

### 4.10 按用户安装的安装包（W11，A-119）

- **形式。** 继续用 Forge 打包；在 `stage package` 之后用 electron-builder 的 NSIS 目标、`--prepackaged` 把打好的目录做成一个安装程序（3.1）。按用户安装（`perMachine: false`），不要管理员权限；`oneClick: false`、`allowToChangeInstallationDirectory: true`，默认目录是 `%LOCALAPPDATA%\Programs\manga`（开发版 `manga-dev`）——electron-builder 的默认目录取应用文件名，B 用它的配置或 `nsis.include` 的初始化宏把目录名定为这两个名字。
- **两个通道并存。** 正式版与开发版的应用 ID、产品名、开始菜单与桌面快捷方式的名字（“MANGA”与“MANGA Dev”）、卸载项都不同，可以同时安装；开发版的图标加一个标记区分（B 用现有图标做）。
- **卸载。** 只删程序目录、快捷方式与卸载项；应用数据（4.9）与用户文件保留（不开 `deleteAppDataOnUninstall`，它删的是 `%APPDATA%`，与 MANGA 无关）。安装与卸载时如果 MANGA 正在运行，提示先关闭。
- **不在本阶段：** 签名（ACT-04、Q-09）、自动更新、按机器安装、便携版。没有签名时 Windows 的 SmartScreen 会提示“未知发布者”，写进人工检查与已知限制。
- **验证。** `stage package` 生成安装程序并检查它的配置（默认目录、按用户、应用 ID、卸载不删数据）；一个单独的脚本（例如 `node scripts/stage.mjs installer`）在开发机上做一次真实的静默安装：装到临时目录（`/S /D=<临时目录>`）、启动一次做最小烟测、确认数据按 4.9 写在对应的位置（启动时把 `LOCALAPPDATA`、`MANGA_DOCUMENTS_DIR` 与新增的 `MANGA_DOWNLOADS_DIR` 指向临时目录里的三个文件夹，不碰本机真实的 Profile）、静默卸载，再确认它写下的开始菜单项、快捷方式与注册表卸载项都已清掉。这个脚本不并进每次的 `stage package`，B 在最终源码上跑一次，报告记录结果。

## 5. 工作包与顺序

### 5.1 C0 阶段开始的整理（先做）

按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)执行，结果写进报告的“整理记录”。A 于 2026-11-03 盘点了 `git ls-files` 与 `git status --short --ignored`（不含 `node_modules`）。

**A 已做（在本计划所在的提交里）：**

- 上一阶段的报告提炼后删除。仍有效的内容（视图布局的路线、隐藏层的办法、knip 的结论、命令注册的拆分、测试临时目录、依赖盘点）上一阶段已经写进 ADR-0007、交互设计、质量门禁与执行状态；还没有正本的“三个窗口观察偶发失败”写成执行状态的 LOOP-27。入链改为归档链接 `https://github.com/chialecode/manga/blob/e05fda3/docs/delivery/stage-report.md#<锚点>`；指向更早计划章节的“计划第 N 节”改为该阶段的归档链接；文档导航与 GitBook 目录里去掉报告（B 新建后加回）。
- 登记表 `currentStage` 改为 `m6`，本计划的 `retireAfter` 改为 `m6`，报告的条目去掉。
- 确认记录里指向上一阶段计划章节的链接改为归档链接；新增 A-117。
- 2026-11-04 用户补充的数据位置与安装位置：A-118、A-119 写进确认记录（A-16 的默认位置随之取代），需求 DATA-04 改写、新增 DATA-06，验收 AT-148—AT-150，AT-51 的预期按新位置改写，数据与安全规则的默认位置一句同步改写，Q-36 加第 11—15 项，Q-09 只剩签名、更新与分发渠道。
- ACT-13 的完成写回[用户待办](../../USER-ACTIONS.md#act-13)与执行状态；本阶段的范围、需求、验收、Q-36 与 ACT-14 写进各自的正本；交付路线 2.2 改为本阶段，上一阶段的能力并入 2.1；受影响的需求标为“本阶段”，B 实现后改为“已实现”。
- 不入库的文件：删除 `dist/gate-package/`（约 650 MB，A 上一阶段为对照基准另打的包，脚本不引用）、`dist/evidence-runs/` 里 87 份上一阶段的零散日志（`current/` 与推送前日志保留）、`apps/desktop/.vite/`（构建缓存）。

**B 执行时再核对一遍：**

| 位置 | 内容判断 | 处理 |
| --- | --- | --- |
| `.env.local` | 开发者的本地配置与凭据，必需 | 保留；不读取与任务无关的值 |
| `dist/design-refs/`（约 1 MB） | 用户提供的界面参考图与截图（三次），对应的问题都已处理 | 原样保留：用户提供的材料，体积小 |
| `dist/tools/`（约 319 MB） | 固定版本的 FFmpeg、OpenAPI 类型生成器、语音模型、字幕字体 | 原样保留 |
| `dist/samples/`（约 83 MB） | 生成的合成样本，测试在用 | 保留；本阶段新增的样本按第 7 节生成 |
| `dist/desktop/`（约 728 MB） | 上一阶段最后的打包产物（Electron 44），人工检查与 4.1 的旧版 Profile 用 | 先用它生成 4.1 的旧版凭据 Profile，再在阶段末重新打包时覆盖 |
| `dist/keys/` | 第一方插件的签名私钥（ACT-08） | 原样保留，不读不输出 |
| `dist/plugins/` | 打包出的第一方插件包 | 保留；阶段末重新生成 |
| `dist/evidence-runs/` | `current/`（上一阶段最后一次门禁）与推送前日志 | `current/` 在本阶段第一次门禁运行时覆盖；推送前日志由钩子自己保留最近 10 份 |
| 系统临时目录里的 `manga-*`（126 个，2026-11-03） | 上一阶段门禁与补充测量留下的 | 按 4.7 确认后删除，只记数量 |
| 上一阶段的本地分支 | 内容已全部合入 `main @ e05fda3` | 保留，不由 Agent 删除 |

**已入库的文件：**

| 位置 | 内容判断 | 处理 |
| --- | --- | --- |
| `docs/delivery/status.md`、`USER-ACTIONS.md`、`docs/README.md`、`docs/decisions/0007-technology-stack.md` | 长期正本，含上一阶段的过程叙述 | 精炼：只留当前结论与链接 |
| `docs/evidence/gate/` | 上一阶段最后一次门禁的证据 | 本阶段最后一次门禁时整体替换 |
| `scripts/check-docs.test.mjs` 里 `currentStage` 的样例 | 测试数据 | 按新的当前阶段更新样例，断言不减 |

**去掉以前阶段的标签（A-57）。** 运行文档检查，把报出的 `M5` / `m5` 标签逐个改写（证据文件在本阶段最后一次门禁时整体替换）。Git 提交信息与固定归档链接里的路径不改。

### 5.2 D1 依赖盘点

按 3.2 的表执行；Electron 与 pi-ai 分别在 W1、W2 做。实施开始与门禁之前各跑一次 `pnpm outdated -r`。ADR-0007 的版本表与例外表按结果更新。

### 5.3 工作包

| 包 | 内容 | 关键失败路径 | 验收 |
| --- | --- | --- | --- |
| W1 Electron 45 与凭据 | 4.1：升级、异步凭据与写回、`manga:state`、原生模块重建、同步接口的检查、旧版 Profile 的打包观察 | 应用就绪前读凭据；`safeStorage` 不可用时保存凭据给出 `CREDENTIAL_UNAVAILABLE`、不写明文；写回新密文失败时这次调用照常成功；同时读同一个凭据的两个调用只写回一次；弹幕、Bangumi、模型连接与视觉读取的凭据路径都走新接口 | AT-141 |
| W2 pi-ai 1.x | 4.2 | 工具参数里有 `$ref`、`enum`、可选字段时两个运行时的校验一致；中止后不再收到事件；压缩时的摘要请求照旧计一次请求并记入调用追踪 | AT-142 |
| W3 长对话 | 4.3：虚拟列表、贴底、跳转、`session.stream` 的 `from`、自动载入更早的页 | 回答流式变长时在底部就贴底、翻上去就不动；窗口高度变化、停靠栏与对话标签切换后位置正确；刷新时删掉了视口里的那条消息，锚点换到相邻的一条；跳到一条还没载入的消息；切换会话时上一会话的消息不出现；5000 条的上限 | AT-143 |
| W4 图像的存放与保留 | 4.4：两张表、写入去重、保留期与清理、重试规则、v13 迁移、设置项、运行详情的占位 | 迁移中途强制结束后再启动能完成；迁移失败回滚、资料不变；v12 的应用拒绝打开 v13；清理与正在进行的重试同时发生时，重试要么拿到原字节、要么按过期处理，不会读到一半；同一张图被两次运行引用，一次过期后另一次照样能重试 | AT-144 |
| W5 PDF 与视频输入 | 4.5：模型档案的 `limits` 与弹窗、四个条件的判断、视频片段的截取与冻结、PDF 的哈希核对、预算、调用记录、假模型服务 | 防剧透开启时片段的终点不越过已看到的位置；源是 MKV、HEVC、可变帧率时的截取；截取失败与超过上限都退回帧图并写明原因；pi 运行时与 Responses 协议的退回；PDF 在任务开始后被替换 | AT-145、AT-146 |
| W6 工作区余项 | 4.6 的三项 | 资源库标签已在另一栏时切到那一栏；它的页面历史照旧可以后退；四宫格基准的门槛不变 | AT-147 |
| W7 门禁工程 | 4.7：临时目录的清理与计数、节能降速的评估、三条观察的判断方式 | 失败的运行保留现场；清理不删别的仍在运行的门禁的目录；评估不改门槛 | 临时目录计数；评估记录；连续三次 `stage package` |
| W8 走查、测试与基准 | 见第 7 节；改写依赖旧结构的测试（同步的 `CredentialVault`、内联的 `FrozenImage.base64`、`Type.Unsafe`、整页替换的消息列表、四宫格基准的笔记标签），断言不减，迁移映射写进报告 | — | 第 7 节 |
| W9 文档 | 需求 MODEL-05、CTX-02、AGENT-06、DATA-04、DATA-06 等按实现改写并改为“已实现”；交付路线 AT-141—AT-150 在实现后改为“已实现”，AT-51 按新的默认位置改写；领域模型 11.2（两个根与分区的默认位置、启动指针）；开发流程与仓库地图里提到 `Documents\MANGA` 的地方；领域模型（`agent_media`、模型档案的 `limits`）；数据与安全（异步凭据、v13 迁移、图像保留期）；Agent 与插件协议（两个运行时的输入差异、发送类型的记录）；交互设计（模型弹窗的上限、对话列表的自动载入、运行详情的过期图像、“设置 › 智能体”的保留天数）；质量门禁（新观察、新基准、临时目录计数、LOOP-13 的结论）；ADR-0007（版本表、例外、自写的理由）；执行状态（LOOP-05、07、13、17、24、26、27 的状态）；用户待办的人工检查（第 8 节） | — | 文档检查 |
| W10 数据的存放位置 | 4.9：两个根与下载位置、系统登记的“文档”与“下载”、新的指针位置、崩溃转储、旧位置的升级（只搬应用数据、用户文件记成覆盖、标记与清理入口）、首次启动引导与设置的位置页、开发版的通道写进产物 | 旧指针有分区覆盖或指向自定义的根；旧位置只读或磁盘空间不够；复制中强制结束后再启动；旧版本在升级后启动，跟着标记打开新位置；“文档”被重定向到另一个盘；`LOCALAPPDATA` 缺失；测试通道仍拒绝没有隔离根的启动；用户文件分区里的绝对路径（作品内容文件夹、笔记文件）升级后照常打开 | AT-148、AT-149；AT-51 |
| W11 安装包 | 4.10：electron-builder 的 NSIS 配置与 `--prepackaged`、两个通道的应用 ID 与名字、默认目录、卸载保留数据、配置检查、真实安装与卸载的脚本 | 默认目录名不随产品名变成别的；改目录后再装一次覆盖原位置；两个通道同时装、各自卸载；正在运行时安装或卸载；卸载后开始菜单、快捷方式与卸载项都清掉、数据还在 | AT-150 |

### 5.4 顺序

1. C0；D1 的第一次盘点；不涉及主版本的补丁与小版本升级。
2. W1（之后的工作都在 Electron 45 上测）。Electron 45.0.0 2026-11-04 起满 14 天；当天之前先做异步凭据的改动，再升级。
3. W2（pi-ai 1.4.0 同样 2026-11-04 起满 14 天）。
4. W4 → W5（W5 的视频片段用 W4 的存放与保留）。
5. W10 → W11（安装包验证 4.9 的位置）；W10 的位置迁移与 W4 的 v13 迁移按 4.9 第 5 步的顺序接起来。
6. W3、W6、W7（互不依赖，可以任意顺序）。
7. W8、W9；最后一次 `pnpm outdated -r`；门禁、打包、基准、报告与整理记录。

可以按依赖调整顺序，但不得跳过任何一个工作包。

## 6. 界面要点

- 视觉沿用现有主题；新增的控件只有模型弹窗里的三个上限、“设置 › 智能体”的保留天数与运行详情里过期图像的占位，用现有的输入框、选择框与占位样式，深浅主题都要有。
- 模型弹窗：勾选“PDF”或“视频”后在它下面出现对应的上限，单位写清（MiB、秒），超出范围时就地提示；没有勾选时不显示。
- 对话列表的外观与现在一致：虚拟化不改变行的样式、间距与选择文字的方式；“更早的消息”按钮保留，自动载入时显示为加载中；跳到一条消息时的高亮与现在一致。
- 运行详情里过期的图像：与原图同样宽高比的占位，文字“已过保留期”，悬停显示来源与尺寸；可访问名称同样写明。
- 所有新控件有可访问名称；数字输入框可以用键盘调整。

## 7. 样本、门禁与基准

**样本。** 全部合成：沿用 `dist/samples/` 与现有的规模样本；补：一段 5000 条消息的会话（含笔记、录音与 Agent 回答，长短不一）；一份 v12 资料，含 300 次带冻结图像的运行（其中一部分图像相同）、几次运行中与失败的运行；一份 PDF 合成书（约 2 MiB，有插图）与一份超过 20 MiB 的；动漫样本里 H.264 MP4、HEVC MKV、可变帧率各一集用来截片段；一份由 Electron 44 的打包产物保存过模型密钥、弹弹play 与 Bangumi 凭据的隔离 Profile（4.1）。

**窗口观察（打包烟测，新增，必需）：**

| 观察 | 内容 |
| --- | --- |
| `credentials-async` | 用 4.1 的旧版 Profile 启动：三种凭据都解得开（模型的测试连接对假模型服务成功、弹弹play 的假服务收到正确的签名头、Bangumi 的假服务收到令牌）；保存一个新的模型密钥，重启后测试连接成功；数据库里没有明文 |
| `chat-long-session` | 打开 5000 条消息的会话：最新一屏画好，页面里的消息节点数不超过 60；向上滚到顶部自动载入更早的一页，视口顶端那条消息不动；此时发一条主机通知触发刷新，已翻出的页仍在、视口不动；删掉视口外的一条旧消息后刷新，它消失、视口不动；回到底部后让假模型流式回答，始终贴底；回答中向上翻，不被拉回；跳到一条还没载入的消息，它出现并高亮 |
| `agent-media-native` | 假模型服务：一个档案勾了 PDF 与视频（Chat Completions）、一个只勾 PDF（Responses）、一个都不勾、一个是 pi 运行时；分别发起带整份 PDF 的任务与带视频区间的任务：PDF 依次是 `file` 部分、`input_file` 部分、文字、文字，视频依次是 `video_url` 片段、帧图、帧图、帧图；片段的时长与终点在区间内、不越过当前位置；超过上限的 PDF 与片段退回并写明原因；调用记录有类型、大小与原因、没有内容 |
| `agent-media-retain` | 两次运行冻结同一张图，`agent_media` 里只有一行；把时钟拨过保留期并触发清理：两次运行的图像都过期、行被删除，运行详情显示占位；重试其中一次，来源未变时按来源重新提取并成功；改掉来源文件后重试，任务停下并说明原因 |
| `migrate-v13` | 用 v12 资料启动：迁移前有备份，迁移后所有图像的哈希集合与迁移前相同，重试一次旧运行发送的字节与迁移前相同；第二次启动不再改动；较旧版本拒绝打开 |
| `workspace-last-tab-empty` | 关闭“最近”的最后一个标签，`reload()` 后主区仍空；切到项目再回来仍空 |
| `library-tab-single` | 从书架打开三次阅读器、从侧栏的管理入口与搜索框各进一次资源库：同一视图里只有一个资源库标签；它在另一栏时切过去 |
| `data-locations-fresh` | 用临时目录里的 `LOCALAPPDATA`、文档与下载（4.10 的环境变量）启动一个全新的正式版与一个开发版：数据库、指针、缓存、日志、运行时、崩溃转储与自动备份都在 `<LocalAppData>\manga`（开发版 `manga-dev`），截图与笔记文件在 `<文档>\MANGA`（开发版 `MANGA-dev`），下载在 `<下载>\MANGA`；临时的 `%APPDATA%` 与主目录里没有 MANGA 的文件；设置的位置页按三组显示 |
| `data-locations-upgrade` | 在临时的旧位置（`<文档>\MANGA\release`）放一份旧版本的 Profile（含截图、笔记文件、作品内容文件夹与一个自定义的下载覆盖）：启动后应用数据在新位置、指纹与完整性检查通过，用户文件仍在原处并能打开，下载覆盖不变，旧根有 `RELOCATED.json`；第二次启动不再改动；在复制中途结束进程后再启动，旧位置照常可用、随后完成迁移；用旧版本的产物启动，跟着标记打开新位置 |

上一阶段全部的窗口观察保留，Electron 升级后全部重跑；`hold-rate-hint-only`、`hold-rate-recovers`、`frame-window-controls` 按 4.7 改判断方式，目标与门槛不变。

截图只留关键状态：长对话列表的中段、模型弹窗里勾了 PDF 与视频的上限、运行详情里过期的图像占位、设置的位置页（三组），各一张浅色。截图不含本机路径。

**基准（新增门槛）：**

| 指标 | 门槛 |
| --- | --- |
| 5000 条消息的会话：打开到最新一屏画好，p95 | ≤ 300 ms |
| 5000 条消息的会话：输入到提交并布局，p95 | ≤ 50 ms |
| 5000 条消息的会话：连续滚动时晚到帧的占比 | ≤ 2% |
| 向上载入一页（200 条）到画好且视口不动，p95 | ≤ 150 ms |
| 截取 60 s 的视频片段（H.264 MP4 样本，无转码），p95 | ≤ 2000 ms |
| 运行快照冻结 4 MB 图像（含哈希与写入），p95 | ≤ 200 ms |

记录项（不设门槛）：v12 → v13 迁移的耗时与迁移前后的数据库体积（300 次带图像的运行）；从旧位置升级时复制 500 MB 应用数据的耗时；安装与卸载的耗时、安装程序的大小；第一次异步解密凭据的耗时；对话 1000 条与 5000 条时的内存工作集。

现有门槛与观察全部保留，目标与测量方法不改；Electron 升级后全部重跑。跑基准前确认机器空闲、启动它的应用在前台（[LOOP-13](status.md#loop-13)；长时间运行后先重启、关掉常驻应用），跑的过程中不执行改动工作树的 git 命令。

**门禁。** `node scripts/stage.mjs test`、`package`、`bench`、`report` 与 `node scripts/verify.mjs` 都在最终源码上通过；4.10 的真实安装与卸载脚本在最终源码上跑一次并通过；`stage package` 连续三次通过（LOOP-27）；证据整体替换 `docs/evidence/gate/`，总量不超过 5 MiB，复制前先看过新截图，不含本机路径。

## 8. 人工检查

B 在用户待办里新增人工检查（编号从 H-80 起），写到用户能直接照做：升级后打开自己平时用的 Profile，模型的测试连接、弹幕与 Bangumi 照常（不用重填凭据）；窗口、全屏、播放、阅读与下载各走一遍常用路径；在一段很长的对话里滚动、翻出更早的消息后等一条回复、跳到笔记引用的那条消息；模型弹窗里给一个支持 PDF 或视频的模型勾上输入类型与上限（真实调用需要 ACT-14）；运行详情里过期图像的样子；用安装程序装到默认位置（看到 SmartScreen 的“未知发布者”时怎么继续）、再装开发版，两者并存、开始菜单里名字不同；第一次启动新版本后，“文档”里的 `MANGA` 只剩自己的文件，设置的位置页显示新位置，确认无误后用“清理旧位置”；卸载正式版后再装回，数据都在。已有 H 项里受 Electron 升级影响的（窗口框架、全屏、播放器、插件与下载）标“需重测”；其余只在说法变了时改文字。人工检查保持 not-run，不由脚本代填。

## 9. B 交付与 A 审查

- B 新建本阶段报告 `docs/delivery/stage-report.md`（并加回登记表、`docs/README.md` 与 `docs/SUMMARY.md`）：按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射；写明位置迁移与安装、卸载的验证结果、 Electron 与 pi-ai 的升级结果（版本、破坏性变更逐条的处理、回退与否）、贴底的路线试验结论、v13 迁移在规模样本上的耗时与体积、LOOP-13 的评估结论与数据、三条观察前后的判断方式、迁移映射（测试与走查）、依赖盘点结果、整理记录（含临时目录的数量）、基准数值与源码指纹。
- B 交付前自检：第 1 节的退出条件逐条有证据；`verify` 与四个阶段入口通过；文档检查通过；暂存内容核对过；一个带 DCO 签名的阶段提交（amend 本计划所在的提交，消息按最终结果重写）。
- A 审查时重点看：凭据的每条读写路径都走异步接口、写回不会丢凭据、不可用时不写明文；pi-ai 升级后两个运行时的行为差异只在文件与视频；虚拟列表的贴底与锚点在流式回答、删除与跳转时是否正确；`from` 刷新的上限与恢复；v13 迁移的备份、回滚、中断与哈希一致；保留期清理与重试的并发；过期后按来源重新提取时修订的核对；视频片段的终点与防剧透范围；PDF 只在整份、用户放入、范围覆盖时发送；调用记录不含内容；临时目录的清理范围；三条观察的判断没有被放宽；LOOP-13 的办法只作用于基准进程；位置迁移只搬应用数据、复制后校验再切换、失败不写新指针、旧文件不自动删除，旧版本跟得到新位置；“文档”与“下载”用系统登记的位置；测试与安装脚本没有碰本机真实的 Profile 与安装，卸载后没有残留的开始菜单项与注册表项。

## 10. 待处理事项入口

- 需要用户的：[Q-36](../../USER-ACTIONS.md#q-36)（本阶段 Agent 先用的默认值）；可选的 [ACT-14](../../USER-ACTIONS.md#act-14)（用户自己的模型对 PDF 与视频输入的真实试验，B 交付后再做更合适）；仍待答复的 [Q-35](../../USER-ACTIONS.md#q-35)、[Q-33](../../USER-ACTIONS.md#q-33)、[ACT-11](../../USER-ACTIONS.md#act-11)（真实 Profile 的迁移在副本上重放；v13 迁移合入后，重放时一并覆盖 v12 → v13）。都不阻塞本阶段。
- 顺延的 Agent 侧后续项：LOOP-09（待审操作），以及 LOOP-17 里的音频输入与 PDF 按页截取，留在[执行状态的后续 loop](status.md#followup-loops)。
- 本阶段发现的非阻塞问题按开发流程新增 LOOP 条目，不扩大本阶段范围。

<a id="prompt"></a>
## 11. 交给 B 的执行 prompt

```text
你是 Agent B，在本仓库的分支 feat/m6-deps-agent-loop 上连续完成当前阶段（依赖升级与 Agent 工程循环）。

依据：AGENTS.md；docs/delivery/stage-plan.md（本阶段唯一计划，全部工作包 C0、D1、W1—W11）；确认记录 A-117—A-119；需求 MODEL-05、AGENT-06、AGENT-07、CTX-02、DATA-01、DATA-04、DATA-06、NFR-01、NFR-03、NFR-05、UI-09；验收 AT-141—AT-150 与计划第 1 节列出的重跑用例；执行状态的 LOOP-05、07、13、17、24、26、27；用户待办 Q-36（按其中的默认实现；用户答复后以答复为准）。

要求：
1. 先核对现场（git status、分支基于 main@e05fda3、计划所在的提交），再按计划第 5.4 节的顺序连续实施，不逐工作包询问。
2. 依赖按计划 3.2 处理：取实施当天满 14 天的最新精确版本，不绕过最小发行龄；Electron 45 与 pi-ai 1.x 都要 2026-11-04 起才满 14 天，之前先做不依赖新版本的改动。升级失败就回退，并在 ADR-0007 写明尝试的版本、失败的命令、上游限制与复查条件。
3. W1 的凭据改用异步接口，解密的 6 处调用都经同一个读取函数；用 Electron 44 的产物生成的旧版 Profile 在 45 上验证（计划 4.1）。源码里不留同步的 safeStorage 调用。
4. W2 的工具参数直接写 JSON Schema，不从 pi-ai 导入 TypeBox；按计划 3.1 的破坏性变更逐条核对并写进报告。
5. W3 先试“虚拟列表 + use-stick-to-bottom”，不行再改为自己贴底（计划 4.3），结论写进报告与 ADR-0007。
6. W4 的 schema v13 迁移按数据与安全规则：迁移前备份、失败回滚、中断后可继续、较旧版本拒绝打开，迁移前后图像的哈希集合必须相等（计划 4.4）。
7. W5 的 PDF 与视频输入只在计划 4.5 的四个条件都满足时发送，任何一个不满足都退回文字或帧图并在调用记录里写明原因；视频片段无转码截取，终点不越过当前位置与防剧透范围。
8. W7 不改任何门槛与测量方法；三条观察改为按页面内的时间判断，报告写明前后的判断方式；LOOP-13 的办法只作用于基准进程。系统临时目录只删计划 4.7 确认过的前缀，报告只写数量。
9. W10 的位置迁移只搬应用数据、用户文件记成分区覆盖不搬，复制后校验再切换，失败不写新指针，旧文件不自动删除（计划 4.9）；全部在临时目录与合成 Profile 上测，不动本机真实的 Profile。W11 的真实安装与卸载只装到临时目录，结束时卸载并确认开始菜单项、快捷方式与注册表卸载项都已清掉（计划 4.10）；安装包不签名、不发布。
10. 改写测试与走查时断言不减；删除的断言在迁移映射里写明由什么替代。
11. 只用合成样本；不发真实模型、弹弹play、Bangumi 请求（ACT-14 未授权）；真实资源库只读试验可选，只记聚合，不写名称与路径。
12. 完成后在最终源码上跑 node scripts/verify.mjs、node scripts/stage.mjs test、package（连续三次）、计划 4.10 的安装与卸载脚本、bench（跑前确认机器空闲、启动它的应用在前台，长时间运行后先重启；跑的过程中不执行改动工作树的 git 命令）、report；证据替换 docs/evidence/gate/（≤ 5 MiB，截图不含本机路径，复制前先看过新截图）。
13. 新建本阶段报告 docs/delivery/stage-report.md（计划第 9 节，并加回登记表、docs/README.md 与 docs/SUMMARY.md），更新用户待办的人工检查（计划第 8 节）、执行状态与各正本；把全部改动 amend 进本阶段唯一的 DCO 签名提交，消息按最终结果写。不 push。
14. 结束时按开发流程 2.4 给出首选下一步：推荐交给 A 集中审查，并附审查 prompt。
```
