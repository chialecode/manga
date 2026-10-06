# 当前执行状态

核对日期：2026-10-06。用例定义与需求追踪矩阵仅在[交付计划](roadmap-and-acceptance.md)维护；本页汇总实际状态并链接证据。已合并阶段的细节只在各自的阶段总结，本页不再按轮次追加。

开发顺序按 A-39：先贯通[全部基本功能 MVP](roadmap-and-acceptance.md#mvp-loop)，再根据反馈循环迭代。MVP 尚未完成；产品验收没有任何一个阶段被自动标为通过。A 的计划覆盖整个阶段（A-46）。

本页是 Agent 侧的状态入口：阶段状态、当前事实、[后续 loop](#followup-loops) 与下一步。用户需要做的事（待决定、人工检查、授权与外部配置）只在[用户待办](../../USER-ACTIONS.md)。两边互不等待：人工检查和非阻塞决定不绑定阶段，可以顺延（A-53）。

## 阶段状态

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| M0 技术与契约验证 | 已合并（[PR #1](https://github.com/chialecode/manga/pull/1)，`dc925e9`）。自动验证子集 passed；M0 整体退出不由此判定，AT-01—48 在 M0 时均未执行 | [M0 总结](../evidence/m0-summary.md) |
| M1a Agent 与可恢复基础配置 | 已合并（[PR #2](https://github.com/chialecode/manga/pull/2)，`a688713`）。A 对自动化子集的复验与用户的本轮人工审查均已记录；产品验收未签字，完整 AT 不据此标 passed | [M1a 总结](../evidence/m1a-summary.md) |
| M1b 阅读与人工记录 | 已合并（[PR #3](https://github.com/chialecode/manga/pull/3)，`5504c97`）。H-02—H-05 与当时视觉由用户报告通过；H-01 的 PDF 行边缘选区修复后**新包复核 not-run**（见用户待办 [H-01 复核](../../USER-ACTIONS.md#h-01)） | [M1b 总结](../evidence/m1b-summary.md) |
| M2 漫画、动画与语音定位 | **Agent 侧完成（A 复核收敛）；2026-10-06 用户授权 push、PR 与 CI 通过后合并（A-54，[ACT-07](../../USER-ACTIONS.md#act-07)），由 Agent 执行**：B 已按[全阶段计划](m2-media-mvp-plan.md)实施并自检，A 于 2026-10-05 集中审查；2026-10-06 用户试用后的界面与流程反馈（A-47—A-52）已由 B 按[计划第 14 节](m2-media-mvp-plan.md#14-人工反馈返工2026-10-06)的 W1—W10 一次完成，`test`、`bench`、`package`、`report` 四份证据对返工后的代码全部重跑。2026-10-06 A 复核返工（在打包版上用合成样本走查），直接修复了复核中发现的 7 处局部缺陷（对话页与书架误写无处显示的笔记、TXT 以首行命名、左栏位置不更新、日志被缩放刷屏、笔记页返回错位、窄窗胶囊笔记框压住框选条，以及推送前 `verify` 暴露的视频播放器偶尔不进入“可播放”），补了运行中附图的正向断言，关闭 LOOP-06，并在修复后的代码上重跑四份证据：必需用例 81/81、打包烟测 11 阶段（含 21 个窗口观察）通过。分支 `feat/m2-media-mvp`（基于 `5504c97`，一个阶段提交，计划与实施两个提交已按 A-21 合并），未推送。产品验收 not-run；人工检查 H-M2-01—10 与 H-01 复核均 not-run，已列入[用户待办](../../USER-ACTIONS.md#checks)，不阻塞合并与下一阶段 | [M2 交付报告](../evidence/m2-media-mvp-delivery.md)（第 16 节为返工交付，第 17 节为 A 复核） |
| M3、M4 | not-run | 目标与范围见[路线](roadmap-and-acceptance.md)；Q-06、Q-15、Q-16 到相应阶段处理 |

## 当前事实

| 项目 | 状态 | 依据 / 下一动作 |
| --- | --- | --- |
| 技术栈 | pnpm 11 hoisted workspace；Electron 44.5.1、Vite 8、React 19、Zod 4、Vitest 5、TypeScript 7、better-sqlite3 13 + Drizzle；PDF.js 6.3.289；原生 `video` + FFmpeg 8.1 LGPL + JASSUB；Silero VAD。运行时/宿主与双 runtime 已定稿 | [ADR-0007](../decisions/0007-technology-stack.md)、[M2 交付报告](../evidence/m2-media-mvp-delivery.md)的依赖升级与例外 |
| 真实调用 | Bangumi 只读（返工后 9 个请求，含角色与人员端点）与 ASR（合成 TTS）的有限契约测试已按 A-28/A-29 执行并通过；**LLM 整理与视觉/OCR 的真实调用未授权，not-run**；真实 Profile 迁移未授权 | [ACT-05](../../USER-ACTIONS.md#act-05)；产品行为由假适配器覆盖 |
| 人工反馈 | 旧原型基础实机、M1a 本轮审查、M1b 的 H-02—H-05 均为用户报告 passed，各自限于当时版本与步骤；M2 有 2026-10-06 的试用反馈（已转为返工并实施），正式人工检查全部 not-run | 阶段总结；[用户待办的人工检查](../../USER-ACTIONS.md#checks) |
| 文档治理 | 登记表有 `currentStage` 与 `retireAfter`，过期文档由检查拒绝；已合并阶段只保留三份阶段总结 | [文档治理](../governance/documentation-policy.md#stage-cleanup) |
| Git、CI 与分支规则 | main 保护保持，必需检查 `repository-quality`；所有提交带 DCO 签名（A-43）；M2 已获推送、PR、CI 通过后合并及分支清理的授权（A-54，[ACT-07](../../USER-ACTIONS.md#act-07)），PR 与合并结果在下一阶段开始时回写 | [Git 与 GitHub](../dev-rules/git-and-github.md) |
| 许可证与公开检查 | Apache-2.0；工作树/暂存检查接入统一入口；随包 FFmpeg（LGPL）、JASSUB、Silero 的许可声明见交付报告，分发决定为 Q-17 | [公开门禁](../dev-rules/quality-gates.md#11-公开内容检查) |
| GitBook、自动 AI reviewer | GitBook 仅准备配置；不启用自动 AI review | ADR-0002；[ACT-04](../../USER-ACTIONS.md#act-04) |

## M0 POC 的当前去向

passed 仅指注明的原型子集，结论与限制见 [M0 总结](../evidence/m0-summary.md)；表中“现在”列是它们今天由什么守护。

| 编号 | 已测范围及状态 | 现在 |
| --- | --- | --- |
| POC-01 | passed：文本解析、码点定位、旧修订、局部 DOM 选区 | M1b 起由 `tests/reading`、`tests/notes` 守护；PDF.js 已采用，正式验收 not-run |
| POC-02 | passed：软件时间线映射、原件保留、回放；设备与硬件定位 not-run | 已由 M2 的录音与位置映射产品测试替代并从 `experiments/m0` 移除；设备项见用户待办 [H-M2-06](../../USER-ACTIONS.md#h-m2-06) |
| POC-03 | passed：格式探测、H.264 实际播放、有限切/拼接；HEVC 解码 rejected 已记录 | M2 按“容器 × 编码 × 音频 × 字幕 × 播放路径”重测，见 [M2 交付报告](../evidence/m2-media-mvp-delivery.md)的支持矩阵；原型用例需带 x264/x265 的系统 FFmpeg，缺少时跳过 |
| POC-04 | passed：命令/代次/提交屏障、worker 重新启用；M1a 起有宿主 grant 与 UI Facet 启停 | `tests/runtime`；第三方沙箱仍属 M4（Q-06） |
| POC-05 | passed：旧 textarea 编辑基础 | M1b 重建新编辑器；真实输入法由用户报告通过（H-02），不继承 |
| POC-06 | passed：单写入、CJK 检索、崩溃边界、备份往返 | 生产存储为 better-sqlite3 + Drizzle，`tests/library`、`tests/package`；不迁移真实 Profile |
| POC-07 | passed：候选 kernel 的已测契约 | ADR-0005 已 accepted；`tests/runtime`；第三方执行隔离属 M4 |
| POC-08 | passed：假提供者关联/替换、资料包校验与往返 | M2 起由 Bangumi 与多来源元数据产品测试替代并从 `experiments/m0` 移除；资料包导入导出由 `tests/library` 守护 |
| POC-09 | passed：受控 HTTP 获取、恢复、不覆盖与两个真实卷双向验证 | 仍由 `experiments/m0` 守护；M4 获取替代后删除，BitTorrent 不由 HTTP 结果推定 |

## 验收记录方式

AT-01—AT-68 不按一次技术报告或一次总体人工反馈全量改为 passed；已测范围以各报告具体子场景和用户确认范围为准。M0 的 POC passed 只指注明的原型子集；POC-09（获取）由保留的 `experiments/m0` 回归守护，到 M4 获取替代后退出。设备项只影响依赖它的录音与播放验收，不能把待开发缺口转交用户测试。

状态统一使用 not-run、running、passed、failed、blocked；blocked 必须注明阻塞与负责人，passed 必须限定实际版本和范围。变更使旧证据失效时保留历史，把当前受影响范围改为待验证。阶段报告脚本（`node scripts/stage.mjs <阶段> report`）只核对证据完整且指纹匹配，`productAcceptance` 固定为 not-run，不计算阶段验收。

<a id="followup-loops"></a>
## 后续 loop（Agent 侧）

按 A-39，先贯通[全软件基本功能 MVP](roadmap-and-acceptance.md#mvp-loop)，再根据反馈持续迭代。本表是 Agent 侧非阻塞后续项的唯一入口，执行仍引用对应阶段的唯一计划；需要用户决定的产品取舍另进[用户待办](../../USER-ACTIONS.md)的 Q 项。这里的“可延期”要求：基本路径可用，影响可以隔离，不破坏引用、权限、数据或恢复，也不撤销当前必需门禁。发现实际阻塞时升级回当前修复，不因曾登记 LOOP 就永久忽略。

| 编号 / 状态 | 已知范围、影响与可用替代 | 负责人 / 承接循环或触发点 | 复测与退出 |
| --- | --- | --- | --- |
| LOOP-03 可后移 | 非基本闭环必需的 bot/设计自动化与维护便利性；现有本地检查继续工作，外部启用归用户待办 ACT-04 | 开发者/维护者；MVP 基本链路期间有实际维护瓶颈时或后续工程循环 | 本地规则有真实使用方、权限最小、避免重复 bot；不启用未授权 App/外部调用 |
| <a id="loop-04"></a>LOOP-04 待用户复查 | PDF 组合字符显示：合成样本中分解形式 e + U+0301 的撇号没有正确叠在 e 上。M2 的 L1 用带真实嵌入字体与组合定位的样本对照，确认 PDF.js 绘制与产品均正确，问题出在旧合成样本的字体；生成器已修，新样本为 `dist/samples/m2/reading/combining-marks.pdf`，对照数据见 [M2 交付报告第 10 节](../evidence/m2-media-mvp-delivery.md#10-实施决定与发现a-审查关注)。文本层与存储为 NFC `é`，选区、笔记和来源不受影响 | 开发者；用户 2026-10-03 决定 M1b 不修，由 M2 的 L1 处理 | 用户待办 [H-01 复核](../../USER-ACTIONS.md#h-01)通过后关闭 |
| <a id="loop-05"></a>LOOP-05 已登记 | Agent 任务的图像材料（漫画区域图、视频帧）以 JPEG 字节冻结在 `agent_runs.snapshot_json`，每任务 ≤ 4 MB，保证重试与恢复发送同一画面；运行记录随使用增长，完整备份随之变大。列表不读取该字段，资料包不导出运行记录，不影响当前功能（M2 A 审查对交付报告问题 B 的结论） | 开发者；M3 前的工程循环，或单个资料库的运行记录超过 1 GB 时 | 改为内容寻址的附件引用，给已结束运行的图像定保留期（到期只保留来源与尺寸，可按来源重新提取）；迁移保留旧快照可读，重试仍发送同一画面 |
| <a id="loop-07"></a>LOOP-07 已登记 | 右栏的长会话：（1）消息列表没有虚拟化，1000 条消息约 2.6 万个节点，打包窗口里输入到提交并布局的 p95 在开发机上为几十到一百多毫秒（记录项，不设门槛，见 [M2 交付报告第 8 节](../evidence/m2-media-mvp-delivery.md#8-性能与基准原始数据)）；（2）向上翻出的更早消息在之后的整页刷新（如主机通知）时折回最新一页，需要再点一次“更早的消息”。不丢数据，笔记与提问照常；M2 A 复核决定不在本阶段处理 | 开发者；单个会话的消息常超过几百条、用户反馈右栏卡顿，或 M3 的长会话工作开始时 | 列表虚拟化（优先评估成熟开源实现）并保持“贴底”与跳转来源；刷新时保留已翻出的页、处理其间被删除的旧消息；1000 条消息的输入延迟与滚动在打包窗口里有门槛并通过 |

已关闭：LOOP-01（M2 的 P6 按参考图重做资源库、三种阅读/播放页与右栏，页面、组件与数据 hooks 分离；最终视觉仍由 Q-08 评审）与 LOOP-02（Electron 44.5.1 等主版本升级后完整回归与打包烟测通过，保留旧版的 8 项例外及复查条件见 [ADR-0007](../decisions/0007-technology-stack.md)），均由 M2 A 审查按各自退出条件关闭，见 [M2 交付报告第 14 节](../evidence/m2-media-mvp-delivery.md#14-a-集中审查2026-10-05)。<a id="loop-06"></a>LOOP-06（打包烟测 formats 阶段的 PDF 选区偶发失败）由 M2 A 复核于 2026-10-06 关闭：PDF 页只在打开宽度绘制一次，之后的宽度变化去抖；formats 阶段负载下连续 10 次通过，A 复核时完整 `package` 再次通过，`loop06` 显示单次绘制、选中节点仍在文档中、未重绘，见 [M2 交付报告第 17 节](../evidence/m2-media-mvp-delivery.md#17-a-复核返工2026-10-06)。

后续发现的非阻塞缺陷新增具体 LOOP 条目，保留原 finding ID 与证据，不把所有未来功能打包成一个永远待办。尚未实现的 MVP 基本功能归路线的当前开发工作，不能登记为“MVP 后优化”而跳过。

## 当前推荐下一步

M2 已由 B 完成返工、A 复核收敛（[交付报告第 17 节](../evidence/m2-media-mvp-delivery.md#17-a-复核返工2026-10-06)），Agent 侧没有未关闭的必需项。用户已于 2026-10-06 授权 [ACT-07](../../USER-ACTIONS.md#act-07)（A-54），Agent 执行 push、PR、CI 通过后合并和分支清理。合并后的首选下一步是 M3 的 A 规划：从更新后的 `main` 建立 M3 分支，并按 [A-45](../governance/documentation-policy.md#stage-cleanup) 把 M2 计划与交付报告提炼为阶段总结后删除。人工检查与待决问题在[用户待办](../../USER-ACTIONS.md)里由用户随时处理，不阻塞以上任何一步。
