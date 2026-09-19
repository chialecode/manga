# ADR-0007：基础技术栈

| 字段 | 内容 |
| --- | --- |
| 编号 / 日期 | ADR-0007 / 2026-09-19 |
| 状态 | accepted（技术选型；集成与产品验收另行记录） |
| 决定者与依据 | 用户于 2026-09-19 确认沿用已讨论的选型，后续新增选择在需要时决定 |
| 影响范围 | A-04/A-05/A-15；POC-01/05/06；M1 界面、存储与 Agent，后续对应能力 |
| 替代关系 | 替代 [ADR-0003](0003-m0-ui-editing.md) 的生产 UI/编辑推荐及 [ADR-0004](0004-m0-storage-host.md) 的驱动推荐 |

## 决定与理由

MANGA 采用成熟的界面、编辑、存储和工程基础，减少通用基础设施的维护；内容身份、稳定引用、命令、授权、模块生命周期与恢复协议由本项目掌握。依赖通过适配器接入，领域契约不绑定具体 UI、ORM 或模型 SDK。

| 能力 | 已选择技术 | 使用边界 |
| --- | --- | --- |
| 应用界面 | React + React DOM | M1 渲染层和受信任 UI Facet；kernel、领域和存储不依赖 React |
| 组件、样式与图标 | Radix UI、Tailwind CSS、Lucide React | 按实际组件引入；语义 Token 与产品视觉独立维护 |
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
| 模型协议适配 | @earendil-works/pi-ai | 服务侧适配；工具授权、路由与 Agent 循环遵守 MANGA 协议 |
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

组合内核、阅读解析器、媒体播放/ASS 后端、BitTorrent 引擎、画布编辑和第三方隔离方案在进入对应阶段时结合证据决定，不能由本 ADR 推导为已接受。依赖具体版本由兼容性验证及锁文件确定；产品格式、目录与优先级已经确认，见 [确认记录](confirmed-decisions.md)。
