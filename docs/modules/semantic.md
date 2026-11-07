# 语义检索模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.semantic` / 语义检索（可选） / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；真实 Embedding 调用 not-run（[ACT-05](../../USER-ACTIONS.md#act-05)），索引与检索用受控向量验证 |
| 需求 / 设计依据 | SEARCH-02、MODEL-03、AT-31；[领域模型](../design/domain-model.md)、[架构](../design/architecture.md) |
| 包与公开入口 | `packages/app-core/src/semantic/`（`service.ts`、`chunk.ts`、`ports.ts`、`http.ts`）；命令 `semantic.status`、`configure`、`rebuild`、`cancel`、`update`、`clear`、`search`；界面：设置里的语义检索页，项目“摘录”标签里的“按含义搜”入口 |

## 1. 责任与依赖

拥有语义索引：把正文、笔记、录音转写和摘录切成片，经嵌入模型得到向量，按含义找最近的片段。它是可选增强：默认关闭，没有它时全文搜索（SEARCH-01）完全不受影响。不拥有被索引的文字，只读它们，从不修改。

Feature `semantic`；Facet `service`/`ui`；硬依赖 `manga.library`。向量只来自用户配置的 Embedding 连接（OpenAI 兼容的 `/embeddings`，通过嵌入端口调用，测试给受控端口），不回退到文本或转录连接，也不用文本模型的连接去算向量。

**索引的版本。** 一个版本固定一个模型、一个向量长度、一种切法（`paragraph-300`、`paragraph-600`（默认）、`paragraph-1200`，按码点计，按句和行打包，不切开一个句子，除非单句超长）。更改模型、向量长度或切法会建一个新版本，在后台重建；重建期间正在使用的旧版本继续回答，全文搜索照常可用；新版本完整之后才切换，所以不同模型的向量永远不会被比较。查询的向量只由索引所用的模型生成；连接的模型改了或向量长度变了，检索返回 `needsRebuild` 而不是混用。

## 2. 数据与公开能力

- 数据：`index_versions`（连接、模型、维度、切法、引擎 `vec0`/`blob`、状态 `building`/`active`/`failed`、进度、错误、激活时间）、`semantic_chunks`（版本、来源种类 `fragment`/`recording`/`excerpt`、来源 ID、片序号、来源哈希、起止码点、向量 BLOB）。`vec0` 引擎为每个版本建一张 sqlite-vec 虚拟表；扩展无法加载时退回 `blob`：向量存在片行的列里，在 JavaScript 里按余弦计算，结果与排序规则相同。同一个版本只用一种引擎，引擎记录在版本上。
- 来源范围：正文（含笔记块）、录音转写（有修订的取修订文本）、摘录；本阶段不索引网页版本全文与文稿。
- 命令：`semantic.configure`（开关、连接、切法；打开或改动自动建新版本）、`rebuild`、`cancel`（丢掉未完成的版本，不动正在使用的）、`update`（只补写入之后新增的片、删掉已不在的片）、`clear`（删除所有版本与向量，不动来源）、`status`（配置、连接、当前与在建版本、失败原因、待补的片数、引擎，以及开启前对片数的估计）、`search`（`text`、`limit`、`kinds`、`projectId`、`resourceId`、`withinProgress`）。
- 范围先于相似度：给了项目则只在项目的材料范围里找（项目持有的资源与笔记、录音、摘录和项目拥有的摘录）；`withinProgress` 时正文命中不超过已读位置（防剧透）。结果带来源种类、来源 ID、起止码点、分数、原文片段，可直接在所在位置打开；来源已被删除、已被改动（录音与摘录核对哈希）或所属模块已关闭的命中不返回，不给出过期位置；其余按来源当前文字取摘要。
- 失败：没有连接 `MODEL_CAPABILITY_MISSING`（`noConnection`）；扩展丢失而版本是 `vec0`：`MODEL_CAPABILITY_MISSING`（`extension`），重建即退回 `blob`；服务错误按嵌入端口分类，失败原因保留在版本上，不含响应正文。

## 3. Agent 与界面

命令在同一个网关注册，界面经这一入口调用。语义检索会调用外部 Embedding 服务，不对 Agent 开放（A-73）；Agent 在项目会话里的 `research.search` 只搜本地资料，不使用向量索引。跨项目的调用在命令层被拒绝（`creative/agent-access.ts`），不只是不在工具清单里；娱乐模式的全局对话与资源会话没有这些命令；仍只由所有者操作的部分登记在[执行状态](../delivery/status.md#loop-09)。设置页：开关、选连接、选切法、开启前显示对片数的估计、进度、取消、重建与更新、清除，“待补 N 片”与“当前设置与索引不一致”的提示，并显示当前引擎。项目的“摘录”标签里有“全文 / 按含义”两种搜索，按含义的结果与全文结果同样可打开所在位置；没有开启或在建时说明状态，不静默显示空结果。

## 4. 生命周期与兼容

停用：检索入口撤销，已有版本与向量保留，重新启用后继续用；在建的版本随应用关闭而中断，开关仍开着时再次保存设置会从中断处续建，也可以取消或重建。清除只删向量与版本记录。索引不进资料包与项目包，导入后由 `update` 或 `rebuild` 补建。sqlite-vec 的原生库随安装包放在应用归档之外（`app.asar.unpacked`），打包窗口里实际加载并完成一次最近邻查询（`creative-semantic-extension`）。

## 5. 验证与未决

自动：`tests/semantic/chunk.test.ts`、`semantic.test.ts`（`vec0` 与 JavaScript 两条路径各一套同样的用例）、`tests/shell/semantic-ui.test.tsx`（AT-31）。基准（服务层，1 万个片）：`semanticSearchP95Ms` 与 `semanticFallbackP95Ms`，见[执行状态](../delivery/status.md)。限制：只支持 OpenAI 兼容的 Embedding 服务；不索引文稿与网页全文；没有混合排序（全文与向量的合并排序）；跨语言检索的质量取决于所选模型，未实测。
