# 资料库模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.library` / 资料库 / 开发者 |
| 文档状态 / 实现状态 | M1a 命令保留；M1b 增加分块全文索引、原文/托管导入和四类候选解析，候选均未验收 |
| 需求 / 阶段 / 设计依据 | LIB-01、LIB-04；M1a；[领域模型](../design/domain-model.md)、[Agent 协议](../design/agent-and-plugins.md) |
| 包与公开入口 | `packages/app-core`；另有 `library.list`、`library.importDocument`、`library.read`、`library.readSlice`、`library.rebuildIndex`、`library.repairSource` |

## 1. 责任与依赖

拥有资源身份、修订、检索投影和资料包导入导出。不拥有笔记编辑器、完整阅读器或下载引擎。Feature `library`；Facet `service`/`ui`/`worker`；解析 worker 随模块启停。无 AI 时仍可导入与检索。

## 2. 数据与公开能力

实体：Work、Resource、ResourceRevision、FileLocation、text fragments。查询在返回正文前按授权过滤。`library.list` 使用书名 query 和 created_at/id 稳定游标，limit 为 1—200（默认 100），total 是当前授权及查询条件下的完整资源数，不随游标减少；一资源只取最新修订，workspace 首屏遵守相同资源粒度。搜索续页必须保留 query；仅会话/偏好刷新不清空已加载结果。普通资料包导入只接受空 Profile；冲突导入另有预览与逐项决策入口，其依赖矩阵仍有 [A 复核 F-09](../evidence/m1b-reading-notes-delivery.md#816-a-独立复核与分页局部修复2026-09-25) 所列缺口。导入校验清单引用、附件路径/哈希与预算，写入全部表并重建检索索引（含笔记授权范围），先发布附件硬链接再提交事务；普通失败回滚事务并清理自有链接与暂存。进程中断由 `recovery_jobs` 记录，重启后经 `settings.recoverJobs` 回滚孤儿文件，不触碰非本任务创建的文件。

## 3. Agent 与界面

Agent 工具 `library.find` / `library.getResource` / `library.contextSnapshot` 使用宿主发放的 enumerated grant。模型不能提供路径或扩大 allowlist。

## 4. 生命周期与兼容

停用撤销 UI 入口、取消解析并拒绝旧代次结果；重新启用创建新 worker。用户数据保留。产品库从 v4 备份后升级到 schema v5，只追加全文分块列；DDL 与版本发布在同一事务，A 已补中断后重试回归。TXT/EPUB/MOBI/PDF 由仓内可替换适配器解析，`accepted` 仍为 false。

## 5. 验证与未决

AT-11/18/49/51 相关子场景；POC-01/06/08 回归仍由 `experiments/m0` 承担。完整阅读归 M1b；A 最新自动复核中分页可达性与同规模性能通过，PDF/EPUB 真实呈现和资料包显式混合依赖矩阵仍需返工，见 [交付复核 8.16](../evidence/m1b-reading-notes-delivery.md#816-a-独立复核与分页局部修复2026-09-25)。正式人工与产品验收 not-run。
