# 仓库地图

> 触发：首次接触本仓、需要定位功能代码、判断新代码归属哪个 package 时。

## 1. 目录

```
manga/
├── AGENTS.md               Agent 与开发者工作入口（唯一正本）
├── CLAUDE.md               只含 @AGENTS.md
├── apps/
│   ├── desktop/            Electron 应用：主进程、preload、渲染进程入口、forge 配置
│   ├── svc-db/             数据服务 utility 进程
│   └── svc-scan/           扫描服务 utility 进程
├── vendor-bin/             平台二进制，不入库，安装时按平台下载并校验 sha256
│   └── ffmpeg/
├── packages/
│   ├── domain/             纯 TS，零 I/O，零 Node API，零 DOM
│   ├── contract/           RPC 契约：方法名 + zod input/output/stream
│   ├── rpc/                RPC 内核（编解码、取消、背压、错误模型）+ 传输适配
│   ├── data/               schema、migration、仓储；唯一 import better-sqlite3 的包
│   ├── zip/                自研 ZIP 随机读取器
│   ├── epub/               自研 EPUB 解析与排版内核
│   ├── comic/              漫画页面管线与缓存
│   ├── media/              FFmpeg sidecar 调度、探测、转封装、抽帧
│   ├── player/             PlaybackEngine 接口与实现
│   ├── subtitle/           字幕解析与渲染
│   ├── ai/                 Provider 层、工具注册、审计
│   ├── providers/          外部元数据 / 弹幕 / 索引适配器
│   ├── ui/                 自研状态、查询缓存、路由、i18n、CSS 令牌、基础组件
│   └── features/           媒体库、阅读器、播放器、笔记的界面模块
├── scripts/                自建工具链（.mjs，用 node:test 测试）
└── docs/                   见 docs/README.md
```

## 2. 新代码该放哪里

按顺序回答，第一个「是」即为答案：

| 问题 | 是 → 放这里 |
|---|---|
| 它是纯函数，不碰 I/O、Node API、DOM 吗？ | `packages/domain/<子域>` |
| 它是 UI 与主机之间的接口定义吗？ | `packages/contract` |
| 它读写数据库吗？ | `packages/data` |
| 它解析某种文件格式吗？ | 对应的格式包（`zip` / `epub` / `comic` / `subtitle`） |
| 它调用外部进程吗？ | `packages/media`（媒体）或新建专用包 |
| 它发起网络请求吗？ | `packages/providers`（外部数据源）或 `packages/ai`（模型） |
| 它是可复用的界面原语吗？ | `packages/ui` |
| 它是某个具体功能的界面吗？ | `packages/features/<功能>` |
| 它是构建、校验、生成类脚本吗？ | `scripts/` |
| 都不是 | 停下来，先问清楚它是什么 |

**不要**把业务逻辑写进 `apps/desktop`。`apps/*` 只做组装：创建窗口、注册协议、拉起进程、连接 RPC 路由。任何超过组装的逻辑都属于某个 package。

## 3. 关键概念在哪

| 概念 | 位置 |
|---|---|
| 锚点模型与失效状态机 | `packages/domain/anchor` |
| CJK 自然排序 | `packages/domain/naming` |
| 文件指纹算法 | `packages/domain/fingerprint` |
| 播放能力决策矩阵 | `packages/domain/playback` |
| 毫秒时间基元 | `packages/domain/time` |
| 能力网关（路径解析与穿越防护） | `apps/desktop/src/main/capability-gate` |
| 密钥保险箱 | `apps/desktop/src/main/secret-vault` |
| 任务调度器 | `apps/desktop/src/main/task-scheduler` |
| 进程监督 | `apps/desktop/src/main/supervisor` |
| 网络网关 | `apps/desktop/src/main/net-gateway` |
| RPC 路由 | `apps/desktop/src/main/rpc-router` |
| 传输适配（换容器时唯一要改的文件） | `packages/rpc/src/transport/electron.ts` |

## 4. 命名

- 包名：`@manga/<name>`，目录名与包名后缀一致。
- 文件名：kebab-case。React 组件文件用 PascalCase。
- 测试：与被测文件同目录的 `__tests__/<name>.test.ts`。
- 脚本测试：`scripts/__tests__/<name>.test.mjs`，用 `node:test`。
