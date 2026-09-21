# MANGA 文档导航

| 项目 | 内容 |
| --- | --- |
| 文档版本 | 0.8（已确认范围与公开内容门禁；各设计文档独立版本） |
| 编写日期 | 2026-09-19 |
| 状态 | 导航与治理入口生效；产品与设计细化仍按各文档状态 |
| 产品主线 | 围绕二次元内容，让阅读观看、随手记录、素材整理和辅助创作形成连续的工作流 |
| 实现状态 | M0 原型已复核修复，已测子集可交审；M0 未退出；下一轮先完成 M1a 基础门槛与 Agent |

## 1. 阅读顺序

开始开发先读根 [AGENTS.md](../AGENTS.md)和 [当前执行状态](delivery/status.md)，再按任务阅读下列正本。首次了解产品可先读产品原则与需求，研究组合架构再读组合方案。

| 开发入口 | 用途 |
| --- | --- |
| [文档治理](governance/documentation-policy.md) / [完整登记表](governance/document-registry.json) | 权威范围、状态、责任、更新与归档；所有自有 Markdown 均登记 |
| [产品规则](product-rules/README.md) | 已确认方向与长期承诺 |
| [开发规则](dev-rules/README.md) / [仓库地图](dev-rules/repo-map.md) | 工作流、模块/契约、数据、Agent 与真实命令 |
| [A/B 协作与集中审批](dev-rules/development-workflow.md#agent-handoff) / [交接模板](templates/agent-handoff.md) | A 规划、B 连续执行、A 集中复核；统一版本/证据与必要用户决定 |
| [设计规则](design-rules/README.md) | UI 治理、可访问性与视觉证据 |
| [决定与问题](decisions/README.md) | 用户确认、A/Q 台账、ADR 与截止点 |
| [基础技术栈决定](decisions/0007-technology-stack.md) | A-15 已授权的 UI、编辑、存储与工程基础选择；原型到正式工程的迁移/验证边界 |
| [模板](templates/README.md) | 提案、模块规格、决定与验证报告 |
| [执行状态](delivery/status.md) | POC/AT 的实际执行情况与证据 |
| [M0 执行与交接计划](delivery/m0-execution-plan.md) / [Cursor prompt](delivery/m0-cursor-prompt.md) | 工作包与交接；当前结果见 [复核修复报告](evidence/2026-09-19-m0-followup-review.md) |
| [M0 收尾计划](delivery/m0-closure-plan.md) / [收尾 Cursor prompt](delivery/m0-closure-cursor-prompt.md) | 历史交接工作包；实际复核结论见下列最终报告 |
| [M1a 执行计划](delivery/m1a-execution-plan.md) / [Cursor prompt](delivery/m1a-cursor-prompt.md) | 下一轮实施入口：新栈、授权/生命周期、数据恢复与目录、Agent/连接/配置、最终验证 |
| [Git 与 GitHub](dev-rules/git-and-github.md) / [GitBook 阅读目录](SUMMARY.md) | 本地验证、远端协作、分支规则、低频自动化及文档接入 |

| 文档 | 负责回答的问题 |
| --- | --- |
| [可组合与 AI-Native 方案](design/composable-ai-native-architecture.md) | 如何使功能可拆卸，划分运行时职责，并验证不同实现是否满足 MANGA 契约？ |
| [外部数据库与下载扩展](design/external-providers-and-acquisition.md) | 如何组合动漫数据库、保留本地身份，以及后装下载能力并可靠导入？ |
| [产品需求](product/requirements.md) | 为谁服务、解决什么问题、需要哪些行为、哪些属于各期范围？ |
| [总体架构](design/architecture.md) | 代码如何组织、模块如何协作、Electron 进程和本地能力如何分工？ |
| [领域与数据](design/domain-model.md) | 资源、位置、记录和引用如何表示、保存、迁移与导出？ |
| [Agent 与插件](design/agent-and-plugins.md) | 状态如何被感知、能力如何注册与执行、插件如何停用、模型如何替换？ |
| [界面与工作流](design/interaction-and-workflows.md) | 用户如何完成阅读、记录、组织、创作和异常恢复？ |
| [交付与验收](delivery/roadmap-and-acceptance.md) | 先验证什么、按什么顺序交付、怎样判定需求完成？ |
| [M0 复核修复报告](evidence/2026-09-19-m0-followup-review.md) | 复核当时的自动化证据、已修复问题与边界 |
| [M0 最新实机反馈与回放诊断](evidence/2026-09-19-m0-device-followup.md) | 微信输入法/键盘/缩放、真实麦克风基础路径及合成录音时长诊断 |
| [M0 收尾交付最终复核](evidence/2026-09-19-m0-closure-review.md) | 当前修复、匹配源码的验证、M0/M1a 判断和人工边界 |
| [M0 收尾覆盖与审查摘要](evidence/m0-closure/coverage.md) | Cursor 交付时的历史 R0—R7 自述；不替代最终复核 |

产品行为以需求文档为准，基础数据语义以领域文档为准，命令与上下文契约以 Agent 与插件文档为准。组合机制、自研范围及运行时选型由可组合方案定义，外部身份、字段合并与获取协议由外部扩展文档细化；对应需求、设计入口与验收已同步。改变跨文档约束时必须同步修改对应章节与验收映射。

这里的“为准”指职责正本，不表示评审稿全部细节已获确认。文档状态、已确认部分和冲突处理见治理规则；文档定义与实际执行结果分别维护。

## 2. 已确认要求与首发基线

长期方向的唯一摘要见 [核心产品原则](product-rules/core-product-principles.md)。2026-09-19 用户新增确认本地单用户、基础功能无需登录、Windows 11 x64 首发，其他桌面系统后续独立验收；正式产品尚未验收，已有 M0 原型见执行状态。

## 3. 假设、待决事项与决定

[已确认决定](decisions/confirmed-decisions.md)保留 A 编号与职责正本，已解决问题已移出[待决事项](decisions/open-questions.md)。M1 先交付 Agent、连接设置与基础配置；基础库按 ADR-0007 实施。剩余问题只在相应阶段阻塞依赖工作，不重复询问已确认项。

## 4. 约束与范围的表达

- **必须**：该需求所属里程碑的发布条件。
- **应当**：默认采用的设计，偏离时需要记录原因和替代验证。
- **可以**：可选能力，不阻塞当前里程碑。
- **M0**：风险验证与契约验证；**M1**：Agent 与基础配置优先，再完成小说与记录流程；**M2**：漫画和动画；**M3**：创作工作区；**M4**：粗剪与扩展交付；**vNext**：待细化范围。
- 一项能力可以先形成最小实现，再在后续里程碑扩展；需求文档会写明初始交付与扩展边界。
- 性能与质量数字是待实测的目标，不是已测得的产品指标。

## 5. 文档维护规则

以 [文档治理](governance/documentation-policy.md)为流程正本。新增/移动文档同步登记与导航，需求或契约变化同步设计及验收映射，重要选择记录决定，实际结果进入证据和执行台账。小型纠错无需新提案或重复审批。

文档变更和推送前执行 `node scripts/verify.mjs`，其中包含 `node scripts/check-docs.mjs` 与类型检查；覆盖和限制见 [质量门禁](dev-rules/quality-gates.md)。GitHub 工作流复用同一入口。CI 不跑完整 POC 或 Windows 设备项，不能把治理检查当作 M0 退出或产品验证。

## 6. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1 | 2026-09-13 | 将用户确认的产品方向细化为需求、架构、数据、协议、交互和分阶段验收文档 |
| 0.2 | 2026-09-19 | 增加可组合与 AI-Native 总方案、外部数据库与下载协议；细化功能/模块/能力/提供者边界、装配、停用、数据恢复，并同步需求及验收 |
| 0.3 | 2026-09-19 | 明确 MANGA 运行时的六项职责与异常难点、POC-07 的统一契约验证、分阶段范围、维护成本和单一生产实现原则 |
| 0.4 | 2026-09-19 | 建立 Agent/程序员入口、文档治理与登记、三类规则、决策和执行台账、模板及可运行检查；确认 A-01/A-02，保留其他未决状态 |
| 0.5 | 2026-09-19 | 统一为 MANGA 自身的需求、职责与验证表述；文档位置采用仓库相对路径，同步导航与登记 |
| 0.6 | 2026-09-19 | 建立 Git/远端管理、本地统一验证、必要 PR CI、单人维护 Ruleset、低频协作规范与 GitBook 接入准备 |
| 0.7 | 2026-09-19 | 登记 M0 验证工程、POC 证据与 proposed ADR；同步导航与命令入口 |
| 0.8 | 2026-09-19 | 落实 Agent 优先、可配置目录、媒体/录音/提供者/语言/许可决定；移除已解决问题，新增公开内容检查 |

- [M0 交付复核与修复](evidence/2026-09-19-m0-followup-review.md)
