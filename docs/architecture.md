# MANGA 技术架构规范

| 项目 | 值 |
|---|---|
| 产品 | MANGA（Manga / Anime / Novel / Game / Agent） |
| 文档性质 | **工程规范**。每条为唯一决定，非建议、非选项 |
| 核实日期 | **2026-08-12**（全部版本号、许可证、地区政策当日联网核实） |
| 目标平台 | Windows 10 21H2+ / Windows 11 x64；后续 macOS |

---

## 0. 文档约定与依赖准入原则

### 0.1 文档约定

- 「使用」「必须」「禁止」为强制条款，违反需 ADR 记录。
- 本文档不列备选方案，不做横向比较，不含人力估算。
- 标注「**待验证**」的条款不得作为决策依据，必须由 PoC 或后续检索确认。

### 0.2 依赖准入原则（唯一标准）

> **只有当「自研 = 重新实现一份成熟的公开规范或数值内核」时，才允许引入第三方依赖。其余一律自研。**

**允许引入的四类：**

| 类别 | 判据 | 本项目实例 |
|---|---|---|
| ① 规范/格式实现 | 规范文本数百页以上，或需要长期兼容性积累 | SQLite、FFmpeg、PDF.js、libass、libvips(sharp)、zlib |
| ② 平台原语 | 无法自研的运行时 | Electron、Node、Chromium |
| ③ 语言与构建工具链 | 编译、打包、测试的基础设施 | TypeScript、Vite、Vitest、ESLint |
| ④ 无障碍交互原语 | WAI-ARIA Authoring Practices 的正确实现（焦点陷阱、层叠、键盘导航、屏幕阅读器语义） | Radix UI 单包、Floating UI |

**禁止引入的类别（一律自研）：**

状态管理、数据获取与缓存、路由、HTTP 客户端封装、ORM 之上的抽象层、UI 组件库、CSS 框架、i18n 框架、AI SDK、动画库、日期库、工具函数库（lodash 类）、图表库。

**准入流程**：新增任何生产依赖必须提交 ADR，说明它属于上述哪一类、自研为何等价于重写规范实现、以及移除路径。

### 0.3 本文档的效力与位置

本文档是**架构正本**，状态为 `authoritative`：它定义技术栈、进程拓扑、信任边界、数据模型与不变式，对全部代码有约束力。

它**不是**日常操作手册。「改动某处之前必须遵守什么」由 `docs/dev-rules/` 下的触发式规则承载，产品行为边界由 `docs/product-rules/` 承载，视觉与交互由 `docs/design-rules/` 承载。三者与本文档冲突时，以本文档为准，并须提交 ADR 说明。

Agent 与开发者的工作入口是根目录 `AGENTS.md`，文档索引是 `docs/README.md`。

---

## 1. 技术栈总览

```
运行时      Electron 43.4.0（精确锁定）· Chromium 150.0.7871.224 · Node 24.18.1
语言        TypeScript 7.0.2 · ESM · strict + noUncheckedIndexedAccess
包管理      pnpm 10（onlyBuiltDependencies 白名单 · frozen-lockfile）
构建打包    electron-forge 7.11.2 + plugin-vite + plugin-fuses + plugin-auto-unpack-natives
            Vite 8.2.1
安装器      @felixrieseberg/electron-forge-maker-nsis 7.2.0（Windows）
安全加固    @electron/fuses 2.1.3（全部 8 项加固开启）
数据库      better-sqlite3 13.0.3（内置 SQLite 3.53.4，FTS5 已启用）
Schema      drizzle-orm 0.45.2 + drizzle-kit 0.31.10（仅生成迁移，运行时用原生 SQL）
校验        zod 4.4.3（精确锁定）
UI          React 19.2.8 + Radix UI 单包 + @floating-ui/react-dom
样式        原生 CSS Modules + CSS 自定义属性设计令牌（零依赖）
虚拟化      @tanstack/react-virtual 3.14.9
文本编辑    CodeMirror 6（@codemirror/view 6.43.8）
文件监听    @parcel/watcher 2.6.0
图像        sharp 0.35.3（libvips）
HTTP        undici 8.10.0
PDF         pdfjs-dist 6.2.108
字幕        JASSUB 2.5.14（libass WASM）
媒体        FFmpeg 8.1 上游 LGPL 预编译产物（进程外 sidecar，sha256 校验）
测试        Vitest 4.1.10 + jsdom + node:test（脚本与闸门）
────────────────────────────────────────────────────────────────────────────
自研内核    RPC 传输层 · 状态与查询缓存 · 路由 · i18n · ZIP 随机读 · EPUB 解析与排版
            漫画页面管线 · PlaybackEngine · 字幕/弹幕渲染 · 锚点与证据模型
            任务调度器 · 能力网关 · 网络网关 · AI Provider 层 · 更新器
```

---

## 2. 质量属性与量化指标

| # | 指标 | 阈值 |
|---|---|---|
| N1 | 窗口可见 | ≤ 1.2 s |
| N2 | 首屏可交互 | ≤ 2.5 s |
| N3 | 媒体库首屏渲染完成（10k 条目） | ≤ 3.5 s |
| N4 | 空闲 5 分钟后全部进程 Private Working Set 合计 | ≤ 550 MB（其中可回收缓存 ≥ 150 MB，系统内存压力下 60 s 内释放） |
| N5 | NSIS 安装包 / 解包体积 | ≤ 180 MB / ≤ 520 MB（含 FFmpeg，不含 AI 模型） |
| N6 | 搜索：DB 查询 P95 | 10k 条 ≤ 20 ms；100k 条 ≤ 60 ms |
| N7 | 搜索：端到端（按键→结果绘制） P95 | 10k 条 ≤ 150 ms；100k 条 ≤ 300 ms |
| N8 | 列表滚动长帧（> 16.7 ms）占比 | ≤ 5%，无 > 50 ms 帧 |
| N9 | 漫画翻页：缓存命中 / 未命中占位 / 未命中完整页 | ≤ 33 ms / ≤ 100 ms / ≤ 800 ms |
| N10 | 视频 seek 误差 | ≤ 1 帧 |
| N11 | 视频 seek 延迟 P95（转封装路径） | ≤ 700 ms |
| N12 | 后台任务全开时主线程最长阻塞 | ≤ 50 ms |
| N13 | 锚点耐久性：文件移动/重命名后自动重绑成功率 | ≥ 95%，**静默丢失 = 0** |
| N14 | 崩溃恢复：1000 次随机 kill 后 `PRAGMA integrity_check` | 全部 ok，僵尸任务 0，已提交事务丢失 0 |
| N15 | 备份 / 恢复（100k 条） | ≤ 20 s / ≤ 20 s，期间 UI 无阻塞 |
| N16 | 离线可用性 | 全部 provider 关闭时 E2E 套件 100% 通过 |
| N17 | 信任边界 | 渲染进程完全攻破后，无法读取授权目录外文件、无法读取任何密钥、无法执行命令 |
| N18 | 时间单位 | 全系统整数毫秒；浮点秒禁止跨进程、禁止入库 |

**内部时间基元**：所有时间值为 `number` 整数毫秒。浮点秒仅允许存在于 `<video>.currentTime` 与 FFmpeg PTS 的读取点，在读取的同一表达式内 `Math.round(x * 1000)` 转换。ESLint 自定义规则禁止 `Ms` 后缀之外的时间变量名。

---

## 3. 进程拓扑与信任边界

### 3.1 拓扑

```
╔══════════════════════════════════════════════════════════════════════════╗
║ L0 · 特权核心  MAIN PROCESS                                               ║
║   窗口 / 菜单 / 单实例 / 协议注册                                          ║
║   CapabilityGate  —— 授权目录表、路径解析、穿越防护、媒体 token 签发       ║
║   SecretVault     —— safeStorage(DPAPI) 加解密，密钥永不出本进程           ║
║   TaskScheduler   —— 租约、重试、取消、崩溃恢复                            ║
║   Supervisor      —— 子进程生命周期、心跳、退避重启、熔断、Job Object       ║
║   NetGateway      —— 域名白名单、限速、超时、响应上限                      ║
║   RpcRouter       —— 唯一 IPC 入口，双向 zod 校验                          ║
╚═╤═══════════╤═══════════╤═══════════╤═══════════╤═══════════╤════════════╝
  │MessagePort│MessagePort│MessagePort│stdio/JSONL│stdio/JSONL│stdio/JSONL
┌─▼─────────┐┌▼─────────┐┌▼─────────┐┌▼─────────┐┌▼─────────┐┌▼─────────┐
│L2 零特权  ││L1 数据   ││L1 扫描   ││L1' 媒体  ││L1' 下载  ││L1' AI    │
│RENDERER   ││Utility   ││Utility   ││ChildProc ││ChildProc ││ChildProc │
│           ││          ││          ││          ││          ││          │
│React UI   ││better-   ││遍历      ││ffmpeg    ││aria2c    ││本地推理  │
│阅读器     ││sqlite3   ││指纹      ││ffprobe   ││(v2)      ││(v2)      │
│播放器 UI  ││独占写入  ││缩略图    ││          ││          ││          │
│           ││WAL 只读  ││归档索引  ││          ││          ││          │
│sandbox    ││并发      ││          ││          ││          ││          │
└─▲─────────┘└──────────┘└──────────┘└──────────┘└──────────┘└──────────┘
  │ media://  (Range 支持，不透明 token)
  │ book://   (EPUB 内容，script-src 'none')
  └────────── 由 L0 的 protocol.handle 服务 ──────────
```

常驻进程：main / renderer / GPU / db-utility / scan-utility。媒体、下载、AI 进程按需启停，空闲 30 s 后自动回收。

### 3.2 窗口配置（强制）

```ts
new BrowserWindow({
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
    preload: PRELOAD_PATH,
  },
})
```

`preload` 仅暴露三个方法：

```ts
contextBridge.exposeInMainWorld('__rpc', {
  invoke(method: string, payload: unknown, callId: string): Promise<unknown>,
  stream(method: string, payload: unknown, callId: string, port: MessagePort): void,
  cancel(callId: string): void,
})
```

禁止在 preload 中暴露任何 `fs`、`path`、`child_process`、`app`、`shell` 能力。

### 3.3 Electron Fuses（全部开启）

通过 `@electron-forge/plugin-fuses` + `@electron/fuses` 2.1.3 在打包时写入：

| Fuse | 值 | 作用 |
|---|---|---|
| `runAsNode` | **false** | 禁止用 `ELECTRON_RUN_AS_NODE` 把应用当 Node 解释器执行任意脚本 |
| `enableNodeOptionsEnvironmentVariable` | **false** | 禁止通过 `NODE_OPTIONS` 注入代码 |
| `enableNodeCliInspectArguments` | **false** | 禁止 `--inspect` 附加调试器读取内存中的密钥 |
| `enableCookieEncryption` | **true** | Cookie 存储加密 |
| `enableEmbeddedAsarIntegrityValidation` | **true** | 启动时校验 asar 完整性，防止篡改注入 |
| `onlyLoadAppFromAsar` | **true** | 只从 asar 加载应用代码，禁止旁路目录 |
| `loadBrowserProcessSpecificV8Snapshot` | false | 不使用 |
| `grantFileProtocolExtraPrivileges` | **false** | 收紧 `file://` 权限 |

### 3.4 内容安全策略

主界面：

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' media: data: blob:;
media-src 'self' media: blob:;
font-src 'self';
connect-src 'self';
frame-src book:;
worker-src 'self' blob:;
form-action 'none';
base-uri 'none';
```

EPUB 内容框架（`book:` scheme）：

```
default-src 'none';
script-src 'none';
style-src 'unsafe-inline' book:;
img-src book: data:;
font-src book:;
```

EPUB 规范允许内嵌脚本。本项目**不支持**电子书脚本内容，`script-src 'none'` 是唯一防线，因为同源 `blob:` 与 iframe sandbox 在需要 `allow-scripts` 时会失效。此条为 P0 安全门，由 CI 断言 CSP 字符串。

### 3.5 不变式

| # | 不变式 | 强制手段 |
|---|---|---|
| B1 | 渲染进程无 Node API、无 fs 句柄、无 DB 连接、无密钥、不能执行命令 | sandbox + Fuses + preload 白名单 |
| B2 | 主进程假定所有 renderer 入参为攻击载荷，用 zod 重新解析 | RpcRouter 强制 schema，无 schema 的方法无法注册；`ipc-contract.test` 断言 |
| B3 | 文件访问必须经 `CapabilityGate.resolve(rootId, relPath)` | ESLint 规则禁止 gate 外直接 import `node:fs` |
| B4 | 媒体 URL 为不透明 token，不含真实路径 | token 128-bit 随机、绑定 window session、TTL 30 min |
| B5 | 密钥单向：可写入、可使用，不可读出 | RPC 契约中不存在返回明文密钥的方法；`ipc-contract.test` 断言 |
| B6 | 外部 HTTP 响应经 zod 解析，失败即丢弃 | NetGateway 统一实施 |
| B7 | 子进程 env 显式构造，不继承密钥 | `spawn` 封装函数，禁止直接调用 `child_process` |
| B8 | AI 工具调用前必须有用户授权记录 | 执行前查 `tool_grant`，无记录则挂起 |
| B9 | 日志禁止出现完整路径、书名、token、密钥 | logger redact 中间件 + 单测断言 |
| B10 | 数据库只有 db-utility 进程持有写连接 | 其他进程不 import better-sqlite3 |

---

## 4. 仓库结构与模块边界

### 4.1 结构

```
manga/
├── apps/
│   ├── desktop/            electron-forge 应用：主进程、preload、渲染进程入口
│   ├── svc-db/             数据服务 utility 进程
│   └── svc-scan/           扫描服务 utility 进程
├── vendor-bin/             平台二进制，不入库，安装时按平台下载并校验 sha256
│   └── ffmpeg/             ffmpeg.exe / ffprobe.exe（LGPL 构建）
├── packages/
│   ├── domain/             纯 TS，零 I/O，零 Node API，零 DOM
│   │   ├── anchor/         锚点模型、失效状态机、类型安全联合
│   │   ├── library/        作品/卷/版本/文件的领域规则
│   │   ├── naming/         CJK 自然排序、卷话号解析、标题归一化
│   │   ├── fingerprint/    指纹算法（纯函数，输入 Uint8Array）
│   │   ├── playback/       播放能力决策矩阵（纯函数）
│   │   └── time/           毫秒基元、时间段代数
│   ├── contract/           RPC 契约：方法名 + zod input/output/stream
│   ├── rpc/                自研 RPC 内核（编解码、取消、背压、错误模型）
│   ├── data/              schema、迁移、仓储；唯一 import better-sqlite3 的包
│   ├── epub/              自研 EPUB 解析与排版内核
│   ├── zip/               自研 ZIP 随机读取器
│   ├── comic/             漫画页面管线与缓存
│   ├── media/             FFmpeg sidecar 调度、探测、转封装、抽帧
│   ├── player/            PlaybackEngine 接口与实现
│   ├── subtitle/          字幕解析与渲染
│   ├── ai/                自研 Provider 层、工具注册、审计
│   ├── providers/         外部元数据/弹幕/索引适配器
│   ├── ui/                自研状态、路由、i18n、CSS 令牌、基础组件
│   └── features/          媒体库、阅读器、播放器、笔记的界面模块
├── scripts/               自建工具链（.mjs，用 node:test 测试）
└── docs/adr/              架构决策记录
```

### 4.2 依赖方向（CI 强制）

```
features ──► ui
    │
    ▼
  rpc(client) ──► contract ──► domain
                      ▲            ▲
  rpc(host) ──────────┘            │
    ├──► data ───────────────────► │
    ├──► epub ──► zip ───────────► │
    ├──► comic ──► zip ──────────► │
    ├──► media ─────────────────► │
    ├──► player ──► media ──────► │
    ├──► subtitle ──────────────► │
    ├──► ai ────────────────────► │
    └──► providers ─────────────► │
```

**四条铁律**，由 `scripts/__tests__/module-boundary.test.mjs` 在 CI 中解析 import 图断言：

1. `domain` 不 import 任何包与任何 Node/DOM API。
2. `contract` 只 import `domain` 与 `zod`。
3. UI 侧（`ui`、`features`、`rpc/client`）不 import 任何主机侧包。
4. RPC 传输实现隔离在 `packages/rpc/transport/electron.ts` 单文件。

---

## 5. RPC 内核（自研）

### 5.1 契约

```ts
// packages/contract/library.ts
export const listWorks = method({
  name: 'library.listWorks',
  input: z.object({
    kind: z.enum(['novel', 'manga', 'anime']).optional(),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).default(60),
  }),
  output: z.object({ items: z.array(WorkSummary), nextCursor: z.number().int().nullable() }),
})

export const scanRoot = method({
  name: 'library.scanRoot',
  input: z.object({ rootId: z.number().int() }),
  stream: ScanProgress,          // 存在 stream 即为流式方法
  output: z.object({ scanned: z.number().int(), changed: z.number().int() }),
})
```

`method()` 返回的对象同时被客户端与主机端 import，**方法名与 schema 只有一处定义**。

### 5.2 传输

- **请求-响应**：`ipcRenderer.invoke` → `ipcMain.handle`。
- **流式与大数据**：`MessageChannelMain` 建立专用 `MessagePort`。二进制载荷用 `ArrayBuffer` transferable，零拷贝。
- **帧格式**（MessagePort 上）：

```ts
type Frame =
  | { t: 'chunk';  seq: number; data: unknown }
  | { t: 'end';    result: unknown }
  | { t: 'error';  error: WireError }
  | { t: 'credit'; n: number }        // 消费者 → 生产者
```

### 5.3 背压

信用制。消费者建立流时授予初始信用 32；每消费 16 个 chunk 回发 `{t:'credit', n:16}`。生产者信用耗尽时挂起，禁止无限缓冲。此机制对 AI 流式回复、扫描进度、日志尾随统一适用。

### 5.4 取消

每次调用携带 `callId`（cuid）。客户端调用 `cancel(callId)`；主机端从 `callId → AbortController` 表中取出并 abort。`AbortSignal` 必须贯穿到最底层：DB 查询的 `interrupt()`、`undici` 的 `signal`、子进程的 kill。

**取消语义**：取消成功后 200 ms 内停止一切资源消耗。已产生的部分结果**不丢弃**，由业务层决定是否持久化（AI 回复标记 `partial=1`；扫描保留 cursor）。

### 5.5 错误模型

```ts
type WireError = {
  code: ErrorCode              // 稳定枚举，UI 据此决定文案与恢复动作
  message: string              // 已脱敏，可直接展示
  retryable: boolean
  details?: Record<string, string | number | boolean>   // 已脱敏
}
```

**禁止**把 stack、绝对路径、SQL 语句、异常原文回传渲染进程。主机端记录完整错误到本地日志（含 traceId），线上错误只回传 `traceId`。

`ErrorCode` 枚举定义在 `contract` 中，新增需 ADR。

---

## 6. 数据层

### 6.1 引擎与驱动

- **SQLite 3.53.4**，由 **better-sqlite3 13.0.3** 内置提供。已核实其默认编译开启 `SQLITE_ENABLE_FTS5`、`SQLITE_ENABLE_RTREE`、`SQLITE_ENABLE_STAT4`、`SQLITE_ENABLE_MATH_FUNCTIONS`、`SQLITE_ENABLE_DESERIALIZE`、`SQLITE_DEFAULT_FOREIGN_KEYS=1`、`SQLITE_DQS=0`、`SQLITE_THREADSAFE=2`；**未开启** `SQLITE_ENABLE_ICU`。
- better-sqlite3 的同步 API 运行在独立 utility 进程中，不阻塞任何界面线程。
- `better-sqlite3` 加入 pnpm `onlyBuiltDependencies` 白名单，由 `@electron/rebuild` 4.2.0 按 Electron ABI 重编。

### 6.2 连接配置

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;      -- 锚点/笔记写入使用独立 FULL 事务
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -32000;       -- 32 MB
PRAGMA mmap_size = 268435456;     -- 256 MB
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;
```

单写多读：db-utility 进程持有唯一写连接；只读查询使用同进程内的独立只读连接并发执行。

### 6.3 Schema 与迁移

- **drizzle-orm 0.45.2** 定义 schema，**drizzle-kit 0.31.10** 生成迁移 SQL。
- **运行时不使用 drizzle 的查询构建器执行热路径查询**。热路径（媒体库列表、搜索、页面查询）使用 `db.prepare()` 预编译的原生 SQL，语句在模块加载时一次性准备并复用。drizzle 的职责仅限于：schema 单一事实源、类型导出、迁移生成。
- 迁移执行器自研，基于 `PRAGMA user_version`，单事务内执行，执行前自动 `VACUUM INTO` 备份。

**三道迁移闸门（CI 强制）：**

| 闸门 | 脚本 | 断言 |
|---|---|---|
| 冻结 | `scripts/__tests__/migration-freeze.test.mjs` | 已发布版本包含的迁移文件哈希不得变化 |
| 校验 | `scripts/validate-migrations.mjs` | 迁移序号连续、无重复、每个迁移有对应的回滚说明文档 |
| 重放 | `packages/data/__tests__/migration-replay.test.ts` | 从每个历史版本的空库重放到最新，结构与直接建库结果一致 |

### 6.4 全文搜索

**FTS5 + `trigram` 分词器**。ICU 未编译进 better-sqlite3，trigram 是唯一无需额外 native 依赖且对中日文有效的方案。

```sql
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, alt_titles, tags, body,
  entity_kind UNINDEXED,
  entity_id   UNINDEXED,
  tokenize = 'trigram'
);
```

排序使用 `bm25(search_fts, 8.0, 4.0, 2.0, 1.0)`，权重依次为标题、别名、标签、正文。

**小说正文与字幕文本默认不建全文索引**，由用户在打开单本/单集时按需触发。这是十万级扩展性的关键约束：trigram 索引体积约为原文 3–4 倍，全量索引会让数据库膨胀到 GB 级。

### 6.5 向量检索

自研。向量存 `BLOB`（float32 或 int8 量化），在 db-utility 进程中做全内存暴力余弦相似度。10 万 × 768 维 float32 = 300 MB，单次全扫约 30 ms，量化到 int8 后为 75 MB。不引入向量扩展。

### 6.6 备份与恢复

- 备份使用 SQLite Online Backup API（`db.backup()`），产生一致快照，不阻塞写入。
- 备份包为 zip：`db.sqlite` + `assets/`（录音、抽取字幕）+ `manifest.json`（schema 版本、库根路径映射表、生成时间）。
- 恢复流程：校验 schema 版本 → 若旧则先跑迁移 → 替换文件 → 应用路径映射表。
- **跨机器迁移**：`manifest.json` 的路径映射表允许把旧库根映射到新库根。因锚点绑定 `file.id` 而非路径，全部锚点存活。

---

## 7. 扫描、指纹与任务调度（自研）

### 7.1 两级指纹

| 级别 | 算法 | 用途 | 成本 |
|---|---|---|---|
| 快速指纹 | `xxhash64(size ‖ mtimeMs ‖ 首 64 KB ‖ 尾 64 KB)` | 变更检测 | 每文件读 128 KB |
| 内容指纹 | `BLAKE3` 全文件 | 去重、移动识别 | 后台低优先级，写入 `file.content_fp` |

两级设计的理由：十万个平均 200 MB 的文件全量哈希需读取 20 TB。日常扫描只读快速指纹。

xxhash64 与 BLAKE3 均自研实现（纯 TS，运行在 scan-utility 进程的 worker 中）。二者规范简短、有官方测试向量，不属于 §0.2 的第三方准入类别。

不使用 inode/FileIndex 作为主键：跨卷不唯一，网络盘与 ReFS 不可靠。仅作为移动识别的辅助信号采集。

### 7.2 扫描流程

```
1. CapabilityGate 记录 library_root（含用户显式授权时间戳）
2. TaskScheduler 入队 { kind:'scan', rootId, cursor:null }，持久化到 SQLite
3. svc-scan 领取任务，lease_until = now + 60s，每 20 s 心跳续租
4. fs.opendir 异步迭代，每 500 条为一片
5. 每片：计算快速指纹 → RPC 批量 upsert 到 svc-db（单事务）→ 更新 task.cursor
6. 变更判定：
     路径在 & 快速指纹同  → 无操作
     路径在 & 快速指纹异  → 标 content_changed，入队内容指纹任务
     路径消失             → status = 'missing'（不删除记录）
     新路径 & 快速指纹命中某 missing 记录 → 入队内容指纹任务做移动确认
7. 移动确认：内容指纹相同 → 更新 file.rel_path，写 file_path_history，锚点零感知
```

崩溃恢复：进程启动时执行

```sql
UPDATE task SET state='pending', attempts=attempts+1
WHERE state='running' AND lease_until < :now;
```

### 7.3 文件监听

**@parcel/watcher 2.6.0**。仅监听已授权的库根。事件经 2 s 节流合并后**入队增量扫描任务**，不直接修改数据库。写入中的文件通过「大小连续两次采样相同」判定完成。

### 7.4 任务调度器（自研）

```sql
CREATE TABLE task (
  id           INTEGER PRIMARY KEY,
  kind         TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','running','done','failed','cancelled')),
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_until  INTEGER,
  cursor       TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_task_ready ON task(state, priority DESC, id) WHERE state='pending';
```

并发池按 kind 隔离：`scan=2`、`fingerprint=2`、`thumbnail=CPU/2`、`remux=1`、`transcode=1`、`ai=1`，并受全局信号量约束。

所有任务必须幂等可重入。缩略图先写临时文件再原子 rename。

---

## 8. 小说内核（自研）

### 8.1 范围

自研 EPUB 解析与排版内核，不引入电子书渲染库。理由：现有 JS 电子书库要么长期停滞，要么明确声明 API 不稳定且无版本发布，无法作为长期依赖；而 EPUB 3 的核心子集（OCF 容器、OPF 包文档、NAV 导航、CFI 定位）规范明确、体量可控。

### 8.2 解析管线

```
ZIP 随机读（packages/zip）
    └─► META-INF/container.xml  → 定位 OPF
            └─► OPF 解析：metadata / manifest / spine / guide
                    ├─► NAV（EPUB 3）或 NCX（EPUB 2）→ 目录树
                    ├─► spine 顺序 + linear 属性 → 阅读序列
                    └─► rendition:layout → 判定 reflowable / pre-paginated
```

资源解析：spine 项通过 `book://<bookToken>/<opfRelativePath>` 提供。相对链接在解析阶段重写为该 scheme，禁止任何外部 URL 通过。

字体去混淆：实现 IDPF 与 Adobe 两种算法，SHA-1 使用 Node 的 `node:crypto`（主进程侧解密后再交付内容）。

### 8.3 排版

反流式内容使用 CSS 多栏分页，渲染在 `book:` 的 iframe 中。

- 分页容器 `column-width` / `column-gap` 由用户设置驱动；`column-count` 支持 1–3 栏。
- 当前位置以 `Range` 为锚，窗口尺寸变化时以该 `Range` 重新定位，不依赖百分比。
- 可见范围通过对滚动偏移做二分查找确定，精度到文本节点。
- 分页/滚动模式切换不重新加载章节。
- 竖排通过 `writing-mode: vertical-rl` + `text-orientation: mixed`；日文 ruby 使用原生 `<ruby>`；字体回退链在应用侧注入，不信任书内字体声明。

固定版式内容（`pre-paginated`）走漫画内核的定位路径。

### 8.4 TXT

编码检测自研：BOM 优先，其次按 UTF-8 合法性、GB18030/Big5/Shift_JIS/EUC-JP 的字节分布启发式打分。解码使用 Chromium 内置的 `TextDecoder`（支持上述全部编码）。检测结果必须可被用户手动覆盖，覆盖值持久化到 `file` 记录。

章节切分：按可配置的正则集（`第[零一二三四五六七八九十百千0-9１-９]+[章节話话回]`、`Chapter\s+\d+` 等），用户可编辑。

### 8.5 定位与全文搜索

- 主定位使用**自研 EPUB CFI 实现**（解析、生成、比较、范围）。CFI 用状态机解析，支持转义断言。
- 冗余定位：`{ chapterId, startOffset, endOffset, contextBefore(32字), contextAfter(32字) }`。CFI 失效时用上下文做模糊重定位，结果状态标记为 `relocated`，**不得标记为 `valid`**。
- 全文搜索不在渲染层做。首次打开时后台抽取纯文本写入 FTS5，搜索走 SQL，命中结果映射回 CFI。

---

## 9. 漫画内核（自研）

### 9.1 ZIP 随机读取器（自研）

不引入 JS 压缩库。实现范围：

```
1. 定位 EOCD：从文件尾向前扫描 ≤ 64 KB 寻找 0x06054b50
2. 若 EOCD 字段为 0xFFFF/0xFFFFFFFF → 解析 ZIP64 EOCD Locator 与 ZIP64 EOCD
3. 解析中央目录：文件名、压缩方法、压缩/未压缩大小、本地头偏移、通用标志位
4. 文件名编码：通用标志位 bit 11 置位则 UTF-8，否则按 §8.4 的检测逻辑（大量中日文 CBZ 使用 GBK/Shift_JIS）
5. 按需读取单条 entry：seek 到本地头 → 跳过变长字段 → 读压缩字节 → node:zlib inflateRaw
```

解压使用 Node 内置 `node:zlib`，属于平台原语。

中央目录在扫描阶段解析一次，写入 `archive_entry` 表；播放期直接按 offset 读取，**不重复扫描中央目录，不预解压整包**。

安全约束：单 entry 未压缩大小上限 200 MB；entry 总数上限 10000；entry 名不参与任何文件系统路径拼接（页面按 index 访问）。

### 9.2 页面源抽象

```ts
interface PageSource {
  readonly pageCount: number
  readonly naturalOrder: readonly number[]      // 自然排序后的 entryIndex
  readPage(index: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>
  readonly meta: { width?: number; height?: number }[]
}
```

四种实现：目录、ZIP/CBZ、图片型 EPUB（走 spine 顺序）、PDF。

### 9.3 CJK 自然排序（自研）

`Intl.Collator({numeric:true})` 不足以处理本产品的文件名。归一化管线：

```
NFKC 规范化
  → 全角数字/字母 → 半角
  → 汉字数字 → 阿拉伯数字（零一二三四五六七八九十百千，含「廿」「卅」）
  → 识别卷话标记：巻/卷/話/话/第…章/第…回/vol./ch./p./page
  → 切分为 [文本段, 数值段, 文本段, 数值段, ...]
  → 逐段比较：文本段用 Intl.Collator，数值段按数值
```

配套 200 条黄金测试用例，覆盖：`p1` vs `p001`、`第9話` vs `第10話`、`Vol.2 Ch.15`、`１２` vs `12`、`第十二巻`、`[汉化组] 作品 第03话`。

### 9.4 缓存与预加载

- LRU 按**解码后像素字节**计量（`width × height × 4`），不按文件大小。上限 `min(256 MB, 物理内存 × 5%)`。
- 解码在 Worker 中用 `createImageBitmap(blob, { resizeWidth })`，主线程零阻塞。
- 预取窗口方向感知：LTR 取 `[n+1, n+2, n-1]`，RTL 取 `[n-1, n-2, n+1]`；双页模式按对预取。预取任务可被翻页 abort。
- 超高长条图（高度 > 20000 px）按视口分块解码，只保留可视区 ±1 屏。
- 收到 `navigator.deviceMemory` 压力信号或主进程转发的系统内存压力事件时，缓存立即降到上限的 25%。

### 9.5 PDF

**pdfjs-dist 6.2.108**，运行在 Worker 中。扫描版漫画 PDF 先用 `page.getOperatorList()` 判定是否为「单一全页图像」，是则直接抽取原始图像流，跳过栅格化。

### 9.6 区域标记

存储归一化坐标 `{x, y, w, h} ∈ [0,1]`，不存像素值。同一标记在不同分辨率版本、不同缩放状态下均可复现。

---

## 10. 视频内核（自研）

### 10.1 PlaybackEngine 接口

```ts
interface PlaybackEngine {
  readonly kind: 'native' | 'remux' | 'transcode' | 'external'
  readonly caps: {
    supportsHtmlOverlay: boolean      // 决定标记/双字幕/弹幕的渲染路径
    supportsAudioTrackSwitch: boolean
    supportsPreciseSeek: boolean
  }
  load(src: MediaRef, opts: LoadOptions): Promise<MediaInfo>
  play(): Promise<void>
  pause(): void
  seek(positionMs: number): Promise<void>      // 整数毫秒
  setRate(rate: number): void
  setVolume(v: number): void
  selectAudioTrack(id: string): Promise<void>
  selectSubtitle(id: string | null, slot: 0 | 1): Promise<void>
  readonly positionMs: number
  on(evt: PlaybackEvent, cb: Handler): Unsubscribe
  dispose(): void
}
```

`caps.supportsHtmlOverlay` 从第一天就存在。界面层必须为 `false` 的情况准备降级路径，否则未来引入原生窗口播放器时全部叠加层要重写。

### 10.2 三级路径

探测由 `ffprobe -show_streams -show_format -print_format json` 完成，决策逻辑是 `packages/domain/playback` 中的纯函数，可单测。

| 级别 | 条件 | 实现 |
|---|---|---|
| **L1 native** | 容器 mp4/webm ∧ 视频 h264/vp9/av1 ∧ 音频 aac/opus/vorbis ∧ 无需内封字幕/多音轨 | `<video src="media://...">` |
| **L2 remux** | 容器 mkv/avi/mov ∧ 视频 h264 ∧ 音频 aac/mp3，或需要指定音轨 | `ffmpeg -c copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof` 管道 → MSE SourceBuffer |
| **L3 transcode** | 视频编码不受支持（hevc 无硬解、10bit 等）∨ 音频 ac3/dts/truehd | `ffmpeg` 硬件编码优先（`h264_qsv` / `h264_nvenc` / `h264_amf`），回退 `libx264`（**注意：libx264 为 GPL，禁止链接；改用 `mpeg4` 或系统硬件编码器**）→ MSE |
| **L0 external** | 以上全部不适用 | 用系统默认播放器打开，界面明确说明原因 |

L3 的编码器选择受 §19 许可证约束：内置 FFmpeg 为 LGPL 构建，不含 x264。硬件编码器由驱动提供，不受 FFmpeg 许可证影响。若目标机器无硬件编码器，L3 不可用，直接降级到 L0。

### 10.3 L2 的 seek

MSE 下 seek 需要重建流：

```
1. abort 当前 ffmpeg 进程
2. 以 -ss <targetMs/1000> 置于 -i 之前启动新进程（走关键帧索引，定位为毫秒级）
3. 记录 ffmpeg 输出的首个 PTS 作为时间基准偏移
4. SourceBuffer.abort() → remove(0, Infinity) → 重新 append
5. 用户可见时间 = 基准偏移 + 当前播放位置
```

seek 目标落在帧上。`positionMs` 对外始终是整数毫秒。

### 10.4 FFmpeg 分发

- 版本 **8.1 分支**（8.1 自 2026-03-08 从 master 切出）。不使用 2026-08-12 当日发布的 9.0.x。
- **使用现成的 LGPL 预编译产物，不自行构建。** 采用 `BtbN/FFmpeg-Builds` 的 `win64-lgpl-shared` 变体（`ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip`）。该变体明确排除 GPL-only 组件（`libx264`、`libx265`），与 §19.2 的「只转封装、不软件编码」策略一致。
- 选 `shared` 而非 `static`：libav* 以 DLL 形式存在，LGPL 的可替换库要求由 DLL 边界天然满足。
- **必须镜像到自建对象存储后再固定 URL**。上游的保留策略是「每月最后一个构建保留两年，日构建只保留最近 14 个」，直接引用日构建的 URL 会在两周内失效。镜像同时解决中国大陆可达性。
- 二进制**不入库**。放在 `vendor-bin/ffmpeg/`，由 `scripts/ensure-vendor-bin.mjs` 在 `pnpm install` 时按平台下载，**版本固定 + sha256 校验**，哈希表提交到仓库。
- 运行时启动前再次校验哈希，不匹配拒绝执行并提示重新安装。
- LGPL 义务（§19.1）由以下方式履行：把对应版本的 FFmpeg 源码 tarball（来自 `ffmpeg.org`）与上游构建配置一并镜像发布，并在声明中给出该二进制对应的上游构建标识。
- 提供「使用系统 FFmpeg」设置项：探测 PATH，校验 `-version` 输出的主版本 ≥ 6。
- 升级 FFmpeg 版本时必须确认新产物的 `-version` 输出中不含 `--enable-gpl` 与 `libx264`，此断言写入 `vendor-sha256` 闸门。

### 10.5 缩略图与预览

- 单帧：`ffmpeg -ss <t> -i <file> -frames:v 1 -f image2pipe -vcodec mjpeg -`（`-ss` 前置走关键帧索引）。
- 时间轴悬停预览：每 10 s 一帧，160×90，一次性生成雪碧图后缓存。
- 图像缩放与格式转换统一用 **sharp 0.35.3**（libvips），不用 Canvas。

### 10.6 进程监督

Supervisor 管理全部媒体子进程：

- 心跳：子进程每 5 s 输出一行 `{"t":"hb"}`，15 s 无心跳判定挂起并 kill。
- 退避重启：1 s / 2 s / 4 s，连续 3 次失败进入熔断，向界面报告并停止重试。
- **Windows Job Object**：所有子进程加入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job，主进程异常退出时子进程由内核回收，杜绝孤儿进程。
- 子进程崩溃不影响主进程与渲染进程。

---

## 11. 字幕与弹幕（自研 + libass）

| 格式 | 实现 |
|---|---|
| SRT | 自研解析 → 内部时间轴模型 → HTML 层渲染 |
| WebVTT | 自研解析（含 cue settings、region）→ HTML 层渲染 |
| ASS / SSA | **JASSUB 2.5.14**（libass 编译为 WASM）→ 独立 canvas 叠加层 |
| 内封字幕 | `ffprobe` 列出 → `ffmpeg -map 0:s:N -c copy` 抽取到应用缓存目录 |

不使用 `<track>` 元素：其样式与布局能力不足以支撑双字幕与自定义排版。

**双字幕**：两个独立槽位。slot 0（主字幕）若为 ASS 则走 JASSUB 保留原始特效；slot 1（副字幕）强制走 HTML 层并应用统一样式，以便文本可选中、可复制、可直接生成锚点。每个槽位有独立的 `offset_ms`。

**同步**：使用 `requestVideoFrameCallback` 而非 `timeupdate`，与视频帧对齐。倍速播放时时间轴按 `playbackRate` 缩放。

**弹幕**：自研 Canvas 渲染层。轨道分配、碰撞检测、滚动/顶部/底部三种模式、透明度与字号设置、按用户/关键词屏蔽。同步机制同上。弹幕数据来自本地文件导入（B站 XML、ASS 弹幕、JSON）。

**字幕文本入索引**：抽取的字幕文本写入 FTS5，实现「按台词搜索视频」，命中结果直接转为视频锚点。

---

## 12. 锚点与证据模型

### 12.1 分层

```
L1 物理层    file · archive_entry · library_root
L2 逻辑层    work · volume · edition · media_item
L3 证据层    anchor · thumbnail                    ← 系统中心
L4 原始记录  note · recording · bookmark           ← 用户产出，机器永不覆盖
L5 派生内容  transcript · ai_message · ai_artifact ← 必须有 evidence_link
L6 创作成果  whiteboard · document · timeline
```

**不变式**：L5 每一行必须至少有一条指向 L3 的 `evidence_link`；L5 的任何写入路径都不得 UPDATE L4。由 `packages/data/__tests__/derived-invariant.test.ts` 断言。

### 12.2 核心表

```sql
CREATE TABLE file (
  id            INTEGER PRIMARY KEY,          -- 稳定代理键，锚点绑此列
  root_id       INTEGER NOT NULL REFERENCES library_root(id) ON DELETE RESTRICT,
  rel_path      TEXT    NOT NULL,             -- 相对库根，/ 分隔
  size_bytes    INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  quick_fp      TEXT    NOT NULL,
  content_fp    TEXT,
  container     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'present'
                CHECK (status IN ('present','missing','error')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (root_id, rel_path)
);

CREATE TABLE file_path_history (
  id           INTEGER PRIMARY KEY,
  file_id      INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  old_root_id  INTEGER NOT NULL,
  old_rel_path TEXT    NOT NULL,
  changed_at   INTEGER NOT NULL,
  reason       TEXT    NOT NULL CHECK (reason IN ('auto_rebind','user_confirm','manual'))
);

CREATE TABLE anchor (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('novel','manga','video')),
  work_id     INTEGER REFERENCES work(id)   ON DELETE SET NULL,
  volume_id   INTEGER REFERENCES volume(id) ON DELETE SET NULL,
  file_id     INTEGER NOT NULL REFERENCES file(id) ON DELETE RESTRICT,
  content_fp_at_creation TEXT,
  payload     TEXT NOT NULL,
  CHECK (
     (kind='novel' AND json_extract(payload,'$.chapterId')   IS NOT NULL
                   AND json_extract(payload,'$.startOffset') IS NOT NULL)
  OR (kind='manga' AND json_extract(payload,'$.pageIndex')   IS NOT NULL
                   AND json_extract(payload,'$.readingDir')  IS NOT NULL)
  OR (kind='video' AND typeof(json_extract(payload,'$.startMs'))='integer')
  ),
  status      TEXT NOT NULL DEFAULT 'valid'
              CHECK (status IN ('valid','file_missing','needs_review',
                                'content_changed','relocated','orphaned')),
  status_note TEXT,
  quoted_text TEXT,
  label       TEXT,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  checked_at  INTEGER
);
CREATE INDEX idx_anchor_file   ON anchor(file_id);
CREATE INDEX idx_anchor_work   ON anchor(work_id, created_at DESC);
CREATE INDEX idx_anchor_status ON anchor(status) WHERE status <> 'valid';

CREATE TABLE evidence_link (
  id          INTEGER PRIMARY KEY,
  source_kind TEXT    NOT NULL,
  source_id   INTEGER NOT NULL,
  anchor_id   INTEGER NOT NULL REFERENCES anchor(id) ON DELETE CASCADE,
  span        TEXT,
  UNIQUE (source_kind, source_id, anchor_id)
);
```

```ts
export type AnchorPayload =
  | { kind: 'novel'; chapterId: string; cfi?: string
      startOffset: number; endOffset: number
      contextBefore?: string; contextAfter?: string }
  | { kind: 'manga'; pageIndex: number; readingDir: 'ltr' | 'rtl'
      region?: { x: number; y: number; w: number; h: number } }
  | { kind: 'video'; startMs: number; endMs?: number; trackHint?: string }
```

zod schema 用 `discriminatedUnion`，`startMs` 用 `.int()`。数据库 CHECK 与 zod schema 双重保证。

### 12.3 锚点绑定 file.id 的理由

用户重新整理作品结构、文件移动、重命名，都不影响 `file.id`。`work_id` / `volume_id` 是冗余字段，可为 NULL。`ON DELETE RESTRICT` 阻止在有锚点时删除文件记录，强制用户显式处理。

### 12.4 失效状态机

| 检测到 | status | 界面行为 |
|---|---|---|
| 文件消失 | `file_missing` | 灰显，标「原文件离线」 |
| 移动且内容指纹一致 | `valid`（自动重绑） | 无感知，写 `file_path_history` |
| 移动且指纹不明 | `needs_review` | 「疑似移动，需确认」 |
| 内容指纹变化 | `content_changed` | 「内容已变，位置可能不准」 |
| CFI 失效后靠上下文重定位 | `relocated` | 「位置为推测」 |
| 所属卷被删除 | `orphaned` | 保留在「孤立证据」视图 |

**禁止**：静默重新定位、自动删除锚点、把 payload 置空。

### 12.5 四种独立删除

| 操作 | 数据影响 | 结果 |
|---|---|---|
| 删除下载任务 | `DELETE FROM download_task` | 任务消失，文件保留 |
| 删除文件 | `unlink()` + `file.status='missing'` | 磁盘文件删除，记录与锚点保留并标离线 |
| 删除媒体库条目 | `DELETE FROM file` | 有锚点时被 RESTRICT 阻止并提示 |
| 解除作品绑定 | `DELETE FROM media_item` | 文件与记录都在，不再属于该作品 |

四个操作在界面与 RPC 契约层面是四个不同的方法，各有独立的确认文案。

---

## 13. 界面层（自研）

### 13.1 状态

自研，基于 `useSyncExternalStore`。

```ts
// packages/ui/store.ts —— 约 60 行
export function createStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (patch: Partial<T> | ((s: T) => Partial<T>)) => {
      const next = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...next }
      listeners.forEach((l) => l())
    },
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  }
}
export function useStore<T, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}
```

不引入状态管理库。

### 13.2 查询缓存

自研。RPC 调用结果按 `方法名 + 序列化入参` 缓存，带 TTL、失效标签、并发去重、乐观更新。主机端在数据变更时通过流式通道推送失效标签，界面按标签丢弃缓存。约 200 行。

### 13.3 路由

自研。桌面应用视图集合固定且无 URL 语义需求。使用 `{ view: ViewId, params: ViewParams }` 的联合类型 + 历史栈，前进/后退绑定到鼠标侧键与快捷键。约 120 行。

### 13.4 样式

原生 CSS Modules（Vite 内置支持）+ CSS 自定义属性设计令牌。零依赖。

令牌命名、配色角色、字体栈、字重与字号白名单、圆角与间距刻度的正本是 [`design-rules/app-shell.md`](./design-rules/app-shell.md)，**不在本文件重复维护**。此处只登记三条架构层面的约束：

- 组件中禁止出现任何 hex / rgba 字面量，一律走令牌；由 CI 闸门在阶段 3 接线时强制。
- chrome 主题（明/暗）与阅读区主题（纸白/护眼/夜间）是两套正交的令牌集合，各自持久化。
- 字体以 webfont 随包分发，不依赖用户系统已装字体 —— 否则中日文混排的回退结果在不同机器上不可预测。

不使用 CSS 框架。阅读器需要竖排、多主题、精细分栏与字体回退控制，utility-class 方案在这些场景下是负担。

### 13.5 组件

- **交互原语**用 Radix UI 单包（`@radix-ui/react-dialog`、`react-dropdown-menu`、`react-popover`、`react-select`、`react-slider`、`react-switch`、`react-tooltip`、`react-alert-dialog`、`react-focus-scope`、`react-dismissable-layer`），配 `@floating-ui/react-dom` 做定位。按 §0.2 第 ④ 类准入。
- **长列表与封面墙**用 `@tanstack/react-virtual`。
- **文本编辑**（笔记、Markdown）用 CodeMirror 6：`@codemirror/state` / `view` / `commands` / `search` / `language` / `lang-markdown`。不使用 WYSIWYG 富文本编辑器。
- 其余组件全部自研。

### 13.6 国际化

自研。类型安全的消息目录：

```ts
// packages/ui/i18n/zh-CN.ts
export default {
  'library.empty': '尚未添加任何媒体目录',
  'anchor.status.contentChanged': '内容已变，位置可能不准',
  'reader.pageOf': (a: { cur: number; total: number }) => `${a.cur} / ${a.total}`,
} satisfies Messages
```

`Messages` 类型由 `zh-CN.ts` 推导，其余语言文件用 `satisfies Messages` 获得编译期完整性检查。缺键、多余键、参数签名不匹配全部是编译错误。首发语言：简体中文、日本語、English。

---

## 14. AI 层（自研）

### 14.1 Provider 抽象

自研，不引入 AI SDK。三种协议各自约 200 行：

| 协议 | 端点 | 覆盖 |
|---|---|---|
| OpenAI 兼容 | `POST /v1/chat/completions`（SSE） | OpenAI、DeepSeek、通义、豆包、智谱、Kimi、LM Studio、vLLM |
| Anthropic Messages | `POST /v1/messages`（SSE） | Claude |
| Ollama | `POST /api/chat`（NDJSON） | 本地 Ollama |

```ts
interface Provider {
  readonly id: string
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>
  readonly pricing?: { inputPerMTok: number; outputPerMTok: number }
}
```

每个 provider 配置必须包含**自定义 base URL** —— 这是中国大陆可用性的前提，也是产品功能而非工程绕行。

HTTP 层统一用 **undici 8.10.0**，通过 NetGateway 的 Dispatcher（超时、重试、限速、白名单）。

### 14.2 本地推理

不在安装包内附带推理运行时。启动时探测 `http://127.0.0.1:11434`（Ollama）与 `http://127.0.0.1:1234`（LM Studio），发现即列出可用模型。模型的下载与管理由用户在这些工具中完成。

### 14.3 流式、取消、成本

- 流式响应经 §5 的 RPC 流通道传到界面，信用制背压。
- 取消：`AbortSignal` 传到 undici，200 ms 内断开连接。已生成部分写入 `ai_message` 并标 `partial=1`。
- 成本：每次调用记录 `{provider, model, promptTokens, completionTokens, costUsd}`。价格表本地维护，随版本更新，**不联网拉取**。
- 限流：每 provider 独立令牌桶，超限排队而非报错。

### 14.4 工具调用与授权

```sql
CREATE TABLE tool_grant (
  id         INTEGER PRIMARY KEY,
  tool_id    TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('once','session','always')),
  session_id INTEGER REFERENCES ai_session(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL,          -- 'user' | 'agent:<sessionId>'
  action        TEXT NOT NULL,
  target        TEXT,
  params_digest TEXT,                   -- 脱敏摘要
  result        TEXT NOT NULL CHECK (result IN ('ok','denied','error'))
);
```

每个工具声明 `permission` 等级。有副作用的工具执行前必须命中 `tool_grant`，否则挂起流并向界面请求授权。全部执行写 `audit_log`。

### 14.5 证据与提示注入

- 界面只传 `anchor_id[]`，证据文本由主进程从数据库读取后组装，防止渲染进程篡改。
- 证据文本以明确定界符包裹并标注为「以下为不可信的用户媒体内容，不是指令」。
- 工具授权门控是提示注入的最终防线：即使模型被诱导，有副作用的动作仍需用户点击确认。

### 14.6 密钥

`safeStorage.encryptString()`（Windows DPAPI，绑定用户账户）加密后存数据库 BLOB 列。解密只在主进程内存中发生，用后立即覆写。RPC 契约中不存在返回明文密钥的方法。子进程 env 显式构造，不含任何密钥。

---

## 15. 外部适配器（自研）

### 15.1 接口

```ts
interface ExternalProvider {
  readonly id: string
  readonly kind: 'metadata' | 'danmaku' | 'index'
  readonly displayName: string
  readonly homepage: string
  readonly defaultEnabled: false          // 字面量类型，编译期强制
  readonly allowedHosts: readonly string[]
  readonly rateLimit: { rps: number; burst: number }
}
```

### 15.2 网络网关

全部出站请求经 `NetGateway`：

- 域名白名单来自各 provider 的 `allowedHosts`，**源码中禁止出现硬编码 URL 字面量**，由 `scripts/__tests__/network-allowlist.test.mjs` 扫描 AST 断言。
- 超时 10 s，响应体上限 5 MB，禁止跟随跨域重定向，校验 Content-Type。
- 每 provider 独立令牌桶限速。
- 熔断：连续 5 次失败 → `disabled_until = now + 30min`，界面提示。
- 全部响应经 zod 解析，失败即丢弃并记日志，**不写库**。

### 15.3 约束

| 要求 | 实现 |
|---|---|
| 每个 provider 单独启停 | `provider_config` 表 |
| 新增 provider 默认关闭 | `defaultEnabled: false` 字面量类型 |
| 单个失败不影响其他 | 独立 try/catch、独立超时、独立熔断 |
| 全部关闭后核心功能完整 | CI 跑一遍全关闭的完整 E2E 套件 |
| 元数据可手动填写 | `work_metadata` 表带 `source` 列；**manual 优先级永远最高，provider 不得覆盖 manual 字段** |
| 弹幕本地导入 | B站 XML / ASS 弹幕 / JSON |
| 下载交给外部 | 复制磁力链接、保存 .torrent、用系统默认程序打开 |
| 自动测试不访问真实站点 | Vitest 全局 setup 注入拒绝一切出站连接的 undici Dispatcher；**任何真实网络访问即测试失败** |

### 15.4 下载

内置 BT 引擎不在本规范范围内。当前实现为交接式：magnet URI 与 .torrent 文件交给系统默认程序处理。

索引类 provider 的返回类型中**不存在**可播放 URL 字段 —— 这是类型层面的约束，不是运行时检查。

---

## 16. 打包、更新、诊断

### 16.1 打包

**electron-forge 7.11.2**，插件与 maker：

| 组件 | 版本 | 作用 |
|---|---|---|
| `@electron-forge/plugin-vite` | 7.11.2 | 主进程 / preload / 渲染进程三入口构建 |
| `@electron-forge/plugin-fuses` + `@electron/fuses` | 7.11.2 / 2.1.3 | §3.3 的安全加固 |
| `@electron-forge/plugin-auto-unpack-natives` | 7.11.2 | 自动把 native 模块移出 asar |
| `@felixrieseberg/electron-forge-maker-nsis` | 7.2.0 | Windows NSIS 安装器 |
| `@electron-forge/maker-zip` | 7.11.2 | 便携版与更新载荷 |

安装范围默认 per-user（`%LOCALAPPDATA%\Programs\manga`），无需管理员权限。

`electron` 版本在 `package.json` 中**精确锁定**（`"electron": "43.4.0"`，无 `^`）。Electron 官方仅支持最新 3 个稳定大版本，每 8 周发布一次；升级作为固定的独立变更提交，附完整回归。

### 16.2 更新器（自研）

不引入更新框架。流程：

```
1. 拉取 manifest.json：{ version, notes, files: [{ url, size, sha256, sig }] }
2. 语义版本比较，版本不高于当前则终止
3. 下载到 %LOCALAPPDATA%\manga\update\，支持断点续传
4. 校验 sha256
5. 用内置 Ed25519 公钥校验 sig（公钥编译进主进程，不从网络获取）
6. 交给 NSIS 安装器静默升级，退出当前进程
```

**禁止降级**：版本比较只接受更高版本。数据库迁移不可逆，降级会导致 schema 不兼容。回滚路径是「卸载 + 恢复备份」。

分发源：国内对象存储 + CDN 为主源，GitHub Releases 为备源，客户端按顺序尝试。产物上传由 CI 完成。

### 16.3 卸载数据语义

NSIS 卸载器三选项：

1. 保留全部数据（默认）
2. 只删除缓存
3. 删除全部应用数据

三者**均不触碰用户媒体文件与下载目录**，文案中明确说明。

### 16.4 数据生命周期

下表为正式版路径。**开发版把 `manga` 替换为 `manga-dev`**，两版数据完全隔离，可同机同时安装运行。标识符正本见 [`dev-rules/naming-and-identifiers.md`](./dev-rules/naming-and-identifiers.md)。

| 类别 | 位置 | 生命周期 | 卸载 | 备份 |
|---|---|---|---|---|
| 用户媒体 | 用户目录 | 用户掌控 | 不触碰 | 否（只备份路径映射） |
| 主数据库 | `%APPDATA%\manga\data\main.db` | 永久 | 按选项 | 是 |
| 录音 | `%APPDATA%\manga\data\recordings\` | 永久 | 按选项 | 是 |
| 缩略图/封面 | `%LOCALAPPDATA%\manga\cache\thumbs\` | LRU，上限 2 GB | 删除 | 否 |
| 抽取的内封字幕 | `%LOCALAPPDATA%\manga\cache\subs\` | 跟随源文件指纹 | 删除 | 否 |
| 转封装临时文件 | `%LOCALAPPDATA%\manga\cache\media\` | 会话级 | 删除 | 否 |
| AI 模型 | 由 Ollama/LM Studio 管理 | 不管理 | 不触碰 | 否 |
| 日志 | `%LOCALAPPDATA%\manga\logs\` | 滚动，7 天 / 50 MB | 删除 | 否 |
| 崩溃转储 | `%LOCALAPPDATA%\manga\crashes\` | 30 天 | 删除 | 否 |

### 16.5 诊断与遥测

- **无遥测**。不集成任何分析 SDK。
- 崩溃转储写在本地，**永不自动上传**。提供「导出诊断包」按钮，由用户主动生成并自行决定是否发送；诊断包生成时对路径、文件名、书名做脱敏替换。
- 日志为结构化 JSONL，logger 层强制 redact 中间件，单测断言密钥、token、绝对路径、书名不出现在输出中。

---

## 17. 测试体系与 CI 闸门

### 17.1 分层

| 层 | 运行器 | 范围 |
|---|---|---|
| `unit` | Vitest 4.1.10 | `domain` 全部；各包纯逻辑 |
| `dom` | Vitest + jsdom | 界面组件与自研 hooks |
| `db` | Vitest（真实 SQLite 临时库） | 仓储、查询、FTS5、索引计划 |
| `migration` | Vitest | 迁移重放、冻结、结构一致性 |
| `guard` | node:test | 架构与供应链闸门（见下） |
| `smoke` | Electron 主进程内置测试模式 | 启动、协议、窗口、Fuses 生效 |

不引入浏览器自动化框架。端到端验证通过 Electron 的 `--test-mode` 启动参数：主进程在测试模式下暴露一个仅 localhost、仅本次进程有效的控制端口，测试脚本用 RPC 契约直接驱动业务流程，界面断言用 `webContents.executeJavaScript` 读取 DOM 快照。这样 E2E 与 RPC 契约共用同一套类型，且不依赖外部驱动。

### 17.2 CI 闸门（全部为阻塞项）

| 闸门 | 断言 |
|---|---|
| `module-boundary` | §4.2 的四条依赖方向铁律 |
| `ipc-contract` | 每个注册的 RPC 方法都有 input/output schema；无方法返回明文密钥字段 |
| `derived-invariant` | L5 表的写入路径必然创建 evidence_link |
| `migration-freeze` | 已发布迁移文件哈希未变 |
| `migration-replay` | 从任意历史版本重放到最新，结构一致 |
| `network-allowlist` | 源码 AST 中无硬编码 URL 字面量（provider 声明表除外） |
| `no-direct-fs` | `CapabilityGate` 之外无 `node:fs` import |
| `no-direct-spawn` | `Supervisor` 之外无 `node:child_process` import |
| `csp-assert` | 两个 scheme 的 CSP 字符串与规范一致 |
| `fuses-assert` | 打包产物的 Fuses 位与 §3.3 一致 |
| `vendor-sha256` | `vendor-bin` 哈希表与下载脚本逻辑一致 |
| `third-party-notices` | 生成的声明文件与 lockfile 一致 |
| `log-redaction` | 日志输出不含密钥、token、绝对路径 |
| `offline-e2e` | 全部 provider 关闭时 smoke 套件 100% 通过，且进程 0 次出站连接 |
| `i18n-complete` | 三种语言的消息目录键集合完全一致（编译期已保证，此闸门防止 `as any` 绕过） |
| `no-hardcoded-copy` | JSX 中无中日英文字面量，用户可见文案一律走消息目录 |

### 17.3 性能基准

`scripts/bench/` 下的基准脚本在每次发布前运行，结果写入 `docs/bench/<version>.json`，与上一版本对比，回归超过 15% 阻塞发布。覆盖 §2 的 N1–N12。

测试素材由 `scripts/fixtures/` 合成生成，不提交二进制到仓库：10k/100k 条媒体记录、500 MB CBZ、2000 章 EPUB、400 页扫描 PDF、12 个容器×编码组合的视频样本矩阵。

---

## 18. 中国大陆工程约束

| 环节 | 措施 |
|---|---|
| npm 依赖 | 开发环境 `registry=https://registry.npmmirror.com`；CI 使用官方源以保证包签名完整性校验 |
| Electron 二进制 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| node-gyp headers | `NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/` |
| better-sqlite3 预编译 | CI 首次构建后把产物存入自建对象存储，`prebuild-install --prebuild-host` 指向该地址 |
| FFmpeg 二进制 | 阶段 1–9 固定上游月度保留构建；阶段 10 前镜像到自建对象存储，连同源码 tarball 与 sha256 一并托管 |
| 应用更新分发 | 国内对象存储 + CDN 为主源，GitHub Releases 为备源 |
| CI | GitHub Actions 构建，产物直接上传国内对象存储 |
| 云端 LLM | 全部 provider 配置支持自定义 base URL；首发即支持国内 OpenAI 兼容端点 |
| 本地模型 | 引导用户自行安装 Ollama / LM Studio；不代下载模型 |

---

## 19. 许可证与合规

### 19.1 义务清单

| 组件 | 许可 | 义务 |
|---|---|---|
| **FFmpeg 8.1（LGPL 预编译产物）** | LGPL-2.1+ | 已核实官方 17 条合规清单。本项目通过**独立进程调用 CLI**，不做库链接，且使用 shared 变体（libav* 为 DLL）。仍须履行：分发对应版本的源码、源码与二进制同源托管、给出该二进制对应的上游构建标识、下载页与「关于」框声明、EULA 中声明并移除逆向工程禁令、不重命名 dll。**产物必须是 lgpl 变体，禁止使用 gpl / nonfree 变体，禁止出现 libx264 / libx265** |
| Electron / Chromium / Node | MIT / BSD-3 + 多种 | 生成完整第三方声明 |
| SQLite | 公有领域 | 无 |
| better-sqlite3 / drizzle-orm / React / Radix / zod / undici | MIT | 保留声明 |
| PDF.js | Apache-2.0 | 保留声明 |
| sharp | Apache-2.0（libvips LGPL-2.1+） | 动态链接，保留声明 |
| @parcel/watcher | MIT | 保留声明 |
| CodeMirror 6 | MIT | 保留声明 |
| JASSUB | MIT（内含 libass，ISC） | 保留声明。**待验证**：完整依赖链中是否含 GPL 组件 |

`scripts/generate-third-party-notices.mjs` 从 lockfile 生成 `THIRD-PARTY-NOTICES.txt` 与 SPDX SBOM，输出在「关于」对话框中可查看，并由 `third-party-notices` 闸门断言与 lockfile 一致。

### 19.2 编解码器专利

FFmpeg 官方明确警告：商业产品使用 H.264/HEVC 等技术会引来专利池收费。本项目的缓解措施：

- 只做转封装（copy），不做软件编码。
- L3 的编码路径只使用系统硬件编码器（专利费已由 OEM 支付）；无硬件编码器时降级到 L0。
- HEVC 解码依赖平台硬件解码器，不内置软件 HEVC 解码。
- EULA 中声明。

### 19.3 产品边界

本产品自身**开源**，许可证在阶段 1 落地为 `LICENSE` 文件（默认 Apache-2.0，理由见 [`roadmap/phase-1.md`](./roadmap/phase-1.md) M1.0）。

不提供远端在线播放/阅读、不抓取媒体流、不内嵌第三方内容网站、不托管内容、不运行 tracker、不提供资源站账户、不预置盗版内容或资源推荐、不绕过 DRM。这些约束在架构层面落实：无 `webviewTag`、无内置资源站、索引 provider 的返回类型中不存在可播放 URL 字段。

### 19.4 供应链

| 措施 | 实施 |
|---|---|
| lockfile 强制 | CI `--frozen-lockfile` |
| 构建脚本白名单 | pnpm `onlyBuiltDependencies: ["better-sqlite3", "electron", "esbuild", "sharp", "@parcel/watcher"]` |
| 关键包精确锁定 | pnpm `overrides` 中锁定 `zod`、`electron`、传递依赖中的高风险包 |
| 包签名校验 | CI 校验 npm registry 的 ECDSA 包签名 |
| 二进制来源固定 | `vendor-bin` 全部 sha256 校验，哈希表入库 |
| 依赖新增审查 | §0.2 的准入 ADR |
| SBOM | 每个 release 生成 |
| 漏洞扫描 | 每周 `pnpm audit` |

---

## 20. 依赖清单

生产依赖（渲染进程 + 主进程），全部为 §0.2 的准入类别：

| 包 | 版本 | 类别 | 用途 |
|---|---|---|---|
| `electron` | **43.4.0**（精确） | ② | 运行时 |
| `better-sqlite3` | 13.0.3 | ① | SQLite 驱动（内置 3.53.4） |
| `drizzle-orm` | 0.45.2 | ③ | schema 单一事实源与类型导出 |
| `zod` | 4.4.3（精确） | ③ | RPC 与外部输入校验 |
| `react` / `react-dom` | 19.2.8 | ② | 界面运行时 |
| `@radix-ui/react-*` | 见 §13.5 | ④ | 无障碍交互原语 |
| `@floating-ui/react-dom` | 2.x | ④ | 浮层定位 |
| `@tanstack/react-virtual` | 3.14.9 | ③ | 列表虚拟化 |
| `@codemirror/*` | view 6.43.8 等 | ① | 文本编辑（Markdown 源码模式） |
| `pdfjs-dist` | 6.2.108 | ① | PDF 解析与渲染 |
| `jassub` | 2.5.14 | ① | ASS 字幕（libass WASM） |
| `sharp` | 0.35.3 | ① | 图像缩放与格式转换（libvips） |
| `@parcel/watcher` | 2.6.0 | ① | 文件系统监听 |
| `undici` | 8.10.0 | ① | HTTP 客户端与 Dispatcher 控制 |

开发依赖：

| 包 | 版本 |
|---|---|
| `typescript` | 7.0.2 |
| `vite` | 8.2.1 |
| `@electron-forge/cli` + plugins/makers | 7.11.2 |
| `@felixrieseberg/electron-forge-maker-nsis` | 7.2.0 |
| `@electron/fuses` | 2.1.3 |
| `@electron/rebuild` | 4.2.0 |
| `drizzle-kit` | 0.31.10 |
| `vitest` | 4.1.10 |
| `jsdom` | 29.x |
| `eslint` + `typescript-eslint` | 9.x / 8.x |
| `prettier` | 3.x |

非 npm 二进制（`vendor-bin`，sha256 校验）：

| 二进制 | 版本 | 许可 |
|---|---|---|
| `ffmpeg.exe` / `ffprobe.exe` / `libav*.dll` | FFmpeg 8.1，上游 `win64-lgpl-shared` 预编译产物 | LGPL-2.1+ |

---

## 21. 实施顺序

按依赖关系排列，每阶段的退出条件为下一阶段的前置。

### 阶段 1 · 骨架与信任边界

pnpm monorepo；electron-forge + plugin-vite 三入口；Fuses 全开；preload 三方法桥；RPC 内核（契约、双向 zod、取消、信用制背压、错误模型）；`CapabilityGate` 与两个自定义协议；db-utility 进程与迁移执行器；全部 CI 闸门；`vendor-bin` 下载与校验脚本。

**退出条件**：路径穿越攻击用例集 0 通过；Fuses 与 CSP 闸门绿；依赖方向违规会导致 CI 失败；空应用窗口可见 ≤ 1.2 s。

### 阶段 2 · 高风险验证

三项必须在写业务代码前完成：

1. **视频能力矩阵实测**。12 个样本（{mp4, mkv} × {h264, hevc-8bit, hevc-10bit, av1} × {aac, ac3, flac}，另加双音轨+三内封字幕的 mkv、4K HDR、VFR）。逐个记录 `<video>` 的实际表现；实测 L2 转封装的首帧延迟与 seek 延迟；用 `ffmpeg -ss` 提取参考帧做像素比对验证 seek 误差。
2. **十万条目性能**。合成 100k 记录 + trigram FTS5 索引，测 §2 的 N3/N4/N6/N7/N8。
3. **崩溃一致性**。写入压力下随机 kill 1000 次，验证 N14。

**退出条件**：N4/N6/N7/N8/N10/N11/N14 全部达标，或已确定明确的降级实现。

### 阶段 3 · 媒体库内核

库根授权；分片扫描与 cursor；两级指纹；去重、移动识别、离线标记；作品/卷/版本/文件四层模型；CJK 自然排序（含 200 条黄金用例）；封面提取（sharp）；虚拟化封面墙；FTS5 元数据搜索；人工治理；备份与恢复；**锚点表结构冻结**。

**退出条件**：N13 达标（自动重绑 ≥ 95%，静默丢失 0）；N15 达标；真实媒体库跑通完整扫描→治理流程。

### 阶段 4 · ZIP 与漫画内核

自研 ZIP 随机读取器（含 ZIP64、非 UTF-8 文件名）；`archive_entry` 索引；`PageSource` 四实现；单双页、LTR/RTL、缩放、适应模式；像素字节 LRU 与方向感知预取；长条图分块；PDF 单页大图直取；页面标记与归一化区域标记。

**退出条件**：N9 达标；连续翻 500 页内存不增长；500 MB CBZ、扫描 PDF、webtoon 长条图全部正常。

### 阶段 5 · EPUB 与小说内核

OCF/OPF/NAV/NCX 解析；字体去混淆；`book:` scheme 与严格 CSP；CSS 多栏排版引擎；二分法可见范围定位；竖排与 ruby；TXT 编码检测与章节切分；自研 CFI；后台纯文本抽取与按需全文索引；小说锚点。

**退出条件**：2000 章 EPUB 打开 ≤ 5 s；锚点创建→关闭→重开→跳转位置误差 0；日文竖排与图文混排正确。

### 阶段 6 · 视频内核

FFmpeg sidecar 与哈希校验；`PlaybackEngine` 接口与 L0/L1/L2 实现；探测决策纯函数；播放控制全套；SRT/VTT 自研解析与渲染；ASS 走 JASSUB；内封字幕抽取；双字幕双槽位；多音轨（经 L2）；缩略图与雪碧图；字幕文本入 FTS5；Supervisor 与 Job Object。

**退出条件**：N10/N11/N12 达标；样本矩阵中 ≥ 10 个可播放，其余明确降级到 L0；kill ffmpeg 后主进程与渲染进程 100% 存活且无孤儿进程。

### 阶段 7 · 证据与笔记

跨三种媒体的统一证据视图；失效状态机与用户处理流程；CodeMirror Markdown 笔记；短语音录制；标签/描述/引用文本/缩略图；证据搜索；`evidence_link` 与「查看证据」跳转；作品笔记聚合。

**退出条件**：三类锚点均可创建、搜索、跳转、失效后恢复；静默丢失 0。

### 阶段 8 · AI 层

三种协议的 Provider 实现；自定义 base URL；Ollama/LM Studio 探测；流式与信用制背压；取消；成本记录；令牌桶限流；会话持久化；证据注入；工具注册与授权门控；`audit_log`；`safeStorage` 密钥管理；日志脱敏。

**退出条件**：取消响应 ≤ 200 ms；未授权工具拦截率 100%；日志密钥泄露 0；全部 AI 产物可回跳证据。

### 阶段 9 · 外部适配器

`ExternalProvider` 接口；`NetGateway`；真实元数据 provider；手动元数据与 manual 优先级；弹幕本地导入与 Canvas 渲染；magnet/torrent 交接；provider 开关界面。

**退出条件**：`offline-e2e` 闸门绿；测试环境 0 次真实网络访问；单 provider 失败不影响其他。

### 阶段 10 · 发布工程

NSIS 三选项卸载器；自研更新器与 Ed25519 完整性校验；国内 CDN 主源与 GitHub 备源；诊断包导出；`THIRD-PARTY-NOTICES` 与 SBOM 生成；FFmpeg 源码随版本发布；首次运行引导。

**退出条件**：全新 Windows 11 上安装→使用→升级→卸载全流程无异常；许可声明完整。

---

## 22. 风险与触发器

| # | 风险 | 缓解 | 触发器 | 应对 |
|---|---|---|---|---|
| R1 | Chromium 对 MKV/多音轨的支持边界导致 L2 成为主路径，seek 延迟不可接受 | `PlaybackEngine` 接口与 `caps.supportsHtmlOverlay` 从阶段 1 就存在 | 阶段 2 实测 seek P95 > 2 s | L2 改为「先转封装到临时文件再播放」；必要时引入 libmpv 独立窗口作为第四种实现 |
| R2 | 内存超出 N4 | 缓存可回收；进程可合并 | 100k 条目下 > 900 MB | 合并 scan-utility 到 db-utility；降低 LRU 上限；缩短封面缓存 TTL |
| R3 | better-sqlite3 随 Electron 大版本 ABI 破坏 | `@electron/rebuild` 自动化；自建 prebuild 缓存；DB 访问收敛在 `packages/data` | 每次 Electron 升级的 CI | 升级 better-sqlite3；若上游停维则迁移到 `node:sqlite`（**待验证**：Electron 打包的 Node 是否启用 FTS5） |
| R4 | Electron 每 8 周升级形成技术债 | 精确锁版本；升级为独立提交；CI 每周跑 nightly 冒烟 | 单次升级超过 2 天 | 放宽到落后 1 个大版本（仍在支持窗口内） |
| R5 | trigram FTS5 的中日文检索质量不足 | 索引 schema 预留 `tokenizer_version` 字段；正文索引默认关闭 | 真实语料检索准确率不可接受 | 在应用层用 `Intl.Segmenter` 预分词后写入普通 FTS5 列，与 trigram 列并存 |
| R6 | 恶意 EPUB 通过脚本内容窃取数据 | 独立 scheme + `script-src 'none'` + CSP 闸门 | 安全测试或用户报告 | 把 EPUB 渲染移到独立的无网络渲染进程 |
| R7 | FFmpeg CVE | 独立子进程、无网络、无密钥、工作目录受限 | FFmpeg 安全公告 | 发补丁版；临时禁用受影响的容器格式 |
| R8 | npm 供应链投毒 | §19.4 全套 | `pnpm audit` 或社区通报 | 锁定版本回退；用 SBOM 定位影响面 |
| R9 | 编解码器专利索赔 | 只转封装不软编码；硬件编码器优先；EULA 声明 | 收到专利池来函 | 移除受影响格式，改为调用系统播放器 |
| R10 | 上游 FFmpeg 预编译产物不可得（保留期过、仓库下线、变体停供） | **阶段 1–9 固定上游月度构建**（上游承诺保留两年），闸门断言不得使用 `latest`/日构建；阶段 10 前完成自建镜像 | `ensure-vendor-bin` 拉取失败 | 走自建镜像；镜像尚未建立时，按上游 docker 构建脚本自建一次并立即托管 |
| R11 | TypeScript 7 与 type-aware ESLint 规则不兼容 | 阶段 1 就验证完整 lint 链路 | 阶段 1 lint 无法运行 | 降到 TypeScript 6.x 线（**待验证**：6.x 的可用性与差异） |
| R12 | 用户媒体在网络盘上，性能与监听假设失效 | 检测卷类型，对网络盘关闭监听、延长超时、跳过全文件指纹 | 扫描超时 | 「网络盘模式」：只做元数据扫描，指纹按需计算 |
| R13 | 阶段 1 的临时更新签名密钥被带进正式发布 | 阶段 1 明确标记为一次性密钥；发布闸门断言编译进主进程的公钥不等于任何已知临时值 | 阶段 10 发布前检查 | 阻塞发布，先完成正式密钥仪式（离线生成、私钥离线保管、公钥编译进主进程） |

---

## 23. ADR 清单

带 ★ 的必须在阶段 1 完成。

| # | 标题 |
|---|---|
| ★001 | 依赖准入原则：自研优先，四类例外 |
| ★002 | Electron 精确锁版本与 8 周升级节奏 |
| ★003 | 进程拓扑与 L0/L1/L2 信任分级 |
| ★004 | Electron Fuses 全项开启 |
| ★005 | 双 scheme 设计与 EPUB 的 `script-src 'none'` |
| ★006 | 自研 RPC 内核：信用制背压、AbortSignal 取消、结构化错误 |
| ★007 | 媒体 URL 使用不透明 token |
| ★008 | 路径解析集中在 CapabilityGate |
| ★009 | 依赖方向四条铁律与 CI 强制 |
| ★010 | better-sqlite3 + drizzle 生成迁移 + 运行时原生 SQL |
| ★011 | 三道迁移闸门：冻结、校验、重放 |
| ★012 | 锚点绑定 file.id 与两级指纹 |
| ★013 | 锚点失效六状态机，禁止静默重定位 |
| ★014 | L4/L5 物理分表与 evidence_link 强制 |
| ★015 | 全系统整数毫秒 |
| ★016 | PlaybackEngine 接口与 caps.supportsHtmlOverlay |
| 017 | FTS5 trigram 与正文索引按需开启 |
| 018 | 向量检索自研全内存暴力实现 |
| 019 | 自研 ZIP 随机读取器，不预解压 |
| 020 | 自研 EPUB 解析与 CSS 多栏排版引擎 |
| 021 | 自研 CFI 实现与上下文冗余定位 |
| 022 | CJK 自然排序归一化管线与黄金测试集 |
| 023 | FFmpeg 使用上游 LGPL 预编译产物、镜像自建存储、进程外调用、sha256 校验 |
| 024 | 视频三级降级与 L3 的编码器许可证约束 |
| 025 | 双字幕双槽位：ASS 走 JASSUB，副字幕走 HTML |
| 026 | 自研状态、查询缓存、路由、i18n |
| 027 | 原生 CSS Modules + 设计令牌，不用 CSS 框架 |
| 028 | 自研 AI Provider 层，三协议，强制自定义 base URL |
| 029 | AI 工具授权门控与审计日志 |
| 030 | 外部 provider 默认关闭与 NetGateway 统一策略 |
| 031 | 自动测试禁止真实网络访问 |
| 032 | 索引 provider 类型中不存在可播放 URL 字段 |
| 033 | 自研更新器与 Ed25519 完整性校验，禁止降级 |
| 034 | 无遥测，崩溃转储本地留存 |
| 035 | E2E 通过 Electron 测试模式而非浏览器自动化框架 |

---

## 24. 待验证事项

以下事项本次调研未能确认，**不得作为决策依据**，必须在阶段 1/2 中确认：

| # | 事项 | 确认方式 |
|---|---|---|
| V1 | Electron 43/44 的 `<video>` 对 MKV 各编码组合的实际支持边界 | 阶段 2 的样本矩阵实测 |
| V2 | L2 转封装的 seek 延迟是否满足 N11 | 阶段 2 实测 |
| V3 | Electron 打包的 Node 24.18.1 中 `node:sqlite` 是否启用 FTS5 | 在 Electron 中执行 `CREATE VIRTUAL TABLE t USING fts5(x)` |
| V4 | JASSUB 2.5.14 的完整依赖链许可证，是否含 GPL 组件 | 读其仓库 LICENSE 与构建脚本 |
| V5 | TypeScript 7.0.2 与 typescript-eslint 8.x 的 type-aware 规则兼容性 | 阶段 1 骨架中实测完整 lint 链路 |
| V6 | Electron 43/44 在 Windows 上 HEVC 硬件解码的默认开关状态 | 目标机型上调用 `MediaCapabilities.decodingInfo` |
| V7 | Electron 44.0.0（2026-08-25 稳定）的破坏性变更清单 | 发布后读 breaking-changes 文档 |
| V8 | trigram FTS5 索引在 100k 条目 + 全部正文时的实际体积 | 阶段 2 实测 |

---

## 25. 资料来源

访问日期均为 **2026-08-12**。

### 官方文档

| 来源 | URL | 核实内容 |
|---|---|---|
| Electron 版本支持策略 | `https://www.electronjs.org/docs/latest/tutorial/electron-timelines` | 支持最新 3 个稳定大版本，8 周节奏 |
| Electron 发布计划 | `https://releases.electronjs.org/schedule` | E44 稳定 2026-08-25（Chromium M152 / Node 24.18.1）；E43 EOL 2027-01-05 |
| Electron v43.4.0 | `https://releases.electronjs.org/release/v43.4.0` | Chromium **150.0.7871.224** / Node **24.18.1**，Latest Stable |
| Electron v43.4.0 Release 资产 | `https://api.github.com/repos/electron/electron/releases/tags/v43.4.0` | 提供 `ffmpeg-v43.4.0-<platform>.zip` 用于替换为非专有构建，反证默认构建含专有编解码器 |
| Node.js 发布时间表 | `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json` | v24 "Krypton" Active LTS，维护期 2026-10-20，EOL 2028-04-30 |
| Node.js `node:sqlite` | `https://nodejs.org/api/sqlite.html` | **Stability 1.2 — Release candidate** |
| SQLite 变更历史 | `https://www.sqlite.org/changes.html` | 最新 **3.53.4**（2026-07-24） |
| better-sqlite3 编译文档 | `https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/compilation.md` | 内置 SQLite **3.53.4**；`SQLITE_ENABLE_FTS5` 已开启；**`SQLITE_ENABLE_ICU` 未开启** |
| FFmpeg 下载页 | `https://ffmpeg.org/download.html` | **8.1.2 "Hoare"**（2026-06-17，8.1 分支 2026-03-08 切出）；9.0.1 于 2026-08-12 当日发布 |
| FFmpeg 许可与法律 | `https://ffmpeg.org/legal.html` | LGPL-2.1+；17 条合规清单；libx264 为 GPL 不可使用；专利 FAQ 明确警告商业使用 |
| BtbN/FFmpeg-Builds README | `https://raw.githubusercontent.com/BtbN/FFmpeg-Builds/master/README.md` | 变体 `lgpl` / `lgpl-shared` 明确排除 libx264、libx265；保留策略「每月最后一个构建保留两年，日构建保留最近 14 个」；docker 化可复现构建 |
| BtbN/FFmpeg-Builds 最新发布资产 | `https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest` | 存在 `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip` |

### npm 版本核实

全部通过 `https://registry.npmjs.org/-/package/<name>/dist-tags` 于 2026-08-12 获取：

`electron` **43.4.0** · `typescript` **7.0.2** · `better-sqlite3` **13.0.3** · `drizzle-orm` **0.45.2** · `drizzle-kit` **0.31.10** · `zod` **4.4.3** · `react` **19.2.8** · `@tanstack/react-virtual` **3.14.9** · `@codemirror/view` **6.43.8** · `pdfjs-dist` **6.2.108** · `jassub` **2.5.14** · `sharp` **0.35.3** · `@parcel/watcher` **2.6.0** · `undici` **8.10.0** · `vite` **8.2.1** · `vitest` **4.1.10** · `@electron-forge/cli` **7.11.2** · `@electron/fuses` **2.1.3** · `@electron/rebuild` **4.2.0** · `@felixrieseberg/electron-forge-maker-nsis` **7.2.0**
