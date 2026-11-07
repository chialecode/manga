# 笔记模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.notes` / 笔记 / 开发者 |
| 文档状态 / 实现状态 | M1a 提供可撤销创建/更新/撤销；完整块编辑器归 M1b |
| 需求 / 阶段 / 设计依据 | NOTE-03、AGENT-03；M1a；[领域模型](../design/domain-model.md) |
| 包与公开入口 | `packages/app-core`；命令 `notes.create`、`notes.update`、`notes.undo` |

## 1. 责任与依赖

拥有 `notes.document` 对象、修订历史和笔记检索投影。依赖 `manga.library`。无 Tiptap/CodeMirror；多块更新仍要求 `blockId`。

## 2. 数据与公开能力

`notes.create` 可撤销；`notes.undo` 从 `object_revisions` 恢复上一载荷。结构变更同步检索。授权：enumerated grant 仅能在允许集合内引用资源。

## 3. Agent 与界面

UI 与 Agent 共用同一命令。停用 notes 后旧工具返回 `CAPABILITY_UNAVAILABLE`，不能再写入。

## 4. 生命周期与兼容

停用撤销 UI Facet 与命令；对象数据保留并可导出。

## 5. 验证与未决

AT-09/10/49；完整结构撤销与跨块选区归 M1b。VOICE-07/08 的分段转录回顾与来源跳转在后续记录工作流中复用稳定的 Transcript/SourceLocator，不在 M1a 声称已实现。
