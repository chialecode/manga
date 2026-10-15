# 互嵌模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.embeds` / 嵌入 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)） |
| 需求 / 设计依据 | CRE-04、NOTE-05、AT-28、AT-91、DATA-03；[领域模型](../design/domain-model.md)、[交互设计](../design/interaction-and-workflows.md) |
| 包与公开入口 | `packages/app-core/src/creative/embeds.ts`；命令 `embed.list`、`upsert`、`remove`、`refresh`、`backlinks`；界面 `apps/desktop/src/renderer/embed/`（笔记里的嵌入块与选择器） |

## 1. 责任与依赖

笔记、白板和思维导图三种对象，都可以把另外两种（或同种的另一个）整体或局部嵌入自己里面，局部指笔记的一个块、白板或导图的一个节点。本模块拥有这唯一的一张关系表和它的解析规则：目标是否还在、模块是否开着、读者是否有权限、有没有循环。它不拥有被嵌入的内容，也不替源对象保存内容。

Feature `embeds`；Facet `service`/`ui`；硬依赖 `manga.library`，不依赖项目模块：笔记不属于项目也能嵌入。白板与导图在自己的编辑里同步它们的嵌入（`embeds.sync`），笔记的嵌入块在保存时同步。

## 2. 数据与公开能力

- 数据：`embeds`（源种类与 ID、槽位、目标种类与 ID、局部定位 `{blockId?, nodeId?}`、模式 `live`/`snapshot`、快照 JSON 与快照版本）。一个源最多 500 个嵌入。
- 模式：`live` 显示目标此刻的内容；`snapshot` 在加入时保存当时的内容和版本，之后目标改变不影响显示，界面标出“取自什么时候”，`embed.refresh`（界面里的“更新快照”）重新取一份。
- 状态（`ResolvedEmbed.state`）：`valid`、`deleted`（目标已不存在）、`disabled`（拥有目标的模块已关闭）、`denied`（读者没有权限）、`cycle`（沿嵌入关系走回了自己）。非 `valid` 的嵌入都带可读的标题与摘要，并列出可做的事：`open`、`enable`、`remove`、`keepSnapshot`、`refresh`；快照模式的嵌入在目标消失后仍显示快照。
- 循环：白板、导图的编辑与 `embed.upsert` 会拒绝形成循环的嵌入（`VALIDATION_ERROR`，一步都不写）；笔记保存不拒绝（不丢用户已输入的内容），而在读取时沿嵌入关系向前走，回到出发的对象即判为 `cycle`，给出摘要并只提供“移除”，不递归展开。
- 反向链接（`embed.backlinks`）：列出嵌入了某个目标的所有源，源模块已关闭的行标为关闭。删除源对象时一并删除它的嵌入行（`dropSource`）。

### 截图对象（NOTE-05）

`screenshot` 是互嵌可指向的对象类型：笔记里是一个嵌入块（`embed/screenshot-node.tsx`，缩略图加来源说明，点击回到视频的时间或漫画的页），白板与导图里是指向图片的引用卡片，而不是图片的副本。见[资料库模块](library.md#screenshots)。

## 3. Agent 与界面

命令在同一个网关注册，界面经这一入口调用。它们是所有者命令，不在 Agent 的工具清单里：Agent 的项目命令按 A-73 只含项目、白板、导图、文稿建议与材料的读写，所以 Agent 不能读写嵌入关系。跨项目的调用在命令层被拒绝（`creative/agent-access.ts`），不只是不在工具清单里；娱乐模式的全局对话与资源会话没有这些命令；仍只由所有者操作的部分登记在[执行状态](../delivery/status.md#loop-09)。笔记里是一种“嵌入”块：从选择器里选目标（笔记、白板、导图，或其中的一个块或节点）和模式；块里显示摘要或内容，点击跳转到源对象。嵌入的内容是只读视图，要改内容需打开目标对象，不在嵌入处直接改写目标。白板的引用实例与导图的节点引用也经同一关系解析。状态为非 `valid` 的块显示原因与上面列出的动作，而不是空白或报错。

## 4. 生命周期与兼容

目标模块停用：占位显示“模块已关闭”并提供启用入口，嵌入行保留；重新启用后恢复。源对象删除：嵌入行随之删除。项目包与资料包带上嵌入行，导入时按 ID 重映射；指向没有一起导入的对象的嵌入导入后显示 `deleted`。

## 5. 验证与未决

自动：`tests/creative/embeds.test.ts`、`tests/shell/embed-ui.test.tsx`（AT-28）、`library-package-creative.test.ts`（往返）。窗口：`creative-embeds-in-note`（在笔记里嵌入白板、快照标记、删除源后的状态）。限制：窗口里只检查了笔记里的嵌入，白板与导图里嵌入的显示由组件测试覆盖；嵌入内容是只读视图，不支持就地编辑；不提供“复制为新对象”。
