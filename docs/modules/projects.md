# 项目模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.projects` / 项目 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；人工检查见[用户待办](../../USER-ACTIONS.md#checks) |
| 需求 / 设计依据 | CRE-01、UI-07、DATA-03、AT-25、AT-87；[领域模型](../design/domain-model.md)、[交互设计](../design/interaction-and-workflows.md) |
| 包与公开入口 | `packages/app-core/src/creative/projects.ts`、`objects.ts`、`project-package.ts`、`bundle.ts`、`library-section.ts`；命令 `project.list`、`create`、`get`、`update`、`delete`、`addMaterial`、`objects`、`removeMaterial`、`terms`、`addTerm`、`updateTerm`、`removeTerm`、`importTerms`、`exportPackage`、`packagePreview`、`importPackage`；界面 `apps/desktop/src/renderer/pages/projects/` |

## 1. 责任与依赖

拥有项目（名称、目标、状态、可选的文本连接覆盖）、项目对材料的引用、项目术语表，以及“项目会话只在项目范围内读写”的范围规则。不拥有被引用的作品、资源、笔记、录音、摘录和白板、导图、文稿、粗剪（它们归各自的模块），也不拥有会话本身（归 Agent 模块）。

Feature `projects`；Facet `service`/`ui`；硬依赖 `manga.library`。创作各模块（白板、导图、文案、粗剪）声明对本模块的硬依赖：关闭项目会被计划器拒绝，直到依赖它的模块先关闭。所有创作命令只给所有者授权，写入命令在只读状态下被拒。无 AI 时项目、材料和术语表完全可用；没有文本连接时会话入口显示缺少连接。

**范围规则。** 一个项目、一个模式、一个对话；项目会话能读写的资源与笔记，由项目持有的材料和它拥有的对象推出（`scopeResourceIds`、`scopeNoteIds`）。切换项目不扩大授权，模型覆盖只对该项目的会话生效，可退回默认连接。

## 2. 数据与公开能力

- 数据：`projects`、`project_materials`（`kind` 取自对象种类：作品、资源、锚点、笔记、录音、摘录、白板、导图、文稿、粗剪、网页版本；只存引用与标签）、`project_terms`（术语、“听成”的写法、备注；与语音词典分开，可从作品词典一键导入）、`agent_sessions.project_id`。删除项目移除它拥有的对象与材料引用、术语，保留会话记录，不触及被引用的个人数据；确认文案说明这一点。
- 引用状态：`project.objects` 对每个引用报告 `ok`、`missing`（目标已不存在）、`disabled`（拥有它的模块已关闭）；界面显示占位并保留行，不静默丢掉。
- 项目包（`project.exportPackage` / `packagePreview` / `importPackage`）：zip，格式 `manga-project-package-v1`，清单列出每个文件的大小与 SHA-256，另含项目的各表（JSON）与每份被引用个人材料的可读快照；资源库本身不进包。上限：单文件 128 MiB、单条 32 MiB、总计 128 MiB、5000 条。导入先预览：校验格式、版本（来自更新数据版本的包不读）、哈希、大小、条数与表结构，任何一项不符在写入前拒绝；导入为副本，Profile 里已有同 ID 时重映射 ID，引用、互嵌与来源随之重映射。导出与导入只通过用户在宿主对话框里选的路径句柄。
- 整库资料包：`DATA-01` 的资料包携带每个项目的同一份 bundle，以及不属于任何项目的网页版本与摘录；会话、撤销历史与检索索引不携带，索引重建。
- 迁移：schema v9 只增加；旧的作品术语并入语音词典（手写词条），旧会话保留。

### 项目总览（A-77）

项目总览是主页视图里“项目总览”入口打开的标签（`pages/projects/project-overview.tsx`）：最近的项目及其材料、白板、导图、文稿、粗剪的数量与最后编辑时间，最近编辑的对象，待采纳的文稿建议，以及“新建项目”。数据来自命令 `project.overview`（聚合现有各对象的计数与更新时间），不新增表。

## 3. Agent 与界面

项目会话只在项目的材料范围内读写资料，授权与模型覆盖遵守项目范围；命令在同一个网关注册，界面经这一入口调用。项目上下文里的项目对话中，Agent 可以读取本项目（`project.list/get/objects/terms`），并做两项可撤销的写入：`project.addMaterial` 与 `project.addTerm`（执行者记为 Agent，术语写入进操作日志）；创建、更新、删除、移除材料、术语的改删与导入、项目包的导出与导入仍是所有者命令（A-73）。跨项目的调用在命令层被拒绝（`creative/agent-access.ts`），不只是不在工具清单里；“最近”里的对话与资源、作品、笔记的对话没有这些命令；仍只由所有者操作的部分登记在[执行状态](../delivery/status.md#loop-09)。创作模式的左栏列项目会话（有项目的在前，不属于项目的对话在后）；项目页含材料、白板、导图、文稿、摘录、粗剪、术语、设置各标签，关闭的模块对应标签不出现，材料里指向关闭模块的行显示“模块已关闭”。项目页的新建与重命名可用键盘完成，窗口在宽、窄、矮三种尺寸下无横向溢出（窗口观察 `creative-fit-*`）。从作品或笔记页可把条目加入项目，也可当场新建项目。

## 4. 生命周期与兼容

停用（受依赖约束）：项目数据保留；创作入口撤销；已有项目包与资料包仍可导出。项目在另一处被删除时，打开中的页面说明项目不存在而不是报错。旧版本的包或来自更新数据版本的包不被读取；未知字段由校验拒绝。迁移前自动备份，失败回滚。

## 5. 验证与未决

自动：`tests/creative/projects.test.ts`、`project-package.test.ts`、`library-package-creative.test.ts`、`tests/shell/projects-ui.test.tsx`、`project-package-ui.test.tsx`、`tests/library/schema-v9-migration.test.ts`，对应 AT-25、AT-28 往返部分；窗口观察 `creative-reach-projects`、`creative-project-tabs`、`creative-project-package`。人工检查与已知限制见[执行状态](../delivery/status.md)与[用户待办](../../USER-ACTIONS.md#checks)。未决：项目包是否可选择附带媒体（需求允许，目前不附带，只带可读快照）。
