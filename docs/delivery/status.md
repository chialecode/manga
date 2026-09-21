# 当前执行状态

核对日期：2026-09-19。用例定义与需求追踪矩阵仅在[交付计划](roadmap-and-acceptance.md)维护；本页汇总实际状态并链接证据。

## 当前事实

| 项目 | 状态 | 依据 / 下一动作 |
| --- | --- | --- |
| 产品需求与详细设计 | 本次优先级、目录、格式与首发范围已确认 | [文档导航](../README.md)、[确认记录](../decisions/confirmed-decisions.md) |
| 基础技术栈 | 已确认选型；正式集成与复测 not-run | [ADR-0007](../decisions/0007-technology-stack.md)；当前 M0 仍为 textarea/node:sqlite/Zod 3/实验构建 |
| 本轮 Cursor 交付复核 | 局部问题已修复，最终自动验证子集 passed | [最终复核报告](../evidence/2026-09-19-m0-closure-review.md)；34/34 场景、独立包、真实跨卷和性能子集 |
| M0 整体退出 | blocked；负责人：开发者、技术负责人及对应设备测试参与者 | 新栈、有限授权/生命周期、恢复及媒体/设备不确定性未全部解决，运行时/宿主未正式定稿；不能以 R0—R7 自述代替验收 |
| M1a | 基础门槛与产品验收 not-run；可继续本地基础实施 | [执行计划](m1a-execution-plan.md)、[Cursor prompt](m1a-cursor-prompt.md)；先完成 P0—P2，再开放实际 Agent 工具，最终按 M1a 范围验收 |
| M1b—M4 产品验收 | not-run | 完整阅读/记录、目标媒体和扩展按各阶段处理，不堵住独立基础工作 |
| 人工反馈 | 旧原型 IME/键盘/缩放、真实基础录音由用户报告 passed | [实机反馈](../evidence/2026-09-19-m0-device-followup.md)、[仅受影响部分的短复测](../evidence/2026-09-19-m0-human-checklist.md) |
| 文档治理 | 已建立；导航基线 0.8，当前事实以本页和新报告为准 | [框架记录](../evidence/2026-09-19-documentation-framework.md)、[文档复核](../evidence/2026-09-19-documentation-revision.md) |
| Git、CI 与分支规则 | 已建立，当前任务未重新修改远端 | [建立报告](../evidence/2026-09-19-github-bootstrap.md)、[Git 与 GitHub](../dev-rules/git-and-github.md)、[实时规则](https://github.com/chialecode/manga/rules) |
| 许可证与公开检查 | Apache-2.0 已落地；工作树/暂存检查接入统一入口 | [许可证](../../LICENSE)、[公开门禁](../dev-rules/quality-gates.md#11-公开内容检查)；语义与图片仍需复核 |
| GitBook、自动 AI reviewer | GitBook 仅准备配置；不启用自动 AI review | ADR-0002；接入和发布另行确定 |

## M0 跟踪

本表中的 passed 仅指注明的原型子集。当前统一源码指纹与结果见 [summary.json](../evidence/m0-final-review/summary.json)，历史报告只对原版本和原测试有效。

| 编号 | 已测范围及状态 | 剩余工作、负责人和截止 |
| --- | --- | --- |
| POC-01 | passed：文本解析/码点定位/旧修订/局部 DOM 选区；证据见[复核报告](../evidence/2026-09-19-m0-closure-review.md) | 开发者在 M1b 完成全文交互与 TXT/EPUB/MOBI/PDF 子特性；当前仅渲染 8,000 字符预览，未测完整长章流程 |
| POC-02 | passed：软件时间线、原件保留、回放时长/seek/导出/重启；旧基础实机路径由用户报告 passed | 设备和硬件定位 not-run；开发者先补媒体身份/采样起点测量与恢复，用户在 M1b 实测；长录音回放仍有解码内存边界 |
| POC-03 | passed：格式探测、H.264 实际播放、有限切/拼接；HEVC 实际解码 rejected，结果已记录 | 开发者在 M2 前定后端并验证 MKV/HEVC/ASS/多音轨/VFR、长图和音画同步；[支持矩阵](../evidence/2026-09-19-m0-support-matrix.md)不撤销格式目标 |
| POC-04 | passed：实验命令/代次/提交屏障、确定性晚到结果拒绝、worker 重新启用 | M1a 有限 actor/资源授权和真实 UI Facet 尚 not-run，开发者在 P1 完成；固定 scope 字符串不是产品权限边界 |
| POC-05 | blocked：开发者尚未集成正式 React 交互；旧 textarea 子集 passed | M1a P0/P4 完成 React 并针对性复测；Tiptap/CodeMirror 和结构撤销在 M1b 完成 |
| POC-06 | blocked：开发者尚未集成 better-sqlite3/Drizzle 与新包；旧 node:sqlite/独立包子集 passed | M1a P2 验证旧库、迁移/资料包突停恢复、全部目录可配置/隔离、凭据和原生打包；写入宿主提供证据后定稿 |
| POC-07 | passed：候选 kernel 的已测契约与启停子集；正式选型未定 | M1a P1 补真实 UI/授权、维护成本与候选建议；技术负责人随后定稿；MinimalActivator 仅是失败反例 |
| POC-08 | passed：假提供者关联/替换、资料包安全校验与普通错误回滚、索引/未知附件往返 | M1a P2 补资料包突停恢复；开发者 M2 接 Bangumi；资料包不等同整个 Profile 备份 |
| POC-09 | passed：受控 HTTP 获取、恢复、不覆盖与两个真实卷双向验证 | [当前结果](../evidence/m0-final-review/poc-09.json)；开发者 M4 重验 BitTorrent 分片/恢复/做种，不由 HTTP 结果推定 |

## 验收记录方式

AT-01—AT-56 的完整产品用例均为 not-run；已测原型只证明各报告具体子场景。需求 6.2 的当前参考机子集达到原目标，30 MiB EPUB、实际显示与硬件响应、新技术栈等尚未完成，不能标整项通过。

最新 [summary.json](../evidence/m0-final-review/summary.json) 的 `automationStatus: tested-subset-passed` 和 `engineeringReviewable: true` 只判断本次原型证据完整且匹配源码。`m0Exit` / `m1Entry: not-assessed-see-stage-gates` 明确不自动计算阶段验收；`pendingAutomated: []` 不代表没有待开发功能。旧 `m0-closure` 部分格式证据在复核中曾因路径缺陷更新，历史版本边界见[复核报告](../evidence/2026-09-19-m0-closure-review.md)。

M0 整体未退出不阻止已授权的 M1a 基础验证与实施，但 M1a 进入验证尚未完成，更不能宣称产品已交付。无需再次确认已选基础库、目录、格式或参考机。仍为 proposed 的运行时/宿主继续做可逆验证，待具体证据和方案就绪后再提交正式决定。设备项只影响依赖它的录音验收，不能把待开发缺口转交用户测试。

状态统一使用 not-run、running、passed、failed、blocked；blocked 必须注明阻塞与负责人，passed 必须限定实际版本和范围。变更使旧证据失效时保留历史，把当前受影响范围改为待验证。
