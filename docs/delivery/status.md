# 当前执行状态

核对日期：2026-09-21。用例定义与需求追踪矩阵仅在[交付计划](roadmap-and-acceptance.md)维护；本页汇总实际状态并链接证据。

## 当前事实

| 项目 | 状态 | 依据 / 下一动作 |
| --- | --- | --- |
| 产品需求与详细设计 | 本次优先级、目录、格式与首发范围已确认 | [文档导航](../README.md)、[确认记录](../decisions/confirmed-decisions.md) |
| 基础技术栈 | 已确认选型；产品契约 Zod 4、React/Forge 宿主与 better-sqlite3 已接入；kernel/单写入已定稿，本轮 A 技术复验见最新报告 | [ADR-0007](../decisions/0007-technology-stack.md)；M0 实验界面/存储仍为 textarea 与 `node:sqlite` |
| 本轮 Cursor 交付复核 | 局部问题已修复，最终自动验证子集 passed | [最终复核报告](../evidence/2026-09-19-m0-closure-review.md)；34/34 场景、独立包、真实跨卷和性能子集 |
| M0 整体退出 | blocked；负责人：开发者、技术负责人及对应设备测试参与者 | 有限授权/生命周期、恢复及媒体/设备不确定性未全部解决；kernel/单写入已定稿，新 React 短测用户报告通过；不能以 R0—R7 自述代替验收 |
| M1a | A 本轮六项技术复验已记录关闭；2026-09-21 用户报告本轮人工审查 passed；真实 Embedding 补测 passed，完整 AT 不自动全量标通过 | [A 最新复验与人工记录](../evidence/m1a-f24-f32-review.md)、[推送前独立跑次](../evidence/m1a-f24-f32/a-publish-embedding/)、[B 自检交接](../evidence/m1a-delivery.md)；M0 已由 [PR #1](https://github.com/chialecode/manga/pull/1) 合入 main，M1a 经 [PR #2](https://github.com/chialecode/manga/pull/2) 接续；后续以两 PR 合并后的 main 为基线 |
| M1b—M4 产品验收 | not-run | 完整阅读/记录、目标媒体和扩展按各阶段处理，不堵住独立基础工作 |
| 人工反馈 | 旧原型基础实机与新 React IME/键盘/缩放均由用户报告 passed；2026-09-21 用户另报告本轮人工审查 passed | [实机反馈](../evidence/2026-09-19-m0-device-followup.md)、[本轮人工记录](../evidence/m1a-f24-f32-review.md)；不覆盖尚未实现的后续语音/媒体能力 |
| 文档治理 | 已建立；导航基线 0.8，当前事实以本页和新报告为准 | [框架记录](../evidence/2026-09-19-documentation-framework.md)、[文档复核](../evidence/2026-09-19-documentation-revision.md) |
| Git、CI 与分支规则 | main 保护保持；2026-09-21 用户追加授权 DCO 补签、M0 → M1a 依次 squash 合并、清理阶段分支并同步 main；未授权发布 | [建立报告](../evidence/2026-09-19-github-bootstrap.md)、[Git 与 GitHub](../dev-rules/git-and-github.md)、[实时规则](https://github.com/chialecode/manga/rules)；DCO 是已存在的 App 检查，必需检查仍为 repository-quality；合并和 CI 结果以 PR #1/#2 为准 |
| 许可证与公开检查 | Apache-2.0 已落地；工作树/暂存检查接入统一入口 | [许可证](../../LICENSE)、[公开门禁](../dev-rules/quality-gates.md#11-公开内容检查)；语义与图片仍需复核 |
| GitBook、自动 AI reviewer | GitBook 仅准备配置；不启用自动 AI review | ADR-0002；接入和发布另行确定 |

## M0 跟踪

本表中的 passed 仅指注明的原型子集。当前统一源码指纹与结果见 [summary.json](../evidence/m0-final-review/summary.json)，历史报告只对原版本和原测试有效。

| 编号 | 已测范围及状态 | 剩余工作、负责人和截止 |
| --- | --- | --- |
| POC-01 | passed：文本解析/码点定位/旧修订/局部 DOM 选区；证据见[复核报告](../evidence/2026-09-19-m0-closure-review.md) | 开发者在 M1b 完成全文交互与 TXT/EPUB/MOBI/PDF 子特性；当前仅渲染 8,000 字符预览，未测完整长章流程 |
| POC-02 | passed：软件时间线、原件保留、回放时长/seek/导出/重启；旧基础实机路径由用户报告 passed | 设备和硬件定位 not-run；开发者先补媒体身份/采样起点测量与恢复，用户在 M1b 实测；长录音回放仍有解码内存边界 |
| POC-03 | passed：格式探测、H.264 实际播放、有限切/拼接；HEVC 实际解码 rejected，结果已记录 | 开发者在 M2 前定后端并验证 MKV/HEVC/ASS/多音轨/VFR、长图和音画同步；[支持矩阵](../evidence/2026-09-19-m0-support-matrix.md)不撤销格式目标 |
| POC-04 | passed：实验命令/代次/提交屏障、确定性晚到结果拒绝、worker 重新启用；M1a 子范围：宿主 grant、UI Facet 启停、越权拒绝 | 第三方沙箱仍 not-run；见 [M1a 交付](../evidence/m1a-delivery.md) |
| POC-05 | M1a React 宿主已集成；旧 textarea 子集仍 passed | Tiptap/CodeMirror 和结构撤销在 M1b；新 React 输入法/键盘/缩放由用户报告 passed；后续仅复测受影响界面 |
| POC-06 | M1a better-sqlite3/Drizzle/FTS5 已接入；旧 node:sqlite 实验保留 | better-sqlite3 单写入已 accepted；本轮合成恢复/索引子场景见最新 A 报告；不迁移真实 Profile 或修改真实原件 |
| POC-07 | passed：候选 kernel 的已测契约；M1a service/UI Facet 注册、授权/幂等及本轮模块撤销子场景有复验证据 | 正式选型已 accepted；MinimalActivator 仅失败反例；第三方执行隔离仍属于 M4 |
| POC-08 | passed：假提供者关联/替换、资料包安全校验与普通错误回滚、索引/未知附件往返 | M1a 已补资料包突停识别；开发者 M2 接 Bangumi；资料包不等同整个 Profile 备份 |
| POC-09 | passed：受控 HTTP 获取、恢复、不覆盖与两个真实卷双向验证 | [当前结果](../evidence/m0-final-review/poc-09.json)；开发者 M4 重验 BitTorrent 分片/恢复/做种，不由 HTTP 结果推定 |

## 验收记录方式

AT-01—AT-59 不按一次技术报告或一次总体人工反馈全量改为 passed；已测范围以各报告具体子场景和用户确认范围为准。2026-09-21 本轮人工审查由用户报告通过。VOICE-06—08 已登记为 A-30 后续需求，尚无产品实现或测试证据。新栈 10k/50k 性能与 Electron 子场景已有独立证据，30 MiB EPUB、实际显示器与硬件响应等未测范围仍不标通过。

最新 [summary.json](../evidence/m0-final-review/summary.json) 的 `automationStatus: tested-subset-passed` 和 `engineeringReviewable: true` 只判断本次原型证据完整且匹配源码。`m0Exit` / `m1Entry: not-assessed-see-stage-gates` 明确不自动计算阶段验收；`pendingAutomated: []` 不代表没有待开发功能。旧 `m0-closure` 部分格式证据在复核中曾因路径缺陷更新，历史版本边界见[复核报告](../evidence/2026-09-19-m0-closure-review.md)。

M0 整体退出仍单独跟踪；用户已在获知历史限制后授权推送、创建 PR，并追加授权合并两个阶段的已交付范围，不将这些操作解释为 M0 全部退出。无需再次确认已选基础库、目录、格式或参考机。运行时/宿主已正式定稿，BYOK 首版自研/PI 双 runtime 也已确定。设备项只影响依赖它的录音验收，不能把待开发缺口转交用户测试。

状态统一使用 not-run、running、passed、failed、blocked；blocked 必须注明阻塞与负责人，passed 必须限定实际版本和范围。变更使旧证据失效时保留历史，把当前受影响范围改为待验证。

## 当前推荐下一步

以合并后的 main 开始下一轮 A 规划，按 M1b 的阅读与人工记录优先顺序，核对 POC-01/05/06 的剩余进入条件并形成可执行计划，再交 B 实施；本次远端收尾不自动开始后续产品开发。真实文本、ASR 和 Embedding 实测只证明合成样本下的接口能力，配置按 A-29 保留本地；向量索引、VOICE-06—08 及完整后续阅读/媒体仍按原阶段交付。B 自检、A 技术复验与本轮用户人工确认分别保留。
