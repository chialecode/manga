# 测试与门禁

> 触发：新增或修改测试、CI 闸门，或需要判断某项改动该跑哪一层测试时。
> **不得通过跳过、删除或弱化测试制造通过。**

## 1. 测试分层

| 层 | 命令 | 运行器 | 范围 |
|---|---|---|---|
| `unit` | `pnpm test:unit` | Vitest | `domain` 全部；各包纯逻辑 |
| `dom` | `pnpm test:dom` | Vitest + jsdom | 界面组件与自研 hooks |
| `db` | `pnpm test:db` | Vitest（真实 SQLite 临时库） | 仓储、查询、FTS5、索引计划、崩溃恢复 |
| `migration` | `pnpm test:migration` | Vitest | 重放、冻结、结构一致性 |
| `guard` | `pnpm test:guard` | `node:test` | 架构与供应链闸门（§3） |
| `smoke` | `pnpm test:smoke` | Electron 测试模式 | 启动、协议、窗口、Fuses、端到端流程 |
| 全部 | `pnpm test:all` | — | 以上全部 |

**提交前必跑**：`pnpm test:unit` + 改动涉及包的 `typecheck`。触及进程边界、数据库、协议或供应链时追加 `pnpm test:all`。

## 2. 端到端不用浏览器自动化框架

Electron 支持 `--test-mode` 启动参数：主进程在该模式下暴露一个仅 localhost、仅本次进程有效的控制端口。测试脚本用 **RPC 契约本身**驱动业务流程，界面断言用 `webContents.executeJavaScript` 读取 DOM 快照。

好处：E2E 与生产代码共用同一套类型，契约变更会让 E2E 编译失败而不是运行时静默失败；不引入额外驱动依赖。

`--test-mode` 只在开发与测试构建中编译进去，发布构建中该分支被 `import.meta.env` 常量折叠移除，`smoke` 层有一条断言验证发布产物中不含该字符串。

## 3. CI 闸门

全部为阻塞项。每个闸门必须有一条**反例测试**：构造一个违规样本，断言闸门确实拦下它。没有反例的闸门等于没有闸门。

| 闸门 | 断言 |
|---|---|
| `module-boundary` | 依赖方向四条铁律；`domain` 无 Node/DOM import |
| `ipc-contract` | 每个注册方法都有 input/output schema；output 中无凭证类字段名 |
| `derived-invariant` | 派生内容（L5）的写入路径必然创建 `evidence_link` |
| `migration-freeze` | 已发布迁移文件哈希未变 |
| `migration-replay` | 从任意历史版本重放到最新，结构一致 |
| `network-allowlist` | 源码 AST 中无硬编码 URL 字面量（provider 声明表与测试 fixture 除外） |
| `no-direct-fs` | `capability-gate` 之外无 `node:fs` import |
| `no-direct-spawn` | `supervisor` 之外无 `node:child_process` import |
| `csp-assert` | 两个 scheme 的 CSP 字符串与规则文档一致 |
| `fuses-assert` | 打包产物的 Fuses 位与规则文档一致 |
| `vendor-sha256` | `vendor-bin.manifest.json` 与下载脚本逻辑一致；version 变更必须伴随 sha256 变更 |
| `third-party-notices` | 生成的声明文件与 lockfile 一致 |
| `log-redaction` | logger 输出不含密钥、token、绝对路径、书名 |
| `offline-e2e` | 全部 provider 关闭时 smoke 套件 100% 通过，且进程 0 次出站连接 |
| `i18n-complete` | 三种语言消息目录键集合完全一致 |
| `no-hardcoded-copy` | JSX 中无中日英文字面量 |

## 4. 网络隔离

Vitest 全局 setup 注入拒绝一切出站连接的 undici Dispatcher，并覆盖全局 `fetch`。

**任何真实网络访问即测试失败。** 需要测试 provider 时用本地 fixture。`offline-e2e` 闸门额外在进程级别统计出站连接数，断言为 0。

## 5. 测试素材

由 `scripts/fixtures/` 合成生成，**不提交二进制到仓库**：

| 素材 | 生成脚本 | 用途 |
|---|---|---|
| 10k / 100k 条媒体记录 | `gen-library.mjs` | 性能基准、分页、搜索 |
| 500 MB CBZ（800 页） | `gen-cbz.mjs` | 随机读、缓存、内存 |
| 2000 章 EPUB | `gen-epub.mjs` | 解析、排版、定位 |
| 400 页扫描 PDF | `gen-pdf.mjs` | 大图直取 |
| 12 组容器×编码视频矩阵 | `gen-video.mjs`（调用 `vendor-bin` 的 ffmpeg） | 播放能力矩阵 |
| 路径穿越攻击用例集 | `traversal-cases.mjs` | 能力网关 |

## 6. 闸门的强制点与 CI 触发策略

GitHub Actions 有并发限制，且 CI 无法拦住一次已经推出去的坏提交。因此闸门的强制力落在**本地 git hook** 上，CI 只做合并前后的复核。

| 强制点 | 跑什么 | 状态 |
|---|---|---|
| **`pre-commit` hook** | `lint` + `typecheck` + `test:unit` + **全部静态闸门** | 生效 |
| **`pre-push` hook** | 追加需要构建或运行时产物的闸门 | 生效 |
| CI（`push` 到 `main`、`pull_request` 到 `main`） | 全量复核 | 生效 |

### 6.1 静态闸门（进 `pre-commit`）

纯文件与 AST 扫描，秒级，无需构建：

`module-boundary`、`no-direct-fs`、`no-direct-spawn`、`network-allowlist`、`no-hardcoded-copy`、`i18n-complete`、`ipc-contract`、`migration-freeze`、`csp-assert`、`vendor-sha256`、`third-party-notices`、`no-bare-new-browserwindow`、`validate-migrations`、`identity-literals`

### 6.2 运行时闸门（进 `pre-push` 与 CI）

需要打包产物或构建输出：

`fuses-assert`（读打包产物的 Fuses 位）、`migration-replay`、`log-redaction`、`derived-invariant`、`offline-e2e`、`release-artifact`（断言发布产物中不含测试模式开关）

> `fuses-assert` 需要 `apps/desktop/out/`，`release-artifact` 需要 `apps/desktop/.vite/build/main.cjs`，两者都被 gitignore。清理过工作区后首次 `git push` 前需先跑 `pnpm --filter @manga/desktop make`，否则会被 `pre-push` 拦下。

### 6.3 CI 配置

```yaml
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md']
  pull_request:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md']
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

`pull_request` 触发是必需的：本仓库只有一位维护者，而 GitHub 不允许批准自己的 PR，因此分支保护的 required approvals 只能是 0，CI 是 PR 上唯一的独立复核。仓库为公开仓，标准 runner 不计分钟数。

`cancel-in-progress` 只对 PR 生效：`main` 上的复核运行不得被后续推送取消。

### 6.4 三条约束

- hook 由 `scripts/install-hooks.mjs` 安装，`postinstall` 中自动执行。**克隆仓库后第一次 `pnpm install` 就必须装上**。
- **禁止 `--no-verify`**。绕过 hook 等同于跳过闸门，与「不得通过跳过、删除或弱化测试制造通过」同级。
- `paths-ignore` 只豁免纯文档改动。触及 `scripts/`、`packages/`、`apps/` 中任一文件就必须跑全套。

## 7. 性能基准

`scripts/bench/` 下的脚本在每次发布前运行，结果写入 `docs/bench/<version>.json`。与上一版本对比，**任一指标回归超过 15% 阻塞发布**。

覆盖架构正本 §2 的 N1–N12。基准运行在固定配置的机器上，结果中记录 CPU、内存、磁盘型号——跨机器对比无意义。

## 8. 写测试的要求

- 单元测试不 mock `domain`。`domain` 是纯的，直接调用。
- 需要 mock 的地方说明为什么该依赖无法注入——通常这是设计问题的信号。
- 数据库测试用真实 SQLite 临时文件，不用内存库：WAL 行为、fsync 语义、并发行为在内存库中不同。
- 断言具体值，不断言「不抛异常」。
- 每个 bug 修复必须附一条会在修复前失败的测试。
