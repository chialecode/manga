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

1. 先建立对应使用方再引入依赖。当前 M0 仍使用 textarea、node:sqlite、Zod 3、fflate 与实验构建脚本；本决定不表示已迁移，不批量添加没有使用方的库。
2. M1 先建立 React Agent 主页面、连接设置、资源位置配置与共享业务能力。笔记阶段再接入 Tiptap/CodeMirror；分别补中文输入法、选区、块拆合、撤销、保存恢复与版本冲突验证。
3. better-sqlite3/Drizzle 验证旧库打开、迁移、单写入、事务事件、崩溃恢复、FTS5 中日文检索与一致备份。保持既有迁移历史和对象身份，禁止重建用户数据库来迁就适配器。
4. 正式 Windows 包验证原生依赖、开发/正式 Profile 隔离和配置目录。原型的数据库与打包成绩不能继承到新实现。
5. Zod、JSZip 和模型适配分别验证错误、取消、范围、晚到结果与往返兼容。OpenAI 格式文本及转录的契约见 [Agent 协议](../design/agent-and-plugins.md#9-模型连接能力与路由)；SDK 未覆盖的接口由独立协议适配器补齐。
6. 选型改变须有实证理由与新的决定。新实现未验证时，状态保持“已选型、未集成/未验证”；对应结果进入 [执行状态](../delivery/status.md)。

## 后续选择

组合内核已按 ADR-0005 定稿；阅读解析器、媒体播放/ASS 后端、BitTorrent 引擎、画布编辑和第三方隔离方案在进入对应阶段时结合证据决定，不能由本 ADR 推导为已接受。依赖具体版本由兼容性验证及锁文件确定；产品格式、目录与优先级已经确认，见 [确认记录](confirmed-decisions.md)。

2026-09-25 用户要求重新评估自研阅读/播放与插件解耦。代码现状、官方资料、适配成本和优先路线见[唯一计划第 14 节](../delivery/m1b-execution-plan.md#14-阅读播放与开源依赖评估2026-09-25)：优先 PDF.js 可逆适配验证、比较 EPUB 引擎，播放后端随 M2 验证；当前未新增 accepted 选择。Q-14—Q-16 在[事项总表](open-questions.md#q-14)统一承接，不重复询问本 ADR 已接受的库。

## 2026-09-23 最新稳定依赖与 UI 决定（A-35）

用户明确 UI 使用 React + Tailwind CSS + shadcn/ui，并要求整个项目依赖都尝试最新稳定版。Tailwind 当前稳定版为 v4 不构成主版本上限；未来 v5 稳定后同样进入迁移和验证。其他运行时、编辑器、存储、模型 SDK、构建/测试与包管理工具也遵守此原则；历史证据中的版本记录保持原样。

实施时重新查询稳定发行版，检查 engine/peer、迁移说明与实际行为，精确锁定通过的版本，不把 manifest 全改为浮动 `latest`。存在实证阻塞时记录候选版本、失败和临时例外，并列后续解除条件。shadcn 的 CLI、组件源码与项目定制分别追踪，更新组件时审阅上游差异，不能覆盖现有行为修复。

本次 A 先完成计划并继续原 M1b 复核；依赖查询只是候选清单，尚未升级当前锁文件或接入 shadcn。实际步骤、Figma 的作用和代码归属只在 [唯一计划第 11—12 节](../delivery/m1b-execution-plan.md#11-ui-实施路径与-figma-的角色)维护，不另开技术迁移计划。

## 2026-09-20 接入与构建边界

AI runtime 切换保存为设置，运行开始时固定所选实现；切换只影响后续运行，活动任务继续使用原实现或由用户取消，不静默转接、扩大授权或丢失会话/工具证据。旧配置缺 runtime 字段时兼容自研适配器。自研与 PI 均用相同受控提供者验证文本、工具、流式、取消与错误，安装 PI 依赖不构成接入完成。具体实现缺口见 [最新 A 审查](../evidence/m1a-acceptance-review.md)。

Windows 原生构建优先在独立打包暂存目录对 better-sqlite3 执行 @electron/rebuild，再验证目标 Electron ABI 与 asar 解包；开发 Node 绑定不被覆盖。预编译二进制可作为按版本/ABI/架构核验的备选。本机工具链事实见审查证据，不因早期未安装记录再次要求安装。

## 模型用途隔离（A-27）

LLM、Embedding、ASR 使用独立 ModelProfile 与任务绑定，分别配置对应类型的模型、连接、凭据和探针；不把文本模型自动复用于转录或向量化。音频只交给已配置的 ASR，转录文本才能进入后续 LLM 整理。切换自研/PI runtime 不隐式更换模型用途。当前 LLM 与 ASR 的本地测试配置均为 OpenAI 兼容接口，已完成有限真实短测；Embedding 尚未配置。具体契约见 [模型路由](../design/agent-and-plugins.md#91-三层配置)，测试配置遵循 [A-29](../dev-rules/development-workflow.md#model-test-config)，文档不指定模型或服务默认值。
