# 当前阶段计划（M10）：安装与自动更新

日期：2026-11-08。角色：A 规划；B 连续实施与自检；A 集中审查。本文是整个阶段的唯一计划，兼作跨模块变更提案（A-46）。B 的执行 prompt 在[第 11 节](#prompt)，不另建 prompt 文件。路径固定、不带阶段名；下一阶段开始时由 A 按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)改写。上一阶段的计划与报告在合并提交里：[计划归档](https://github.com/chialecode/manga/blob/c79f49a/docs/delivery/stage-plan.md)、[报告归档](https://github.com/chialecode/manga/blob/c79f49a/docs/delivery/stage-report.md)。

用户 2026-11-08 要求下一阶段主要解决安装问题：本机同时装着正式版和开发版；每次修改完成后，本机的开发版自动更新；正式版通过互联网更新；整个更新流程尽量自动化。版本号先保持 0.1.x 的形式。Windows 代码签名暂不做：个人开发者能拿到的签名要么收费，要么有资格限制，同类的个人开源项目普遍不签名（调研见 3.1）。

用户同日补充：本阶段也要做在 GitHub Actions 上构建与发布，发布周期是**每周一次：上次发布以来有新的 PR 合并，就发布一个正式版**。原来登记为后续项的“在 CI 上构建发布”因此并入本阶段（W9，A-126）。

范围记为 **A-124**，更新的设计记为 **A-125**，CI 构建与每周发布记为 **A-126**。A 没说到的细节先定了默认值，登记为[用户待办的 Q-38](../../USER-ACTIONS.md#q-38)，B 按默认实现，用户以后可以改。需求是 DATA-06、DATA-07（[需求](../product/requirements.md)），验收是 [AT-157—AT-163](roadmap-and-acceptance.md#at-updates)。

本计划一次列出本阶段的全部交付、退出条件和收尾流程。B 连续完成全部工作包后一次交付，A 一次集中审查。人工检查与待决问题按 A-53 记在用户待办，不阻塞开发。

## 1. 范围与退出条件

| 项目 | 约定 |
| --- | --- |
| 阶段 | 安装与自动更新：版本号规则（W1）；开发版本地自动更新（W2）；正式版联网更新（W3）；更新的安全（W4）；一条命令发布（W5）；安装体验修整（W6）；测试、走查与演练（W7）；文档（W8）；GitHub Actions 上的构建与每周发布（W9）；阶段开始的整理（C0）；依赖盘点（D1） |
| 代码基线 | `main @ c79f49a`（[PR #9](https://github.com/chialecode/manga/pull/9) 于 2026-11-08 squash 合并）；没有未合并的前置分支 |
| 工作分支 | `feat/m10-install-update`，A 已从基线创建。本计划所在的提交是阶段提交的起点；B 的实施、A 的审查修复与人工反馈修复全部 amend 进同一提交 |
| 关联需求 | DATA-06（安装与卸载，去掉“签名与自动更新另定”）、新增 DATA-07（版本与更新）；受影响的既有行为：DATA-01（更新后首次启动的迁移与备份）、UI 的设置页与帮助菜单 |
| 关联验收 | 新增 AT-157—AT-163；安装相关的既有观察（`installer` 步骤、数据位置的升级 `data-locations-upgrade`）按新版本号重跑 |
| 可连续执行 | 本地实现；第 3 节列出的依赖安装；合成样本、测试、打包、基准、文档同步；第 5.1 节的整理；阶段提交与 amend |
| 外部操作 | 未授权：push、PR、合并。每周自动发布是用户 2026-11-08 定下的发布方式（A-126），合并本阶段后由 workflow 按周执行；仓库侧的一次性配置已由 A 按 [ACT-17](../../USER-ACTIONS.md#act-17) 的授权在 2026-11-08 完成（`release` 环境只允许 `main`、不设审批人；secrets `MANGA_PLUGIN_SIGNING_KEY_PEM` 与 `MANGA_UPDATE_SIGNING_KEY_PEM`；允许列表加了两个 Action；期望配置记在 `.github/actions-policy.json`），合并后的第一次试运行也已授权。B 不改仓库设置与 secrets。本阶段的测试不访问 GitHub：更新源用本机回环地址上的假发布服务；workflow 用本地的静态检查与“只构建不发布”的模式验证；本机的 `stage release` 只在有授权时发布，默认只生成全部文件 |

**退出条件与覆盖**

| 条件 | 做法 | 工作包 | 验收证据 |
| --- | --- | --- | --- |
| 版本号按规则生成 | 正式版 `0.1.x`，开发版 `<下一个正式版号>-dev.<UTC 年月日时分>`；由脚本统一算出并写进安装包，不手改 `package.json`；“关于”里显示版本与提交 | W1 | AT-157 |
| 开发版在本机自动更新 | `stage package` 或 `stage gate` 通过后，若本机装了开发版：让运行中的开发版保存并退出，静默安装新包，原来在运行就重新打开；正式版不受影响；没装开发版就跳过；可以关闭 | W2 | AT-158 |
| 正式版联网更新 | 启动后与每隔一段时间检查 GitHub Releases；后台下载（只下载变化的部分）；下载好后提示“重启以更新”，不打断播放、录音、导出与 Agent 任务；不理会时退出应用时安装；更新后第一次启动显示更新内容；资料库的迁移照常先备份 | W3 | AT-159 |
| 更新不能被篡改 | 安装包须有对应的 Ed25519 签名，公钥内置在应用里；签名不对、被改过、版本更旧、来源不是 HTTPS 的，一律拒绝并保留现版本，告诉用户原因；离线时不打扰 | W4 | AT-160 |
| 一条命令发布 | `node scripts/stage.mjs release` 在门禁通过的同一份源码上，生成正式版安装包、差分块图、更新清单、SHA256SUMS、签名与发布说明，先在临时目录演练“从上一版升级到这一版”；有授权时创建标签与 GitHub Release | W5 | AT-161 |
| 安装体验 | 应用图标（不再是默认的 Electron 图标）、中文的安装界面、发布者与描述信息、“安装的应用”里显示版本 | W6 | AT-162 |
| CI 构建与每周发布 | `.github/workflows/release.yml`：每周定时与手动触发；上次发布以来没有新的合并就跳过；在 Windows 运行器上跑检查、打包、安装与升级演练，全部通过才签名并发布；密钥只在受保护的环境里，写权限只给不装依赖的发布那一步 | W9 | AT-163 |
| 阶段开始的整理 | 上一阶段的报告提炼后删除；去掉以前阶段的标签；按内容整理文件 | C0 | 文档检查；报告的整理记录 |
| 依赖盘点 | 按 A-35 与 ADR-0007 的复查条件逐项处理 | D1 | ADR-0007 版本表；完整回归 |

**阶段完成的判定。** 以下依次满足后，Agent 侧完成，可以请求用户授权 push、PR 与合并（A-24、A-53）：（1）B 自检的必需用例与门禁全部通过；（2）A 集中审查收敛。第一次真正的联网发布在合并之后：ACT-17 的仓库配置完成后，先手动以“只构建不发布”试运行一次，之后按周自动发布。人工检查与待答复问题记在用户待办，不是合并的前提；`productAcceptance` 保持 not-run。

**阶段完成后，用户可以：**

- 改完代码、门禁通过后，开发版自己装上新版本，原来开着的会自动重开；
- 每周一次，只要上周有 PR 合并，GitHub Actions 就自动检查、打包并发布新的正式版，谁都不用动手（也可以手动触发一次）；装着的正式版过一会儿提示“新版本已下载，重启以更新”，点一下或下次退出时就更新好了，更新内容在第一次启动时显示；
- 在“设置 › 更新”里看到当前版本、手动检查更新、关闭自动检查或自动下载。

## 2. A 已核对的现场

- **安装包**（`scripts/stage/installer-lib.mjs`）：electron-builder 26.18.0 的 NSIS 目标，`--prepackaged` 打 Forge 的输出；`CHANNEL_INSTALL` 定义两个通道（正式版 `app.manga.desktop` / `MANGA` / `manga.exe`，开发版 `app.manga.desktop.dev` / `MANGA Dev` / `manga-dev.exe`）；按用户安装、可改目录、卸载保留数据；`win.signAndEditExecutable: false`，`publish: null`，不生成更新清单。`buildInstaller` 把通道写进 `resources/channel.json` 并给开发版的可执行文件改名。
- **通道**（`apps/desktop/forge.config.ts`）：`MANGA_BUILD_CHANNEL=release` 打正式版，否则开发版；`stage package` 默认打开发版，并在 `dist/desktop/installer/out-development/` 生成开发版安装包（`scripts/stage/package.mjs` 第 524 行）。`stage installer` 在临时目录里打两个通道、真正安装、启动、卸载；它按卸载项的显示名 `MANGA` / `MANGA Dev` 认出真实安装，发现已装任一通道就拒绝运行。**这与本阶段的目标冲突**：用户以后会同时装着两个通道，门禁的安装步骤会被挡住，见 4.8。
- **版本号**：`apps/desktop/package.json` 是 `0.1.0`，安装包名为 `manga-dev-setup-0.1.0.exe`；`app.getVersion()` 在主进程两处使用（`apps/desktop/src/main/index.ts`）。没有任何更新机制，也没有“关于”页。
- **打包的提示**：electron-builder 每次报 “default Electron icon is used”“description is missed”“author is missed”，应用与安装包都还是默认图标。
- **签名材料**：`dist/keys/` 里只有第一方插件的 Ed25519 密钥（ACT-08）；插件包的验签代码在插件模块里（Ed25519、内置公钥），更新可以照同样的做法，但用另一把密钥。
- **数据位置与迁移**：正式版 `%LOCALAPPDATA%\manga`、开发版 `%LOCALAPPDATA%\manga-dev`（A-118）；每次结构升级前自动留 `manga.sqlite.premigrate-v<旧版本>` 备份，较旧的应用拒绝打开较新的资料（`API_INCOMPATIBLE`）。
- **仓库**：`chialecode/manga` 公开；还没有任何标签与 Release。
- **现有 CI**（`.github/workflows/ci.yml`、`.github/actions-policy.json`、Git 与 GitHub 第 2 节）：只有一个在 Ubuntu 上跑 `verify` 的必需检查 `repository-quality`，没有 Windows 的媒体前置（FFmpeg、语音模型、合成样本），这些用例记为跳过；规则写着不做定时运行、不用 secrets 与写权限；Actions 只允许 `actions/checkout` 与 `actions/setup-node`，并要求固定完整 SHA。本阶段的发布 workflow 是这些规则的有意例外，只限 `release.yml`，`ci.yml` 不变（A-126）。
- **打包要用的私钥**：随包的第一方插件在打包时用 `dist/keys/plugin-first-party.pem` 签名（`scripts/desktop-plugins.ts`，也可以用 `MANGA_PLUGIN_SIGNING_KEY` 指定）；所以在 CI 上打正式版需要插件私钥与更新私钥两把。
- **媒体前置的获取**：`scripts/tools/fetch-ffmpeg.mjs`、`fetch-silero-vad.mjs`、`fetch-subtitle-font.mjs` 按锁文件下载并校验；合成样本由 `scripts/samples/` 生成。

## 3. 开源查证（2026-11-08）

查询来源：npm registry 的发行时间、官方文档与 GitHub 仓库。“满 14 天”以实施当天计算，B 实施时重查一次。本地参考索引里没有安装与更新的条目，按开发流程 2.5 记为“未找到对应参考”。

### 3.1 候选

| 需要 | 候选 | 版本与日期 | 许可证 | 判断 |
| --- | --- | --- | --- | --- |
| 应用内更新 | electron-updater（[文档](https://www.electron.build/docs/features/auto-update/)，与现用的 electron-builder 同一项目） | 6.8.11（2026-10-20，已满 14 天）；6.8.12（10-26，11-09 起满）；7.0.0 仍是 alpha | MIT | **采用 6.8.x**：支持 NSIS 安装包、GitHub Releases 与通用 HTTP 源、按块图只下载变化的部分、`autoInstallOnAppQuit`、拒绝降级（`allowDowngrade`）。7.x 改为“没有 Windows 签名就拒绝更新”，正式发行后再评估 |
| 同上 | Electron 自带的 `autoUpdater` 与 update.electronjs.org（[文档](https://www.electronjs.org/docs/latest/tutorial/updates)） | — | — | 不采用：Windows 上依赖 Squirrel.Windows 的安装方式，与已定的 NSIS 按用户安装（A-119）不同，要换安装包 |
| 同上 | Velopack（[仓库](https://github.com/velopack/velopack)） | npm `velopack` 1.3.39（2026-10-17） | MIT | 不采用：自带安装器与更新器，会替换现在的 NSIS 安装包与安装目录约定；Electron 不是它的主要场景。需要换安装方式时再评估 |
| 更新包的校验 | Node 内置 `crypto` 的 Ed25519 | — | — | **自写**：插件包已经这样验签；更新用单独的一把密钥。原因见 4.4 |
| 发布到 GitHub | GitHub CLI `gh release` | 本机已登录 | MIT | **复用**：草稿、上传资源与发布都用它；不引入 electron-builder 的上传（避免把令牌交给构建过程） |
| CI 的 Windows 机器 | GitHub 托管运行器 `windows-2025`（[运行器镜像](https://github.com/actions/runner-images)；`windows-latest` 目前也指向它） | Windows Server 2025 | — | **采用，固定写 `windows-2025`**，不用会随时迁移的 `-latest`。它不是 Windows 11：本机门禁仍是阶段合并的依据，CI 上的结果只决定这一次能不能发布。公开仓库使用标准运行器不计费，B 实施时以 GitHub 的计费文档复核 |
| 在 job 之间传文件 | `actions/upload-artifact`、`actions/download-artifact`（GitHub 官方） | v7.0.2、v8.0.2（均 2026-10-07，已满 14 天） | MIT | **采用**：让“构建与签名”和“发布”分在两个 job，发布的 job 拿写权限但不装依赖、不碰私钥。按现有规则固定完整 SHA，并加进 Actions 允许列表（仓库设置的修改归 ACT-17） |
| 创建 Release | 运行器自带的 `gh`；第三方的 release Action | — | — | **用 `gh`**，不引入第三方 Action（避免扩大允许列表）；electron-builder 自带的上传同样不用 |
| Windows 代码签名 | Azure Artifact Signing、Certum 开源证书、SignPath Foundation、Microsoft Store（MSIX） | — | — | **暂不签名**（Q-09 当前默认）：Azure 的个人开发者只开放给美国和加拿大；Certum 开源证书约 €49/年，个人、非商业开源项目可申请；SignPath 免费但要求 CI 构建、签名政策与项目知名度；Store 免费签名只适用于 MSIX，与 NSIS 安装方式冲突。准备给更多人用时按 Q-09 再定 |

**一个必须处理的细节。** electron-updater 6.8.11 的 `NsisUpdater` 只有在安装目录的 `app-update.yml` 里写了 `publisherName` 时才调用校验函数，否则直接跳过校验（`verifySignature` 返回 null）。所以不签名时必须给正式版的 `app-update.yml` 写上发布者名，并把 `verifyUpdateCodeSignature` 换成 4.4 的 Ed25519 校验；否则下载的安装包完全不经校验就会被执行。B 用测试证明：去掉这一项时测试失败。

### 3.2 依赖盘点（A-35，D1）

B 实施开始与门禁之前各跑一次 `pnpm outdated -r`，按“满 14 天的最新版本”处理；electron-builder 26.18.1（2026-10-26）11-09 起满 14 天，与 electron-updater 一起升级，安装包与更新的全部用例重跑。主版本或行为变化的升级先单独做并跑对应的回归，失败时回退到原版本，在 ADR-0007 的例外表写明尝试的版本、失败的命令、上游限制与复查条件。最小发行龄策略不绕过。

## 4. 设计

### 4.1 版本号（W1）

- **正式版**：`0.1.x`。脚本从 GitHub 上最高的 `v0.1.*` 标签（本机用 `git tag` 与 `gh release list` 核对）算出下一个号；还没有任何发布时从 `0.1.1` 开始，保证比已经打过的 `0.1.0` 大。`apps/desktop/package.json` 的 `version` 只表示版本线（`0.1.0`），不为每次发布提交改动。
- **开发版**：`<下一个正式版号>-dev.<UTC 年月日时分>`，例如 `0.1.2-dev.202611081530`（预发布标识是一个不带前导零的数字）。开发版与正式版是两个独立的通道，互不比较。
- **写进安装包**：`buildInstaller` 的 `version` 参数由同一个函数给出；应用里 `app.getVersion()` 得到它。提交的短哈希与构建时间写进 `resources/build.json`，“关于”与调用追踪、诊断信息里显示。
- 升级到 `0.2` 或 `1.0` 由用户决定，不由脚本自动做。

### 4.2 开发版在本机自动更新（W2）

- **触发**：`stage package` 通过、或 `stage gate` 整体通过之后，作为最后一步执行 `stage install-dev`（也可以单独运行）。环境变量 `MANGA_DEV_AUTO_INSTALL=0` 时跳过；CI 上跳过。
- **只碰开发版**：按卸载项与 `CHANNEL_INSTALL.development` 确认本机装了开发版，没装就跳过并说明。绝不安装、关闭或改动正式版。
- **运行中的开发版**：通过单实例通道请它保存并退出（新增启动参数 `--quit-for-update`：保存工作区、结束录音与写入、取消可取消的任务后退出）；30 秒内没退出就放弃本次安装、不强杀，给出原因。
- **安装**：用刚打出的开发版安装包静默安装（`/S`），沿用上次的安装目录；完成后核对已装版本等于新版本号。原来在运行的，重新启动它。
- **结果**：写进门禁证据（`install-dev.json`：是否装过、旧版本、新版本、用时、跳过原因），不影响门禁本身的结论；失败时门禁仍按测试结果判定，`install-dev` 单独报失败。

### 4.3 正式版联网更新（W3）

- **只在正式版启用**：开发版与 `pnpm dev` 不检查联网更新。更新源是 GitHub Releases（`chialecode/manga`），只取正式发布的 Release，草稿与预发布不算。
- **检查**：启动 10 分钟后检查一次，之后每 6 小时一次；“帮助 › 检查更新…”与“设置 › 更新”里的按钮可以手动检查。离线或失败时静默，记进操作日志，手动检查时才显示错误。
- **下载**：默认自动在后台下载，按块图只下载变化的部分；下载与校验（4.4）都通过后才算“已就绪”。
- **提示**：已就绪时在顶部一行右侧显示一个不打断的提示：“新版本 0.1.x 已就绪 · 重启以更新 · 稍后”，可以展开看更新内容（来自 Release 的说明）。正在播放、录音、导出、下载或有 Agent 任务在运行时，“重启以更新”先说明会中断什么、要求确认。
- **安装**：点“重启以更新”或退出应用时，由 MANGA 等待保存、写升级前备份并重新验签后安装。上游 `autoInstallOnAppQuit=false`，避免它绕过 MANGA 的保存与备份流程；用户可观察到的退出安装行为不变。更新后的第一次启动显示一次“已更新到 0.1.x”，可以点开更新内容。
- **资料库**：新版本需要升级资料库时，照常在迁移前自动备份；提示里写明“这次更新会升级资料库，升级前会自动备份”（更新清单里带上新版本的 `schemaVersion`，与本机比较）。
- **设置 › 更新**：当前版本与提交、上次检查时间、“自动检查更新”（默认开）、“自动下载”（默认开）、“检查更新”按钮。关闭自动检查后不再联网检查。
- **隐私**：检查更新只访问 GitHub，只带应用版本与平台，不带任何用户数据；遵循系统代理。

### 4.4 更新的安全（W4）

- **一把单独的密钥**：A 已在 2026-11-08 生成 `dist/keys/update-release.pem`（Ed25519，PKCS#8 PEM，不入库）与 `dist/keys/update-release.pub`（与插件公钥同一格式：一行 base64 的原始 32 字节公钥），同一份私钥已放进 `release` 环境；B 把公钥写进应用源码，**不得重新生成或覆盖**这把密钥（否则本机与 CI 的签名对不上）。`stage release` 在密钥缺失时明确失败，不自动生成。与插件密钥分开：一把泄露不影响另一把。备份提醒在用户待办 ACT-08。
- **签什么**：对正式版安装包签一个分离签名 `manga-setup-<版本>.exe.sig`，签名内容包含文件的 SHA-512、版本号与文件名，防止把旧版本的合法安装包冒充新版本。签名随 Release 一起上传。
- **怎么验**：正式版的 `app-update.yml` 写上 `publisherName`（使校验函数被调用，见 3.1），`verifyUpdateCodeSignature` 换成自己的函数：下载对应的 `.sig`，用内置公钥验证，核对 SHA-512、版本与文件名；任何一项不符就拒绝，删除下载的文件，保留现版本，界面显示“更新包校验失败，已保留当前版本”。
- **其他拒绝**：版本不比当前新（`allowDowngrade=false`）；不是 HTTPS；清单格式不对。都记进操作日志。
- **密钥轮换**：换密钥需要先发布一个用旧密钥签名、内置了新公钥的版本，步骤写进 Git 与 GitHub 规则；本阶段只实现一把密钥，轮换作为文档里的操作说明。

### 4.5 一条命令发布（W5）

`node scripts/stage.mjs release` 依次（本机与 CI 用同一个脚本；CI 上的差别见 4.9）：

1. **前提**：在 `main` 上、工作区干净、与 `origin/main` 一致；当前源码指纹的 `stage gate` 结果全部有效（否则先跑 `stage gate`）。阶段的 squash 合并提交与阶段分支最后一次提交的内容相同，门禁结果按指纹直接复用。
2. **打包**：用门禁里同一份打包目录打正式版安装包（版本号见 4.1），生成 `latest.yml`、块图、`.sig`、`SHA256SUMS`。
3. **演练**：在临时目录里装上一个正式版（第一次发布时没有，就装用同一源码打的 `0.1.0` 临时包），用回环地址上的假发布服务提供新版本，让它自己检查、下载、校验、安装、重启，核对新版本号、资料完好、迁移有备份；再用一个被改过一个字节的安装包确认会被拒绝。演练失败就停止，不发布。
4. **发布说明**：从这个阶段的合并提交消息与执行状态生成中文的发布说明（新增、修复、需要注意的事，例如“会升级资料库”）。
5. **发布**：本机只在用户当次授权时执行（CI 上的发布见 4.9）：在合并提交上创建标签 `v0.1.x`，用 `gh release create` 上传全部文件并发布。没有授权时只把全部文件与发布说明放在 `dist/release/v0.1.x/`，并输出需要用户授权的那一步。
6. **证据**：`release.json`（版本、源码指纹、文件大小与 SHA-256、演练结果、是否已发布与 Release 链接），不含本机路径。

**本机发布的位置**：正式发布由 4.9 的 workflow 每周进行；本机的 `stage release` 用于发布前的演练与 CI 不可用时的备用，真正发布仍需用户当次的授权。

### 4.6 安装体验修整（W6）

- **图标**：先由 Agent 用产品主色画一个简单的“M”字图标（SVG 源文件入库，生成 `.ico` 与各尺寸 PNG），应用窗口、任务栏、安装包、卸载项与快捷方式都用它；用户以后可以换（Q-38 第 6 项）。
- **安装界面**：中文（electron-builder 的 NSIS 语言设置），安装完成后可以勾选“启动 MANGA”。
- **信息**：`description`、`author`（发布者名与 4.4 的 `publisherName` 一致）、版权与主页链接写进包信息；“安装的应用”里显示名称、版本、发布者与图标；去掉打包时的三条提示。
- **覆盖安装**：在正式版运行时安装新版本，先提示关闭（沿用现有的检查）；覆盖安装保留安装目录与数据。

### 4.7 命令与契约

- 新增所有者命令：`update.status`（当前版本、通道、上次检查、状态：空闲 / 检查中 / 下载中 / 已就绪 / 失败与原因）、`update.check`、`update.restartToUpdate`、`update.settings.get` / `set`。Agent 不能调用。契约在 `packages/contracts/src/`，命令快照用例随之更新。
- 更新状态变化发主机通知，界面按现有方式刷新。
- 新的错误码：`UPDATE_VERIFY_FAILED`、`UPDATE_UNAVAILABLE`（开发版或离线），各有中文说明。

### 4.8 测试用的安装身份

按用户安装的卸载项、开始菜单与桌面快捷方式按应用 ID 与产品名区分，临时目录装出来的测试副本若用真实的身份，就会覆盖用户真实安装的卸载项与快捷方式。所以：

- `installer-lib.mjs` 增加两个**测试身份**：`app.manga.desktop.test` / `MANGA Test` / 安装目录 `manga-test`，`app.manga.desktop.dev.test` / `MANGA Dev Test` / `manga-dev-test`；数据目录同样加 `-test`。除身份外，安装包的内容与真实通道相同（通道仍分别是正式版与开发版）。
- `stage installer`、升级演练（4.5 第 3 步）与窗口观察里的安装与更新，一律用测试身份，不再因为本机装了真实版本而拒绝运行；只在本机已有**测试身份**的残留时先清理它（上次失败留下的）。
- 每次运行前后对真实身份做一次快照（卸载项、安装目录里可执行文件的版本与修改时间、开始菜单与桌面快捷方式、数据目录是否存在），前后必须相同，不同就判失败并写明哪一项变了。
- 只有 `stage install-dev`（4.2）会动真实的开发版，它从不动真实的正式版；它同样记录正式版的快照，前后必须相同。

### 4.9 GitHub Actions 上的构建与每周发布（W9）

新增 `.github/workflows/release.yml`，与 `ci.yml` 分开，必需检查 `repository-quality` 不变。

- **触发**：`schedule` 每周一 00:00 UTC（北京时间 08:00，用户 2026-11-08 指定；cron `0 0 * * 1`），外加 `workflow_dispatch`（输入 `dry_run`，默认 `true`：只构建、演练，不发布）。不响应 `push`、`pull_request` 与任何来自 fork 的事件；`concurrency` 组 `release`，不取消正在进行的那一次。
- **判断要不要发布**（job `decide`，Ubuntu，`contents: read`，不装依赖）：取最高的 `v0.1.*` 标签，看 `main` 在它之后有没有新的提交（`main` 只能经 PR 的 squash 合并进来，一个提交就是一个合并的 PR；用户确认任何合并进 `main` 的 PR 都算，包括 Dependabot 的）。没有就以“本周没有新的合并”成功结束，不构建；有就算出下一个版本号，并列出这些 PR 作为发布说明的素材。还没有任何标签时视为有新合并，发布 `0.1.1`。
- **检查**（job `check`，`windows-2025`，`contents: read`，**没有任何 secret**）：按锁文件取得媒体前置、生成合成样本，跑 `verify`、`stage test`、一次 `stage package`（打包烟测与窗口走查）与 `stage installer`（4.8 的测试身份）。不跑基准：共享运行器的速度不稳定，基准以本机最后一次门禁的证据为准，`release.json` 写明基准证据的源码指纹与它是否等于这次发布的源码。任何一步失败，这一周不发布。
- **构建与签名**（job `build`，`windows-2025`，`contents: read`，`environment: release`）：同一个提交上打正式版的包（插件私钥只给打包那一步），生成安装包、块图、`latest.yml`、`.sig`（更新私钥只给签名那一步）、`SHA256SUMS` 与发布说明，跑 4.5 第 3 步的升级演练（上一版从已发布的 Release 下载，并先核对它的签名）。私钥来自环境的 secrets `MANGA_PLUGIN_SIGNING_KEY_PEM`、`MANGA_UPDATE_SIGNING_KEY_PEM`（PEM 内容），只映射给对应的那一步，写到运行器的临时文件后用文件路径交给脚本（插件用现有的 `MANGA_PLUGIN_SIGNING_KEY`），用完即删，不打印、不进日志与 artifact。产物以 artifact 交给下一步，保留 7 天。
- **发布**（job `publish`，Ubuntu，`contents: write`，没有 secret，不 checkout 源码以外的东西、不装依赖）：下载 artifact，核对 `SHA256SUMS` 与 `.sig`（用仓库里的公钥），确认这个标签还不存在，用 `gh release create v0.1.x --target <提交>` 上传全部文件并发布。`dry_run` 时跳过本步。
- **发布说明**：中文；列出上次发布以来合并的 PR（标题与链接）与合并提交里的说明；新版本会升级资料库时写在最前面；写明这次没有跑基准、人工检查的状态见用户待办。
- **失败时**：workflow 失败、不发布，GitHub 按通知设置告诉维护者；Agent 下次开工时用 `gh run list --workflow release.yml` 看一眼最近一次的结果，失败就作为当前阶段的修复项。不自动重跑，不自动改代码。
- **安全边界**：所有 Action 固定完整 SHA；`permissions` 默认 `{}`，每个 job 只给自己需要的；`release` 环境只允许 `main` 部署；两把私钥只在这个环境里；CI 的令牌不能触发别的 workflow。workflow 文件由一个本地测试做静态检查（触发条件、每个 job 的权限、secret 只出现在 `build` 的指定步骤、Action 都固定 SHA 且在允许列表里、`publish` 没有安装步骤），随 `verify` 运行。
- **长期不活动**：公开仓库 60 天没有活动时 GitHub 会停用定时 workflow；有合并就不会发生，发生时在 Actions 页面重新启用即可（写进 Git 与 GitHub 规则）。

## 5. 工作包与顺序

### 5.1 C0 阶段开始的整理（先做）

按[文档治理第 8 节](../governance/documentation-policy.md#stage-cleanup)执行，结果写进报告的“整理记录”。

**A 已做（在本计划所在的提交里）：**

- 上一阶段的报告提炼后删除。仍有效的内容已在正本里：待审操作的设计在 A-121、领域模型与 Agent 协议；A 审查的两条修复在执行状态；门禁做法在质量门禁。入链改为归档链接 `https://github.com/chialecode/manga/blob/c79f49a/docs/delivery/stage-report.md#<锚点>`；文档导航与 GitBook 目录里去掉报告（B 新建后加回）。
- 登记表 `currentStage` 改为 `m10`，本计划的 `retireAfter` 改为 `m10`，报告的条目去掉。报告第 11 节里“看过、不改”的一条观察项登记为 LOOP-33。
- 新增 A-124、A-125、A-126；需求 DATA-06 改写、新增 DATA-07；验收 AT-157—AT-163；交付路线 2.2 改为本阶段，上一阶段的能力并入 2.1；ACT-16 的完成写回用户待办与执行状态；新增 Q-38、ACT-17。

**B 执行时再核对一遍：**

| 位置 | 内容判断 | 处理 |
| --- | --- | --- |
| `.env.local` | 开发者的本地配置与凭据，必需 | 保留；不读取与任务无关的值 |
| `dist/design-refs/`、`dist/tools/`、`dist/samples/` | 用户提供的界面参考、固定版本的工具、合成样本 | 原样保留 |
| `dist/desktop/`、`dist/plugins/` | 上一阶段最后的打包产物与安装包 | 阶段末重新打包时覆盖 |
| `dist/keys/` | 第一方插件的签名私钥（ACT-08）；本阶段新增更新签名私钥 | 原样保留，不读不输出私钥 |
| `dist/evidence-runs/` | `current/`（上一阶段最后一次门禁）与零散日志 | `current/` 在本阶段第一次门禁时覆盖；其余零散日志删除 |
| 系统临时目录里的 `manga-*` | 以前失败运行留下的现场 | 确认没有正在运行的门禁后删除，只记数量 |
| 本地分支 `rebuild/m1`—`rebuild/m8`、`feat/m6-project-workspace`、旧的阶段分支 | 历史改写时留下的备份与已合并的分支 | 保留，不由 Agent 删除；在报告里列出，用户可以自行删除 |
| `backup/main-pre-rewrite` | 历史改写前的本地 `main`（A 在同步 `main` 前留的备份） | 保留，不由 Agent 删除 |
| `docs/evidence/gate/` | 上一阶段最后一次门禁的证据 | 本阶段最后一次门禁时整体替换 |

**去掉以前阶段的标签（A-57）。** A 已运行文档检查并改写了报出的一处（ADR-0002 的历史改写一节）；B 交付前再运行一次。`docs/evidence/gate/` 里的 `stage` 字段随本阶段最后一次门禁整体替换。Git 提交信息与固定归档链接里的路径不改。

### 5.2 D1 依赖盘点

按 3.2 执行。ADR-0007 的版本表新增 electron-updater，并写明 3.1 的选择理由。

### 5.3 工作包

| 包 | 内容 | 关键失败路径 | 验收 |
| --- | --- | --- | --- |
| W1 版本号 | 4.1：版本号函数、安装包与 `build.json`、“关于” | 没有任何标签时从 0.1.1 开始；标签不连续时取最高；开发版标识没有前导零；两个通道版本互不影响 | AT-157 |
| W2 开发版自动更新 | 4.2：`stage install-dev`、`--quit-for-update`、门禁衔接 | 开发版没装；开发版在运行且有未保存的工作区；30 秒内不退出；安装失败；正式版在运行（不受影响）；CI 上跳过 | AT-158 |
| W3 正式版更新 | 4.3：electron-updater 接入、检查与下载、提示、退出时安装、更新内容、设置页与帮助菜单 | 离线；下载中断后续传；下载中退出；有任务运行时点重启；关闭自动检查；新版本要升级资料库 | AT-159 |
| W4 更新的安全 | 4.4：密钥、`.sig`、`publisherName` 与自定义校验、拒绝降级与非 HTTPS | 安装包改一个字节；签名换成别的版本的；没有 `.sig`；版本比当前旧；去掉 `publisherName` 时测试必须失败 | AT-160 |
| W5 发布命令 | 4.5：`stage release` 的前提、打包、演练、发布说明、有授权时发布 | 工作区不干净；门禁结果过期；演练失败时不发布；没有授权时不调用 `gh release create`；`gh` 未登录 | AT-161 |
| W6 安装体验 | 4.6：图标、中文安装界面、包信息、覆盖安装 | 高 DPI 下的图标；卸载项的图标与版本 | AT-162 |
| W7 测试、走查与演练 | 见第 7 节；4.8 的测试身份与真实安装的快照；回环地址上的假发布服务；`installer` 步骤扩展为“装旧版 → 更新 → 核对” | 本机同时装着真实的正式版与开发版时跑 `stage installer` 与 `stage gate`：照常运行，真实安装的快照前后相同 | 第 7 节 |
| W9 CI 构建与每周发布 | 4.9：`release.yml`、`stage release --ci`、版本与发布说明的生成、workflow 的静态检查、`actions-policy.json` 的允许列表 | 本周没有新合并（跳过且成功）；标签已存在；`check` 失败时不进入 `build`；`dry_run` 不发布；上一版的下载或签名核对失败时不发布；私钥没配置时 `build` 明确失败、不产出未签名的包 | AT-163 |
| W8 文档 | 需求 DATA-06、DATA-07 按实现改为“已实现”；AT-157—AT-163；Git 与 GitHub 第 2、3、5 节（发布 workflow 作为 `ci.yml` 规则的例外、`release` 环境与两把私钥、允许列表、每周发布与停用定时的处理、失败时怎么看）；数据与安全（更新的密钥与校验、更新前的备份）；Git 与 GitHub（标签、Release、密钥轮换、发布授权）；质量门禁（`install-dev`、`release` 与演练）；仓库地图（新脚本与 `dist/release/`）；交互设计（更新提示、设置 › 更新、帮助菜单、“关于”）；ADR-0007；执行状态；README 的安装与更新说明 | — | 文档检查 |

### 5.4 顺序

1. C0；D1 的第一次盘点。
2. W1 → W6（版本号与安装包信息是后面所有工作的基础）。
3. W2（只涉及本机，先让开发流程受益）。
4. W3 → W4（更新与校验一起做，W4 的拒绝路径与 W3 同时测）。
5. W5（依赖 W1、W3、W4）；W9（依赖 W5）；W7、W8；最后一次 `pnpm outdated -r`；`stage gate`；报告与整理记录。

可以按依赖调整顺序，但不得跳过任何一个工作包。

## 6. 界面要点

- 更新提示在顶部一行右侧，用现有的小按钮与气泡样式，深浅主题都要有；不弹窗、不抢焦点。只有“重启以更新”会中断正在进行的事时才弹确认框。
- “设置 › 更新”放在“设置 › 常规”之后；“帮助”菜单新增“检查更新…”与“关于 MANGA”；“关于”显示名称、版本、通道、提交、构建时间与许可证，有“复制版本信息”按钮（反馈问题时用）。
- 开发版的“关于”写明“开发版：由本机构建自动更新”，不显示检查更新的按钮。
- 所有新控件有可访问名称，可以用键盘操作；状态变化对读屏软件可见。

## 7. 样本、门禁与基准

**样本。** 全部合成：回环地址上的假发布服务（按 GitHub Releases 的文件布局提供 `latest.yml`、安装包、块图与 `.sig`）；测试用的另一把 Ed25519 密钥（测试里生成，不入库）；一份旧版本的资料用来核对更新后的迁移。

**窗口与安装观察（新增，必需）：**

| 观察 | 内容 |
| --- | --- |
| `version-about` | 正式版与开发版的“关于”显示各自的版本号格式、提交与通道；开发版没有检查更新的按钮 |
| `update-flow` | 在临时目录装版本 A 的正式版，假发布服务提供版本 B：启动后检查、下载、校验通过，顶部出现提示；点“重启以更新”后重启为 B，资料完好，迁移有备份，显示一次“已更新到 B” |
| `update-on-quit` | 同上，但不点提示直接退出：再次启动时已是 B |
| `update-rejected` | 假发布服务分别提供改过一个字节的安装包、别的版本的签名、没有签名、比当前旧的版本：都被拒绝，仍是 A，界面显示原因 |
| `update-offline` | 假发布服务不可达：自动检查不打扰；手动检查显示无法连接 |
| `install-dev` | 在临时的“机器”里装开发版并让它运行，执行 `install-dev`：开发版保存后退出、被更新并重新打开；同一台临时机器上的正式版不受影响 |
| `release-workflow` | 静态检查 `release.yml`（见 4.9 的安全边界）；用脚本模拟 `decide`：没有标签、标签后没有提交、标签后有两个合并时分别得到“发布 0.1.1”“跳过”“发布下一个版本并列出两个 PR”；`stage release --ci` 在缺私钥时失败且不留未签名的包 |
| `installer-info` | 安装包是中文界面，“安装的应用”里显示名称、版本、发布者与图标 |

上一阶段全部的窗口观察保留。截图只留关键状态：顶部的更新提示（浅色与深色）、“设置 › 更新”、“关于”。截图不含本机路径。

**基准（记录项，不设门槛）**：一次更新的下载量（差分与完整）、从点“重启以更新”到新版本可操作的用时、`install-dev` 的用时、`stage release` 的用时。现有门槛与观察全部保留，目标与测量方法不改。

**门禁。** 修复先用子集确认（`MANGA_PACKAGE_PHASES` 与 `MANGA_PACKAGE_REUSE_BUILD`、单个测试文件），最后在最终源码上跑一次 `node scripts/stage.mjs gate`（跑前确认机器空闲、启动它的应用在前台，不锁屏；跑的过程中不改工作树）。证据整体替换 `docs/evidence/gate/`，总量不超过 5 MiB，复制前先看过新截图，不含本机路径。

## 8. 人工检查

B 在用户待办里新增人工检查（编号从 H-92 起），写到用户能直接照做：门禁通过后看开发版是否自己更新并重开；在“关于”里看版本；第一次真正发布后，装着的正式版收到更新、看提示、点重启、看更新内容；在“设置 › 更新”关掉自动检查；安装界面是中文、“安装的应用”里的信息。H-84、H-85 按新的版本号与安装方式改写。人工检查保持 not-run，不由脚本代填。

## 9. B 交付与 A 审查

- B 新建本阶段报告 `docs/delivery/stage-report.md`（并加回登记表、`docs/README.md` 与 `docs/SUMMARY.md`）：按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射；写明版本号的算法、开发版自动更新的退出与安装流程、正式版更新的状态机、校验的内容与拒绝路径、发布命令每一步的产物、演练结果、依赖盘点结果、整理记录、基准数值与源码指纹。
- B 交付前自检：第 1 节的退出条件逐条有证据；`stage gate` 通过；文档检查通过；暂存内容核对过；一个带 DCO 签名的阶段提交（amend 本计划所在的提交，消息按最终结果重写）。
- A 审查时重点看：任何路径都不能执行未经 Ed25519 校验的安装包（包括 `publisherName` 缺失、`.sig` 缺失、下载中断后续传的文件）；开发版的自动更新绝不碰正式版；测试与演练只用测试身份，真实安装的快照前后相同；发布命令在没有授权时不对外发布；`release.yml` 的权限与 secret 只在 4.9 写明的 job 与步骤里，没有新合并时不发布，`dry_run` 不发布；私钥不进仓库、证据与日志；更新不打断正在进行的录音与导出；版本号在两条通道上都单调递增。

## 10. 待处理事项入口

- 需要用户的：[Q-38](../../USER-ACTIONS.md#q-38)（本阶段先用的默认值）；[ACT-17](../../USER-ACTIONS.md#act-17)（仓库配置已完成，合并后的试运行已授权）；[Q-09](../../USER-ACTIONS.md#q-09)（签名与分发，本阶段按“暂不签名”实现）；仍待答复的 [Q-37](../../USER-ACTIONS.md#q-37)、[Q-36](../../USER-ACTIONS.md#q-36)。都不阻塞本阶段。
- 新增的后续项：winget 清单（LOOP-31）；新版本启动失败时的回退帮助（LOOP-32）；上一阶段 A 审查时记下的观察项：粗剪模块停用时执行中的导出提议停在“执行中”（LOOP-33）。留在[执行状态的后续 loop](status.md#followup-loops)。
- 顺延的 Agent 侧后续项保持不变（LOOP-16、17、18、21、30）。

<a id="prompt"></a>
## 11. 交给 B 的执行 prompt

```text
你是 Agent B，在本仓库的分支 feat/m10-install-update 上连续完成当前阶段（安装与自动更新）。

依据：AGENTS.md；docs/delivery/stage-plan.md（本阶段唯一计划，全部工作包 C0、D1、W1—W9，设计 4.1—4.9）；确认记录 A-118、A-119、A-124、A-125、A-126；需求 DATA-06、DATA-07；验收 AT-157—AT-163；用户待办 Q-38（按其中的默认实现；用户答复后以答复为准）、ACT-17、Q-09。

要求：
1. 先核对现场（git status、分支基于 main@c79f49a、计划所在的提交），再按计划第 5.4 节的顺序连续实施，不逐工作包询问。
2. 依赖按计划 3.2 处理：electron-updater 与 electron-builder 取实施当天满 14 天的最新 6.x / 26.x 精确版本，不用 7.x / 27.x 的 alpha；不绕过最小发行龄。
3. 版本号按 4.1：正式版 0.1.x 从标签算出，开发版 <下一个正式版号>-dev.<UTC 年月日时分>；不为发布提交改 package.json。
4. 测试与演练里的安装一律用 4.8 的测试身份，本机装着真实版本时门禁照常运行、真实安装的快照前后相同。开发版自动更新按 4.2：只碰开发版；运行中的开发版先保存再退出，不强杀；正式版绝不受影响；CI 与 MANGA_DEV_AUTO_INSTALL=0 时跳过；结果写 install-dev.json。
5. 正式版更新按 4.3、校验按 4.4：只在正式版启用；任何路径都不能执行未经 Ed25519 校验的安装包；必须给 app-update.yml 写 publisherName 让校验函数被调用，并有测试证明去掉它时测试失败；拒绝降级、非 HTTPS、签名不符。私钥只在 dist/keys/，不进仓库、证据与日志。
6. 发布命令按 4.5：更新密钥已在 dist/keys/update-release.pem，不得重新生成或覆盖；门禁结果过期或工作区不干净时拒绝；演练失败不发布；本机没有用户当次的发布授权时绝不调用 gh release create 或推送标签，只生成 dist/release/v0.1.x/。本阶段的测试只用回环地址上的假发布服务，不访问 GitHub。
7. CI 构建与每周发布按 4.9：release.yml 与 ci.yml 分开；检查的 job 没有 secret，私钥只给 build 里打包与签名的那两步，写权限只给不装依赖的 publish；所有 Action 固定完整 SHA 并同步 actions-policy.json；workflow 有随 verify 运行的静态检查。本阶段不 push、不触发 workflow、不改仓库设置与 secrets（归 ACT-17）。
8. 安装体验按 4.6；图标先用 Agent 画的占位图标，SVG 源文件入库。
9. 改写测试与走查时断言不减；删除的断言在迁移映射里写明由什么替代。只用合成样本。
10. 修复先用子集确认；最后在最终源码上跑一次 node scripts/stage.mjs gate（跑前确认机器空闲、启动它的应用在前台，不锁屏；跑的过程中不改工作树）；证据替换 docs/evidence/gate/（≤ 5 MiB，截图不含本机路径，复制前先看过新截图）。
11. 新建本阶段报告 docs/delivery/stage-report.md（计划第 9 节，并加回登记表、docs/README.md 与 docs/SUMMARY.md），更新用户待办的人工检查（计划第 8 节，从 H-92 起）、执行状态与各正本；把全部改动 amend 进本阶段唯一的 DCO 签名提交，消息按最终结果写。不 push。
12. 结束时按开发流程 2.4 给出首选下一步：推荐交给 A 集中审查，并附审查 prompt。
```
