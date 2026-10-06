# ADR-0007：基础技术栈

| 字段 | 内容 |
| --- | --- |
| 编号 / 日期 | ADR-0007 / 2026-09-19 |
| 状态 | accepted（技术选型；集成与产品验收另行记录） |
| 决定者与依据 | 用户于 2026-09-19 确认沿用已讨论的选型，后续新增选择在需要时决定；2026-09-20 确认 BYOK、自研与 PI 双 AI runtime，以及自研 kernel/单写入宿主 |
| 影响范围 | A-04/A-05/A-15；POC-01/05/06；M1 界面、存储与 Agent，后续对应能力 |
| 替代关系 | 替代 [ADR-0003](0003-m0-ui-editing.md) 的生产 UI/编辑推荐及 [ADR-0004](0004-m0-storage-host.md) 的驱动推荐 |

## 决定与理由

MANGA 采用成熟的界面、编辑、存储和工程基础，减少通用基础设施的维护；内容身份、稳定引用、命令、授权、模块生命周期与恢复协议由本项目掌握。依赖通过适配器接入，领域契约不绑定具体 UI、ORM 或模型 SDK。

2026-09-25 A-40 将该方向扩展为全项目的活跃开源优先原则：通用引擎、画布、下载、协议和运行基础先查证已有方案，重点做 MANGA 整合。A 制定方案前必须留下官方维护、发行与适用证据，执行口径见[选型规则](../dev-rules/architecture-and-contracts.md#open-source-first)。下表已选基础继续有效；既有自研部分作为可恢复迁移基线，后续有充分证据时可用开源替换内部实现，不用重新造库，也不未经验证批量换栈。

| 能力 | 已选择技术 | 使用边界 |
| --- | --- | --- |
| 应用界面 | React + React DOM | M1 渲染层和受信任 UI Facet；kernel、领域和存储不依赖 React |
| 组件、样式与图标 | shadcn/ui、Radix UI、Tailwind CSS、Lucide React | A-35 确认 shadcn 源码组件，按实际使用引入；语义 Token 与产品视觉独立维护；集成状态见执行状态与计划 |
| 富文本与结构化输入 | Tiptap / ProseMirror | 笔记、带引用节点的输入；适配稳定块 ID、修订、撤销与 Agent 修改 |
| Markdown / 纯文本源编辑 | CodeMirror 6 | 对应源编辑视图；同一会话只有一个权威编辑状态 |
| Markdown 展示 | react-markdown + remark-gfm；按需 remark-cjk-friendly | Agent 输出和预览；安全 HTML 呈现另行验证 |
| 大列表 | TanStack Virtual | 资源与搜索列表；正文虚拟化另测选区和锚点 |
| 存储与全文索引 | SQLite + better-sqlite3 + Drizzle ORM / Kit，FTS5 | 服务或 worker 侧；ORM 类型不进入公共 DTO |
| 运行时校验 | Zod 4 | IPC、工具与资料包；升级时验证现有 Zod 3 契约 |
| ZIP 资料包 | JSZip | 校验路径、实际解压量、条目数与内存预算；ZIP 支持不等于 EPUB 支持 |
| 构建与桌面打包 | Vite + @vitejs/plugin-react + Electron Forge / plugin-vite | 验证原生模块 ABI、重建、asar 与离线资产 |
| 单元与组件测试 | Vitest + Testing Library / user-event + jsdom | 既有 node:test 在覆盖迁移前保留 |
| 浏览器烟测 | playwright-core | Electron 宿主、原生 IME 与真实设备另测 |
| AI runtime 与模型协议适配 | 自研适配器 + PI（@earendil-works/pi-ai） | BYOK；首版两种实现均须实际接入，可在设置切换；运行时身份独立于 API 协议/模型/连接，工具授权与 Agent 业务规则由 MANGA 宿主管理 |
| 实时 ASR 传输 | ws | 需要 WebSocket 时接入；M1 文件转录接口独立实现，不强制实时服务 |
| 图片处理 | sharp | 服务或 worker 侧缩略图与变换，验证大图预算和打包 |
| 凭据保护 | Electron safeStorage | 主进程适配器；业务配置保存 credentialRef，凭据不进入资料包 |

## 实施与验证

1. 先建立对应使用方再引入依赖。产品已迁移到 React/Tailwind/Radix、Tiptap/CodeMirror、better-sqlite3 + Drizzle、Zod 4 与 Forge/Vite；`experiments/m0` 保留 textarea、`node:sqlite` 与 fflate 的原型回归，到 M4 获取替代 POC-09 后删除。不批量添加没有使用方的库。
2. M1 先建立 React Agent 主页面、连接设置、资源位置配置与共享业务能力。笔记阶段再接入 Tiptap/CodeMirror；分别补中文输入法、选区、块拆合、撤销、保存恢复与版本冲突验证。
3. better-sqlite3/Drizzle 验证旧库打开、迁移、单写入、事务事件、崩溃恢复、FTS5 中日文检索与一致备份。保持既有迁移历史和对象身份，禁止重建用户数据库来迁就适配器。
4. 正式 Windows 包验证原生依赖、开发/正式 Profile 隔离和配置目录。原型的数据库与打包成绩不能继承到新实现。
5. Zod、JSZip 和模型适配分别验证错误、取消、范围、晚到结果与往返兼容。OpenAI 格式文本及转录的契约见 [Agent 协议](../design/agent-and-plugins.md#9-模型连接能力与路由)；SDK 未覆盖的接口由独立协议适配器补齐。
6. 选型改变须有实证理由与新的决定。新实现未验证时，状态保持“已选型、未集成/未验证”；对应结果进入 [执行状态](../delivery/status.md)。

## 后续选择

组合内核已按 ADR-0005 定稿；阅读解析器、媒体播放/ASS 后端、BitTorrent 引擎、画布编辑和第三方隔离方案在进入对应阶段时结合证据决定，不能由本 ADR 推导为已接受。依赖具体版本由兼容性验证及锁文件确定；产品格式、目录与优先级已经确认，见 [确认记录](confirmed-decisions.md)。

2026-09-25 用户要求重新评估自研阅读/播放与插件解耦。候选与取舍见 [M1b 总结第 5 节](../evidence/m1b-summary.md)与 [Q-14](../../USER-ACTIONS.md#q-14)：PDF.js 已接入并 accepted，比较 EPUB 引擎，播放后端由 M2 验证（见 [M2 计划第 3 节](../delivery/m2-media-mvp-plan.md#3-开源查证与整合路线a-40)）。Q-14—Q-16 在[用户待办](../../USER-ACTIONS.md#q-14)统一承接，不重复询问本 ADR 已接受的库。

## 2026-09-23 最新稳定依赖与 UI 决定（A-35）

用户明确 UI 使用 React + Tailwind CSS + shadcn/ui，并要求整个项目依赖都尝试最新稳定版。Tailwind 当前稳定版为 v4 不构成主版本上限；未来 v5 稳定后同样进入迁移和验证。其他运行时、编辑器、存储、模型 SDK、构建/测试与包管理工具也遵守此原则；历史证据中的版本记录保持原样。

实施时重新查询稳定发行版，检查 engine/peer、迁移说明与实际行为，精确锁定通过的版本，不把 manifest 全改为浮动 `latest`。存在实证阻塞时记录候选版本、失败和临时例外，并列后续解除条件。shadcn 的 CLI、组件源码与项目定制分别追踪，更新组件时审阅上游差异，不能覆盖现有行为修复。

依赖升级由 M2 的 U1 实施（结果见下节），Figma 与设计实现的约定见[设计规则](../design-rules/DESIGN.md#设计与实现约定)，不另开技术迁移计划。

## 2026-10-04 M2 依赖刷新结果（U1，LOOP-02）

Electron 37 已停止维护，M2 新增网络与媒体解析，因此 U1 在媒体与网络功能开工前先升级运行时，再尝试其他主版本；每项升级后跑类型检查与受影响测试，最后跑完整回归与打包烟测。完整盘点见 [M2 交付报告](../evidence/m2-media-mvp-delivery.md)的依赖节。

| 项 | M1b 基线 | 现在 | 备注 |
| --- | --- | --- | --- |
| Electron | 37.4.0 | 44.5.1 | 同步 `@electron/rebuild` override；原生模块 ABI 与 asar 解包在打包烟测中核验 |
| Electron Forge | 7.11.2 | 8.0.1 | 含 plugin-vite / auto-unpack-natives / fuses |
| Vite、@vitejs/plugin-react | 7.1.5、5.0.3 | 8.3.2、6.1.1 | |
| Vitest | 3.2.4 | 5.0.3 | 测试按能力分目录，jsdom 用例以文件头声明环境 |
| TypeScript | 5.9.2 | 7.0.2 | 打开 `erasableSyntaxOnly`：源码不用 enum、命名空间与参数属性，可被 Node 的类型剥离直接运行 |
| better-sqlite3、drizzle-orm | 12.2.0、0.44.5 | 13.0.3、0.45.3 | 旧库打开、迁移（schema v7）与备份往返由测试守护 |
| esbuild | 0.25.10 | 0.28.2 | |
| Tiptap | 2.26.1 | 3.31.4 | 唯一的代码迁移是 `setContent` 的选项写法；未使用的 `extension-history` 已移除（历史在文档级维护） |
| 测试工具 | Testing Library 16.3.0 / 14.6.1、playwright-core 1.55.0 | 16.3.3 / 14.6.7、1.63.0 | |
| 新增（M2） | — | sharp 0.35.5、yauzl 3.4.0、anitomy 0.0.35、onnxruntime-web 1.30.0、`@napi-rs/canvas` 1.0.10、jassub 2.5.16；随包 FFmpeg 8.1 LGPL 共享构建与 Silero VAD 模型（版本与哈希锁定在 `scripts/tools/*.lock.json`） | 用途与许可见交付报告；Q-17 |
| 新增（M2 返工） | — | use-stick-to-bottom 1.1.6（MIT，2026-06-04 发行，无依赖，精确固定） | 右栏消息流在流式输出时贴底、用户上滚后不被拉回；聊天界面结构参照 Vercel ai-elements（Apache-2.0）为 MANGA 的消息类型重写，源码注明来源与许可，不引入其运行时。选型证据与未采用方案见[M2 计划 14.3](../delivery/m2-media-mvp-plan.md#143-开源查证a-402026-10-06)；1000 条消息的滚动与输入延迟在 bench 中记录 |
| 移除 | epubjs 0.3.93、@readium/shared 2.5.1 | — | 只服务已完成的引擎对比（C4） |

**保留旧版本的例外与复查条件**（pnpm 的最小发行龄策略不绕过：版本太新时 pnpm 会自动写入豁免，U1 一律回退而不是接受豁免）。M2 A 审查（2026-10-05）按完整回归与打包烟测关闭 LOOP-02；同时指出前四项只试了最新版、未满发行龄就退回 M1b 基线（审查 F-07）。下次依赖盘点复查时改取满足发行龄的最新版本，不必等最新版本本身满龄：

| 项 | 保留 | 最新稳定 | 原因与复查条件 |
| --- | --- | --- | --- |
| jsdom | 26.1.0 | 30.1.2 | 发行时间不满足最小发行龄；下次依赖盘点复试，复试时跑全部 jsdom 用例 |
| lucide-react | 0.544.0 | 1.52.0 | 同上 |
| @earendil-works/pi-ai | 0.85.1 | 1.0.2 | 同上；升级涉及 runtime 适配器，需重跑 `tests/agent` |
| jassub | 2.5.16 | 2.5.18 | 同上 |
| pdfjs-dist | 6.3.289（精确固定） | 6.4.299 | 代码断言版本，文本层与资产清单、拖选行为按它验证；升级需重测 PDF 文本层并让用户复核 H-01 |
| @codemirror/state、view、commands | 6.5.2、6.38.1、6.8.1 | 6.7.6、6.43.13、6.11.1 | 只升这三者会与 `codemirror` 元包产生两份实例，类型不兼容；随下一次元包升级一起处理 |
| @types/node | 24.5.2 | 26.6.4 | 类型随运行时（Node 24.19）；Node 升级时同步 |
| openapi-typescript | 7.13.0（仅在 `dist/tools/openapi-gen` 生成 Bangumi 类型，不进仓库依赖） | — | 它依赖 TypeScript 编译器 API，而 TypeScript 7 不再提供，所以生成器在隔离目录里用 TypeScript 5.9 运行；生成结果 `bangumi-openapi.ts` 入库并固定到官方规格提交与哈希；上游支持 TypeScript 7 后改回常规开发依赖 |

## 2026-09-20 接入与构建边界

AI runtime 切换保存为设置，运行开始时固定所选实现；切换只影响后续运行，活动任务继续使用原实现或由用户取消，不静默转接、扩大授权或丢失会话/工具证据。旧配置缺 runtime 字段时兼容自研适配器。自研与 PI 均用相同受控提供者验证文本、工具、流式、取消与错误，安装 PI 依赖不构成接入完成。实现与复验见 [M1a 总结](../evidence/m1a-summary.md)（F-28）。

Windows 原生构建优先在独立打包暂存目录对 better-sqlite3 执行 @electron/rebuild，再验证目标 Electron ABI 与 asar 解包；开发 Node 绑定不被覆盖。预编译二进制可作为按版本/ABI/架构核验的备选。本机工具链事实见审查证据，不因早期未安装记录再次要求安装。

## 模型用途隔离（A-27）

LLM、Embedding、ASR 使用独立 ModelProfile 与任务绑定，分别配置对应类型的模型、连接、凭据和探针；不把文本模型自动复用于转录或向量化。音频只交给已配置的 ASR，转录文本才能进入后续 LLM 整理。切换自研/PI runtime 不隐式更换模型用途。当前 LLM 与 ASR 的本地测试配置均为 OpenAI 兼容接口，已完成有限真实短测；Embedding 尚未配置。具体契约见 [模型路由](../design/agent-and-plugins.md#91-三层配置)，测试配置遵循 [A-29](../dev-rules/development-workflow.md#model-test-config)，文档不指定模型或服务默认值。
