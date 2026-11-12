# 数据、进程与外部输入约束

触发：身份、定位、数据库、迁移、文件、凭据、IPC、内容渲染、提供者、日志和下载变更。协议正本为 [领域模型](../design/domain-model.md)、[总体架构](../design/architecture.md)、[外部扩展](../design/external-providers-and-acquisition.md)。

## 1. 数据与迁移

- 业务身份独立于路径、页面、外部站点和内容哈希。内容版本、对象修订、schema、解析规范化版本分别管理；改变偏移规则必须处理旧锚点。
- 已确认保存的数据必须由持久化提交证明；UI 不能乐观显示“已保存”代替实际确认。写入、修订、引用和事务事件保持同一明确提交边界。
- 原始附件、用户记录和不可重建的位置映射不能当缓存清理。未知插件对象保留封装、payload、引用和附件清单，可完整导出。
- 录音按每次采集的保留选择区分长期附件与仅供处理的临时音频。选择不保留时，成功转录先持久化文本、原始时间区间和来源映射，再清理临时音频；失败/取消显示可恢复或待清理状态，按明确策略处理。切换设置不追溯删除已保存录音；本地清理不代表远端已删除。详细契约见[语音数据](../design/domain-model.md#9-语音采集与位置映射)。
- 迁移声明输入/输出版本、旧数据夹具、备份、失败恢复和降级策略。已经随版本交付的迁移保持不可变，修复追加新迁移；未发布实验迁移只有在确认无共享/用户数据依赖后才能重整并记录依据。
- 备份须为一致快照并验证附件覆盖，不能只复制运行中 SQLite 的一个文件。恢复先在隔离位置验证；代码回退不等于数据可逆迁移。
- Agent 任务冻结的图像与视频片段按内容哈希存一份（`agent_media`）；已结束的运行过了保留期去掉引用，快照保留来源与尺寸，没有引用的内容删除。清理与重试并发时，重试要么拿到完整的原字节、要么按过期处理。schema v13 的迁移把 v12 快照里内联的图像搬进这张表，迁移前后被引用图像的哈希相同。
- Agent 提出的待审操作存入 `agent_proposals`（schema v14，迁移前备份 `manga.sqlite.premigrate-v13`，失败回滚、中断可续）。提议创建与工具回执一起保存；Agent 只收到编号、状态与摘要，反向引用等完整影响预览只交给所有者。确认以条件更新（`WHERE status = 'pending'`）原子转为 `applying`，经所有者命令以提议编号幂等执行；同步修改在所有者处理函数里重新核对对象与依赖修订，并把效果与 `operations` 成功回执一起提交。`command_requests` 只代表开始，不证明执行完成。项目包发布前保存仅限主进程的输出摘要，重启可核对成品大小与哈希后补回执；粗剪任务与提议关联一起登记，实际输出完成才是 `applied`，取消或中断为 `failed`。没有完成证据的操作回到 `pending`，不自动重跑。删除对话或项目时连同提议一并清除；提议进入完整备份，不进入可移植项目包（`.manga-project.zip`）。
- “从最近移除”与跨上下文最远进度在 schema v15 建立（A-129，迁移前备份 `manga.sqlite.premigrate-v14`，失败回滚、中断可续、幂等、旧版拒绝 v15 数据库）：新增 `recent_dismissals` 表记录从“最近”视图隐去的作品与独立资源（作品与资源被删时由触发器清理），只影响“最近”列表展示，不删任何进度、笔记或材料；新增 `progress_furthest` 只读视图供资源库卡片、“按进度”排序与作品主页汇总各上下文最远进度，保留 `progress_latest` 供“最近打开”排序。
- 默认移除条目、停用模块、卸载代码与删除源文件/用户数据分别处理。测试仅操作独立临时目录与合成夹具。

对应 POC-01、POC-06、AT-04、AT-15、AT-17、AT-18、AT-48。当前没有真实数据库或已发布 migration，上述要求在建立相应实现时落实，不需要伪造历史迁移文件。

## 2. Electron 与文件边界

- Renderer 无 Node 特权，启用隔离与沙箱；preload 只暴露按用途定义的窄接口，不暴露通用 shell、SQL 或任意 IPC。
- 可信入口校验真实窗口/frame、输入 schema、资源归属、有效授权与目标修订；模型或 renderer 自报 actor/projectId 不能授予权限。
- EPUB、HTML、Markdown、字幕、模型结果和本地压缩包均按不可信材料处理；来源中的指令不能变成宿主执行命令。
- 文件解析检查路径穿越、符号链接/Windows 重解析点、大小、解压比和授权目录；平台路径通过接口取得，不在领域层硬编码盘符。
- 外部进程使用程序路径和参数数组，禁止把用户路径、模型文本或提供者文件名拼入 shell 命令。

验证要覆盖中文、空格、特殊字符、离线磁盘、同名不同内容和受限目录；Electron 进程隔离不等于第三方 Node 插件安全沙箱。

## 3. 凭据、网络与日志

凭据经平台凭据接口管理，业务配置只存引用。Electron 上用 `safeStorage` 的异步接口：所有读取都经 `packages/app-core/src/credentials.ts` 的同一个读取函数，平台要求换新密文时只在密文未被改动的前提下写回一次，写回失败不影响这次读取；加密不可用时拒绝保存并给出 `CREDENTIAL_UNAVAILABLE`，不写明文。源码里不留同步接口（只有生成旧版 Profile 的样本脚本例外，`scripts/check-deps.mjs` 守护）。工具、上下文、资料包、普通日志和报错不得回显密钥、签名 URL 或认证头。日志保留任务/对象 ID、错误分类和必要摘要，默认不记录整本正文、原始录音或私人材料。诊断采集要有明确范围与保留清理方式。

提供者网络访问由宿主检查用途、目标和重定向。元数据查询不自动授权媒体上传、下载或远程进度写入；用户明确配置的本地服务按独立授权处理。来源关闭后停止新增访问，已有本地资料继续可用。

下载执行遵循外部扩展设计的文件发布与入库回执协议，不能把 `rename` 或 HTTP 200 当作完整成功；跨卷、ETag 变化、取消和崩溃恢复须有故障样本。对应 AT-39—43、AT-46、AT-47。

弹幕的 AppId 与 AppSecret 是发行方的凭据：构建时从环境变量注入主进程，签名只在主进程里算，不进渲染进程、预加载桥、仓库、日志、证据与报告；用户自己填的一份存进保险库，只留引用。跳转只跟随 https 的弹弹play 域名且不带签名头；403、429 按服务端要求处理，不自动反复重试。Agent 调用记录先脱敏再保存（密钥原文、认证头、令牌形状的文字、本机路径、图片内容），只存本机，不进备份与资料包。

资源文件只经“资源库位置 + 相对路径”读取（`packages/app-core/src/library-locations.ts`）：库外文件不能读、不能导入，重新定位只接受资源库位置下的文件；新增读取资源文件的入口必须走这个解析函数，不得自己拼路径；每个打开资源或取其内容的命令先做同一个可打开检查（`checkOpenable`：库外与文件不在位置里分别给出原因，包括有播放副本的视频），界面打开前先问 `library.openable`，不能打开时不进阅读器，新增这类命令必须接入这个检查并补拒绝用例。用户产出的文件放在作品内容文件夹里，位置规则只写在 `work-folders.ts` 的一个函数里（关联了条目的在 `<媒介>/<条目名>/`，否则在 `未分类/<资源文件名>/`）；移动、重排与补写笔记文件都先记进 `file_moves` 日志、在迁移事务之外后台进行、可中断后重做，不覆盖同名文件，原件在目标写好之前不删；笔记的 Markdown 文件是单向写出的副本，数据库是正本；删除条目不删任何文件。

涉及这些边界的改动增加相关验证和迁移说明；已有授权范围内的修复正常推进，不因“安全”关键词额外要求用户反复确认。

所有安装目录外的应用生成内容必须有可见、可配置的位置，开发与正式通道隔离。默认位置按 A-118：用户创建的文件在系统登记的“文档”下的 `manga`（下载在“下载”下的 `manga`），应用自己管理的数据在 `%LOCALAPPDATA%\manga`（开发版 `manga-dev`）；所有路径统一用小写的 `manga`；不写漫游的 `%APPDATA%`，不在用户主目录下建文件夹。具体分区、凭据密文与启动定位要求见 [领域模型](../design/domain-model.md#112-文件分区)。迁移前验证授权与空间，切换前校验，失败可恢复；不自动搬动仅索引的外部原件。从旧位置（`<文档>\manga\<通道>`）升级只复制应用数据、核对后写新指针，用户文件留在原处、记成分区覆盖，旧文件只在用户点“清理旧位置”后删除。卸载程序不删应用数据与用户文件（A-119）。

模型外部调用按任务用途隔离：原始音频只允许路由到用户独立配置且授权的 ASR，LLM 只接收转录文本。ASR/Embedding 未配置或与任务错配时，必须在凭据解析和网络请求前失败，不沿用文本测试配置。参考模型目录或兼容 API 名称不能扩展数据发送授权。

## 4. 应用更新与安装包安全（A-125）

- **独立的更新签名密钥：** 正式版安装包使用独立于第一方插件密钥的 Ed25519 密钥对签名（私钥 `%APPDATA%\manga-release\update-signing.key` 不入库且不进日志或证据，公钥 `%APPDATA%\manga-release\update-signing.pub` 内置在 `packages/app-core/src/update/signature.ts` 的 `RELEASE_UPDATE_PUBLIC_KEYS`）。两把密钥职责隔离，一把泄露不影响另一把。
- **绑定版本与文件名的分离签名（`.sig`）：** 发布时为 `manga-setup-<版本>.exe` 生成分离签名 `manga-setup-<版本>.exe.sig`。签名原文是 UTF-8 的 `manga.update.signature.v1`、`version <版本>`、`fileName <文件名>`、`sha512 <base64>` 四行，每行末尾都有换行。`.sig` 另有字节数、密钥编号与签名时间；字节数由文件、清单和签名记录交叉核对，不在签名原文中。版本和文件名的绑定防止合法旧包被重命名冒充新版本。
- **`publisherName` 强制触发与纵深防御校验：** 在未做 Windows Authenticode 代码签名时，`electron-updater` 6.8.11 的 `NsisUpdater.verifySignature` 只有在 `resources/app-update.yml` 含有 `publisherName` 时才会调用自定义 `verifyUpdateCodeSignature`，否则直接返回 `null` 跳过校验。因此正式版打包时强制写入 `publisherName: ["chialecode"]`（由 `checkAppUpdateConfig` 与测试守护，去掉时测试必须失败），同时 `UpdateService` 在标记更新“已就绪”以及调用安装程序（`restartToUpdate` / `installOnQuit`）前独立执行二次 Ed25519 签名、`SHA-512`、版本号与文件名核对——任何路径都绝不执行未经 Ed25519 校验通过的安装包。
- **拒绝路径与清理：** 签名不符、文件被篡改 1 字节、缺失 `.sig`、缺失 `publisherName`、清单版本号不高于当前版本（`allowDowngrade = false`）或更新源地址非 `https://`（仅本机回环测试显式开启时例外）一律拒绝，立即删除已下载的临时文件，保留当前版本，向用户展示中文原因（`UPDATE_VERIFY_FAILED`）并写入操作日志（`update.rejected`）。
- **下载与执行之间的校验：** 正式版先检查 `app-update.yml` 的 `publisherName` 与固定的 `updaterCacheDirName: updater`，拒绝重复或冲突字段。真实下载走上游 `NsisUpdater`，所有请求与重定向都检查 HTTPS，并去掉上游的用户分组标识。已就绪更新绑定验签 receipt；保存完成后重新读取文件与 `.sig` 验签，安装辅助程序按 receipt 中的预期 SHA-512 在准备和执行前各核对一次。
- **隐私与更新前备份：** 正式版检查更新只访问 GitHub Releases（遵循系统代理），请求头只带应用版本与平台（`MANGA/<version> (<platform>; <arch>)`），不携带任何用户标识或本地数据；开发版与 `pnpm dev` 不做联网更新检查。安装前等待界面保存回执、录音保存与不可取消写入，再用 SQLite 快照生成 `manga.sqlite.preupdate-v<旧版本>.sqlite`，包含已提交但仍在 WAL 中的数据，通过临时文件原子替换。保存、备份或辅助程序准备失败时保留当前应用、恢复交互和待更新元数据，允许重试。资料库 schema 的升级仍先生成 `manga.sqlite.premigrate-v<旧版本>` 备份。
- **启动失败的退路与回退安全（A-127、LOOP-32）：** 正式版安装更新前将当前已验签的安装包与 `previous.json`（含版本号、`sha512Hex`、前后 schema 版本与备份路径）保存在 `<应用数据根>\cache\updater\previous\`，并写入 `last-installed.json`。打包正式版更新后的前三次启动由极薄入口 `launch-guard.ts` 跟踪启动完成情况（开发版与 `pnpm dev` 不进入该守卫；故障注入开关 `MANGA_TEST_FAIL_LAUNCH=1` 仅在 `testIdentity === true` 时生效）：连续两次启动未到达主窗口就绪时，第三次启动在加载完整主进程前弹出原生对话框，绝不静默自动回退。仅当上一版安装包存在且重新计算 `SHA-512` 与 `previous.json` 一致时才提供“回到 <上一版>”按钮，用户确认后与安装辅助脚本拉起安装包前均再次核对 `SHA-512`。若新版本已升级过资料库 schema，回退前先把当前 `manga.sqlite`（连同 `-wal`/`-shm`）改名为 `manga.sqlite.rolledback-<ISO 时间戳>` 保留现场，再经临时文件 `.restore.part` 原子恢复 `manga.sqlite.premigrate-v<旧 schema>`（不存在时回退到更新前 `preupdate` 备份），写入 `update-skip.json` 跳过该故障目标版本（可在“设置 › 更新”取消跳过）与 `rollback-record.json`（下次启动记入操作日志）。

<a id="light-open-isolation"></a>
## 5. 轻量打开的数据隔离与“打开方式”注册（A-128）

- **严格限定在 `<应用数据根>\light\`：** 轻量打开进程（`--manga-light`）只读写对应通道的 `%LOCALAPPDATA%\manga\light`（开发版为 `manga-dev\light`），绝不打开或创建 `manga.sqlite`、资料库指针、`locations.ts`、用户“文档 / 下载”目录或漫游 `%APPDATA%`，且零联网请求（不检查更新、不调外部元数据或模型）：
  - `runtime/`：Chromium 的 `userData` 与 `sessionData`（在 `requestSingleInstanceLock` 前设定，与完整应用的 `runtime/` 互不抢锁），以及进程握手文件 `light-instance.json`、`quit-request.json`、`quit-ack.json`；
  - `positions.json`：最多 500 条 LRU 位置记录，键仅为归一化绝对路径、文件大小与修改时间的 `SHA-256` 十六进制摘要（文件夹为路径加 `\ndir` 的 `SHA-256`），值只有已知字段：视频为 `{ kind, positionMs, durationMs, finished, at }`，漫画为 `{ kind, page, pageIndex, pageCount, finished, at }`，其中 `page` 是页面 id（图片文件名或归档内条目名）的 `SHA-256`，**不含任何明文路径、文件名或页面名**（读到旧格式里的明文页面 id 时改写为摘要）；视频播到距结尾 5 秒内（或已播完）时下次从头开始；从资源管理器打开某张图片时从这一张开始，不套用该文件夹记住的页；
  - `window.json`：记住上次轻量窗口的宽高与坐标；
  - `cache/`：`play-copies/` 与 `index.json`（`JsonPlayCopyStore`，上限 2 GiB，超限按 LRU 清理未在使用中的播放副本）及会话临时目录 `work/<sessionId>/`；
  - `logs/`（含 `crashes/`）：仅记错误分类与摘要，不记明文用户文件路径。
- **更新与 `install-dev` 退出握手：** 完整应用执行 `UpdateService` 重启/退出更新，以及 `scripts/stage/install-dev.mjs` 更新开发版前，通过 `askLightToQuit` 向同通道 `light/runtime/quit-request.json` 写入退出请求并等待最多 10 秒：轻量进程保存当前播放/阅读位置、写出 `quit-ack.json` 后干净退出；若超时或被拒绝则中止本次更新并提示“请先关闭轻量播放窗口”，不强杀轻量进程。轻量进程自身不做自动更新检查与下载。
- **按用户 `HKCU` 注册“打开方式”，不抢默认关联：** 安装程序只写 `HKCU`、不写 `HKLM`，且禁止使用 `electron-builder` 的 `fileAssociations`（由 `checkInstallerConfig` 与测试守护，防止覆写 `.<ext>` 默认值抢走用户原有默认播放器/看图软件）。共注册 21 个扩展名（13 个视频：`.avi .flv .m2ts .m4v .mkv .mov .mp4 .mpeg .mpg .ogv .ts .webm .wmv`；1 个漫画包：`.cbz`；7 个图片：`.avif .bmp .gif .jpeg .jpg .png .webp`；`.zip` 与文件夹只支持拖入、窗口内选择或命令行打开，不进系统“打开方式”）：
  1. `HKCU\Software\Classes\<ProgID>`（正式版 `Manga.Video` / `Manga.Comic` / `Manga.Image`，开发版 `MangaDev.*`，测试身份 `MangaTest.*` / `MangaDevTest.*`）：友好类型名、`DefaultIcon` 与 `shell\open\command = "\"<exe>\" --manga-light \"%1\""`；
  2. `HKCU\Software\Classes\.<ext>\OpenWithProgids`：写入名为 `<ProgID>` 的空字符串值（`REG_SZ`），不改 `.<ext>` 的 `(Default)` 默认值与 `UserChoice`；
  3. `HKCU\Software\Classes\Applications\<exeName>`：`FriendlyAppName`、`DefaultIcon`、`SupportedTypes`（21 个扩展名）与 `shell\open\command`；
  4. `HKCU\Software\MANGA\<通道键>\Capabilities` 与 `HKCU\Software\RegisteredApplications`：登记应用描述与 `FileAssociations`，供 Windows“设置 › 默认应用”按扩展名或按应用切换，并调用 `SHChangeNotify(SHCNE_ASSOCCHANGED, ...)` 刷新外壳缓存。
- **卸载与通道隔离清理：** 卸载脚本只删除本通道自己的 `ProgID`、`OpenWithProgids` 值名、`Applications\<exeName>`、`Capabilities` 与 `RegisteredApplications` 值；父键（`.<ext>\OpenWithProgids`、`.<ext>`、`Software\MANGA`）通过 `MangaDeleteBareKey` 仅在无任何子键且无任何值时才删除，绝不清理其他通道或用户已有默认关联。`stage installer` 对真实 `HKCU` 相关键做前后快照比对，确保测试身份卸载后零残留。
