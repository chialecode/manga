# 当前执行状态

核对日期：2026-10-03。用例定义与需求追踪矩阵仅在[交付计划](roadmap-and-acceptance.md)维护；本页汇总实际状态并链接证据。

当前开发顺序按 A-39：先贯通[全部基本功能 MVP](roadmap-and-acceptance.md#mvp-loop)，再根据反馈循环迭代。MVP 尚未完成；下表的阶段验收不由新流程自动标通过。待决定/人工/配置/外部授权及非阻塞后续项统一从[事项总表](../decisions/open-questions.md)进入，本批 A 技术审查已收敛，正式人工与外部动作按事项总表集中处理。

## 当前事实

| 项目 | 状态 | 依据 / 下一动作 |
| --- | --- | --- |
| 产品需求与详细设计 | 本次优先级、目录、格式与首发范围已确认 | [文档导航](../README.md)、[确认记录](../decisions/confirmed-decisions.md) |
| 基础技术栈 | 已确认选型；产品契约 Zod 4、React/Forge 宿主与 better-sqlite3 已接入；kernel/单写入已定稿，本轮 A 技术复验见最新报告 | [ADR-0007](../decisions/0007-technology-stack.md)；M0 实验界面/存储仍为 textarea 与 `node:sqlite` |
| 本轮 Cursor 交付复核 | 局部问题已修复，最终自动验证子集 passed | [最终复核报告](../evidence/2026-09-19-m0-closure-review.md)；34/34 场景、独立包、真实跨卷和性能子集 |
| M0 整体退出 | blocked；负责人：开发者、技术负责人及对应设备测试参与者 | 有限授权/生命周期、恢复及媒体/设备不确定性未全部解决；kernel/单写入已定稿，新 React 短测用户报告通过；不能以 R0—R7 自述代替验收 |
| M1a | A 本轮六项技术复验已记录关闭；2026-09-21 用户报告本轮人工审查 passed；真实 Embedding 补测 passed，完整 AT 不自动全量标通过 | [A 最新复验与人工记录](../evidence/m1a-f24-f32-review.md)、[推送前独立跑次](../evidence/m1a-f24-f32/a-publish-embedding/)、[B 自检交接](../evidence/m1a-delivery.md)；M0 已由 [PR #1](https://github.com/chialecode/manga/pull/1) 合入 main，M1a 经 [PR #2](https://github.com/chialecode/manga/pull/2) 接续；后续以两 PR 合并后的 main 为基线 |
| M1b—M4 产品验收 | not-run | 完整阅读/记录、目标媒体和扩展按各阶段处理，不堵住独立基础工作 |
| M1b 阅读与人工记录实施 | 用户 ACT-01 复核发现 PDF 行边缘选区误报重复句、合成样本组合字符错位，A 8.27 已修复：文本层改用 PDF.js 官方 `TextLayerBuilder`，行首/行尾/边距拖选落到所拖的行，样本组合标记零前进宽度。169 项 Vitest、包、14 项打包版拖选（连续 5 次）与 8.26 的 21+7 项打包审计复跑通过；bench 与严格报告未重跑。用户新包复查后撇号显示仍有问题，按 [LOOP-04](../decisions/open-questions.md#loop-04) 放到后续阶段；新包人工复核与产品验收 not-run | [ACT-01 修复 8.27](../evidence/m1b-reading-notes-delivery.md#act01-review)、[A 复核 8.26](../evidence/m1b-reading-notes-delivery.md#a-b11-review)、[B 原自检 8.25](../evidence/m1b-reading-notes-delivery.md#b11-pdfjs-text)、[PDF.js MVP 计划](m1b-execution-plan.md#pdfjs-mvp) |
| M1b 首版界面切片 | A-37 已实现：双模式显示为观测者/造物主，阅读/笔记/Agent 共享白灰粉视觉；动画演示采用离线静帧、模拟时间和内存笔记。内部模式标识不变，正式媒体仍属 M2，Q-08 未批准 | [界面细节](../design/interaction-and-workflows.md#33-首版界面切片)、[5 组打包交互检查](../evidence/m1b-reading-notes/a-b6-review/final/a-b6-ui-review.json)、[宽窗截图](../evidence/m1b-reading-notes/a-b6-review/final/animation-wide-settled.png) |
| 人工反馈 | 旧原型基础实机与新 React IME/键盘/缩放均由用户报告 passed；2026-09-21 用户另报告本轮人工审查 passed；2026-10-03 用户在 M1b 稳定包上报告 H-02—H-05 与当前视觉未发现问题，H-01 的 PDF 行边缘选区失败后已修复、待新包复核 | [实机反馈](../evidence/2026-09-19-m0-device-followup.md)、[本轮人工记录](../evidence/m1a-f24-f32-review.md)、[M1b ACT-01 反馈](../evidence/m1b-reading-notes-delivery.md#act01-review)；不覆盖尚未实现的后续语音/媒体能力 |
| 文档治理 | 已建立；导航基线 0.8，当前事实以本页和新报告为准 | [框架记录](../evidence/2026-09-19-documentation-framework.md)、[文档复核](../evidence/2026-09-19-documentation-revision.md) |
| Git、CI 与分支规则 | main 保护保持；2026-09-21 用户追加授权 DCO 补签、M0 → M1a 依次 squash 合并、清理阶段分支并同步 main；未授权发布 | [建立报告](../evidence/2026-09-19-github-bootstrap.md)、[Git 与 GitHub](../dev-rules/git-and-github.md)、[实时规则](https://github.com/chialecode/manga/rules)；DCO 是已存在的 App 检查，必需检查仍为 repository-quality；合并和 CI 结果以 PR #1/#2 为准。2026-10-03 起所有提交都带 DCO 签名（A-43） |
| 许可证与公开检查 | Apache-2.0 已落地；工作树/暂存检查接入统一入口 | [许可证](../../LICENSE)、[公开门禁](../dev-rules/quality-gates.md#11-公开内容检查)；语义与图片仍需复核 |
| GitBook、自动 AI reviewer | GitBook 仅准备配置；不启用自动 AI review | ADR-0002；接入和发布另行确定 |

## M0 跟踪

本表中的 passed 仅指注明的原型子集。当前统一源码指纹与结果见 [summary.json](../evidence/m0-final-review/summary.json)，历史报告只对原版本和原测试有效。

| 编号 | 已测范围及状态 | 剩余工作、负责人和截止 |
| --- | --- | --- |
| POC-01 | passed：文本解析/码点定位/旧修订/局部 DOM 选区；证据见[复核报告](../evidence/2026-09-19-m0-closure-review.md) | M1b 已采用 PDF.js 6.3.289，accepted=true。A 8.26 独立复核本批选区/来源/生命周期并完成局部修复；正式验收仍 not-run，不沿用 M0 通过 |
| POC-02 | passed：软件时间线、原件保留、回放时长/seek/导出/重启；旧基础实机路径由用户报告 passed | 设备和硬件定位 not-run；开发者先补媒体身份/采样起点测量与恢复，用户在 M1b 实测；长录音回放仍有解码内存边界 |
| POC-03 | passed：格式探测、H.264 实际播放、有限切/拼接；HEVC 实际解码 rejected，结果已记录 | 开发者在 M2 前定后端并验证 MKV/HEVC/ASS/多音轨/VFR、长图和音画同步；[支持矩阵](../evidence/2026-09-19-m0-support-matrix.md)不撤销格式目标 |
| POC-04 | passed：实验命令/代次/提交屏障、确定性晚到结果拒绝、worker 重新启用；M1a 子范围：宿主 grant、UI Facet 启停、越权拒绝 | 第三方沙箱仍 not-run；见 [M1a 交付](../evidence/m1a-delivery.md) |
| POC-05 | M1a React 宿主已集成；旧 textarea 子集仍 passed | A 补光标换段、IME 结束保存及串行提交局部回归；完整块编辑/源编辑/历史 UI 尚缺（F-03/10）；真实输入法与 H-02 仍 not-run |
| POC-06 | M1a better-sqlite3/Drizzle/FTS5 已接入；旧 node:sqlite 实验保留 | A 补迁移 DDL 与版本发布原子性及中断重试；A 8.24 关闭本批 F-09 三个冲突组合，保留拒绝与一致来源图证据；不迁移真实 Profile，不宣布存储验收 |
| POC-07 | passed：候选 kernel 的已测契约；M1a service/UI Facet 注册、授权/幂等及本轮模块撤销子场景有复验证据 | 正式选型已 accepted；MinimalActivator 仅失败反例；第三方执行隔离仍属于 M4 |
| POC-08 | passed：假提供者关联/替换、资料包安全校验与普通错误回滚、索引/未知附件往返 | M1a 已补资料包突停识别；开发者 M2 接 Bangumi；资料包不等同整个 Profile 备份 |
| POC-09 | passed：受控 HTTP 获取、恢复、不覆盖与两个真实卷双向验证 | [当前结果](../evidence/m0-final-review/poc-09.json)；开发者 M4 重验 BitTorrent 分片/恢复/做种，不由 HTTP 结果推定 |

## 验收记录方式

AT-01—AT-62 不按一次技术报告或一次总体人工反馈全量改为 passed；已测范围以各报告具体子场景和用户确认范围为准。2026-09-21 M1a 本轮人工审查由用户报告通过。VOICE-06—08 已登记为 A-30 后续需求，尚无产品实现或测试证据。2026-09-22 的 UI-06—08 与 AT-60—62 已有 B 自检证据，产品验收和 H-01—H-05 仍 not-run。新栈 10k/50k、10 MiB TXT 与 30 MiB EPUB 有本轮合成自检；实际显示器、输入法与硬件响应仍不标通过。

最新 [summary.json](../evidence/m0-final-review/summary.json) 的 `automationStatus: tested-subset-passed` 和 `engineeringReviewable: true` 只判断本次原型证据完整且匹配源码。`m0Exit` / `m1Entry: not-assessed-see-stage-gates` 明确不自动计算阶段验收；`pendingAutomated: []` 不代表没有待开发功能。旧 `m0-closure` 部分格式证据在复核中曾因路径缺陷更新，历史版本边界见[复核报告](../evidence/2026-09-19-m0-closure-review.md)。

M0 整体退出仍单独跟踪；用户已在获知历史限制后授权推送、创建 PR，并追加授权合并两个阶段的已交付范围，不将这些操作解释为 M0 全部退出。无需再次确认已选基础库、目录、格式或参考机。运行时/宿主已正式定稿，BYOK 首版自研/PI 双 runtime 也已确定。设备项只影响依赖它的录音验收，不能把待开发缺口转交用户测试。

状态统一使用 not-run、running、passed、failed、blocked；blocked 必须注明阻塞与负责人，passed 必须限定实际版本和范围。变更使旧证据失效时保留历史，把当前受影响范围改为待验证。

## 当前推荐下一步

用户决定是否合并 [PR #3](https://github.com/chialecode/manga/pull/3)：必需检查 repository-quality 与 DCO 以 PR 为准；2026-10-03 用户授权补签并强推：分支上的 `1d0524f` 与追加提交 `99b27a6` 已归并为一个带签名的阶段提交，用 `--force-with-lease` 推送，最终 SHA 以 PR 为准。用户 2026-10-03 在新包上复查后反馈撇号显示仍有问题，决定本轮不修，按 [LOOP-04](../decisions/open-questions.md#loop-04) 放到后续阶段；行边缘拖选未单独报告结果。A [8.27](../evidence/m1b-reading-notes-delivery.md#act01-review) 已修复用户 2026-10-03 反馈的两项问题；H-02—H-05 与当前视觉按用户报告通过，标题栏按钮主题与正式界面观感随 Q-08 进入下一阶段。M1b 原有的四个未推送提交（`1919dc4`、`bd1fcbe`、`c692f58` 及其后的修复提交）已于 2026-10-03 按 A-21 归并为一个阶段提交，旧 SHA 只在历史证据中作被测版本引用；B 历史证据保留。

D0 的 12 manifest/84 项已核对，实装/分类完善按 LOOP-02；纯 UI/无关升级按既有 loop 后移。新包上的 H-01、产品验收、Q-08 最终视觉、真实模型与真实 Profile 迁移仍 not-run。产品 PDF 已切到 PDF.js 6.3.289、accepted=true；EPUB/MOBI/播放候选仍未选定。本轮按用户 2026-10-03 的明确要求推送分支并创建 [PR #3](https://github.com/chialecode/manga/pull/3)；合并与发布未执行，动画演示不代表 M2 完成。

后续按 A-33 先形成小说、漫画、动画可用试用闭环；播放/阅读状态、笔记和划线通过所属会话提供给 Agent。Q-11—13 为后续非阻塞细节，不要求现在逐项回答。
