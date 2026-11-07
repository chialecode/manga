# 资料库模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.library` / 资料库 / 开发者 |
| 文档状态 / 实现状态 | M1a 命令保留；M1b 增加分块全文索引、原文/托管导入和四类候选解析，候选均未验收。**M2 返工已实施并自检**（产品验收 not-run）：资源库路径与后台增量扫描、作品主页、设置中的单次导入（A-47、A-50），实施与证据见[M2 交付报告第 16 节](../evidence/m2-media-mvp-delivery.md#16-返工交付2026-10-06)；计划见[M2 计划第 14 节](../delivery/m2-media-mvp-plan.md#14-人工反馈返工2026-10-06) |
| 需求 / 阶段 / 设计依据 | LIB-01、LIB-04；M1a；[领域模型](../design/domain-model.md)、[Agent 协议](../design/agent-and-plugins.md) |
| 包与公开入口 | `packages/app-core`（`src/library-scan/`）；另有 `library.list`、`library.importDocument`、`library.read`、`library.readSlice`、`library.rebuildIndex`、`library.repairSource`；资源库路径与扫描：`library.paths.list/add/update/remove`、`library.scan.start/cancel/status/setSchedule`（仅所有者；`library.scan.status` 对任务只给目录名，不含本机路径） |

## 1. 责任与依赖

拥有资源身份、修订、检索投影和资料包导入导出。不拥有笔记编辑器、完整阅读器或下载引擎。Feature `library`；Facet `service`/`ui`/`worker`；解析 worker 随模块启停。无 AI 时仍可导入与检索。

## 2. 数据与公开能力

实体：Work、Resource、ResourceRevision、FileLocation、text fragments。查询在返回正文前按授权过滤。`library.list` 使用书名 query 和 created_at/id 稳定游标，limit 为 1—200（默认 100），total 是当前授权及查询条件下的完整资源数，不随游标减少；一资源只取最新修订，workspace 首屏遵守相同资源粒度。搜索续页必须保留 query；仅会话/偏好刷新不清空已加载结果。普通资料包导入只接受空 Profile；冲突导入另有预览与逐项决策入口，其依赖矩阵（skip/duplicate/replace 的混合组合）由 `tests/reading/*` 与 `tests/package/*` 守护，F-09 已关闭（见 [M1b 总结](../evidence/m1b-summary.md)）。导入校验清单引用、附件路径/哈希与预算，写入全部表并重建检索索引（含笔记授权范围），先发布附件硬链接再提交事务；普通失败回滚事务并清理自有链接与暂存。进程中断由 `recovery_jobs` 记录，重启后经 `settings.recoverJobs` 回滚孤儿文件，不触碰非本任务创建的文件。

### 资源库路径与后台扫描（A-50）

数据模型见[领域模型 4.4](../design/domain-model.md#44-资源库路径与后台扫描m2-返工)。实现：`library_paths`、`library_files`（路径、相对路径、大小、修改时间、指纹、状态与上次所见的扫描）、`scan_jobs` 三张表（schema v8 追加）；`ScanService` 一次只运行一个扫描，其余排队；目录遍历在 `worker_threads` 的 worker 中进行，主进程只收批次、按单个文件一次小事务写库，每处理一个文件让出一次事件循环；进度通知节流为约每 200 ms 一次；`SCAN_LIMITS` 为 50 000 个单位、深度 8，超出时标记 `truncated` 且不把未列出的文件记为消失；无权限或中途消失的目录记入 `unreadable`，不使整次扫描失败，也不把其中的文件标为不可用。作品划分、增量跳过、不可用标记与移动重关联按设计实现，导入一个单位用与目录导入相同的代码（`importScanUnit`），所以扫描与导入产生同样的作品。路径的“自动扫描”与全局计划（启动时、间隔 30 分钟/1/6/24 小时或关闭，默认启动时与每小时）由应用内计时器触发，睡眠唤醒后不重复补扫；`add` 一个路径会立即扫描一次。扫描不联网；封面与文件自带资料在扫描结束后由后台任务低优先级读取。

**规模表现（bench，合成数据）：** 5000 个小说文件（20 个系列目录加 3000 个散文件）一次扫描在开发机上约 13—33 s（随机器状态变化），期间主进程事件循环延迟 p99 13.3—31.8 ms、书架与设置所用命令的应答 p95 7.4—19.7 ms（B 自检与 A 复核的三次运行，门槛均为 100 ms，原始数据见[交付报告第 8 节](../evidence/m2-media-mvp-delivery.md#8-性能与基准原始数据)）。基准发现并处理了两个问题：`resource_revisions(resource_id, created_at)` 与 `file_locations(resource_revision_id)` 没有索引，每个资源的“最新修订”与“所在文件”查询都读整张表，3000 多个作品时扫描后的封面与资料读取一次占满主进程约 38 s；后台任务队列在同一轮事件循环里连续跑完所有不等待的任务。已在 v8 的 DDL 里补上两个索引，任务队列在两个任务之间让出一轮事件循环（任务被取消时仍会启动并看到已取消的信号）。

## 3. Agent 与界面

资源库页在设置里（“基础设置 → 资源库”）：添加路径（经宿主对话框取得目录句柄，Agent 不能添加）、媒介、自动扫描开关、立即扫描、取消、上次结果与每个路径的文件数；标题栏在扫描时出现进度入口；单次导入（文件、文件夹、压缩包）也在这一页。主面板不显示导入入口，资源库完全为空时应用打开设置的“资源库”页。书架的卡片进入作品主页（页面），“阅读/观看”才打开文件。

Agent 工具 `library.find` / `library.getResource` / `library.contextSnapshot` 使用宿主发放的 enumerated grant。模型不能提供路径或扩大 allowlist。

## 4. 生命周期与兼容

停用撤销 UI 入口、取消解析并拒绝旧代次结果；重新启用创建新 worker。用户数据保留。产品库从 v4 备份后升级到 schema v5，只追加全文分块列；DDL 与版本发布在同一事务，A 已补中断后重试回归。TXT/EPUB/MOBI/PDF 由仓内可替换适配器解析，`accepted` 仍为 false。

## 5. 验证与未决

AT-11/18/49/51 相关子场景；POC-01/06/08 回归仍由 `experiments/m0` 承担。阅读已随 M1b 合并（PDF 经 PDF.js，EPUB/MOBI 为仓内适配器），见 [M1b 总结](../evidence/m1b-summary.md)。产品验收 not-run。
