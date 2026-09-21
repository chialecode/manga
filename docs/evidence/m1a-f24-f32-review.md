# M1a F-24—F-32：Agent A 集中复验

日期：2026-09-21。审查起点为 `feat/m1a-agent-foundation` @ `11d0059`（B amend 前基点 `fbfaf95`）；前置仍是未合并的 `feat/m0-tech-contract-validation` @ `a33b115`。仅复验 F-24—F-32，不从 M0 重开，也不纳入 VOICE-06—08 / AT-57—59。

当前接续：第 1–4 节为历史失败复验，第 5 节为 `6d377bb` 上的 A 复验；人工反馈、Embedding 实测和推送前验证见第 6 节，DCO 与远端合并交接见第 7 节。历史状态不回写成当时已通过。

**技术审查未收敛：F-26、F-28、F-29 在本轮定义范围内关闭；F-24、F-25、F-27、F-30、F-31、F-32 仍未关闭。M1a 产品验收未通过，不推荐 push、PR、合并或进入 M1b。** B 交付报告第 7–8 节仍是 B 当时自检，不能改写成 A 审核结果。

## 1. 版本、现场与证据

开始时工作区已有未提交的 `product-app.ts`、`library-package.ts`、PI/mock 适配、报告脚本、`a-reverify.test.ts`、真实探针脚本及 `m1a-a-reverify/` 结果。它们属于本轮 F 编号的复验范围，保留后逐项检查；本报告不将这些预存结果冒充本轮新执行。最终局部修复和文档同步按同一交付 amend，最终 SHA 以包含本报告的提交及交接消息为准。无 upstream，无远端分支引用包含原提交；本轮没有 push、PR 或合并。

新执行结果在 [独立复验证据](m1a-f24-f32/a-reverify/)；B 的 `m1a-f24-f32/` 根级结果保留其原指纹。`m1a-review/`、`m1a-acceptance/`、`m1a-model-routing/`、`m1a-asr-siliconflow/` 均未覆盖。

最终源码指纹：

- `sourceFingerprint`：`1c8a204d83fe6b8b72809aafc8ff0159d9f473e3dbdd246035a9ad93b1642d6c`。
- `m1aSourceFingerprint`：`9d4ac3bc85a2bb44e5bfe7e5353be63737651733900f38855fb66a8a840b1778`。

本轮保留 F-21 Responses 工具定义及 `function_call_output`、F-22 公共错误不回显供应商 body、F-23 授权过滤及 F-24 既有文件保护；`tests/m1a/acceptance-review.test.ts` 与 `tests/m1a/model-routing.test.ts` 原回归均未修改。

## 2. 逐项技术结论

| 编号 | A 复验结果与已修部分 | 尚缺的关闭条件 |
| --- | --- | --- |
| F-24 | **保留止损，完整恢复未关闭**。已复验逐文件 planned/copying/committed 记录、仅提案不删除预存文件及活动库保护。本轮独立反例复现了同名复制覆盖、回滚删除替换文件；现用排他复制，committed 记录文件身份及内容指纹，回滚核对目标范围、实际路径、活动库和所有权。copying、旧格式指纹或发生替换的文件保留并标 needs-review | `recoverOrRollback(action="recover")` 仍只改标 needs-review；没有续作或可完成的冲突处理流程。B 补足复制中断后恢复/放弃的明确状态转换和可操作入口，不能把不删除误写成完整恢复完成 |
| F-25 | **未关闭，P1**。目标库先 succeeded、指针临时文件 fsync 后 rename、同实例写入屏障已验证；旧实例新建检查点/回滚被拒，运行在迁移前转 interrupted。受控屏障复现的晚到解析写入已补提交前检查 | [audit.json](m1a-f24-f32/a-reverify/audit.json) 仍复现：迁移后以原显式 Profile 参数重启，构造器先重新发布旧根指针，未消费 `relocatedRoot` 作为宿主准入条件，旧库仍可写。B 统一启动定位、目标锁、宿主写入准入及权威库判定；覆盖 pointer 失败和 copy/verify/publish/commit/switch 全阶段真实子进程退出。不能只在一个业务命令补布尔判断 |
| F-26 | **本轮关闭**。跨 actor completed/pending 均拒绝；新增同 actor 不同 session/run（包含原记录没有任务身份）、旧回执缺可信身份、权限缩小和撤销的测试。本轮补严格任务比较、缺身份旧回执拒绝及 pending 完成后的当前授权复核。允许已授权的笔记对象回执适应同一 run 创建对象后扩大的集合 | 这是命令回执与当前范围的技术结论；不等于 F-32 的恢复执行日志已完成。只读总览没有持久回执，复用 key 时重新按当前授权过滤，未将其误报为缓存泄漏 |
| F-27 | **未关闭，P1**。send 立即回 runId、服务取消、关闭/重启中断恢复及同 run 重试通过；关闭后晚到 Promise 不再访问已关闭数据库 | `App.refresh` 只恢复 sessionId，不恢复运行；`SessionList` 只选该会话第一条 run，`AgentPane` 不展示完整用户输入/多轮历史，流式文字在完成前未落地给 getRun。B 补实际 App/Electron 慢提供者：发送→副驾驶→停止→重启恢复及模块入口撤销，不用服务断言代替完整流程 |
| F-28 | **本轮关闭**。实际 PI 0.85.1 与 native 调用链、两种协议工具 schema、Responses call_id 回执与真实业务工具、本地 401/429/断线错误映射通过。修复 PI 工具 schema 丢失、Responses 身份映射和历史 assistant 消息被改成 user。验证默认 native、切换持久化、run 内冻结及两套 runtime 的会话历史 | 不把本地协议覆盖解释为任意真实服务均兼容；真实端点短测仍按下面的有限用途范围 |
| F-29 | **本轮关闭**。独立 LLM/Embedding/ASR 连接、错配联网前拒绝、授权 WAV 文件转录、保存清除旧能力、密钥引用删除、工具/流终结条件通过。新增空向量响应反例，现只有有效有限数值向量才能标记 Embedding 能力。普通测试不加载 `.env.local` | 真实 Embedding 未配置，not-run；真实 ASR 仅合成文件协议短测，非真实录音或识别准确率验收。向量索引及后续录音范围不属于本轮 |
| F-30 | **未关闭，P1**。needsSetup、跳过 AI、payload/文件字节、仅索引根保留原件和 reveal 服务有实测。修正仅索引迁移记录为旧 source，且记录随目标数据库保存；拒绝不完整的分区计划，避免重启丢配置 | UI 仍仅展示分区/指针并整体迁移；独立分区迁移明确返回 CAPABILITY_UNAVAILABLE。`directoryStats` 单根递归同步，扫描只在根之间让出事件循环；总览也同步递归 backup/cache。B 补分区/指针持久配置、可取消的逐批扫描和准确位置/缺失/修复流程 |
| F-31 | **未关闭，P1**。实际 10,000/50,000 服务基准和新 Windows 包已重跑。cases 从 Vitest 执行结果生成；缺项、失败、无关测试、缺失/旧 M1a 指纹及独立 A 审计失败均被报告拒绝 | bench 仍只有服务检索、单次保存及同一进程内重开宿主；没有真实进程冷启动、可见交互、上下文测量和检索原始样本序列。B 按 P5 补齐指标与真实口径，并让门禁强制这些字段；现有数值不能提升为完整性能验收 |
| F-32 | **未关闭，P1**。材料快照、getResource 固定修订、同 runId、步数限额及无报价不写假费用通过；本轮修复 contextSnapshot 可指定后续修订的旁路，补两套 runtime 历史消息测试 | [audit.json](m1a-f24-f32/a-reverify/audit.json) 实际复现：第一次建笔记已提交，下一请求断线；同 runId 重试从头调用模型，参数稍变后笔记数 1→2。B 从持久工具回执/消息检查点恢复，不能仅依赖 inputHash；预算/已用量/截止点须跨恢复保持，模型路由与会话历史也需冻结。现有 B 测试手动把成功 run 改 failed 且 mock 重复完全相同参数，不覆盖该故障 |

## 3. 独立验证与边界

定向反例在 `tests/m1a/reverify-boundaries.test.ts`，补充场景在 `tests/m1a/a-reverify.test.ts`。同名覆盖、替换文件删除、任务身份回放、PI 消息角色、空向量能力与缺少指纹均先复现失败再修复。测试期间发现旧辅助函数使用 PID/序号构造临时根，会碰撞残留 Profile；现用 `mkdtemp`，保留失败事实，随后在唯一合成目录重新运行。

| 检查 | 结果与能证明的范围 |
| --- | --- |
| `node scripts/verify.mjs` | 退出 0；87 份文档、656 本地链接、公开内容/依赖/两套类型检查、Vitest 87 passed / 4 live skipped、M0 回归 15/15。计数见 [test-run.json](m1a-f24-f32/a-reverify/test-run.json)；不能替代失败审计 |
| `M1A_REQUIRE_REPORT=1` + `node scripts/verify-m1a.mjs` | 回归子集通过；总报告因 A 审计 F-25/F-32 仍失败而退出 1，见 [report.json](m1a-f24-f32/a-reverify/report.json)。没有放宽检查或把失败改写为通过 |
| `node scripts/audit-m1a-reverify.mjs` | 退出 1；两个局部边界修复后 passed，权威库重启和断线重试副作用仍 failed |
| `node scripts/m1a.mjs package` | 退出 0；未签名 Windows x64 包 initial/restart、笔记标记读回；原生模块使用现有缓存，未声称本轮从源码 rebuild 或签名发布 |
| `node scripts/m1a.mjs bench` | 退出 0；10,000 元数据/50,000 检索块，服务检索 p95 0.313 ms（100 次），保存 1.207 ms（1 次），同进程宿主重开 5.034 ms（1 次）；限制属于 F-31 |
| `node scripts/m1a.mjs live` | 按忽略配置显式运行，LLM completion/stream 与独立 ASR 合成静音 WAV 协议短测；Embedding 未配置、not-run。实际状态见 [live-api.json](m1a-f24-f32/a-reverify/live-api.json)，不记录密钥、真实根或供应商正文 |

过程失败记录：一次 Forge 下载校验清单遇到 TLS 连接中断，一次真实 LLM completion/stream 请求发生 fetch failed；最终同源码有限重试通过，未更换用途、关闭校验或删除失败事实。统一检查还检出新所有权 helper 的向上相对导入违反现有依赖门禁，已将纯文件身份逻辑放入 domain 同层模块并重新验证。

本轮没有上传用户正文/音视频，没有迁移真实 Profile 或扫描真实资源根；也未要求重新授权已提供的用途配置。IME/键盘/缩放沿用已记录的用户反馈，本次未改 renderer。包截图只证明最终版本正常启动和合成资料页面，不能作为 F-27 完整运行交互的替代。

## 4. 集中交接与用户事项

**首选下一步：交给 Agent B，一次性补 F-24、F-25、F-27、F-30、F-31、F-32 的上述差异。** 先收敛权威库/恢复和持久运行日志，再补真实界面与性能证据，最后交 A 复验。可直接使用 [更新后的 B prompt](../delivery/m1a-cursor-prompt.md)。保留 F-21—F-23、F-26、F-28、F-29 已关闭结论和新增反例，不重做 M0 或重启整份计划。

当前没有需要用户先回答才能修复的产品决定。Embedding 配置仅在需要真实向量服务验证时再补，本轮保持 not-run；已授权的 kernel、单写入、双 runtime、LLM/ASR 配置和真实根不重复询问。Q-05/Q-08/Q-09 按原阶段截止，不拿它们替代开发缺口。

本轮不申请远端操作：阶段尚未完成。修复收敛并完成 A 复验后，再提供明确的本地版本与 push/PR/合并建议，由用户决定相应动作。本文没有签署 M1a 产品验收通过。

## 5. A 2026-09-21 复验（`6d377bb`）

本节是 A 对 B 返工后的独立复验，保留上文历史结论与 B 自检原文，不把 B 第 10 节改写成审核结果。工作区起点为 `feat/m1a-agent-foundation` @ `6d377bb`，前置仍为未合并的 `feat/m0-tech-contract-validation` @ `a33b115`；本轮没有回退 SHA，也没有纳入 VOICE-06—08 / AT-57—59。

F-24、F-25、F-27、F-30、F-31、F-32 的技术缺口本轮均关闭。F-24 的 `recover` 对 planned/copying/committed/needs-review 均产生明确恢复、回滚或 needs-review 结果，并保留冲突/外源文件；F-25 统一读取 pointer、`relocatedRoot`，使用目标锁和宿主写入屏障，旧 Profile 重启解析到已发布库，copy/verify/publish/commit/pointer/switch 均由真实子进程退出覆盖；F-27 通过真实 Electron 慢提供者的发送→副驾驶→停止→重启恢复及模块入口撤销；F-30 持久化 pointer/分区配置，逐批可取消扫描，提供位置/缺失/修复，总览使用持久扫描统计，独立分区改址明确拒绝；F-31 报告包含 10,000/50,000 规模、真实进程冷启动、Electron 可见交互、保存、上下文及检索原始样本，并拒绝缺项、失败、无关测试和旧指纹；F-32 从持久消息/工具回执恢复固定材料、模型路由、历史和预算，断线后同 runId 改参数重试仍保持一条笔记。

独立证据目录为 [`m1a-f24-f32/a-reverify-6d377bb`](m1a-f24-f32/a-reverify-6d377bb/)，未覆盖 `m1a-review`、`m1a-acceptance`、`m1a-model-routing`、`m1a-asr-siliconflow`、根级 B 跑次、`a-reverify` 或 `b-rework`。该跑次 `verify.mjs` 退出 0；M1a Vitest 94 passed / 4 live skipped；`audit-m1a-reverify.mjs` 四项 passed，其中断线反例的笔记数为 1→1；Windows x64 包 initial/restart/agent/agent-restart passed；bench 为 10k/50k，检索 p95 0.357 ms、保存 p95 6.395 ms、上下文 p95 0.559 ms、进程冷启动 p95 27.755 ms、Electron 交互 p95 4 ms；`M1A_REQUIRE_REPORT=1 node scripts/verify-m1a.mjs` 退出 0，报告指纹与源码匹配。真实 LLM completion/stream 与合成 WAV ASR 短测 passed，Embedding 未配置而 not-run。

本轮仍未关闭编号：无（仅就上述六个技术复验编号而言）。这不构成 M1a 产品验收通过；真实 Embedding、既有人工项及后续范围仍按阶段边界保留。本轮没有 push、PR、合并或发布。

## 6. 人工确认、Embedding 补测与推送准备（2026-09-21）

用户在 `b76fed5` 交付后明确报告本轮人工审查通过，并授权在门禁通过后推送 M0、M1a 两个阶段分支及创建 PR。此授权不包含合并或发布，也不将 VOICE-06—08 / AT-57—59、未测媒体/设备能力或 M0 全部退出条件改写成通过。

用户另提供了独立 Embedding 用途配置，按 A-29 只保存到 Git 忽略的本地环境文件，未设为产品默认模型。补测前发现 `live-models.test.ts` 的旧 Embedding 用例仅检查配置字符串；现改为在隔离合成 Profile 中经 `connections.upsert` → `connections.test(capability="embedding")` 实际调用应用服务。服务用合成短文本请求，要求恰好一个非空向量且每个分量为有限数值，并持久化 verified capability；完成后清理持有测试凭据密文的临时 Profile。没有将配置存在冒充接口通过，也不记录密钥、向量正文或供应商 body。

新证据使用 [`a-publish-embedding/`](m1a-f24-f32/a-publish-embedding/)，保留全部历史跑次。真实 LLM completion/stream、合成 WAV ASR、应用 Embedding 探针均 passed，见 [live-api.json](m1a-f24-f32/a-publish-embedding/live-api.json)。由于测试源指纹变化，重新生成同指纹的包、性能、独立审计和 M1a 报告；最终命令状态见 [verification.json](m1a-f24-f32/a-publish-embedding/verification.json)。产品实现未改动，F-24—F-32 沿用第 5 节限定范围的复验结论，B 第 10 节仍是 B 自检。

M0 的 `a33b115` 在隔离工作树、锁定依赖下重新运行自身 `node scripts/verify.mjs`，退出 0（79 份文档、569 个本地链接、公开内容、依赖边界、类型检查和 15/15 回归）。该命令不重做 M0 媒体/设备或历史完整性能验收。推送保留两个独立交付提交：M0 PR 指向 main；M1a PR 暂以 M0 分支为基准，前置合并后的改基与合并另行处理。仓库 CI 当前只自动运行面向 main 的 PR，不能将 M1a 的临时基准 PR 说成已获该 CI 检查。

## 7. DCO 与远端合并交接（2026-09-21）

用户在两个 PR 创建后追加授权：处理本次 DCO、直接合并 M0/M1a、清理阶段分支并同步主分支，为下一阶段准备。仓库实际默认分支为 main。该授权覆盖本轮补签及衔接依赖所需的限定分支更新，不包含发布，也不改变历史产品验收边界。

DCO App 报错为两个交付提交缺少 Signed-off-by；按现有提交作者身份补签，使用指定远端旧 SHA 的 force-with-lease 防止覆盖新增工作。M0 签署提交 `b1298d9` 与原 `a33b115` 文件树相同，DCO 与 repository-quality 均通过，已由 [PR #1](https://github.com/chialecode/manga/pull/1) squash 合入 main（`dc925e9`）。本地验证曾因切换分支后沿用 M1a 依赖失败；按 M0 锁文件重新安装后，类型及 15/15 回归通过。未修改测试或放宽门禁。

M1a 的 [PR #2](https://github.com/chialecode/manga/pull/2) 已改为 main 基准，并将独立 M1a 交付接到已合并的 M0 上；补签与改基后的产品源码、测试和证据文件树保持原 `cd9b392` 内容，本次另同步导航和交付状态。沿用第 6 节匹配源码指纹的证据，合并前通过本地统一检查，并要求新 head 的 DCO 与面向 main 的 repository-quality 均成功。最终合并 SHA、检查和时间以 PR 记录为准；合并后的 main 是下一阶段基线。

切回 M1a 后，锁定安装仍遗留 M0 的 Zod 3 局部依赖链接，覆盖了 M1a hoisted 布局中的 Zod 4，导致类型和契约检查失败。将已核对的旧链接移到忽略的本地备份位置后，实际解析恢复为锁定的 Zod 4.1.5，再重跑统一检查；未更改源码、依赖清单、锁文件或历史证据。

main Ruleset 未改动，DCO 未被擅自新增为必需检查；本轮没有安装或移除 App。后续先做 M1b 阅读与人工记录的 A 规划，核对其进入条件；B 第 10 节、未测 AT、独立分区拒绝及 VOICE-06—08 的阶段范围继续保留。
