# 插件模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.plugins` / 插件 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；信任边界与手动流程见[用户待办](../../USER-ACTIONS.md#checks) |
| 需求 / 设计依据 | PLUG-01—06、AT-34、AT-45、AT-47、AT-48；[Agent 与插件协议](../design/agent-and-plugins.md)、[外部扩展设计](../design/external-providers-and-acquisition.md)、[数据与安全](../dev-rules/data-and-security.md) |
| 包与公开入口 | `packages/app-core/src/plugins/`（`package.ts` 包格式与签名、`trust.ts` 信任库、`service.ts` 安装与启停、`runtime.ts` 进程与消息、`spawn-node.ts`）；契约 `packages/contracts/src/plugin.ts`、`inputs-plugins.ts`；桌面端进程启动 `apps/desktop/src/main/plugin-process.ts`；命令 `plugin.list`、`bundled`、`inspect`、`install`、`enable`、`disable`、`rollback`、`uninstall`、`exportData`、`deleteData`、`trust.list`、`trust.add`、`trust.remove`；界面 `apps/desktop/src/renderer/pages/settings/plugins-page.tsx`、`plugin-dialogs.tsx` |

## 1. 责任与依赖

拥有可安装的插件包：包格式、签名与信任、安装/升级/回退/卸载、各插件的启停与独立进程的运行。插件用来给应用的“位置”（slot）补上一个提供者，并在启用期间打开对应的界面部分（facet）。现在只有一个位置 `acquisition.engine` 和一个界面部分 `acquisition`（下载页）。不拥有插件提供的业务（下载的计划、发布与入库归[下载模块](acquisition.md)）。

Feature `plugins`；Facet `service`/`ui`；无硬依赖。关闭本功能会停掉所有插件进程，已安装的包与数据保留；重新打开与应用启动时，把用户启用过的重新启动（`restore`）。

**信任边界（Q-06）。** 插件包是一个 zip：`manifest.json`、`signature.json` 和 `payload/` 下的文件。签名（Ed25519）覆盖清单的字节，以及每个载荷文件的名字、大小与 SHA-256，所以包里任何内容改动都使签名失败。只有签名密钥在信任库里的包才能安装：信任库由随应用带来的第一方公钥（不可移除）和用户自己选择信任的公钥组成。信任是用到时才查的，不记在已安装的插件上，所以移除一把密钥会停止它签过的所有插件（`reconcileTrust`）。未签名或签名不符、密钥不被信任的包一概拒绝，不提供“仍然安装”的入口。

**进程是故障边界，不是沙箱。** 每个可执行插件在自己的进程里运行（桌面端是 Electron 的 utility process，没有窗口，只用消息与应用通信）。进程可以崩溃、挂起或刷屏而不拖垮应用，但操作系统并不限制它能做什么；因此可执行插件只接受受信任发布者的包。宿主自己只做两件事：不启动不被信任的；只在“插件向宿主提出的请求”这一道门上检查用户确认过的权限（`network`、`files`、`library-import`）。目前宿主开放给插件的请求只有 `log`（无需权限）；插件所声明的权限由用户在安装时逐项确认，并记录在案，但插件进程自己的网络与文件读写不经宿主，由发布者负责。这一点已在安装界面与用户待办中如实写明。

## 2. 数据与公开能力

- 数据：`plugins`（当前版本、上一版本、是否启用、已确认的权限、最近一次错误）、`plugin_versions`（版本、签名密钥、清单、各文件哈希）、`plugin_leftovers`（已卸载但留有数据的插件）；包文件解到 `<profile>/plugins/<id>/<version>/`，插件自己的数据在 `<profile>/plugin-data/<id>/`。
- 包的限制：整个包 256 MiB，解开后单个文件 128 MiB、总计 512 MiB，最多 4096 个文件，清单 64 KiB，名字 200 字符；解包在内存里进行，路径含 `..`、绝对路径、保留名或指向载荷之外的一概拒绝（`unsafe`）；读包从不执行其中任何东西，也不写盘。
- 清单（`manga-plugin-v1`）：`id`、`name`、`version`（三个数字）、`publisher`、`description`、`host.min/max`（应用版本范围）、`permissions`、`entry`（载荷里的 `.mjs/.cjs/.js`；`null` 表示只声明不运行）、`provides`（slot 与 id）、`facets`。没有 `entry` 的包不能填 slot。
- 检查（`plugin.inspect`）：不改任何东西地说明安装会发生什么：动作（安装/升级/同版本/更旧）、信任类别与密钥指纹、签名是否成立、宿主是否兼容、新增的权限，以及若被拒绝的原因与说明（`PLUGIN_REFUSALS`：`format`、`size`、`unsafe`、`manifest`、`entry`、`unsigned`、`signature`、`untrusted`、`incompatible`、`permissions`、`same-version`、`older`、`unknown`、`disabled`、`integrity`、`no-previous`、`running`、`key`、`source`）。
- 安装（`plugin.install`）：来源是用户在宿主对话框里选的文件，或随应用带来的包（`bundledId`）；清单里声明的每一项权限都要由调用方确认，缺任何一项以 `FORBIDDEN` 拒绝，不会静默生效，升级带来的新权限同样需要重新确认。先写进暂存目录、从磁盘再校验一遍、再原子地移到位置并写入记录；应用在安装中途退出时暂存目录在下次启动被清掉，不算安装。同一时间只做一个变更。
- 升级与回退：升级保留被替换的版本；升级后的新版本若无法启动，自动退回上一版本并说明原因；`plugin.rollback` 在用户需要时回到保留的上一版本。升级前在运行的插件升级后继续运行；新安装时可选“安装后启用”（界面默认勾选）。
- 启停：`plugin.enable` 启动进程并等待它报告就绪（10 秒）；每 5 秒探测一次，连续 3 次无响应则结束；停止时给 3 秒优雅退出；调用默认等 30 秒；每秒超过 5000 条消息或单条超过 4 MiB 即被结束；自行退出的插件在 5 分钟内最多重启 3 次，间隔 0.5 秒起按倍数增长，用尽后标为 `failed` 并保留原因。每次启动都再按签名与信任校验一遍已安装的文件。停用后再启用，不需要重新安装。
- 卸载（`plugin.uninstall`）：默认保留插件自己的数据，在列表里以“残留”显示，用户可以导出（`plugin.exportData`，写到所选目录，不覆盖已有文件）或删除（`plugin.deleteData`）；勾选删除数据时一并删除。再次安装同一插件会接回保留的数据。
- 日志：安装、停用、卸载与删除数据记入操作日志（分类“插件”），按插件的名字记录，不含任何文件所在位置；包内容与密钥不进日志。

## 3. 界面与 Agent

界面：设置里的“插件”页，列出已安装的插件（版本、发布者、信任类别、权限、状态、错误、占用）、随应用带来但未安装的包（“只提供，不自动安装”）、信任的密钥（第一方的不可移除）、卸载后留下的数据；安装对话框先显示 `inspect` 的结果（谁签的、要什么权限、新增什么权限、会发生什么），权限逐项勾选确认后才能确认安装。键盘可完成全部操作。

Agent 不能安装、启用或信任插件：插件管理的命令是所有者命令，不在 Agent 的工具清单里，技能也不能授予插件权限或启用插件（AT-44），这一点是有意的、不计划放开。

## 4. 生命周期与兼容

停用本功能：所有插件进程停止，插件提供的位置撤销，已安装的包、数据与用户的启用意愿保留；重新启用后恢复。插件被禁用或卸载时，依赖它的下载按[下载模块](acquisition.md)的规则暂停，不丢任务。应用关闭时先停掉全部插件。数据目录与资料包的关系：插件数据不进资料包，用 `plugin.exportData` 导出。迁移前自动备份，失败回滚。

## 5. 验证与未决

自动：`tests/plugins/plugin-package.test.ts`（包格式、签名、解包限制、路径安全）、`plugin-service.test.ts`（信任、权限确认、升级回退、启停与进程、宿主请求的门、行为异常的插件、随应用的包、操作日志与半写的安装）、`tests/shell/plugins-ui.test.tsx`。窗口：`plugins`（打包应用里的 15 步：随包的插件被提供但没有自己装上、安装对话框在权限被确认之前不能确认、安装后启用并以第一方信任运行、下载页随引擎出现，接着对回环蜂群做一次下载，最后在设置页停用再启用；下载部分见[下载模块](acquisition.md)）。卸载保留数据、信任移除与升级回退由自动测试覆盖，窗口里没有走。

限制：进程不是沙箱，只收可信发布者；第一方签名私钥由构建者持有，不在仓库里，没有私钥无法生成可安装的随包插件（见[用户待办](../../USER-ACTIONS.md#checks)里的备份事项）；清单没有 `needs` 字段，插件之间与对应用模块的依赖不由清单表达；宿主开放的请求只有 `log`，`network`、`files`、`library-import` 的门还没有对应的宿主方法；只有 `acquisition.engine` 一个位置，新增位置要改契约；不支持从网络安装或自动更新，只从本机文件或随包安装。
