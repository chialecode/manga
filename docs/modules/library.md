# 资料库模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.library` / 资料库 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）：分块全文索引、原文/托管导入、四类候选解析、资源库路径与后台增量扫描、作品主页、不可用资源的内容视图与重新定位、同条目作品的版本显示（A-47、A-50、A-67—A-69）；解析引擎中 PDF 经 PDF.js，EPUB/MOBI 为仓内适配器，均未验收；资源位置改为“资源库位置 + 相对路径”并关闭所有绕开资源库的入口、作品内容文件夹、截图（A-79、A-80）已实现并自检；第三轮返工（A-86—A-88）：打开前的统一核对、删除条目与“未归入作品”、内容文件夹改按条目与“未分类”放、笔记写成 Markdown 文件、schema v11 已实现并自检 |
| 需求 / 设计依据 | LIB-01、LIB-02、LIB-04、NOTE-05、DATA-05；[领域模型](../design/domain-model.md)、[Agent 协议](../design/agent-and-plugins.md) |
| 包与公开入口 | `packages/app-core`（`src/library-scan/`）；另有 `library.list`、`library.importDocument`、`library.read`、`library.readSlice`、`library.rebuildIndex`、`library.repairSource`、`library.resourceContent`、`library.openable`（只读，界面在打开前问）、`works.counterpart`、`works.deletePreview`、`works.delete`、`works.unassigned`（只给所有者，不进 Agent 的命令表）；资源库路径与扫描：`library.paths.list/add/update/remove/ensureDownloads`、`library.scan.start/cancel/status/setSchedule`（仅所有者；`library.scan.status` 对任务只给目录名，不含本机路径）；截图 `screenshot.save/list/get/image/delete`；作品内容文件夹 `workFolders.list/forWork/rename` |

## 1. 责任与依赖

拥有资源身份、修订、检索投影和资料包导入导出。不拥有笔记编辑器、完整阅读器或下载引擎。Feature `library`；Facet `service`/`ui`/`worker`；解析 worker 随模块启停。无 AI 时仍可导入与检索。

## 2. 数据与公开能力

实体：Work、Resource、ResourceRevision、FileLocation、text fragments。查询在返回正文前按授权过滤。`library.list` 使用书名 query 和 created_at/id 稳定游标，limit 为 1—200（默认 100），total 是当前授权及查询条件下的完整资源数，不随游标减少；一资源只取最新修订，workspace 首屏遵守相同资源粒度。搜索续页必须保留 query；仅会话/偏好刷新不清空已加载结果。普通资料包导入只接受空 Profile；冲突导入另有预览与逐项决策入口，其依赖矩阵（skip/duplicate/replace 的混合组合）由 `tests/reading/*` 与 `tests/package/*` 守护，并已验证关闭。导入校验清单引用、附件路径/哈希与预算，写入全部表并重建检索索引（含笔记授权范围），先发布附件硬链接再提交事务；普通失败回滚事务并清理自有链接与暂存。进程中断由 `recovery_jobs` 记录，重启后经 `settings.recoverJobs` 回滚孤儿文件，不触碰非本任务创建的文件。

### 资源库路径与后台扫描（A-50）

数据模型见[领域模型 4.4](../design/domain-model.md#44-资源库路径与后台扫描)。实现：`library_paths`、`library_files`（路径、相对路径、大小、修改时间、指纹、状态与上次所见的扫描）、`scan_jobs` 三张表（schema v8 追加）；`ScanService` 一次只运行一个扫描，其余排队；目录遍历在 `worker_threads` 的 worker 中进行，主进程只收批次、按单个文件一次小事务写库，每处理一个文件让出一次事件循环；进度通知节流为约每 200 ms 一次；`SCAN_LIMITS` 为 50 000 个单位、深度 8，超出时标记 `truncated` 且不把未列出的文件记为消失；无权限或中途消失的目录记入 `unreadable`，不使整次扫描失败，也不把其中的文件标为不可用。作品划分、增量跳过、不可用标记与移动重关联按设计实现，导入一个单位用与目录导入相同的代码（`importScanUnit`），所以扫描与导入产生同样的作品。路径的“自动扫描”与全局计划（启动时、间隔 30 分钟/1/6/24 小时或关闭，默认启动时与每小时）由应用内计时器触发，睡眠唤醒后不重复补扫；`add` 一个路径会立即扫描一次。扫描不联网；封面与文件自带资料在扫描结束后由后台任务低优先级读取。

**规模表现（bench，合成数据）：** 5000 个小说文件（20 个系列目录加 3000 个散文件）一次扫描在开发机上约 13—33 s（随机器状态变化），期间主进程事件循环延迟 p99 13.3—31.8 ms、书架与设置所用命令的应答 p95 7.4—19.7 ms（自检与复核的三次运行，门槛均为 100 ms，数据见[执行状态](../delivery/status.md#验证基线)）。基准发现并处理了两个问题：`resource_revisions(resource_id, created_at)` 与 `file_locations(resource_revision_id)` 没有索引，每个资源的“最新修订”与“所在文件”查询都读整张表，3000 多个作品时扫描后的封面与资料读取一次占满主进程约 38 s；后台任务队列在同一轮事件循环里连续跑完所有不等待的任务。已在 DDL 里补上两个索引，任务队列在两个任务之间让出一轮事件循环（任务被取消时仍会启动并看到已取消的信号）。

### 资源位置：资源库位置 + 相对路径（A-80）

`packages/app-core/src/library-locations.ts` 是把“资源库位置 + 相对路径”换成磁盘路径、把磁盘路径换成这一对的唯一地方；读取资源文件的所有入口（阅读、探测、播放句柄、扫描、重新定位、资料包恢复）都经它，其他代码不许再拼接。`file_locations` 的 `library_path_id` 指向资源库位置，`relative_path` 是相对它的路径（统一用 `/`，`.` 表示位置本身）；不在任何资源库位置下的记录 `library_path_id` 为空、把旧路径留作文字（`legacy_path`），资源标为库外，不能打开阅读，但作品主页与“资源不可用”视图仍列出它的笔记、书签、录音与对话，并提供“把所在文件夹加为资源库位置”。

- **打开前核对（A-86）：** 同一个文件里的 `checkOpenable` 回答一个资源能不能打开，三种结果：`open`；`outside`（库外，附所在文件夹）；`missing`（位置还在、文件不见了，附资源库位置与相对路径，位置所在的磁盘没有连上时另有说明）。`assertOpenable` 用它，库外与文件丢失分别以 `LOCATION_UNAVAILABLE` 拒绝，`details.reason` 是 `outside-library` 或 `file-missing`。先调用它的命令：`library.read`、`library.readSlice`、`library.readOriginal`、`comic.pages`、`comic.pageHandle`、`comic.pageHandles`、`video.probe`、`video.subtitles`、`video.audioTracks`、`video.frameIndex`、`video.keyframes`、`video.playbackPlan`、`video.playCopy`、`video.handle`（原文件与播放副本都查）、`video.subtitleHandle`、`video.fonts`、`material.frame`、`material.region`、截图保存，以及弹幕匹配里需要文件指纹的那一步；Agent 的读取经过同样的命令，所以同样受限；只查看、取消、移除而不读文件的操作（播放副本的状态、取消与移除，取消帧时间表）仍然可用（`tests/library/open-check.test.ts`）。资源库位置被移除时（`library.paths.remove`），已发出的媒体句柄作废，并发出通知 `library.pathRemoved`（带位置与受影响的资源），打开着的窗口据此关闭阅读器；会话与进度保留，`workspace.sessions` 给每个会话一个 `openState`，左栏据此不再列出打不开的资源。界面一侧见[交互设计 3.8](../design/interaction-and-workflows.md#38-界面2026-10-10)：所有入口经 `App.tsx` 的一个 `openGate`。
- **更改路径：** `library.paths.update` 可以换文件夹；先抽样核对新路径下的文件指纹与原记录一致，一致才改位置记录，资源、进度与用户内容全部保留；不一致时拒绝并说明。
- **重新定位：** 只接受资源库位置下的文件，选择器默认打开该位置，选到库外时提示先把文件夹加为资源库位置；视频与漫画只认同样内容的文件。
- **应用管理的位置：** `library_paths.managed = 1`，跟随资源分区，用来存放粘贴的文本和恢复的媒体；资料包恢复时媒体写进用户选的资源库位置，或者不恢复媒体，不再写进附件目录。以前托管在附件目录的媒体在升级时复制进应用管理的位置（原文件保留，使升级前的备份仍可用）。
- **入口收口：** 导入单个文件的入口只接受资源库位置下的文件；“转写音频文件”改为“导入录音文件”，先复制进作品内容文件夹再转写；测试用 `libraryRoot()` 辅助函数把临时目录登记为资源库位置。

### 作品内容文件夹（A-79）

`packages/app-core/src/work-folders.ts`。用户为一部作品产出的内容（截图、录音、导入转写的音频、粗剪文件与导出、每条笔记的 Markdown 文件）都写进位置分区 `works`。放在哪里只由一个函数 `ownerOf` 决定（A-88，取代 A-79 里按作品放的结构）：

- 资源所在的作品关联了条目（`work_links` 里最近确认的 Bangumi 关联）：`<媒介>/<条目名>/`，同一条目、同一媒介的资源共用（A-68）；
- 其他资源：`未分类/<资源文件名>/`，每个资源文件一个；条目被删除或取消关联后也在这里；
- 只挂在作品上、没有资源的文件：条目的文件夹，没有条目时是 `未分类/<作品名>/`。

子文件夹是 `截图`、`录音`、`粗剪`、`导出`、`笔记`。`work_folders` 记录归属（条目 `subject`、作品 `work`、资源 `resource`）、媒介、相对目录与创建时间，`work_files` 记录其中的每个文件（类型、子目录、资源与作品、关联对象、大小；作品可以为空）。文件夹名在创建时由条目名、作品名或资源文件名（去掉扩展名）净化（去掉非法字符与保留名，最长 80 字）确定，重名时先加上级文件夹名、再加序号，作品改名时不跟着改，`workFolders.rename` 可以按当前标题重命名。

**文件跟着规则走。** 关联或取消关联条目、删除条目、把资源归入别的作品时，`settle` 把受影响的文件移到规则给出的文件夹：不覆盖同名文件（加序号），每个移动先记进 `file_moves` 再做，进程中断后下次启动接着做；移动后空了的文件夹删去。`product-app.ts` 的 `followFiles` 在这些命令之后调用它，失败只记日志，不撤销命令。

**笔记写成文件（Q-31）。** `packages/app-core/src/note-files.ts`：`NoteFiles` 跟随已提交的 `note.*` 事件，每次保存排一次写入，连续保存合并成一次（等待 600 ms，应用退出前 `flush`）；写入时用 `mdast-util-to-markdown`（固定在 2.1.2）把笔记块转成 Markdown：标题、段落、列表、引用、代码，转义交给库；文件开头是笔记标题，接着一段引用写“由 MANGA 生成，在这里修改不会写回应用”、作品、资源、第一个带锚点的块的位置与标签；嵌入的截图在同一文件夹的 `截图/` 里时写成相对链接，否则写成文字说明。标题改变时文件改名，笔记删除时删文件（空了的文件夹也删），恢复时重写。既没有资源也没有作品的笔记（全局笔记、项目笔记）不写。文件只是一份副本：在文件里改的内容不读回，数据库是笔记的正本；若以后要双向同步，登记为后续 loop。

**升级后的重排。** schema v11 的迁移只改表（见[领域模型](../design/domain-model.md)）；已有的文件按新规则就位、已有的笔记补写文件，是启动后的后台任务 `settleLayout`：`WorkFolders.settleAll` 每批 50 个文件，批与批之间让出事件循环，`NoteFiles.syncAll` 接着补写笔记；元数据键 `workLayout` 为 `pending` 时才做，全部做完才改为 `settled` 并记一条日志；中途退出或失败，下次启动重做，已就位的不再动、笔记文件不重复写。

文件夹不得与资源库位置重叠（否则扫描会把截图当成漫画）。书签、对话仍只在数据库里。已有录音在升级时按录音会话找到资源与作品迁移进来，带日志（`file_moves`），可中断后重做。

<a id="screenshots"></a>
### 截图（NOTE-05）

`packages/app-core/src/screenshots.ts`。页面按来源的尺寸画出图片（视频是 `video` 元素自己的帧，漫画是页的原图或框选区域）交给 `screenshot.save`，服务给它在作品文件夹里的位置，把来源写进 `screenshots` 表，并以 PNG 的 `iTXt` 文本块（关键字 `manga.screenshot`）嵌入同样的信息，使单独流传的文件仍说得清出处；数据库是正本。元数据含作品、资源与版本、尺寸与格式、截取时间；视频另有时间（毫秒）、帧号、当时的字幕文本、音轨与字幕轨、倍速以及是否合成了字幕或弹幕；漫画另有页号与页标签、跨页、阅读方向与区域（页面归一化坐标）。截图是 `screenshot` 对象，可经引用与互嵌插入笔记、白板与导图，点击回到来源。`screenshot.list`、`screenshot.get` 对 Agent 开放，受资源范围与防剧透约束，不返回图像与本机路径。

## 3. Agent 与界面

资源库页在设置里（“基础设置 → 资源库”）：添加路径（经宿主对话框取得目录句柄，Agent 不能添加）、媒介、自动扫描开关、立即扫描、取消、上次结果与每个路径的文件数；标题栏在扫描时出现进度入口。没有独立的“导入”入口：资源库的内容由资源库路径下的文件决定（A-69），扫描只登记、不复制、不移动。资源库完全为空时应用打开设置的“资源库”页。书架的卡片进入作品主页（页面），“阅读/观看”才打开文件。

Agent 工具 `library.find` / `library.getResource` / `library.contextSnapshot` 使用宿主发放的 enumerated grant。模型不能提供路径或扩大 allowlist。

### 用户内容的保留、重新定位与版本（A-67、A-68、A-69）

- **文件消失不带走用户的内容。** 扫描把找不到的文件标为不可用，不删除资源，挂在资源上的笔记、书签、录音和资源会话的对话都留着。作品主页上不可用的资源仍可进入“资源内容”视图（`library.resourceContent`：资源、进度、笔记、书签、录音与对话），视图里有“重新定位…”（`library.repairSource`，保留资源与全部绑定）。同指纹的文件出现在资源库路径下时，扫描自动把它认作原资源的文件（`domain/relink.ts`，只对最新修订、不对应用自己托管的副本生效；原文件仍在时视为第二份拷贝，照常作为新资源导入）。
- **删除条目（A-87，AT-101）。** `packages/app-core/src/works-delete.ts`：`works.deletePreview` 返回会删除与会保留的数量，`works.delete` 在一个事务里做完。条目是一部作品，或同一个 Bangumi 条目、同一媒介的一组版本（`entryGroup`），删除整组。删除的是作品记录，在线资料的关联、快照、候选、改过的字段与封面选择，没有其他作品用到的角色与制作人员，书架状态与版本分组，以及只由在线资料推出（未经用户确认）的弹幕匹配。保留的是资源与文件、进度、书签、笔记、录音与转写、截图、对话、用户确认过的弹幕匹配、作品词典与术语：资源的 `work_id` 置空并记下 `left_work_at`，作品的标题记进 `removed_works`，只挂在作品上的内容仍指向这个作品标识，所以显示删除前的标题（设置的记录与词典、对话列表、笔记文件的来源）。之后 `works.unassigned` 列出这些资源（书架与总览末尾的“未归入作品”一组），`works.moveResource` 把它们放回作品（清空 `left_work_at`），“匹配条目…”为它新建作品后关联；扫描与导入看到 `left_work_at` 不为空的资源时不重新分组（Q-30）。删除写操作日志，随后用 `followFiles` 把它们的文件移到各自的 `未分类/<资源文件名>/`；项目材料、白板、导图里引用这部作品的地方显示“已不存在”（现有机制）。
- **作品清空后保留。** 最后一个资源被移走时，只要作品持有用户写的东西（术语、作品词典、改过的字段、笔记、对话），作品就保留为“没有资源的作品”（`workHoldsUserContent`），作品主页提示“这部作品的文件都不在了”；只持有文件与在线条目提供的资料的空作品才随之清除，因为没有东西丢失。文件仅仅消失（不可用）时作品和资源都不动。只有用户明确删除才删除用户内容。
- **库外资源。** 以前单独导入、文件不在任何资源库路径下的资源（`works-versions.ts` 的 `outsideSql`）在作品主页标“库外”，并提示把它们所在的文件夹加为资源库路径（“添加资源库位置”）；它们照常可读、可记笔记。下载目录在第一次用到时登记为资源库路径（`library.paths.ensureDownloads`），下载完成的文件因此都在资源库路径下。
- **版本是派生的，不迁移数据。** 关联到同一个 Bangumi 条目（`work_links` 里该作品最近确认的 `bangumi` 关联）、同一媒介、且至少有一个资源的作品，按 `works-versions.ts` 的 `groupKeySql` 归为一组：总览与三个资源库（`works.list` 的分组模式）每组只列一个入口，入口取最近打开的版本，计数按版本计，分页保持完整；作品主页的“版本”选择器列出同组作品（`works.counterpart` 找到另一个版本里的同一集或同一卷，按位置比例对齐进度）。取消关联就拆开，没有数据被合并或移动；未关联的作品各自显示。schema 版本不变（v9），没有数据迁移。

## 4. 生命周期与兼容

停用撤销 UI 入口、取消解析并拒绝旧代次结果；重新启用创建新 worker。用户数据保留。产品库从 v4 备份后升级到 schema v5，只追加全文分块列；DDL 与版本发布在同一事务，A 已补中断后重试回归。TXT/EPUB/MOBI/PDF 由仓内可替换适配器解析，`accepted` 仍为 false。版本、库外标记和不可用状态由现有行派生。schema 从 v9 升到 v10 一次完成（见[领域模型](../design/domain-model.md)）：迁移前先把数据库复制成 `manga.sqlite.premigrate-v9`（复制完成后才改名，中断的复制不会被当成备份；Agent 调用记录不进这份副本），DDL、位置换算与版本发布在同一事务里，进程在发布版本前中断则整体回到 v9，下次启动重做；需要复制的托管媒体记在 `file_moves`，逐个校验大小，写到一半的副本会被替换，原文件永远不删；回滚就是恢复这份备份，同一迁移可以再次运行得到同样结果；比应用新的库被拒绝而不是读取。schema 从 v10 升到 v11 同样一次完成（备份是 `manga.sqlite.premigrate-v10`，迁移只改表、不移动文件；文件重排是启动后的后台任务，见“作品内容文件夹”），测试覆盖 v10 资料升级、v9 → v10 → v11 连续升级、迁移与重排中途中断后重做、失败回滚、备份与恢复往返（`tests/library/schema-v11-migration.test.ts`）。

## 5. 验证与未决

AT-11/18/49/51 相关子场景；POC-01/06/08 的断言已由产品测试承担（原型工程已删除）。阅读已合并（PDF 经 PDF.js，EPUB/MOBI 为仓内适配器）。产品验收 not-run。
