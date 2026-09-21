# M0 验证模块规格

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `m0.*` 验证模块集合；技术负责人 |
| 文档状态 / 实现状态 | draft 规格；experiments/m0 可运行原型，非正式产品模块 |
| 需求 / 阶段 / 设计依据 | POC-01—09；[组合方案](../composable-ai-native-architecture.md)、[领域模型](../domain-model.md)、[Agent 协议](../agent-and-plugins.md) |
| 包与公开入口 | `packages/contracts`、`packages/kernel`、`packages/storage-sqlite`、`experiments/m0` |

## 1. 责任与依赖

验证宿主装配 `library`、`notes`、`novel-reader`、`metadata`、`download`。领域代码不导入 Electron、内核或 SQLite 驱动。无 AI、无界面时，Node 宿主仍可执行同一命令。假元数据提供者为 many 绑定；阅读器停用后库与笔记保留。

## 2. 数据与公开能力

实体沿用 Work/Resource/ResourceRevision/Anchor/ContentObject/ImportReceipt。命令包括 `workspace.get`、`library.importText`、`library.importEpub`、`library.search`、`notes.create`、`notes.update`、`capture.save`、`metadata.query`、`metadata.override`、`acquisition.start`、`reader.resolveAnchor`、`progress.set`。短事务提交对象、修订、操作与事件后才通知。`metadata.override` 属于本地库，不依赖元数据聚合模块；采集附件由 notes 模块保存。输入 schema 见 `packages/contracts/src/inputs.ts`。

## 3. Agent 与界面

UI 与假 Agent 经同一 `MangaApp.call`。Renderer 不携带 actor；宿主封装命令。任务目标由幂等键与对象 ID 固定。

## 4. 生命周期与兼容

停用先拒绝新调用并增加 module epoch，排空租约后释放资源。激活失败清理作用域。未知 `content_objects` payload 完整进入备份。schema 迁移失败回滚。

## 5. 验证与未决

对应 POC-01—09。独立包、双向跨卷及当前参考机性能子集已自动验证；旧编辑器部分人工已报告通过，新编辑器与声学仍需对应人工验证，未完成工程项见 [复核报告](../../evidence/2026-09-19-m0-followup-review.md)。运行时/写入宿主仍为建议；正式 UI/存储基础按 ADR-0007 已选，集成尚未验证。M1 Agent 和扩展媒体目标不能由本原型的假 Agent/格式子集宣称完成。
