# 第一阶段：骨架与信任边界

> 状态：`authoritative`，**已验收完成**（2026-08-18，PR #1 → commit `71dd1ee`，E1–E12 全部满足）。
> 架构依据见 [`docs/architecture.md`](../architecture.md) §21「实施顺序 · 阶段 1」。当前阶段见 [`phase-2.md`](./phase-2.md)。

## 1. 阶段目标

**在写任何业务代码之前，先把不可回头的东西固定下来。**

第一阶段不交付任何用户可见功能。它交付的是：一条能跑通的工具链、一个能打包的应用外壳、一套被机器强制的边界。这些东西的共同特点是——**如果第一天没做对，后面每一天的成本都会更高**：

- 依赖方向一旦被违反，恢复它需要重构全部已写的代码。
- 安全边界一旦有例外，例外会繁殖。
- migration 一旦发布过，就永久冻结。
- 二进制供应链一旦没有校验，后面加校验意味着要回溯审计全部历史产物。

## 2. 阶段退出条件

全部满足才算完成。任何一条不满足都不进入第二阶段。

| # | 条件 | 验证方式 |
|---|---|---|
| E1 | 路径穿越攻击用例集 **0 通过** | `pnpm test:unit`（`capability-gate/__tests__/traversal.test.ts`） |
| E2 | 16 个闸门全部接线且**阻塞提交或推送**，每个都有反例证明它确实会拦 | `pnpm test:guard` + 逐个反例演示 |
| E3 | 依赖方向违规会被 `pre-commit` hook 拒绝 | 反例：在 `domain` 中 import `node:fs`，尝试 commit 被拒 |
| E4 | Fuses 8 项与 CSP 两串与规则文档完全一致 | `fuses-assert` / `csp-assert` |
| E5 | 空应用窗口可见 P95 ≤ 1.2 s | `scripts/bench/startup.mjs`，结果入 `docs/bench/` |
| E6 | 1000 次随机 kill 后 `PRAGMA integrity_check` 全 ok、僵尸任务 0、已提交事务丢失 0 | `pnpm test:db` |
| E7 | 从 `0001` 重放到最新，结构与直接建库一致 | `pnpm test:migration` |
| E8 | 篡改 `vendor-bin` 二进制后应用拒绝启动 | 手工 + `vendor-sha256` |
| E9 | RPC 取消在 200 ms 内生效；慢消费者下主机端内存不线性增长 | `packages/rpc/__tests__/` |
| E10 | 全新 Windows 11 上安装 → 启动 → 升级 → 卸载三选项行为与文档一致 | 手工，记录到 PR |
| E11 | 待验证事项 V3、V5 有明确结论并写入 ADR | 文档检查 |
| E12 | 开发版与正式版可同机同时安装运行，数据、缓存、日志、单实例锁、任务栏分组、深链接全部隔离 | 手工，逐项核对 [`naming-and-identifiers.md`](../dev-rules/naming-and-identifiers.md) §3.1 |

> **关于 CI 与闸门强制点**：闸门的强制力落在 **本地 git hook** 上，不在 CI（见 [`testing-and-gates.md`](../dev-rules/testing-and-gates.md) §6）：静态闸门进 `pre-commit`，运行时闸门进 `pre-push`。远端已绑定（`origin` → `github.com/chialecode/manga`），`pre-push` 与 CI 均已生效；CI 在 `push` 到 `main` 与 `pull_request` 到 `main` 时运行，只做复核。
> **验收时必须现场演示每个闸门的反例被拒绝**，不接受「脚本存在」或「手动跑过一次」作为通过证据。

## 3. 里程碑依赖图

```
M1.0 工具链与骨架
  ├─► M1.1 应用外壳 ──┬─► M1.2 信任边界 ──► M1.4 能力网关与媒体协议 ──┐
  │                    │                                                 │
  │                    └─► M1.3 RPC 内核 ──► M1.5 数据层与迁移 ─────────┤
  │                                                                      ├─► M1.7 闸门全量 ──► M1.8 发布链路预演
  └─► M1.6 vendor-bin 供应链 ──────────────────────────────────────────┘
```

M1.2 与 M1.3 可并行，M1.4 与 M1.5 可并行，M1.6 全程可并行。

---

## 4. 里程碑

### M1.0 · 工具链与仓库骨架

**目标**：一条能跑通的 `install → typecheck → lint → test → build` 流水线，且依赖方向从第一天起就被机器强制。

**交付物**

| 路径 | 内容 |
|---|---|
| `pnpm-workspace.yaml` | workspace 定义 |
| `package.json`（根） | `engines`（node 24 / pnpm 10）、`packageManager` 精确版本、`onlyBuiltDependencies` 白名单、`overrides` 精确锁定 `electron` / `zod` / `better-sqlite3` |
| `.npmrc` | 镜像配置、`prebuild-host`、`frozen-lockfile` 相关 |
| `tsconfig.base.json` + 各包 `tsconfig.json` | strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`module: nodenext`、project references |
| `eslint.config.js` | flat config + typescript-eslint + 自定义规则骨架（`no-direct-fs`、`no-hardcoded-copy`、`no-console`、`no-bare-new-browserwindow`） |
| `.prettierrc` | 格式化 |
| `packages/*/`、`apps/*/` | 全部空包（`package.json` + `src/index.ts`），按 [`repo-map.md`](../dev-rules/repo-map.md) 的目录 |
| `packages/contract/src/identity.ts` | 应用名、appId、目录名、协议名的**唯一定义处**，按 [`naming-and-identifiers.md`](../dev-rules/naming-and-identifiers.md)；`__BUILD_CHANNEL__` 由构建注入 |
| `scripts/__tests__/module-boundary.test.mjs` | 解析 import 图，断言四条铁律；含反例 |
| `scripts/install-hooks.mjs` | 安装 `pre-commit` 与 `pre-push` hook；`postinstall` 中自动执行 |
| `.husky/pre-commit`（或等价实现） | `lint` + `typecheck` + `test:unit` + 11 个静态闸门，失败拒绝 commit |
| `.husky/pre-push`（或等价实现） | 追加 5 个运行时闸门，失败拒绝 push（绑定远端后生效） |
| `.github/workflows/ci.yml` | `on: push: branches: [main]` + `paths-ignore` + `concurrency`；install / typecheck / lint / test:unit / test:guard |
| `LICENSE` + 各包 `package.json` 的 `license` 字段 | 开源许可证（见下方「必须在此里程碑确定的事项」） |
| `docs/adr/0001-*.md` … | 阶段 1 需要的 ★ 级 ADR（见 architecture §23） |

**验收**

- 干净机器上 `pnpm install` 通过（含镜像路径），且 `pre-commit` / `pre-push` hook 被自动安装。
- `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、`pnpm test:guard` 全绿。
- 反例验证：在 `packages/domain` 中 import `node:fs` → **commit 被 hook 拒绝**。
- 反例验证：在 `packages/features` 中 import `packages/data` → **commit 被 hook 拒绝**。
- 源码中搜不到应用名、appId、目录名、协议名的字面量（全部来自 `identity.ts`）。

**必须在此里程碑解决的待验证事项**

> **V5 · TypeScript 7.0.2 与 typescript-eslint 8.x 的 type-aware 规则兼容性。**
> 跑通完整 lint 链路（含 `@typescript-eslint/no-floating-promises` 这类需要类型信息的规则）。
> 不可用则降到 TypeScript 6.x 线，并提交 ADR 记录降级原因与重新升级的触发条件。
> **这条不解决就不要继续**——它会影响后面每一个包的类型质量。

**必须在此里程碑确定的事项**

> **开源许可证。** 产品已定为开源，但具体许可证需在本里程碑落地为 `LICENSE` 文件与各包的 `license` 字段。
> **默认取 Apache-2.0**：它带显式专利授权条款，与架构正本 §19.2 的编解码器专利敞口直接相关；与本仓库全部依赖（MIT / BSD-3 / Apache-2.0）兼容；且不给下游附加限制。
> 若要改为其他许可证，**必须在接受任何外部贡献之前完成** —— 一旦有第三方提交，变更许可证需要逐个联系贡献者。

**前置**：无。

---

### M1.1 · 应用外壳

**目标**：能启动、能打包的最小 Electron 应用。

**交付物**

| 路径 | 内容 |
|---|---|
| `apps/desktop/forge.config.ts` | `plugin-vite`（main / preload / renderer 三入口）、`plugin-fuses`、`plugin-auto-unpack-natives`、`maker-nsis`、`maker-zip`；按 `__BUILD_CHANNEL__` 产出 stable / dev 两套标识 |
| `apps/desktop/vite.{main,preload,renderer}.config.ts` | 三份构建配置；注入 `__BUILD_CHANNEL__` |
| `apps/desktop/src/main/bootstrap.ts` | **在 `app.whenReady()` 之前**完成 `setName` / `setAppUserModelId` / `setPath`（userData、sessionData、logs、crashDumps），全部取自 `identity.ts` |
| `apps/desktop/src/main/index.ts` | 单实例锁、深链接注册（`manga://` / `manga-dev://`）、生命周期、优雅退出 |
| `apps/desktop/src/main/window/create-window.ts` | **唯一**的窗口创建函数：统一施加 webPreferences、CSP 注入、导航拦截、窗口状态持久化 |
| `apps/desktop/src/renderer/index.tsx` | 空白页 + 版本信息 + 一个调试面板（显示当前 channel 与全部解析后的路径） |
| `scripts/bench/startup.mjs` | 测量进程启动到窗口 `ready-to-show` 的耗时，采样 20 次取 P95 |

**验收**

- `pnpm dev` 起窗口。
- `pnpm make` 产出 NSIS 安装包与 zip。
- **窗口可见 P95 ≤ 1.2 s**（E5），结果写入 `docs/bench/`。
- 反例验证：在窗口创建函数之外直接 `new BrowserWindow` → ESLint 失败。
- **环境隔离（E12）**：同机安装 stable 与 dev 两份，同时启动，逐项核对 [`naming-and-identifiers.md`](../dev-rules/naming-and-identifiers.md) §3.1 的七项隔离全部成立。特别验证：两版同时运行时单实例锁互不干扰；卸载 dev 后 `manga://` 仍由 stable 处理。

**前置**：M1.0。

**并行事项**：Electron 44.0.0 于 2026-08-25 转稳定。在此里程碑完成后评估升级（待验证事项 V8），升级作为独立 PR，不与本里程碑混合。

---

### M1.2 · 信任边界

**目标**：安全基线全部落地，并被闸门锁死。

**交付物**

| 路径 | 内容 |
|---|---|
| `apps/desktop/src/main/window/web-preferences.ts` | 固定配置常量，被 `create-window` 引用 |
| `apps/desktop/src/preload/index.ts` | 三方法桥，不多不少 |
| `apps/desktop/forge.config.ts` | Fuses 全 8 项 |
| `apps/desktop/src/main/protocol/register.ts` | 两个 scheme 的 `registerSchemesAsPrivileged` |
| `apps/desktop/src/main/security/csp.ts` | 两串 CSP 常量 |
| `apps/desktop/src/main/security/navigation.ts` | `setWindowOpenHandler` 一律 deny；`will-navigate` 一律 preventDefault；`shell.openExternal` 前校验 `https:` |
| `scripts/__tests__/csp-assert.test.mjs` | 断言 CSP 字符串与 [`electron-security-and-process-boundaries.md`](../dev-rules/electron-security-and-process-boundaries.md) §2 一致；含反例 |
| `scripts/__tests__/fuses-assert.test.mjs` | 读打包产物的 Fuses 位；含反例 |

**验收**

- `csp-assert`、`fuses-assert` 闸门绿。
- 用 `npx @electron/fuses read` 读打包产物，8 项与文档逐项一致。
- 在 DevTools 中求值 `window.require`、`window.process`、`require`、`module` 均为 `undefined`。
- 尝试 `window.open('https://example.com')` 被拒绝；点击外链走主进程且非 https 被拦。

**前置**：M1.1。

---

### M1.3 · RPC 内核

**目标**：类型安全、可取消、有背压、错误脱敏的进程间调用。这是后面所有功能的通信基础。

**交付物**

| 路径 | 内容 |
|---|---|
| `packages/contract/src/method.ts` | `method()` 定义器：`name` / `input` / `output` / `stream?` / `invalidates?` |
| `packages/contract/src/errors.ts` | `ErrorCode` 枚举、`WireError` 类型 |
| `packages/contract/src/sys.ts` | 验证用方法 `sys.echo`、`sys.ticker` |
| `packages/rpc/src/core/frame.ts` | 帧编解码 |
| `packages/rpc/src/core/credit.ts` | 信用制背压（初始 32，每 16 回补） |
| `packages/rpc/src/core/cancel.ts` | `callId → AbortController` 表 |
| `packages/rpc/src/transport/electron.ts` | **唯一** import `electron` 的位置 |
| `packages/rpc/src/client/index.ts` | `invoke` / `stream` / `cancel` |
| `packages/rpc/src/client/cache.ts` | 自研查询缓存：键=方法名+序列化入参，TTL、失效标签、并发去重 |
| `apps/desktop/src/main/rpc-router/index.ts` | 路由、双向 zod 校验、错误转换、traceId |
| `scripts/__tests__/ipc-contract.test.mjs` | 断言每个注册方法有 schema、output 无凭证字段名；含反例 |

**验收**

- `ipc-contract` 闸门绿；反例（注册无 schema 的方法）被拦。
- **取消**：调用 `sys.ticker` 后 `cancel`，主机端计数器在 200 ms 内停止递增。
- **背压**：客户端每 500 ms 才消费一个 chunk，运行 60 s，主机端 RSS 曲线平稳（增量 < 10 MB）。
- **错误脱敏**：主机端抛出 `new Error('C:\\Users\\x\\secret.epub not found')`，渲染端收到的 `WireError` 中不含该路径，但本地日志中含完整错误与匹配的 `traceId`。
- `module-boundary` 断言：`electron` 只在 `transport/electron.ts` 中出现。

**前置**：M1.1。

---

### M1.4 · 能力网关与媒体协议

**目标**：路径安全与 Range 服务。这是后面全部媒体功能的地基，也是本阶段安全风险最集中的地方。

**交付物**

| 路径 | 内容 |
|---|---|
| `apps/desktop/src/main/capability-gate/roots.ts` | `library_root` 管理（本里程碑先用 JSON 持久化，M1.5 后迁入数据库） |
| `apps/desktop/src/main/capability-gate/resolve.ts` | 六步解析（见规则文档 §4），顺序不可调整 |
| `apps/desktop/src/main/capability-gate/token.ts` | 128-bit 随机 token、session 绑定、TTL 30 min、续期 |
| `apps/desktop/src/main/protocol/media.ts` | `media` 处理器：Range 解析、206、`Content-Range`、`Accept-Ranges`、`ETag` |
| `apps/desktop/src/main/protocol/book.ts` | `book` 处理器：只读，无 Range |
| `apps/desktop/src/main/capability-gate/__tests__/traversal.test.ts` | 攻击用例集 |
| `scripts/fixtures/traversal-cases.mjs` | 用例生成器 |
| `scripts/__tests__/no-direct-fs.test.mjs` | 断言 `capability-gate` 外无 `node:fs`；含反例 |
| `scripts/bench/range-throughput.mjs` | Range 吞吐基准 |

**攻击用例集必须覆盖**

`../` 与 `..\` 及混合、URL 编码与双重编码（`%2e%2e`、`%252e`）、Unicode 规范化变体、Windows 8.3 短名、symlink 与 junction 跨界、UNC 路径（`\\?\`、`\\server\share`）、保留设备名（`CON`/`NUL`/`COM1`…）、超长路径、路径中的 NUL 字节、绝对路径注入、空字符串与 `.`。

**验收**

- **攻击用例 100% 被拒绝**（E1）。
- 2 GB 文件的 Range 请求吞吐 ≥ 400 MB/s（本地 SSD）。
- 协议单请求开销 ≤ 2 ms。
- 过期 token 被拒；A 窗口签发的 token 在 B 窗口不可用。
- `no-direct-fs` 闸门绿。

**前置**：M1.2。

---

### M1.5 · 数据层与迁移

**目标**：可迁移、可备份、崩溃一致的数据库，跑在独立进程里。

**交付物**

| 路径 | 内容 |
|---|---|
| `apps/svc-db/src/index.ts` | utility 进程入口、RPC 端点 |
| `apps/svc-db/src/connection.ts` | 写连接单例、只读连接池、PRAGMA 基线 |
| `packages/data/src/schema/*.ts` | drizzle schema：`library_root`、`file`、`file_path_history`、`archive_entry`、`task` |
| `packages/data/migrations/0001_init.sql` | 首个迁移 |
| `packages/data/migrations.lock.json` | 迁移哈希表 |
| `packages/data/src/migrator.ts` | 自研执行器：`user_version`、单事务、`VACUUM INTO` 备份、保留最近 3 份 |
| `packages/data/src/backup.ts` | Online Backup API 封装 |
| `packages/data/src/repo/*.ts` | 仓储，全部用 `db.prepare()` 预编译语句 |
| `packages/data/src/recovery.ts` | 启动时重置僵尸任务 |
| `scripts/validate-migrations.mjs` | 序号连续、无重复、有回滚说明 |
| `scripts/__tests__/migration-freeze.test.mjs` | 哈希冻结；含反例 |
| `packages/data/__tests__/migration-replay.test.ts` | 重放一致性 |
| `packages/data/__tests__/crash.test.ts` | 1000 次随机 kill |
| `postinstall` 接入 `@electron/rebuild` | native ABI 重编 |

**验收**

- `pnpm test:db`、`pnpm test:migration` 绿。
- **1000 次随机 kill**：`integrity_check` 全 ok、僵尸任务 0、已提交事务丢失 0（E6）。
- 从 `0001` 重放到最新，结构与直接建库一致（E7）。
- 反例：修改已发布的 `0001_init.sql` → `migration-freeze` 拦下。
- `EXPLAIN QUERY PLAN` 检查：`file` 表按 `quick_fp` 与按 `(root_id, rel_path)` 的查询都走索引。

**必须在此里程碑记录的待验证事项**

> **V3 · Electron 打包的 Node 24.18.1 中 `node:sqlite` 是否启用 FTS5。**
> 在 Electron 主进程中执行 `CREATE VIRTUAL TABLE t USING fts5(x)`，记录结论。
> **只记录，不改选型**——本阶段仍用 better-sqlite3。这条结论是风险 R3 回退路径是否成立的依据。

**前置**：M1.3。

---

### M1.6 · vendor-bin 供应链

**目标**：二进制来源可信、可复现、可校验。

**不自行构建 FFmpeg。** 上游 `BtbN/FFmpeg-Builds` 已提供 `win64-lgpl-shared` 变体（明确排除 `libx264` / `libx265`），自建一份不带来收益，只增加维护面。本里程碑做的是**固定与校验**，不是构建。

**本阶段不做自建镜像。** 直接固定上游**月度保留**构建的 URL（上游承诺每月最后一个构建保留两年）。自建镜像推迟到阶段 10。**代价与残留风险见 architecture §22 R10** —— 若上游仓库下线、停供 `lgpl-shared` 变体或改保留策略，`pnpm install` 会直接失败。

**交付物**

| 路径 | 内容 |
|---|---|
| `scripts/vendor-bin.manifest.json` | 上游月度构建的固定 URL、版本、sha256、上游构建标识 |
| `scripts/ensure-vendor-bin.mjs` | 下载、校验、缓存、`--force`；校验失败即删除产物并失败退出 |
| `apps/desktop/src/main/vendor-bin.ts` | 运行时首次调用前二次校验 |
| `scripts/__tests__/vendor-sha256.test.mjs` | 断言 version 变更必须伴随 sha256 变更；**断言 URL 指向月度构建，不得含 `latest` 或日构建标记**；含反例 |

**验收**

- `vendor-sha256` 闸门绿；反例（只改 version 不改 sha256）被拦。
- 反例（把 URL 换成 `latest`）被拦。
- 篡改 `vendor-bin/ffmpeg/ffmpeg.exe` 一个字节 → 应用启动被拒绝并给出可读提示（E8）。
- 落地产物的 `ffmpeg -version` 输出中**不含** `--enable-gpl`、**不含** `libx264`（此断言进闸门）。
- 对应版本的 FFmpeg 源码 tarball URL 已记录在 manifest 中（LGPL 义务的履行凭据，阶段 10 随镜像一并托管）。

**前置**：M1.0。

---

### M1.7 · 闸门全量接线

**目标**：把规范变成机器强制。规则文档写了什么，闸门就必须能拦住什么。

**交付物**

| 路径 | 内容 |
|---|---|
| `apps/desktop/src/main/supervisor/index.ts` | Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）、心跳 5 s / 超时 15 s、退避 1-2-4 s、3 次熔断、`env` 显式构造 |
| `apps/desktop/src/main/logger/index.ts` | 结构化 JSONL、滚动、`traceId` |
| `apps/desktop/src/main/logger/redact.ts` | 脱敏中间件（路径、书名、token、密钥） |
| `packages/ui/src/i18n/` | 三语言目录 + `Messages` 类型推导 |
| `scripts/generate-third-party-notices.mjs` | 从 lockfile 生成声明与 SPDX SBOM |
| `scripts/fixtures/` | 素材生成器骨架（本阶段只需 traversal 与小规模 library） |
| `scripts/bench/` + `docs/bench/` | 基准框架与结果目录 |
| 剩余闸门 | `no-direct-spawn`、`log-redaction`、`third-party-notices`、`network-allowlist`、`i18n-complete`、`no-hardcoded-copy`、`derived-invariant`（占位，阶段 3 补断言）、`offline-e2e`（占位，阶段 9 补 provider） |

**验收**

- `pnpm test:guard` 覆盖全部 16 个闸门（E2）。
- **每个闸门都有反例，且反例确实被拦。** 没有反例的闸门视为未完成。
- `log-redaction`：把含 API Key、绝对路径、书名的样本喂给 logger，输出中无原文。
- Supervisor：杀死一个测试子进程 → 按 1/2/4 s 退避重启，3 次后熔断并上报；主进程 kill 后用 `tasklist` 校验无孤儿子进程。

**前置**：M1.4、M1.5、M1.6。

---

### M1.8 · 发布链路预演

**目标**：走通打包 → 安装 → 升级 → 卸载。

**交付物**

| 路径 | 内容 |
|---|---|
| `scripts/package-desktop.mjs` | 打包、产物哈希、上传 |
| `apps/desktop/installer/` | NSIS 三选项卸载器脚本与文案 |
| `scripts/gen-update-keys.mjs` | Ed25519 密钥对生成（用于更新包完整性校验，私钥不入库） |
| `apps/desktop/src/main/updater/index.ts` | manifest 拉取、语义版本比较（**只接受更高版本**）、断点续传、sha256、Ed25519 校验、交给安装器 |
| `apps/desktop/src/main/updater/sources.ts` | 国内对象存储主源 + GitHub 备源，按序回退 |

**本阶段使用临时密钥对。** M1.8 只是发布链路预演，用一次性密钥即可，公钥编译进主进程、私钥用后即弃，**不做任何正式密钥保管**。正式密钥仪式在阶段 10 前完成。**残留风险见 architecture §22 R13** —— 临时公钥若被带进正式发布，更新链路将失去真实完整性保证。

**验收**

- 全新 Windows 11：安装 → 启动 → 卸载三选项，行为与 [`architecture.md`](../architecture.md) §16.3 一致（E10）。
- `0.0.1 → 0.0.2` 升级后数据保留。
- 尝试 `0.0.2 → 0.0.1` 被拒绝。
- 篡改更新包 → sha256 或 Ed25519 校验失败，不执行安装。
- 安装 stable 与 dev 两版并存，升级 stable 不影响 dev 的数据与安装（E12 的发布侧验证）。

**前置**：M1.7。

---

## 5. 待验证事项在本阶段的处置

| # | 事项 | 处置 |
|---|---|---|
| V3 | Electron 内 `node:sqlite` 是否启用 FTS5 | M1.5 记录结论，写入 ADR |
| V5 | TypeScript 7.0.2 + type-aware ESLint | **M1.0 必须解决**，不解决不继续 |
| V7 | Electron 44.0.0 的破坏性变更 | M1.1 后评估，升级作为独立 PR |
| V1 / V2 / V4 / V6 / V8 | 视频能力矩阵、L2 seek 延迟、JASSUB 许可证链、HEVC 硬解、trigram 索引体积 | **阶段 2**，不在本阶段 |

---

## 6. 本阶段明确不做

写下来是为了防止范围蔓延。以下任何一项出现在阶段 1 的 PR 中都应被打回：

- 任何真实业务功能：不扫描真实媒体库、不解析 EPUB、不读 CBZ、不播放视频、不做 AI。
- 任何界面设计与任何界面实现。渲染进程在本阶段是空白页加一个调试面板。三栏外壳的**结构契约**已在 [`design-rules/app-shell.md`](../design-rules/app-shell.md) 定稿，但**实现在阶段 3（M3.0）**；视觉正本 `design-rules/DESIGN.md` 同样在阶段 3 建立。
- 任何真实的外部数据源。`network-allowlist` 闸门先接线，provider 本身留到阶段 9。
- `sharp`、`@parcel/watcher`、`pdfjs-dist`、`jassub`、CodeMirror、Radix —— 这些依赖在需要它们的阶段才装。**阶段 1 结束时 `package.json` 里不应该有它们。**
- 性能优化。本阶段只建立基准，不优化；唯一的性能门槛是 E5 的窗口可见时间。**注意**：E5 测的是空白页，阶段 3 外壳落地后 webfont 与首屏 CSS 会进入启动路径，届时必须重测并更新基线。

---

## 7. 建议的 PR 切分

每个 PR 独立可评审、独立通过 CI。括号内是对应里程碑。

1. workspace + tsconfig + eslint + prettier + 空包骨架（M1.0）
2. `module-boundary` 闸门 + 反例 + CI workflow（M1.0）—— **必须早于任何业务包有实质代码**
3. TypeScript 7 与 type-aware lint 验证结论 + ADR（M1.0 / V5）
4. forge 配置 + 三入口 vite + 主进程骨架 + 窗口创建函数（M1.1）
5. 启动基准脚本 + 首次基准结果（M1.1）
6. webPreferences + preload 三方法桥（M1.2）
7. Fuses + `fuses-assert` 闸门（M1.2）
8. 两个 scheme 注册 + CSP + `csp-assert` 闸门 + 导航拦截（M1.2）
9. `contract` 的 `method()` 与 `ErrorCode`（M1.3）
10. RPC 帧、取消、信用制背压（M1.3）
11. RPC 路由 + 双向校验 + 错误脱敏 + `ipc-contract` 闸门（M1.3）
12. 客户端查询缓存（M1.3）
13. 能力网关六步解析 + 攻击用例集 + `no-direct-fs` 闸门（M1.4）
14. `media` 协议与 Range + 吞吐基准（M1.4）
15. `book` 协议（M1.4）
16. `svc-db` 进程 + 连接与 PRAGMA（M1.5）
17. drizzle schema + `0001_init` + 迁移执行器（M1.5）
18. 三道迁移闸门 + 反例（M1.5）
19. 崩溃恢复 + 1000 次 kill 测试 + `node:sqlite` FTS5 结论（M1.5）
20. 备份与恢复（M1.5）
21. FFmpeg LGPL 产物与源码镜像到自建存储 + manifest（M1.6）
22. `ensure-vendor-bin` + `vendor-sha256` 闸门 + 运行时校验（M1.6）
23. Supervisor + Job Object（M1.7）
24. logger + 脱敏 + `log-redaction` 闸门（M1.7）
25. i18n 骨架 + `i18n-complete` + `no-hardcoded-copy` 闸门（M1.7）
26. `network-allowlist` + `no-direct-spawn` + `third-party-notices` 闸门（M1.7）
27. 打包脚本 + NSIS 三选项卸载器（M1.8）
28. 更新器 + Ed25519 完整性校验 + 多源回退（M1.8）
29. 阶段 1 验收报告：E1–E11 逐条证据（M1.8）

第 2 个 PR 是关键：**依赖方向闸门必须在任何业务包写出实质代码之前就位**。否则等到有几千行代码时再引入，会得到一份长长的豁免清单，闸门就名存实亡了。
