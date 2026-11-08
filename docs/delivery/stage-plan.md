# 当前阶段计划（M9）：Agent 的待审操作与门禁提速

日期：2026-11-06。角色：A 规划；B 连续实施与自检；A 集中审查。本文是整个阶段的唯一计划，兼作跨模块变更提案（A-46）。B 的执行 prompt 在[第 11 节](#prompt)，不另建 prompt 文件。路径固定、不带阶段名；下一阶段开始时由 A 按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)改写。上一阶段的计划与报告在合并提交里：[计划归档](https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-plan.md)、[报告归档](https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-report.md)。

用户 2026-11-06 在上一阶段合并后说“开始下一个阶段”，没有提新的产品要求。按 A-39（MVP 已贯通，之后按反馈循环迭代）与[执行状态的后续 loop](status.md#followup-loops)，A 选的范围是：

1. **Agent 的待审操作（LOOP-09）。** 路线 2026-10-08 已定（A-74），一直顺延。删除、重命名、项目包导出、粗剪的编辑与导出，由 Agent 提出、界面列出将要发生的变化、用户确认后才由所有者命令执行。语义检索与网页抓取像 `metadata.search` 一样，由用户为一次任务加上。这是现在 Agent 在项目里“只能建议、不能收尾”的主要缺口：整理一个项目时，用户仍要自己去删旧白板、改名、导出。
2. **门禁提速（LOOP-29）。** 用户 2026-11-06 指出门禁效率太低，上一阶段审查已把测试并行并加了 `stage gate`；剩下最大的一块是窗口走查里约 430 处固定等待（每次 `stage package` 约 12 分钟里约 7 分钟），而本阶段要连续三次 `stage package`。顺带补拍模型弹窗的截图。
3. **测试的临时目录（LOOP-28）。** 一次 `stage test` 在系统临时目录留约 4 个目录。

记为 **A-120**（本阶段的范围）与 **A-121**（待审操作的设计：不暂停任务的提议、确认时重新核对、只执行一次）。A 的推荐与理由见 3.1 与第 4 节。没说到的细节 A 先定了默认值，登记为[用户待办的 Q-37](../../USER-ACTIONS.md#q-37)，B 按默认实现，用户以后可以改。插件与下载继续只由所有者操作（A-74）；项目包**导入**不开放给 Agent，因为它要用户先选一个文件（Q-37 第 3 项）。需求是 AGENT-01、AGENT-03、AGENT-04、DATA-01（[需求](../product/requirements.md)），验收是 [AT-151—AT-156](roadmap-and-acceptance.md#at-proposals)。

本计划一次列出本阶段的全部交付、退出条件和收尾流程。B 连续完成全部工作包后一次交付，A 一次集中审查。人工检查与待决问题按 A-53 记在用户待办，不阻塞开发。

## 1. 范围与退出条件

| 项目 | 约定 |
| --- | --- |
| 阶段 | Agent 的待审操作与门禁提速：提议的存放与 schema v14（W1）；五种提议（W2）；确认、拒绝与失效（W3）；对话里的提议卡片（W4）；按任务加上的语义检索与网页抓取（W5）；窗口走查的条件等待（W6，LOOP-29）；测试的临时目录（W7，LOOP-28）；阶段开始的整理；依赖盘点 |
| 代码基线 | `main @ fd32430`（[PR #8](https://github.com/chialecode/manga/pull/8) 于 2026-11-06 squash 合并）；没有未合并的前置分支 |
| 工作分支 | `feat/m9-next`，A 已从基线创建。本计划所在的提交是阶段提交的起点；B 的实施、A 的审查修复与人工反馈修复全部 amend 进同一提交 |
| 关联需求 | AGENT-01、AGENT-03、AGENT-04、DATA-01；受影响的既有行为：AGENT-06（对话的列表里出现提议卡片；删除对话连同它的提议）、AGENT-07（调用追踪记录提议工具）、CREATE 类需求里的删除、重命名与导出（行为不变，多一个由提议触发的入口）、SEARCH-02（语义检索多一个 Agent 的入口） |
| 关联验收 | 新增 AT-151—AT-156；授权相关的既有用例按新工具重跑并扩充：AT-11、AT-13、AT-44、AT-85、AT-129。窗口走查改为条件等待后，全部打包烟测与窗口观察重跑 |
| 可连续执行 | 本地实现；第 3 节列出的依赖试用与安装；合成样本、测试、打包、基准、文档同步；第 5.1 节的整理；阶段提交与 amend。不逐工作包询问 |
| 外部操作 | 未授权：push、PR、合并、发布。不需要真实模型、Embedding、网页或 Bangumi 的调用：语义检索用本地的假 Embedding 服务，网页抓取用本机回环地址上的假网页服务；真实 Embedding 调用仍受 ACT-05 约束。数据库 schema 升到 v14（4.1），按数据与安全规则做迁移：迁移前备份、失败回滚、中断后可继续、较旧版本拒绝打开，并有测试 |

**退出条件与覆盖**

| 条件 | 做法 | 工作包 | 验收证据 |
| --- | --- | --- | --- |
| Agent 只能提出，不能直接执行 | 项目对话里的 Agent 有五个提议工具；调用只写一条提议，不改动任何对象；“最近”的对话没有这些工具；命令层拒绝 Agent 直接调用删除、重命名、导出与粗剪编辑 | W1、W2 | AT-151；AT-11、AT-85 |
| 用户看到将要发生的变化 | 提议卡片列出对象、变化前后、引用它的地方、能否撤销；删除写明不能撤销 | W2、W4 | AT-151、AT-153、AT-154 |
| 确认后只执行一次、按当时的对象执行 | 确认时原子地把提议从“待确认”改为“执行中”；对象在提议后被改过或删掉时不执行、标为“已失效”；执行用所有者命令与提议的幂等键；中途退出后再启动能判断执行了没有 | W3 | AT-152 |
| 拒绝与结果回到 Agent | 拒绝不改动任何东西；下一次任务的上下文里有这次会话里已处理提议的结果（执行、拒绝、失效、失败与原因） | W3 | AT-151 |
| 粗剪的编辑与导出 | 编辑的提议列出每一步与前后的片段数、总时长；确认后进入粗剪的撤销列表，标为 Agent 的一步；导出的提议先给出导出计划与问题，确认后照常导出、可取消 | W2、W3 | AT-153 |
| 项目包导出 | 确认时选保存位置；取消选择时提议仍待确认；导出的包与用户自己导出的相同 | W2、W3 | AT-154 |
| 语义检索与网页抓取按任务加上 | 输入框的“本次任务”里新增两项；没加时工具不出现、命令层拒绝；加了只对这一次任务有效，重试沿用；模块没开或不在项目里时不显示对应项 | W5 | AT-155；AT-13 |
| schema v14 | v13 → v14 新增提议表；迁移前备份、失败回滚、可重复执行、较旧版本拒绝打开；删除对话连同它的提议 | W1 | AT-156 |
| 窗口走查更快 | 固定等待改为等到条件满足，只留按真实时间流逝的等待并写明原因；断言与门槛不变；`window-walk` ≤ 240 s；模型弹窗截图拍到“模型能力”一节 | W6 | `stage package` 的阶段用时；新增的固定等待检查 |
| 测试不留临时目录 | 测试辅助件的临时目录放进全局的测试临时根并在结束时删除；`stage test` 前后各数一次，多出的算失败 | W7 | `test-run.json` 的计数 |
| 阶段开始的整理 | 上一阶段的报告提炼后删除；去掉以前阶段的标签；按内容整理文件 | C0 | 文档检查；报告的整理记录 |
| 依赖盘点 | 按 A-35 与 ADR-0007 的复查条件逐项处理 | D1 | ADR-0007 版本表；完整回归 |

**阶段完成的判定。** 以下依次满足后，Agent 侧完成，可以请求用户授权 push、PR 与合并（A-24、A-53）：（1）B 自检的必需用例与门禁全部通过；（2）A 集中审查收敛。人工检查与待答复问题记在用户待办，不是合并的前提；`productAcceptance` 保持 not-run。

**阶段完成后，用户可以：**

- 在项目对话里说“把这三块旧白板删掉、把导图改名叫《第二季结构》”，对话里出现两张提议卡片，写清删掉什么、哪里引用了它、不能撤销；点“确认”才执行，点“拒绝”什么都不变，Agent 下一轮知道你的决定；
- 让 Agent 调整粗剪（“把第 3 段挪到最后，删掉重复的两段”），确认前看到每一步与前后的时长，确认后不满意可以在粗剪里撤销；让它导出粗剪或项目包，确认时选保存位置；
- 发起一次任务时勾上“语义检索”或“抓取网页”，只有这次任务能用；
- 门禁的一次 `stage package` 从约 12 分钟降到约 9 分钟以内，一次完整的 `stage gate` 少约 10 分钟；测试跑完不在临时目录留东西。

## 2. A 已核对的现场

- **Agent 的命令清单**（`packages/app-core/src/commands/access.ts`）：`AGENT_COMMANDS`（资料读取、笔记的创建与修改等 22 个）、`AGENT_OPT_IN_COMMANDS = ["metadata.search"]`；项目范围的在 `creative/agent-access.ts`：`AGENT_PROJECT_READS`（18 个）与 `AGENT_PROJECT_WRITES`（`whiteboard.edit`、`mindmap.edit`、`project.addMaterial`、`project.addTerm`、`draft.suggest`）。`agentToolSchema` 去掉任务自带的参数（`contextId`、`projectId`）与 Agent 不能用的参数；`AgentRule` 在命令层拒绝别的项目与不属于本项目的对象。`AGENT_LOGGED_COMMANDS` 决定哪些 Agent 写入进操作日志；`AGENT_EDIT_LABEL = "Agent："` 标在白板与导图的撤销列表里。
- **任务的授权。** `product-app.ts` 第 495 行按 `AGENT_COMMANDS`、项目命令与 `input.allowCommands`（只认 `AGENT_OPT_IN_COMMANDS`）组出 `allowedCommands`；`commands/agent-run.ts` 第 231 行据此给模型工具清单；`commands/agent.ts` 第 329 行在加了 `metadata.search` 时要求对应模块开启、第 447 行把它记为 `allowedNetworkCommands`。契约 `contracts/src/inputs.ts` 第 247 行：`allowCommands: z.array(z.enum(["metadata.search"])).max(1)`。界面 `renderer/workspace/agent.tsx` 第 199 行：输入框的 `allowOnline` 对应 `metadata.search`。工具的中文说明在 `product-helpers.ts`（第 41 行起）。
- **已有的“提出—采纳”。** 文稿建议：`draft.suggest` 由 Agent 写一条建议，用户在文稿里 `draft.adopt` / `draft.discardSuggestion`；这是唯一现成的“Agent 提出、用户决定”的做法，但它挂在文稿上，不是通用的。
- **要开放的所有者命令**（`commands/creative.ts`）：`whiteboard.delete` / `rename`、`mindmap.delete` / `rename`、`draft.delete` / `rename`、`roughcut.delete` / `rename`、`project.update`（项目改名）、`project.exportPackage { projectId, pathHandle }`（`pathHandle` 来自保存对话框，`renderer/hooks/use-package.ts`）、`roughcut.edit { cutId, label?, actions[1..200] }`（有撤销与重做）、`roughcut.plan`、`roughcut.export { cutId, pathHandle?, fileName?, options? }`（不给 `pathHandle` 时写进导出分区）。白板、导图、文稿与粗剪的删除是直接删除，没有回收站（B 核对；有的话预览写明可以恢复）。引用关系可以从 `embed.backlinks` 查到。
- **语义检索与网页抓取。** `semantic.search`（`contracts/src/inputs-semantic.ts`）需要语义模块开启并配好 Embedding 连接；`webpage.fetch { url }`（`inputs-research.ts`）抓取网页并存为项目里的网页版本，`webpage.list` / `get` 已经是 Agent 的项目读取命令。
- **存储。** `packages/storage-drizzle/src/sql.ts` 的 `PRODUCT_SCHEMA_VERSION = 13`；`command_requests` 表记录幂等回执（操作者、会话、幂等键）；迁移、备份与回滚走 `store.ts` 的现有流程。删除对话（A-89）连同运行、消息、工具事件、追踪、检查点与冻结的材料。
- **窗口走查**（`apps/desktop/src/main/smoke/`）：`sleep(` 的调用 2026-11-06 数到约 430 处，最多的是 `shell-walk.ts`（50）、`rail-walk.ts` 与 `media.ts`（各 27）、`workspace-walk.ts`（27）、`frame-walk.ts`（25）、`novel-walk.ts` 与 `view-walk.ts`（各 23）。`driver.ts` 已有 `waitUntil(view, expression, timeoutMs)` 与 `waitForTestId`，`common.ts` 有 `capturePage`。上一阶段最终门禁里每次 `stage package` 约 700 s，其中 `window-walk` 约 7 分钟。模型弹窗截图 `ui-model-limits` 停在弹窗顶部（[上一阶段报告第 10 节](https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-report.md#limits)）。
- **测试的临时目录。** `vitest.config.ts` 的 `globalSetup` 是 `tests/helpers/global-temp.ts`，它建一个全局的测试临时根；但 `tests/helpers/plugin-fixtures.ts` 的 `tmpDir()`（`manga-plugin-*`）与 `tests/helpers/app.ts`（`manga-test-*`）直接用 `os.tmpdir()`，个别用例没有删。
- **门禁。** `node scripts/stage.mjs gate` 按 verify → test → package → installer → bench → package 直到连续三次 → report 跑，跳过结果仍有效的步骤（[质量门禁第 2 节](../dev-rules/quality-gates.md)）。

## 3. 开源查证（2026-11-06）

查询来源：npm registry 的发行时间、GitHub 仓库与官方文档。“满 14 天”以实施当天计算，B 实施时重查一次。本地参考索引里“Agent 功能”一项没有工具审批的做法，按开发流程 2.5 记为“未找到对应参考”。

### 3.1 候选

| 需要 | 候选 | 版本与日期 | 许可证 | 判断 |
| --- | --- | --- | --- | --- |
| 工具调用的人工审批 | OpenAI Agents SDK（JS）的 human-in-the-loop（[指南](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)，2026-11-06 查阅） | `@openai/agents` 0.21.0（2026-10-20） | MIT | **借鉴做法，不引入**：工具设 `needsApproval`，调用时不执行、记为 `RunToolApprovalItem`，一轮结束时任务暂停并在 `result.interruptions` 里交出；`state.approve` / `reject` 后用序列化的 `RunState` 恢复。它的安全提示直接适用：界面只拿不透明的编号与显示内容，完整状态留在主进程；决定要对照存下的请求核对，并且**原子地只消费一次**，防止重放 |
| 同上 | Vercel AI SDK 的工具执行审批（[工具调用文档](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)，2026-11-06 查阅） | `ai` 7.0.163（2026-11-05） | Apache-2.0 | **借鉴做法，不引入**：`toolApproval`（旧的 `needsApproval` 已标为废弃）让调用**不暂停地返回**，内容里带 `tool-approval-request`；应用收集决定后把 `tool-approval-response` 放回消息再调一次，拒绝时模型收到 `execution-denied` 并可以回应。MANGA 采用同样“不暂停、下一轮带上决定”的形状（4.1） |
| 同上 | LangGraph 的 `interrupt()` 与 `Command({ resume })`（[中断文档](https://docs.langchain.com/oss/javascript/langgraph/interrupts)，2026-11-06 查阅） | `@langchain/langgraph` 1.7.0（2026-11-05） | MIT | 不采用：暂停要有检查点，恢复时节点从头重跑，副作用必须放在审批之后或幂等。MANGA 的任务循环是自己的（自研与 pi 两个运行时，A-11），换成图运行时代价大。借鉴“副作用在确认之后、可重复执行”的要求 |
| 提议的存放与执行 | 现有的 SQLite、命令网关与幂等回执 | — | — | **自写**：一张提议表（4.1），确认时经命令网关以所有者身份执行，幂等键是提议编号。不引入工作流或审批库：五种提议都是已有命令，缺的只是“先存下来、确认后执行一次”。理由写进 ADR-0007 |
| 粗剪编辑的预览 | 现有的粗剪模型 | — | — | **复用**：在副本上试应用动作，得到前后的片段数与总时长，不写库 |
| 条件等待 | 现有的 `waitUntil` / `waitForTestId`（`driver.ts`） | — | — | **复用**：不引入 Playwright 等测试框架；窗口走查本来就在 Electron 主进程里用 `executeJavaScript` 驱动 |

### 3.2 依赖盘点（A-35，D1）

2026-11-06 的 `pnpm outdated -r`，按“满 14 天的最新版本”（当天满 14 天即 2026-10-23 及以前发行）：

| 依赖 | 现用 | 最新 | 满 14 天的最新（2026-11-06） | 处理 |
| --- | --- | --- | --- | --- |
| @earendil-works/pi-ai | 1.3.0 | 1.5.0（11-02） | 1.4.0（10-21） | 升级；1.5.0 自 11-16 起满 14 天，实施末重查。1.4 的 `telemetryContext` 改名为 `telemetry`、删除 `getPiUserAgent()`；1.5 不再转出 TypeBox（上一阶段已改为直接写 JSON Schema） |
| electron | 45.0.0 | 45.2.3（11-04） | 45.0.0 | 实施末重查：45.1.0（10-27）11-10 起满 14 天，45.2.x 随后；补丁与小版本升级后全部打包烟测与基准重跑 |
| dockview-react | 8.6.1 | 8.8.3（10-30） | 8.6.1 | 实施末重查（8.8.x 约 11-12 起）；升级后复查标签上的 Delete / Backspace 是否仍要自己拦 |
| vitest | 5.0.5 | 5.1.0（11-02） | 5.0.5 | 实施末重查（11-16 起）；升级后核对按文件并行与 `--no-wasm-code-gc`（LOOP-08） |
| @tanstack/react-virtual | 3.14.21 | 3.14.26 | 3.14.22（10-22） | 升级；长对话的基准与 `chat-long-session` 照跑 |
| linkedom | 0.18.13 | 0.18.15 | 0.18.14（10-21） | 升级 |
| pdfjs-dist、onnxruntime-web、@napi-rs/canvas、knip、@vitejs/plugin-react、tiptap、@xyflow/react、tailwindcss、mdast-util-to-markdown、jassub、lucide-react、d3-hierarchy | — | 有补丁或小版本 | 多数还是现用版本 | 实施末重查，满 14 天的补丁与小版本照常升级；pdfjs-dist 6.5（11-15 起）与 onnxruntime-web 1.31（11-09 起）是小版本，升级后跑阅读器与语音的回归 |
| @types/node | 24.19.2 | 26.x | — | 留在 24.x：与 Electron 45 的 Node 24 和 CI 的 `.node-version` 一致 |

主版本或行为变化的升级先单独做并跑对应的回归，失败时回退到原版本，在 ADR-0007 的例外表写明尝试的版本、失败的命令、上游限制与复查条件。最小发行龄策略不绕过，不接受自动写入的豁免。

## 4. 设计

### 4.1 提议的存放与生命周期（W1，A-121，schema v14）

- **不暂停任务。** Agent 调用提议工具时，主进程校验参数、核对对象属于本项目、算出预览，写一条提议，工具结果是 `{ proposalId, status: "pending", summary }`，任务照常继续或结束；Agent 应该告诉用户“我提出了……，请在下面确认”。不做“任务停在工具调用上等确认”：那要把运行状态序列化、跨重启恢复，两个运行时都得改，而 A-74 只要求“提出、列出变化、确认后执行”。
- **一张表**（v14 新增，`sql.ts`）：`agent_proposals(id, session_id, run_id, project_id, kind, command_id, input_json, preview_json, target_json, reason, status, result_json, created_at, decided_at)`，`(session_id, status, created_at)` 上有索引。`target_json` 记下提议时对象的编号与修订（按现有行、内容与操作历史计算摘要字符串，删除/项目导出附加依赖摘要）。状态：`pending` → `applying` → `applied` / `failed`；`pending` → `rejected` / `stale`，确认后变化可由 `applying` → `stale`。创建提议与工具回执一起提交，模型只拿编号、状态与摘要。
- **上限。** 每个对话同时待确认的提议至多 20 条；第 21 条被拒绝，工具结果说明原因（让用户先处理已有的提议）。
- **跟随对话与项目。** 删除对话（A-89）连同它的提议；删除项目时它的提议随之删除。提议不进项目包与资料包；数据库备份照常包含。
- **迁移。** v13 → v14 只新增表与索引；迁移前备份、失败回滚、可重复执行、较旧版本拒绝打开 v14，与以前的迁移同一套流程与测试。

### 4.2 五种提议（W2）

Agent 看到的工具（项目对话才有，`AGENT_PROJECT_PROPOSALS` 并入 `AGENT_PROJECT_COMMANDS`；工具的中文说明写明“只提出，用户确认后才执行”）：

| 工具 | 输入（项目由任务提供） | 预览 | 确认后执行的所有者命令 |
| --- | --- | --- | --- |
| `proposal.delete` | `kind`（`whiteboard` / `mindmap` / `draft` / `roughcut`）、对象编号、可选的理由 | 对象类型与标题；内容规模（卡片、节点、版本、片段数）；被哪些笔记、白板、导图、文稿引用（`embed.backlinks`），删除后这些引用显示为已删除；“删除后不能撤销” | `<kind>.delete` |
| `proposal.rename` | `kind`（上面四种加 `project`）、对象编号、新标题 | 原标题 → 新标题；新标题与项目里同类对象重名时提示 | `<kind>.rename` / `project.update` |
| `proposal.exportProject` | 可选的理由 | 项目标题、材料与各类对象的数量、估计大小；“确认时选择保存位置” | `project.exportPackage`（`pathHandle` 由确认时的保存对话框给出） |
| `proposal.editRoughcut` | 粗剪编号、`label`、`actions`（与 `roughcut.edit` 相同，至多 200 步） | 每一步的中文说明（加入、移动、调整、删除、备注）；前后的片段数与总时长；在副本上试应用，失败的动作在提出时就拒绝 | `roughcut.edit`，撤销列表里标为 `Agent：<label>` |
| `proposal.exportRoughcut` | 粗剪编号、可选的文件名与选项 | `roughcut.plan` 的结果：请求区间与实际区间、问题逐项、输出时长；默认写进导出分区 | `roughcut.export`（进度与取消照旧） |

- 预览算出来就存进 `preview_json`；卡片只显示存下的预览，不再按模型的参数重算，确认时再核对对象没变（4.3）。
- 提议工具与其他项目命令一样过 `AgentRule`：别的项目的对象、不存在的对象、`kind` 与对象不符，都在提出时拒绝。
- 命令层仍拒绝 Agent 直接调用 `*.delete`、`*.rename`、`project.update`、`project.exportPackage`、`roughcut.edit`、`roughcut.export`（授权用例 AT-11、AT-85 加这些命令）。

### 4.3 确认、拒绝与失效（W3）

- **所有者命令。** `proposal.list { sessionId?, projectId?, status? }`、`proposal.apply { proposalId, pathHandle? }`、`proposal.reject { proposalId }`。三者只在 `OWNER_COMMANDS` 里，Agent 调用一律拒绝。
- **只执行一次。** `proposal.apply` 先用一条条件更新把 `pending` 改为 `applying`（改动行数不是 1 就返回“已经处理过”）；然后核对对象仍在、修订与 `target_json` 相同，不同就改为 `stale` 并说明；再经命令网关以所有者身份执行，幂等键是提议编号，操作日志记“Agent 提出、用户确认”与提议编号。网关异步处理后，同步删除、改名与粗剪编辑在所有者处理函数里再次核对，并把效果与成功回执一起提交。删除还核对反向引用，项目导出还核对包内内容与快照。成功为 `applied`、失败为 `failed`，`result_json` 存结果或分类原因。`failed` 不自动重试，用户可以让 Agent 再提一次。
- **中途退出。** 只有命令一致且成功的 `operations` 回执证明同步效果已执行；`command_requests` 只代表开始。项目包导出在发布前记录私有输出摘要，重启核对成品大小与哈希后可补回执；没有完成证据的提议回到 `pending`，不自动执行。粗剪的任务与回执一起登记，卡片在输出完成前保持 `applying`；取消、失败或重启后中断成为 `failed`。
- **导出要选位置。** `proposal.exportProject` 的确认先弹保存对话框，取消就什么都不做、提议仍待确认。
- **结果回到 Agent。** 下一次任务组装上下文时，在用户消息之前加一段“上次以来提议的结果”：类型、对象标题、结果与原因（不含预览全文），计入预算；只消费实际容纳的结果，在创建本轮任务的事务里标记，剩余留给后续轮次。同一条结果只带一次，重试沿用冻结的上下文。
- **其他变化。** 对象被用户删掉或改过时，卡片在列表刷新时显示为失效，不等用户点确认；对话被删除时提议一并删除。

### 4.4 对话里的提议卡片（W4）

- 卡片出现在提出它的那次回答下面（停靠栏与对话标签都显示），按提出的顺序排列。待确认时有“确认”“拒绝”；处理后显示结果与时间（“已执行 · 14:03”“已拒绝”“已失效：……”“执行失败：……”）。删除类的卡片在“确认”旁写“不能撤销”，确认按钮用危险样式。
- 同一次回答里有两条以上待确认的提议时，卡片组上方有“全部确认（N）”与“全部拒绝”；“全部确认”先弹一个列出全部变化的确认框，再逐条执行，每条各自记结果。执行清单固定为打开确认框时展示的卡片；之后到达的提议需要另外确认。一条失败不阻止其他条，取消目录选择保留该条待确认；选择器或命令错误在卡片旁显示。
- 对话列表是虚拟化的（上一阶段的 LOOP-07）：卡片是消息行的一部分，高度变化照旧由列表测量；贴底与跳转不受影响。
- 项目对象的侧栏不显示提议；只在对话里处理。

### 4.5 按任务加上的语义检索与网页抓取（W5）

- `AGENT_OPT_IN_COMMANDS` 改为 `["metadata.search", "semantic.search", "webpage.fetch"]`；契约 `allowCommands` 的枚举随之扩大、上限改为 3；运行的快照冻结它，重试沿用。
- 输入框的“本次任务”菜单（现在只有“联网搜索资料”）加两项：“语义检索”只在语义模块开启并配好 Embedding 连接时显示；“抓取网页”只在项目对话里显示（抓到的网页存为本项目的网页版本）。两项都写明会产生外部调用。
- `commands/agent.ts` 对每一项要求对应模块开启，并记进 `allowedNetworkCommands`；`semantic.search` 的范围与资料读取的范围相同（不因加上它而放宽），防剧透照旧。`webpage.fetch` 过 `AgentRule` 的项目范围。
- 测试只对假 Embedding 服务与回环地址上的假网页服务；真实调用仍受 ACT-05 约束。

### 4.6 窗口走查的条件等待（W6，LOOP-29）

- 逐个文件把 `sleep(n)` 换成等到条件满足：元素出现或消失（`waitForTestId`）、属性或文字改变、页面上的状态（`waitUntil`）、画出新的一帧（`requestAnimationFrame` 两次）。超时沿用各处现有的上限，等不到算失败，断言不变。
- 只保留必须按真实时间流逝的等待：播放推进、按住时长、去抖与节流的时间窗、动画时长。每一处在同一行或上一行写 `// real time: <原因>`。新增一个快速检查（单元用例或 verify 的一步）：`apps/desktop/src/main/smoke/` 里没有原因注释的 `sleep(` 为 0。
- 目标：`window-walk` ≤ 240 s（开发机，上一阶段约 7 分钟）；每个阶段的用时写进 `package.json` 的证据（已有就沿用）。三条曾偶发失败的观察（LOOP-27）的判断方式不变。
- 模型弹窗截图先滚动到“模型能力”一节再拍，确认截图里有三个上限的输入框。

### 4.7 测试的临时目录（W7，LOOP-28）

- `plugin-fixtures.ts` 的 `tmpDir()` 与 `tests/helpers/app.ts` 的临时目录改为建在 `global-temp.ts` 的全局测试临时根下（经它设置的环境变量），全局清理时一并删除；个别需要系统临时目录的用例自己删除。
- `stage test` 前后各数一次系统临时目录里 `manga-*` 的数量，多出的写进 `test-run.json` 并判为失败（与 `stage package` 的做法一致，失败时保留现场）。

### 4.8 命令与契约

- 新增命令：`proposal.delete`、`proposal.rename`、`proposal.exportProject`、`proposal.editRoughcut`、`proposal.exportRoughcut`（Agent，项目对话）；`proposal.list`、`proposal.apply`、`proposal.reject`（所有者）。契约在 `packages/contracts/src/`（新文件 `inputs-proposals.ts`），命令快照用例随之更新。
- 新的错误码：`PROPOSAL_DECIDED`（已处理过）、`PROPOSAL_STALE`（对象已改变）、`PROPOSAL_LIMIT`（待确认太多），各有中文说明。
- 会话流（`session.stream`）带上每条消息关联的提议，界面不另取；提议的状态变化发主机通知，列表按现有的方式刷新。

## 5. 工作包与顺序

### 5.1 C0 阶段开始的整理（先做）

按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)执行，结果写进报告的“整理记录”。

**A 已做（在本计划所在的提交里）：**

- 上一阶段的报告提炼后删除。仍有效的内容已经在正本里：门禁的做法在质量门禁第 2、3 节，验证基线在执行状态，LOOP-13、26、27 的结论在执行状态，ADR-0007 有自写与选型的理由。还没有正本的“从笔记跳到一条还没载入的消息没有产品入口”写成执行状态的 LOOP-30。入链改为归档链接 `https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-report.md#<锚点>`；文档导航与 GitBook 目录里去掉报告（B 新建后加回）。
- 登记表 `currentStage` 改为 `m9`，本计划的 `retireAfter` 改为 `m9`，报告的条目去掉。
- 新增 A-120、A-121；需求 AGENT-01、AGENT-03、AGENT-04 按本阶段改写；验收 AT-151—AT-156；交付路线 2.2 改为本阶段，上一阶段的能力并入 2.1；ACT-15 的完成写回用户待办与执行状态；新增 Q-37。
- 执行状态里 Agent 一行的运行时版本改为现用的 pi-ai 1.3.0。
- **2026-11-07 用户补充“路径不再使用大写的 manga，而是全部用小写的 manga”（A-118、A-119）：** A 已直接改好 `packages/app-core/src/locations.ts`、`packages/app-core/src/commands/settings.ts`、`apps/desktop/forge.config.ts`、`scripts/stage/*`、测试与文档正本：`<文档>\manga`（开发版 `manga-dev`）、`<下载>\manga`（开发版 `manga-dev`）、打包输出 `dist/desktop/packages/manga-win32-x64/manga.exe`、安装可执行文件 `manga.exe` / `manga-dev.exe` 全部小写，已有的大写 `MANGA` 文件夹在启动时自动改名为小写并修正指针与旧位置记录；B 保留这些改动，跑本阶段 `stage gate` 时一并重新生成包、安装包与 `ui-settings-locations.png` 截图。

**B 执行时再核对一遍：**

| 位置 | 内容判断 | 处理 |
| --- | --- | --- |
| `.env.local` | 开发者的本地配置与凭据，必需 | 保留；不读取与任务无关的值 |
| `dist/design-refs/`、`dist/tools/`、`dist/samples/` | 用户提供的界面参考、固定版本的工具、合成样本 | 原样保留；本阶段新增的样本按第 7 节生成 |
| `dist/desktop/`、`dist/installer/`（若有）、`dist/plugins/` | 上一阶段最后的打包产物与安装包 | 阶段末重新打包时覆盖 |
| `dist/keys/` | 第一方插件的签名私钥（ACT-08） | 原样保留，不读不输出 |
| `dist/evidence-runs/` | `current/`（上一阶段最后一次门禁）与推送前日志 | `current/` 在本阶段第一次门禁运行时覆盖；其余零散日志删除 |
| 系统临时目录里的 `manga-*` | 上一阶段测试留下的（LOOP-28） | 确认没有正在运行的门禁后删除，只记数量 |
| 上一阶段的本地分支 | 内容已全部合入 `main @ fd32430` | 保留，不由 Agent 删除 |
| `docs/evidence/gate/` | 上一阶段最后一次门禁的证据 | 本阶段最后一次门禁时整体替换 |

**去掉以前阶段的标签（A-57）。** 运行文档检查，把报出的 `M8` / `m8` 标签逐个改写。Git 提交信息与固定归档链接里的路径不改。

### 5.2 D1 依赖盘点

按 3.2 的表执行。实施开始与门禁之前各跑一次 `pnpm outdated -r`。ADR-0007 的版本表与例外表按结果更新。

### 5.3 工作包

| 包 | 内容 | 关键失败路径 | 验收 |
| --- | --- | --- | --- |
| W1 提议的存放 | 4.1：v14 的表与迁移、状态机、上限、随对话与项目删除 | 迁移中途强制结束后再启动能完成；迁移失败回滚、资料不变；v13 的应用拒绝打开 v14；第 21 条提议被拒绝且说明原因 | AT-156 |
| W2 五种提议 | 4.2：工具、预览、`AgentRule`、命令层拒绝直接调用 | 别的项目的对象；对象不存在；`kind` 与对象不符；粗剪动作在副本上失败；新标题为空或过长；“最近”的对话没有这些工具 | AT-151、AT-153、AT-154 |
| W3 确认与失效 | 4.3：`apply` / `reject` / `list`、原子消费、修订核对、幂等执行、启动时恢复 `applying`、下一轮的结果 | 同时点两次确认（或两个窗口）只执行一次；提议后对象被改或被删；执行失败；执行中退出；导出时取消保存对话框；拒绝后 Agent 下一轮看得到 | AT-152 |
| W4 提议卡片 | 4.4：卡片、全部确认与拒绝、危险样式、状态变化的刷新 | 卡片高度变化时贴底与锚点；对话很长时卡片在虚拟列表里；停靠栏与对话标签同时显示同一条提议，一边确认后另一边更新 | AT-151 |
| W5 按任务加上 | 4.5：枚举、界面两项、模块检查、范围 | 模块关着时不显示、命令层拒绝；“最近”的对话没有“抓取网页”；重试沿用；没加时工具不出现 | AT-155 |
| W6 条件等待 | 4.6：替换固定等待、`// real time` 注释与检查、截图滚动 | 条件写错导致假通过：每处替换后的条件要能在失败时超时（B 抽查：故意改坏一个元素，看到对应观察失败）；阶段用时 | `window-walk` 用时；检查 |
| W7 测试临时目录 | 4.7 | 并行的测试进程共用全局根时不互删；失败时保留现场 | `test-run.json` |
| W8 走查、测试与基准 | 见第 7 节；改写依赖旧结构的测试（命令清单快照、`allowCommands` 的枚举、`sleep` 的走查），断言不减，迁移映射写进报告 | — | 第 7 节 |
| W9 文档 | 需求 AGENT-01、03、04 按实现改为“已实现”；交付路线 AT-151—AT-156 在实现后改为“已实现”；领域模型（提议表、状态）；数据与安全（v14 迁移、提议不进项目包）；Agent 与插件协议（提议工具、按任务加上的三项、所有者命令）；交互设计（提议卡片、“本次任务”菜单）；质量门禁（条件等待的规则与检查、测试的临时目录计数）；ADR-0007（版本表、自写的理由）；执行状态（LOOP-09、28、29 的状态） | — | 文档检查 |

### 5.4 顺序

1. C0；D1 的第一次盘点与已满 14 天的升级（pi-ai 1.4.0、react-virtual 3.14.22、linkedom 0.18.14）。
2. **W7 → W6 先做**：门禁变快后，后面每次验证都省时间。W6 改完先单独跑 `window-walk`（`MANGA_PACKAGE_PHASES` 与 `MANGA_PACKAGE_REUSE_BUILD`），确认通过与用时。
3. W1 → W2 → W3 → W4（依次依赖）。
4. W5（与 W1—W4 独立，可以穿插）。
5. W8、W9；最后一次 `pnpm outdated -r` 与满 14 天的升级；`stage gate`；报告与整理记录。

可以按依赖调整顺序，但不得跳过任何一个工作包。

## 6. 界面要点

- 视觉沿用现有主题；提议卡片用现有的卡片、按钮与危险按钮样式，深浅主题都要有。
- 卡片标题是动词加对象（“删除白板《旧分镜》”“重命名导图：《结构》→《第二季结构》”“导出项目包”“调整粗剪《预告》：5 步”“导出粗剪《预告》”）；正文是预览的几行，引用多于 5 处时折叠为“还有 N 处”。
- 待确认的卡片在对话里醒目但不打断：不弹窗、不抢焦点；“全部确认”才弹确认框。
- “本次任务”菜单里的三项是复选，写明“会联网”“会调用 Embedding 服务”；勾上的项在输入框下方以小标签显示，发出后清空（与现在的“联网”一致）。
- 所有新控件有可访问名称；卡片的按钮可以用键盘操作，结果的变化对读屏软件可见。

## 7. 样本、门禁与基准

**样本。** 全部合成：沿用 `dist/samples/` 与现有的规模样本；补：一个项目，含 3 块白板（其中一块被笔记与导图引用）、2 张导图、2 篇文稿与一个 12 段的粗剪；一份 v13 资料（含几次对话与运行）用来迁移；假 Embedding 服务与回环地址上的假网页服务沿用已有的。

**窗口观察（打包烟测，新增，必需）：**

| 观察 | 内容 |
| --- | --- |
| `proposal-delete-rename` | 假模型在项目对话里依次调用删除白板（有引用的那块）与重命名导图：两张卡片出现，删除卡片列出引用并写“不能撤销”；数据库与侧栏都没变；确认删除 → 白板消失、引用显示为已删除、卡片显示已执行；拒绝重命名 → 导图名不变；下一轮请求里带有两条结果 |
| `proposal-stale-once` | 提议删除一篇文稿后在文稿里改一个字，再确认：显示已失效、文稿还在；另一条提议在停靠栏与对话标签里同时点确认：只执行一次，两边都显示已执行 |
| `proposal-roughcut` | 假模型提出 5 步的粗剪编辑：卡片列出 5 步与前后时长；确认后粗剪变化、撤销列表里有 `Agent：` 的一步，撤销后复原；再提出导出：卡片显示导出计划，确认后产出文件并通过输出校验 |
| `proposal-export-project` | 提出导出项目包：确认后（走查给保存对话框一个临时路径）导出完成，包与所有者导出的同一项目内容一致；再提一次，保存对话框取消，提议仍待确认 |
| `proposal-restart` | 一条待确认、一条模拟执行中（在 `applying` 状态结束进程）后重启：待确认的仍可确认；执行中的按回执判为已执行或回到待确认 |
| `agent-opt-in` | 项目对话里只勾“抓取网页”发起任务：工具清单里有 `webpage.fetch`、没有 `semantic.search`，抓到假网页并存为网页版本；下一次任务不勾，工具清单里没有它；语义模块开启时勾“语义检索”，对假 Embedding 服务检索成功；“最近”的对话里看不到“抓取网页” |
| `migrate-v14` | 用 v13 资料启动：迁移前有备份，迁移后提议表存在、其余数据不变；第二次启动不再改动；较旧版本拒绝打开 |

上一阶段全部的窗口观察保留，W6 改为条件等待后全部重跑；`hold-rate-hint-only`、`hold-rate-recovers`、`frame-window-controls` 的判断方式不变。

截图只留关键状态：对话里的删除提议卡片（待确认，浅色与深色各一张）、处理后的卡片组、“本次任务”菜单、模型弹窗的“模型能力”一节。截图不含本机路径。

**基准（新增门槛）：**

| 指标 | 门槛 |
| --- | --- |
| 提出一条删除提议（含引用查询与预览，项目有 500 个对象），p95 | ≤ 150 ms |
| 确认一条提议到对象与卡片都更新，p95 | ≤ 300 ms |

记录项（不设门槛）：`window-walk` 与每次 `stage package` 的用时（替换前后对照）；v13 → v14 迁移的耗时；一次完整 `stage gate` 的用时。

现有门槛与观察全部保留，目标与测量方法不改。跑基准前确认机器空闲、启动它的应用在前台（[LOOP-13](status.md#loop-13)）；跑的过程中不执行改动工作树的 git 命令；不锁屏（走查要用剪贴板）。

**门禁。** 修复先用子集确认（`MANGA_PACKAGE_PHASES` 与 `MANGA_PACKAGE_REUSE_BUILD`、单个测试文件），最后在最终源码上跑一次 `node scripts/stage.mjs gate`（verify、test、package 连续三次、installer、bench、report 都通过）；门禁运行时不改工作树。证据整体替换 `docs/evidence/gate/`，总量不超过 5 MiB，复制前先看过新截图，不含本机路径。

## 8. 人工检查

B 在用户待办里新增人工检查（编号从 H-88 起），写到用户能直接照做：在一个项目里让 Agent 删除一块旧白板并重命名一张导图，看卡片写清的变化，拒绝一条、确认一条，再问 Agent 刚才的结果；提议后自己改动那个对象再确认，看到“已失效”；让 Agent 调整粗剪，确认后在粗剪里撤销；让 Agent 导出项目包，确认时选位置；发起任务时勾“抓取网页”（需要能联网的模型连接与网页）；感受一次 `stage package` 变快不需要人工检查。已有 H 项里受影响的（对话列表、项目对象的删除与改名）只在说法变了时改文字。人工检查保持 not-run，不由脚本代填。

## 9. B 交付与 A 审查

- B 新建本阶段报告 `docs/delivery/stage-report.md`（并加回登记表、`docs/README.md` 与 `docs/SUMMARY.md`）：按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射；写明提议的状态机与原子消费的实现、修订核对用的字段、启动时恢复的判断、五种提议的预览内容、v14 迁移、`sleep` 替换前后的数量与用时（逐文件）、保留的真实时间等待及原因、测试临时目录的计数、迁移映射（测试与走查）、依赖盘点结果、整理记录（含临时目录的数量）、基准数值与源码指纹。
- B 交付前自检：第 1 节的退出条件逐条有证据；`stage gate` 通过；文档检查通过；暂存内容核对过；一个带 DCO 签名的阶段提交（amend 本计划所在的提交，消息按最终结果重写）。
- A 审查时重点看：Agent 的任何路径都不能不经确认执行删除、重命名、导出与粗剪编辑（工具清单、命令层、所有者命令的操作者核对）；`apply` 的原子消费与幂等键；修订核对没有漏掉的对象类型；启动时对 `applying` 的判断；拒绝与失效的结果确实进入下一轮、只带一次；删除对话与项目时提议一并删除；按任务加上的三项不放宽资料范围、模块关着时命令层拒绝；条件等待没有放宽任何断言、超时能真的失败，保留的 `sleep` 都有原因；测试临时目录的清理不误删并行进程的目录。

## 10. 待处理事项入口

- 需要用户的：[Q-37](../../USER-ACTIONS.md#q-37)（本阶段 Agent 先用的默认值）；仍待答复的 [Q-36](../../USER-ACTIONS.md#q-36)、[Q-35](../../USER-ACTIONS.md#q-35)、[Q-33](../../USER-ACTIONS.md#q-33)；可选的 [ACT-14](../../USER-ACTIONS.md#act-14)、[ACT-11](../../USER-ACTIONS.md#act-11)。都不阻塞本阶段。
- 顺延的 Agent 侧后续项：LOOP-17 里的音频输入与 PDF 按页截取、LOOP-16（弹幕密度曲线）、LOOP-18（截图候选栏）、LOOP-21（弹幕搜索偶发无响应）、LOOP-30（跳到一条还没载入的消息的入口），留在[执行状态的后续 loop](status.md#followup-loops)。
- 本阶段发现的非阻塞问题按开发流程新增 LOOP 条目，不扩大本阶段范围。

<a id="prompt"></a>
## 11. 交给 B 的执行 prompt

```text
你是 Agent B，在本仓库的分支 feat/m9-next 上连续完成当前阶段（Agent 的待审操作与门禁提速）。

依据：AGENTS.md；docs/delivery/stage-plan.md（本阶段唯一计划，全部工作包 C0、D1、W1—W9）；确认记录 A-74、A-120、A-121；需求 AGENT-01、AGENT-03、AGENT-04、DATA-01；验收 AT-151—AT-156 与计划第 1 节列出的重跑用例（AT-11、AT-13、AT-44、AT-85、AT-129）；执行状态的 LOOP-09、28、29；用户待办 Q-37（按其中的默认实现；用户答复后以答复为准）。

要求：
1. 先核对现场（git status、分支基于 main@fd32430、计划所在的提交，保留 A 已完成的路径全小写改动），再按计划第 5.4 节的顺序连续实施，不逐工作包询问。W7、W6 先做，让后面的验证变快。
2. 依赖按计划 3.2 处理：取实施当天满 14 天的最新精确版本，不绕过最小发行龄；升级失败就回退，并在 ADR-0007 写明尝试的版本、失败的命令、上游限制与复查条件。
3. 待审操作按计划 4.1—4.4：Agent 只能写提议，任何路径都不能不经用户确认执行删除、重命名、导出与粗剪编辑；确认用条件更新原子消费、核对对象修订、以提议编号为幂等键经所有者命令执行；启动时恢复 applying 的提议；拒绝与失效的结果在下一轮上下文里只带一次。
4. schema v14 迁移按数据与安全规则：迁移前备份、失败回滚、中断后可继续、较旧版本拒绝打开，并有测试。
5. 按任务加上的语义检索与网页抓取（计划 4.5）不放宽资料范围，模块关着时命令层拒绝；只对假 Embedding 服务与回环地址上的假网页服务测试。
6. W6 把窗口走查的固定等待换成条件等待，断言与门槛不变；只保留按真实时间流逝的等待并写 // real time: 原因；加检查保证没有原因的 sleep( 为 0；抽查条件能真的超时失败。window-walk 目标 ≤ 240 s。模型弹窗截图先滚到“模型能力”。
7. W7 让测试的临时目录都在全局测试临时根下并被清理；stage test 前后计数，多出的判失败。
8. 改写测试与走查时断言不减；删除的断言在迁移映射里写明由什么替代。
9. 只用合成样本；不发真实模型、Embedding、网页、弹弹play、Bangumi 请求；真实资源库只读试验可选，只记聚合，不写名称与路径。
10. 修复先用子集确认（MANGA_PACKAGE_PHASES + MANGA_PACKAGE_REUSE_BUILD、单个测试文件）；最后在最终源码上跑一次 node scripts/stage.mjs gate（跑前确认机器空闲、启动它的应用在前台，不锁屏；跑的过程中不改工作树、不执行改动工作树的 git 命令）；证据替换 docs/evidence/gate/（≤ 5 MiB，截图不含本机路径，复制前先看过新截图）。
11. 新建本阶段报告 docs/delivery/stage-report.md（计划第 9 节，并加回登记表、docs/README.md 与 docs/SUMMARY.md），更新用户待办的人工检查（计划第 8 节，从 H-88 起）、执行状态与各正本；把全部改动 amend 进本阶段唯一的 DCO 签名提交，消息按最终结果写。不 push。
12. 结束时按开发流程 2.4 给出首选下一步：推荐交给 A 集中审查，并附审查 prompt。
```
