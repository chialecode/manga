# M1a：给 Agent B 的集中返工 prompt

日期：2026-09-21。以 [最新 A 复验](../evidence/m1a-f24-f32-review.md)为唯一差异清单，复用 [原计划](m1a-execution-plan.md)；[原 A 发现](../evidence/m1a-acceptance-review.md)与 B 交付第 7–8 节保留为历史。

```text
你是 Agent B。请在当前仓库 feat/m1a-agent-foundation 连续补齐 M1a 本轮差异，不从 M0 重开，不重建分支或覆盖已有改动。

先读 AGENTS.md、docs/README.md、docs/delivery/status.md、docs/evidence/m1a-f24-f32-review.md、docs/evidence/m1a-delivery.md 第 7–9 节、docs/delivery/m1a-execution-plan.md，再按触发表读正本与实现。执行 git status --short --branch。以包含最新 A 复验报告的当前提交为起点；11d0059 已被同一交付 amend 接续，前置 feat/m0-tech-contract-validation @ a33b115 未合并。不要回退到旧 SHA。

只补 F-24、F-25、F-27、F-30、F-31、F-32。保留 A 已关闭的 F-21—F-23、F-26、F-28、F-29，以及 F-24 止损。保留 acceptance-review.test.ts、model-routing.test.ts、a-reverify.test.ts、reverify-boundaries.test.ts、报告反例；不能削弱断言来关闭编号。

依赖顺序：
1. F-24/25：恢复/放弃必须能从 planned/copying/committed/needs-review 走到明确结果，回滚只处理有可验证所有权的本任务产物。保留排他复制、身份及内容指纹、活动库/实际路径检查。统一启动参数、pointer、relocatedRoot、目标锁和宿主提交屏障；旧 Profile 重启不能重新成为写入权威。覆盖 pointer 发布失败和 copy/verify/publish/commit/switch 的真实子进程退出；不能只测试 location-copy/location-switch。
2. F-32：从持久消息/工具回执检查点恢复，固定材料、模型路由、历史和已用预算，重试不能重新生成另一条副作用。运行 node scripts/audit-m1a-reverify.mjs，修复“首次建笔记已提交→下一请求断线→同 runId 重试模型改参数→笔记 1→2”的反例。无报价继续保持费用未知，禁止伪造 0 费用。
3. F-27：补实际 App 的用户输入/多轮历史及刷新重启恢复、实时运行状态和当前任务停止。用真正 App/Electron 与慢提供者验证发送→切副驾驶→停止→重启恢复、模块入口撤销；服务测试和简单页面截图不能替代它。
4. F-30：实现分区和 pointer 的持久可编辑配置；当前不支持的独立分区计划保持明确拒绝，直到完整路径可用。单根扫描改为有界批次/worker并能取消，准确处理占用/位置/缺失/修复。仅索引原件保留，不将媒体根当 Profile 迁移目标。
5. F-31：保留实际 10,000 元数据/50,000 检索块，补真实进程冷启动、可见交互、保存、上下文与搜索原始测量。当前同进程重开和保存 n=1 不够。报告必须拒绝缺项、失败、无关测试和旧/缺失指纹，也要传播 A audit 失败。

局部修复、自测、文档同步连续完成，不逐包请求确认。已定稿 kernel/better-sqlite3 单写入、自研/PI 双 runtime 不重问。真实模型仅在明确触发的本地测试中按忽略的 .env.local 分用途读取 MANGA_TEST_LLM_*、MANGA_TEST_ASR_*、MANGA_TEST_EMBEDDING_*；不打印密钥，不硬编码提供者默认，不跨用途回退。Embedding 未配置则 not-run。真实资源根已有授权，先满足恢复/索引门槛；自动测试只用唯一临时目录与合成资料。

源码稳定后在 docs/evidence/m1a-f24-f32/ 下创建新的独立跑次目录，生成匹配两个当前指纹的测试、失败审计、基准、Windows 包与必要真实模型结果。不覆盖 m1a-review、m1a-acceptance、m1a-model-routing、m1a-asr-siliconflow，以及 B 根级和 A a-reverify 历史结果。运行 node scripts/verify.mjs；显式设置 M1A_EVIDENCE_DIR 和 M1A_REQUIRE_REPORT=1 后运行 node scripts/verify-m1a.mjs。修正缺口后 audit 必须真实通过，不得删除反例或忽略失败。

在 docs/evidence/m1a-delivery.md 追加按编号的实现、验证与限制，更新状态/模块规格，保留历史结论。未 push 的同一交付按授权 amend，消息描述最终结果；不自动 push、创建 PR、合并或发布。不要扩到 VOICE-06—08/AT-57—59、M1b/M2 或 M4。

完成后给出提交、未提交文件归属、证据、剩余编号及集中用户事项。首选下一步交 Agent A 复验，并附可复制 prompt。B 自检不得写成 A 已审或 M1a 产品验收通过。
```
