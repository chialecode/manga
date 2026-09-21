# 资源总览模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.inventory` / 资源总览 / 开发者 |
| 文档状态 / 实现状态 | M1a 总览含占用字节、分区/指针位置、缺失修复、可取消的逐批扫描和仅索引外部根；独立分区迁移仍拒绝 |
| 需求 / 阶段 / 设计依据 | LIB-04、AT-51 |
| 包与公开入口 | `packages/app-core`；`inventory.overview`、`inventory.scan`、`inventory.cancelScan`、`inventory.reveal`、`inventory.repair` |

## 1. 责任与依赖

汇总已存在资源、笔记、附件、备份和缓存占用；未来模块显示未启用/无数据。依赖 library。扫描按有界批次让出事件循环，可用 `inventory.cancelScan` 取消；总览读取已扫描的 `partition_stats`，不在 overview 中递归 backup/cache。凭据不进入结果。

## 2. 数据与公开能力

契约要求数量、字节、位置、托管/索引/缺失状态来自同一存储查询。资源/笔记字节取自修订或对象 payload；附件列表取自文件系统；backup/cache 等分区占用以扫描写入的 `partition_stats` 为准。仅索引根登记在 `indexed_roots`，扫描时刷新占用，原件不随默认根移动。缺失分区或索引根可通过 `inventory.repair` 重建目录或更新路径；独立分区改址仍拒绝。非 owner 不返回 Profile 路径。

## 3. Agent 与界面

`inventory.overview` 可供 Agent 只读调用；非 owner grant 按已授权资源/对象返回元数据，不返回 Profile 路径或无关附件，空范围返回空集合（F-23）。

## 4. 生命周期与兼容

停用取消扫描并撤销 UI。

## 5. 验证与未决

AT-51 子场景；完整备份产品能力仍按 DATA-02 后续扩展。
