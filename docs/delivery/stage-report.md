# 当前阶段交付报告（M10）：安装与自动更新

日期：2026-11-08，A 审查 2026-11-09。角色：Agent B 实现复核与修复；Agent A 集中审查。当前结论：A 审查收敛（[第 13 节](#a-review)），最终源码的 `stage gate` 与本地发布演练通过，待用户授权 push、PR 与合并（[ACT-19](../../USER-ACTIONS.md#act-19)）。分支 `feat/m10-install-update`，基于 `main@c79f49a`；一个未推送的阶段提交，修复与证据都 amend 在里面，不 push、创建 PR、合并或发布。

依据：[阶段计划](stage-plan.md)（C0、D1、W1—W9；A-124—A-126）、[需求 DATA-06、DATA-07](../product/requirements.md)、[验收 AT-157—AT-163](roadmap-and-acceptance.md#at-updates)、[评审规则](../../REVIEW.md)。用户事项统一见 [USER-ACTIONS.md](../../USER-ACTIONS.md)：Q-38 默认继续有效，H-84、H-85、H-92—H-95 保持 not-run；ACT-17 合并后的试运行尚未执行。下一阶段开始时按[治理规则](../governance/documentation-policy.md#stage-cleanup)提炼本报告后删除。

## 1. 结果与证据映射

正式版与开发版分别安装、分别保存资料。正式版下载使用 `electron-updater` 的真实 NSIS 下载、差分与缓存路径，MANGA 在保存、备份和重新验签后管理退出安装；开发版只从当前源码对应的本机产物更新。发布命令先完成完整产物与真实升级演练，再执行独立发布校验；外部发布仍须授权。

| 范围 | 实现位置 | 验证入口与边界 |
| --- | --- | --- |
| C0、D1 | 阶段整理；`pnpm-workspace.yaml`、锁文件、[ADR-0007](../decisions/0007-technology-stack.md) | 保留必要的本地配置、工具、样本、密钥与分支；依赖沿用已查证的发行龄策略 |
| W1 / AT-157 | `packages/contracts/src/version.ts`、`scripts/stage/version-lib.mjs`、构建脚本、“关于 MANGA” | `tests/runtime/version-build.test.ts`、`tests/shell/update-ui.test.tsx`、`version-about` 窗口观察 |
| W2 / AT-158 | `scripts/stage/install-dev.mjs`、`apps/desktop/src/main/index.ts`、`packages/app-core/src/product-app.ts` | `tests/update/install-dev-recovery.test.ts`、`tests/update/release-and-install-dev.test.ts`；真实安装演练验证草稿、重开、正式版隔离与 30 秒超时撤回 |
| W3、W4 / AT-159、AT-160 | `packages/app-core/src/update/`、`apps/desktop/src/main/updater.ts`、更新设置与顶部提示 | `tests/update/update-service.test.ts`、更新 UI 用例；`installer.json.updateRehearsal` 是真实上游下载与 NSIS 执行证据 |
| W5 / AT-161 | `scripts/stage/release.mjs`、`release-previous.mjs`、`release-publish-verify.mjs`、`update-rehearsal.mjs` | `tests/update/release-integrity.test.ts`；本地真实发布演练、上一版产物校验与提取 |
| W6 / AT-162 | 应用图标、`scripts/stage/installer-lib.mjs` 与 `installer.mjs` | `tests/runtime/installer-config.test.ts`、真实双通道安装/覆盖/卸载、Test 身份与真实安装快照 |
| W7、W8 | 阶段门禁、报告、基准、职责正本与用户待办 | 最终 `stage gate` 与脱敏证据；人工检查不由脚本代填 |
| W9 / AT-163 | `.github/workflows/release.yml`、`scripts/check-workflows.mjs`、发布决定与校验器 | 触发、权限、密钥、完整 SHA 与逐命令失败传播的反例；真实 GitHub workflow 运行未执行 |

<a id="w1-versioning"></a>
## 2. 版本与构建对应关系

正式版扫描 `v0.1.<patch>` 标签，从最高补丁号加一；无标签时第一次正式发布为 `0.1.1`。开发版为 `<下一正式版号>-dev.<UTC YYYYMMDDHHmm>`。不为发布改 `package.json` 的版本线。`resources/build.json` 记录版本、通道、提交、构建时间与 schema；`build-provenance.json` 在编译前记录源码、锁文件和构建脚本指纹。

“关于”显示上述信息与许可证，可复制不含本机路径的版本摘要；开发版注明由本机构建自动更新。制作正式包时写入当前发布目标的提交，避免复用门禁包的旧提交显示。

<a id="w2-install-dev"></a>
## 3. 开发版保存、安装与失败恢复

默认安装器来自 `latest-package.json` 中当前指纹对应的精确产物，核对文件名、目录、版本、通道、字节数与 SHA-256；不按目录挑选旧文件。执行前核对开发版安装与运行 marker、可执行文件和 Test 身份，拒绝缺失元数据、不同通道或无握手能力的旧进程。

脚本通过独占锁、唯一请求编号与到期时间发出退出请求。主进程等待真实编辑器保存回执、录音保存与不可取消写入；30 秒内未退出则撤回请求，保持进程运行，写入稍后完成也不能触发迟到退出。安装前后重新核对 checksum，只有新版本以正确的可执行文件、通道和身份报告 ready 才算重开成功。安装失败或退出后文件变更时尝试重开已保存的旧开发版，同时保留失败状态与恢复版本。

CI、`MANGA_DEV_AUTO_INSTALL=0` 或未安装开发版时如实记为 skipped。本轮门禁设置自动安装关闭，真实开发版与正式版的安装和资料受保护；有安装时的路径用隔离 Test 身份自动验证。

<a id="w3-release-update"></a>
## 4. 正式版真实下载与退出安装

主进程将 `UpdateService` 接到实际 `NsisUpdater.checkForUpdates()` / `downloadUpdate()`，使用系统网络和代理。官方 `electron-builder` 分块器生成内容分块的 `.blockmap`，上游引擎完成 Range 差分；没有可用旧缓存或差分失败时退回全量。中断的全量文件按清单绑定保存，下次通过上游 `GenericDifferentialDownloader` 从完整块边界续传，最终验证全部组装字节。旧版本 partial 只清理本实现拥有的文件。

关闭自动下载后，检查只显示可用版本；“下载更新”执行这一次下载，不改变自动下载设置。已 ready 的版本与说明固定绑定验签 receipt，新检查不会替换它。自动检查离线静默，手动检查显示中文原因。

`autoInstallOnAppQuit=false`：上游的自动安装处理不能绕过 MANGA 的保存与备份。用户点重启或正常退出时，MANGA 等待界面保存、停止并保存录音、取消可取消任务、等待写入、刷新笔记文件，再做 SQLite 快照与重新验签。繁忙任务先确认；准备失败恢复窗口交互与元数据，允许重试。

Windows 的短启动器通过 `Start-Process` 隐藏启动独立助手，避免助手随旧应用的 Windows job 一同退出。助手先确认准备成功，再等旧 PID 退出，以 receipt 的预期 SHA-512 在准备和执行前核对安装器，执行真实 NSIS `/S /D=<原目录>`，核对安装后的 build 版本并按需重开。它显式加载自己的系统模块，不依赖调用方的 PowerShell 模块路径；取消后不能迟到安装或重开。完成记录使用无 BOM UTF-8，并标记尝试编号与失败步骤。

<a id="w4-security"></a>
## 5. 验签、备份与拒绝路径

更新 Ed25519 密钥与插件密钥独立。私钥原样保留，签名时只读取，不打印、不覆盖、不入库。签名原文精确为四行 UTF-8，每行末尾有换行：

```text
manga.update.signature.v1
version <版本号>
fileName <安装包文件名>
sha512 <安装包 SHA-512 base64>
```

`.sig` 包含 size、keyId、signedAt 等记录；size 不在签名原文中，由实际文件、清单与记录交叉核对。正式版配置必须含 `publisherName: ["chialecode"]` 和 `updaterCacheDirName: updater`，下载前即检查重复/冲突字段。上游 publisher hook 确实被调用，MANGA 在 ready 和安装前独立验签，辅助程序不能把后来被替换文件的哈希重新当作预期值。

拒绝范围包括：篡改字节（清单 hash 同步变更仍须拒绝）、跨版本签名、缺 `.sig` / publisherName、降级、非 HTTPS 请求和重定向、重复/冲突清单、保存期间签名或文件变化。被拒文件清理；disposed 后迟到的网络结果不能写关闭的库。

备份使用 SQLite 快照，包含已提交但尚在 WAL 中的数据，以 `.part` 原子替换，安装前刷新到保存后的状态；保存、备份与 spawn 失败传播并恢复元数据。真实包的 schema 当前为 14；本轮升级演练不冒充一次 schema 升级，结构升级的提示与既有迁移另由门禁覆盖。

<a id="w5-release"></a>
## 6. 发布产物、上一版与本地演练

发布命令要求干净工作区、正确分支及当前源码对应的门禁和构建 provenance，缺密钥失败且不自行生成。生成七项产物：安装包、`.blockmap`、`.sig`、`latest.yml`、`SHA256SUMS`、`RELEASE-NOTES.md`、`release.json`。完整的 release 记录先落盘，独立校验版本、完整目标 SHA、schema、日期、指纹、文件库存与演练结果，再允许发布。校验拒绝重复/缺失 sums、重复签名字段、说明里的伪造字段、服务替身演练及执行文件不一致。

存在上一版标签时，先获取七个原发布文件，逐跳检查 HTTPS，完整校验 SHA256SUMS 与 Ed25519 后提取原 NSIS 应用，核对旧版本/通道/schema，再重打为 Test 身份演练；失败不得用当前包冒充旧版。无标签时明确标记首版 current-source seed。本地受控来源与外部已发布 Release 分开记录。

默认不发布；`publish=false` 的本地验证不创建标签、不请求 GitHub。真实发布命令的 auth、网络、限流或 tag 检查错误都拒绝继续，仅明确 not-found 可创建新 Release。正式对外发布在 main 上重跑，不能把本轮分支上的演练产物当成已发布版本。

<a id="w9-workflow"></a>
## 7. 每周发布工作流

`release.yml` 每周一 UTC 00:00 与手动触发，上次标签之后没有新合并则跳过。检查 job 无 secret；Windows build 中只有打包与签名步骤分别读取插件和更新密钥；不装依赖的 publish job 才有 contents 写权限，dry_run 跳过发布。所有 Action 固定完整 SHA。

Windows 多命令步骤中，每个 `node` / `pnpm` / `corepack` 原生命令后都检查 `$LASTEXITCODE`，避免前面的失败被后面的成功覆盖。静态检查有移除失败传播检查的反例。本轮只运行本地校验；GitHub 运行器与外部发布服务保持未执行边界。

<a id="w6-installer"></a>
## 8. 安装身份与产品边界

NSIS 为按用户安装，可选目录，简体中文界面与多尺寸 M 图标，名称/版本/发布者进入卸载项。Windows Authenticode 仍按 Q-09 当前默认暂不启用。

所有自动安装演练使用 `MANGA Test` / `MANGA Dev Test`，包含空格与中文的隔离路径。下载、验证、执行的 Test 安装包必须是同一文件，并核对安装后的 `app.asar` 与真实打包源码一致。真实安装的卸载项、可执行文件、快捷方式及资料目录快照前后一致才算通过。失败现场保留；清理前取消并等待本轮安装辅助程序，避免迟到安装。

演练 Profile 是空库，启动时按既有规则打开资源库设置。检查先确认原笔记页签已经恢复并获得焦点，再通过正常“主页”按钮回到笔记，不重新打开笔记；重启就绪计时截至新进程 ready 与工作区 DOM 可操作，不包含后续备份内容扫描。

<a id="cleanup"></a>
## 9. 整理与保留范围

`.env.local`、媒体工具、合成样本、本地参考材料、密钥和备份分支保留；本地参考索引未找到安装更新条目。上一阶段的有效规则已在正本中维护，文档只保留当前阶段标签。

最终证据整体替换 `docs/evidence/gate/`，不超过 5 MiB，截图先检查隐私。过程日志、临时诊断与 Test Profile 不入库；清理只针对确认属于本轮、已无进程且处于命名临时根的制品。失败运行不计 passed，也不保留其数据为最终性能。

<a id="dependencies"></a>
## 10. 依赖盘点

采用计划已经查证的 `electron-updater 6.8.11`、`electron-builder 26.18.0`，knip 为 `6.43.0`；版本与发行龄证据见[阶段计划第 3 节](stage-plan.md#3-开源查证2026-11-08)与 [ADR-0007](../decisions/0007-technology-stack.md)。继续执行 14 天最小发行龄和现有例外，不因复核扩大依赖升级范围。

<a id="gate"></a>
## 11. 自检、门禁与审查修复

### 11.1 最终验证

最终源码（含 A 审查的修复）在 Windows 开发机、Node 26.12.1 上跑 `node scripts/stage.mjs gate` 通过，证据在 [`docs/evidence/gate/`](../evidence/gate/)（1.9 MiB，截图不含本机路径）。旧报告中的测试文件、次数、替身字节数与毫秒级安装时序不作为通过证据。

| 步骤 | 结果 |
| --- | --- |
| `verify --skip-tests` | passed（25 s）：类型、knip、文档、发布、工作流静态检查、依赖边界、烟测条件等待 |
| `test` | passed（73 s）：Vitest 2910 项，2900 passed、0 failed、10 skipped；临时目录剩 0 个；测试的 `LOCALAPPDATA`、`APPDATA`、文档与下载都在本轮临时根下 |
| `package` ×3 | 连续三次 passed（353、334、352 s，`passStreak: 3`）；132 项窗口观察全部 passed，其中 `update` 阶段 8 项（`version-about`、`update-flow`、`update-on-quit`、`update-rejected`、`update-offline`、`install-dev`、`release-workflow`、`installer-info`）；第一次重新构建，第二、三次沿用同一份构建与安装包（`package.json` 的 `build`）；三次都没有安装开发版，留给门禁最后一步；临时目录剩 0 个 |
| `installer` | passed（408 s）：24 步全绿；两个通道以测试身份安装、并存、覆盖、卸载，首次启动“下载”目录里什么都没有；真实的 `electron-updater` 下载、Ed25519 校验与 NSIS 执行的升级演练（完整 212 MB，差分 435 KB，节省 99.8%；点重启到新版本就绪 22.1 s；开发版保存、退出、安装、重开 13.8 s；60 s 写入时请求被撤回、未安装）；真实安装快照前后一致 |
| `bench` | passed（588 s）：60 项门槛全部在目标内；最慢的几段是工作区 145 s、规模窗口 137 s、扫描与停靠栏 103 s、阅读器 79 s、对话 40 s |
| `report` | self-check-passed；`productAcceptance` 恒为 not-run |
| `install-dev` | passed（13.3 s）：本机真实的 `MANGA Dev` 从 `0.1.1-dev.202611081756` 更新到本次构建（未在运行，`releaseUntouched: true`），整次门禁只安装这一次；门禁前后真实的启动指针没有指向临时目录、没有出现测试身份目录 |
| 本地发布演练 | passed（268 s）：在阶段分支的干净工作树上调用 `runStageRelease`（`publish: false`，分支核对改为本分支、不核对远端；命令本身只在 `main` 上运行），生成 `dist/release/v0.1.1/` 的安装包、块图、`.sig`、`latest.yml`、`SHA256SUMS`、发布说明与 `release.json`；首版种子 `0.1.0 → 0.1.1` 真实 NSIS 升级、资料完好、有备份、篡改 1 字节被拒绝、真实安装未受影响；没有创建标签、没有请求 GitHub。`bench.json` 的 `stageReleaseMs` 因基准先于演练运行记为 not-run，用时以 `release.json` 为准 |

### 11.2 B 复核修复映射

| 编号 | 修复 | 复验依据 |
| --- | --- | --- |
| B-01 | 实际连接上游下载、差分、缓存、publisher hook 与块边界续传；保存中断字节的写入时序 | 上游集成测试；真实 NSIS 演练 |
| B-02 | 保存/备份/spawn 失败传播与窗口恢复；WAL 快照；保存后验签和可信预期 hash | 故障注入与 WAL 用例；真实未保存笔记、工作区和备份 |
| B-03 | 开发版请求撤回、独占锁、精确产物、失败重开旧版和真实 ready 检查 | install-dev 恢复测试；真实 30 秒超时后写入完成仍存活 |
| B-04 | Windows 辅助程序隐藏启动、系统模块加载、无 BOM 记录与取消/清理生命周期 | Windows 真实辅助程序、安装与重开 |
| B-05 | 完整 release.json 在发布校验之前；严格 inventory、sums、manifest、签名、tag/auth 错误拒绝 | 发布完整性反例与本地真实 pipeline |
| B-06 | 下载、验签并提取上一版原 Release，不失败降级到当前源码 | 受控上一版七个真实产物；独立提取与升级 |
| B-07 | CI 逐原生命令传播失败 | 工作流静态校验与删除检查的反例 |
| B-08 | 服务夹具与真实证据分开；基准只读取真测量，报告拒绝虚构时序；补手动下载入口 | 阶段报告反例、更新 UI 用例与最终证据指纹 |

`productAcceptance` 始终为 not-run。工程自检通过不表示 A 已审核，也不表示外部服务、真实用户资料或主观安装体验已验收。

<a id="next-step"></a>
## 12. 下一步

A 审查已收敛（第 13 节），首选下一步是请用户授权本阶段的 push、创建 PR 与合并（[ACT-19](../../USER-ACTIONS.md#act-19)）；授权后由 Agent 执行，合并后按 [ACT-17](../../USER-ACTIONS.md#act-17) 第（4）项手动以“只构建不发布”试运行一次发布 workflow。H-84、H-85、H-92—H-95 与 Q-38 不是合并的前提，保持 not-run。

<a id="a-review"></a>
## 13. A 集中审查（2026-11-09）

**范围。** 计划第 9 节列出的审查重点，按最终源码逐项核对实现与证据：任何路径都不能执行未经 Ed25519 校验的安装包；开发版自动更新不碰正式版；测试与演练只用测试身份；发布命令没有授权时不对外发布；`release.yml` 的权限与 secret 范围；私钥不进仓库、证据与日志；版本号单调。

**接手时的状态。** B 的复核修复（第 11.2 节）没有提交，最后一次门禁在 `package` 第 2 次失败，本节 11.1 还是占位。失败不在本阶段的代码里，见 A-01。

**结论。** 没有需要交回 B 的缺陷。

- 校验：下载经 `electron-updater` 的 publisher hook 调用 MANGA 的 Ed25519 校验；就绪、“重启以更新”与退出安装前各自重新验签（含重新读 `.sig`）；Windows 安装助手在准备与执行前两次核对 SHA-512 等于验签回执里的值；缺 `publisherName`、缺 `.sig`、续传后的文件都会被拒绝（`tests/update/update-service.test.ts`、`installer` 的真实演练与 `update-rejected` 观察）。
- 开发版自动更新：`install-dev` 只对正式版做前后快照，从不安装或关闭它；30 秒没退出就撤回请求、不强杀；CI 与 `MANGA_DEV_AUTO_INSTALL=0` 时跳过。
- `release.yml`：`permissions` 默认 `{}`；`check` 没有任何 secret；两把私钥只给 `build` 的打包与签名两步，写到临时文件、用完即删；写权限只给不装依赖的 `publish`；`dry_run` 不发布；Action 全部固定完整 SHA。
- 发布：命令只在 `main`、干净工作树与当前门禁证据上运行；本地演练 `publish: false` 不创建标签、不请求 GitHub。

| 编号 | 发现 | 处理 | 复验 |
| --- | --- | --- | --- |
| A-01 | 窗口观察 `chat-long-session` 在回答气泡刚出现时就采样“是否贴着底部”，列表正在用平滑滚动追到底部，第一个样本差 173 px，其余 11 个 1 px，门禁因此在 `package` 第 2 次失败；这个观察也在 CI 的 `check` 里跑，会让每周发布随机失败 | 先条件等待列表追到底部（上限 2 s，超时算失败），再开始采样；记录追底用时（`apps/desktop/src/main/smoke/loop-walk.ts`） | 最终门禁三次 `package` 全部通过，追底 0 ms，12 个样本 0—1 px |
| A-02 | 同一观察的“刷新后视口不动”与“删除视口外的消息后视口不动”按“当前最上面一条可见消息”比较前后：最上面一条几乎滚出视口时，挪 1 px 它就不再算可见，换成下一条，被误判为视口移动 | 改为记下一条顶部在视口内的消息，之后量同一条消息的位置，容差仍是 2 px | 单独跑 `loop` 阶段 3 次与最终门禁都通过，位移 1 px |
| A-03 | 门禁慢（用户 2026-11-09 提出）：只改走查也让测试、安装与基准全部重跑；连续三次打包每次都重新构建与打安装包；基准没有分段用时 | 走查装置从产品源码指纹里排除，按谁运行它分 `smoke`、`smokeChecks`、`smokeBench`、`smokeWalk` 四组，基准与走查共用的合成夹具移到 `fixtures.ts`；`gate.json` 的 `packaged` 列出打进包里的全部组，`installer`、`install-dev` 与 `release` 判断包是否当前都核对它；输入、构建环境与打包目录都没变时沿用构建与安装包（`build-stamp.json`）；基准记录分段用时，门禁列出最慢的 5 段（[质量门禁](../dev-rules/quality-gates.md)） | `scripts/stage-report.test.mjs` 新增两项（只改走查时只有打包结果过期、走查目录的文件必须归组）；`tests/update/install-dev-recovery.test.ts` 增加“走查改了，包就不是当前的”；最终门禁三次 `package` 都沿用构建，后两次沿用安装包，每次约省 50 s |
| A-04 | “设置 › 更新”底部的“更新内容”一段贴着卡片的左边框，没有内边距（[截图](../evidence/gate/screenshots/ui-settings-update.png)） | 不阻塞，登记为 [LOOP-34](status.md#loop-34) | — |
| A-05 | 门禁里每次 `package` 通过都在末尾执行一次 `install-dev`，加上门禁最后一步，一次门禁最多把正在用的开发版退出、安装、重开 4 次；同一份构建已经装好时也会再装一次（用户 2026-11-09 提出） | 门禁启动的 `package` 带 `MANGA_PACKAGE_IN_GATE=1`，不再自己安装，开发版只在门禁最后一步装一次；单独运行 `stage package` 仍在通过后安装。`install-dev` 自己找最新打包的安装包时（门禁最后一步）或调用方给出打包目录时，先比较已装的与打包目录的 `app.asar`，版本与内容都相同就跳过（`skipReason: this build is already installed`）；调用方指定别的安装包而不给目录时不跳过（真实演练里“60 s 写入时请求被撤回”要对同一份构建再请求一次），不退出正在用的应用（`scripts/stage/gate.mjs`、`package.mjs`、`install-dev.mjs`） | `tests/update/install-dev-recovery.test.ts` 新增一项：同一份构建跳过且不请求退出，同版本但内容不同仍安装 |
| A-06 | Vitest 只把临时目录换到本轮的独立根，`LOCALAPPDATA` 仍是真实的：测试以正式版或开发版通道、只给 Profile 根打开产品时，启动指针落在真实位置（`%LOCALAPPDATA%manga-devlauncherpointer.json`、`mangalauncherpointer.json`），之后从开始菜单打开的真实安装就打开测试的临时资料库；测试安装身份的 `manga-test`、`manga-dev-test` 也各留下一份指针 | `tests/helpers/global-temp.ts` 把 `LOCALAPPDATA`、`APPDATA`、文档与下载目录也换到本轮根下；`stage package` 的 `install-dev` 观察与 `stage release` 演练里打开产品的地方补上临时的 `localAppDataDir`（它们曾在真实的 `manga-dev-test`、`manga-test` 留下指针）；门禁在 `report` 前核对真实指针没有指向临时目录、测试身份目录没有出现；本机被改的两份真实指针已恢复（开发版指回默认的 `%LOCALAPPDATA%manga-dev`，正式版没有自己的资料，删掉指针回到首次启动），两个测试身份目录已删除 | 新增 `tests/runtime/test-places-isolation.test.ts`：四个位置都在本轮根下，两个通道只给 Profile 根时指针也在本轮根下；之后整套测试跑完，真实指针不变 |
| A-07 | 下载的暂存放在 `<下载>mangaacquisition`，每次启动还会建空的 `<下载>manga`：用户的“下载”目录里出现了不是用户文件的东西（用户 2026-11-09 提出） | 暂存改到应用数据的 `cacheacquisition`，早先暂存的任务在启动时移过去并删掉留下的空目录；启动不再建“下载”目录，等第一次把东西存到那里（下载用的资源库位置）才建；存储清单里还没建立的下载目录不算“缺失”（`product-app.ts`、`acquisition/service.ts`、`commands/inventory.ts`）。`stage package` 的 `data-locations-fresh` 与 `stage installer` 的首次启动改为要求“下载”里什么都没有 | `tests/runtime/data-locations.test.ts` 新增一项：两个通道启动后“下载”为空、暂存在缓存里，早先暂存的任务移到缓存且空目录被删 |
| A-08 | `stage installer` 的真实演练失败时（这次是 A-05 的跳过让“写入时撤回请求”一步拿到 `skipped`），`installer.json` 记了 failed，进程却以 0 退出，门禁把它记为通过，接着在 `bench` 才因为“没有当前的演练结果”失败 | `installer.mjs` 按结果显式退出；门禁的每一步除了退出码，还要它的结果文件对现在的输入是 passed 才算通过，连续打包每次之后也核对一次（`scripts/stage/gate.mjs`） | 修复后重跑的门禁 `installer` 通过 |
| A-09 | PR 的 CI（`ubuntu-24.04`）上 `tests/update/update-service.test.ts` 有 3 项失败：它们驱动真实的上游 `NsisUpdater`，后者按所在平台取清单，Linux 上请求 `latest-linux.yml`，测试服务器只有 Windows 的 `latest.yml`；本机 Windows 上一直通过 | 这 3 项只在 Windows 上运行（`it.skipIf(!nsisPlatform)`，注释写明原因）：NSIS 更新只在 Windows 上发生，开发机的门禁与每周发布工作流在 `windows-2025` 上的 `check` 都跑它们；Linux 的 PR CI 跑其余更新测试 | 修复后本机 `stage test` 与 `report` 重跑通过（2910 项，0 failed），证据 `cases.json`、`test-run.json`、`report.json` 已更新；PR 的 CI 重跑通过 |

**没有验证的。** GitHub 上的 workflow 运行与真实的 Release（合并后按 ACT-17 第（4）项试运行）；有上一版标签时“下载、验签并提取原发布包”只由测试覆盖；Windows 代码签名按 Q-09 不做；人工检查全部 not-run。
