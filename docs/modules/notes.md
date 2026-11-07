# 笔记模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.notes` / 笔记 / 开发者 |
| 文档状态 / 实现状态 | M1b 已接块拆分/合并/移动/复制/替换、稳定 ID 和桌面编辑器；真实输入法仍待人工。**M2 返工已实施并自检**：右栏笔记气泡关联当前位置；笔记管理移入设置的“记录”（A-48、A-49），见[M2 交付报告第 16 节](../evidence/m2-media-mvp-delivery.md#16-返工交付2026-10-06)；产品验收仍为 not-run |
| 需求 / 阶段 / 设计依据 | NOTE-03、AGENT-03；M1a；[领域模型](../design/domain-model.md) |
| 包与公开入口 | `packages/app-core` 与 `apps/desktop`；命令另有 `notes.get`、`notes.split`、`notes.merge`、`notes.move`、`notes.copy`、`notes.replace`、`notes.openSource` |

## 1. 责任与依赖

拥有 `notes.document` 对象、修订历史和笔记检索投影。依赖 `manga.library`。桌面已有 Tiptap 与 CodeMirror 6 入口；两种视图共用权威块状态与输入法屏障（F-03 已关闭，见 [M1b 总结](../evidence/m1b-summary.md)）；完整结构操作的撤销仍未实现，不能视为完整编辑器；旧 schema v1 载荷保留到被编辑，读取时升到文档 schema 2。修订冲突返回候选且不覆盖。

## 2. 数据与公开能力

`notes.create` 可撤销；`notes.undo` 从 `object_revisions` 恢复上一载荷。结构变更同步检索。授权：enumerated grant 仅能在允许集合内引用资源。

## 3. Agent 与界面

UI 与 Agent 共用同一命令。停用 notes 后旧工具返回 `CAPABILITY_UNAVAILABLE`，不能再写入。

**右栏笔记气泡与记录页（M2 返工）。** 右栏输入框切到“笔记”后发送，创建带锚点的笔记：小说为位置或选区，漫画为页或区域，视频为时间点或 A-B 区间，作品主页为作品级；锚点经 `notes.create` 的 `workId`、`locator`、`quoteText` 与 `tags` 写入，没有位置信息时仍可创建。气泡可就地编辑、跳回来源（`notes.openSource`）、作为引用标签提问。`notes.delete` 为软删除：对象标记 `deleted_at`，修订与引用保留，从消息流和书架隐藏；`notes.undelete` 在设置的“记录”页恢复。“记录”页（`records.list`）按类型、作品、媒介、状态与关键字筛选笔记与录音，分页，可打开、回放、重试转写、清理待处理音频、恢复已删除项、跳到来源；1 万条笔记的分页由合成数据测试覆盖。书架不再有“笔记”导航。

## 4. 生命周期与兼容

停用撤销 UI Facet 与命令；对象数据保留并可导出。

## 5. 验证与未决

AT-09/10/49 的块拆分、复制和冲突候选有 M1b 合成测试。真实输入法、跨块选区和语音回顾仍 not-run。VOICE-07/08 不在本轮声称已实现。
