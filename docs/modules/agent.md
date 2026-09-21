# Agent 模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.agent` / Agent / 开发者 |
| 文档状态 / 实现状态 | M1a 会话/运行循环、即时 runId、材料快照、持久消息/工具检查点、同 run 重试与双 runtime 已接线；技能与完整阅读上下文归后续阶段 |
| 需求 / 阶段 / 设计依据 | AGENT-01—06、MODEL-04、AT-49/50 |
| 包与公开入口 | `packages/app-core`、`packages/model-protocol`；`agent.createSession`、`agent.send`、`agent.cancel`、`agent.retry`、`agent.getRun` |

## 1. 责任与依赖

拥有会话、运行、工具证据和预算。工具只来自当前启用且授权的命令，工具输入 schema 由命令契约生成（不允许额外字段）。主页面与副驾驶共享同一会话服务。依赖 library；无连接时仍可使用已交付本地命令。

## 2. 数据与公开能力

AgentRun 固定会话、grant、材料修订快照、冻结 runtime、会话历史、连接与预算；`agent.send` 立即返回当前 `runId`，完成态经 `agent.getRun` 轮询，流式文字写入 `live_text`。任务 grant 只含用户勾选的可读材料，不附带资源写权限，Agent 只能改自己创建的笔记。已执行工具按同一 run 的命令回执恢复，重试不得因模型改参数再生成一条副作用。截止时间与已用步数跨恢复保持。无报价不写假费用。取消只作用于未结束的运行。

## 3. Agent 与界面

来源正文中的指令不能授予权限。模型不能填写 actor、scopeHandle 或磁盘路径。

## 4. 生命周期与兼容

停用中止运行并撤销 UI/工具。替换连接不改变命令协议。

## 5. 验证与未决

AT-09/11/12/13/44/49/50 本轮子场景（`tests/m1a/p3-agent.test.ts`、`p5-faults.test.ts`、`a-review.test.ts`、`f24-f32.test.ts`）。真实 API 契约按独立用途读取忽略的本地配置，普通 CI 不联网。A-22 自研/PI 双 runtime 已接入 `completeText`/`streamText`，设置可切换，运行中冻结。VOICE-06—08 不在 M1a。不得因子场景通过宣称模块或产品验收完成。

2026-09-21 本轮 B 返工：`getRun` 返回用户输入、消息检查点与 live text；App 刷新恢复当前 run；重试从已执行工具回执续作。详见 [F-27/F-32](../evidence/m1a-f24-f32-review.md) 与 [B 交付](../evidence/m1a-delivery.md)。
