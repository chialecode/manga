# Agent 模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.agent` / Agent / 开发者 |
| 文档状态 / 实现状态 | 会话/运行循环、即时 runId、材料快照、持久消息/工具检查点、同 run 重试与双 runtime 已接线；停靠栏是聊天窗口、对话标签没有停靠栏、上下文调试面板、快捷任务模板与使用记录（A-47、A-48、A-52）已实现并自检（见[执行状态](../delivery/status.md)）；对话记录可以在设置里删除（A-89）、模型的添加与编辑在弹窗里（A-90）已实现并自检；技能与完整阅读上下文待实现；产品验收为 not-run |
| 需求 / 设计依据 | AGENT-01—07、MODEL-01、MODEL-04、MODEL-05、AT-49/50、AT-95—AT-97 |
| 包与公开入口 | `packages/app-core`、`packages/model-protocol`；`agent.createSession`、`agent.send`、`agent.cancel`、`agent.retry`、`agent.getRun`；另有 `session.stream`、`debug.context`、`quickTasks.list/save/delete/reorder/restore`、`usage.query`（契约见 `packages/contracts/src/inputs-workspace.ts`） |

## 1. 责任与依赖

拥有会话、运行、工具证据和预算。工具只来自当前启用且授权的命令，工具输入 schema 由命令契约生成（不允许额外字段）。主页面与副驾驶共享同一会话服务。依赖 library；无连接时仍可使用已交付本地命令。

**创作命令（A-73）。** 只有项目上下文里的项目对话（任务带 `projectId`）得到项目范围内的创作命令（`packages/app-core/src/creative/agent-access.ts`）：读取 `project.list/get/objects/terms`、`whiteboard.list/get`、`mindmap.list/get`、`draft.list/get/version`、`roughcut.list/get`、`research.search`（本地资料）、`excerpt.list/get`、`webpage.list/get`；可撤销的写入 `whiteboard.edit`、`mindmap.edit`、`project.addMaterial`、`project.addTerm`、`draft.suggest`（只写成建议，作者记为 Agent，采纳由用户做）。命令层按任务所属项目校验：命名了别的项目、或对象不属于本项目的调用被拒绝（`SCOPE_DENIED`），不只是不在工具清单里；项目参数不向模型暴露。Agent 对白板与导图的一次编辑是撤销列表里一步标为“Agent：…”的操作，白板与导图编辑、添加术语记入操作日志；返回给模型的结果截到 8000 字符。删除、重命名、项目包导入导出、粗剪的编辑与导出、语义检索（会调用付费的外部服务）、网页抓取、插件与下载仍是所有者命令；“最近”里的对话与资源、作品、笔记的对话没有项目命令。AT-85 守护。

## 2. 数据与公开能力

AgentRun 固定会话、grant、材料修订快照、冻结 runtime、会话历史、连接与预算；`agent.send` 立即返回当前 `runId`，完成态经 `agent.getRun` 轮询，流式文字写入 `live_text`。任务 grant 只含用户勾选的可读材料，不附带资源写权限，Agent 只能改自己创建的笔记。已执行工具按同一 run 的命令回执恢复，重试不得因模型改参数再生成一条副作用。截止时间与已用步数跨恢复保持。无报价不写假费用。取消只作用于未结束的运行。

媒体材料（漫画区域图、视频帧、字幕窗口、转写、资源库摘要）在发送时冻结进 run 快照。图像按预算重编码为 JPEG：每任务 ≤ 4 张、每张 ≤ 1.5 MB、合计 ≤ 4 MB，字节保存在 `agent_runs.snapshot_json`，使重试与恢复发送同一画面；会话与运行列表不读取快照字段，对外的 run 详情去掉图像字节，资料包不导出运行记录，完整备份按数据库原样包含。改为附件引用并给历史图像定保留期记为 [LOOP-05](../delivery/status.md#loop-05)。

### 模型配置、上下文预算与调用追踪（A-82、A-83）

- **模型配置：** `provider_connections.profile_json` 保存每个模型的配置（`ModelProfile`）：上下文窗口、最大输出、输入类型（文本/图片/视频/PDF/音频）、能力（工具调用/结构化输出/原生联网搜索/推理）、推理等级；默认保守（128k/8k，文本与工具调用）。命令 `connections.setProfile` 保存；`connections.probe` 做测试连接，逐项探测并写入 `last_test_json`。推理等级按协议映射：Chat Completions 的 `reasoning_effort`、Responses 的 `reasoning.effort`，不支持时不发送。
- **删除对话（A-89，AT-103）：** `conversation.list`（按项目、类型、时间筛选与标题搜索，分页）、`conversation.delete`（一个或多个会话，最多 500 个）与 `conversation.deleteAll`（可带同一组筛选）只给所有者，不在 Agent 的命令表里。`app-core/src/conversations.ts` 在一个事务里删除会话，连同它的运行、消息、工具事件、调用追踪（`agent_requests`）、检查点、冻结的材料、关闭会话的记录，以及语义索引里来自这些会话的片段；不删 Agent 写下的笔记、白板、导图与文稿等内容对象，也不删用户的笔记、录音、书签与进度。有任务还在进行的会话不删，结果里列出它们；停靠栏正显示被删的对话时，渲染进程换成新对话，历史列表同步（`tests/creative/conversation-delete.test.ts`、`tests/shell/conversation-records-ui.test.tsx`）。迁移前自动复制的数据库副本（`manga.sqlite.premigrate-v<版本>`）里仍有当时的对话：副本是升级当时的完整库（只去掉调用追踪），删除对话不改动它，页面如实写明。
- **测试连接：** 成功时写延迟、模型回复的前几个字与探测到的窗口等能力，失败分类为密钥被拒、地址不对、模型不存在、超时、限流、协议不符，各有中文原因与解决办法；服务返回的正文不会进入结果（`model-probe.ts`）。
- **上下文预算：** `agent-context.ts`。按 Token 计：可用 = 窗口 − 最大输出 − 余量（窗口的 5%，至少 4k）。估算不用模型自己的分词器且偏高，服务报告过用量后按其比例修正；图片按固定 Token 计。超出时先把旧的工具结果截成摘要，再把较早的对话压缩成一条摘要消息（用同一连接，算一次模型请求，记入调用追踪）；连续压缩失败 3 次才报错并给出办法。PI 与自研两个运行时共用同一套预算与压缩。
- **任务限制：** 步数与时长上限在“设置 › 智能体”（`agent-settings.ts`，默认 24 步、10 分钟）。
- **调用追踪：** `agent-trace.ts` 的 `AgentTrace` 在两个运行时共用的提供者适配层记录每次模型请求、工具调用与压缩，写入 `agent_requests`：请求与响应脱敏后压缩保存，每部分最多 256 KiB（超出时存一个说明了截断的 JSON 对象，原大小保留），图片只记媒体类型、字节数、尺寸与短指纹；字段名像密钥的值整个抹去，连接的密钥原文、认证头、令牌形状的文字与本机路径不会出现。可以改为只记大小、时间与状态。命令 `agent.trace.list/get/export/stats/clear`（仅所有者，归设置模块），任务限制与追踪设置经 `settings.getAgent`/`settings.setAgent`；时间线在“设置 › 使用记录”与对话回复的“查看调用记录”。写记录失败不影响任务；进程中断时仍在运行的请求在下次启动标为错误。保留 30 天、最多 500 MB，在启动时、每次任务结束后和改设置时清理；只存本机，不进备份（迁移前的数据库副本也先去掉它）与资料包。

## 3. Agent 与界面

来源正文中的指令不能授予权限。模型不能填写 actor、scopeHandle 或磁盘路径。

**聊天窗口（A-48）。** 停靠栏是当前会话的对话记录：`session.stream` 把该会话的笔记气泡、语音气泡、用户消息与 Agent 消息按时间合并（渲染端每页 200 条）；输入框含引用标签行（选区、漫画区域、视频时间点或 A-B 区间）、“笔记/问 Agent”切换（只在打开的资源与作品主页出现；书架等没有归属的页面只问 Agent，不改动记住的选择）、麦克风、附件与“+”菜单、发送。材料、字幕范围、联网等选项在“+”菜单与材料对话框里；发送失败时输入不丢，Agent 运行中仍可记笔记，附件不因运行中而禁用。停靠栏收起时留下悬浮胶囊，可记笔记与录音（没有归属的页面只有麦克风）。对话页不显示停靠栏：消息流与输入框居中，对话列表在左栏下部。没有模型连接时显示“尚未配置模型”并仍可记笔记。

**上下文调试面板。** 标题栏按钮与快捷键在主面板下方打开，页签为当前、上次任务、事件、复制 JSON；高度可调（120—640 px），开合状态按会话保存在本地。内容来自 `debug.context`（模型、工具、预算、上次运行）和已冻结的快照，不另造一份；复制时由 `redactForDebug` 二次处理：凭据与令牌键值、`data:` 图像与大块二进制只保留字符数与短哈希，本机路径已由主进程去掉。面板打开不改变阅读器的尺寸测量。

**快捷任务（A-52）。** 设置的“快捷任务”页管理模板（新建、编辑、复制、删除、排序、启用/停用、恢复默认）；原先写死的任务迁移为可修改的内置默认。占位符：`{{作品}}`、`{{作者}}`、`{{当前位置}}`、`{{选区}}`、`{{字幕窗口}}`、`{{用户输入}}`，未知占位符保存时拒绝，当前页面没有对应内容时渲染为空并在消息里说明；模板不能改变工具授权或材料范围。每个标签按适用页面始终列出，发送时渲染为可见的用户消息并带“快捷任务”标记。

**使用记录。** 每次运行把模型、输入/输出令牌、耗时与结果写进运行记录（`agent_runs` 的 `model_id`、`input_tokens`、`output_tokens`、`duration_ms`），服务没有给出的显示“未提供”，旧运行显示“未记录”；设置的“使用记录”页按日期与模型汇总，转写任务显示音频时长。

## 4. 生命周期与兼容

停用中止运行并撤销 UI/工具。替换连接不改变命令协议。

## 5. 验证与未决

AT-09/11/12/13/44/49/50 的子场景（`tests/agent/loop.test.ts`、`protocol-faults.test.ts`，`tests/runtime/grants-package-inventory.test.ts`、`location-ownership-idempotency.test.ts`）。真实 API 契约按独立用途读取忽略的本地配置，普通 CI 不联网。A-22 自研/PI 双 runtime 已接入 `completeText`/`streamText`，设置可切换，运行中冻结。不得因子场景通过宣称模块或产品验收完成。AT-64、AT-66、AT-67 与 AT-54/58/59 的结果见[执行状态](../delivery/status.md)；调试面板脱敏、快捷任务渲染与校验、使用记录写入分别有单元测试，打包烟测 `window-walk` 阶段走过聊天窗口、调试面板与快捷任务。

`getRun` 返回用户输入、消息检查点与 live text；App 刷新恢复当前 run；重试从已执行工具回执续作。
