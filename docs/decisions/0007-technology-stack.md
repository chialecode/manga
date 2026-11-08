# ADR-0007：基础技术栈

| 字段 | 内容 |
| --- | --- |
| 编号 / 日期 | ADR-0007 / 2026-09-19 |
| 状态 | accepted（技术选型；集成与产品验收另行记录） |
| 决定者与依据 | 用户于 2026-09-19 确认沿用已讨论的选型，后续新增选择在需要时决定；2026-09-20 确认 BYOK、自研与 PI 双 AI runtime，以及自研 kernel/单写入宿主 |
| 影响范围 | A-04/A-05/A-15；POC-01/05/06；界面、存储与 Agent，后续对应能力 |
| 替代关系 | 替代 [ADR-0003](0003-ui-editing.md) 的生产 UI/编辑推荐及 [ADR-0004](0004-storage-host.md) 的驱动推荐 |

## 决定与理由

MANGA 采用成熟的界面、编辑、存储和工程基础，减少通用基础设施的维护；内容身份、稳定引用、命令、授权、模块生命周期与恢复协议由本项目掌握。依赖通过适配器接入，领域契约不绑定具体 UI、ORM 或模型 SDK。

2026-09-25 A-40 将该方向扩展为全项目的活跃开源优先原则：通用引擎、画布、下载、协议和运行基础先查证已有方案，重点做 MANGA 整合。A 制定方案前必须留下官方维护、发行与适用证据，执行口径见[选型规则](../dev-rules/architecture-and-contracts.md#open-source-first)。下表已选基础继续有效；既有自研部分作为可恢复迁移基线，后续有充分证据时可用开源替换内部实现，不用重新造库，也不未经验证批量换栈。

| 能力 | 已选择技术 | 使用边界 |
| --- | --- | --- |
| 应用界面 | React + React DOM | 渲染层和受信任 UI Facet；kernel、领域和存储不依赖 React |
| 组件、样式与图标 | shadcn/ui、Radix UI、Tailwind CSS、Lucide React | A-35 确认 shadcn 源码组件，按实际使用引入；语义 Token 与产品视觉独立维护；集成状态见执行状态 |
| 富文本与结构化输入 | Tiptap / ProseMirror | 笔记、带引用节点的输入；适配稳定块 ID、修订、撤销与 Agent 修改 |
| Markdown / 纯文本源编辑 | CodeMirror 6 | 对应源编辑视图；同一会话只有一个权威编辑状态 |
| Markdown 展示 | react-markdown + remark-gfm；按需 remark-cjk-friendly | Agent 输出和预览；安全 HTML 呈现另行验证 |
| 大列表 | TanStack Virtual | 资源与搜索列表；正文虚拟化另测选区和锚点 |
| 存储与全文索引 | SQLite + better-sqlite3 + Drizzle ORM / Kit，FTS5 | 服务或 worker 侧；ORM 类型不进入公共 DTO |
| 运行时校验 | Zod 4 | IPC、工具与资料包；升级时验证现有 Zod 3 契约 |
| ZIP 资料包 | JSZip | 校验路径、实际解压量、条目数与内存预算；ZIP 支持不等于 EPUB 支持 |
| 构建与桌面打包 | Vite + @vitejs/plugin-react + Electron Forge / plugin-vite + electron-builder（NSIS 安装包） + electron-updater（正式版更新） | 验证原生模块 ABI、重建、asar 与离线资产；正式版更新只经内置 Ed25519 公钥校验通过后才允许执行 |
| 单元与组件测试 | Vitest + Testing Library / user-event + jsdom | 既有 node:test 在覆盖迁移前保留 |
| 浏览器烟测 | playwright-core | Electron 宿主、原生 IME 与真实设备另测 |
| AI runtime 与模型协议适配 | 自研适配器 + PI（@earendil-works/pi-ai） | BYOK；首版两种实现均须实际接入，可在设置切换；运行时身份独立于 API 协议/模型/连接，工具授权与 Agent 业务规则由 MANGA 宿主管理 |
| 实时 ASR 传输 | ws | 需要 WebSocket 时接入；文件转录接口独立实现，不强制实时服务 |
| 图片处理 | sharp | 服务或 worker 侧缩略图与变换，验证大图预算和打包 |
| 凭据保护 | Electron safeStorage（异步接口） | 主进程适配器；业务配置保存 credentialRef，凭据不进入资料包；所有读取经同一个异步函数，平台要求时把新密文写回 |

## 实施与验证

1. 先建立对应使用方再引入依赖。产品已迁移到 React/Tailwind/Radix、Tiptap/CodeMirror、better-sqlite3 + Drizzle、Zod 4 与 Forge/Vite；原型工程已随获取的产品测试替代全部 POC 回归而删除，不再保留 `node:sqlite` 的原型实现。不批量添加没有使用方的库。
2. React Agent 主页面、连接设置、资源位置配置与共享业务能力先于笔记建立；Tiptap/CodeMirror 的中文输入法、选区、块拆合、撤销、保存恢复与版本冲突验证由笔记测试守护。
3. better-sqlite3/Drizzle 验证旧库打开、迁移、单写入、事务事件、崩溃恢复、FTS5 中日文检索与一致备份。保持既有迁移历史和对象身份，禁止重建用户数据库来迁就适配器。
4. 正式 Windows 包验证原生依赖、开发/正式 Profile 隔离和配置目录。原型的数据库与打包成绩不能继承到新实现。
5. Zod、JSZip 和模型适配分别验证错误、取消、范围、晚到结果与往返兼容。OpenAI 格式文本及转录的契约见 [Agent 协议](../design/agent-and-plugins.md#9-模型连接能力与路由)；SDK 未覆盖的接口由独立协议适配器补齐。
6. 选型改变须有实证理由与新的决定。新实现未验证时，状态保持“已选型、未集成/未验证”；对应结果进入 [执行状态](../delivery/status.md)。

## 后续选择

组合内核已按 ADR-0005 定稿；阅读解析器（EPUB/MOBI 的生产引擎，[Q-14](../../USER-ACTIONS.md#q-14)）、第三方插件的执行隔离（Q-06）在进入对应能力时结合证据决定，不能由本 ADR 推导为已接受。依赖具体版本由兼容性验证及锁文件确定；产品格式、目录与优先级已经确认，见[确认记录](confirmed-decisions.md)。

2026-09-25 用户要求重新评估自研阅读/播放与插件解耦：PDF.js 已接入并 accepted，播放后端与其他媒体能力的选型记录见下文[开源选型记录](#open-source-record)。Q-14—Q-16 在[用户待办](../../USER-ACTIONS.md#q-14)统一承接，不重复询问本 ADR 已接受的库。

## 2026-09-23 最新稳定依赖与 UI 决定（A-35）

用户明确 UI 使用 React + Tailwind CSS + shadcn/ui，并要求整个项目依赖都尝试最新稳定版。Tailwind 当前稳定版为 v4 不构成主版本上限；未来 v5 稳定后同样进入迁移和验证。其他运行时、编辑器、存储、模型 SDK、构建/测试与包管理工具也遵守此原则；历史证据中的版本记录保持原样。

实施时重新查询稳定发行版，检查 engine/peer、迁移说明与实际行为，精确锁定通过的版本，不把 manifest 全改为浮动 `latest`。存在实证阻塞时记录候选版本、失败和临时例外，并列后续解除条件。shadcn 的 CLI、组件源码与项目定制分别追踪，更新组件时审阅上游差异，不能覆盖现有行为修复。

依赖升级的结果见下节，Figma 与设计实现的约定见[设计规则](../design-rules/DESIGN.md#设计与实现约定)，不另开技术迁移计划。

## 2026-10-04 依赖刷新结果

Electron 37 已停止维护，而媒介能力新增了网络与媒体解析，因此在这些功能开工前先升级运行时，再尝试其他主版本；每项升级后跑类型检查与受影响测试，最后跑完整回归与打包烟测。依赖盘点由 `scripts/inventory-deps.mjs` 生成。

| 项 | 刷新前 | 现在 | 备注 |
| --- | --- | --- | --- |
| Electron | 37.4.0 | 44.5.1 | 同步 `@electron/rebuild` override；原生模块 ABI 与 asar 解包在打包烟测中核验 |
| Electron Forge | 7.11.2 | 8.0.1 | 含 plugin-vite / auto-unpack-natives / fuses |
| Vite、@vitejs/plugin-react | 7.1.5、5.0.3 | 8.3.2、6.1.1 | |
| Vitest | 3.2.4 | 5.0.3 | 测试按能力分目录，jsdom 用例以文件头声明环境 |
| TypeScript | 5.9.2 | 7.0.2 | 打开 `erasableSyntaxOnly`：源码不用 enum、命名空间与参数属性，可被 Node 的类型剥离直接运行 |
| better-sqlite3、drizzle-orm | 12.2.0、0.44.5 | 13.0.3、0.45.3 | 旧库打开、迁移与备份往返由测试守护 |
| esbuild | 0.25.10 | 0.28.2 | |
| Tiptap | 2.26.1 | 3.31.4 | 唯一的代码迁移是 `setContent` 的选项写法；未使用的 `extension-history` 已移除（历史在文档级维护） |
| 测试工具 | Testing Library 16.3.0 / 14.6.1、playwright-core 1.55.0 | 16.3.3 / 14.6.7、1.63.0 | |
| 新增（媒介能力） | — | sharp 0.35.5、yauzl 3.4.0、anitomy 0.0.35、onnxruntime-web 1.30.0、`@napi-rs/canvas` 1.0.10、jassub 2.5.16；随包 FFmpeg 8.1 LGPL 共享构建、Silero VAD 模型与 ASS 字幕默认字体（Noto Sans CJK 2.004 简体中文子集，OFL-1.1；版本与哈希锁定在 `scripts/tools/*.lock.json`） | 用途见[开源选型记录](#open-source-record)，许可见 Q-17 |
| 新增（停靠栏聊天） | — | use-stick-to-bottom 1.1.6（MIT，2026-06-04 发行，无依赖，精确固定） | 停靠栏消息流在流式输出时贴底、用户上滚后不被拉回；聊天界面结构参照 Vercel ai-elements（Apache-2.0）为 MANGA 的消息类型重写，源码注明来源与许可，不引入其运行时。选型证据与未采用方案见[开源选型记录](#open-source-record)；1000 条消息的滚动与输入延迟在基准中记录 |
| 移除 | epubjs 0.3.93、@readium/shared 2.5.1 | — | 只服务已完成的引擎对比（C4） |

**保留旧版本的例外与复查条件**（pnpm 的最小发行龄策略不绕过：版本太新时 pnpm 会自动写入豁免，U1 一律回退而不是接受豁免）。A 审查（2026-10-05）按完整回归与打包烟测关闭该升级批次；同时指出前四项只试了最新版、未满发行龄就退回旧版。下次依赖盘点复查时改取满足发行龄的最新版本，不必等最新版本本身满龄：

| 项 | 保留 | 最新稳定 | 原因与复查条件 |
| --- | --- | --- | --- |
| @types/node | 24.5.2 | 26.6.5 | 类型随运行时（Node 24.x）；Node 升级时同步 |
| openapi-typescript | 7.13.0（仅在 `dist/tools/openapi-gen` 生成 Bangumi 类型，不进仓库依赖） | — | 它依赖 TypeScript 编译器 API，而 TypeScript 7 不再提供，所以生成器在隔离目录里用 TypeScript 5.9 运行；生成结果 `bangumi-openapi.ts` 入库并固定到官方规格提交与哈希；上游支持 TypeScript 7 后改回常规开发依赖 |

## 2026-10-22 依赖刷新与分屏库

单一工作区那一阶段开始时按 A-35 再盘点一次（`pnpm outdated -r`，最小发行龄不绕过，没有写入任何豁免），并把上面保留旧版本的例外逐个复试。结果与每项的验证记录在[阶段报告](https://github.com/chialecode/manga/blob/b94b33a/docs/delivery/stage-report.md#dependencies)。

| 项 | 前 | 后 | 结果 |
| --- | --- | --- | --- |
| Electron | 44.5.1 | 44.9.3 | 同一主版本补丁；打包烟测核验原生模块与 asar |
| React / react-dom、Vite、Vitest、@vitejs/plugin-react、Zod、drizzle-orm、Tiptap、Radix、@tanstack/react-virtual、@napi-rs/canvas、playwright-core、user-event、mdast-util-to-markdown | 各自上一补丁 | 见报告 | 同一主版本内精确固定 |
| jsdom | 26.1.0 | 30.1.3 | 复试通过。共享的 `tests/helpers/setup-dom.ts` 补一条 `[popover]` 显示规则（jsdom 30 带默认隐藏规则而没有 Popover API），`:focus-visible` 的用例改用显式替身；断言不变 |
| lucide-react | 0.544.0 | 1.61.0 | 复试通过；代码里用到的 114 个图标名在 1.x 全部存在，类型检查与全量用例通过 |
| pdfjs-dist | 6.3.289 | 6.4.299 | 复试通过；断言版本的常量随之更新，PDF 文本层、字体宽度与拖选用例通过。H-01 的复核在新版本上做 |
| jassub | 2.5.16 | 2.5.23 | 复试通过 |
| @codemirror/state、view、commands | 6.5.2、6.38.1、6.8.1 | 6.7.6、6.43.15、6.11.1 | 与 `codemirror` 元包（6.0.2，已是最新）合并为一份实例；`pnpm dedupe` |
| linkedom | 0.18.13 | 保持 0.18.13 | **回退。** 0.18.14 依赖 `@acemir/cssom`，主进程打包报 `"parse" is not exported by "node_modules/@acemir/cssom/build/CSSOM.js"`（CommonJS 的具名导出 Rolldown 认不出）。复查条件：linkedom 或 `@acemir/cssom` 发行带 ESM 入口，或主进程打包能识别该导出 |
| Electron 45.0.0 | — | 不升 | 2026-10-21 发行，太新；下次盘点再试 |
| 新增 dockview-react | — | 8.6.1 | 见开源选型记录“标签页与分屏” |

## 2026-11-04 依赖刷新（Electron 45、pi-ai 1.x、安装包）

依赖与 Agent 工程循环这一阶段开始时与门禁前各盘点一次（`pnpm outdated -r`），按“满 14 天的最新精确版本”取，最小发行龄不绕过、不接受自动写入的豁免。逐项的验证见[阶段报告](https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-report.md#dependencies)。

| 项 | 前 | 后 | 结果 |
| --- | --- | --- | --- |
| Electron | 44.9.3 | 45.0.0 | 升级（2026-11-04 起满 14 天，当天满龄的只有 45.0.0）。凭据改用异步的 `safeStorage` 接口，同步接口在源码里只留给生成旧版 Profile 的样本脚本（`scripts/check-deps.mjs` 守护）；Electron 44 保存的三种凭据在 45 的打包产物上解得开（打包观察 `credentials-async`）。沙箱预加载没有用到被移除的 `Buffer` / `setImmediate` / Node 模块 |
| @earendil-works/pi-ai | 0.85.1 | 1.3.0 | 升级到当天满 14 天的最新（1.4.0 在 2026-11-04 22:43 UTC 满龄，晚于本次盘点）。工具参数直接写 JSON Schema，不再从 pi-ai 取 TypeBox，1.4 与 1.5 的入口变化不影响；两个运行时的契约用例（`tests/agent/runtime-contract.test.ts`）覆盖工具 Schema、流式、图片与中止。复查条件：下次盘点取满龄的最新 1.x |
| electron-builder（新增，开发依赖） | — | 26.18.0 | 只用它的 NSIS 目标、以 `--prepackaged` 把 Forge 打好的目录做成按用户安装的安装包；`electron-winstaller` 的安装脚本在 `pnpm-workspace.yaml` 里关掉（不用 Squirrel） |
| knip | 6.41.0 | 6.42.1 | 满龄的最新 |
| @types/node | 24.5.2 | 24.19.2 | 留在 24.x，与 Electron 45 的 Node 24 和 CI 的 Node 一致 |
| linkedom | 0.18.13 | 保持 0.18.13 | **再次回退。** 复试 0.18.14：`vitest run tests/danmaku/credential-leak.test.ts`（它先做主进程打包）报 `MISSING_EXPORT`：`parse` 不是 `@acemir/cssom` 的导出（CommonJS 的具名导出 Rolldown 认不出）。上游没有新的发行。复查条件同上一次 |
| dockview-react、@tanstack/react-virtual 与其余补丁 | — | 不变 | 实施时更新的版本都不满 14 天（dockview-react 8.6.2 在 11-08、react-virtual 3.14.22 在 11-05 满龄），门禁前再查一次 |

**长对话的列表（LOOP-07）。** 计划先试“`@tanstack/react-virtual` 的虚拟列表 + use-stick-to-bottom 贴底”，两者共用 use-stick-to-bottom 的滚动容器：虚拟列表用它的 `scrollRef` 作滚动元素，`scrollMargin` 取列表在容器里的偏移；贴底由 use-stick-to-bottom 负责，行高变化时只在“不在底部、变化的行在视口之上”时由虚拟列表修正滚动位置。向上载入更早的一页与主机通知刷新时，视口顶端那条消息由 MANGA 自己按消息 ID 与偏移锚定（删掉时改用相邻的一条）。结论见[阶段报告](https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-report.md#stick-to-bottom)：两者没有争夺滚动位置，保留 use-stick-to-bottom，不改为自己贴底。它对内容变高的跟随改为立即（`resize="instant"`）。因为它的尺寸观察晚一帧，列表在提交后的布局阶段把“上次停在最底下、没有被用户解除贴底”的列表放回底部。

**任务图像的存放（LOOP-05）是自写的。** 一张按 SHA-256 为键的 `agent_media` 表与一张运行到图像的引用表，放在现有的 SQLite 里，用 Node 的 `crypto` 求哈希；需要的只是“同样内容只存一份、引用计数为零时删除”，引入对象存储库或另一个数据库得不偿失。

**基准不受节能降速（LOOP-13）。** 用 Windows 的 `SetProcessInformation(ProcessPowerThrottling)` 关闭基准进程的执行速度节流，经系统自带的 PowerShell `Add-Type` 调用，不加依赖；只在 `stage bench` 设 `MANGA_BENCH_NO_THROTTLE=1` 时、只对基准阶段的进程生效。评估与是否启用见[阶段报告](https://github.com/chialecode/manga/blob/fd32430/docs/delivery/stage-report.md#loop-13)。

## 2026-11-07 依赖刷新与待审操作自研说明

Agent 的待审操作与门禁提速这一阶段开始时与门禁前各盘点一次（`pnpm outdated -r`），按“实施当天满 14 天的最新精确版本”升级，最小发行龄不绕过。逐项验证见[阶段报告](https://github.com/chialecode/manga/blob/c79f49a/docs/delivery/stage-report.md#dependencies)。

| 项 | 前 | 后 | 结果 |
| --- | --- | --- | --- |
| @earendil-works/pi-ai | 1.3.0 | 1.4.0 | 升级（官方 npm registry 的 `time`：2026-10-21 22:43 UTC，已满 14 天；最新 1.5.0 于 11-02 发行未满龄）。类型检查与双运行时契约用例（`tests/agent/runtime-contract.test.ts`）通过 |
| @tanstack/react-virtual | 3.14.21 | 3.14.22 | 升级（2026-10-22 12:04 UTC，已满 14 天；最新 3.14.26 于 11-03 发行未满龄）。5000 条消息虚拟列表与带提议卡片的动态行高测量（`tests/shell/proposals-ui.test.tsx`、`chat-long-session`）通过 |
| linkedom | 0.18.13 | 保持 0.18.13 | **复试后回退。** 尝试 0.18.14（官方发行日期为 2026-10-21，已满龄），主进程打包报 `MISSING_EXPORT`：`parse` 不是其依赖 `@acemir/cssom` 的具名导出。该依赖是 CommonJS，现有打包路线不能识别此导出。复查条件：linkedom 或该依赖发布可识别的 ESM 导出，或打包器支持该 CommonJS 导出；保持现版本并由主进程构建用例覆盖 |
| dockview-react 与其余补丁 | 8.6.1 等 | 不变 | 2026-11-07 对 65 个直接依赖读取官方 npm registry 的发行时间，除 linkedom 的已登记例外外，当前版本均为同主版本中满 14 天的最新。`dockview-react` 8.8.3、Electron 45.2.3、Vitest 5.1.0 等更新尚未满龄；Tiptap 3.32.0、Vite 8.3.5 与 Vitest 5.0.5 的现版本已经满龄。`@types/node` 留在 24.x，保持与 Electron/CI 运行时一致 |

**待审操作状态机、提议卡片与烟测条件等待为仓内自写（A-40、A-121）：**

- **待审操作状态机与原子消费：** 复用 SQLite、命令网关与成功回执。创建提议与工具回执一起保存；确认原子抢占后，同步效果与回执在最后一次修订核对的事务里一起提交，项目包用发布摘要恢复，粗剪按持久任务完成状态恢复。A 已核对的人工审批候选、官方来源与适配理由见[阶段计划第 3 节](https://github.com/chialecode/manga/blob/c79f49a/docs/delivery/stage-plan.md#31-候选)：需要不暂停任务、在下一轮带回结果，现有 SDK 的运行状态与本项目的双运行时不同；只补五种已有命令的确认入口，保留一份状态源。
- **提议卡片界面：** 在 `apps/desktop/src/renderer/components/chat/messages.tsx` 中用现有的卡片、按钮、危险按钮样式与语义 token 渲染，随 `session.stream` 装入对应的助手消息并参与 `@tanstack/react-virtual` 的 `measureElement` 动态行高测量，不引入独立聊天 UI 框架（如 `@assistant-ui/react`）。
- **打包烟测的条件等待（LOOP-29）：** 复用 `apps/desktop/src/main/smoke/driver.ts` 的 `waitUntil`、`waitForTestId`，补充 `waitText`、`waitFrames`、`waitDrawn`，通过 `webContents.executeJavaScript` 等待实际状态；无需另换测试运行器。

## 2026-11-08 依赖盘点与自动更新选型

安装与自动更新阶段开始时与门禁前各执行一次 `pnpm outdated -r`，按“实施当天满 14 天的最新精确版本”处理，最小发行龄策略（`minimumReleaseAge: 20160` 分钟）不绕过、不写入豁免。

| 项 | 前 | 后 | 结果 |
| --- | --- | --- | --- |
| electron-updater（新增，`apps/desktop` 依赖） | — | 6.8.11 | 2026-10-20 20:51 UTC 发行，已满 14 天（6.8.12 于 2026-10-25 23:54 UTC 发行，实施时尚未满 14 天；7.x 仍为 alpha 且改为无 Windows 代码签名即拒绝更新，正式发行并与 Q-09 一起评估后再议）。配合 `app-update.yml` 的 `publisherName: ["chialecode"]` 接入自定义 `verifyUpdateCodeSignature`（见开源选型记录） |
| knip | 6.42.1 | 6.43.0 | 升级（2026-10-24 07:45 UTC 发行，已满 14 天；最新 6.46.0 未满龄）。`node scripts/verify.mjs` 通过 |
| electron-builder | 26.18.0 | 保持 26.18.0 | 26.18.1 于 2026-10-25 23:54 UTC 发行，实施时距满 14 天尚差数小时，按最小发行龄策略保持 26.18.0；下次盘点满龄后升级 |
| linkedom | 0.18.13 | 保持 0.18.13 | 已登记例外不变（0.18.14 的 `@acemir/cssom` CommonJS 导出限制未变，上游尚无新发行） |
| dockview-react、Electron、Vitest 与其余依赖 | 8.6.1、45.0.0、5.0.5 等 | 不变 | 2026-11-08 核对 npm registry `time`：高于当前锁定版本的候选（如 Electron 45.2.3、dockview-react 8.8.3、@earendil-works/pi-ai 1.5.0、@tanstack/react-virtual 3.14.26 等）发行均未满 14 天，保持当前精确版本 |

## 2026-09-20 接入与构建边界

AI runtime 切换保存为设置，运行开始时固定所选实现；切换只影响后续运行，活动任务继续使用原实现或由用户取消，不静默转接、扩大授权或丢失会话/工具证据。旧配置缺 runtime 字段时兼容自研适配器。自研与 PI 均用相同受控提供者验证文本、工具、流式、取消与错误，安装 PI 依赖不构成接入完成。实现与复验由 `tests/agent` 守护。

Windows 原生构建优先在独立打包暂存目录对 better-sqlite3 执行 @electron/rebuild，再验证目标 Electron ABI 与 asar 解包；开发 Node 绑定不被覆盖。预编译二进制可作为按版本/ABI/架构核验的备选。本机工具链事实见审查证据，不因早期未安装记录再次要求安装。

<a id="open-source-record"></a>
## 开源选型记录（A-40）

查询日期 2026-10-03（媒介能力）与 2026-10-06（聊天、扫描、元数据）；来源是官方仓库 API、npm registry 与官方文档。“维护”只指近期有提交或发行，适用性以实测为准。表中是已采用的选择与未采用的理由；EPUB/MOBI 的生产引擎仍未定，候选是 epub.js、Readium Web、foliate-js（MOBI/KF8 的候选 foliate-js 接口不稳定），见 [Q-14](../../USER-ACTIONS.md#q-14)。

| 能力 | 采用 | 未采用与理由 |
| --- | --- | --- |
| 桌面运行时 | Electron 45.0.0（Chromium 156，Node 24.22），2026-11-04 满 14 天后升级；下次盘点取满龄的最新 45.x | 停留 37：Electron 只维护最新三个稳定主版本，37 系已无安全补丁 |
| 视频播放 | Chromium `<video>`，经自定义 `manga-media:` 协议流式读取；`protocol.handle` + `net.fetch(file:)` 不处理 Range，所以自行返回 206/416。Windows 上 HEVC 走 D3D11 硬件解码，没有软件回退 | libmpv：在 Electron 中需要原生插件和实验性 `sharedTexture`，默认 GPL；播放副本已能覆盖无硬件 HEVC |
| 探测、帧时间戳、字幕与字体提取、重封装、播放副本 | FFmpeg 8.1 LGPL 构建（BtbN `win64-lgpl-shared-8.1`），子进程调用。LGPL 变体含 HEVC 解码器、AAC 编码器、NVENC/AMF/QSV 硬件编码、SVT-AV1、libvpx、libopus、libass，没有 GPL 专属的 x264/x265；粗剪也用同一工具 | mediabunny 1.61.0（MPL-2.0）不读取 ASS 与字体附件，记为备选；`ffmpeg-static` 是 GPL 构建；openh264 默认不用（自编译二进制不在 Cisco 专利许可范围内，Q-17） |
| 无硬件 HEVC 与不支持音轨 | 本地播放副本：视频优先用硬件 H.264 编码，没有则用 SVT-AV1 快速预设（Chromium 用 dav1d 软件解码）；音频转 AAC；保持原时间戳（VFR 不改帧率） | — |
| ASS 渲染 | JASSUB 2.5.16（libass 编译为 WASM）；npm 许可声明含 MIT、ISC、LGPL-2.1+、FTL/GPL-2.0 等组件，随包附声明。JASSUB 没有指定默认字体时回退到只含西文字形的内置字体，样式字体缺失的中文会画成方块，所以随包放一个含中日文字形的开源字体作默认字体（Noto Sans CJK 简体中文子集，OFL-1.1，约 8 MiB，不含韩文）；它不可用时才用本机字体 | 不自写 ASS 排版；系统字体查询在开发机上没有加载成功，不能作为唯一依赖 |
| 多音轨 | Chromium `audioTracks`（Blink 特性 `AudioVideoTracks`）；不可用时用 FFmpeg 把所选音轨重封装到缓存 | — |
| 漫画 CBZ 与本地元数据 | yauzl 3.4.0（MIT）按需读取单个条目；`ComicInfo.xml` 按 Anansi Project 规范解析 | JSZip 需要整包载入内存，不适合数百 MB 的 CBZ（资料包继续用 JSZip） |
| 缩略图与封面 | sharp 0.35.5（Apache-2.0） | Electron `nativeImage` 同步解码会阻塞主进程 |
| Bangumi 接口 | 官方 OpenAPI v0；用 openapi-typescript 生成类型并提交生成结果与规格提交号，运行时用 Zod 校验实际使用的字段。端点：搜索（标注为实验性）、条目详情、关联条目、剧集、角色（含 `actors` 声优）、人物（含 `career`）；UA 规范要求带开发者 ID、应用名、版本与项目主页。维护者 2026-09-26 答复公开条目数据可自行存储与缓存（bangumi/api#294）；官方未公布限流数值；2026-07 起中国大陆无法直连（#284） | 第三方客户端库：官方规范可直接生成类型，少一层依赖 |
| 动画文件名解析 | anitomy（TS 移植）0.0.35（MIT），经适配层隔离，失败时退回自然排序 | anitomyscript（Emscripten 版，npm 停在 2022）；0.0.x 接口可能变化 |
| 网络 | Electron `net.fetch`（Chromium 网络栈，跟随系统代理） | Node `fetch` 默认不读系统代理 |
| 麦克风采集 | Chromium `getUserMedia`（按 deviceId 选择，启用回声消除与降噪约束）加 AudioWorklet 输出 16 kHz 单声道 PCM，分块追加写盘 | 以 MediaRecorder 为主路径：崩溃后封装不完整，且仍需解码才能筛人声 |
| 人声筛选 | Silero VAD v6.2.3（MIT）的 ONNX 模型，在独立 worker 中用 onnxruntime-web 1.30.0 的 WASM 后端运行；模型约 2 MB，随包离线 | onnxruntime-node（原生插件，性能不足时备选）；@ricky0123/vad-web 面向浏览器实时流；WebRTC VAD 在音乐与噪声上误检更多 |
| 录音保存与上传 | 保留模式用 FFmpeg（libopus）把 PCM 转为 Opus 存入附件；上传给 ASR 的块用 WAV（16 kHz 单声道） | — |
| 视觉与 OCR 路由 | 沿用 OpenAI 格式协议的图像输入（Responses `input_image`、Chat Completions `image_url`），不新增依赖 | tesseract.js 7.0.0：竖排日文漫画效果差，且本地 OCR 不是需求 |
| 大列表 | TanStack Virtual 3.14.22 | — |
| 标签页与分屏（2026-10-22 查证） | dockview-react 8.6.1（MIT，核心 `dockview-core` 零依赖，仓库 2026-10-21 仍有推送，周下载约 27 万，peer 支持 React 19），面板一律 `renderer: "always"`。试验在隔离页里用真实视频、漫画页与文稿在 Electron 44 / React 19 下六项全部满足：四种布局互相切换标签不丢；播放中的视频在栏间、栏边新栏和栏内移动后 `currentTime` 连续且无 `emptied` / `loadstart`（`always` 把内容放在覆盖层里只改位置，不搬 DOM）；布局可序列化恢复（未知的标签类型由应用自己保留，因为 `fromJSON` 遇到未知组件会抛错）；`--dv-*` 映射到 MANGA 的设计 token，深浅主题都对；方向键与 `Home` / `End` 内置，`Ctrl+Tab` 由应用处理；与 `<Activity>`、门户共存。体积：压缩后约 400 KB，样式约 160 KB。试验结果见[阶段报告](https://github.com/chialecode/manga/blob/b94b33a/docs/delivery/stage-report.md#dockview) | flexlayout-react 0.11.1（备选，生态较小）；react-resizable-panels 4.14.8（只有分隔，没有标签，作为不合格时的退路，未启用）；react-mosaic-component 7.2.1（没有标签组）；allotment 1.20.6（只有分隔视图） |
| 聊天界面 | 参照 Vercel ai-elements（Apache-2.0）的 conversation、message、prompt-input 结构，为 MANGA 的消息类型重写，源码注明来源与许可；Markdown 继续用 react-markdown 与 remark-gfm | @assistant-ui/react 0.15.23：自带运行时与状态库，会与已有的会话、运行与快照模型形成两套状态 |
| 消息流贴底 | use-stick-to-bottom 1.1.6（MIT），与 @tanstack/react-virtual 的虚拟列表共用滚动容器（2026-11-04 试验） | 自写滚动判定；react-virtuoso（要把列表与贴底整体换掉，两条现有路线可用时不评估） |
| 安装包（2026-11-04 查证） | electron-builder 26.18.0 的 NSIS 目标（MIT，开发依赖），`--prepackaged` 用 Forge 的产物，按用户安装到 `%LOCALAPPDATA%\Programs\manga`；图标由 SVG 源文件经 `sharp` 与 `resedit` 生成多尺寸 `.ico` 并写入可执行文件资源，安装界面设为简体中文（`2052` / `zh_CN`） | @electron-forge/maker-squirrel（固定装到 `%LocalAppData%\<应用名>`，不能选目录）；maker-wix（要另装 WiX）；maker-msix（`AppData` 被虚拟化） |
| 正式版应用内更新（2026-11-08 查证） | electron-updater 6.8.11（MIT，与 electron-builder 同源）配合仓内 `UpdateService`：支持 NSIS 安装包、GitHub Releases 与通用 HTTP 源、按 `.blockmap` 块图做 HTTP Range 差分下载、`autoInstallOnAppQuit`、拒绝降级（`allowDowngrade = false`） | Electron 自带 `autoUpdater`（Windows 上绑定 Squirrel.Windows，与已定的 NSIS 按用户安装冲突）；Velopack 1.3.39（自带安装器与更新器，会替换现有 NSIS 安装目录约定） |
| 更新包防篡改校验（2026-11-08 查证） | Node 内置 `crypto` 的 Ed25519 分离签名（`.sig`）：独立于插件密钥的 `dist/keys/update-release.pem` 对安装包的 `SHA-512 + 版本号 + 文件名` 签名，公钥内置在 `packages/app-core/src/update/signature.ts`；正式版 `resources/app-update.yml` 写入 `publisherName: ["chialecode"]` 使 `NsisUpdater.verifySignature` 调用自定义 `verifyUpdateCodeSignature`，同时 `UpdateService` 在标记就绪与执行安装前做纵深防御二次校验（缺失 `publisherName`、缺失 `.sig`、篡改 1 字节、旧版签名冒充、降级、非 HTTPS 一律拒绝并删除下载文件） | Windows Authenticode 代码签名（Q-09 当前默认暂不签名：Azure Artifact Signing 个人开发者仅开放美加，Certum 收费，SignPath 要求知名度，Store 仅支持 MSIX）；只靠 `latest.yml` 的 SHA-512（无法防御更新源清单与安装包被同时替换） |
| 发布到 GitHub Releases 与每周 CI 构建（2026-11-08 查证） | GitHub CLI `gh release`（MIT，本机与 GitHub 托管运行器自带）创建标签与 Release；CI 构建采用固定标签的 GitHub 托管运行器 `windows-2025`（不用随时迁移的 `windows-latest`），`build` 与 `publish` 两个 job 之间用官方 `actions/upload-artifact` v7.0.2 与 `actions/download-artifact` v8.0.2（均满 14 天，固定完整 SHA）传产物，使写权限只留在不装依赖、不碰私钥的 `publish` job | electron-builder 自带上传（需把写权限令牌交给构建进程）；第三方 release Action（扩大 Actions 允许列表与供应链面） |
| 目录遍历与定时扫描 | Node 内置 `fs.promises.opendir`，在 `worker_threads` 中执行，写库仍由单写入宿主按小批次完成；定时用应用内计时器（关闭、30 分钟、1 小时、6 小时、每天）与启动后延迟扫描 | fdir 6.5.0：瓶颈不在遍历本身；croner 10.0.1：用不到 cron 表达式 |
| 文件变更监听 | 不采用（用户要求的是按间隔扫描） | chokidar 5.0.0 与 @parcel/watcher 2.6.0：大目录树长期监听有句柄与网络盘问题，需要“即时发现新文件”时的候选 |
| 播放器控件 | 保留原生 `video` 播放器，只改样式与控件布局 | media-chrome 4.19.3：换控件层要重接帧号跳转、JASSUB、A-B 与录音标记；Vidstack 的 React 包 0.6.15 停在 2024-04 |
| 快捷任务模板 | 只替换白名单占位符的简单渲染 | mustache 4.2.0 停在 2021，条件与循环没有需求，还会让模板看起来能执行逻辑 |
| 每个视图一份布局（2026-10-24 查证） | 沿用 dockview-react 8.6.1：每个上下文里每个视图一个 dockview 实例，只有当前视图的那个可见，其余挂着、用统一的隐藏层（`data-hidden-layer`）藏起；布局各自用 `toJSON` / `fromJSON` 存进工作区状态 version 2。阅读器与编辑器挂在按标签编号的宿主里，一个标签同时出现在主页与它的功能视图时是同一个实例，换视图不重建 | 一个实例切换视图时 `fromJSON` 换布局：`fromJSON` 先清掉全部面板再按新布局建，面板内容会卸下再挂上，播放中的视频要重新载入，不满足“切走切回 `currentTime` 连续”。这条是按 dockview 的行为判断，没有另做隔离试验；采用的路线由打包窗口观察 `view-main-linkage` 验证 |
| 拖过最窄即收起（2026-10-24 查证） | 改在现有的分隔条（`shell.tsx` 的 `Divider`）里，借用 react-resizable-panels 4.14.8 的 `collapsible` 与 allotment 1.20.6 的 `snap` 语义：越过最窄宽度的一半才收起，宽度偏好保持拖动前的值；键盘照 WAI-ARIA APG 的 Window Splitter（Enter 收起与恢复） | 引入这两个库：外壳的侧栏与停靠栏是固定宽度的列，不是按比例分配的面板组，换库要重写外壳与它的观察 |
| 图标栏拖动换位置（2026-10-24 查证） | 自写：十来个固定高度的图标，用与分隔条相同的指针捕获做纵向排序，按下后移动约 4 px 才开始拖动，Esc 或拖出图标栏取消；键盘用右键菜单的“上移 / 下移” | @dnd-kit/core 6.3.1 与 @dnd-kit/sortable 10.0.0：最后发行在 2024-12；@dnd-kit/react 0.5.1：未到 1.0、发行不满 14 天；@atlaskit/pragmatic-drag-and-drop 4.0.0：基于原生拖放，dockview 的标签拖动也用原生拖放，两者在主区上空会互相响应 |
| 侧栏的引导线（2026-10-24 查证） | CSS 左边框画 1 px 竖线；侧栏只有“上下文 → 条目”两层、每组分页 | react-arborist 4.0.1、@headless-tree/react 1.8.0：不需要虚拟化的树、拖放与键盘树导航 |
| 小说分页（2026-10-26 查证） | 在现有的文本层上自写：一章放进页框大小的 CSS 多栏容器，`column-width` 等于页宽，一栏一页，翻页平移一个页宽；页与文本偏移的换算用 `Range.getClientRects` 与 `caretPositionFromPoint`，位置仍是 `NORMALIZATION_V1` 的文本锚点 | foliate-js（npm 1.0.1 停在 2025-04）、@readium/navigator 2.14.0（发行不满 14 天）：在 iframe 里渲染原始出版物、用自己的位置（CFI 或 Readium 的定位），笔记、书签、进度与 Agent 的已读范围都要另起一套或双向换算；epub.js 0.3.93：GitHub 最后一个发行在 2020 年 |
| 无用代码（2026-10-24 查证，2026-11-02 接入） | knip 6.41.0（ISC，开发依赖，查询时满 14 天的最新版；6.43.0 当时不满 14 天）接进 `node scripts/verify.mjs`：没有用到的文件、导出与依赖算失败；`knip.json` 写明它自己找不到的入口（打包入口、worker、插件进程与测试的子进程）与动态加载的依赖 | — |
| 封面原图 | 独立图片表，按内容哈希去重，列表查询不读字节（A-51） | 文件附件（原方案）：用户决定改存数据库。SQLite 官方对比：约 100 KB 以上的 BLOB 放外部文件读得更快，封面原图通常 100—500 KB，存库读取略慢，但备份与迁移只需一个文件 |

## 模型用途隔离（A-27）

LLM、Embedding、ASR 使用独立 ModelProfile 与任务绑定，分别配置对应类型的模型、连接、凭据和探针；不把文本模型自动复用于转录或向量化。音频只交给已配置的 ASR，转录文本才能进入后续 LLM 整理。切换自研/PI runtime 不隐式更换模型用途。当前 LLM 与 ASR 的本地测试配置均为 OpenAI 兼容接口，已完成有限真实短测；Embedding 尚未配置。具体契约见 [模型路由](../design/agent-and-plugins.md#91-三层配置)，测试配置遵循 [A-29](../dev-rules/development-workflow.md#model-test-config)，文档不指定模型或服务默认值。
