# 文案模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.copywriting` / 文案 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；真实模型调用 not-run，生成走受控提供者验证（[ACT-05](../../USER-ACTIONS.md#act-05)） |
| 需求 / 设计依据 | CRE-05、AT-29；[领域模型](../design/domain-model.md)、[Agent 与插件协议](../design/agent-and-plugins.md) |
| 包与公开入口 | `packages/app-core/src/creative/drafts.ts`；命令 `draft.list`、`create`、`get`、`rename`、`delete`、`save`、`checkpoint`、`version`、`restore`、`suggest`、`suggestions`、`suggestion`、`cancelSuggestion`、`adopt`、`undoAdopt`、`discardSuggestion`、`keepSuggestion`；界面 `apps/desktop/src/renderer/pages/projects/copy/` |

## 1. 责任与依赖

拥有文稿（带版本历史的文字）和为它生成的建议。不拥有被引用的材料：建议只引用笔记、摘录、其他文稿、导图、白板、录音转写与项目术语表（`DRAFT_SOURCE_KINDS`），并记下写建议时它们的样子。

Feature `copywriting`；Facet `service`/`ui`；硬依赖 `manga.library`、`manga.projects`。生成通过文本模型端口（项目选了文本连接时用它，否则用默认文本连接），只用文本连接，用途隔离见 MODEL-02。没有文本连接时文稿的编辑、版本与恢复照常可用，生成入口说明缺少连接。

## 2. 数据与公开能力

- 数据：`drafts`（标题、当前文本、版本号、所属项目）、`draft_versions`（每次保存或检查点一行，带标签；超过 100 条时先清掉没有标签的最旧版本，当前版本和有标签的保留）、`draft_suggestions`（种类、指令、状态、基于的版本与原文、结果、依据快照、模型信息、采纳到的版本）。文稿最多 2000 个，文本最长 20 万字，建议每稿最多 200 条，同一文稿同时进行的最多 3 条。
- 保存带 `expectedVersion`，版本不符以 `REVISION_CONFLICT` 拒绝，不覆盖别处的修改；`draft.checkpoint` 给当前版本加标签；`draft.restore` 恢复旧版本并把恢复前的文本存成版本。
- 建议种类：`outline`（提纲）、`continue`（续写）、`polish`（润色）、`translate`（翻译）、`terms`（按术语表改写）、`cite`（引用材料生成）；可限定在文稿的一个范围。状态：`running`、`pending`、`failed`、`cancelled`、`adopted`、`discarded`。建议在后台生成，与文稿分开保存，显示为与基础文本的差异；应用启动时仍标为 `running` 的建议（上次运行中断）改标为 `failed`，不留下“永远在跑”的行。
- 采纳（`draft.adopt`）：文稿在建议之后被改过时先要求确认（`REVISION_CONFLICT`，`reason: draftChanged`），采纳前把当前文本存成版本；`draft.undoAdopt` 回到采纳前的版本。引用的内容与生成的内容分开显示，生成的文字不冒充原文。
- 依据变化：每份依据存哈希；之后任一依据被改动、删除或所属模块被关闭，建议的依据状态为 `changed`、`missing` 或 `disabled`，界面并排给出新旧，用户选择保留（`draft.keepSuggestion`）或重新生成。

## 3. Agent 与界面

命令在同一个网关注册，界面经这一入口调用。Agent 在本项目的会话里可以读（`draft.list/get/version`），并用 `draft.suggest` 写一条建议（作者记为 Agent，不调用模型、不带引用依据；界面显示“由 Agent 写成，采纳前不会改动文稿”）；保存、采纳、撤销采纳与删除仍由用户做，建议先成为待审的差异，不直接改文稿（A-73）。跨项目的调用在命令层被拒绝（`creative/agent-access.ts`），不只是不在工具清单里；娱乐模式的全局对话与资源会话没有这些命令；仍只由所有者操作的部分登记在[执行状态](../delivery/status.md#loop-09)。界面里的建议先成为待审的差异，不直接改文稿。界面：项目页的“文稿”标签，左侧文稿列表，右侧编辑区（Tiptap 的段落文档，带自己的撤销历史）、版本列表、建议面板（选种类与依据，进度，差异，采纳、放弃、保留、重做）。差异按词标出增删；两段文本合计超过 6 万字或 1.5 秒内算不完时，只显示“太长，无法比较”，仍可采纳或放弃。

## 4. 生命周期与兼容

停用：文稿、版本与已有建议保留可读，入口撤销；重新启用后恢复。文稿随项目包与资料包往返；模型信息只含连接与模型名，不含密钥。迁移前自动备份，失败回滚。

## 5. 验证与未决

自动：`tests/creative/drafts.test.ts`、`tests/shell/draft-ui.test.tsx`（AT-29），生成用受控提供者，未发出真实调用。窗口：`creative-draft`（建文稿、保存、版本）。限制：差异按词，不做语义对齐；翻译与改写不检查事实；真实模型的质量与费用未验证；Q-23 里其他语音功能与本模块无关。
