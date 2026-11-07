# M1a 执行交付（B → A）

日期：2026-09-19（B 交付）/ 2026-09-20（A 集中审查）。本文件是 Agent B 对 [M1a 执行计划](../delivery/m1a-execution-plan.md) 的交接报告，并在第 5 节记录 Agent A 的集中审查结论与已并入同一交付 commit 的修复；不覆盖 M0 历史证据，也不把自动检查写成产品验收。

| 字段 | 内容 |
| --- | --- |
| 执行范围 | 计划 2026-09-19；P0—P5 连续实现。未把 AT-49/50/51/55 整条标为 passed，只报告已测子场景 |
| 版本与工作区 | 分支 `feat/m1a-agent-foundation`；基线 `a33b115`（M0 复核，整体未验收）；前置未合并 `feat/m0-tech-contract-validation`。交付 commit 见最终聊天，报告不回写自身哈希。未授权 push/PR |
| 源码指纹 | `sourceFingerprint` `8548050379e87b7b6390b18d8727c19ed679c6c93f8e61afa6f13b0e99303dc0`；`m1aSourceFingerprint` `f12562c5ef2fe19997427e2189ce766b53cf089b3fc21a790d1bed2af4ac1bf5`（A 审查修复后的最终源码；与 [package.json](m1a-review/package.json)、[bench.json](m1a-review/bench.json)、[test-run.json](m1a-review/test-run.json) 一致） |
| 可运行产物 | `pnpm install` 后 `pnpm --filter @manga/desktop start`。Windows 未签名本地包：`node scripts/m1a.mjs package` → `dist/m1a-package/MANGA-win32-x64/`（gitignored）。烟测 `MANGA.exe --m1a-smoke` |
| 未提交/生成物归属 | `dist/`、`apps/desktop/.vite/`、`node_modules/` 为本地生成，不入库。公开证据在 `docs/evidence/m1a-review/` |
| 实际 push/PR | 未执行 |
| 关键变更与恢复 | 宿主 `ScopeGrant` 取代固定 `scopeHandle="library"`。`agent.send` 默认 enumerated 空 allowlist，不再把全库资源写入任务授权；资料包导入/导出与位置迁移只接受宿主 `pathHandle`。停用只杀死解析 worker，重新启用再创建。位置 `apply` 成功后更新 pointer；不可写启动仍可通过选目录写入 pointer。凭据经 `stashSecret` + vault 密文。打包 worker 外置于 `resources/parse-worker.cjs` |

> 最新判断：本页原工作包与第 5 节记录上一轮审查；2026-09-20 [最新验收审查](m1a-acceptance-review.md)发现新的数据、权限、界面及验证缺口，M1a 尚未通过。当前代码/证据以新报告为准；不继续采用“只剩用户人工项”的结论。

## 工作包映射

| 工作包 / 用例 | 实现位置 | 实际命令与证据 | 状态、限制及剩余责任 |
| --- | --- | --- | --- |
| P0 正式工程 | `apps/desktop` React/Radix/Tailwind/Lucide/Vite/Forge 7.11.2；`packages/contracts` Zod 4.1.5；`packages/i18n`；`packages/app-core` | `node scripts/m1a.mjs test` 32/32 passed；`tests/m1a/p0-*.test.ts(x)` 含 Zod 3 信封兼容、Testing Library、playwright-core 接线 | 已实现。playwright-core 只断言 API/可执行路径，未下载浏览器做页面自动化。Tiptap/CodeMirror 未装。原生输入法短测待用户 |
| P1 授权与生命周期 | `packages/app-core/src/grants.ts`、`product-app.ts`；kernel `RuntimeOptions` | `tests/m1a/p1-grants.test.ts`：空 enumerated 越权 `SCOPE_DENIED`、`agent.send` 省略读列表时任务 grant 为空且 `getResource` 拒绝、撤销后幂等拒绝、UI Facet 启停、50 次启停、UI 与 Agent 同 `notes.create`、停用后晚到 `notes.update` 为 `CAPABILITY_UNAVAILABLE`、worker 停用后 pid 消失并在重新启用后重建 | 已实现子集。对应 POC-04/07、AT-11/14/36/37/44/48 **子场景**，不是整条 AT。ADR-0004/0005 仍 proposed，未代签 accepted |
| P2 存储与位置 | `packages/storage-drizzle`；`locations.ts`；`library-package.ts`；`ElectronSafeStorageVault` | `tests/m1a/p2-storage.test.ts`：v1→v2、schema 过新 `API_INCOMPATIBLE`、CJK 范围过滤、子进程 `crash-at=publish`/`location-copy` 退出码 99 且 pointer 不切换、pathHandle 导出/迁移、第二宿主冲突、测试通道 pointer/documents 落在临时 profile。打包 `nativeModuleUnpacked: true`，Electron 37.4.0 ABI 136 prebuild | 已实现子集。POC-06、AT-17/18/21/35/48/51 子场景。本机无 Visual Studio/`node-gyp`，Forge `onlyModules` 跳过 rebuild，改用 `scripts/ensure-electron-sqlite.mjs`。真实用户库迁移需授权 |
| P3 Agent 服务 | `packages/model-protocol`（pi-ai **0.85.1**，计划中的 0.52.7 不存在）；`product-app` Agent 循环 | `tests/m1a/p3-agent.test.ts`：Chat Completions/Responses、multipart 转录、流式工具参数、401/429、前缀不重复 `/v1`、Agent `notes.create` 后可 `notes.undo`、`agent.retry`、取消为 `CANCELLED`。本地 mock HTTP，无真实 API key | 已实现子集。AT-09/10/11/12/13/44/49/50 子场景。真实兼容端点 not-run。pi-ai 0.85.1 已安装但未接入调用路径（见 F-08） |
| P4 中文界面 | `apps/desktop/src/renderer/App.tsx`；i18n catalogs | `tests/m1a/p4-ui-service.test.ts`：共享会话、跳过 AI、可取消扫描、`qps-ploc`、导入/保存连接/重试/选目录键。A 审查补齐：迁移先展示计划再确认、材料勾选与授权范围计数、运行状态/授权句柄、中断任务回滚入口。截图 [ui-smoke-initial.png](m1a-review/ui-smoke-initial.png)、[ui-smoke-initial-library.png](m1a-review/ui-smoke-initial-library.png)、[ui-smoke-restart.png](m1a-review/ui-smoke-restart.png) | 已实现子集。AT-49/50/51/55 子场景。设置页含本机绝对路径，**不**把该截图写入仓库。键盘/焦点/缩放/原生输入法短测待用户。Q-08 未定稿 |
| P5 验证 | `scripts/verify.mjs`、`scripts/m1a.mjs`、`scripts/package-m1a.mjs`、`scripts/verify-m1a.mjs`、`scripts/bench-m1a.mjs`；`tests/m1a/p5-faults.test.ts`、`tests/m1a/a-review.test.ts` | 见第 3 节命令。包烟测 initial/restart passed。检索 p95 **0.28 ms**（n=100，200 条资源）、保存 **0.79 ms**（n=1，最终跑次），低于 500/1000 ms 服务侧目标 | 自动部分已接线。不是 10,000 元数据/50,000 块；不是显示器绘制延迟；30 MiB EPUB 首屏不宣称。恶意未闭合 JSON、缺能力、断线、超时不执行 `notes.create` |

## 检查命令

在仓库根、Node.js 24.19.0、pnpm 11.24.0。`M1A_EVIDENCE_DIR=docs/evidence/m1a-review`。

| 命令 | 退出 | 说明 |
| --- | --- | --- |
| `node scripts/m1a.mjs test` | 0 | Vitest 10 files / 43 tests passed（含 `tests/m1a/a-review.test.ts` 11 条审查回归） |
| `node scripts/m1a.mjs package` | 0 | Forge 未签名包 + `--m1a-smoke` initial/restart 共用同一 profile，restart 阶段必须读回 initial 写入的标记笔记（`markerRestored: true`）；worker 与 better-sqlite3 已解包/外置 |
| `node scripts/m1a.mjs bench` | 0 | 服务侧检索/保存抽样 |
| `node scripts/verify-m1a.mjs` | 见最终跑次 | 重跑 Vitest 并写 `docs/evidence/m1a-review/test-run.json` |
| `node scripts/verify.mjs` | 见最终跑次 | 文档/公开内容/依赖/tsc/Vitest/M0 契约回归 |

M0 回归文件仍由 `verify.mjs` 运行，实验目录未删除。

## 阶段判断

- **M0 整体退出**：仍 blocked（新栈产品验收、人工项、运行时/宿主定稿未齐）。
- **M1a 基础门槛**：本地可自动的 P0—P5 已实现；B 自审修复（空 allowlist 默认授权、worker 停用、pathHandle-only、不可写选目录、弱断言）与 A 集中审查修复（第 5 节 F-01—F-17）均已并入同一交付 commit。A 对自动化子集的技术审查结论为通过；**本报告不是进入验证或产品验收签字。**
- **M1a 产品验收**：未签字。不得以本交付、截图或门禁通过代替 AT 整条 passed。

2026-09-20 按用户授权整理初始化历史并同步 Git 规则后，M0 基线由 `3fcdbfc` 衔接为 `a33b115`；上述当前依赖引用已同步。M0/M1a 实现和既有机器测试证据保持原内容，本次历史整理不代表重新执行设备或产品验收。远端 `main` 的初始化内容和 Git 审查规则已合并为单一提交 `4f9306a`，只保留原初始化提交消息；原 main 保护配置已恢复，M0 与 M1a 均未推送。

## 修复与回归（相对 M0 基线 `a33b115`）

- 指定修订 `contextSnapshot`、码点选区、单块 `notes.update`、资料包校验/回滚语义在 `app-core` 接续，并由 M0 `experiments/m0` 回归继续守护。
- 解析 worker：CJS 无 top-level await；打包路径不依赖 asar 内 `spawn`。
- 凭据：UI `stashSecret` 只进内存 Map，upsert 后密文入库；禁止把 API key 写入 `path_handles`。
- pnpm 11：`nodeLinker: hoisted`（Forge 需要）；`@electron/rebuild` override `4.2.0`；allowBuilds 含 esbuild/better-sqlite3/electron/tailwind oxide 等。

## 4. 用户决定落实与当前待办

2026-09-20 用户已回复原九项清单；运行时/宿主、React 短测、API、本地资源、Git 时机、临时视觉、Visual Studio、双 runtime 与残留指针状态均在 [最新验收报告第 1 节](m1a-acceptance-review.md#1-已生效决定与本地准备)落实，已解决项不再列为待批。

当前无新增实现阻塞需用户决定。Embedding 真实探针因 `MANGA_TEST_EMBEDDING_*` 未配置保持 not-run；VOICE-06—08 属于 M1b/M2。F-24—F-32 已由 B 实现并自检，编号须经 A 复验后才能关闭。不开始 M1b，不执行远端操作。下节保留上一轮历史结论。

## 5. A 集中审查（2026-09-20）

审查基线：交付 commit `c7b7670` 相对 M0 `a33b115`；按 [评审口径](../../REVIEW.md) 与 [Agent 交接](../dev-rules/development-workflow.md#agent-handoff)执行。A 直接修复了可本地判定的问题并补充回归，全部并入同一交付 commit（amend），未推送。修复后的源码指纹见本页第 1 节；`package.json`、`bench.json`、`test-run.json` 均在最终源码上重新生成。

| 编号 | 发现 | 处置与证据 |
| --- | --- | --- |
| F-01 | B 报告中的指纹与交付 commit 源码不一致（证据生成于最后一次 amend 之前） | 所有证据在最终源码重生成；指纹三份一致，见第 1 节 |
| F-02 | path handle 可被当作 credential handle 传入 `connections.upsert` | `upsertConnection` 只接受 `stashSecret` 句柄；`a-review` P1 用例：`FORBIDDEN` 且 `credentials` 为 0 行 |
| F-03 | 同一幂等键换命令/输入时返回他人结果 | 幂等复用校验 `command_id`/`input_hash`，不一致为 `VALIDATION_ERROR` |
| F-04 | `inventory.scan` 同步执行不可取消；`moduleEnabled \|\| true` 使停用无效 | 扫描按批 `setImmediate` 让出并检查 abort；`moduleEnabled` 取自 UI Facet；用例：扫描中取消返回 `cancelled: true`，随后 overview 为 `false` |
| F-05 | 资料包导入丢失 M0 语义：不重建索引、不校验引用、缺表、无预算、暂存/孤儿只“识别” | `library-package.ts` 重写：引用校验、清单/附件预算、全部表写入、`pkg-body-*`/`pkg-note-*` 索引重建（含 noteScopes）、先发布硬链接再提交、失败清理自有链接；`settings.recoverJobs` 回滚孤儿；往返用例检索按授权过滤 |
| F-06 | 包烟测 restart 使用不同 profile，未证明持久化；两张截图相同 | 两阶段共用 profile，initial 写标记笔记、restart 必须读回；两张截图仍相同属预期（同一页面同一状态），保留 |
| F-07 | 工具定义无输入 schema（`additionalProperties: true`） | `commandInputJsonSchema` 由 Zod 生成；用例断言 `notes.create` 必填 `title/text` 且不允许额外字段 |
| F-08 | pi-ai 0.85.1 无 `complete/streamSimple/generate` 导出，`completeWithPiAi` 是死代码 | 删除死 shim，保留协议路由并注明；接入方式列入第 4 节待用户决定 |
| F-11 | 位置迁移不校验目标与检查点一致、不做 WAL checkpoint、不核对复制结果、连带复制锁/WAL 文件 | `applyLocations` 校验 `targetRoot`、预检目标为空、`wal_checkpoint(TRUNCATE)`、逐分区指纹比对并写回 `verified`；`copyPartition`/`fingerprintTree` 跳过瞬态文件；用例：错误目标拒绝、迁移根无 WRITE_LOCK/-wal/-shm、重开可见笔记 |
| F-14 | 流在 provider 完成前中断时仍执行工具 | 未收到完成事件抛 `PROVIDER_UNAVAILABLE`（retryable）；mock 新增 `truncated-stream`；用例：0 条笔记、run 为 `failed` |
| F-16 | Agent 任务 grant 对读集合附带写权限 | `issueAgentGrant` 写集合为空；用例：Agent 对用户笔记 `notes.undo` 得 `SCOPE_DENIED` |
| F-17 | 流式工具调用重组不符合真实分片形态（Chat 只在首块带 id/name，Responses 用 `output_item.added` + `item_id`） | 适配器按 `index`/`item_id` 归并；mock 改为真实形态；用例两种协议均重组为 `call_1`/`library.find` 且参数可解析 |
| F-18 | `agent.cancel` 对已结束运行无条件改状态 | 只更新 queued/running/waiting_input；用例：已成功运行取消返回 `false` 且状态不变 |
| F-19 | 删除连接残留凭据密文 | `connections.delete` 同时删除 `credentials` 行并返回 `credentialRemoved` |
| F-20 | 界面缺口：迁移无计划确认直接执行；无材料选择与授权范围展示；无中断任务入口 | `App.tsx` 增加迁移计划/确认/放弃、材料勾选与 `readResourceIds` 传递、运行状态与授权句柄、`RecoveryJobs` 回滚；`settings.get` 返回 `recoveryJobs` |

未编号缺口（F-09/10/12/13/15）在复核中确认为误报或已被上表修复覆盖，不单列。

审查结论：实现完整性——计划 P0—P5 的本地自动子集齐全；技术审查——通过（tsc、Vitest 43 条、包烟测含持久化、`verify.mjs` 全部通过）；产品验收——未签字，AT-49/50/51/55 仍只有子场景，人工项见第 4 节。

## 6. 最新 A 验收接续（2026-09-20）

起点 62fd4ed；新结论与稳定问题编号在 [最新验收审查](m1a-acceptance-review.md)，不覆盖历史机器报告。A 修复 Responses 输入、公共错误脱敏、Agent 总览授权过滤，并止损位置回滚误删；新增 5 条回归全部先失败后通过。benchmark 的 Documents/指针也已隔离到临时目录。完整阶段仍未通过。

## 7. B 集中返工 F-24—F-32（2026-09-20）

本轮为未 push 的同一交付续作，基点 `fbfaf95`。保留 F-21—F-23 与 F-24 止损。VOICE-06—08 未纳入。下表是 **B 自检**，不是 A 复验或产品验收。

| 编号 | 实现要点 | 失败场景与测试 | 限制 |
| --- | --- | --- | --- |
| F-24 | `migration_owned_files` planned/copying/committed；回滚只删本任务产物；无所有权或与活动 Profile 冲突标 needs-review | `tests/m1a/f24-f32.test.ts`、`acceptance-review.test.ts` 预存文件保留 | 不自动清理冲突/用户原件 |
| F-25 | 目标库先标 succeeded，原子 pointer，旧宿主 `RESTART_REQUIRED`；拒绝重叠/重解析路径；crash `location-switch` | `f24-f32` 写入屏障、子进程退出；`a-review` 指纹与锁文件 | 切换后须重启打开权威库 |
| F-26 | 幂等绑定 actor/session/run/grant 指纹；pending 跨 actor 拒绝 | `f24-f32` 跨 actor 回放与 in-flight | 旧回执缺 actor 列时按当前 grant 再校验范围 |
| F-27 | `agent.send` 立即返回 runId；UI 轮询 `getRun`；停止使用当前任务 ID | `p3-agent`/`f24-f32` waitForRun；App 轮询 | 无 WebSocket 订阅 |
| F-28 | 实际导入 PI 0.85.1；设置切换；run 冻结 runtime；默认 native | `f24-f32` runtime 冻结；native 对 mock 完成 | PI 与本地 mock 不完全同构时以冻结字段为准 |
| F-29 | LLM/Embedding/ASR 独立连接；合成 WAV 探针；授权文件转录；upsert 清 verified | `model-routing` 错配零网络；`f24-f32` 嵌入/转录 | 完整向量索引仍属 SEARCH-02；桌面不导入 `.env.local` |
| F-30 | `needsSetup` 来自连接/跳过 AI；分区展示；字节与可用状态；仅索引根；reveal | `f24-f32`、`p4-ui-service` | 不把外部根当迁移目标，不自动上传原件 |
| F-31 | 10k 元数据 / 50k 检索块 bench；`scripts/m1a-report.mjs` 拒绝缺项/失败/旧指纹 | `scripts/m1a-report.test.mjs`；独立 `M1A_EVIDENCE_DIR` | 不是显示器绘制延迟；不覆盖历史证据目录 |
| F-32 | 材料修订快照、同 runId 重试、工具键 `runId:command:inputHash`、上下文/输出/时长预算、不伪造费用 | `f24-f32` 快照/重试/步数耗尽 | 无报价时费用限制不生效 |

独立证据目录 [m1a-f24-f32](m1a-f24-f32/)（不覆盖 `docs/evidence/m1a-review/` 与 `m1a-acceptance/`）：`sourceFingerprint` `566435d6e00daf8dec45a27ef44050bea8bef9511c20a1188445d7e6963e15a3`，`m1aSourceFingerprint` `2f24544d0e2caa946ba1d5d8b8cf9756c6b89ea5023975c1882e0c74025747b5`。10k/50k 检索 p95 与保存/冷启动见 [bench.json](m1a-f24-f32/bench.json)；Windows 包 initial/restart 见 [package.json](m1a-f24-f32/package.json)。`node scripts/verify.mjs` 退出 0：86 份文档、640 个本地链接、依赖边界、两套 tsc、13 个 Vitest 文件 67 passed / 4 live skipped、15 条 M0 回归。最终交付 commit 见交接消息，本报告不回写自身哈希。

## 8. B → A 交接

| 字段 | 内容 |
| --- | --- |
| 执行范围 | 计划 2026-09-19；本轮只补 [验收审查](m1a-acceptance-review.md) F-24—F-32。保留 F-21—F-23 与 F-24 止损。未把 AT 整条标 passed，未纳入 VOICE-06—08 |
| 版本与工作区 | 分支 `feat/m1a-agent-foundation`；amend 前基点 `fbfaf95`；前置未合并 `feat/m0-tech-contract-validation` @ `a33b115`。无 upstream，未 push/PR |
| 可运行产物 | `pnpm --filter @manga/desktop start`；独立包证据见 [package.json](m1a-f24-f32/package.json) |
| 关键变更与恢复 | 逐文件迁移所有权；切换后旧宿主写屏障；幂等绑定 actor/session/run/grant；`agent.send` 立即返回 runId；native/PI 双 runtime 冻结于 run；LLM/Embedding/ASR 用途隔离；授权文件转录；`needsSetup` 来自连接而非 workspace；10k/50k 报告门禁；同 runId 重试与材料快照 |
| 待用户处理 | 无本轮实现阻塞。Embedding 配置缺省则真实向量探针 not-run。push/PR/合并需用户明确授权 |

下一步必须交给 Agent A 复验；B 自检不是 A 审核，也不是产品验收通过。

## 9. A 集中复验回交（2026-09-21）

第 7–8 节保留为 B 自检原记录。A 的独立复验与局部修复见 [F-24—F-32 复验报告](m1a-f24-f32-review.md)：F-26、F-28、F-29 在本轮范围关闭，F-24、F-25、F-27、F-30、F-31、F-32 仍需 B 补差异；实际权威库重启和断线后重试重复副作用反例仍失败。新证据位于 `docs/evidence/m1a-f24-f32/a-reverify/`，根级 B 跑次保持原指纹。技术报告不通过，不是产品验收通过；禁止据原提交消息的 close 字样推导全部编号已关闭。

## 10. B 按 A 差异返工（2026-09-21）

本轮从 `feat/m1a-agent-foundation` @ `7bf6936` 连续补 F-24、F-25、F-27、F-30、F-31、F-32。保留 F-21—F-23、F-26、F-28、F-29 与 F-24 止损。下表是 **B 自检**，不是 A 复验或产品验收。

| 编号 | 实现要点 | 失败场景与测试 | 限制 |
| --- | --- | --- | --- |
| F-24 | `recover` 从 planned/copying/committed 续拷；copying 中的本任务文件可删后重拷；完成后 `publishRelocatedLibrary`；设置页有恢复入口 | `f24-f32` 中断复制后续作；crash `location-copy` | 冲突/外源文件仍 needs-review，不自动覆盖 |
| F-25 | `resolveLaunchLayout` 先读 marker/`relocatedRoot` 再写 pointer；显式旧 Profile 重启打开已发布库；copy/verify/publish/commit/pointer/switch 子进程退出 | `f24-f32` 权威库重启与全阶段 crash；`audit-m1a-reverify.mjs` | 指针发布失败后需重启或 recover 完成 rename |
| F-27 | App 刷新恢复当前 run 与多轮 input/messages；Electron 慢提供者：发送→副驾驶→停止→重启恢复，并撤销模块入口 | `f27-app.test.tsx`、包烟测 `agent`/`agent-restart` | 无 WebSocket；截图不能单独代替该流程 |
| F-30 | `settings.setLayout` 保存 pointer 并重定向旧指针；独立分区仍 `CAPABILITY_UNAVAILABLE`；扫描逐批可取消；overview 用 `partition_stats`；缺失可 `inventory.repair` | `f24-f32` pointer/scan/repair | 独立分区改址仍未实现 |
| F-31 | 保留 10k/50k；真实进程冷启动、保存 n≥10、上下文、检索原始样本、Electron 可见交互；报告拒绝缺字段/非 process/非 electron | `m1a-report.test.mjs`、`bench-m1a.mjs` | 不是显示器合成延迟；30 MiB EPUB 首屏不宣称 |
| F-32 | 持久消息/工具回执/截止点/冻结历史与连接；断线后同 run 重试即使用不同参数也不再执行第二次 `notes.create` | `f24-f32` 断线反例；`audit-m1a-reverify.mjs` | 同一 run 内同名命令复用首次已执行回执；无报价仍不写 0 费用 |

独立证据目录 [m1a-f24-f32/b-rework](m1a-f24-f32/b-rework/)，不覆盖根级 B 跑次或 A `a-reverify/`。本轮指纹：`sourceFingerprint` `78276083685baf9dcab69febe355ca18f4e46b773dbe2e4a1ebb5b5304842782`，`m1aSourceFingerprint` `cd4e568b2c5bbc57a3474e4699d8d2ac48796be1b85aee05c1cb325ee5c84cb2`。Vitest 94 passed / 4 live skipped；`audit-m1a-reverify.mjs` 四项 passed；Windows 包 initial/restart/agent/agent-restart passed；bench 10k/50k，检索 p95 0.344 ms（n=100）、保存 7.16 ms（n=30）、上下文 0.221 ms（n=30）、进程冷启动 26.7 ms（n=5, kind=process）、Electron 可见交互 3 ms（n=3, kind=electron）。真实 LLM completion/stream 与 ASR 合成 WAV 短测 passed，Embedding 未配置 not-run。统一入口与 `M1A_REQUIRE_REPORT=1` 的 `verify-m1a.mjs` 以该目录 `test-run.json` 为准。未 push/PR/合并；B 自检不是 A 复验或产品验收。

## 11. A 复验（2026-09-21，`6d377bb`）

第 10 节保留为 B 自检原记录。本节记录 A 的独立结果：F-24、F-25、F-27、F-30、F-31、F-32 技术缺口均已复验关闭；F-21—F-23、F-26、F-28、F-29 保持已关闭。新跑次位于 `m1a-f24-f32/a-reverify-6d377bb/`，不覆盖任何历史跑次。`verify.mjs`、显式 `M1A_REQUIRE_REPORT=1 node scripts/verify-m1a.mjs`、`audit-m1a-reverify.mjs`、Vitest、Windows Electron 四阶段烟测与 10k/50k 基准均按 A 报告记录通过；真实 LLM/ASR 短测通过，Embedding 未配置而 not-run。技术复验收敛不等于 M1a 产品验收通过；本轮不执行远端操作。

## 12. 人工审查与真实 Embedding 补测（2026-09-21）

用户报告本轮人工审查通过，补充独立 Embedding 本地测试配置，并授权推送 M0/M1a 分支及创建 PR。A 修正了旧 live 用例只检查配置的不足，经应用连接探针完成真实 Embedding 向量验证；当前 LLM/ASR/Embedding 三用途短测均通过。新证据在 [a-publish-embedding](m1a-f24-f32/a-publish-embedding/)，版本与检查口径见 [A 报告第 6 节](m1a-f24-f32-review.md#6-人工确认embedding-补测与推送准备2026-09-21)。人工反馈只覆盖本轮已交付界面与行为，不扩展为未执行 AT、后续语音/媒体或 M0 整体退出；未授权合并/发布。
