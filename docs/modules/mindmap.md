# 思维导图模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.mindmap` / 思维导图 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；手感检查见[用户待办](../../USER-ACTIONS.md#checks) |
| 需求 / 设计依据 | CRE-03、CRE-04、AT-27；[领域模型](../design/domain-model.md)、[交互设计](../design/interaction-and-workflows.md) |
| 包与公开入口 | `packages/app-core/src/creative/mindmap.ts`、`sort-key.ts`、`ops.ts`；命令 `mindmap.list`、`create`、`get`、`rename`、`delete`、`setTheme`、`edit`、`undo`、`redo`、`export`；界面 `apps/desktop/src/renderer/pages/projects/canvas/mindmap-tab.tsx`、`mindmap-model.ts` |

## 1. 责任与依赖

拥有导图文档：一个中心主题（单根树）、每个节点稳定的 ID、父节点、兄弟之间的排序键、折叠标记、挂在节点上的引用，以及导图自己的撤销历史。引用是附件，指向个人材料或其他创作对象，不参与父子结构，也不改变树。

Feature `mindmap`；Facet `service`/`ui`；硬依赖 `manga.library`、`manga.projects`。布局用 `d3-hierarchy`（ISC）算出节点位置，渲染用 `@xyflow/react`；树模型、排序键、撤销与持久化由 MANGA 自己实现。无 AI 时完全可用。

## 2. 数据与公开能力

- 数据：`mindmaps`（标题、主题、所属项目）、`mindmap_nodes`（ID、父 ID、排序键、文本、折叠标记、引用 JSON）。排序键是两个相邻键之间的分数索引：在两个兄弟之间插入或移动只写一行，不重排其余兄弟。
- `mindmap.edit` 的步骤：`addChild`、`addSibling`、`setText`、`move`（换父节点）、`shift`（同一父节点内上移或下移）、`delete`（带子树）、`collapse`、`addRef`、`removeRef`。一次调用是一次撤销，逆与变更一起保存，重启后仍可撤销与重做；历史每张图最多 300 条。
- 树约束：只有一个根，根不能删除也不能移动；`move` 先检查目标父节点不是被移动节点自己或它的后代，否则以 `VALIDATION_ERROR` 拒绝并保持整张图不变；删除节点带走它的子树与引用，ID 不复用。
- 主题 `pink`、`blue`、`green`、`mono`（`mindmap.setTheme`）。
- 导出（`mindmap.export`，格式 `png`、`svg`、`markdown`、`opml`）：Markdown 与 OPML 在服务里由树生成，PNG 与 SVG 由界面渲染后把数据交给命令；文件写入用户在宿主对话框里选的目录，先写临时名，完成后改名，重名时加序号，不覆盖已有文件，只返回文件名。

## 3. Agent 与界面

命令在同一个网关注册，界面经这一入口调用。Agent 在本项目的会话里可以读（`mindmap.list/get`）并编辑（`mindmap.edit`）：一次编辑是一步可撤销的操作，在撤销列表里标为“Agent：…”，写入进操作日志；新建、重命名、删除与导出仍只由所有者操作（A-73）。跨项目的调用在命令层被拒绝（`creative/agent-access.ts`），不只是不在工具清单里；娱乐模式的全局对话与资源会话没有这些命令；仍只由所有者操作的部分登记在[执行状态](../delivery/status.md#loop-09)。界面：项目页的“导图”标签，左侧是导图列表，右侧是画布；节点上的引用显示标签并可打开所指对象，目标失效或模块关闭时显示摘要与状态而不是消失。键盘：`Tab` 加子节点、`Enter` 加兄弟（`Shift+Enter` 加在前面）、`F2` 改文字、`Delete`/`Backspace` 删除、空格折叠或展开、`Alt+↑/↓` 在兄弟间调整顺序、方向键在节点间移动选择、`Ctrl+Z`、`Ctrl+Shift+Z`/`Ctrl+Y` 撤销与重做；拖动节点到另一节点上改变父子关系，落在自己的后代上被拒并提示。1000 个节点的导图不做可见区裁剪，折叠一个分支即让其下节点不再出现在页面里（规模与结果见[执行状态](../delivery/status.md)）。

## 4. 生命周期与兼容

停用：画布入口与命令撤销，数据保留，引用该导图的互嵌显示占位与恢复入口。导图随项目包与资料包往返；撤销历史属于 Profile，不进包。迁移前自动备份，失败回滚。

## 5. 验证与未决

自动：`tests/creative/mindmap.test.ts`、`sort-key.test.ts`、`tests/shell/mindmap-ui.test.tsx`（AT-27）。窗口：`creative-mindmap`（键盘加节点、折叠、文本导出、撤销）与 `creative-fit-*`；基准 `mindmapFoldP95Ms`（1000 个节点，隐藏窗口，只含 DOM 提交）。限制：PNG 与 SVG 的版式随当前主题与可见节点；节点内不支持富文本；没有多人协作。
