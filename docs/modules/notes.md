# 笔记模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.notes` / 笔记 / 开发者 |
| 文档状态 / 实现状态 | M1b 已接块拆分/合并/移动/复制/替换、稳定 ID 和桌面编辑器；真实输入法仍待人工 |
| 需求 / 阶段 / 设计依据 | NOTE-03、AGENT-03；M1a；[领域模型](../design/domain-model.md) |
| 包与公开入口 | `packages/app-core` 与 `apps/desktop`；命令另有 `notes.get`、`notes.split`、`notes.merge`、`notes.move`、`notes.copy`、`notes.replace`、`notes.openSource` |

## 1. 责任与依赖

拥有 `notes.document` 对象、修订历史和笔记检索投影。依赖 `manga.library`。桌面已有 Tiptap 与 CodeMirror 6 入口；两种视图同步、完整结构操作与源编辑 IME 仍有 [A 审查 F-03](../evidence/m1b-reading-notes-delivery.md#8-a-集中审查与返工) 缺口，不能视为完整编辑闭环；旧 schema v1 载荷保留到被编辑，读取时升到文档 schema 2。修订冲突返回候选且不覆盖。

## 2. 数据与公开能力

`notes.create` 可撤销；`notes.undo` 从 `object_revisions` 恢复上一载荷。结构变更同步检索。授权：enumerated grant 仅能在允许集合内引用资源。

## 3. Agent 与界面

UI 与 Agent 共用同一命令。停用 notes 后旧工具返回 `CAPABILITY_UNAVAILABLE`，不能再写入。

## 4. 生命周期与兼容

停用撤销 UI Facet 与命令；对象数据保留并可导出。

## 5. 验证与未决

AT-09/10/49 的块拆分、复制和冲突候选有 M1b 合成测试。真实输入法、跨块选区和语音回顾仍 not-run。VOICE-07/08 不在本轮声称已实现。
