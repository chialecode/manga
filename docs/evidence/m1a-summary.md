# M1a 阶段总结

| 字段 | 内容 |
| --- | --- |
| 阶段 | M1a：Agent 与可恢复基础配置 |
| 合并 | [PR #2](https://github.com/chialecode/manga/pull/2)，`main` @ `a688713`；上一阶段 `dc925e9`（见 [M0 总结](m0-summary.md)） |
| 归档 | 计划、交付/审查报告与 6 个轮次证据目录留在合并提交中：`https://github.com/chialecode/manga/tree/a688713/docs/evidence`、`.../docs/delivery` |
| 结论 | A 对自动化子集的技术复验于 2026-09-21 收敛；用户同日报告本轮人工审查通过。**产品验收未签字**：AT-49/50/51/55 只有子场景，AT 不据此整条标 passed |

## 1. 交付内容

| 工作包 | 结果（范围均为合成数据与受控本地服务） |
| --- | --- |
| P0 正式工程 | `apps/desktop`（React 19 + Radix + Tailwind + Lucide + Vite + Forge）、`packages/contracts`（Zod 4）、`packages/i18n`、`packages/app-core`；Zod 3 命令信封兼容 |
| P1 授权与生命周期 | 宿主 `ScopeGrant` 取代固定 `scopeHandle`；`agent.send` 默认空 enumerated allowlist；撤销后幂等拒绝；UI Facet 启停与 50 次启停；解析 worker 随模块停用/重建 |
| P2 存储与位置 | schema v1→v2 迁移与备份；better-sqlite3 + Drizzle；CJK 检索在返回前按范围过滤；位置迁移的逐文件所有权、写入屏障与指针原子发布；资料包导入的引用校验、预算、先发布后提交与失败清理；pathHandle-only 的导入导出；Electron `safeStorage` 凭据保险库 |
| P3 Agent 服务 | Chat Completions 与 Responses 两套协议、multipart 转录、流式工具参数重组；`notes.create` 的撤销；取消、重试；PI 0.85.1 与自研 native 双 runtime（设置切换，run 冻结所选 runtime，默认 native） |
| P4 中文界面 | 共享会话、跳过 AI 仍可用库与总览、可取消扫描、迁移“先计划后确认”、材料勾选与授权范围、中断任务回滚入口、`qps-ploc` 伪本地化 |
| P5 验证 | `scripts/verify.mjs`、阶段报告门禁（缺项/失败/旧指纹非零退出）、10,000 元数据 / 50,000 检索块基准、Windows 未签名包的 initial/restart/agent/agent-restart 烟测 |

## 2. 审查问题与关闭情况

A 的集中审查和复验共登记 F-01—F-32；B 自述与 A 复验分开记录，编号只在 A 复验后关闭。

| 范围 | 内容 | 状态 |
| --- | --- | --- |
| F-01—F-20（首轮审查） | 证据指纹不一致、path handle 冒充 credential handle、幂等键换命令返回他人结果、扫描不可取消、资料包丢失 M0 语义、烟测 restart 不同 profile、工具无输入 schema、位置迁移不校验/不 checkpoint、流中断仍执行工具、Agent 授权含写权限、流式重组形态、取消对已结束运行、删除连接残留密文、界面缺口 | 已关闭 |
| F-21—F-23 | Responses 工具格式与 call_id、供应商 body 反射进错误、空 grant 的 `inventory.overview` 泄漏 | 已关闭，各有先失败后通过的回归 |
| F-24—F-25 | 位置迁移：持久逐文件所有权（planned/copying/committed）、回滚只删本任务产物；切换后旧宿主写入屏障、权威库唯一、重叠/重解析目录拒绝、六个阶段的真实子进程退出 | A 于 2026-09-21 复验关闭 |
| F-26 | 幂等回执绑定 actor/session/run/grant，pending 跨 actor 拒绝 | 关闭 |
| F-27 | `agent.send` 立即返回 runId；刷新恢复当前 run 与多轮历史；Electron 内“发送→切副驾驶→停止→重启恢复” | 关闭 |
| F-28、F-29 | 双 runtime 冻结；LLM/Embedding/ASR 独立连接，错用途零网络；合成 WAV 探针；授权文件转录；配置变更清 verified | 关闭 |
| F-30—F-32 | `needsSetup` 来自连接；分区占用/可用状态与修复入口；10k/50k 基准与报告门禁；材料修订快照、同 run 重试不重复提交、预算与 deadline | 关闭 |

## 3. 度量与真实调用（当时版本，不外推）

- 10,000 元数据 / 50,000 块：检索 p95 0.344 ms（n=100）、保存 7.16 ms（n=30）、上下文 0.221 ms（n=30）、进程冷启动 26.7 ms、Electron 可见交互 3 ms（n=3）。不是显示器合成延迟，30 MiB EPUB 首屏未宣称。
- Vitest 94 passed / 4 live skipped；Windows 包四阶段烟测通过，restart 读回 initial 写入的标记笔记。
- 真实 LLM（合成文本、流式、工具参数）、ASR（合成中文 WAV，转写一致）与 Embedding（经应用连接探针取得真实向量）三用途有限短测均 passed，只发送合成内容；Responses 真实端点未测。测试配置在忽略的本地环境文件，不是产品默认。2026-09-20 的一次把 LLM 模型用于转录探测的 HTTP 400 是错误配置，不能用于判断 ASR 可用性（A 已承认并用途检查修正）。

## 4. 用户决定与人工反馈

- 2026-09-20：自研 kernel、一个 Profile 一个 better-sqlite3 写入宿主（ADR-0005/0004 accepted）；首版双 runtime（A-22）；LLM/Embedding/ASR 用不同类型模型（A-27），测试配置读本地环境变量（A-29）；真实资源根仅用于只读本机试验（A-23）。
- 2026-09-20：React 输入界面的中文输入法、键盘、缩放人工检查无误（user-reported passed，未提供测试包哈希或逐档步骤）。
- 2026-09-21：本轮人工审查通过；授权推送 M0/M1a 分支并创建 PR。反馈只覆盖当时交付的界面与行为。
- 构建：pnpm 11 采用 `nodeLinker: hoisted`；`@electron/rebuild` override；本机有 Visual Studio，打包走独立暂存目录 rebuild 与 ABI/asar 核验。

## 5. 已知限制与去向

| 限制 | 去向 |
| --- | --- |
| 迁移后须重启才能打开权威库；独立分区改址仍 `CAPABILITY_UNAVAILABLE` | 事项总表 / 后续阶段 |
| 无 WebSocket 订阅，UI 轮询 `getRun` | 保持 |
| 无报价时不写 0 费用，费用限制不生效 | 保持 |
| 完整向量索引属 SEARCH-02；桌面不导入 `.env.local` | 后续阶段 |
| 长录音筛选、音频保留、分段回顾、跨媒介映射（VOICE-06—08，AT-57—59） | M2（已并入） |
| Q-08 最终视觉 | [用户待办 Q-08](../../USER-ACTIONS.md#q-08) |

## 6. 清理记录（M2 的 C1—C3）

| 项 | 内容 |
| --- | --- |
| 已删除的文档 | `docs/delivery/m1a-execution-plan.md`、`m1a-cursor-prompt.md`；`docs/evidence/m1a-delivery.md`、`m1a-acceptance-review.md`、`m1a-f24-f32-review.md`（上文已提炼） |
| 已删除的证据目录 | `m1a-a-reverify`、`m1a-acceptance`、`m1a-asr-siliconflow`、`m1a-f24-f32`（含 `a-reverify*`、`b-rework`、`a-publish-embedding`）、`m1a-model-routing`、`m1a-review`；其中 live-api.json 只含时间、样本格式/哈希与请求次数 |
| 已删除的脚本 | `audit-m1a-reverify.mjs`（四项反例已由 `tests/runtime/location-ownership-idempotency.test.ts`、`location-switch-recovery.test.ts` 覆盖）、`bench-m1a*.mjs`、`m1a*.mjs`、`m1a-required-cases.json`、`package-m1a.mjs`、`verify-m1a.mjs`（由通用的 `scripts/stage.mjs` 与 `scripts/stages/<阶段>.json` 取代）、`ensure-electron-sqlite.mjs`（由 `verify-electron-sqlite.mjs` 取代） |
| 保留并改名 | `scripts/m1a-live.mjs` → `scripts/live-models.mjs`；`tests/m1a/*` → 按能力命名的测试，映射见 [M1b 总结](m1b-summary.md#迁移映射) |
| 提炼去向 | 授权/幂等/位置语义 → 领域模型与数据安全规则；决定 → 确认记录与 ADR；验收子集 → 路线；开放项 → 事项总表 |
| 归档提交 | `a688713`（`git merge-base --is-ancestor a688713 origin/main` 为真） |
