# 资料库模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.library` / 资料库 / 开发者 |
| 文档状态 / 实现状态 | 设计随 M1a 交付；实现已接入产品宿主，M1a 相关命令可运行 |
| 需求 / 阶段 / 设计依据 | LIB-01、LIB-04；M1a；[领域模型](../design/domain-model.md)、[Agent 协议](../design/agent-and-plugins.md) |
| 包与公开入口 | `packages/app-core` 内置模块；命令 `library.importText`、`library.getResource`、`library.contextSnapshot`、`library.find`、`library.search`、`library.exportPackage`、`library.importPackage`、`workspace.get` |

## 1. 责任与依赖

拥有资源身份、修订、检索投影和资料包导入导出。不拥有笔记编辑器、完整阅读器或下载引擎。Feature `library`；Facet `service`/`ui`/`worker`；解析 worker 随模块启停。无 AI 时仍可导入与检索。

## 2. 数据与公开能力

实体：Work、Resource、ResourceRevision、FileLocation、text fragments。查询在返回正文前按授权过滤。资料包导入只接受空 Profile，校验清单引用、附件路径/哈希与预算，写入全部表并重建检索索引（含笔记授权范围），先发布附件硬链接再提交事务；普通失败回滚事务并清理自有链接与暂存。进程中断由 `recovery_jobs` 记录，重启后经 `settings.recoverJobs` 回滚孤儿文件，不触碰非本任务创建的文件。

## 3. Agent 与界面

Agent 工具 `library.find` / `library.getResource` / `library.contextSnapshot` 使用宿主发放的 enumerated grant。模型不能提供路径或扩大 allowlist。

## 4. 生命周期与兼容

停用撤销 UI 入口、取消解析并拒绝旧代次结果；重新启用创建新 worker。用户数据保留。旧 schema v1 可打开并升级到产品 schema v2。

## 5. 验证与未决

AT-11/18/49/51 相关子场景；POC-01/06/08 回归仍由 `experiments/m0` 承担。完整阅读归 M1b。
