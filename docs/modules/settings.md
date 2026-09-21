# 设置模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.settings` / 设置 / 开发者 |
| 文档状态 / 实现状态 | M1a 首次配置、分区/指针展示、整体迁移、指针位置保存与中断复制续作已接线；独立分区迁移仍明确拒绝；长录音策略属 M1b |
| 需求 / 阶段 / 设计依据 | UI-04、DATA-04、MODEL-01/04；M1a |
| 包与公开入口 | `packages/app-core`；`settings.get`、`settings.skipAi`、`settings.proposeLocations`、`settings.applyLocations`、`settings.recoverJobs`、`settings.setRuntime`、`settings.setLayout`、`connections.*` |

## 1. 责任与依赖

拥有位置配置、启动指针展示、模型连接摘要与凭据引用。不保存明文凭据。无模型时跳过 AI 仍进入应用。

## 2. 数据与公开能力

连接只存 `credentialRef`；删除连接同时删除对应凭据密文。upsert 清除旧 `verifiedCapabilities`。目录变更先产生检查点并向用户展示计划，`applyLocations` 校验目标与检查点一致、目标为空、拒绝与当前 Profile 重叠或重解析路径、先做 WAL checkpoint，再按 `migration_owned_files` 逐文件 planned/copying/committed 复制并按指纹核对；目标库在切换 pointer 前将检查点标为 succeeded，随后旧宿主写入屏障 `RESTART_REQUIRED`。启动先跟随 `RELOCATED.json`/`relocatedRoot` 再发布 pointer。锁文件与 WAL/SHM 不随分区复制。`settings.recoverJobs` 对资料包清理本任务暂存/孤儿链接；位置回滚仅删除身份与内容指纹仍一致、在目标范围内的 committed 产物；copying 中断文件在确认为本任务产物后可删除并续拷。`recover` 续完复制后发布权威库。`settings.setLayout` 可保存 pointer 位置并把旧 pointer 写成重定向；独立分区计划保持 `CAPABILITY_UNAVAILABLE`。`settings.get.needsSetup` 仅在未跳过 AI 且无连接时为真。仅索引的外部原件不随默认根移动。

## 3. Agent 与界面

目录与凭据必须经宿主交互产生 path/credential handle。Agent 不能模拟选择器。

## 4. 生命周期与兼容

开发/正式/测试通道隔离。Documents 不可写时返回 `LOCATION_UNAVAILABLE` 并提供选目录/重试，不静默改路径。

## 5. 验证与未决

AT-50/51；`tests/m1a/p2-storage.test.ts`、`tests/m1a/a-review.test.ts`、`tests/m1a/f24-f32.test.ts`、`tests/m1a/model-routing.test.ts` 覆盖迁移校验、写入屏障、用途隔离与中断回滚。真实兼容文本/ASR 短测按忽略的本地用途配置执行，不作为产品默认；Embedding 未配置时 not-run。VOICE-07/M1b 的音频保留与分段回顾不在本模块 M1a 范围。

模型设置按 A-27 分成 LLM、Embedding、ASR，独立选型、凭据、runtime 和能力记录；错配在联网前拒绝。设置可分别编辑、测试、更换和清除连接/凭据；授权音频文件经 `library.transcribeAudio` 与宿主 path handle 上传，测试连接使用有效合成 WAV，不把用户库文件因探针外传。桌面设置不自动导入 `.env.local`。

2026-09-21 本轮 B 返工：启动定位消费 `relocatedRoot`；`settings.recoverJobs recover` 续拷并发布；`settings.setLayout` 保存 pointer。独立分区迁移仍拒绝。详见 [最新复验](../evidence/m1a-f24-f32-review.md) 与 [B 交付](../evidence/m1a-delivery.md)。
