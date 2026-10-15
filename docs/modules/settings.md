# 设置模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.settings` / 设置 / 开发者 |
| 文档状态 / 实现状态 | 首次配置、分区/指针展示、整体迁移、指针位置保存与中断复制续作已接线；独立分区迁移仍明确拒绝；设置是独立界面，分组为基础设置、Agent 能力、记录、日志（A-49）；产品验收为 not-run |
| 需求 / 设计依据 | UI-04、DATA-04、DATA-05、MODEL-01/04/05、READ-03、READ-04、AGENT-07 |
| 包与公开入口 | `packages/app-core`；`settings.get`、`settings.skipAi`、`settings.proposeLocations`、`settings.applyLocations`、`settings.recoverJobs`、`settings.setRuntime`、`settings.setLayout`、`connections.*` |

## 1. 责任与依赖

拥有位置配置、启动指针展示、模型连接摘要与凭据引用。不保存明文凭据。无模型时跳过 AI 仍进入应用。

## 2. 数据与公开能力

连接只存 `credentialRef`；删除连接同时删除对应凭据密文。upsert 清除旧 `verifiedCapabilities`。目录变更先产生检查点并向用户展示计划，`applyLocations` 校验目标与检查点一致、目标为空、拒绝与当前 Profile 重叠或重解析路径、先做 WAL checkpoint，再按 `migration_owned_files` 逐文件 planned/copying/committed 复制并按指纹核对；目标库在切换 pointer 前将检查点标为 succeeded，随后旧宿主写入屏障 `RESTART_REQUIRED`。启动先跟随 `RELOCATED.json`/`relocatedRoot` 再发布 pointer。锁文件与 WAL/SHM 不随分区复制。`settings.recoverJobs` 对资料包清理本任务暂存/孤儿链接；位置回滚仅删除身份与内容指纹仍一致、在目标范围内的 committed 产物；copying 中断文件在确认为本任务产物后可删除并续拷。`recover` 续完复制后发布权威库。`settings.setLayout` 可保存 pointer 位置并把旧 pointer 写成重定向；独立分区计划保持 `CAPABILITY_UNAVAILABLE`。`settings.get.needsSetup` 仅在未跳过 AI 且无连接时为真。仅索引的外部原件不随默认根移动。

### 第二轮返工新增的设置页

- **设置 › 键盘快捷键：** 按阅读器分组列出键位表（`packages/contracts/src/key-bindings.ts`）里的全部动作，可以改键、恢复默认；两个动作用同一个键时指出冲突；每个动作最多 4 个键。按键处理读同一份表。
- **设置 › 阅读与播放：** 编辑倍速列表（0.25—4，最多两位小数，不重复，自动排序，1× 固定保留）、自定义倍速、按住 → 的临时倍速；随媒体设置保存。
- **设置 › 弹幕：** 见[弹幕模块](danmaku.md)。
- **设置 › 智能体：** 步数与时长上限、调用追踪的模式（完整/只记大小）、保留天数与大小上限、占用与一键清除。
- **AI 功能与模型：** 每个连接的每个模型的配置与“测试连接”结果，见[Agent 模块](agent.md)；添加与编辑在弹窗里（A-90）：`pages/settings/connection-dialog.tsx`，页面（`models-page.tsx`）只有列表与“添加模型”，没有常驻表单。弹窗用现有的 `components/modal.tsx`（Radix Dialog），分“连接”（地址、模型、密钥、协议、用途、运行时、超时）与“模型能力”（上下文、输出、输入类型、能力、推理等级，只对文本与视觉用途显示）两组；保存前逐字段校验，错误显示在字段旁、弹窗不关；编辑时密钥框留空表示不改；保存后可以直接测试，结果同时显示在弹窗与列表里；有未保存的修改时关闭、删除连接都先确认；列表里的用途、协议、运行时显示中文名称（`tests/agent/connection-dialog.test.tsx`、`models-page.test.tsx`）。
- **位置：** 位置分区新增 `works`（作品内容），与其他分区一样可以改位置，迁移时随之移动。

## 3. Agent 与界面

目录与凭据必须经宿主交互产生 path/credential handle。Agent 不能模拟选择器。

**独立设置界面（A-49）。** 进入设置后左栏换成设置导航（顶部“返回”）、主面板换成设置内容、不显示右栏。分组与页面（`apps/desktop/src/renderer/lib/shell-model.ts` 的 `SETTINGS_GROUPS`）：基础设置——常规、外观、阅读、录音、资源库、来源、存储与备份、模块、快捷键；Agent 能力——模型、快捷任务、使用记录；记录——笔记、录音与对话；日志——操作日志。“对话”类别（`pages/settings/conversation-records.tsx`，A-89）列出全部对话，按模式、类型（全局、资源、作品、项目、笔记）、时间筛选并按标题或所属内容搜索，每项显示标题、所属、轮数与最后时间；可以删除一个、多选删除、删除全部（筛选时可只删筛选出的），都先确认，确认框写明删除与保留的范围，并说明升级前复制的数据库副本里还留着当时的对话；有任务在进行的对话不删，说明原因；所属内容已不存在的对话照常列出。依赖某模块的页面在该模块停用时不列出，其余始终可达。资源总览在“存储与备份”页，资源库路径与扫描计划在“资源库”页（没有独立的“导入”入口），元数据来源在“来源”页。设置页之间切换不丢未保存输入。“阅读与播放”页有“截图带字幕”（`video.shotSubtitles`，默认开）；“弹幕”页有“弹幕速度跟随倍速”（默认开）。

**操作日志。** `operation_log` 表由命令分发处在提交后统一写入（`packages/app-core/src/ops/`），覆盖用户与 Agent 的写操作、扫描、导入、匹配、编辑、模块启停、备份与迁移、连接变更，不记录翻页等只读操作；阅读器里连续的视图设置变更（缩放、适配，即 `settings.setMedia`）由同一操作者在 60 秒内重复时合并为一行并更新时间，失败或中间插入其他操作时另起一行；不含凭据、正文与图像；保留 180 天或 5 万条，超出的按时间清理。`log.query` 按类别、操作者、结果、时间与关键字分页读取。

## 4. 生命周期与兼容

开发/正式/测试通道隔离。Documents 不可写时返回 `LOCATION_UNAVAILABLE` 并提供选目录/重试，不静默改路径。

## 5. 验证与未决

AT-50/51；`tests/runtime/storage-locations-recovery.test.ts`、`grants-package-inventory.test.ts`、`location-ownership-idempotency.test.ts`、`location-switch-recovery.test.ts` 与 `tests/agent/model-routing.test.ts` 覆盖迁移校验、写入屏障、用途隔离与中断回滚。真实兼容文本/ASR 短测按忽略的本地用途配置执行，不作为产品默认；Embedding 未配置时 not-run。VOICE-07 的音频保留与分段回顾归语音模块。

模型设置按 A-27 分成 LLM、Embedding、ASR，独立选型、凭据、runtime 和能力记录；错配在联网前拒绝。设置可分别编辑、测试、更换和清除连接/凭据；授权音频文件经 `library.transcribeAudio` 与宿主 path handle 上传，测试连接使用有效合成 WAV，不把用户库文件因探针外传。桌面设置不自动导入 `.env.local`。

启动定位消费 `relocatedRoot`；`settings.recoverJobs recover` 续拷并发布；`settings.setLayout` 保存 pointer。独立分区迁移仍拒绝。
