# 白板模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.whiteboard` / 白板 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；手感检查见[用户待办](../../USER-ACTIONS.md#checks) |
| 需求 / 设计依据 | CRE-02、CRE-04、AT-26；[领域模型](../design/domain-model.md)、[交互设计](../design/interaction-and-workflows.md) |
| 包与公开入口 | `packages/app-core/src/creative/whiteboard.ts`、`ops.ts`、`sort-key.ts`；命令 `whiteboard.list`、`create`、`get`、`rename`、`delete`、`edit`、`setViewport`、`undo`、`redo`；界面 `apps/desktop/src/renderer/pages/projects/canvas/` |

## 1. 责任与依赖

拥有白板文档：节点、连线、分组与视口，以及每块白板自己的撤销与重做历史。不拥有被引用的对象：引用实例只保存目标对象的种类与 ID、局部定位和自己的位置，源内容在源对象里编辑，多个实例随之一致，移动一个实例不影响其他实例。

Feature `whiteboard`；Facet `service`/`ui`；硬依赖 `manga.library`、`manga.projects`。白板不依赖导图或文案；互嵌由 `manga.embeds` 提供。渲染用 `@xyflow/react`（MIT）：卡片是 React 组件，平移缩放、框选、连线交给它；数据模型、撤销与持久化由 MANGA 自己维护，React Flow 的节点只是视图。无 AI 与无连接时完全可用。

## 2. 数据与公开能力

- 数据：`whiteboards`（标题、视口 JSON、所属项目）、`whiteboard_nodes`（种类 `text`、`card`、`ref`、`group`；位置、尺寸、内容、父分组、层序）、`whiteboard_edges`（端点、标签）。引用实例同步到互嵌关系（`embeds`，见[互嵌模块](embeds.md)），反向链接据此查询。
- `whiteboard.edit` 接受一个步骤列表，一次调用是一次撤销：`addNode`、`moveNodes`、`resizeNode`、`updateNode`、`deleteNodes`、`addEdge`、`updateEdge`、`deleteEdges`、`group`、`ungroup`、`setGroup`、`align`、`distribute`、`arrange`、`order`。步骤先作用在工作副本上，与已存行的差异作为一条变更保存，同时保存它的逆；撤销与重做读存下来的逆，所以重启后仍然可用。历史每块板最多 300 条，超出的最旧一条先丢，撤销后的新编辑丢掉可重做的部分。
- 视口（`setViewport`）单独保存，不进撤销历史。错误：越权 `FORBIDDEN`，白板不存在 `NOT_FOUND`，步骤不合法 `VALIDATION_ERROR`，不写入任何一步。

## 3. Agent 与界面

命令在同一个网关注册，界面经这一入口调用。Agent 在本项目的会话里可以读（`whiteboard.list/get`）并编辑（`whiteboard.edit`）：一次编辑是一步可撤销的操作，在撤销列表里标为“Agent：…”，写入进操作日志；新建、重命名、删除仍只由所有者操作（A-73）。跨项目的调用在命令层被拒绝（`creative/agent-access.ts`），不只是不在工具清单里；娱乐模式的全局对话与资源会话没有这些命令；仍只由所有者操作的部分登记在[执行状态](../delivery/status.md#loop-09)。界面：项目页的“白板”标签，左侧是项目的白板列表（新建、重命名、删除先确认），右侧是画布：工具条可加卡片、文本与引用（引用经选择器指向个人材料或其他创作对象），双击空白处在该处加卡片；拖动移动，框选后对齐、水平或垂直等距、整理排列、调整前后层次，连线从节点边缘拖出，`Ctrl+G` 把选中节点收进一个分组，`Ctrl+Z` 撤销、`Ctrl+Shift+Z` 或 `Ctrl+Y` 重做，有“平移”与“选择”两种指针模式；位置与缩放重启后恢复。500 张卡片的白板只绘制视口内与邻近的卡片，其余保留在数据里；拖动与缩放不会因此丢卡片（窗口基准的规模与结果见[执行状态](../delivery/status.md)）。窄窗下画布占满主面板宽度，工具条折行而不出现横向溢出。

## 4. 生命周期与兼容

停用：画布入口与命令撤销，数据保留；引用该白板的互嵌显示“模块已关闭”的占位和恢复入口。引用目标被删除或其模块关闭时，引用卡片保留标题与摘要，不在画布里消失。白板随项目包与资料包往返；撤销历史属于 Profile，不进包。

## 5. 验证与未决

自动：`tests/creative/whiteboard.test.ts`、`sort-key.test.ts`、`tests/shell/whiteboard-ui.test.tsx`（AT-26）。窗口：`creative-whiteboard`（添加卡片、鼠标拖动、重载后位置仍在、撤销）与 `creative-fit-*`；基准 `whiteboardOpenMs`、`whiteboardDragP95Ms`、`whiteboardZoomP95Ms`（500 张卡片，隐藏窗口，只含 DOM 提交，不含绘制）。限制：画布没有多人协作；没有自动排版以外的版式模板；触摸与手写输入未测。
