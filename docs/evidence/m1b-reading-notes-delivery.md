# M1b 阅读与人工记录交付

| 字段 | 内容 |
| --- | --- |
| 角色 | Agent B 实施自检与本轮返工；本文件已追加 Agent A 集中审查。不是 M1b 产品验收 |
| 计划 | [m1b-execution-plan.md](../delivery/m1b-execution-plan.md) 第 14.6 节；历史复核对象为 `bd1fcbe`（父 `1919dc4`）；2026-10-03 起与后续提交一起归并为一个 M1b 阶段提交，旧 SHA 只作被测版本引用 |
| 基线 | `main` @ `a688713` |
| 分支 | `codex/m1b-reading-notes` |
| 证据 | ACT-01 修复为 `docs/evidence/m1b-reading-notes/act01-fix`，A 8.26 为 `a-b11-review`。最新 B 为 `docs/evidence/m1b-reading-notes/b11-pdfjs-text`，M1a 为 `docs/evidence/m1b-m1a-regression/b11-pdfjs-text`。A 的 `a-b10-review` 与更早的 `b10-pdfjs-mvp`、`a-b9-review`、`b9-rework`、`a-b9-rework-review` 保留 |
| 产品验收 | not-run |
| A 审查 | 2026-09-25：8.24 对 `bd1fcbe` 复核为 rework-required，该结论保留；B 8.25 自检后由 A 8.26 独立复核收敛。2026-10-03 用户 ACT-01 反馈后的修复与自检见 8.27 |

第 1—6 节保留 B 在原实施版本上的历史自述。A 的审查结论留在第 8 节相应小节，不改写。B 最新交付见第 8.25 节，A 的独立复核见第 8.26 节，用户 ACT-01 反馈与修复见第 8.27 节，当前交接见第 9 节。旧跑次的指纹不能用来证明本轮源码。

## 1. 实现范围

阅读与人工记录落在现有产品服务和桌面壳上。资料库 schema 从 v4 备份后升到 v5，只追加全文分块列。笔记旧 schema v1 载荷保持原样，读到内存时升到文档 schema 2。TXT、EPUB、MOBI、PDF 使用仓内适配器，`PARSER_CANDIDATES` 的 `accepted` 全部为 false。布局偏好写在 `config` 键 `shell.layout`，不复用 `settings.setLayout`。

桌面壳按视口停靠或浮出左右栏，悬停离开延迟 180 ms，Esc 关闭未固定浮层并回到触发按钮。工作模式只切换爱好者/创作者文案和已交付入口。阅读行宽与壳宽分开。笔记编辑器以块文档为准，Tiptap 与 CodeMirror 6 是两种视图。

保留 M1a 的授权、恢复、任务快照、工具回执、用途隔离、目录与原件保护，以及模块停用后的晚到结果屏障。Agent 发送时把选区和笔记修订冻进 `snapshot_json`。防剧透默认关闭；打开后未读范围不进入枚举授权检索，跳转本身不扩大已读范围。

## 2. 本轮命令

证据目录 `docs/evidence/m1b-reading-notes/b-final`。`node scripts/verify-m1b.mjs` 在 `M1B_REQUIRE_REPORT=1` 下退出 0。`report.json` 的 `automationStatus` 为 `self-check-passed`，`productAcceptance` 为 `not-run`，`errors` 为空。

| 命令 | 结果 |
| --- | --- |
| `node scripts/m1b.mjs test` | 退出 0。Vitest 19 passed，含 10 MiB TXT 与 30 MiB EPUB 末段 |
| `node scripts/m1b.mjs bench` | 退出 0。10,000 条元数据、50,000 个检索块 |
| `node scripts/m1b.mjs package` | 退出 0。Windows x64 未签名包 |
| `node scripts/verify-m1b.mjs` | 退出 0。指纹一致 |
| `node scripts/verify.mjs` | 退出 0。文档、依赖边界、M1a 与 M1b 测试及审查用例通过 |

`report.json`（2026-09-21T17:18:55.159Z）指纹：源码 `b1e0945bf0155ce4e73a7ba5f53c4c1a7aa026943a831aca5f18789150f2c3e2`，M1b 源码 `6743d89931039faced52e40b923cad8dc872a2b109fce64a5dee30f426cd3643`，锁文件 `a6699b8bf09cba2192f10323919f96261298f3d188418c4b2c0e345af44ab192`，测试脚本 `7768022a1a7e1e11bba0d4a379ee7e09e2a4729f17df97bbb444c4667484ca9a`，构建脚本 `a3167dfa8fbaf998ba247b8dd7474d5cb59a171f8b03daa015dcaa7b3c538d07`。文档改动不计入这些指纹。

性能自检（服务计时，不是可操作 UI 的全部）：检索 p95 0.49 ms，上下文 p95 0.64 ms，已索引首屏 p95 0.54 ms，笔记保存 p95 0.86 ms，进度保存 p95 1.09 ms，进程冷启动 p95 18.8 ms。重解析与解析期间的 `workspace.get` 另记在 `bench.json` 的 `reparseMs`、`duringParseMs`。Electron 点击 p95 2 ms，样本种类为 `electron`。这些数字只说明本机合成库未超过需求 6.2 的自动门槛。

稳定包路径（B 原证据）`dist/m1a-package/MANGA-win32-x64`；A 修复后新包统一输出 `dist/desktop/packages/MANGA-win32-x64`。烟测阶段 `initial`、`restart`、`agent`、`agent-restart`、`reading` 均为 passed。阅读阶段记录的 CSS 视口：1280×840 与 720×540，`devicePixelRatio` 1.5。截图在同一证据目录：`ui-smoke-initial.png`、`ui-smoke-initial-library.png`、`ui-smoke-restart.png`、`ui-smoke-agent.png`、`ui-smoke-agent-copilot.png`、`ui-smoke-agent-restart.png`、`ui-smoke-agent-restart-copilot.png`、`ui-smoke-reading.png`。阅读截图是烟测结束时的 720×540 窗口。

M1a 回归使用 `docs/evidence/m1b-m1a-regression/b-final`，不覆盖 `docs/evidence/m1a-f24-f32/`。结果见第 6 节。没有第二次执行 `node scripts/m1a.mjs package`；同一二进制上的 M1a 烟测阶段已包含在上面的 M1b 包命令里。

## 3. 自动用例

| 编号 | 状态 | 证据 |
| --- | --- | --- |
| G-01 / POC-01 剩余格式与长文 | passed（自检） | 四类候选、损坏/加密/扫描页、zip 路径与压缩比、worker、10/30 MiB 末段 |
| G-05 / POC-05 编辑器子集 | passed（自检） | 拆分、复制、冲突候选不落库、组字期间不保存、v4 库中的 v1 笔记 |
| G-06 / POC-06 索引与恢复子集 | passed（自检） | 4,000 字以后的中文尾部、未读过滤、选区快照、提交中断后笔记不存在 |
| AT-60 | passed（自检） | 悬停浮层与 Esc 焦点；宽窗停靠 |
| AT-61 | passed（自检） | 模式菜单方向键与 Esc |
| AT-62 | passed（自检） | 主面板剩余宽度与阅读行宽 680 分离 |

解析后端没有被标成 accepted。历史 M0/M1a passed 不记入本表。

## 4. 人工步骤

下表是待执行步骤，不是通过记录。

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| H-01 | not-run | 无模型导入合成书、读到末章、选区评论、来源返回、重启 |
| H-02 | not-run | 真实中文输入法、选词、粘贴、跨块撤销和源编辑 |
| H-03 | not-run | 宽屏、1280×840、960×640、720×540、800×1200，以及 100%/125%/150% 的人工核对。包烟测只自动记录了 1280×840、720×540 和本机 1.5 倍缩放 |
| H-04 | not-run | 长标题拖动、最大化、贴靠，以及任务运行中的纯键盘模式切换 |
| H-05 | not-run | 合成备份/资料包的人工阅读，以及宽窗行宽的视觉确认 |

B 原始包启动步骤已不再作为推荐入口。A 复核包/开发入口：先在仓库根执行 `pnpm install --frozen-lockfile`，再执行 `pnpm dev`；脚本自动准备 Electron 37.4.0 x64 的 better-sqlite3 ABI，并把开发数据放到 `dist/desktop/development`。审查包运行 `node scripts/review-m1b-ui.mjs`，它使用 `dist/desktop/packages/MANGA-win32-x64` 和独立合成 Profile。不要把开发目录或真实资料库指给测试。

## 5. 当前集中待处理

B 已完成第 8.2—8.5 节的复核。当前没有必须由用户先决定才能交给 A 的事项。A 复核后才安排完整 H-01—H-05。解析候选保留 `accepted=false`，当前证据不足以推荐生产定稿。Q-08 最终视觉基线和 Q-11—13 后续细节集中到相应阶段。没有 push、PR、合并、发布或真实 Profile 迁移授权。

## 6. M1a 回归

命令：

```powershell
$env:M1A_EVIDENCE_DIR='docs/evidence/m1b-m1a-regression/b-final'
node scripts/verify-m1a.mjs
node scripts/m1a.mjs bench
```

2026-09-22 该目录上的命令退出 0。`node scripts/verify-m1a.mjs`：Vitest 94 passed、4 live skipped，F-24—F-32 用例 passed；因为该目录没有 M1a `package.json`，报告门禁 `reportEvaluated` 为 false。`node scripts/m1a.mjs bench`：10,000 元数据 / 50,000 块，检索 p95 0.38 ms，保存 p95 6.99 ms，上下文 p95 0.30 ms，冷启动 p95 18.9 ms，Electron 点击 p95 4 ms。这些数字只证明保留范围，不代替第 2 节。

## 7. 用户本次体验反馈

| 用户标注 | 反馈及处理边界 |
| --- | --- |
| H-01 | 排版混乱、操作不明、保存后拆分意义不清；阅读跳笔记后按钮失效。局部换段/对象绑定已修，整体阅读记录工作流仍须返工。 |
| H-02 | 中文组字时拆分异常；微信输入法期间显示已保存。已补 compositionend 保存及真实状态，真实微信/微软输入法复测尚未执行。 |
| H-03 | 窗口/导航预期不符；要求标题最左端图标。图标与宽窗恢复常驻已局部调整。 |
| H-04 | 模式移到左栏顶部；功能与打开会话分区；每个资源/工程有自己的 Agent/上下文/环境。位置已调整，会话实现见 F-05。 |
| H-05 | 无法缩成手机比例。解除 720 宽硬下限，补 360 × 780 CSS 视口验证；这条反馈与原 H-05 备份清单不同，不视为原清单已执行。 |

用户同时要求美观易懂、宽窗常驻侧栏不遮挡主面板、低占用媒体会话、明确启动与人工步骤、统一生成物。正式 H-01—05 按会话要求保持 `not-run`，上述负面体验保留且不得改写成 passed。

## 8. A 集中审查与返工

审查基于实施提交 `2d604a8`，并运行了定向 Vitest、TypeScript、文档检查、Electron Windows x64 打包与 `pnpm dev` 隔离启动。A 已直接修复并验证以下局部问题：

- P2：拆分按钮现在在编辑器光标处换段，保留块/锚点身份；组字结束会补保存，保存请求串行使用服务端新修订；笔记编辑器按对象重建，避免从阅读跳到另一笔记时继续写旧对象。
- P2：选区记录使用实际 DOM 选区的码点范围，禁止把整段 slice 当作选区；没有选区时记录按钮不可用。
- P2：窗口最小尺寸降为 360 × 360，侧栏图标位于标题最左端，宽窗侧栏参与布局，窄窗才产生浮层，窄窗 Esc 取消固定浮层并恢复焦点；开发启动自动选择 Electron SQLite ABI。
- P1：新增 `notes.get` 对无来源独立笔记的枚举授权缺口已修复；防剧透对直接正文/快照读取补边界检查；ZIP/PDF 解压增加实际输出上限，防止伪造声明大小绕过预算。
- P1：v4→v5 DDL 与版本发布放入同一事务，并增加升级中断后的重试回归；生成物改为 `dist/desktop` 分区。

最终源码对应的证据在 `docs/evidence/m1b-reading-notes/a-final`；中间跑次保留到本地忽略目录 `dist/desktop/review-runs/a-intermediate-report`，未覆盖 B 历史证据。

| 最终检查 | 实际结果与范围 |
| --- | --- |
| `node scripts/verify.mjs` | 退出 0；文档/公开检查/依赖边界/两套类型检查；M1a 94 passed、4 live skipped；M1b 快速子集 25 passed、2 large skipped；既有契约/修复回归 15 passed；报告反例通过 |
| `M1B_EVIDENCE_DIR=docs/evidence/m1b-reading-notes/a-final` 下 `node scripts/m1b.mjs test` | 退出 0；27 passed，含 10 MiB TXT / 30 MiB EPUB；见 [test-run.json](m1b-reading-notes/a-final/test-run.json) |
| 同目录 `node scripts/m1b.mjs package` | 退出 0；Windows x64 未签名包，initial/restart/agent/agent-restart/reading 五阶段；见 [package.json](m1b-reading-notes/a-final/package.json) |
| 同目录 `node scripts/review-m1b-ui.mjs` | 退出 0；真实 Electron + Playwright：两次阅读→选区→笔记、对象切换/保存目标、光标换段、精确选区范围、宽窗侧栏恢复、左栏模式菜单和 Esc；1280×840、360×780 CSS 视口，DPR 1.5，无壳级横向溢出；见 [a-ui-review.json](m1b-reading-notes/a-final/a-ui-review.json) 与同目录截图 |
| `pnpm dev -- --m1a-smoke` | 退出 0；开发启动自动选择 Electron SQLite ABI；日志 `dist/desktop/development/profile/logs/smoke-initial.json` 的 channel 为 development、status 为 passed |
| 独立 `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/a-final` 下 `node scripts/audit-m1a-reverify.mjs` | 退出 0；迁移晚到/旧根恢复/快照旧修订/工具回执续跑反例均未重现，见该目录 `audit.json` |

最终 `m1bSourceFingerprint` 为 `f98621d2b855300491377803c409eba1e98f323b990cb3b581d983f01d2569ae`，包、测试和 A UI JSON 一致。未重跑性能基准，未生成 A 的完整 `report.json`，不沿用 B 的性能数值或 `self-check-passed` 作为新版本全面通过。真实输入法、系统拖动/贴靠和 100%/125%/150% 人工检查仍未执行；截图确认这里只修复局部结构，整体视觉与操作组织仍未收敛。

| 计划 | A 判断 |
| --- | --- |
| P0/P6 | 有真实命令/指纹/包，但旧必需用例映射过窄，无法证明全部计划完成；F-08 |
| P1 | 契约及 v4 升级局部验证可复用；完整格式/编辑/恢复门槛未关闭；F-03/07/09 |
| P2 | 局部壳修复通过；资源会话与真实右栏助手未实现；F-05/10 |
| P3 | 全文尾部可检索，实际阅读恢复/格式页面/设置仍缺；F-01/06/07/10 |
| P4 | 局部编辑/选区修复通过，完整编辑与来源闭环仍缺；F-01/03/10 |
| P5 | 部分索引/授权/快照有证据，模型材料与冲突库恢复未完成；F-04/09 |

以下问题需要 B 按同一计划一次性返工，不能让用户用人工步骤替代缺失实现。上表列出 A 审查时的触发现象与要求，B 的逐项处理见 8.2。

| 编号 | 严重度 | 触发与实际结果 | 预期/要求 | 位置与验收 |
| --- | --- | --- | --- | --- |
| F-01 | P1 | 从笔记进入来源没有可操作来源卡片；`notes.openSource` 虽注册，UI 没有调用，无法从笔记跳回正文或返回原笔记位置 | 阅读→记录→来源跳转→返回闭环；失效来源有状态和修复入口 | `apps/desktop/src/renderer/App.tsx`、`note-editor.tsx`、`reading.tsx`；补 UI/服务调用、重启后定位、AT-04/05/52 |
| F-02 | P1，已修复 | 选中正文少量文字会保存整段 slice 范围 | 保存实际选区的码点 `[start,end)`，重复句保留锚点恢复信息 | `reading.tsx`；A 定向回归与 `a-final` |
| F-03 | P1 | 记录页没有标题/列表/引用/代码/纯文本块的可发现创建与切换；CodeMirror 改后未更新 Tiptap，下次富文本输入可覆盖源编辑结果；源编辑未纳入组字保护，窗口关闭/页面离开没有可靠的持久草稿/保存失败恢复 | 两种视图共用权威块状态、撤销历史与 IME 屏障，跨视图/关闭不丢编辑；块拆合/复制/移动同步 refs，保留未知载荷 | `note-editor.tsx`、`packages/app-core/src/domain/note-document.ts`、`reading-service.ts`；G-05/AT-05/16/17 |
| F-04 | P1 | 阅读页的 `noteSelection` 只创建笔记并跳页；Agent 发送仍只取手工 `materials`，没有把当前资源、选区、笔记修订接入上下文栏和发送快照的可见路径。`runAgentLoop` 只读取 history/connectionId，`snapshot.selection/notes` 未进入模型消息；笔记快照只有标题/修订，没有正文或按修订读取的保证 | 右侧 Agent 绑定当前资源/工程会话；发送时冻结并显示实际材料/版本，工具/模型请求可核验 | `App.tsx`、`product-app.ts`、Agent pane/context contract；AT-09/10/24 |
| F-05 | P1 | 模式菜单已移入左栏，但左栏仍只是功能按钮，没有下方“已打开资源/工程会话”和每会话独立右侧 Agent/上下文/环境 | 爱好者资源会话、创作者工程会话有独立身份与任务隔离；切换不串目标，非活动媒体可休眠 | `App.tsx`、`shell.tsx`、workspace/session schema；A-32、AT-61/62；工程会话后续 M3 |
| F-06 | P1 | `readDocument` 返回 progress，但 renderer 忽略它；打开资源总是从首段开始，没有恢复定位/已读范围展示 | 重启/切换后恢复 `lastLocator`，跳转不扩大已读范围，正文/Agent 可查询当前状态 | `reading.tsx`、`App.tsx`、`reading-service.ts`; AT-04/52、CTX-01/03 |
| F-07 | P1 | PDF 把流而非 Page Tree 当页面（多内容流/字体/图片流可错页），扫描页没有图像可读；EPUB 只计数插图/CSS 后丢弃显示内容，MOBI HTML 直接成为正文；当前自建夹具不能证明真实格式定位 | 使用有依据的解析适配方案完成页/部件身份、插图/固定页显示及独立来源样本；候选仍 accepted=false，不以文件扩展名宣称完整支持 | `formats.ts`、`reading-service.ts`、`reading.tsx`; G-01/AT-52 |
| F-08 | P1 | B 的包烟测只点开阅读导航，没有导入合成书→阅读末段→记录→来源→重启的端到端闭环；必需用例映射把少量 jsdom/服务测试作为 G/AT 通过 | 基于本计划补匹配范围的实际 App/Electron 和失败路径；性能从操作到内容可用/保存回执计时，不能只测 click dispatch；A 本轮局部 UI 回归不关闭完整缺口 | `scripts/package-m1b.mjs`、`scripts/m1b-required-cases.json`、`scripts/bench-m1b.mjs`；P6、AT-04/05/52/60—62 |
| F-09 | P1 | P5 要求冲突库预览后导入；`importLibraryPackage` 在任何非空库直接拒绝，UI 无导入预览/冲突选择；托管书籍附件往返后缺少 `file_locations` 重建 | 实现空库/冲突库预览、ID/修订冲突策略、引用重映射与托管媒体定位恢复；保留原件和未知附件；不得修改无授权 Profile | `packages/app-core/src/domain/library-package.ts`、资料包契约/界面；AT-18/48，合成包及提交中断反例 |
| F-10 | P2 | 阅读器只有固定样式值，没有字体/行距/边距/三背景设置入口；没有可用书签、结果跳转、前后阅读导航；笔记缺独立创建/标题/标签/搜索/历史 UI | 按 READ-01、NOTE-01—04 提供可发现操作与空/错/加载状态，并用真实内容截图核对正文行宽和工具分层。三背景/边距是本轮新增明确要求，视觉数值仍可调整 | `App.tsx`、`reading.tsx`、`note-editor.tsx`；P3/P4、AT-05/16/62 |


用户反馈的 H-01—H-05 负面结果已作为上述问题和 A-32 的依据记录；按本轮要求正式 H-01—H-05 状态仍为 `not-run`，修复后需重新执行。解析候选 `accepted=false` 保持不变；M1a 授权、恢复、任务快照/工具回执、用途隔离、目录/原件保护和生命周期屏障回归保持有效。A-33 的小说/漫画/动画优先方向已同步需求、路线和待决事项；小说样式要求细化本计划 P3/F-10，漫画与动画功能留到后续阶段，不扩入本轮返工。

### 8.2 B 返工：逐项实现位置与实测结果

返工在 `codex/m1b-reading-notes` 上连续进行，保留规划提交 `78a6fca` 与 A 的局部修复。本轮从头复核已有实现后，证据目录改为 `docs/evidence/m1b-reading-notes/b4-recheck`（独立跑次，不覆盖 `b-final`、`a-final`、`b3-rework`）。表中“实测”列都是本轮真实执行过的命令或测试名。`report.json` 的 `automationStatus` 为 `self-check-passed`，`productAcceptance` 为 `not-run`。

| 编号 | 实现位置 | 实测 | 剩余限制 |
| --- | --- | --- | --- |
| F-01 | `App.tsx`（`openNoteSource`/`backToNote`/`repairNoteSource`、`note-stale-banner`、返回原块）；`note-editor.tsx`（带锚点的块才显示 `note-block-source-*`）；`reading.tsx`（`reading-source-card`、`reading-source-quote`、修复入口、`reading-part-source`）；`preload/index.ts` 的 `choosePath` 桥；`reading-service.ts`（命令走 `openNoteSourceDetail`，已删除会在指名块没有来源时退回 `sources[0]` 的 `openNoteSource`） | 服务：`re-points a note whose source revision is gone and keeps the link usable`、`never opens another block's source for a jump that names one block`、`stops asking for a file the user already re-picked while the note keeps its own revision`；jsdom：点击 `note-block-source-quote`，无锚点块没有来源按钮；包内真窗：`b4-recheck/b2-ui-review.json` 的导入、失效文件修复、返回原笔记位置；烟测 `sourceCardOk`/`restoredSource` | 修复只按引文唯一命中重定位；引文消失时保留“待处理”状态，需要用户重新指定文件。未验证真实收藏的旧修订迁移 |
| F-03 | `note-editor.tsx`（块级工具栏、`record/undo/redo` 文档级共享历史、`onUpdate` 不回写 Tiptap、源编辑组字屏障、草稿与失败重试以服务端修订串行保存、`noteAttrs` 保留未知载荷）；`domain/note-document.ts`（`copy`/`split` 不复制锚点、保留 `attrs`）；`reading-service.ts`（`noteRefMutations` 在每次提交边界同步 refs，删除块去掉链接、修订回滚恢复链接） | 服务与 jsdom：G-05 全部 7 条、`keeps an unknown block payload through a replace`、`drops the source link when its block is removed and restores it with the revision`；包内真窗：`shared undo and redo across the block document` | 真实微软拼音/微信输入法与系统关闭窗口仍属 H-02，未执行 |
| F-04 | `product-app.ts`（`materialContextMessage` 写入 `snapshot_json`，`runAgentLoop` 使用冻结文本，`getRun` 返回 `contextText`）；`agent-surface.ts`（`resolveAgentSurface` 按当前页决定资源、笔记与选区）；`App.tsx`（发送走该表面，随后 `refresh(sid)` 加载同一会话的运行） | 服务：`freezes the material context message with the run so the model request can be checked`、`freezes the selection into the agent snapshot`；`tests/m1b/agent-surface.test.ts` 5 条（另一本书的残留笔记不进入材料、属于该书的笔记进入、副驾驶跟随所选会话、笔记会话使用自己的来源、笔记页不附上另一本打开的书）；包内真窗：`the composer sends what the bound pane shows`；闭包烟测从阅读页选区、`reading-select-agent`、作曲框与 `agent-send` 得到 `materialsFromUi` 与 `materialsFrozen`，重启后 `restoredMaterials` | 只覆盖文本材料；真实模型连通性未测（无凭据），工具循环仍按既有 M1a 证据 |
| F-05 | `product-app.ts`（资源、笔记与 `project` 都按 `kind`+`target_id`+`mode` 复用；未知 kind 返回校验错误）；`shell.tsx`（`shell-sessions`、`data-kind`/`data-current`）；`App.tsx`（`ensureBoundSession`、作曲键跟随当前表面） | 服务：`keeps a note session apart from the book session and from the other work mode`（同一工程目标与模式复用，另一模式另开会话）、`gives each resource its own agent session and freezes the visible materials`；jsdom：`shows the opened resource sessions under the left navigation`；包内真窗：`one rail lists resource and note sessions apart` | 创作者工程工作台仍留在 M3，本轮只稳定会话身份；非活动媒体休眠仍留在 M2 |
| F-06 | `reading-service.ts`（`readDocument` 用 `lastLocator` 计算窗口起点，`restoredFrom` 只在定位可解析时为 `progress`，`mergeConsumedRanges` 合并重复已读段）；`reading.tsx`（`data-restored`/`data-offset`，查找命中把该命中的 `end` 传给跳转）；`App.tsx`（书签跳转不调用进度保存） | 服务：`restores the slice at the stored offset and merges repeated consumed ranges`、`restores the stored reading position and never marks a jump as read`；jsdom：书签范围高亮，命中跳转参数为 `("body", 2, 7)`；包内真窗：`a bookmark jump draws the stored range and reports the position`；闭包烟测 `uiTailVisible`、`progressAtTail`，书签之后 `progressStillAtTail`，重启 `uiRestoredTail` 且 `restoredProgress` 要求偏移大于 0 | TXT 首窗 1200 个码点，恢复起点为已存偏移前 200 字，检索分块 4000 字；长文按需加载未做虚拟滚动 |
| F-07 | `domain/formats.ts`（`PdfReader` 解析经典 xref/xref 流/ObjStm、继承 `/Resources`、内容流 `/Name Do` 绘制的图像、缺页不静默丢弃；EPUB 每章插图与固定布局；MOBI `recindex`/`kindle:embed`）；`scripts/build-m1b-samples.py` + `tests/m1b/external-samples.test.ts`（CPython 独立生成的 EPUB/对象流 PDF/PalmDOC MOBI 样本，SHA-256 记录在 `manifest.json`） | G-01 全部 18 条，含 `reads an EPUB written by an external zip writer`、`reads a PDF whose page tree and inherited resources live in an object stream`、`reads a PalmDOC compressed MOBI with recindex and kindle:embed images`、`records the external toolchain that produced the samples`、10 MiB/30 MiB 长文末段 | 解析候选仍 `accepted=false`；样本为自建合成件，不等于真实出版的复杂排版；扫描页只标记图像、未做 OCR |
| F-08 | `apps/desktop/src/main/index.ts`（`closure`/`closure-restart`：约 1490 字合成书，窗口内点 `reading-more` 看到 `chi-close-tail`，记录真实选区，来源卡片与返回，样式与书签，阅读页作曲框发送并比对 `agent-context-text`，重启后打开该书并看到末段）；`scripts/package-m1b.mjs`（断言 `materialsFromUi`、`uiTailVisible`、`progressAtTail`、`progressStillAtTail`、`uiRestoredTail`，closure 阶段超时 120 秒）；`scripts/bench-m1b.mjs`；`scripts/review-m1b-reading.mjs` | `node scripts/m1b.mjs package` 退出 0，7 个烟测阶段 passed；`node scripts/m1b.mjs test` 在 `M1B_REQUIRE_REPORT=1` 下退出 0，Vitest 70 passed / 0 failed；`cases.json` 10 个必需用例 passed；`node scripts/review-m1b-reading.mjs` 14 项观测 passed；`bench.json` 含操作级 `contentAvailableP95Ms`/`saveReceiptP95Ms`/`importToReadableP95Ms` | 打包烟测仍是合成 Profile。A 的 `review-m1b-ui.mjs` 未改断言，CSS 修复后连续两次退出 0 |
| F-09 | `domain/library-package.ts`（空库/冲突库预览、逐行决策含 `resource_revision`、`decidedAction` 继承、`remapLocator` 同步锚点/进度/书签的 `representationId`、托管附件重建 `file_locations`、未知附件保留、`empty` 覆盖阅读状态）；`contracts/library-package.ts` + `inputs.ts`（`bookmarks` 清单与决策 kind）；`App.tsx`（预览面板、逐项选择、导出入口） | 服务：`previews a conflicting package and imports it with a chosen strategy`、`applies a per-row revision decision and remaps the revision inside a stored locator`、`restores hosted media locations and preserves unknown attachments across a package round trip`、`treats a library that only holds reader state as non-empty`；包内真窗：`package export, preview and one decision per conflicting row`、`the chosen per-row strategy is what the import applies` | 空库导入仍要求目标库为空（冲突库走预览+策略）；资料包不含凭据；未跑真实大库往返 |
| F-10 | `reading.tsx`（字号/行距/边距/行宽/三背景 + 夜间、章节前后导航、命中跳转与空结果、书签新增/删除/高亮、扫描页与插图占位、源文件提示）；`App.tsx`（笔记独立创建、标题与标签内联编辑、搜索/标签筛选、历史与修订恢复、加载/空/错误状态）；`note-editor.tsx`（块类型工具栏） | jsdom：`reading surface` 四条 + `creates and switches every required block type from the toolbar`；服务：`supports note tags, listing, search, history and revision restore`、`keeps bookmarks, reader style and image parts addressable`；包内真窗：`inline note title and tags`、`note search result and empty state`、`reader font, line height, margin and background`、`reading column and reader style in the real window` | 视觉数值仍可调整（Q-08 未定基线）；夜间/护眼/书本黄只做了背景与前景对比，未做完整主题细化 |

### 8.3 本轮发现并修复的额外缺陷

除 A 列出的项以外，返工期间由新入口发现并修复：

- `apps/desktop/src/preload/index.ts` 缺少 `choosePath` 桥。`repairNoteSource` 调用 `window.manga.choosePath()`，预加载原先没有暴露该方法，打包后的“重新指定文件”会静默失败。已补齐桥接，并在 `scripts/review-m1b-reading.mjs` 中以真窗点击验证。
- 笔记编辑器打开已有修订时初始状态为 `尚未保存`。初始状态改为与服务端修订一致，并加 jsdom 用例锁定。
- 修复来源后，阅读器仍按笔记自己的修订报告“来源文件目前不可用”。同一资源已有可用文件时，读者与来源卡片不再要求重新指定，同时保留 `revisionFileMissing` 供诊断。
- 发送任务会带上任意残留的打开笔记，阅读另一本书时材料串到上一本。`agent-surface.ts` 按当前页解析表面：笔记页只用该笔记及其来源，阅读页只纳入属于当前书的笔记和选区，Agent/副驾驶跟随已选会话。`tests/m1b/agent-surface.test.ts` 锁定这五条。
- 查找命中高亮把结束位置写成起点加 8 个码点。跳转现在传入命中自己的结束位置，jsdom 期望 `("body", 2, 7)`。
- 闭包烟测用服务调用读末段和冻结材料，短样本的末段落在第一窗内，末尾的进度点击可能把位置写回开头，重启只打开阅读导航。样本改为前缀加 120 段中文再加 `chi-close-tail`（1490 字节，末段起点 1450）。窗口内点“继续”后保存进度，作曲框发送后比对可见上下文，书签跳转后进度仍在末段；重启打开原书，`data-restored` 为 `progress` 且偏移大于 0，正文含末段标记。
- 指名块没有来源时，未使用的 `openNoteSource` 会退回来源列表第一项。命令路径本来只用 `openNoteSourceDetail`，该函数已删除。
- `session.open` 对 `project` 每次新建会话。现在与资源/笔记一样按目标与模式复用。工程界面仍是 M3。
- 发送后的 `refresh()` 沿用闭包里的旧 `sessionId`，可能载入另一个会话的运行。发送完成后改为 `refresh(sid)`。
- 窗口缩到 360 时，React 尚未把停靠栏改成隐藏，壳级 `scrollWidth` 会大于视口。`styles.css` 在最大宽度 959px 时隐藏 `data-shell-state="dock"` 的栏。A 的 `review-m1b-ui.mjs` 断言未改，修复后连续两次在 1280×840 与 360×780、DPR 1.5 下 `overflow` 为 false。

### 8.4 返工证据跑次

```powershell
$env:M1B_EVIDENCE_DIR='docs/evidence/m1b-reading-notes/b4-recheck'
node scripts/m1b.mjs package
node scripts/m1b.mjs bench
$env:M1B_REQUIRE_REPORT='1'
node scripts/m1b.mjs test
node scripts/review-m1b-reading.mjs
node scripts/review-m1b-ui.mjs
node scripts/verify.mjs
$env:M1A_EVIDENCE_DIR='docs/evidence/m1b-m1a-regression/b4-recheck'
node scripts/audit-m1a-reverify.mjs
```

| 命令 | 结果 |
| --- | --- |
| `node scripts/m1b.mjs package` | 退出 0。Windows x64 未签名包，`initial`/`restart`/`agent`/`agent-restart`/`reading`/`closure`/`closure-restart` 全部 passed。最终一次在窄窗 CSS 修复之后 |
| `node scripts/m1b.mjs bench` | 退出 0。10,000 元数据 / 50,000 块；检索 p95 0.46 ms、上下文 p95 0.55 ms、已索引首屏 p95 0.70 ms、保存 p95 0.90 ms、进度保存 p95 1.16 ms、冷启动 p95 19.5 ms、Electron 交互 p95 3 ms；操作级内容可用 p95 1.28 ms、保存回执 p95 33.5 ms、导入到可读 p95 16.0 ms |
| `node scripts/m1b.mjs test` | 退出 0。Vitest 70 passed、0 failed、0 skipped（含 10 MiB TXT / 30 MiB EPUB 末段）；`cases.json` 10 个必需用例 passed：G-01(18) G-05(7) G-06(14) AT-04(5) AT-05(5) AT-18(4) AT-52(8) AT-60(3) AT-61(2) AT-62(2)；`report.json` `automationStatus` = `self-check-passed`、`productAcceptance` = `not-run`、`errors` 为空。时间 `2026-09-23T05:23:07.257Z` |
| `node scripts/review-m1b-reading.mjs` | 退出 0。打包后真窗 + 合成 Profile；14 项观测 passed，截图 `b2-*.png`。`humanChecks` 与 `productAcceptance` 均为 `not-run` |
| `node scripts/review-m1b-ui.mjs` | 连续两次退出 0。脚本断言未改：`localFixesStatus` = passed，1280×840 主面板宽 696、360×780 主面板宽 360，DPR 1.5，`overflow` 均为 false |
| `node scripts/verify.mjs` | 退出 0。见 8.5 |
| `node scripts/audit-m1a-reverify.mjs` | 退出 0。写出 `docs/evidence/m1b-m1a-regression/b4-recheck/audit.json`，`status` = `no-open-finding-reproduced`，F-25 两条与 F-32 两条观察均为 passed |

指纹（`b4-recheck/report.json`，与 `test-run.json`/`package.json`/`cases.json`/`bench.json`/`a-ui-review.json`/`b2-ui-review.json` 一致）：源码 `d176cf572c4858bc09f184eaf52b84515dc1486b95d56c36345c0e3431367fdd`，M1b 源码 `630ebb11493363bd199750dd948b04aa571a71df5a5c1040cb605def01b7df83`，锁文件 `a6699b8bf09cba2192f10323919f96261298f3d188418c4b2c0e345af44ab192`，测试脚本 `2ebe4d7e679ecb3475639665b992c95ace248b938fa0482bfa539889d6b6559a`，构建脚本 `cfc1d329bf09d049f8689c6e528563f15e58efb7cc23b20369c5388749fa6497`。文档改动不计入这些指纹。

闭包烟测要点（`b4-recheck/package.json` 的 `closure`，以及同次标准输出）：`readLastChapter`、`recordedNote`、`selectionAccurate`、`materialsFrozen`、`materialsFromUi`、`uiTailVisible`、`progressAtTail`、`bookmarkHighlighted`、`sourceCardOk`、`restoredProgress`、`restoredSource`、`restoredMaterials`、`uiRestoredTail` 为 true。打包脚本另外断言 `progressStillAtTail`，该字段未写入 `package.json`，本次命令退出 0。记录的选择是 `chi-close-sel`（码点 8—21），摘录与选区相同；样本 1490 字节，末段起点 1450；笔记保存 60 ms，导入 6 ms，上下文 343 字。解析候选 `accepted=false`。

### 8.1 可选的局部人工复测

首选下一步是交 A 复核第 8.2—8.5 节与 `b4-recheck`。正式 H-01—H-05 仍为 `not-run`。自动闭包使用合成 TXT：前缀“闭合样本第一章。”、重复的“中段正文用于闭合检查。”和结尾标记 `chi-close-tail`。需要用户参与时按下表执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

新 checkout 请自行创建小型合成 TXT/EPUB，不用真实收藏作为测试数据。脚本 `node scripts/review-m1b-reading.mjs` 会自动打开打包后的应用并替换原生对话框，等价流程也可手工核对：

1. 打开“阅读”，导入合成 TXT，点书名。选择一小段正文后点“记录笔记”，检查摘录与选择相符；再选另一段记录，确认正文已更换。
2. 在笔记当前光标处换段；分别用微软拼音/微信输入法组字、选词后停顿，预期组字期间不显示“已保存”，确认后出现保存回执；切换另一笔记再返回，确认内容与目标一致。
3. 点击笔记的“打开来源”，预期阅读页显示来源卡片与命中位置；点“返回笔记”回到原块；把原文件改名后重新打开，预期出现“原件不可用”和“重新指定文件”，选择新文件后状态恢复。
4. 设置字号/行距/边距与三背景，加一个书签并跳转，确认高亮范围与书签一致、已读范围不被跳转扩大。
5. 选中正文后点“把选区交给 Agent”，在右侧确认绑定的资源/笔记/选区与冻结文本；发送后核对回执中的上下文与面板一致。
6. 宽窗点击标题最左侧栏图标收起/恢复，预期常驻栏占位；缩为手机比例，预期仅主面板，浮层 Esc 可关闭；模式菜单在左栏顶部，下方列出已打开的资源与笔记会话。
7. 记录失败步骤、输入法、缩放和实际窗口尺寸；不要在本轮测试真实 Profile 迁移。

### 8.5 返工后的仓库门禁

| 检查 | 结果与范围 |
| --- | --- |
| `node scripts/verify.mjs` | 退出 0。文档 90 篇、727 个本地链接、75 条需求、62 个验收用例、9 个证据链接；公开检查 597 个文件、1162 个快照、201 个二进制快照；依赖方向通过；M1a Vitest 94 passed、4 live skipped；M1b 快速子集 68 passed、2 large skipped（完整 70 项见 8.4 的 `M1B_LARGE=1` 跑次）；契约/修复回归 15 passed；Node 24.19.0 |
| M1a 屏障审计 | `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/b4-recheck` 下 `node scripts/audit-m1a-reverify.mjs` 写出 `audit.json`，`no-open-finding-reproduced`。未覆盖 `a-final`、`b-final`、`b3-rework`，也未改 M1a 正本。本轮没有另跑 `verify-m1a.mjs` 的报告门禁 |

这些检查只证明当前源码通过本仓库门禁与合成自检，不构成 M1b 产品验收。解析候选 `accepted=false`、H-01—H-05 `not-run`、产品验收 `not-run` 均未改变。

### 8.6 A 独立复核与本轮局部修复（2026-09-23）

复核入口为实施提交 `53a1f6c67d8817da92eccc0b9f21e56c32941e85`，保留规划提交 `78a6fca`。开始时工作区干净，分支没有 upstream；另核对远端同名分支不存在，未执行 push。修改前用当前指纹读取 `b4-recheck`，原 B 报告确实为 `self-check-passed`，不是伪造的命令成功；以下独立反例说明原覆盖不足。B 的 8.2—8.5 和证据原样保留，不能用后来的反例改写历史跑次。

A 新证据统一写入 `a-recheck`，M1a 审计写入 `docs/evidence/m1b-m1a-regression/a-recheck`。测试只使用合成文件和隔离 Profile；没有真实 Profile 迁移、真实模型调用或 H 检查。完成四处局部修复：

1. **F-03 草稿回执竞态**：先发送保存 A，再输入 B 并进入组字，A 的回执原先无条件删除持久草稿，B 又因组字屏障暂不保存。`note-editor.tsx#flush` 现在仅在没有较新编辑时清草稿。新增回归先观察到失败，再在修复后通过；串行保存、修订保护、共用撤销栈和组字屏障保留。
2. **F-09 进度预览查询**：`planPackageImport` 对两个 SQL 占位只绑定一个参数，任何含 progress 的资料包预览都会抛出 `Too few parameter values were provided`。改为绑定完整的资源/修订复合键；新增合成进度冲突与无冲突检查通过。这一局部修复不关闭下节的导入映射问题。
3. **F-10 字体与会话标题**：原实现只有字号。补充系统黑体、宋体、等宽三种字体栈，使用已有 `settings.setShell` 持久化；旧配置缺字段时默认 sans，不重置原字号。没有引入或下载字体资产。服务兼容回归及实际窗口选择、重载恢复通过，字形效果仍按 H/Q-08 人工确认。真窗截图另发现长会话标题的 inline span 无法截断，侧栏出现横向滚动；改为 block truncate 并保留完整 title，补真窗边界观测。
4. **F-08 证据门禁**：`m1b-report.mjs` 现在在独立 A 审计存在时检查其指纹、非空观测及每项结果，拒绝失败、空观测、陈旧证据。补充门禁反例通过。原 B 自检仍是其历史子集结果；当前 A 目录不能在已知反例失败时输出 `self-check-passed`。

### 8.7 A 逐项判断与集中返工清单

“技术复核通过”仅关闭本表所述实现问题，绝不把相关 AT 全部改为 passed。

| 编号 | A 判断 | 实现、实测与限制 |
| --- | --- | --- |
| F-01 | 技术复核通过 | `App.tsx#openNoteSource/backToNote/repairNoteSource`、`reading-service.ts#openNoteSourceDetail` 和 preload 路径桥齐备。包内 14 项阅读复核包含来源卡片、移动文件重新指定、返回原块；无锚点块不跳到邻块来源。唯一引文修复、真实旧修订限制沿用 8.2 |
| F-03 | 本轮局部修复后技术复核通过 | 块工具、Tiptap/CodeMirror 权威状态、共享历史、refs 同步及失败草稿均有代码和回归；新增“旧回执不能删除新组字草稿”反例已修。真实 IME、系统关闭与存储耗尽未验证，H-02 保持 not-run |
| F-04 | 冻结链路通过；整体受 F-05 限制 | `product-app.ts#materialContextMessage/runAgentLoop/getRun` 的冻结正文实际进入模型消息路径；包烟测验证选区来自 UI、回执内容及重启恢复。正常同模式表面过滤用例通过；跨模式界面仍可能展示别的会话草稿，不能宣布全部材料归属闭环通过 |
| F-05 | **P1，rework-required** | 服务层按 kind/target/mode 复用会话，但 `App.tsx#refresh` 取旧闭包 mode 查询列表，`ensureBoundSession` 又无 mode 筛选；`agent-surface.ts#composerKeyFor` 只匹配 kind/target，未找到时回退旧 session。真窗输入 `enthusiast draft only` 再切创作者，仍显示原草稿及原资源会话。须统一当前模式、目标、会话、输入草稿和运行面板的绑定，覆盖切换中发送/失败/返回；工程与媒体休眠仍留 M3/M2 |
| F-06 | 技术复核通过 | `readDocument` 按已存 locator 窗口恢复、合并已读范围；包内末段可见、书签跳转不扩大已读范围、重启偏移大于零均通过。仍为分窗加载，未实现虚拟滚动；完整长书舒适度不自动通过 |
| F-07 | **P1，rework-required** | 仍是自建候选解析器。ReportLab 生成且 Poppler 正常渲染的 `standard-scan.pdf` 被解析为无图像页，实际产品窗口也没有可解码图像；`pdfPageImages` 以 `\w+` 匹配 PDF Name，漏掉合法带点资源名；取原始像素当图片也不能等同页面渲染。独立 ZIP EPUB 的 `../Images/scan.png` 插图为 0，`assetFor` 未正确归一相对路径。源码仍丢弃作者 CSS、固定版式位置和正文内插图位置；PDF 字体映射/页面渲染缺口不能归为仅“复杂出版排版”。须集中补可靠适配边界、正常页面呈现/映射及失败状态，候选继续 `accepted=false` |
| F-08 | **P1，部分修复，仍需返工** | 7 阶段包烟测和 14 项真窗观测均真实通过；但主闭环只覆盖短 TXT，未证明四格式实际页面和多模式目标。`bench-m1b.mjs` 新指标仍是 `app.call` 服务回执；`main/index.ts` 的 bench 仍在 click dispatch 返回时结束，不等到 React 内容可用/持久保存状态。`importToReadable` 只等导入命令，没有等页面可读。须补实际 Electron 操作到正文/保存回执的原始计时及上述反例，不能以现有指标关闭完整 P6 |
| F-09 | **P1，部分修复，仍需返工** | 进度预览参数已修。独立审计仍复现：①duplicate 导入非冲突资源时 `remap()` 不放原 ID，插入 `.get()` 为 null；②复制锚点后 refs 指向新锚点，但笔记 payload 与历史仍存旧 anchorId，删除/恢复或后续重建会重新关联旧来源；③逐行 skip 冲突锚点仍新增 null ID 的锚点。须对已知领域行统一计划映射、依赖决策、历史/载荷/引用/索引/附件的提交和恢复；验证混合冲突及缺媒体往返。保留原件/目录保护和未知载荷，不直接对未知插件私有字段做猜测替换 |
| F-10 | 补字体后技术复核通过 | 字号、字体栈、行距、边距、背景、书签、查找、章节导航及笔记标题/标签/搜索/历史入口存在且定向实测通过。正式视觉、真实中文输入和全尺寸缩放仍为 not-run；工具分层/组件统一建议见唯一计划第 11 节，不冒充本轮已重做完整 UI |

新增反例由 `scripts/audit-m1b-recheck.mjs` 与 `scripts/review-m1b-recheck.mjs` 记录，失败真实返回非零；没有把“成功复现错误”登记为产品 passed。F-05 涉及界面会话状态模型，F-07 涉及解析/渲染适配，F-09 涉及依赖图和事务导入，交 B 集中补齐，避免只修表面结果而遗漏相邻状态。

### 8.8 A 验证、证据与边界

| 检查 | 本轮结果与证据 |
| --- | --- |
| 修改前统一门禁 | 退出 0：M1a 94 passed / 4 live skipped，M1b 68 passed / 2 large skipped，契约/修复回归 15 passed |
| 局部修复反例 | 草稿竞态与带进度资料包先失败后通过；字体旧配置兼容与持久化通过。`tests/m1b/a-recheck.test.ts`、`shell-ui.test.tsx`；报告门禁反例 6 passed |
| 最终 Windows 包 | `node scripts/m1b.mjs package` 退出 0；7 阶段全部 passed，SQLite Electron ABI 检查通过，输出 `dist/desktop/packages/MANGA-win32-x64`；[package.json](m1b-reading-notes/a-recheck/package.json) |
| 原阅读/壳复核 | `review-m1b-reading.mjs` 退出 0，14 项观测；`review-m1b-ui.mjs` 退出 0，原选区断言与宽/窄窗检查保留。见 [b2-ui-review.json](m1b-reading-notes/a-recheck/b2-ui-review.json)、[a-ui-review.json](m1b-reading-notes/a-recheck/a-ui-review.json) |
| 新独立反例 | `audit-m1b-recheck.mjs` 退出 1，F-07 两项、F-09 三项失败；`review-m1b-recheck.mjs` 退出 1，字体重载和长会话标题边界两项通过、F-05 两项与扫描 PDF 一项失败。见 [服务与格式审计](m1b-reading-notes/a-recheck/a-adversarial-review.json)、[真窗补测](m1b-reading-notes/a-recheck/a-additional-ui-review.json) |
| 性能 | `node scripts/m1b.mjs bench` 退出 0，10k/50k 合成数据与原始计时见 [bench.json](m1b-reading-notes/a-recheck/bench.json)。这些是现有脚本覆盖的服务/点击指标，不能代替 F-08 要求的完整 UI 时延 |
| 完整 M1b 测试与报告 | Vitest 73 项通过，包含 10 MiB TXT / 30 MiB EPUB；`M1B_REQUIRE_REPORT=1 node scripts/m1b.mjs test` 因独立 A 审计失败而退出 1，报告为 `failed-or-incomplete`，保留 `productAcceptance=not-run`。见 [test-run.json](m1b-reading-notes/a-recheck/test-run.json)、[report.json](m1b-reading-notes/a-recheck/report.json) |
| M1a 屏障 | 最终源码再次运行 `audit-m1a-reverify.mjs`，`no-open-finding-reproduced`，4 项观察通过；见 [audit.json](m1b-m1a-regression/a-recheck/audit.json)。不把该子集写成完整 M1a AT |

合成扫描页由 `scripts/build-m1b-review-samples.py` 使用 ReportLab/Pillow 生成，EPUB 使用 Python zipfile；版本与 SHA-256 见 [sample-manifest.json](m1b-reading-notes/a-recheck/sample-manifest.json)。PDF 经 Poppler 渲染并目视核对，源页有文字与蓝粉色块，产品截图却没有页面图像。重跑现有审计可直接使用已提交样本，不依赖安装这些生成工具。所有图片仅包含合成内容。

最终 `node scripts/verify.mjs` 退出 0：文档 90 篇（收尾文档检查为 749 个本地链接）；类型/依赖/公开内容门禁通过，M1a 94 passed / 4 live skipped，M1b 快速集 71 passed / 2 large skipped，契约/修复回归 15 passed，M1b 报告门禁反例 6 passed。摘要见 [repository-quality.json](m1b-reading-notes/a-recheck/repository-quality.json)。该门禁通过与独立审计 failed 可以同时成立，因为覆盖范围不同。解析候选仍为 `accepted=false`，H-01—H-05 与产品验收仍为 `not-run`。原编辑/选区/窗口/ABI/迁移事务/授权/生成物，以及 M1a 快照/工具回执/用途隔离/目录与原件保护/生命周期屏障均保留；本轮未修改相关授权、迁移或生命周期协议。

最终 A 跑次指纹：源码 `ce5ada40dbc2415e3c110160bca22b7989d980133688edaedc289495052df019`，M1b 源码 `e247fc7e6bc8e9caa83fa57756d5b1fc5a73f695fb3d9d9620aa301ba703209a`，锁文件 `a6699b8bf09cba2192f10323919f96261298f3d188418c4b2c0e345af44ab192`，测试脚本 `f4ff73b8a766283e65e8e7001fd4c7b6169423aefc87a3a85eeab65f271c6e54`，构建脚本 `cfc1d329bf09d049f8689c6e528563f15e58efb7cc23b20369c5388749fa6497`。上述包、完整测试、性能、两份既有 UI 复核、两份独立反例与报告逐一核对一致；M1a 审计源码指纹相同。

### 8.9 B 返工 F-05 F-07 F-08 F-09（2026-09-23）

实施基线 `136c15e0b1b63ccc3d88a5cc4473acfb16d69084`，保留规划提交 `78a6fca`。先在新目录 `docs/evidence/m1b-reading-notes/b5-rework` 复现两条独立脚本，失败记录保留为 `repro-a-adversarial-review.json`、`repro-a-additional-ui-review.json` 及对应截图；没有改弱断言，也没有覆盖 `b-final`、`a-final`、`b3-rework`、`b4-recheck`、`a-recheck`。8.2—8.8 保持 A/B 当时的记录。

| 编号 | 实现 | 复测 |
| --- | --- | --- |
| F-05（含 F-04） | 草稿键是当前模式加目标；会话列表和运行面板只保留当前模式。切换在 `settings.setShell` 返回前就改可见模式，失败则撤回，返回原模式仍看到原草稿。冻结材料仍只跟当前模式的会话 | 真窗：创作者不显示爱好者草稿，侧栏不再列出该会话。包内 `formats` 阶段同时检查切走后再返回草稿 |
| F-07 | PDF 名称允许点号；8 位 DeviceRGB/DeviceGray 原始样本包进 PNG，已是 PNG/JPEG 的字节保持原样；解不出的图像和未映射字体写入警告。EPUB `..` 限制在压缩包内，插图保留码点位置，作者 CSS 留在 `stylesheets` 而不进入正文。阅读页对无法显示的图像给出失败状态。候选 `accepted` 仍为 false | 审计：标准扫描页为 `image/png`，相对路径 EPUB 有 1 个插图。真窗：该扫描页 `naturalWidth > 0`。页面图像使用 blob URL，产品 CSP 的 `img-src` 增加 `blob:`，与已有对象 URL 一致 |
| F-08 | 新增 `formats` 烟测：txt/epub/pdf/mobi 实际打开、模式往返、损坏 PDF 的可见失败。窗口计时等到库页面、正文标记和笔记 `data-save-state=saved` 再记 `contentAvailableMs` / `saveReceiptMs` / `importToReadableMs` | 包烟测八阶段 passed，四格式 `opened` 均为 true。`bench.json` 含三组 Electron 窗口样本。这仍是合成自检，不关闭完整 P6 或产品验收 |
| F-09 | 非冲突 id 保持原值，只有 duplicate 碰撞才分配新 id。skip 已存在的锚点/引用不再插入空 id。笔记块 `anchorId` 与其 `object_revisions` 按同一映射改写；未知插件载荷和 `attrs` 不改。缺失附件继续导入，托管 `file_locations.available=0`，不改来源原件 | 原审计三项通过。补充回归覆盖混合 skip/duplicate、历史与引用一致、插件私有字段不变、缺托管文件后原件仍在 |

React 19.3.0、React DOM 19.3.0、Tailwind CSS 4.3.3 与 Vite 插件已写入锁文件。shadcn CLI 4.21.0 的 new-york `button` / `textarea` 源码在 `apps/desktop/src/renderer/components/ui/`，阅读导入按钮和作曲框实际使用它们；这是 U2 的一条路径，不是整套壳迁移。`.github/dependabot.yml` 增加根目录 npm 每周检查（上限 3，React 与 Tiptap 分组，minor/patch 分组）和 `experiments/m0-desktop` 月度上限 1；Actions 仍为月度上限 1。配置只在本地，没有 push，bot 没有开过 PR。

D2—D4 已重新查询并多数保持原版：Tiptap 3.31.3、TypeScript 7.0.2、Vite 8.3.0、Vitest 5.0.1、Electron 44.4.5、better-sqlite3 13.0.3、lucide-react 1.47.0、pnpm 12.5.1 未接入。Zod 4.6.5 已接入。查询、安装和验证状态见 [dependency-candidates.json](m1b-reading-notes/b5-rework/dependency-candidates.json)。不能把这份清单写成全项目已是最新稳定版。

H-01—H-05、真实输入法、真实模型、真实 Profile、OCR 与产品验收保持 `not-run`。解析候选保持 `accepted=false`。

### 8.10 A 复核 b086b1e 与局部修复（2026-09-24）

本次入口为未推送实施提交 `b086b1e`，分支 `codex/m1b-reading-notes`，父提交 `78a6fca` 保留。开工工作区干净；核对远端同名分支不存在。唯一计划仍为 `docs/delivery/m1b-execution-plan.md`。所有新证据写入 `a-b5-review`，M1a 屏障写入 `docs/evidence/m1b-m1a-regression/a-b5-review`；`b5-rework`（包括 `repro-*`）、`a-recheck` 与更早跑次原样保留。本节覆盖当前判断，不改写 8.9 的 B 历史自检。

**结论：rework-required。** 上一轮服务/格式五个反例和真窗五项补测均已通过；新增反例仍发现 F-07、F-09 的实现缺口，F-08 的完整性能覆盖仍缺。A 完成以下局部修复并独立复测：

1. **F-01/F-02 来源定位单位**：H-01 自动子集选中 `中文日本語😀é`，保存 locator 是正确的 7 个码点，但来源跳转原先将 `utf16Range` 交给码点分窗/高亮，实际多高亮一个句号。解析结果新增兼容字段 `codePointRange`；直接定位与引文恢复均返回两种明确单位，界面只使用已解析码点范围，歧义候选不自动取第一项。领域正本与契约同步；含前置 emoji 的定位、引文重定位及重复句回归通过。
2. **F-05 同一会话草稿**：阅读页与 Agent 页分别使用 mode/target 和 mode/session 键，切页时显示空草稿。统一同一模式、同一目标的草稿键；没有对应目标会话时不再借用另一会话的运行面板。原跨模式隔离、同资源跨页面与键盘模式往返通过。此结论限于已测正常切换，不代表全部异步竞态覆盖。
3. **F-06 章节位置自动保存**：目录切到 EPUB 末章后关闭进程，原先没有写入进度，重启回到首章。章节/阅读窗口切换现在保存当前位置，`consumed=false`，不把导航等同已读授权；书签/搜索的临时高亮保持原阅读位置。包内原 `progressStillAtTail` 断言保留并通过；独立 EPUB 重启恢复末章通过。连续滚动与整本书舒适度仍不由该子集推定。
4. **F-08 实际窗口计时门禁**：B 已采集 Electron 原始计时，但 `contentAvailableP95Ms`、`saveReceiptP95Ms`、`importToReadableP95Ms` 仍取 `app.call` 耗时，门禁只检查窗口样本数量。反例 `[1,1,2001]` 原被接受。现由窗口样本计算三项 p95，并拒绝非数值、负数、超时和摘要不匹配；服务样本单独保留。门禁增加本轮独立审计/H 自动子集文件，已知失败不能被普通自检覆盖。报告反例 7 项通过。

初次 H 子集失败保留在 [repro-a-b5-h-checks.json](m1b-reading-notes/a-b5-review/repro-a-b5-h-checks.json)，仅定位修复后暴露的重启问题保留在 [repro-h01-progress.json](m1b-reading-notes/a-b5-review/repro-h01-progress.json)。第一份使用 B 原包，第二份使用本轮中间包；两者仅作失败复现，不作最终源码通过证据。[repro-scroll-check.json](m1b-reading-notes/a-b5-review/repro-scroll-check.json) 保留滚动诊断：初版脚本只等待元素进入视口，最终脚本明确居中滚动并等待两帧后测量整个按钮边界，仍断言完整可达。最终 [a-b5-h-checks.json](m1b-reading-notes/a-b5-review/a-b5-h-checks.json) 匹配重建后的源码和包。高缩放截图使用 Electron `capturePage` 保留完整窗口内容，避免 Playwright 在内容缩放与系统缩放不同时截掉右下区域；DOM 另检查正文宽度、实际记录按钮边界与可达性。

### 8.11 尚未关闭的集中返工

| 编号 | 当前判断、触发与影响 | 修复方向与复验要求 |
| --- | --- | --- |
| F-07 | **P1，rework-required**。`formats.ts#pdfFontReport` 将存在 `/ToUnicode` 的字体计作已映射，`parsePdfBytes` 却不把字符表传给 `extractPdfText`。完整 xref 合成 PDF 的 `0x41 → U+4E2D` 应提取“中”，实际为“A”，且 `unmappedFonts=0`、无警告。`pypdf 6.10.0` 独立提取为“中”，见 [参考核对](m1b-reading-notes/a-b5-review/unicode-map-reference.json)。这影响正文、查找和引用，不能归为复杂排版。B 修好的普通 RGB 扫描图和相对 EPUB 插图均维持 passed；作者 CSS 只保存不渲染、固定版式及 PDF 页面绘制仍未完成 | 完成可靠的字体/页面适配与定位边界，逐格式记录正常呈现、错误和不支持状态；保留扫描图/相对插图/页身份回归。候选 `accepted=false`，不能通过改为接受字形码或弱化断言关闭问题 |
| F-09 | **P1，rework-required**。`library-package.ts#importLibraryPackageResolved` 的 `anchorPlan` 在资源 skip 前分配新锚点，随后跳过实际锚点插入，但仍复制笔记和 refs，新副本指向不存在的锚点。另一反例在 `resource_revision=skip` 时保留库内原 payload，后面的索引循环却写入包内被拒绝的正文。见 [三项独立反例](m1b-reading-notes/a-b5-review/a-b5-deep-review.json) 中两项 F-09 | 统一实际导入/保留/跳过/重映射的依赖计划，笔记/历史/refs/索引/附件必须跟随真正持久化的行；skip 资源加 duplicate 笔记仍可解析来源，skip 修订不改变其索引/媒体。混合策略、缺媒体、进程中断恢复及原件保护一起验证，不只补当前两个输出 |
| F-08 | **P1，局部门禁已修，P6 证据仍需返工**。`bench-m1b.mjs` 的服务数据集有 10k/50k；三个窗口跑次另建空 Profile，`measureWindowBench` 导入约 30 次重复短文并创建一份笔记。后台解析期间只测服务 `workspace.get`。因此本轮新增窗口 p95 只能证明短样本，不能证明同一基准库下 10 MiB TXT/30 MiB EPUB 的可操作首屏、后台解析期间 UI 反馈或真实窗口冷启动。B 在 8.9 未宣称完整 P6 通过，这一边界继续保留 | 在同一规模 Profile 上测真实 Electron 内容可用、保存回执、冷启动至可操作库；大书访问末段，并在后台解析期间实际操作界面。保存原始样本/数据规模/等待条件，与需求 6.2 的口径映射；服务和空库窗口结果可保留但不能替代 |

复现入口：`scripts/audit-m1b-b5-review.mjs`，真实退出 1；失败是尚待修复的产品行为。原 `audit-m1b-recheck.mjs` 退出 0 只说明原五个反例已消失。F-05 本轮所述会话/草稿技术子集关闭；F-01/F-02/F-06 的新增局部问题已修。没有新增产品范围或第二份计划，也不将上述开发缺口交由人工承担。

### 8.12 验证与 H-01—H-05 的当前边界

用户本轮追加要求“能验证的 H 项一起验证”。据此执行合成 Profile 的自动技术子集，替代旧交接中“不执行 H”的实施限制；正式 H-01—H-05 人工状态和产品验收仍为 `not-run`。下表中 passed 仅描述明确列出的自动子集。

| 检查 | 当前结果与证据 |
| --- | --- |
| Windows 包 | 八阶段 passed；`dist/desktop/packages/MANGA-win32-x64/MANGA.exe`；[package.json](m1b-reading-notes/a-b5-review/package.json) |
| M1b 完整场景 | 82 项 Vitest 通过（含 10 MiB TXT/30 MiB EPUB）；[test-run.json](m1b-reading-notes/a-b5-review/test-run.json)。报告门禁因本轮 F-07/F-09 独立失败而退出 1，`failed-or-incomplete`；[report.json](m1b-reading-notes/a-b5-review/report.json)，不删失败以凑通过 |
| 原阅读/壳/补充 UI | 原 14 项阅读流程、笔记编辑/来源/资料包入口、宽窄窗、旧跨模式/扫描页观测均通过；[阅读复核](m1b-reading-notes/a-b5-review/b2-ui-review.json)、[壳复核](m1b-reading-notes/a-b5-review/a-ui-review.json)、[原补测](m1b-reading-notes/a-b5-review/a-additional-ui-review.json) |
| 性能子集 | [bench.json](m1b-reading-notes/a-b5-review/bench.json) 的三项 UI p95 来自实际 Electron 原始样本；仅限短样本/新 Profile。F-08 完整规模要求仍见 8.11 |
| M1a 屏障 | [audit.json](m1b-m1a-regression/a-b5-review/audit.json)：四项 passed，`no-open-finding-reproduced`，不代表完整 M1a AT |
| 仓库门禁 | `node scripts/verify.mjs` 退出 0；最终汇总见 [repository-quality.json](m1b-reading-notes/a-b5-review/repository-quality.json)。业务回归通过与独立产品反例失败分别报告 |
| 命令与指纹 | [a-command-results.json](m1b-reading-notes/a-b5-review/a-command-results.json) 记录各入口实际退出码；`expectedExit=1` 标注本轮仍失败的反例/报告，不把失败变成产品通过。最终源码/锁/测试/构建指纹与包、测试、性能、最终审计一致 |

| H 项 | A 已完成的自动技术子集 | 仍交人工或 B 的部分 |
| --- | --- | --- |
| H-01 | **passed 子集**：无 AI 的双章 EPUB 导入、末章中日文/emoji/NFC 摘录、评论保存、来源精确高亮、返回、退出进程后恢复末章及笔记。22 条补测观测见 [a-b5-h-checks.json](m1b-reading-notes/a-b5-review/a-b5-h-checks.json)；另有原包 TXT 流程 | 人工整书体验与其余格式阅读完整性；PDF 已知缺口先由 B 修，不能让用户验收失败实现 |
| H-02 | 原最终包复核覆盖按键编辑、光标拆块、CodeMirror 源编辑、共享撤销/重做与持久保存；Vitest 覆盖组字屏障/草稿回执竞态 | **真实微软拼音/微信输入法 not-run**；自动插入 Unicode 和合成 composition 事件不代表系统选词、候选框或焦点实测 |
| H-03 | **passed 子集**：1920×1080、1280×840、960×640、720×540、800×1200、360×780 的 Electron 内容尺寸 × 100%/125%/150% 内容缩放共 18 组；记录真实 CSS 视口/DPR、正文边界/按钮可达性；窄窗左右 hover→移入、Esc 和焦点恢复 | 原 H 表定义的是外窗与真实 Windows DPI；本轮没有更改系统显示设置。外窗边框/任务栏、真实显示器舒适度与 Q-08 仍人工核对，不能把内容缩放写成系统 DPI 验收 |
| H-04 | **passed 子集**：纯键盘模式菜单、两模式草稿返回；原包可控提供者发送/取消/重启和跨页面历史仍通过 | 系统拖动、标题双击、最大化/还原/贴靠及真实 IME/任务并发切模式需人工补测；未测部分不写 passed |
| H-05 | 合成备份/恢复服务回归、真窗资料包预览/逐行选项、来源缺失/重指定提示已执行；本轮资料包依赖反例为 **failed** | F-09 由 B 先修；之后人工核对恢复结果可理解性、正文行宽/空栏/Q-08。真实 Profile 迁移不在授权内 |

后续人工只使用稳定包和合成数据。开发入口为 `pnpm dev`；独立隔离的自动 H 子集入口为 `M1B_EVIDENCE_DIR=<新的证据目录> node scripts/review-m1b-b5-h-checks.mjs`，该脚本生成双章 EPUB、替换文件对话框并建立新测试 Profile。人工可自行建立内容含 `中文日本語😀é` 的 TXT/EPUB，按计划第 8 节操作；先等待 B 修复 F-07/F-09，再集中核对 H-02 实际输入法、H-03 系统 DPI、H-04 原生窗口和 H-05 视觉反馈。不需要为本轮审查先配置真实模型或迁移真实资料。

解析候选 `accepted=false`。React/Tailwind/shadcn 的 B 已接入范围保持，D2—D4 未完成的升级仍是后续路线，不宣称全部最新稳定依赖已完成。没有 push、PR、合并、发布、真实模型调用或真实 Profile 迁移。

### 8.13 B 返工 F-07 F-08 F-09 2026-09-24

本节是 B 对 8.11 的实现与自检，不改写 8.10—8.12。A 对 `b086b1e` 的 rework-required 仍然是当时的审查结论。本轮自检通过不等于 A 已关闭发现，也不等于产品验收。

规划提交 `78a6fca` 保留。实施从 `9be328a` 继续，工作区已有改动保留并纳入同一未推送实施提交。新证据只写入 `docs/evidence/m1b-reading-notes/b6-rework`。扫描页和相对插图样本从 `a-recheck` 复制进来，源目录未改。M1a 写入 `docs/evidence/m1b-m1a-regression/b6-rework`。`a-b5-review`、`b5-rework`（含 `repro-*`）、`a-recheck` 与更早跑次未覆盖。

| 编号 | 实现 | 本轮自检 |
| --- | --- | --- |
| F-07 | `pdf-text.ts` 应用 ToUnicode CMap（`bfchar`/`bfrange`，含数组形式）、简单字体编码与 `/Differences`、Form XObject。未映射字形不进入正文并留下警告。`vectorPageRendering` 为 false。作者 CSS 只保存。扫描页仍产出可显示图像，空页保留页身份。`PARSER_CANDIDATES` 的 `accepted` 仍为 false | `audit-m1b-b5-review.mjs` 退出 0：同一 xref 样本提取“中”，`unmappedFonts=0`。[a-b5-deep-review.json](m1b-reading-notes/b6-rework/a-b5-deep-review.json)。原扫描图与相对 EPUB 插图由 `audit-m1b-recheck.mjs` 与打包阅读器复核通过：[a-adversarial-review.json](m1b-reading-notes/b6-rework/a-adversarial-review.json)、[a-additional-ui-review.json](m1b-reading-notes/b6-rework/a-additional-ui-review.json)。Vitest 覆盖 CID 映射、未映射 Identity-H、WinAnsi 与页身份。没有 OCR，也没有把 PDF 画成排版页 |
| F-09 | 导入先形成依赖计划，再写已决定保留的行。skip 资源不插入悬空锚点，笔记与引用跟随实际锚点。skip 修订不把被拒绝的正文写入 payload、索引或媒体。缺媒体标为不可用。未知插件私有字段不改写 | 同一审计的两项 F-09 通过。`b6-rework.test.ts` 覆盖混合 skip/duplicate、skip 修订保持原索引与媒体、replace 去掉旧索引，以及提交前退出时回滚已发布媒体。原包文件不改写 |
| F-08 | 同一 Profile 写入 10 000 条元数据和 50 000 个检索块，再放入 ≥10 MiB TXT 与 ≥30 MiB EPUB。清单用一条 SQL 取 `length(payload_json)`，列表只显示最近 100 项，合计仍按全库。正文索引按码点窗口分批并让出事件循环，幂等键在索引写完后记录。隐藏的 `bench-scale` 窗口关闭后台节流，用渲染进程时钟等到目标 DOM | [bench.json](m1b-reading-notes/b6-rework/bench.json) `scaleWindow.ok=true`。冷启动至库内大书按钮 511 ms；界面反馈 p95 6 ms；10 485 774 字节 TXT 末段 p95 415.4 ms；31 501 731 字节 EPUB 末段 p95 652.2 ms；保存回执 p95 562.3 ms；后台解析 10 485 760 字节期间界面 p95 7.7 ms、保存 p95 215.7 ms。服务样本仍在同一文件，不能代替这些窗口样本。界面反馈量到 DOM 出现，不含绘制帧。窗口是合成 Profile 上的隐藏烟测窗 |

A 已修的 `codePointRange`、同一模式跨页面草稿、章节位置保存（`consumed=false`，书签和搜索临时高亮不改阅读位置）和窗口计时门禁仍在。`a-b5-review.test.ts` 与阅读笔记回归通过。正式 H-01—H-05 本轮没有复跑 `review-m1b-b5-h-checks.mjs`，状态保持 not-run；8.12 的自动子集仍只属于 `a-b5-review` 的指纹。

| 检查 | 命令与结果 |
| --- | --- |
| 单元与报告 | `M1B_EVIDENCE_DIR=docs/evidence/m1b-reading-notes/b6-rework`、`M1B_REQUIRE_REPORT=1`、`node scripts/verify-m1b.mjs` 退出 0。Vitest 94 项通过，含 10 MiB TXT 与 30 MiB EPUB。[test-run.json](m1b-reading-notes/b6-rework/test-run.json)、[cases.json](m1b-reading-notes/b6-rework/cases.json)。[report.json](m1b-reading-notes/b6-rework/report.json) 为 `self-check-passed`、`engineeringReviewable=true`、`productAcceptance=not-run`、`errors=[]` |
| 打包 | `node scripts/package-m1b.mjs` 退出 0。八个烟测阶段通过，formats 打开 txt/epub/pdf/mobi。[package.json](m1b-reading-notes/b6-rework/package.json)。产物 `dist/desktop/packages/MANGA-win32-x64`，未签名，不入库 |
| 同一规模窗口 | `node scripts/bench-m1b.mjs` 退出 0。口径见上表与 [bench.json](m1b-reading-notes/b6-rework/bench.json) |
| 独立反例 | `audit-m1b-b5-review.mjs`、`audit-m1b-recheck.mjs`、`review-m1b-recheck.mjs` 均退出 0。三份 JSON 的 `productAcceptance` 与 `humanChecks` 为 not-run |
| M1a | `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/b6-rework`、`node --experimental-strip-types scripts/audit-m1a-reverify.mjs` 退出 0。[audit.json](m1b-m1a-regression/b6-rework/audit.json) 为 `no-open-finding-reproduced`，只覆盖合成 Profile 上的四项屏障 |
| 指纹 | 包、性能、三份独立复核、测试与报告共用 `sourceFingerprint` `df41eaf7f344ff969c852442bb36f70ca26bc77a93dc047fd2ae19799d866394`、`m1bSourceFingerprint` `b7eb671651f2b9146cdafb7e064e252ef306ffb355b8a3fb11b3a41106c3b1f3`。文档改动在这些产物之后，不改变该源码指纹 |

仓库门禁 `node scripts/verify.mjs` 退出 0（Node 24.19.0，`repository-quality` passed）。没有 push、PR、合并、发布或真实 Profile 迁移。

### 8.14 A 复核与界面实现（2026-09-24）

入口为 `c3a6446b4c56e13904bf76a1ed33fb31c9abeca3`，父提交 `78a6fca666383af2d97648538d5c31fcea344df0`。工作区起始干净，同名远端分支不存在。本轮在同一分支完成独立审查和 A-37 界面增补，最终 amend 同一未推送实施提交，规划提交不变。唯一计划仍为 `docs/delivery/m1b-execution-plan.md`；本节为最新判断，8.10—8.13 保留为当时版本的记录。

**结论：rework-required。** B 的 ToUnicode 修复、原资料包反例和同规模窗口计时子集已通过；这些结果不关闭 F-07/F-08/F-09 的完整范围。较大缺口集中交回 B：

| 编号 | 触发条件、实际行为与影响 | 返工要求与保留边界 |
| --- | --- | --- |
| F-07 | **P1，rework-required**。`pdf-text.ts` 的旧 `0x41 → 中` 样本现通过，普通扫描图、相对路径 EPUB 插图与页身份回归通过。但 `formats.ts` 仍报告 `vectorPageRendering=false`；EPUB 作者 CSS 只存入载荷，固定版式仅保留插图与声明尺寸，未按作者布局完整呈现，纯矢量页面仍受限。当前只能证明正文/部分图像可提取，不能交付所需的完整页面阅读 | 完成 PDF 页面呈现及 EPUB 作者样式/固定版式适配，保留查找、码点来源与稳定页身份。逐格式记录支持、错误和未支持边界；不能接受字形码、删断言或把存储 CSS 当作渲染。解析候选继续 `accepted=false` |
| F-09 | **P1，rework-required**。`library-package.ts` 的 `anchorPlan`、对象 skip 与写锚点分开：全局 replace + resource duplicate + note/object skip 仍将被跳过笔记的原锚点改指向复制资源。全局 duplicate + resource_revision skip 时，资源属主映射导致修订未进入计划，`rewriteNoteAnchors` 删除摘录的 anchorId，refs 写入也被跳过；摘录文本仍在，但来源消失，尽管原锚点仍存在 | 以实际保留/复制/替换/跳过的依赖图统一决定资源、修订、对象历史、锚点、refs、索引和附件；skip 笔记不得暗改原来源，无法映射的来源须保持可解析或明确可修复的身份。扩展混合策略矩阵并保留原件、缺媒体、回滚和中断恢复检查，不只特判这两个输出 |
| F-08 | **P1，计时子集 passed，完整 finding 仍 rework-required**。`product-app.ts#inventory` 新增 `resources.slice(0,100)`，`workspace.get` 同样 `LIMIT 100`。101 条合成资源的最早项在两份列表都不存在，响应没有 continuation/cursor，当前界面也没有通向它的浏览或搜索路径；仅总数仍为 101。规模性能不能靠使旧资源不可达来满足 | 增加有界分页或覆盖全库的搜索/继续访问入口，保留正确总数、稳定顺序和会话身份；先证明第 101 条及更旧资源能打开，再在同一规模 Profile 上复测性能。保留 B 已完成的窗口计时与 A 的原始样本门禁，不退回服务耗时替代 UI |

上述三项新反例见 [a-b6-deep-review.json](m1b-reading-notes/a-b6-review/final/a-b6-deep-review.json)，复现入口 `scripts/audit-m1b-b6-review.mjs` 真实退出 **1**。原 [b5 独立反例](m1b-reading-notes/a-b6-review/final/a-b5-deep-review.json) 与 [早期服务/格式反例](m1b-reading-notes/a-b6-review/final/a-adversarial-review.json) 均退出 0；不改弱任何既有断言。报告门禁纳入本轮独立审计与 UI 结果，并新增“绿自检不得掩盖 b6 失败”反例。

**A-37 界面范围与实现。** 用户确认“统一现有界面，并增加动画演示页”。本轮统一左栏、标题、阅读/笔记控件和 Agent 消息/输入层级，双模式显示为观测者/造物主；内部 `enthusiast` / `creator`、会话与布局状态保留。增加离线静帧、模拟播放/进度/倍速、七集缩略图、演示字幕、标记和时间点笔记；右栏预设对话明确标注，笔记只在本次内存中保留，离页停止计时，退出清空，不创建真实资源/笔记/模型运行。正式媒体导入、字幕解析与逐帧仍属 M2。细节归 [交互设计 3.3](../design/interaction-and-workflows.md#33-首版界面切片)；本轮不新增第二份计划或迁移真实 Profile。

[宽窗界面](m1b-reading-notes/a-b6-review/final/animation-wide-settled.png)、[时间点笔记](m1b-reading-notes/a-b6-review/final/animation-note.png)、[手机比例](m1b-reading-notes/a-b6-review/final/animation-360.png)、[小说阅读](m1b-reading-notes/a-b6-review/final/reading-wide.png)、[笔记页](m1b-reading-notes/a-b6-review/final/notes-wide.png) 来自实际包。界面验证覆盖图片可解码、演示状态、时间点来源跳转、跨页面/模式保留、无真实业务写入、1280/960/360 响应布局及 Esc 焦点恢复；五组均 passed。原 `codePointRange`、跨页面草稿、章节位置保存和窗口计时门禁继续保留。

| 验证 | 本轮结果与范围 |
| --- | --- |
| Windows 包 | `node scripts/package-m1b.mjs` 退出 0，八阶段 passed，四格式打开；[package.json](m1b-reading-notes/a-b6-review/final/package.json)。本地产物 `dist/desktop/packages/MANGA-win32-x64/MANGA.exe`，未签名、不入库 |
| 完整 M1b 与报告门禁 | 94 项 Vitest passed，含 10 MiB TXT/30 MiB EPUB；9 项报告反例 passed。[test-run.json](m1b-reading-notes/a-b6-review/final/test-run.json)。`M1B_REQUIRE_REPORT=1 node scripts/verify-m1b.mjs` 真实退出 **1**，唯一门禁错误是本轮独立反例失败；[report.json](m1b-reading-notes/a-b6-review/final/report.json) 为 `failed-or-incomplete`、`engineeringReviewable=false`、`productAcceptance=not-run` |
| 打包 UI 与原阅读 | 五组新界面、14 项阅读流程、原壳和补测均通过：[a-b6-ui-review.json](m1b-reading-notes/a-b6-review/final/a-b6-ui-review.json)、[b2-ui-review.json](m1b-reading-notes/a-b6-review/final/b2-ui-review.json)、[a-ui-review.json](m1b-reading-notes/a-b6-review/final/a-ui-review.json)、[a-additional-ui-review.json](m1b-reading-notes/a-b6-review/final/a-additional-ui-review.json) |
| H 自动技术子集 | `review-m1b-b5-h-checks.mjs` 在最终包重新执行，Unicode 摘录/来源/重启、草稿、18 组尺寸与内容缩放组合及键盘检查通过，见 [a-b5-h-checks.json](m1b-reading-notes/a-b6-review/final/a-b5-h-checks.json)。正式 H-01—H-05 仍全部 **not-run** |
| 同规模窗口 | [bench.json](m1b-reading-notes/a-b6-review/final/bench.json) 退出 0。同一合成 10k 元数据/50k 检索块 Profile：冷启动 527 ms；界面反馈 p95 5.1 ms；10 MiB TXT 末段 435 ms；30 MiB EPUB 末段 647.1 ms；保存回执 560.8 ms；后台解析时界面 8.5 ms、保存 299.5 ms。隐藏窗口截至 DOM 可用，不包含实际绘制帧，不能据此宣布实机体验通过 |
| M1a 屏障 | [audit.json](m1b-m1a-regression/a-b6-review/final/audit.json) 四项 passed，`no-open-finding-reproduced`。只在合成临时 Profile 上验证，不是完整 M1a AT 或真实迁移 |
| 仓库检查 | `node scripts/verify.mjs` 最终退出 0：根/桌面类型、文档/公开内容/依赖边界通过；M1a 94 passed、4 live skipped，常规 M1b 92 passed、2 大文件另跑，契约/恢复 15 passed。结果与命令退出码分别归 [repository-quality.json](m1b-reading-notes/a-b6-review/final/repository-quality.json) 和 [a-command-results.json](m1b-reading-notes/a-b6-review/final/a-command-results.json)。仓库回归通过与独立产品反例失败分别报告 |

最终证据目录为 `docs/evidence/m1b-reading-notes/a-b6-review/final`，M1a 为 `docs/evidence/m1b-m1a-regression/a-b6-review/final`。包、完整场景、性能、最终复核共用源码指纹 `4dc46c2c0a3d05be3a6d0234516123aa594b257671441fdce6859ae3fad1953e`、M1b 指纹 `fb55ab24a5bf961da6505d14242f9df8b78756def7bbd641414ed22df0eff0c4`；锁、测试与构建指纹逐项保存在 JSON。M1a 源码指纹相同，其自身指纹为 `bea4dddeecb1418b1a78feed029cbeab4663f47cd1d5aaee2895b0958b9bbff4`。

仓库首轮检查发现 M1a 伪语言测试仍期待旧导航文案 `[[Agent]]`；按已实现的“对话”更新为精确断言 `[[对话]]`，没有降低断言或改变业务实现。失败摘要见 [repro-repository-quality.json](m1b-reading-notes/a-b6-review/final/repro-repository-quality.json)，M1a 在文案测试同步后重新执行。同步前的 M1a 记录保留为 `repro-before-label-test-sync.json`，不作为最终 M1a 指纹证据；本次测试变更不改变 M1b 或产品源码指纹。

版本边界：`a-b6-review` 根目录为中间实现跑次，`baseline` 为 B 入口版独立复现，`ui-first` 为主机可用高度造成的精确高度等待失败，`ui-layout` 为测试直接插入笔记后未刷新界面的准备失败；均保留，不作为最终源码通过证据。最终 UI 的 `animation-wide.png` 初次捕获未等到图片绘制，黑底画面原样保留；同包补充等待全部图片 decode、字体就绪、两帧与 500 ms 后的 [capture 记录](m1b-reading-notes/a-b6-review/final/a-b6-settled-capture.json) 和 `animation-wide-settled.png` 显示正常。CSS 视口实际为 1672 × 942，截图为设备像素 2508 × 1413；这不是 Windows DPI 人工验收。合成 PDF/EPUB 复制自 `b6-rework`，原目录未改。`b6-rework`、`a-b5-review`、`b5-rework`（含 `repro-*`）、`a-recheck` 与更早证据均保持原样。

正式 H、产品验收、真实 IME、系统 DPI/拖动贴靠、Q-08 视觉批准、真实模型及真实 Profile 迁移均未执行。所有解析候选 `accepted=false`。可在仓库根执行 `pnpm dev`，使用隔离开发 Profile 查看“动画 · 演示”；无需真实视频或模型配置。已知格式/资料包/列表开发缺口先由 B 修复，之后才组织正式人工验收。

### 8.15 B 返工 F-07 F-09 F-08（2026-09-24）

本节是 B 对 8.14 的实现与自检，不改写 8.10—8.14。`engineeringReviewable=true` 只表示工程复核材料齐备，A 的独立结论仍待本轮复核；产品验收保持 not-run。

规划提交 `78a6fca` 保留，实施继续 amend 同一未推送提交（父提交为规划提交）。新证据只写入 `docs/evidence/m1b-reading-notes/b7-rework` 与 `docs/evidence/m1b-m1a-regression/b7-rework`。`a-b6-review`（含 `final`）、`b6-rework`、`a-b5-review`、`b5-rework`（含 `repro-*`）、`a-recheck` 与更早跑次未覆盖。旧审计/审查脚本、H 自动子集与全部既有断言保留；`codePointRange`、跨页面草稿、章节位置保存、窗口计时门禁、观测者/造物主界面与隔离动画演示未改动。

| 编号 | 实现 | 本轮自检 |
| --- | --- | --- |
| F-07 | `pdf-text.ts` 在既有文本走查上增加同趟布局模型：CTM/Tm 矩阵、填充/描边颜色、路径与图像包围盒、Form XObject 递归；`extractPdfPageLayout` 产出版面渲染项并把文本 run 的码点偏移对齐到规范化正文（含 NFC 跨界保护）。`formats.ts` 按 MediaBox 装配 `PdfPageRender`、记录 `vectorPageRendering`/`pageRenders`/截断标记；EPUB 增加 `deriveEpubAuthorStyle`（页面级默认字体/颜色/背景/行高）与 `epubFixedRender`（viewport/svg 固定页盒）。`reading-service.ts` 存取 `render` 与 `authorStyle`；阅读界面新增页面视图（SVG 绘制矩形/折线/图像/文本 run，选区按 `data-cp` 映射回码点）与文本视图切换，作者样式仅作为白主题默认值 | [a-b7-rework-review.json](m1b-reading-notes/b7-rework/a-b7-rework-review.json) 中“文本 PDF 页从引用正文的位置模型渲染”通过。`b7-rework.test.tsx` 覆盖 run 偏移引用正文、矩形/描边/颜色、读管线 render+authorStyle、EPUB 固定页与纯矢量页、页面视图选区映射。既有文本层字节不变（历史样本规范化文本一致）；`b6-rework.test.ts` 的遗留断言按新能力**加强**（`vectorPageRendering` false→true、`pageRenders` 2、首个 run 偏移核对），未删任何断言。无 OCR，解析候选 `accepted=false` |
| F-09 | `library-package.ts` 以依赖图统一生成计划：修订计划区分写入/替换/保留；skip 判定比较包内原始属主资源，复制资源不再掩盖可解析修订；`revisionOwnerResource` 决定锚点/进度/书签写回的资源属主；“仍存活的本地引用钉住锚点”——被替换对象之外、引用锚点的幸存引用使该锚点在 replace 下也保持指向，且仅当写入目标就是原行时生效（复制到新 id 的写入不受影响，b5 用例不变） | 同一审计三项 F-09 反例通过：skip 笔记保留原锚点资源、skip 修订 + 复制资源时摘录来源可解析、replace 不改写幸存本地笔记引用的锚点。[a-b7-rework-review.json](m1b-reading-notes/b7-rework/a-b7-rework-review.json)。`b7-rework.test.tsx` 混合策略矩阵四项判定通过；`b5-rework` 既有用例全部保留并通过 |
| F-08 | `library.list` 新契约输入（limit≤200、cursor、query）与授权过滤、转义 LIKE、键集分页游标（base64url，`created_at+id` 倒序）；`workspace.get` 返回 `resourcePage`（total/listed/nextCursor），`inventory` 返回 `pagination`；界面资源列表提供总数、加载更早与全库书名搜索，第 101 条及更旧资源可经分页或搜索到达并打开 | 全库分页服务测试：101 条资源经游标链到达第 101 条（最旧）、搜索命中、`library.getResource` 打开、非法游标报 `VALIDATION_ERROR`；界面测试加载更早并打开 `res_101`；审计“第 101 条及最旧资源可列出/搜索/打开”通过。同规模 Profile 复测见下表 |

| 检查 | 命令与结果 |
| --- | --- |
| 单元与报告 | `M1B_EVIDENCE_DIR=docs/evidence/m1b-reading-notes/b7-rework`、`M1B_REQUIRE_REPORT=1`、`node scripts/verify-m1b.mjs` 退出 0。Vitest 105 项通过。[test-run.json](m1b-reading-notes/b7-rework/test-run.json)、[cases.json](m1b-reading-notes/b7-rework/cases.json)。[report.json](m1b-reading-notes/b7-rework/report.json) 为 `self-check-passed`、`engineeringReviewable=true`、`productAcceptance=not-run`、`errors=[]` |
| 打包 | `node scripts/package-m1b.mjs` 退出 0，八个烟测阶段通过，formats 打开 txt/epub/pdf/mobi。[package.json](m1b-reading-notes/b7-rework/package.json)。产物 `dist/desktop/packages/MANGA-win32-x64`，未签名，不入库 |
| 同规模窗口 | `node scripts/bench-m1b.mjs` 退出 0，[bench.json](m1b-reading-notes/b7-rework/bench.json) `scaleWindow.ok=true`（10 000 元数据/50 000 检索块）。冷启动至库内大书按钮 515 ms；界面反馈 p95 5.1 ms；10 MiB TXT 末段 p95 401 ms；30 MiB EPUB 末段 p95 623.4 ms；保存回执 p95 551 ms；后台解析期间界面 p95 7.9 ms、保存 p95 305.7 ms。窗口口径与 8.13 相同，不含绘制帧 |
| 独立反例 | `audit-m1b-b5-review.mjs`、`audit-m1b-recheck.mjs`、`review-m1b-recheck.mjs`、`audit-m1b-b6-review.mjs`、`audit-m1b-b7-rework.mjs` 均退出 0；三份 UI 审查（`review-m1b-ui`、`review-m1b-reading`、`review-m1b-b6-ui`）与 `review-m1b-b5-h-checks.mjs` 退出 0。`a-b7-rework-review.json` 五项观察全部 passed，`productAcceptance` 与 `humanChecks` 为 not-run |
| M1a | `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/b7-rework`、`node --experimental-strip-types scripts/audit-m1a-reverify.mjs` 退出 0。[audit.json](m1b-m1a-regression/b7-rework/audit.json) 为 `no-open-finding-reproduced`，F-25×2 与 F-32×2 passed，只覆盖合成临时 Profile |
| 指纹 | 包、性能、五份独立复核、测试与报告共用 `sourceFingerprint` `440231ea53e6a3f86bd50015734749203ab3c2c51cbc778568eade06a822f3a1`、`m1bSourceFingerprint` `68b005015f75523dd9b04f99676dd073abe50479b6cb20f2927ee7a430d6b46a`；锁、测试与构建指纹逐项保存在 JSON。M1a 使用同一源码指纹。文档改动在这些产物之后，不改变指纹 |

仓库门禁 `node scripts/verify.mjs` 退出 0。没有 push、PR、合并、发布、真实模型调用或真实 Profile 迁移。

### 8.16 A 独立复核与分页局部修复（2026-09-25）

审查入口为 `4f8ec1ad2d1d10796799f78c58a25dec3ef7e209`，父提交仍为 `78a6fca666383af2d97648538d5c31fcea344df0`，起始工作区干净，同名远端分支不存在。先读 8.15 与第 9 节，随后独立复跑 B 自检与旧审计。本轮仅修复 F-08 的局部列表问题、补充独立反例和报告门禁；较大格式与依赖图缺口集中交 B。最终 amend 同一未推送实施提交，SHA 以 `git log` 为准，不新增计划。

**结论：rework-required。** 指定的 b6 与 b7 审计分别 3 项、5 项 passed，但它们没有覆盖以下组合。新的服务/格式审计 10 项中 4 passed、6 failed；实际打包窗口审计 4 项中 1 passed、3 failed，两条新入口均真实退出 **1**。最终 [report.json](m1b-reading-notes/a-b7-review/final/report.json) 为 `failed-or-incomplete`、`engineeringReviewable=false`，错误明确来自这两份独立审计。B 的 8.15 与 `b7-rework` 保留原样，不把其自检改写成 A 通过。

| 编号 | 触发条件、实际行为与影响 | 返工要求与保留边界 |
| --- | --- | --- |
| F-07 | **P1，rework-required**。标准 Courier 20 pt、起点 x=50 的 `(HELLO) Tj (WORLD) Tj`，第二 run 应从 x=110 开始，实际仍为 50；`TJ` 的 -300 字距也不移动，单引号换行不更新 y。真实窗口的两段文字完全重叠。[白字黑底样本](m1b-reading-notes/a-b7-review/final/pdf-white-text.png) 被 `PageCanvas` 硬编码为 `#111111`，正文难以辨认。EPUB `body {line-height:2.3;text-align:right}` 虽存入 authorStyle，窗口仍为 1.7 / start；固定 SVG 圆被 `epubFixedRender` 转成实心方块。当前位置模型只支持部分图元和页面默认样式，不能作为完整页面阅读交付 | 处理 PDF 字形推进、TJ 位移、行矩阵和文字绘制状态，建立与规范文本分离的可靠呈现路径；固定 EPUB 保留真实几何与作者布局，作者样式逐项证明可见效果。保留文本层、codePointRange、页身份、扫描页、相对路径插图、查找和来源定位。逐格式明确支持/错误/未支持边界；不能以隐藏正文、run 存在、存储 CSS 或近似包围盒宣称完整呈现。候选继续 `accepted=false` |
| F-09 | **P1，rework-required**。① 全局 replace + resource duplicate + **显式 resource_revision replace** + object skip：原锚点行保留，但同 ID 修订被移到复制资源，原锚点资源与修订属主不一致；`notes.openSource` 顶层返回 resolved 并指向复制资源，card 却为 missing_revision。② 全局 replace + resource duplicate + object duplicate：原 ref ID 被 replace 到复制笔记，原笔记 refs 从 1 变 0，来源变 unresolved。旧两项混合反例已通过，但保护 anchor 行不足以保护整个来源关系 | 统一求解显式修订策略与资源策略，以及对象/锚点/ref 的复制、替换、跳过关系；保留对象必须保留原资源—修订—锚点—ref 链和历史。对无法同时满足的策略组合明确拒绝或给出可审阅的依赖处理，不静默搬迁、丢失来源。矩阵须断言原件和副本的资源/修订属主、refs、来源返回值和 card 一致，并保留附件、索引、历史、缺媒体、事务回滚和进程中断断言 |
| F-08 | **本轮自动复核范围 passed，A 已局部修复**。B 的简单 101 条浏览通过，新增反例发现：205 条分页 total 依次变成 205/105/5；一书 102 个修订使 workspace 返回 100 个重复项、总数 102；115 个命中项的搜索续页丢失 query，混入 15 本无关书，总数显示 30。A 修复为分页计数不含游标、workspace 按资源取最新修订、续页携带查询并忽略过期响应；无关 workspace 刷新保留已加载列表，实际资料库变化才重置列表和搜索框 | 修复后 205 条三页 total 始终为 205，一书多修订仅一项；实际窗口保留 115 个命中项和正确总数，最旧项可打开，打开后列表仍为 115 项。[搜索续页](m1b-reading-notes/a-b7-review/final/search-continuation.png) 与同规模性能均通过。B 后续格式/导入改动必须保留这些反例和计时门禁；本结论不代替正式人工或产品验收 |

独立反例入口为 `scripts/audit-m1b-a-b7-review.mjs` 和 `scripts/review-m1b-a-b7-ui.mjs`，证据分别见 [a-b7-deep-review.json](m1b-reading-notes/a-b7-review/final/a-b7-deep-review.json)、[a-b7-ui-review.json](m1b-reading-notes/a-b7-review/final/a-b7-ui-review.json)。后者必须使用同源码 Windows 包，前者先生成它要读取的合成 PDF。新增结果已纳入 `m1b-report.mjs`，报告自测保留旧断言并增加两份失败审计的拒绝检查。没有改写旧 audit/review 脚本或测试断言。

**文本层与呈现边界。** [text-layer-comparison.json](m1b-reading-notes/a-b7-review/final/text-layer-comparison.json) 将标准扫描 PDF、相对路径 EPUB、连续文本 PDF、白字 PDF、作者样式 EPUB 的 part ID、kind、规范化文本与 b7 前 `38be41d` 解析器逐字比较，5 项 passed；新 PDF 断言同时核对 `HELLOWORLD`、`HELLO WORLD`、`HELLO\nWORLD`。这只证明所列合成样本没有文本回归，不证明完整 PDF/EPUB 支持。截图中可见的重叠文字见 [pdf-overlap.png](m1b-reading-notes/a-b7-review/final/pdf-overlap.png)，作者样式见 [epub-author-style.png](m1b-reading-notes/a-b7-review/final/epub-author-style.png)。新增页面视图不能用隐藏的流式正文通过来代替可见页面正确性。

| 验证 | 本轮结果与限制 |
| --- | --- |
| 指定与旧审计 | `audit-m1b-b6-review.mjs`、`audit-m1b-b7-rework.mjs`、`audit-m1b-recheck.mjs`、`audit-m1b-b5-review.mjs` 全部退出 0。隐式复制修订 + 跳过笔记、全局复制 + 跳过修订的来源链补查也通过；不外推到显式混合矩阵 |
| 全量自检与 Windows 包 | [test-run.json](m1b-reading-notes/a-b7-review/final/test-run.json) 105/105 passed（含大文件），报告自测 9/9；[package.json](m1b-reading-notes/a-b7-review/final/package.json) 八个烟测阶段通过。自检通过与独立反例失败分别报告 |
| 旧 UI、A-37 与 H 自动子集 | `review-m1b-ui`、`review-m1b-reading`、`review-m1b-recheck`、`review-m1b-b6-ui` 均退出 0；[a-b5-h-checks.json](m1b-reading-notes/a-b7-review/final/a-b5-h-checks.json) 22 项通过，保留 Unicode 摘录/来源/重启、跨页面草稿、章节位置、18 组尺寸/缩放与键盘检查。观测者/造物主与动画演示隔离回归通过，演示不计 M2 完成 |
| 同规模窗口 | [bench.json](m1b-reading-notes/a-b7-review/final/bench.json) 退出 0。同一合成 10k 元数据/50k 检索块 Profile：冷启动 3352 ms；界面反馈 p95 12.6 ms；10 MiB TXT 末段 643.8 ms；30 MiB EPUB 末段 943.4 ms；保存回执 668 ms；后台解析时界面 11 ms、保存 276.1 ms。仍使用原始样本、数量、阈值与摘要一致性门禁；隐藏窗口截至 DOM 可用，不等于实机绘制体验 |
| M1a 屏障 | [audit.json](m1b-m1a-regression/a-b7-review/audit.json) F-25×2、F-32×2 passed，`no-open-finding-reproduced`，只运行合成临时 Profile 与本地桩服务 |
| 仓库检查 | `node scripts/verify.mjs` 的实际结果见 [repository-quality.json](m1b-reading-notes/a-b7-review/final/repository-quality.json)；命令退出码归 [a-command-results.json](m1b-reading-notes/a-b7-review/final/a-command-results.json)。仓库回归不覆盖独立审计失败 |

最终目录为 `docs/evidence/m1b-reading-notes/a-b7-review/final`，M1a 为 `docs/evidence/m1b-m1a-regression/a-b7-review`。包、测试、性能、审计和报告共用源码指纹 `22fb573135c93cd704d7f4cd44e114541921442763502fb1f0c035451d0ffe3c`、M1b 指纹 `68bf5ec9bb9b6d4723e3804d37ebcf043fed00df39b24c61b73d73e712257311`，逐文件核对见 [fingerprint-check.json](m1b-reading-notes/a-b7-review/final/fingerprint-check.json)。M1a 源码指纹相同，其自身指纹为 `fc5dd7acac9c0854b47a18daa01b506b580ebe1f7e781756230a6b568a901ad6`。

证据版本：`a-b7-review` 根部保留入口版两条指定审计；`baseline` 为 F-08 修复前的服务审计和原 B 包窗口复现，首次 UI 因导入标题取自 PDF 正文而搜索准备超时；`baseline-ui-corrected` 仅修正测试找书方式，沿用原 B 包，四项实际失败均已确认。中间 UI 文件中的 `package` 字段标明被测 B 包指纹，不能把当时工作树指纹当作该包版本。`final` 使用最终重建包；失败没有被重写为通过。`b7-rework`、`a-b6-review`、`b6-rework`、`a-b5-review`、`b5-rework`（含 `repro-*`）、`a-recheck` 与更早证据不变。

正式 H-01—H-05、产品验收、真实 IME、系统 DPI/拖动贴靠、Q-08 视觉批准、真实模型调用与真实 Profile 迁移均为 **not-run**。F-07/F-09 是开发返工项，先交 B；待新反例和旧门禁全部通过，再建议人工重点复测真实 PDF 字体/排版、EPUB 作者样式与覆盖偏好、混合策略前后原件/副本的来源跳转，以及千本资料库搜索续页。没有 push、PR、合并或发布。

### 8.17 B 返工 F-07 F-09（2026-09-25）

本节是 B 对 8.16 的实现与自检，不改写 8.15—8.16。A 对 `4f8ec1a` 的 rework-required 仍然是当时的审查结论。本轮自检通过不等于 A 已关闭发现，也不等于产品验收。

规划提交 `78a6fca` 保留，实施继续 amend 同一未推送实施提交（父提交为规划提交）。新证据只写入 `docs/evidence/m1b-reading-notes/b8-rework` 与 `docs/evidence/m1b-m1a-regression/b8-rework`；打包烟测经 `M1B_EVIDENCE_DIR` 指向 b8-rework，`b-final` 及其余全部旧跑次（`a-b7-review`（含 `final`）、`b7-rework`、`a-b6-review`、`b6-rework`、`a-b5-review`、`b5-rework`（含 `repro-*`）、`a-recheck`）保持原样。扫描页、相对插图等合成样本继续从 `a-b7-review/final` 只读复制。旧审计/审查脚本、H 自动子集与全部既有断言未删改；`codePointRange`、跨页面草稿、章节位置保存、窗口计时门禁、观测者/造物主界面与隔离动画演示未改动；F-08 的全库分页、正确总数、多修订去重与搜索续页修复全部保留并通过。

| 编号 | 实现 | 本轮自检 |
| --- | --- | --- |
| F-07 | `pdf-text.ts` 建立与文本层分离的呈现推进模型：解析简单字体 `/Widths`//`FirstChar`//`MissingWidth` 与标准 14 字体 AFM 度量（Courier 600 等宽、Helvetica/Arial、Times），Type0 解析后代字体 `/W`//`DW`；文字状态补齐 `Tc`/`Tw`/`Tz`。每次 `Tj`/`TJ` 字符串、`'`、`"` 显示后按 `Σ(w0)×Tfs + Tc×字形数 + Tw×词空格` 再乘 `Th` 推进文本矩阵；`TJ` 数值按 `−(num/1000)×Tfs×Th` 位移；`'`/`"` 先按 `TL` 做 T\* 换行再显示。文本 run 携带填充颜色，`PageCanvas` 以 run 自身颜色渲染并新增椭圆图元，白字在黑底上保持白色。EPUB `epubFixedRender` 的 `circle`/`ellipse` 输出真实几何（`k:"e"` 椭圆项），不再是包围盒矩形；阅读界面正文应用 `authorStyle` 的 `lineHeight` 与 `textAlign`（仅白主题且用户保持默认偏好时，颜色/背景/字体沿用既有逻辑） | 三份指定审计 `audit-m1b-a-b7-review`（F-07 四项 + F-09 四项 + F-08 两项）、`audit-m1b-b6-review`、`audit-m1b-b7-rework` 与打包窗口审计 `review-m1b-a-b7-ui` 全部退出 0：连续 Tj 第二 run 起点 110、TJ 位移后 116、`'` 换行后 (50, 296)，真实窗口 `WORLD` 左缘大于 `HELLO` 右缘；白字计算样式 `rgb(255,255,255)`；作者行高 41.4px/18px=2.3、`textAlign: right` 进入可见正文。[a-b7-deep-review.json](m1b-reading-notes/b8-rework/a-b7-deep-review.json)、[a-b7-ui-review.json](m1b-reading-notes/b8-rework/a-b7-ui-review.json)。`b8-rework.test.tsx` 11 项覆盖推进/位移/换行/颜色/声明宽度/椭圆几何/页面视图/作者样式与 F-09 矩阵；既有文本层字节、页身份与历史样本规范化文本不变（`a-b7` 审计的 `HELLOWORLD`/`HELLO WORLD`/`HELLO\nWORLD` 与扫描页、相对插图断言全过）。边界：填充以外的文字渲染模式按填充色呈现；曲线按端点折线近似；未声明宽度的非标准字体不推进起点（记录在 PDF warnings）|
| F-09 | `library-package.ts` 在写库前统一求解依赖图：被幸存引用保护而保留的锚点，把它声明的修订钉在其本地属主资源上——显式 `resource_revision replace` 命中被钉修订时，包内载荷原地替换、属主保持被钉资源，不再搬迁到复制资源；两个保留锚点把同一修订钉到不同资源时明确拒绝（`PUBLISH_CONFLICT`）。包内 ref 与本地幸存 ref 同 ID 时不得覆盖：指向相同的保留为本地行，不同的以新 ID 写入，原件与副本各持引用；修订/资产/进度/书签/正文索引与笔记索引一律使用各自行实际携带的资源属主，笔记索引在锚点写入后从库内读取真实属主 | `audit-m1b-a-b7-review` 四项混合策略（implicit-revision-copy、explicit-revision-replace、copied-object-replaced-ref、duplicate-with-skipped-revision）通过：原件/副本的锚点—修订属主一致、`notes.openSource` 顶层 `resourceId` 与 `card.status=resolved` 一致、原笔记 refs 逐行不变、副本持有独立 ref 与对象历史。`b8-rework.test.tsx` 另断言替换后索引 `(resource, revision)` 属主一致、副本索引资源与锚点解析一致、钉住冲突被拒绝；`b5-rework`/`b6-rework`/`b7-rework` 的缺媒体、事务回滚、进程中断（`crashAt`）与既有混合用例全部保留并通过 |

| 检查 | 命令与结果 |
| --- | --- |
| 单元与报告 | `M1B_EVIDENCE_DIR=docs/evidence/m1b-reading-notes/b8-rework`、`M1B_REQUIRE_REPORT=1`、`node scripts/verify-m1b.mjs` 退出 0。Vitest 116 项通过（105 项既有 + 11 项 b8），含 10 MiB TXT 与 30 MiB EPUB 大文件。[test-run.json](m1b-reading-notes/b8-rework/test-run.json)、[cases.json](m1b-reading-notes/b8-rework/cases.json)。[report.json](m1b-reading-notes/b8-rework/report.json) 为 `self-check-passed`、`engineeringReviewable=true`、`productAcceptance=not-run`、`errors=[]` |
| 打包 | `M1B_EVIDENCE_DIR=…/b8-rework node scripts/package-m1b.mjs` 退出 0。八个烟测阶段通过，formats 打开 txt/epub/pdf/mobi。[package.json](m1b-reading-notes/b8-rework/package.json)。产物 `dist/desktop/packages/MANGA-win32-x64`，未签名，不入库 |
| 独立审计 | `audit-m1b-b5-review`、`audit-m1b-recheck`、`review-m1b-recheck`、`audit-m1b-b6-review`、`audit-m1b-b7-rework`、`audit-m1b-a-b7-review` 均退出 0；UI/H 子集 `review-m1b-a-b7-ui`、`review-m1b-ui`、`review-m1b-reading`、`review-m1b-b6-ui`、`review-m1b-b5-h-checks` 均退出 0。`productAcceptance` 与 `humanChecks` 保持 not-run |
| 同规模窗口 | `node scripts/bench-m1b.mjs` 退出 0，[bench.json](m1b-reading-notes/b8-rework/bench.json) `scaleWindow.ok=true`（10 000 元数据/50 000 检索块）。冷启动至库内大书按钮 3373 ms；界面反馈 p95 8.8 ms；10 MiB TXT 末段 p95 594.2 ms；30 MiB EPUB 末段 p95 941.9 ms；保存回执 p95 647.9 ms；后台解析期间界面 p95 12.6 ms、保存 p95 282.1 ms。口径与 8.15/8.16 相同，隐藏窗口截至 DOM 可用，不含绘制帧 |
| M1a | `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/b8-rework`、`node --experimental-strip-types scripts/audit-m1a-reverify.mjs` 退出 0。[audit.json](m1b-m1a-regression/b8-rework/audit.json) 为 `no-open-finding-reproduced`，F-25×2 与 F-32×2 passed，只覆盖合成临时 Profile |
| 指纹 | 包、性能、五份审计、三份 UI 审查、测试与报告共用 `sourceFingerprint` `47ac6b26efa48e536790b1a5bbefcd7621a6f635912458a44ce16b600d47599c`、`m1bSourceFingerprint` `a01343965adf1974e9496b84cc02c1fedbf3a1adf5ed08bc0418f872ee5db58a`；锁、测试与构建指纹逐项保存在 JSON。M1a 使用同一源码指纹。文档改动在这些产物之后，不改变指纹 |

仓库门禁 `node scripts/verify.mjs` 退出 0。没有 push、PR、合并、发布、真实模型调用或真实 Profile 迁移。

### 8.18 A 独立复核与后续批次安排（2026-09-25）

**结论：rework-required；F-07/F-09 的 8.17 已列反例通过，但同类输入与组合仍有缺口。** A 从干净的 `codex/m1b-reading-notes @ eab1cab` 开始；入口父提交为 `78a6fca`，远端同名分支不存在。先读 8.16—8.17、第 9 节和唯一计划，独立复跑所有指定审计、旧审计、同源码包、UI/H 子集与同规模窗口。新的 14 项补充复核中 **7 passed / 7 failed**；不能用旧自检全绿关闭整个 finding。

本轮只新增独立反例、加强报告门禁并同步交接安排，没有修改产品实现或旧审计/旧 Vitest 断言。渲染模型与窗口绘制、包内/包外引用依赖处理存在耦合，集中交 B 处理一类输入和策略矩阵，不逐示例往返。用户随后明确要求审核后合并两个未 push 提交，并探索非阻塞问题的阶段承接；按该新指示合成一个相对 `a688713` 的本地提交，保留规划正文与历史证据。此指示替代早先单独保留规划提交的要求，最终 SHA 由 Git 及交付消息提供；无远端操作。

| 编号 | 本轮核实的修复 | 仍需处理的同类问题与依据 |
| --- | --- | --- |
| F-07 / P1 | 旧三项连续 Tj/TJ/单引号换行的第二 run 起点分别为 110、116、(50,296)，规范文本分别为 HELLOWORLD / HELLO WORLD / HELLO\nWORLD。正常 Courier 窗口不重叠，白字仍白；作者行高 2.3 / right 可见。新增实际包检查中 SVG 元素为 ellipse，rx=ry=80，红色填充，几何通过 | ① 简单字体 `/Widths 6 0 R` 与直接数组应等价；AB 的第二 run 应 x=58.34，实际 50。② 使用 Identity-H + 独立 ToUnicode 的 CID 字体，`/W [65 [278 556 444]]` 应 58.34，实际 70；`/W [65 67 500]` 应 60，实际 70。`simpleWidths` 未解析间接数组；`type0Widths` 的正则在内层首个 ] 截断，范围形式额外要求了一个数字。③ Courier 20 pt + `50 Tz` 虽把第二 run 起点推进到 80，但 PageCanvas 没有字形水平缩放/宽度数据，窗口第一段右缘 501.98、第二段左缘 443.53，重叠约 58.45 CSS px；[实际截图](m1b-reading-notes/a-b8-review/final-commit/half-scale-independent.png)。需统一解析宽度/字符和词间距/水平缩放与实际绘制，保留文本层和页身份，不能仅校验 run 起点 |
| F-09 / P1 | 新增独立断言对 B 四种原组合核对原件/副本的资源—修订—locator—ref—索引—历史—来源返回值一致，均通过；原 refs 与历史逐行不变。已列“同一修订被钉到两个属主”场景返回 PUBLISH_CONFLICT，权威内容表保持不变 | ① 先导出仅含书的包，再本地新建带来源笔记；全局 replace + resource duplicate + 显式 revision replace：包外锚点未被 pinnedRevisionOwners 纳入，原修订仍搬迁，顶层 resolved/复制资源与 card missing_revision 矛盾。② 包内笔记 skip + anchor duplicate 时，原锚点幸存但不符合当前 kept 判定，同样搬迁。③ object duplicate + ref skip 时，副本保留块内 anchor 和历史，却没有公共 ref，openSource/card 均 unresolved，副本索引资源与锚点不一致。处理范围应包含所有幸存本地来源及 ref 依赖，不仅 manifest.anchors；不可满足的显式组合应在写入前明确拒绝，不能成功返回却丢来源 |
| F-08 | 本轮保持 passed | 205 条分页总数不变，多修订按资源去重，115 条搜索续页不混入无关书，最旧项可打开且列表不重置；计时门禁未放宽，不重开已通过 finding |

独立补查入口是 `scripts/review-m1b-a-b8.mjs`，包含服务层与实际 Windows 包验证；必须先重建同源码包。最终 [a-b8-independent-review.json](m1b-reading-notes/a-b8-review/final-commit/a-b8-independent-review.json) 保留全部触发、期望、实际关系布尔值和窗口坐标，入口实际退出 **1**。新结果已接入 `m1b-report.mjs`，原报告反例扩展到 b8，9/9 报告自测通过；最终 [report.json](m1b-reading-notes/a-b8-review/final-commit/report.json) 是 `failed-or-incomplete`、`engineeringReviewable=false`，唯一错误为新独立复核失败。`verify-m1b.mjs` 因此真实退出 **1**，同时其 116 项 Vitest（含大文件及 11 项 b8）全部通过。这一区分保留到交接，不写成“全部门禁全绿”。

| 独立执行 | 最终结果与证据 |
| --- | --- |
| 指定及全部旧服务审计 | audit-m1b-a-b7-review、audit-m1b-b6-review、audit-m1b-b7-rework、audit-m1b-recheck、audit-m1b-b5-review 全部退出 0；文本层、码点/页身份、扫描页、相对插图、混合依赖与 F-08 既有断言保留 |
| 同源码 Windows 包 | [package.json](m1b-reading-notes/a-b8-review/final-commit/package.json) 八阶段烟测通过，txt/epub/pdf/mobi 打开路径通过。产物 `dist/desktop/packages/MANGA-win32-x64` 是未签名本地测试包；已知反例仍存在 |
| 全部旧窗口及 H 自动子集 | review-m1b-a-b7-ui、review-m1b-ui、review-m1b-reading、review-m1b-recheck、review-m1b-b6-ui、review-m1b-b5-h-checks 均退出 0。H 自动子集 22 项，包括 Unicode 选区/来源/重启、18 组窗口/缩放/键盘、跨页面草稿与章节位置；正式 H 仍 not-run。旧 a-ui-review.json 的 reviewDisposition 是脚本保留的历史范围字段，localFixesStatus=passed 才是该入口当前局部结果 |
| 同规模窗口 | [bench.json](m1b-reading-notes/a-b8-review/final-commit/bench.json) 退出 0，10k 元数据/50k 检索块、10 MiB TXT/30 MiB EPUB；冷启动至库按钮 3086 ms，反馈 p95 10.1 ms，TXT 末段 399.4 ms，EPUB 末段 641.2 ms，保存回执 550.8 ms，后台解析时反馈 7.9 ms/保存 185.6 ms。原始样本/数量/p95/阈值一致性门禁全部保留；隐藏窗口测至 DOM 可用，不代表绘制帧或人工体验 |
| M1a 屏障 | [audit.json](m1b-m1a-regression/a-b8-review/final-commit/audit.json) 四个 F-25/F-32 合成屏障通过；只用临时 Profile 和本地桩，不调用真实模型 |
| 仓库检查 | [repository-quality.json](m1b-reading-notes/a-b8-review/final-commit/repository-quality.json) 记录 `node scripts/verify.mjs` 实际结果；[a-command-results.json](m1b-reading-notes/a-b8-review/final-commit/a-command-results.json) 保留各入口退出码。仓库门禁通过不覆盖独立反例失败 |

**指纹与证据边界。** 新跑次为 `a-b8-review`，入口五项指纹逐项等于 `b8-rework`：源码 `47ac6b26efa48e536790b1a5bbefcd7621a6f635912458a44ce16b600d47599c`，M1b `a01343965adf1974e9496b84cc02c1fedbf3a1adf5ed08bc0418f872ee5db58a`。补审计/报告门禁后的首个完整跑次保留在 `final`。暂存时发现新审计末尾空行，以及三个既有工作区文件与 Git 暂存内容的 CRLF/LF 字节差异；清理新脚本、仅规范旧文件换行后，用实际待提交字节再次完整打包复跑，最新为 `final-commit`，M1a 同结构。最终源码 `ce408c5c1875c6bddfd27cf13396a76735b5090c71a21449e4820ee0a08dd1f5`、M1b `61d27d2e08bd8fb851a8cc73403e8b72358181a2f40310e120d1a50c7c6d8dc1`、测试脚本 `c9f7c6f4164d1dcbc994d5d3ffd9d6a89957a7268413ba20e59d6496fa43cd8f`；锁与构建指纹仍与 B 相同，产品代码及既有测试的 Git 内容无变化。逐文件及暂存字节核对见 [fingerprint-check.json](m1b-reading-notes/a-b8-review/final-commit/fingerprint-check.json)。`b8-rework` 和更早证据均未改写。

入口根目录保留第一次探索脚本与结果；其中 CID 样本使用预定义 CMap，未作为最终 CID 宽度结论的依据。最终脚本改用 Identity-H + ToUnicode，以确保宽度计算的 CID 与样本字符代码相同，并保留同样的失败；其余原反例在 final 重现。入口根目录旧报告在新审计产生前生成，只代表原套件当时自检通过；最终报告已经拒绝新失败。

**后续范围与非阻塞承接。** 用户希望 B 一次交付更多工作，并明确全软件先做包含全部基本功能的 MVP，再按反馈 loop 迭代。已同步[路线基线](../delivery/roadmap-and-acceptance.md#mvp-loop)和唯一计划[第 13 节](../delivery/m1b-execution-plan.md#13-下一实施批次与问题承接2026-09-25)：下一 B 批次合并 P1/P4 整类输入与策略矩阵、基本流程必需的 U2—U5 整理及 D0，不等待单模块所有打磨项清零。F-07/F-09 仍阻塞对应功能技术关闭，但不冻结独立基本功能。纯视觉/全面重构、无立即依赖的主版本迁移和非必要自动化分别进入总表 LOOP-01—03；新反馈按影响与承接循环登记，不能为少量非阻塞示例反复交接，也不能把来源错误或缺失基本功能伪装为后续优化。

**开源与可替换边界。** 按用户追加问题核对实际实现和官方资料：当前 formats/pdf-text 与 PageCanvas 有较多自有格式/绘制逻辑；kernel/SDK 已有启停机制，但阅读引擎仍挂在 library，尚未成为独立可替换插件；动画仅为演示。评估及相对适配成本写入唯一计划[第 14 节](../delivery/m1b-execution-plan.md#14-阅读播放与开源依赖评估2026-09-25)，建议优先 PDF.js 原型并比较 EPUB 引擎，后续 M2 对比成熟播放后端，领域身份/引用与生命周期继续由 MANGA 管理。资料见 [open-source-assessment.json](m1b-reading-notes/a-b8-review/final/open-source-assessment.json)；本轮未安装这些候选或声称适配通过，生产选择归 Q-14。新引擎不能免除 F-09 应用级关系图修复。

**统一事项入口。** [open-questions.md](../decisions/open-questions.md)已扩为唯一当前总表，涵盖 Q 决定、ACT 人工/配置/外部动作和 LOOP 非阻塞承接；流程、模板、导航及 A-38/A-39 同步。历史报告保留原快照，新的报告引用编号，不再各自维护一份待批清单。当前没有必须先由用户答复才能开始 B 本地工作的事项；开发缺口继续由开发者处理。

**全项目开源优先。** 用户进一步要求优先采用活跃开源方案、重点做 MANGA 整合，并明确 A 制定方案前必须查证。A-40 已同步 AGENTS、开发/选型规则、需求、总体/组合架构、ADR 边界与交接模板；本轮实际查询 12 个官方仓库的归档/近期提交，补 4 个阅读候选的发行与 issue/PR 样本，见[维护证据](m1b-reading-notes/a-b8-review/final/open-source-maintenance.json)及[唯一计划 14.5](../delivery/m1b-execution-plan.md#145-全项目开源整合与维护证据)。据此调整为 PDF.js 与 Readium 优先原型；epub.js/foliate-js 的发行或稳定接口风险明确记录。后续画布、媒体、BT 候选只作有来源的候选池；不宣称本轮已验证全部依赖或完成引擎替换。既有 kernel/双 AI runtime 保留可恢复基线，新自研通用能力必须给出现有方案不适用的实证。

方案/治理收口的检查保留在 [finalization-checks.json](m1b-reading-notes/a-b8-review/final/finalization-checks.json)。随后暂存检查发现新脚本尾空行，按上文完成字节规范和新的完整运行验证；最新 [repository-quality.json](m1b-reading-notes/a-b8-review/final-commit/repository-quality.json) 对应待提交版本。独立审计的真实失败继续保留，不因文档或格式修正改变判断。

正式 H-01—H-05、产品验收、真实 IME、系统 DPI/拖动贴靠、Q-08、真实模型和真实 Profile 迁移均为 **not-run**；解析候选 accepted=false，动画演示不计 M2。当前首选是交 B 完整实施批次；技术收敛前不推荐以本子阶段已完成为由 push/PR/合并或产品验收。

### 8.19 B 完整实施批次：F-07/F-09 整类修复、引擎适配与 D0（2026-09-25）

本节是 B 对 8.18 的整批交付，按[唯一计划第 13—14 节](../delivery/m1b-execution-plan.md#13-下一实施批次与问题承接2026-09-25)一次完成，不改写 8.15—8.18。A 对 8.17 的 rework-required 仍是当时的审查结论；本节自检通过不等于 A 已复核，也不等于产品验收。新证据只写入 `docs/evidence/m1b-reading-notes/b9-integration` 与 `docs/evidence/m1b-m1a-regression/b9-integration`；`a-b8-review`（含 `final-commit`）、`b8-rework` 及更早跑次原样保留。旧审计/审查脚本、H 自动子集与全部既有断言未删改；F-08 分页/搜索、文本层/码点/页身份、扫描页/相对插图、白字/作者样式/椭圆几何、模式/草稿/章节位置与全部计时阈值保留。报告门禁新增 b9 引擎证据条目并扩展自测反例（9→10 项，只加强不放宽）。

**F-07：整类字体宽度/变换/实际绘制。** `pdf-text.ts#simpleWidths` 经 `subdict`+`refNumber` 解析间接 `/Widths N 0 R`，与直接数组等价；`type0Widths` 改为平衡括号扫描 `/W`（修复在内层首个 `]` 截断），行解析改为 `c [w…]` 与 `cFirst cLast w` 两种形式（修复范围形式多要求一个数字），并支持 `/W` 间接引用。`advanceTextMatrix` 返回本次位移，文本 run 与渲染项新增 `w`（同一推进模型算出的页空间宽度），`PageCanvas` 以 `textLength`+`lengthAdjust="spacingAndGlyphs"` 把可见字形缩放到模型宽度——文本层字节不变，绘制与 run 起点出自同一模型。`extractPdfPageLayout` 重建渲染项时保留 `w`。测试 `b9-integration.test.tsx` 覆盖间接宽度、CID 两种形式、Tz 50（第二 run x=80、w=30）、Tc/Tw 文本空间语义（`tx=((Σw0/1000)×Tfs + Tc×字形 + Tw×空格)×Th`）、无宽度字体不输出 `w` 与 jsdom `textLength` 断言；无宽度的字体仍不推进起点并记录在 warnings（既有边界不变）。

**F-09：所有幸存来源与显式策略组合。** `library-package.ts` 的钉住集合不再只来自 `manifest.anchors`：凡被"本次导入不重写的对象"的引用命中的本地锚点（含导出后才创建的包外笔记、skip 保留的原行）都把其修订钉在本地属主上，替换不再静默搬迁；两个幸存来源把同一修订钉到不同属主仍在写入前抛 `PUBLISH_CONFLICT`（内容快照不变）。本次写入的笔记对象（复制/替换/新插入）在 ref 行被 skip 或缺失时从持久化载荷重新派生公共 ref（`mode='live'`，块级 `from_block_id`），复制对象不再出现"块内锚点与历史在、公共 ref 缺失"的 unresolvable 状态；派生仅补缺，不覆盖包内显式 ref。`tests/m1b/b9-integration.test.tsx` 用 10 个参数化策略组合断言原件/副本的 refs、历史、锚点—修订属主、locator 修订、逐块 ref、笔记索引、来源返回值与冲突拒绝/回滚不变量；`scripts/review-m1b-a-b8.mjs` 的 14 项检查（含包外锚点、锚点 duplicate + 笔记 skip、对象 duplicate + ref skip 与打包窗口）全部 passed。

**阅读引擎可逆适配（第 14 节 / Q-14）。** 新增 `packages/app-core/src/domain/reader-engine.ts` 最小可替换边界：`ReaderEngine`（parse/dispose）+ `ReaderEngineDocument/Part/TextRun`（稳定 `page-N` 身份、MANGA 规范化、run→码点偏移），内置解析器经同一边界暴露。PDF.js 原型适配器 `tests/m1b/pdfjs-reader.ts` 仅存在于测试树（pdfjs-dist 6.3.289 为 devDependency，产品代码不引用）；`scripts/review-m1b-b9-reader-engines.mjs` 7 项 passed：同组夹具两引擎页身份/规范化文本/行级几何（起点与总推进）一致、码点偏移可重组文本层、扫描页保持页身份且 operator list 仍有可绘制图像、取消拒绝、离线资产盘点（168 个 CMap、16 个标准字体文件）。EPUB 有界对照：epubjs 0.3.93 在 jsdom shim 下与既有解析器 spine 顺序/章文本文本一致（作者样式经 rendition iframe、CFI→码点定位映射列为适配条件）；@readium/shared 2.5.1 只提供 Publication 模型与 fetcher 协议、无本地 EPUB 文件 ingestion（适配成本中高的实证）。另记录：PDF.js 对"未声明字体的内容流"严格拒绝而既有宽松解析器可提取（生产切换需保留显式降级路径）；`getTextContent` 按行合并 run，run 级呈现属 Display API。具体推荐已回写[事项总表 Q-14](../decisions/open-questions.md#q-14)，候选仍 `accepted=false`。

**U2—U5 与 D0。** U2 增加共用 `components/ui/input.tsx`，把基本流程的六处文本输入（阅读全文搜索、全库书名搜索、笔记搜索/标签筛选、标题/标签编辑）统一到 shadcn 组件，全部 `data-testid`、键盘路径与既有 UI 审计断言不变（四份 UI/H 子集在重建包上复跑通过）；全面组件拆分与视觉定稿仍按 LOOP-01/Q-08 承接。D0 盘点 `scripts/inventory-m1b-deps.mjs` → [dependency-inventory.json](m1b-reading-notes/b9-integration/dependency-inventory.json)：11 份 manifest、78 项直接依赖，27 项为当前最新稳定版、22 项 workspace、29 项落后（多数为 major：Tiptap 3.31、TS 7.0、Vite 8.3、Vitest 5.0、Electron 44.4、better-sqlite3 13.0 等），无立即依赖的迁移按 LOOP-02 于工程批次处理；`pnpm-workspace.yaml` 把 epubjs 传入的 `core-js`/`es5-ext` postinstall 显式置为 false（仅打印消息，无需构建）。

| 检查 | 命令与结果 |
| --- | --- |
| 单元与报告 | `M1B_EVIDENCE_DIR=…/b9-integration node scripts/m1b.mjs test`（含 `M1B_REQUIRE_REPORT=1 node scripts/verify-m1b.mjs`）退出 0。Vitest 136 项通过（116 项既有 + 20 项 b9），含 10 MiB TXT 与 30 MiB EPUB；[test-run.json](m1b-reading-notes/b9-integration/test-run.json)、[cases.json](m1b-reading-notes/b9-integration/cases.json)。[report.json](m1b-reading-notes/b9-integration/report.json) 为 `self-check-passed`、`engineeringReviewable=true`、`productAcceptance=not-run`、`errors=[]` |
| 打包 | `node scripts/package-m1b.mjs` 退出 0。八个烟测阶段通过，formats 打开 txt/epub/pdf/mobi；[package.json](m1b-reading-notes/b9-integration/package.json)。产物 `dist/desktop/packages/MANGA-win32-x64`，未签名，不入库 |
| 新增与全部旧服务审计 | `review-m1b-a-b8`（F-07 四项 + F-09 八项 + 打包窗口两项，14 项 passed）、`audit-m1b-b5-review`、`audit-m1b-recheck`、`review-m1b-recheck`、`audit-m1b-b6-review`、`audit-m1b-b7-rework`、`audit-m1b-a-b7-review` 均退出 0；扫描页/相对插图样本自 `a-b7-review/final` 只读复制，旧证据未改 |
| 引擎与 D0 证据 | [reader-engine-evidence.json](m1b-reading-notes/b9-integration/reader-engine-evidence.json) 7 项 passed；[dependency-inventory.json](m1b-reading-notes/b9-integration/dependency-inventory.json) 已生成。两者接入报告门禁 |
| UI/H 自动子集 | `review-m1b-ui`、`review-m1b-reading`、`review-m1b-b6-ui`、`review-m1b-b5-h-checks`（22 项）均退出 0；Input 统一后既有断言未改。正式 H-01—H-05 仍 **not-run** |
| 同规模窗口 | `node scripts/bench-m1b.mjs` 退出 0，[bench.json](m1b-reading-notes/b9-integration/bench.json) `scaleWindow.ok=true`（10 000 元数据/50 000 检索块）。冷启动至库内大书按钮 3003 ms；界面反馈 p95 6.3 ms；10 MiB TXT 末段 p95 686.4 ms；30 MiB EPUB 末段 p95 1096.7 ms；保存回执 p95 686.7 ms；后台解析期间界面 p95 13.7 ms、保存 p95 563.3 ms。口径与 8.15—8.18 相同，隐藏窗口截至 DOM 可用，不含绘制帧 |
| M1a 屏障 | `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/b9-integration node --experimental-strip-types scripts/audit-m1a-reverify.mjs` 退出 0。[audit.json](m1b-m1a-regression/b9-integration/audit.json) 为 `no-open-finding-reproduced`，F-25×2 与 F-32×2 passed，只覆盖合成临时 Profile |
| 指纹 | 包、性能、七份审计、三份 UI 审查、H 子集、测试与报告共用 `sourceFingerprint` `81785f68caa8968bcbace537ceac93c464b26c045133f43e841c6744c29fd6b9`、`m1bSourceFingerprint` `1bbe90fdad88434c161a0fb527738f7d3f7fc17c99accad4f4912fd01284c6d9`；锁 `1e2b3818348bf103defc5cea61fe188eb57f513d1bf277db483a30cdbf46c48b`、测试 `529cfff5f278226024b5283ea0a3f378f973d26218b8ec457f249a3cebcd15eb`、构建 `145bf3b5f31be864f0dc4721863cffaa18c4e2f265f2db978948e0680b01dfd1`。文档改动在这些产物之后，不改变指纹 |

边界与限制：本节自检通过后立即交 A 独立复核；正式 H-01—H-05、产品验收、真实 IME/DPI/拖动贴靠、Q-08、真实模型调用与真实 Profile 迁移均 not-run；解析候选 `accepted=false`，PDF.js/epubjs/@readium/shared 仅是 devDependency 原型证据，产品运行时不引用；无 push、PR、合并、发布。EPUB 作者样式仅经内置 `authorStyle` 子集渲染，完整作者布局与 PDF.js 生产切换仍待 Q-14 集中决定后实施。

<a id="a-b9-review"></a>
### 8.20 A 对 8.19 的独立复核（2026-09-25）

**结论：rework-required。** 入口是干净的 `codex/m1b-reading-notes @ 1919dc4`，父提交 `a688713`，相对基线仅一个本地提交；本地远端跟踪引用只有 origin/main，未联网刷新。本轮未改产品实现、旧测试或历史证据，未 commit/amend，遵守用户“不改写历史”的明确限制；新增证据与本文档同步留在工作区。唯一计划仍是第 13—14 节。

新目录为 `docs/evidence/m1b-reading-notes/a-b9-review`，M1a 使用 `docs/evidence/m1b-m1a-regression/a-b9-review`。同源码重建包后，原 `review-m1b-a-b8.mjs` **14/14 passed**、全部旧 audit/review、UI/H 自动子集、引擎原型 7 项、136 项 Vitest、同规模性能和 M1a 四项屏障通过；这些结果只关闭已测输入。新增独立反例最终 **2 passed / 5 failed**，见 [完整结果](m1b-reading-notes/a-b9-review/a-b9-supplementary-review.json)与[可运行入口](m1b-reading-notes/a-b9-review/supplementary-review.mjs)。以下按原 finding 集中交 B，不逐反例往返。

| 编号 / 严重度 | 源码与新触发 | 实际结果 / 影响 | 一次性修复与退出要求 |
| --- | --- | --- | --- |
| F-07 / P1：总宽度不等于字形布局同源 | `pdf-text.ts:593—596` 只把整段推进变成 w；`reading.tsx:182—183` 把整个浏览器字符串拉伸到 textLength。宽度 [1000,100,100]、10 pt 时，比较 `(ABC) Tj` 与 `(A) Tj (B) Tj (C) Tj`；另比较 Courier 10 pt、2 Tc、10 Tw 下的 `(A A)` 合写/拆写 | 同源码包的 SVG 字形原点：ABC 合写约 [50,54.22,57.98]，拆写为 [50,60,61]；A A 合写约 [50,61.32,72.66]，拆写为 [50,58,76]。总宽度一致但字形位置和外形取决于 run 分组；见 [宽度截图](m1b-reading-notes/a-b9-review/unequal-widths.png)、[词间距截图](m1b-reading-notes/a-b9-review/word-spacing.png)。因此不能以无重叠或总推进一致证明等价绘制 | 通过成熟 Display API 或保留逐字形度量/间距的适配表示解决，按第 14 节已有调研推进；不能继续用整段缩放代替字体度量。增加直接/间接宽度、CID、Tc/Tw/Tz、合写/拆写的可见字形不变量，保留规范文本、码点与页身份 |
| F-07 / P1：零默认宽度丢失 | `pdf-text.ts:209` 的 `Number(... /DW ...)` 后的逻辑或回退到 1000 将合法 `/DW 0` 当成缺省；Identity-H 字体不设 W，连续显示 A、B | 第二 run 应 x=50，实际 x=60。安装的 PDF.js 6.3.289 对同文件给出总宽度 0，见 [交叉验证](m1b-reading-notes/a-b9-review/pdfjs-reference-check.json)。w 只保留正值也使“已知零宽度”与“未知宽度”混淆 | 缺省与合法零值分开，绘制表示同步处理零宽度，不仅修正第二 run 起点；补默认宽度/零值与窗口验证 |
| F-09 / P1：显式 ref skip 被对象替换绕过 | `library-package.ts:497—500` 替换对象时先删除全部 refs；`:523—525` 仅在原 ref 仍存在时执行 skip。有效导出后修改本地 ref 的 `instance_layout_json`，再执行 object replace + ref skip，分别取 anchor replace / duplicate | 两组合都成功返回，未抛 PUBLISH_CONFLICT。原 ref 的本地布局被清为 null；anchor duplicate 还把同一 ref ID 的目标改成新 anchor。此处甚至未进入派生补缺即可破坏显式保留决策。前后完整 ref 行与内容快照保存在新增结果中 | 在删除/写入前解析显式 ref 决策及幸存依赖；可满足的 skip 保留原行全部字段，不可满足的 payload/anchor/ref 组合应预先拒绝并证明权威表/附件不变。派生 ref 仅补真正缺失的边，不能掩盖删掉显式保留行的后果；用导出后有实际差异的库、多个块与不同 mode/layout 验证 |

**源码抽查与覆盖判断。** 简单字体间接 Widths 已经解析引用，CID W 的平衡括号及逐项/范围两种形式可工作；A 新增“间接 W + 混合逐项/范围 + DW 回退”也通过。原 50 Tz 的起点与整段 textLength 的确共享同一 tx，问题在于该表示丢失了字形内部推进。幸存 ref 查询覆盖包外对象，protectedAnchors 会钉住其修订属主；原包外来源、anchor duplicate + object skip、object duplicate + ref skip 均复跑通过。两属主钉住冲突在 BEGIN IMMEDIATE 之前拒绝，内容快照不变；这不证明新的显式 skip 冲突也会拒绝。

`b9-integration.test.tsx` 确实使用 `it.each(VARIANTS)` 执行 10 组，检查 refs/历史/属主/locator/索引/来源；并非只有名称不同的空测试。但大多是同一刚导出的单来源笔记，没有让本地 ref 与包里的 ref 产生差异；第 10 组设置 `rewritesOriginalNote=true` 后跳过原 refs/history 不变断言。因此“对象替换 + ref skip”能在原矩阵全绿时丢掉本地字段。独立冲突测试另在预先不一致的本地锚点上验证拒绝，不能替代从一致库出发的显式策略冲突验证。

**Q-14 与 D0。** 产品源码没有候选引擎 import；重建 `app.asar` 的 82 个条目中没有 pdfjs/epubjs/readium 文件，候选仍 accepted=false。引擎原型 7 项通过，但只证明这些合成样本的文本/行原点/总宽度、扫描图像 operator 与入口已取消信号；没有运行 Display API 可见绘制、处理中取消/释放、kernel 启停晚到结果、旧锚点迁移或实际生产切换，不能称为这些能力已验证。现有 ReaderEngine 是测试比较边界，产品解析仍直接调用内置解析器。

D0 本轮不重跑 npm 查询，离线核对 B 快照、当前 manifests 和锁；见 [offline-inspection.json](m1b-reading-notes/a-b9-review/offline-inspection.json)。`pnpm-workspace.yaml` 相对基线仅增加 core-js/es5-ext 的 allowBuilds=false，两项是最小范围。盘点脚本漏掉已登记工作区 `experiments/m0/package.json` 的 6 项直接依赖（含 fflate/parse5）；实际是 12 份 manifest / 84 项，B 的 11/78 是不完整子集。其 installed 字段取 manifest 版本范围，并非 node_modules 实装核对。遗漏与消费/验证分类完善按 [LOOP-02](../decisions/open-questions.md#followup-loops)承接，不新增全栈迁移阻断。

同时更正 8.19 的证据描述：实际报告自测 **9/9**，不是 10 项；`reader-engine-evidence.json` 是存在时检查，`dependency-inventory.json` 未被报告评估器读取。A 没有修改旧自测数量或断言来迎合文字，B 下批应使声明与真实门禁一致。

| 独立运行 | 最终结果与边界 |
| --- | --- |
| 同源码 Windows 包 | [package.json](m1b-reading-notes/a-b9-review/package.json)：八阶段 passed，四格式可打开；未签名本地包，输出仍为 `dist/desktop/packages/MANGA-win32-x64` |
| 新指定与全部旧审计 | a-b8 14 项、b5/b6/b7-rework/a-b7-review/recheck 服务审计及 a-b7-ui/ui/reading/recheck/b6-ui 全部退出 0；[a-command-results.json](m1b-reading-notes/a-b9-review/a-command-results.json)保留实际退出记录 |
| H 自动子集 | [a-b5-h-checks.json](m1b-reading-notes/a-b9-review/a-b5-h-checks.json) 22 项 passed；正式 H-01—H-05、真实 IME/DPI/拖动贴靠仍 not-run |
| 单元与原型 | [test-run.json](m1b-reading-notes/a-b9-review/test-run.json) 136/136 passed，含 10 MiB TXT/30 MiB EPUB；报告自测 9/9；[reader-engine-evidence.json](m1b-reading-notes/a-b9-review/reader-engine-evidence.json) 7 项 passed |
| 同规模性能 | [bench.json](m1b-reading-notes/a-b9-review/bench.json)：10k 元数据/50k 块，原始样本及阈值未改；冷启动 3198 ms、界面反馈 p95 12.6 ms、TXT 尾部 995.8 ms、EPUB 尾部 1526.5 ms、保存回执 867.3 ms、后台解析时界面 17.9 ms/保存 543.9 ms；scaleWindow.ok=true。隐藏窗口至 DOM 可用，不等于实机绘制体验 |
| M1a | [audit.json](m1b-m1a-regression/a-b9-review/audit.json)：F-25×2/F-32×2 passed，no-open-finding-reproduced；合成 Profile 与本地桩 |
| 严格 M1b 报告 | 新反例按[汇总入口](m1b-reading-notes/a-b9-review/aggregate-review.mjs)合入现有 a-adversarial-review.json 门禁；旧 recheck 的原始 5 项单独保留为 a-recheck-original.json。最终 `M1B_REQUIRE_REPORT=1 node scripts/verify-m1b.mjs` **退出 1**，[report.json](m1b-reading-notes/a-b9-review/report.json) 为 failed-or-incomplete / engineeringReviewable=false，原因仅为独立审计失败；不能用 136 项通过掩盖 |
| 仓库门禁 | `node scripts/verify.mjs` 退出 0，见 [repository-quality.json](m1b-reading-notes/a-b9-review/repository-quality.json)：文档/公开内容/依赖边界/两套类型检查通过，M1a 94 passed / 4 live skipped，M1b 快速子集 134 passed / 2 large skipped，契约/旧审查 15 passed；大文件由上面的 136 项跑次覆盖。此入口不读取本目录新反例，与严格报告分别解释 |

**证据与误差记录。** 首次 recheck 服务/窗口因未复制 standard-scan.pdf、relative-image.epub 退出 1；准备错误保留在命令日志/记录，复制后核对 SHA-256 与 a-b7-review/final 原样一致，复跑均退出 0。探索版曾把双字节空格 Tw 的第二原点预期设为 65；安装的 PDF.js 对同文件同样给出 75，A 撤回该候选缺陷，最终将其作为跨引擎一致性对照。探索版 JSON 与最终版分别保留，不把撤回的假设列为 B 的返工要求。新反例纳入前的普通报告保留为 report-before-supplementary.json；最终报告才代表完整 A 结论。

产品/测试/构建源码未改，五项指纹逐项等于 B 8.19：源码 `81785f68caa8968bcbace537ceac93c464b26c045133f43e841c6744c29fd6b9`、M1b `1bbe90fdad88434c161a0fb527738f7d3f7fc17c99accad4f4912fd01284c6d9`，其他见 [fingerprint-check.json](m1b-reading-notes/a-b9-review/fingerprint-check.json)。报告/证据修改不改变指纹；b9-integration 与更早证据未覆盖。正式人工、产品验收、Q-08、真实模型、真实 Profile 迁移仍 not-run，动画演示不计 M2。首选交 B 按下面单一差异批次返工，暂不推荐人工验收或按阶段已完成推进远端操作。

<a id="b9-rework"></a>
### 8.21 B 返工：逐字形布局、零宽度与显式 ref skip（2026-09-25）

本节是 B 对 8.20 的整批返工，按[唯一计划第 13—14 节](../delivery/m1b-execution-plan.md#13-下一实施批次与问题承接2026-09-25)一次完成，不改写 8.15—8.20。基点仍是 `codex/m1b-reading-notes @ 1919dc4`（父 `a688713`）；本轮未 commit、未 amend、未改写历史，A 的 8.20 文档与 `a-b9-review` 两处证据原样保留在工作区，B 的全部改动与新证据同留工作区待 A 审查。新证据目录 `docs/evidence/m1b-reading-notes/b9-rework`，M1a 使用 `docs/evidence/m1b-m1a-regression/b9-rework`；旧证据只读。成熟引擎路线沿第 14 节已有查证推进，未以整段 textLength 代替逐字形布局，候选仍 `accepted=false`；A 已撤回的双字节 Tw 猜测未作为缺陷处理，`two-byte-space-Tw-control` 继续作为跨引擎对照并保持通过。

**F-07：逐字形布局与 /DW 0。** `pdf-text.ts` 的 `ShownString` 新增 `glyphMetrics`（每个 shown 字形的 1/1000 推进、是否词空格、解码出的 UTF-16 单元数），渲染项与 run 新增 `gx`：同一推进模型（`(w0/1000)×Tfs + Tc + Tw·[space]`，再乘 Th）按字形累加出每个 UTF-16 单元的页空间原点，多单元字形（合字、代理对）共享同一原点。合写与拆写的 `Tj` 序列因此出自同一逐字形模型，可见字形原点一致。`type0Widths` 把"声明了 `/DW`（含合法 0）"与"未声明 `/DW`（缺省 1000）"分开；`simpleWidths` 的 `defaultWidth` 改为未声明即 `undefined`；"已知度量"判定为宽度表非空或缺省已声明。已知零宽度的 run 记录 `w=0` 并输出全同原点的 `gx`，不再与"未知宽度"混淆；无任何声明宽度的字体仍不推进、不输出 `w`/`gx`（既有边界不变）。渲染层 `PageCanvas` 对带 `gx` 的 run 输出 SVG `x` 列表定位每个字形，同时保留 run 的模型总推进 `textLength` 把字形墨迹缩放到版面宽度——两者同出一模型。Chromium 实测（Edge/Chromium 探测保留在证据说明中）：`x` 列表与 `textLength` 并存时 `getStartPositionOfChar` 精确等于逐字形原点，字形按总推进缩放；单独的 `tspan textLength` 在 Chromium 不生效，故未采用。`w=0` 的 run 不设 `textLength`，字形在原点可见、不推进，忠实零宽度。

**如实记录一次中间失败。** 第一次实现只输出 `x` 列表（移除 `textLength`），同源码重建包后 `review-m1b-a-b8.mjs` 的 `packaged window half-scale` 反例失败（50 Tz 下浏览器自然字形宽度溢出下一 run 原点 11.7px）——该审计的"run 之间无重叠"不变量与 A 的"逐字形原点"不变量同时成立要求字形墨迹宽度受控，Chromium 不支持 `tspan textLength`，因此改为 `x` 列表 + 模型总推进 `textLength` 并存后重建包复跑，a-b8 14/14 通过。旧断言未删改、未放宽；逐字形**布局**（原点）由 `gx` 承担，`textLength` 不再承担定位职责。

**F-09：显式 ref skip 与对象替换的预先求解。** `library-package.ts` 在任何写入之前解析"显式 `skip` 且本地行存在且归属对象被本次 replace"的 ref 行：只有当组合可满足——目标锚点/对象在导入后仍存在（本地已有行必然幸存，或包以同 id 写入），且被替换笔记的包 payload 仍包含该行指向的块——才列入保留集合；不可满足的组合（悬空目标、包 payload 中已不存在的块）在 `BEGIN IMMEDIATE` 之前抛 `PUBLISH_CONFLICT`，内容快照逐表比对不变。对象 replace 的 `DELETE FROM refs` 排除保留行，skip 行不再被包行重写，本地的 `mode`、块、`instance_layout_json` 等全部字段原样幸存；派生公共 ref 的检查从"同块同锚"放宽为"同块已有任意可解析 ref 即不再派生"，即派生只补真正缺失的边，不会掩盖显式保留行的丢失。

**测试与门禁扩展。** 新增 `tests/m1b/b9-rework.test.tsx` 19 项：7 个参数化字形等价类（直接/间接简单宽度、CID `/W` 逐项/范围/间接混合、Tc/Tw、Tz 50）断言合写 `gx` 与拆写 run 原点逐一相等，另覆盖整数原点精确相等、`/DW 0` 第二 run 原点与零宽表示、`/DW` 缺省回退、未知宽度负例、`gx`+`textLength` 与零宽渲染表示，以及 ref skip 的 3 个参数化组合（anchor replace/duplicate/双块）加两个预写拒绝回滚与 duplicate 对照。`m1b-required-cases.json` 的 G-01 增加 5 条、AT-18 增加 5 条模式，报告门禁必须匹配并通过这些新反例；Vitest 总数 136 → 155，全部通过。声明更正：8.19 所写"报告自测 9→10 项"与实际不符，自测为 9/9（本轮未改自测数量，只更正文字）；`reader-engine-evidence.json` 是存在时检查、`dependency-inventory.json` 不被报告评估器读取，均属实，本轮未改该评估逻辑。

**D0 盘点更正。** `inventory-m1b-deps.mjs` 补入已登记工作区 `experiments/m0/package.json` 并在结果中声明 manifest 计数：[dependency-inventory.json](m1b-reading-notes/b9-rework/dependency-inventory.json) 为 **12 份 manifest / 84 项直接依赖**（27 项当前最新、26 项 workspace、31 项落后，含 experiments/m0 的 fflate/parse5 等 6 项）；`installed` 字段仍是 manifest 范围而非 node_modules 实装核对，消费/验证分类完善与无立即依赖的升级按 [LOOP-02](../decisions/open-questions.md#followup-loops) 承接。

| 检查 | 命令与结果 |
| --- | --- |
| 单元与严格报告 | `M1B_EVIDENCE_DIR=…/b9-rework node scripts/verify-m1b.mjs`（Vitest 155/155，含 10 MiB TXT 与 30 MiB EPUB）及 `M1B_REQUIRE_REPORT=1` 复跑均退出 0；[test-run.json](m1b-reading-notes/b9-rework/test-run.json)、[cases.json](m1b-reading-notes/b9-rework/cases.json)、[report.json](m1b-reading-notes/b9-rework/report.json) 为 `self-check-passed`、`engineeringReviewable=true`、`productAcceptance=not-run`、`errors=[]` |
| 打包 | `node scripts/package-m1b.mjs` 退出 0，八阶段烟测通过，四格式可打开；[package.json](m1b-reading-notes/b9-rework/package.json)。产物 `dist/desktop/packages/MANGA-win32-x64`，未签名，不入库。全部窗口类审计用该同源码包 |
| 指定审计 | `review-m1b-a-b8.mjs` **14/14 passed**（F-07 四项 + F-09 八项 + 打包窗口两项）；[a-b8-independent-review.json](m1b-reading-notes/b9-rework/a-b8-independent-review.json) |
| 全部旧审计 | `audit-m1b-b5-review`、`audit-m1b-recheck`（原始输出保留为 [a-recheck-original.json](m1b-reading-notes/b9-rework/a-recheck-original.json)，扫描/插图夹具自 `a-b7-review/final` 只读复制并核对 SHA-256）、`audit-m1b-b6-review`、`audit-m1b-b7-rework`、`audit-m1b-a-b7-review`、`review-m1b-recheck` 均退出 0 |
| A 8.20 新反例复跑 | [supplementary-review.mjs](m1b-reading-notes/b9-rework/supplementary-review.mjs) 逐字复制自 `a-b9-review`（diff 为空），在重建包上 **7/7 passed**：zero-default-cid-width、two-byte-space-Tw-control（对照）、indirect-mixed-cid-widths、两个 F-09 anchor replace/duplicate、两个 packaged 合写/拆写等价；[a-b9-supplementary-review.json](m1b-reading-notes/b9-rework/a-b9-supplementary-review.json) |
| 汇总与严格报告门禁 | [aggregate-review.mjs](m1b-reading-notes/b9-rework/aggregate-review.mjs) 合入 12 项观察全部 passed 生成 [a-adversarial-review.json](m1b-reading-notes/b9-rework/a-adversarial-review.json)；报告门禁纳入该汇总后仍 `engineeringReviewable=true`——新反例进入门禁，不是只跑旧固定样本 |
| UI/H 自动子集 | `review-m1b-a-b7-ui`、`review-m1b-ui`、`review-m1b-reading`、`review-m1b-b6-ui`、`review-m1b-b5-h-checks`（22 项）均退出 0；正式 H-01—H-05 仍 **not-run** |
| 引擎与 D0 | [reader-engine-evidence.json](m1b-reading-notes/b9-rework/reader-engine-evidence.json) 7 项 passed，候选仍 `accepted=false`，产品源码与包未引入；[dependency-inventory.json](m1b-reading-notes/b9-rework/dependency-inventory.json) 12 manifest/84 项 |
| 同规模窗口 | `bench-m1b.mjs` 退出 0，[bench.json](m1b-reading-notes/b9-rework/bench.json) `scaleWindow.ok=true`（10 000 元数据/50 000 检索块）：冷启动至大书按钮 3527 ms、界面反馈 p95 12.2 ms、10 MiB TXT 尾段 p95 581.8 ms、30 MiB EPUB 尾段 p95 1001 ms、保存回执 p95 637.1 ms、后台解析期间界面 12.0 ms/保存 356.2 ms。口径与阈值同 8.15—8.20 |
| M1a 屏障 | `M1A_EVIDENCE_DIR=docs/evidence/m1b-m1a-regression/b9-rework node --experimental-strip-types scripts/audit-m1a-reverify.mjs` 退出 0，[audit.json](m1b-m1a-regression/b9-rework/audit.json) 为 `no-open-finding-reproduced`，F-25×2 与 F-32×2 passed，仅合成临时 Profile |
| 仓库门禁 | `node scripts/verify.mjs` 退出 0：文档/公开内容/依赖边界/两套类型检查、M1a 94 passed/4 live skipped、M1b 快速子集、契约/旧审查 15 passed |
| 指纹 | 包、审计、UI/H、测试、bench 与报告共用 `sourceFingerprint` `dfa7f0d97e2b548b5f3874700a1fab64159bf04743a32d0476960687a32eaf56`、`m1bSourceFingerprint` `1cb0463fe9c4d4144c37377a30fa25155a8eead34f48eb133a8be13d2fad457b`、`testScriptFingerprint` `ec87749776eb57e7770acbaf8641bbfad5a928e227e800ab0585a28cb40723f1`、`lockFingerprint` `1e2b3818348bf103defc5cea61fe188eb57f513d1bf277db483a30cdbf46c48b`、`buildScriptFingerprint` `145bf3b5f31be864f0dc4721863cffaa18c4e2f265f2db978948e0680b01dfd1`；源码在证据生成期间冻结，20 份 JSON 指纹逐一核对无 stale。文档改动在这些产物之后 |

边界与限制：本节自检通过后交 A 独立复核；A 未复核前 rework-required 结论维持。正式 H-01—H-05、产品验收、真实 IME/DPI/拖动贴靠、Q-08、真实模型调用与真实 Profile 迁移均 not-run。PDF.js/epubjs/@readium/shared 仍为 devDependency 原型，产品运行时不引用。`textLength` 仍把 run 的字形墨迹缩放到模型总推进（均匀分配），各字形墨迹宽度不逐字形独立控制——Chromium 不支持 `tspan textLength`，字形文件本身不可用，替换字体的字形外形只是近似；逐字形原点与 run 间不重叠已由不变量覆盖，完整作者字体渲染仍归 Q-14 的引擎路线。无 push、PR、合并、发布。

<a id="a-b9-rework-review"></a>
### 8.22 A 复核 8.21 与 PDF MVP 路线调整（2026-09-25）

**复核结论：rework-required；下一批改走 PDF.js 产品接入。** 入口为 `codex/m1b-reading-notes @ 1919dc4`、父 `a688713`，B 的产品/测试/脚本及 `b9-rework` 未提交。A 本轮未改产品、测试、构建源码，未 commit/amend/改写历史；新增证据与文档留在工作区。原 `a-b9-review`、`b9-rework` 两种跑次的两个目录共 181 个文件在审查前后 SHA-256 一致。包由当前源码独立重建，未沿用 B 二进制。

新证据是 `docs/evidence/m1b-reading-notes/a-b9-rework-review` 与 `docs/evidence/m1b-m1a-regression/a-b9-rework-review`。[运行记录](m1b-reading-notes/a-b9-rework-review/a-command-results.json)保存命令及实际退出码；[复跑入口](m1b-reading-notes/a-b9-rework-review/run-review.mjs)按 prepare/legacy/new/strict/repository 分阶段运行。`supplementary-review.mjs` 从 B `b9-rework` 逐字复制，SHA-256 一致，7/7 passed。B 修复了旧样本的原点与行级保留问题，但更严格的[字形/引用图反例](m1b-reading-notes/a-b9-rework-review/a-glyph-ref-review.json)为 **2 passed / 6 failed**，入口是 [glyph-ref-review.mjs](m1b-reading-notes/a-b9-rework-review/glyph-ref-review.mjs)。按原 finding 集中记录：

| 编号 / 严重度 | 已关闭的子范围 | 仍有的具体错误与影响 | 本轮后的处理 |
| --- | --- | --- | --- |
| F-07 / P1 | `/DW 0` 与缺省分开；连续 Tj 的零推进；直接/间接简单宽度及 CID 的模型原点；50 Tz 等宽对照 | `reading.tsx#PageCanvas` 同时设置逐字形 x 与整段 textLength，后者仍把 Tc/Tw 与不同宽度平均进字形缩放。宽度 [1000,100,100] 的 ABC 合写字形 extent 约 [4.22,3.77,4.01]，拆写 [10,1,1]；原点完全相同但字形变形且 B/C 可见重叠。标准 Courier、2 Tc/10 Tw 的两个 A 合写宽 11.33、拆写宽 8；同一 `(AAA)` 从 0 Tc 改为 2 Tc，字形宽从 6 变为 8。替代字体不能解释同字体同字形随操作符分组/间距改变外形。见[页面截图](m1b-reading-notes/a-b9-rework-review/unequal-glyph-extents.png)与[标准字体截图](m1b-reading-notes/a-b9-rework-review/courier-spacing-does-not-stretch-ink.png) | 不继续修自研字形模型；按用户 A-41 和计划 14.6 切换 PDF.js Canvas + TextLayer，删除产品自研 PDF 路径，保留语义行为回归 |
| F-09 / P1 | `object replace + ref skip` 的本地 ref 各字段保留；已测无目标/无块组合拒绝 | `library-package.ts` 先以 replacedObjectIds 排除幸存 ref，再求 protectedAnchors/修订属主，最后才识别 preservedSkipRefs，保留行未参与前面的求解。由一致的合成库出发：anchor duplicate 时块载荷/历史指向新 anchor、公共 ref 留在旧 anchor；再加 resource duplicate + revision replace，旧 anchor 的属主与修订属主分叉，`notes.openSource` 顶层 resolved 但来源卡 missing_revision；anchor replace 变体则静默把 skip 来源搬到复制资源。三种输入均成功提交，未 PUBLISH_CONFLICT。按块任意 ref 判重掩盖了目标不一致 | 幸存边须先进入统一求解，再验证最终块/历史/ref/锚点/修订/索引。不相容组合允许预写拒绝并证明表/附件不变，无需为 MVP 让所有策略组合都成功；与 PDF 接入同批完成 |

**测试门禁确有加强，但断言不足以关闭整类缺陷。** 19 项新 Vitest 都真实执行；7 个字形参数化用例检查模型原点，jsdom 用例检查 x/textLength 属性，未比较实际字形 extent/像素。F-09 的 3 个参数化保行用例检查完整 ref 和 openSource，但没有核对同一块的 payload/history/ref 目标一致，也没有把资源复制与修订替换合入 skip 组合。G-01/AT-18 新增的 10 个模式实际匹配 17 个新用例；其余 2 项仍随完整 Vitest 执行。门禁比 8.19 更强，不能把上述缺口描述为已验证通过。

**D0 与声明更正属实。** [离线核对](m1b-reading-notes/a-b9-rework-review/offline-inspection.json)逐份比较当前 12 个 manifest 的 84 项，B 清单无遗漏，计数 27 latest / 26 workspace / 31 behind；本轮未重查全部 npm latest，不把 B 的日期快照当新的全栈升级证明。8.21 对报告自测 9/9、引擎证据“存在时检查”、D0 未进入评估器的更正与实际一致。`installed` 仍从 manifest 范围派生；JSON 中 `classification.installedVerified` 仍不能证明每项实装和消费，继续归 LOOP-02。重建 app.asar 82 个条目不含 pdfjs/epubjs/readium，源码也无产品 import，当前候选仍 accepted=false。

| 本轮验证 | 结果与边界 |
| --- | --- |
| 包与原审计 | [package.json](m1b-reading-notes/a-b9-rework-review/package.json) 八阶段 passed；a-b8 14/14、全部旧服务 audit/review、a-b7-ui/ui/reading/recheck/b6-ui 通过，H 自动子集 22/22；正式 H 仍 not-run |
| B 补充反例复跑 | [a-b9-supplementary-review.json](m1b-reading-notes/a-b9-rework-review/a-b9-supplementary-review.json) 7/7，复制的脚本未改断言 |
| 单元与原型 | [test-run.json](m1b-reading-notes/a-b9-rework-review/test-run.json) 155/155，含 10 MiB TXT/30 MiB EPUB；报告自测 9/9；原[引擎原型](m1b-reading-notes/a-b9-rework-review/reader-engine-evidence.json) 7/7 |
| 性能 | [bench.json](m1b-reading-notes/a-b9-rework-review/bench.json) 同规模 10k/50k、原阈值，scaleWindow.ok=true；冷启动 3253 ms、界面 p95 9.3 ms、TXT 尾段 514.1 ms、EPUB 尾段 890.9 ms、保存 610.4 ms、后台解析期间界面 11.7 ms/保存 354.2 ms。仍是隐藏窗口截至 DOM 可用 |
| M1a | [audit.json](m1b-m1a-regression/a-b9-rework-review/audit.json) F-25×2/F-32×2 passed，no-open-finding-reproduced；合成 Profile、本地桩 |
| 新反例与严格报告 | 原 recheck 5 项 + 复制复跑 7 项 + 新反例 8 项，经[汇总入口](m1b-reading-notes/a-b9-rework-review/aggregate-review.mjs)进入 a-adversarial-review.json，共 14 passed / 6 failed。`M1B_REQUIRE_REPORT=1 node scripts/verify-m1b.mjs` **退出 1**；[report.json](m1b-reading-notes/a-b9-rework-review/report.json) 为 failed-or-incomplete / engineeringReviewable=false，唯一错误为独立审计失败 |
| 仓库门禁与冻结 | `node scripts/verify.mjs` 退出 0，[repository-quality.json](m1b-reading-notes/a-b9-rework-review/repository-quality.json)保留实际结果：文档/公开内容/依赖/两套类型通过，M1a 94 passed/4 live skipped，M1b 快速 153 passed/2 large skipped（完整 155 项见上），契约/恢复 15 passed。与严格报告分别解释。[fingerprint-check.json](m1b-reading-notes/a-b9-rework-review/fingerprint-check.json)逐份核对源码/测试/锁/构建指纹及历史文件保留 |

五项指纹与 B 8.21 一致：source `dfa7f0d97e2b548b5f3874700a1fab64159bf04743a32d0476960687a32eaf56`、M1b `1cb0463fe9c4d4144c37377a30fa25155a8eead34f48eb133a8be13d2fad457b`、test `ec87749776eb57e7770acbaf8641bbfad5a928e227e800ab0585a28cb40723f1`；lock/build 见核对文件。探索脚本第一次用了不存在的 `resource_locations` 表名，并把 SVG 折叠的独立空格当有绘制字符；这是 A 的探针准备错误，保留于 `a-glyph-ref-exploration.json`，修正为实际 `file_locations` 和仅比较非空格字形后得到上面的正式 2/6，不作为 B 的额外缺陷。PDF.js Node 探测初次 Windows 资产路径需改用 `/` 结尾后运行，最终结果单独记录，未进入冻结产品通过数。

**用户要求的路线调整。** 用户在本轮明确希望先移除自编 PDF 解析器、优先开源、尽快形成 MVP，并选定继续 A/B 分工。A 已刷新[官方来源与维护/版本](m1b-reading-notes/a-b9-rework-review/pdfjs-mvp-assessment.json)，并用 PDF.js 6.3.289 的真实 Display API 与本地字体绘制三份反例：[候选探测](m1b-reading-notes/a-b9-rework-review/pdfjs-display-probe.json) 3/3 对应行像素一致。这是独立 Node 候选实证，未改产品引擎、未验证 Electron 集成或文本选区。推荐和可执行任务已收进[唯一计划 14.6](../delivery/m1b-execution-plan.md#pdfjs-mvp)：Canvas + 官方 TextLayer、原件/旧锚点兼容、离线资产、取消/停用、移除自研 PDF 生产路径，以及 F-09 可满足/拒绝边界。同批交付可用闭环，不再交仅解析文本的候选原型，也不再追补旧 SVG 内部表示。

**外部动作与人工边界。** 用户本轮末句给予“无阻塞且 CI 通过后 push→PR→合并→清理分支/同步 main”的条件授权，已覆盖此前文档的“未授权”状态，见 ACT-03；当前 F-07/F-09 与严格报告失败使条件未满足，故未 push、PR、合并或删分支。发布、真实模型和真实 Profile 迁移未授权、未执行。正式 H-01—H-05、Q-08、产品验收仍 not-run。首选下一步交 B 执行已修订的 PDF.js MVP 批次，A 本轮不代替 B 实施。

<a id="b10-pdfjs-mvp"></a>
### 8.23 B 交付：PDF.js 产品接入与 F-09 预写拒绝（2026-09-25）

**交付结论：自检通过，交 A 复核；不是产品验收。** 入口仍是 `codex/m1b-reading-notes`，父提交 `1919dc4` 未改写。本批在其上新增本地提交。产品 PDF 解析、Canvas 和文本层改为 PDF.js 6.3.289 的 legacy 构建（Apache-2.0）；`pdf-text.ts` 与 `formats.ts` 里的自研 PDF 解释路径已删除。EPUB 固定版面仍用原有 SVG。新解析记录 `parserId=pdfjs-dist@6.3.289`，`accepted=true`。无来源路径的 PDF 导入保留提交的 bytes；阅读端只通过 `library.readOriginal` 取回，该命令不在 Agent 命令集。

**旧断言到新检查。** 合写 `Tj` 不再要求两个 `gx` 原点：规范文本是 `HELLOWORLD`，文本层总宽 120。`TJ` 数字间距得到 `HELLO WORLD`、总宽 126。引号操作符仍分成两行，第二行 y=296。50 Tz 的可见总宽为 60。CID `/W` 保留 `ABC` 且总宽大于 0，不把 TextItem 分组当成字形几何。扫描页 `kind=image`、正文为空、警告含 OCR，不抽出 PNG。无 ToUnicode 的 Identity-H 控制字符不进入正文，同字体的可打印误映射一并丢掉，拉丁编码的 `AB` 保留，并写入“no Unicode mapping”警告。WinAnsi/Differences 得到 `“中é” café`；这份合成 Form XObject 的 `form é` 没有进入文本层，记为引擎边界，不回退自研解释器。

**F-09。** 显式 skip 的幸存 ref 在属主规划前进入 protected anchors。`duplicate anchor conflicts` 与 `duplicate resource conflicts` 在写入前 `PUBLISH_CONFLICT`，表和附件不变。`replaced anchor stays` 成功，payload、历史、ref、修订属主和索引都留在原资源，`notes.openSource` 为 resolved。既有“anchor replace”保行用例仍通过。

**本轮验证。** 证据目录 `docs/evidence/m1b-reading-notes/b10-pdfjs-mvp`。[严格报告](m1b-reading-notes/b10-pdfjs-mvp/report.json) `engineeringReviewable=true`，`productAcceptance=not-run`。Vitest 158 passed（含 10 MiB TXT 与 30 MiB EPUB）。同源 Windows 包八阶段烟测通过：PDF 文字页 Canvas 有尺寸，文本层选中 `FORMAT-PDF-MARK` 并写入笔记，扫描页翻到第 2 段仍有 Canvas；损坏 PDF 有可见错误。闭合烟测仍覆盖阅读→笔记→来源→重启。Bench 同规模通过：界面 p95 7 ms，保存回执 p95 485 ms，导入到可读 p95 150 ms，10k 冷启动 3095 ms，10 MiB TXT 尾段 p95 413 ms，30 MiB EPUB 尾段 p95 623 ms。服务审计 a-b5、a-b7、b7 与 reader-engine 均为 passed。M1a 屏障写到 `docs/evidence/m1b-m1a-regression/b10-pdfjs-mvp/audit.json`，结论 `no-open-finding-reproduced`，源码指纹与严格报告一致。`node scripts/verify.mjs` 在 Node 24.19.0 上 `repository-quality` passed。正式 H-01—H-05、Q-08、产品验收、真实模型和真实 Profile 迁移 not-run。U2—U5、D0/D2—D4、EPUB/MOBI/播放引擎仍按原 loop 后移。

<a id="a-b10-review"></a>
### 8.24 A 独立复核 PDF.js MVP（2026-09-25）

**结论：rework-required；F-09 本批三个组合关闭，F-07 未收敛。不是产品验收。** 复核对象为 `codex/m1b-reading-notes` 的 `bd1fcbe`，父 `1919dc4`；产品源码、原提交及其父均未修改。本轮只保存独立证据、复核脚本适配和当前文档，按用户“不改写”指示追加本地审查提交。原三个历史证据目录及对应 M1a 目录共 291 个文件逐一与 `bd1fcbe` 的 Git blob 核对，全部未变。

[严格报告](m1b-reading-notes/a-b10-review/report.json)为 `engineeringReviewable=false`、`automationStatus=failed-or-incomplete`、`productAcceptance=not-run`。B 自检范围独立复跑先通过（[初始报告](m1b-reading-notes/a-b10-review/report-initial.json)），随后 A 反例进入同一严格门禁使其失败，不能沿用初始通过结论。[指纹与完整性](m1b-reading-notes/a-b10-review/integrity.json)中五项指纹均与 B 8.23 相同，源码指纹 `5e3311139f8d340eda126f123dfc96b4c23403485ce31f10b077dcd8266fb270`；本轮包的 asar/EXE 哈希另有记录。

**已确认的问题与一次返工差异。** 沿用 F-07，子编号仅细分同一 PDF 接入问题。三个问题影响必需的基本摘录/来源/会话边界，需要连同适配器、壳状态和包用例一起修复；不转交用户人工试错，不回退自研 PDF 引擎。

| 编号 / 严重度 | 触发与实际结果 | 位置 / 修复验收 |
| --- | --- | --- |
| F-07.1 / P1 | 正常 Courier 20 pt 单行、400 pt 页宽，包内 Canvas 宽 617 px。TextLayer 对应 span 仅 70 px，页面上的文本宽应约 185.1 px；computed font-size=14px、transform=none。TextLayer 写出的字高、横向缩放与总缩放变量未被完整 CSS 消费，鼠标命中区偏离文字 | `apps/desktop/src/renderer/pdf-page.tsx` 的 TextLayer 容器与 `TEXT_LAYER_CSS`。按已锁定 PDF.js 6.3.289 的官方样式/变量接线，验证适宽、缩放、换页后的字形命中区，并用实际鼠标拖选验证；不能只用程序设置 DOM Range 证明可选 |
| F-07.2 / P1 | 新 PDF `FIRST LINE / SECOND LINE / THIRD LINE`：跨前两行选区的 Range 文本为 `FIRST LINESECOND LINE`，按钮禁用；两行 `REPEAT` 的第二行选区也禁用。单独摘录 `SECOND LINE` 可以保存，但来源返回同时高亮 `SECOND LINE` 和 `THIRD LINE` | `pdf-page.tsx` 的 selectionchange、quoteMatches、markRange，以及 `pdfjs-document.ts` 的规范映射。DOM Range、innerText（本样本每行之间三个 LF）与遍历 span 使用不同偏移规则；应共享 TextItem→规范码点映射，包含 EOL、空格、中文/emoji/NFC 和页分窗。当前表示中可定位的重复引文不能误报歧义；旧表示的真正歧义继续 needs_review。核对笔记→来源→返回→重启，不能只断言 quote 字符串 |
| F-07.3 / P1 | 在 IPC 边界延迟书 A 的 `library.readOriginal` 成功响应，切到书 B `REPEAT` 并等其渲染完成，再释放 A；标题保持 `REPEAT`，Canvas/TextLayer 却变成 A 的 `FIRST LINE` | `apps/desktop/src/renderer/App.tsx` 的 openResource/loadOriginal/openNoteSource。原件响应须与当前资源、修订、会话及请求代次绑定；晚到成功/失败均不得替换/清空新书、重绑旧 Agent 会话。同步检查解析、render/text/load 取消、停用/重新启用与释放，使用确定性屏障复验 |

具体输入、步骤、实际值及可执行脚本见 [独立 PDF/F-09 结果](m1b-reading-notes/a-b10-review/a-pdfjs-review.json)与 [independent-review.mjs](m1b-reading-notes/a-b10-review/independent-review.mjs)。该脚本 13 项观察中 8 passed / 5 failed；五项失败分别为多行来源高亮、文本层几何、跨行选区、重复引文选区、原件晚到。单行摘录/来源返回成功，重开合成 Profile 后两份笔记及来源仍 resolved；这不证明失败的 PDF 闭环或真实迁移通过。

**F-09 关闭依据。** 独立从有效来源/笔记/历史/ref 创建样本，导出后更改本地 ref 的 mode/layout，再以 object replace + ref skip 导入。anchor duplicate，以及 resource duplicate + anchor duplicate，均在写入前 `PUBLISH_CONFLICT`，13 张内容/索引表（含 search_idx）及附件 SHA-256 未变。resource duplicate + anchor replace 成功，skip ref、块载荷、历史、锚点、修订属主和索引保持原资源，notes.openSource/card 均 resolved；anchor replace 对照也通过。旧包外幸存、复制对象、多块/不同 mode/layout 等由本轮 b5/b6/b7/b8 服务复核及 Vitest 覆盖。此关闭限定本批组合，不声明任意冲突策略都已支持。

**已复跑及边界。**

| 范围 | 本轮结果 |
| --- | --- |
| 完整测试与报告 | [test-run](m1b-reading-notes/a-b10-review/test-run.json) 158/158，包含 10 MiB TXT、30 MiB EPUB；报告反例 9/9。required cases 均 passed，但 A 必需反例失败使最终严格报告失败 |
| 同源码 Windows 包 | [package](m1b-reading-notes/a-b10-review/package.json) 八阶段 passed，含正常 PDF Canvas、文字层单行摘录、扫描页翻页、损坏输入提示与既有闭合/重启。A 另验证真实扫描样本 Canvas 非空、无文本层；对其包内 PDF 运行拦截 HTTP/HTTPS，观察到请求 0，不等于操作系统断网认证 |
| 字形与旧复核 | b5、b6、b7 服务审计及 reader-engine passed；旧 B8、A-B7 UI 与 scan recheck 经本轮脚本适配后 passed。旧脚本首次结果保留为 `*-initial.json`：前两个未等待异步文本层，scan recheck 仍要求 img。A 只在本证据目录修正等待和 Canvas 断言，未改产品源码；B 应把这些适配收回正式脚本。旧 H 自动子集与其余 UI 复核 passed，正式 H 仍 not-run |
| 同规模 bench | [bench](m1b-reading-notes/a-b10-review/bench.json) passed；10k/50k、窗口反馈 p95 6.5 ms、保存回执 p95 481 ms、导入到可读 p95 153 ms、10k 冷启动 3083 ms、10 MiB TXT 尾段 p95 420.6 ms、30 MiB EPUB 尾段 p95 672.3 ms |
| 离线与 M1a | 安装依赖与包内 CMap/标准字体/WASM/ICC/legacy 模块逐文件字节一致，许可证一致，renderer worker/资产在包内。M1a [四项屏障](m1b-m1a-regression/a-b10-review/audit.json) no-open-finding-reproduced；仍为合成 Profile |
| 仓库质量与 CI | 本地 [repository-quality](m1b-reading-notes/a-b10-review/repository-quality.json)的 `node scripts/verify.mjs` 最终 passed（Node 24.19.0）；首次仅因新结果链接尚未生成而失败，补齐后完整复跑通过。本地通过不等于严格复核或 CI。按完整目标 SHA 只读查询未发现 CI run，CI=not-run；未 push/PR/合并/发布 |
| 仍缺的计划证据 | 完整中文/emoji/EOL 鼠标选区闭环、真实嵌入字体与替代字体分开验证、合成旧 PDF 修订/歧义/缺原件、处理中取消/释放及开发启动离线资产，尚未由本轮独立证据证明，B 须按 14.6 补齐。不能包装为用户人工待办 |

从仓库根复现（合成 Profile 自动进入临时目录或 `dist/desktop/review-runs`；不使用真实 Profile）：

```powershell
$env:M1B_EVIDENCE_DIR='docs/evidence/m1b-reading-notes/a-b10-review'
node scripts/m1b.mjs package
node scripts/m1b.mjs bench
node docs/evidence/m1b-reading-notes/a-b10-review/run-review.mjs legacy
node docs/evidence/m1b-reading-notes/a-b10-review/run-review.mjs adapted
node docs/evidence/m1b-reading-notes/a-b10-review/run-review.mjs new
node docs/evidence/m1b-reading-notes/a-b10-review/run-review.mjs strict
node docs/evidence/m1b-reading-notes/a-b10-review/run-review.mjs repository
```

`new` 与 `strict` 在被审版本应非零；它们就是本批返工的复现入口。后续 B 使用新证据目录并迁入这些用例，不覆盖本轮或历史结果。正式 H-01—H-05、Q-08、产品验收、真实模型及真实 Profile 迁移均 not-run。[ACT-03](../decisions/open-questions.md)条件未满足，当前首选下一步为 B 一次性修复上述差异并补齐必需验证。

<a id="b11-pdfjs-text"></a>
### 8.25 B 对齐文本层几何、规范选区与晚到原件

本节是 B 对 8.24 的一次返工，不改写 8.23、8.24，也不改写 `bd1fcbe`、`1919dc4` 或 A 的审查提交 `c692f58`。新证据只写入 `docs/evidence/m1b-reading-notes/b11-pdfjs-text` 与 `docs/evidence/m1b-m1a-regression/b11-pdfjs-text`。`a-b10-review`、`b10-pdfjs-mvp` 及更早目录未覆盖。PDF.js 保持 6.3.289。F-09 已通过的三个组合在本轮独立反例中仍然通过。自检通过不等于 A 已关闭 F-07，也不等于产品验收。

**F-07.1。** 页面容器在构造 TextLayer 前写入 `--scale-factor`、`--user-unit` 和 `--total-scale-factor`，样式按官方 6.3.289 规则用 `--font-height` 与 `--scale-x` 排选区。打包窗口里 Courier 20pt 的 `FIRST LINE` 命中宽度为 185.11px，按页面宽 400、字形宽 120 计算的期望值是 185.1px，左缘与字形原点重合。放大后以及下一页 `PAGE TWO` 的偏差都小于 2px。

**F-07.2。** 解析器和 DOM 文本层共用 `mapCanonicalPieces`。跨行选区和第二次 `REPEAT` 可以记笔记；来源高亮只标被引用的行。鼠标拖选含中文、空格、😀 和 `e` + 组合尖音符的一行后，保存的摘录是 NFC 的 `é`，来源高亮覆盖这些 span，返回笔记后重启仍能解析。跨行拖选保存 `甲行\n乙行`，高亮只有这两行。旧表示里范围与引文不一致的重复 `REPEAT` 保持 `needs_review`；原件文件删除后笔记和修订 id 仍在，`readOriginal.available` 为 false。

**F-07.3。** `openResource` / `openNoteSource` 递增阅读代次。书 A 的 `library.readOriginal` 晚到成功或失败时，若当前已经是书 B，不替换画布、不清空 B，也不把会话绑回 A。解析取消、资料库停用后再启用，旧代次结果不发布。

| 范围 | 本轮结果 |
| --- | --- |
| 独立反例 | [a-pdfjs-review.json](m1b-reading-notes/b11-pdfjs-text/a-pdfjs-review.json) 21/21 passed，含 8.24 的 13 项和 14.6 补齐的鼠标、缩放/翻页、晚到失败、嵌入字体、开发服资产、旧修订/缺原件、取消/停用 |
| 严格报告 | [report.json](m1b-reading-notes/b11-pdfjs-text/report.json) `engineeringReviewable=true`，`automationStatus=self-check-passed`，`productAcceptance=not-run`。这是 B 自检，不是 A 复核 |
| Vitest | [test-run.json](m1b-reading-notes/b11-pdfjs-text/test-run.json) 164/164，含 10 MiB TXT、30 MiB EPUB，以及新增的 PDF 文本映射、旧修订、取消/停用和嵌入字体用例 |
| 包与 bench | [package.json](m1b-reading-notes/b11-pdfjs-text/package.json) 八阶段 passed；[bench.json](m1b-reading-notes/b11-pdfjs-text/bench.json) passed。同规模窗口：反馈 p95 10.1 ms，保存回执 p95 627 ms，导入到可读 p95 150 ms，10k 冷启动 3474 ms，10 MiB TXT 尾段 p95 559.8 ms，30 MiB EPUB 尾段 p95 893.3 ms |
| 旧审计与 UI | 正式脚本已等待异步 TextLayer，扫描页检查 Canvas 像素。legacy 首次因新目录缺少 `consecutive-text.pdf` / `white-text.pdf` 使 a-b7 UI 退出 1；样本从 `a-b10-review` 只读复制后，adapted 三支脚本退出 0。其余 legacy 脚本退出 0 |
| M1a | [audit.json](m1b-m1a-regression/b11-pdfjs-text/audit.json) `no-open-finding-reproduced`，F-25×2 与 F-32×2 passed，只覆盖合成 Profile |
| 仍 not-run | 正式 H-01—H-05、Q-08、产品验收、真实模型、真实 Profile 迁移、CI。未 push / PR / 合并 |

从仓库根复现（合成 Profile；不覆盖历史证据目录）：

```powershell
$env:M1B_EVIDENCE_DIR='docs/evidence/m1b-reading-notes/b11-pdfjs-text'
$env:M1A_EVIDENCE_DIR='docs/evidence/m1b-m1a-regression/b11-pdfjs-text'
node scripts/m1b.mjs package
node scripts/m1b.mjs bench
node docs/evidence/m1b-reading-notes/b11-pdfjs-text/run-review.mjs legacy
node docs/evidence/m1b-reading-notes/b11-pdfjs-text/run-review.mjs adapted
node docs/evidence/m1b-reading-notes/b11-pdfjs-text/run-review.mjs new
node docs/evidence/m1b-reading-notes/b11-pdfjs-text/run-review.mjs m1a
node docs/evidence/m1b-reading-notes/b11-pdfjs-text/run-review.mjs strict
node docs/evidence/m1b-reading-notes/b11-pdfjs-text/run-review.mjs repository
```

<a id="a-b11-review"></a>
### 8.26 A 独立复核及生命周期局部修复（2026-09-26）

**结论。** A 从 B 的 `05be466`（父 `c692f58`）开始复核，先独立重跑 8.25 的 21 项，再补旧表示和在途生命周期反例。F-07.1、F-07.2 及 F-09 三个组合复跑通过；F-07.3 在原件晚到之外仍有两个局部缺陷，A 已直接修复并重建、复测。最终本批技术审查收敛，正式 H、Q-08、产品验收、真实模型和真实 Profile 迁移仍为 not-run。严格报告字段只描述证据门禁，不代替本节 A 的判断。

所有新增证据位于 `docs/evidence/m1b-reading-notes/a-b11-review` 与 `docs/evidence/m1b-m1a-regression/a-b11-review`。`baseline/` 保留修复前真实跑次，未把旧失败改为通过。此前两组证据目录的 1373 个已跟踪文件逐项对照 `05be466` 的 Git blob，全部相同，含 `a-b9-review`、`b9-rework`、`a-b9-rework-review`、`a-b10-review`、`b10-pdfjs-mvp` 和 `b11-pdfjs-text`。`bd1fcbe`、`1919dc4`、`c692f58` 保留；本轮局部修复按仓库规则归入未推送的 B 当前交付，最终提交号由交接消息给出。源码和产物指纹见 [integrity.json](m1b-reading-notes/a-b11-review/integrity.json)。

**F-07 复核和局部修复：**

| 编号 | A 的复现、处理与最终结果 |
| --- | --- |
| F-07.1 | Courier 20pt 的 `FIRST LINE` 命中宽 185.108px，预期 185.1px，左缘一致；放大及第 2 页误差均小于 2px。官方 TextLayer 缩放变量确实生效，关闭本批 finding |
| F-07.2 | 跨行、第二次重复引文、单行来源高亮、中文/emoji/NFC/空格/EOL 鼠标选择和重启通过。另在合成 Profile 中预置与 PDF.js 不同的旧存储文本：唯一 `SECOND LINE` 只高亮该行；旧文本 `OLD REPEAT REPEAT` 的有效旧范围在当前页无法唯一对应时显示待复核且无误高亮。重启后资源修订、锚点、笔记和历史逐行不变。关闭本批 finding |
| F-07.3：晚到原件 | 原件晚到成功/失败不替换当前书，不清空其 Canvas，不改变当前会话；切到笔记后当前笔记会话保持。B 的请求代次修复通过 |
| F-07.3：晚到文本 | 修复前延迟第 1 页已取得的 `getTextContent` 返回，翻到第 2 页后释放，当前 TextLayer 从 `PAGE TWO` 变成 `FIRST LINE`，尽管旧 worker 已 destroy。A 在动态 import 和 getTextContent 的 await 后、创建任务或改 DOM 前检查 effect 是否失效；真实包及新增 Vitest 回归均通过 |
| F-07.3：取消不完成 | 修复前解析开始后取消，Promise 3 秒后仍 pending。仅 destroy PDF.js 任务不足以保证所有 page Promise 拒绝。A 为异步等待增加取消完成路径，统一销毁，并在读取操作符后再次核对 signal；确定性在途反例得到 `CANCELLED`。停用中的导入被拒绝且零资源入库，旧 worker 退出，重新启用使用新 worker 并可正常导入。关闭本批 finding |

修复前证据见 [baseline/a-supplemental-review.json](m1b-reading-notes/a-b11-review/baseline/a-supplemental-review.json)；修复后见 [a-supplemental-review.json](m1b-reading-notes/a-b11-review/a-supplemental-review.json)。在途取消回归通过延迟真实 PDF.js 响应固定时序，避免小文件在计时器触发前已经解析完成；没有用预先 aborted 的 signal 代替在途取消。一次补充停用夹具故意不响应 abort，运行时按契约拒绝停用；最终夹具响应取消后验证停用、旧结果拒绝和重启 worker，不将该夹具问题记为产品缺陷。

本轮还修正了 required cases 的编号：B 新增的验收编号未在验收正本定义，相关测试归回既有 G-01 与 AT-04；保留全部断言，新增晚到 TextLayer 回归。没有新增产品验收承诺，也没有降低报告门禁。PDF.js 仍锁定 6.3.289；旧自研 PDF 字体/操作符解释器仍已移除，无静默回退。

| 验证范围 | A 最终结果与证据 |
| --- | --- |
| 独立 PDF/F-09 反例 | [原 21 项](m1b-reading-notes/a-b11-review/a-pdfjs-review.json)和 [A 补充 7 项](m1b-reading-notes/a-b11-review/a-supplemental-review.json)全部 passed。F-09 三个组合保持写前冲突拒绝或完整来源图；比较 13 张表、索引和附件 SHA256，另保留 anchor replace 对照 |
| 严格报告 / Vitest | [report.json](m1b-reading-notes/a-b11-review/report.json) `engineeringReviewable=true`、errors=[]；[test-run.json](m1b-reading-notes/a-b11-review/test-run.json) 165/165，含 10 MiB TXT 和 30 MiB EPUB。补充失败进入独立审计汇总，不能被原 21 项或 B 自检覆盖 |
| 同源 Windows 包 | [package.json](m1b-reading-notes/a-b11-review/package.json) 八阶段 passed；Canvas 文字/扫描页、摘录/来源/返回/重启已实跑；包内 worker/CMap/字体/WASM/ICC 与安装版本字节相同，许可证匹配，HTTP/HTTPS 零请求 |
| 同规模 bench | [bench.json](m1b-reading-notes/a-b11-review/bench.json) passed；10k/50k、反馈 p95 10.4ms、保存回执 p95 661.5ms、导入到可读 p95 152ms、10k 冷启动 3438ms、10 MiB TXT 尾段 p95 573.4ms、30 MiB EPUB 尾段 p95 855.1ms。全部原阈值保留 |
| 仍适用旧审计 | legacy 九支、extra 四支全部退出 0，覆盖旧 F-07/F-09、EPUB、UI/H 自动子集和 reader-engine；命令和指纹见 [a-command-results.json](m1b-reading-notes/a-b11-review/a-command-results.json)。没有用自动 H 子集宣称正式 H 通过 |
| M1a | [audit.json](m1b-m1a-regression/a-b11-review/audit.json) F-25×2、F-32×2 passed，`no-open-finding-reproduced`，仅合成 Profile |
| 统一仓库检查 | `node scripts/verify.mjs` 退出 0；[repository-quality.json](m1b-reading-notes/a-b11-review/repository-quality.json) passed，涵盖类型、文档、依赖、公开内容、M1a/M1b 测试和契约/修复回归。它仍不是远端 CI 或产品验收 |
| CI / 外部动作 | [ci-status.json](m1b-reading-notes/a-b11-review/ci-status.json)：只读查询 `05be466` 无 CI runs，远端无此任务分支；最终本地修复版 CI not-run。未 push、PR、合并、发布，不建议 ACT-03 |

复跑仍须使用新的证据目录，先复制本目录三支 review 脚本并调整 runner 的 M1a/log 目录，再执行 package、bench、legacy、extra、new、m1a、strict、repository；不要向本目录或旧目录覆盖写入。完整回归使用本次源码/锁文件/测试/构建的五类指纹，修复前 baseline 仅保留历史比较，不参与最终通过门禁。

<a id="act01-review"></a>
### 8.27 ACT-01 用户集中复核与修复（2026-10-03）

**用户反馈。** 用户在隔离合成 Profile 上用 `be1d2fd` 的同源稳定包完成集中复核，报告如下：

| 项 | 用户结果 |
| --- | --- |
| PDF 选区 | `repeated.pdf` 中，选区带上行末换行或从行首开始拖选时出现“来源有重复句，需要确认”，无法记笔记 |
| 组合字符 | `unicode.pdf` 中 é 的 e 与撇显示错位，用户怀疑是 PDF.js 的问题 |
| Q-08 视觉 | 暂无问题；标题栏最小化/最大化/关闭按钮尚未跟随沉浸主题，放到下一阶段；现有页面仍像测试界面，用户下一阶段提供界面参考 |
| 其余 H-01—H-05 | 未发现问题 |

**A 的复现、原因与处理。**

| 编号 | 打包版复现 | 原因 | 处理 |
| --- | --- | --- | --- |
| ACT01-1 选区 | 用真实鼠标从第二行首字拖过行尾：Chromium 把起点放在文本层容器中第一行 `<br>` 之前，终点放在 span 元素上，只选中一个换行并出现复核提示。提示插在页面上方，把页面下推 21px；清空选区后提示仍然保留 | 一是选区端点只在落入 span 文本时才换算，落在容器、`<br>` 或空白处就回退为按引文全文匹配，重复句随即判为待复核。二是 Electron 37（Chromium 138）在绝对定位文本层的空白处原生拖选时，会跳到任意 DOM 位置，甚至落到页面之外；PDF.js 官方的 endOfContent 补救依赖上一次选区，同一手势可能选中整行、什么都不选或选中上一行 | 文本层改由同包官方 `TextLayerBuilder` 构建，文本参数与解析器 `getTextContent()` 的默认值一致。端点不在 span 内时，按文档顺序换算到行首、行尾或换行之后；选区两端的空白与换行去掉，只剩空白时视为未选择。页面上的普通单击拖选由产品计算：指针在字形上时用浏览器光标，在空白处时取最近一行的行首或行尾；双击、三击、Shift 点击和键盘选择保持原生，拖到滚动区上下边缘时滚动。复核提示移入缩放工具栏，不再推动页面；来源高亮与当前选区的复核状态分开，选区清空即撤销 |
| ACT01-2 组合字符 | 放大后撇号落在 e 右侧约一个字宽处 | 合成样本生成器的 CID 字体没有字形程序，并对每个码点（含 U+0301）都给 1000 单位的前进宽度。PDF 只记录字形位置，不做组合排版，PDF.js 按样本给出的位置用系统字体逐字绘制。A 在本地另用嵌入 Arial 的 e + U+0301 对照，PDF.js 同样把零宽撇号画在 e 之后；预组合的 é 则完整绘制。因此这不是 PDF.js 或产品缺陷，文本层与存储仍是 NFC `é` | 样本生成器为组合标记写 0 前进宽度，为拉丁字母与空格写比例宽度，撇号紧随 e，不再偏出一个字宽。该样本有意保留分解形式以测试规范化，因此不会显示为完整合成的 é；本节另附分解/预组合对照样本 |

**验证（2026-10-03，修复后源码与同源包）。**

| 范围 | 结果与证据 |
| --- | --- |
| Vitest | M1b 全量 169/169 passed（含 `M1B_LARGE=1` 的 10 MiB TXT 与 30 MiB EPUB）。新增用例覆盖：端点落在文本层容器、`<br>` 与 endOfContent 上，只选中空白，旧表示仍需复核，空白处取最近行边缘、不信任不在指针下的光标，组合标记零前进宽度；另覆盖改用官方 `TextLayerBuilder` 后晚到文本被丢弃。签名归并后的 pre-push 复跑中，`b9-rework` 的 F-09 显式跳过用例偶发失败：用例按 `ORDER BY id` 取第一行，笔记自身引用的 ID 是随机 UUID，以 `f` 开头时（约 1/16）会排到 `ref_extra_0` 之后，于是跳过了错的行并被产品正确拒绝。用例已改为固定顺序；把该行 ID 改成 `f` 开头后，旧用例稳定失败、新用例通过。产品代码未改 |
| 同源 Windows 包 | `node scripts/m1b.mjs package` 八阶段烟测 passed；烟测证据写入临时目录，不覆盖已提交证据 |
| 打包版行边缘拖选 | [edge-drag-review.json](m1b-reading-notes/act01-fix/edge-drag-review.json) 共 14 项：`repeated`、`multiline` 各 5 种真实鼠标拖选（首字起拖过行尾、左边距起至末字、左边距起拖过行尾、首行拖过行尾、跨行），双击选词，左边距拖选后记笔记并打开来源（高亮第二个 `REPEAT`，码点 7—13，resolved），以及两组组合字符样本。连续 5 次全部 passed，无复核提示，页面无位移。截图见 [unicode-accent.png](m1b-reading-notes/act01-fix/unicode-accent.png)、[accent-forms.png](m1b-reading-notes/act01-fix/accent-forms.png) |
| 旧 F-07/F-09 打包审计 | 把 A 8.26 的两支脚本复制到本目录后复跑：[a-pdfjs-review.json](m1b-reading-notes/act01-fix/a-pdfjs-review.json) 21/21 passed，[a-supplemental-review.json](m1b-reading-notes/act01-fix/a-supplemental-review.json) 7/7 passed。脚本只做了两处适配：晚到文本改为延迟 `streamTextContent`，即官方 builder 的取数入口；切书或翻页前标记旧文本层，避免与上一本相同首行的竞态误配。旧歧义表示仍显示复核提示 |
| 仓库检查 | `node scripts/verify.mjs` 退出 0 |
| 未执行 | bench 与严格报告不覆盖本次改动路径，未重跑 |

**状态。** 用户 2026-10-03 对 `be1d2fd` 包报告 H-02—H-05 与 Q-08 当前视觉未发现问题，按用户报告记为 passed，范围仅限该包与用户实际执行的步骤（用户未逐项提供系统条件）；Q-08 的反馈不等于最终视觉批准。H-01 的其余步骤未发现问题，但 PDF 行边缘选区在该包上 failed，组合字符错位判定为合成样本问题；两项修复后待用户在新包上复核，H-01 当前记为 not-run。本次改动只涉及 PDF 页面的选区与提示以及合成样本，不触及 H-02—H-05 的路径。产品验收仍为 not-run。

**用户新包复查（2026-10-03）。** 用户在修复后的新包上复查后反馈撇号的显示仍有问题，决定本轮不修，登记为 [LOOP-04](../decisions/open-questions.md#loop-04) 放到后续阶段。按上表分析，该样本没有组合定位，分解形式只能按样本位置逐字绘制；后续先用带真实字形与组合定位的样本和真实 PDF 确认问题所在。文本层与存储仍为 NFC `é`，选区、笔记与来源不受影响。行边缘拖选的复查结果用户未单独报告，H-01 保持 not-run。

<a id="current-handoff"></a>
## 9. 当前交接：ACT-01 反馈已修复，PR 已创建，撇号显示转入后续阶段

| 字段 | 内容 |
| --- | --- |
| 当前角色与结论 | A 已按用户的 ACT-01 反馈完成 [8.27](#act01-review) 的修复与自检；产品验收不由工程检查推定 |
| 版本 | `codex/m1b-reading-notes`，[PR #3](https://github.com/chialecode/manga/pull/3)，相对 `main` @ `a688713` 只有一个带签名的阶段提交，最终 SHA 以 PR 为准。2026-10-03 用户授权补签并强推：分支上的 `1d0524f` 与追加提交 `99b27a6` 已归并为一个带签名的阶段提交，用 `--force-with-lease` 推送，最终 SHA 以 PR 为准。M1b 原有的四个未推送提交（`1919dc4`、`bd1fcbe`、`c692f58` 及其后的修复提交）已于 2026-10-03 按 A-21 归并为一个阶段提交，旧 SHA 只在历史证据中作被测版本引用；用户 2026-10-03 重申一个阶段一个提交 |
| 唯一计划 | [14.6](../delivery/m1b-execution-plan.md#pdfjs-mvp)；A 修复与证据见 [8.27](#act01-review)，8.26 及更早小节保留历史含义 |
| 必须保留 | PDF.js 6.3.289（文本层改用同包官方 `TextLayerBuilder`）、F-09 三个已通过组合、历史证据目录 |
| 远端动作 | 2026-10-03 用户明确要求修复后 push 并创建 PR，已创建 [PR #3](https://github.com/chialecode/manga/pull/3)（ACT-03）。`1d0524f` 上 repository-quality passed，DCO 因该提交未签名而失败；用户随后授权补签并强推，签名后的阶段提交以 PR 上的检查结果为准。合并、清理阶段分支与发布未执行 |
| 当前限制 | 撇号显示仍有问题，按 [LOOP-04](../decisions/open-questions.md#loop-04) 后续处理；新包上 H-01 PDF 行边缘选区的人工复核、Q-08 最终视觉、产品验收、真实模型与真实 Profile 迁移均为 not-run |
| 首选下一步 | 必需检查通过后由用户决定是否合并 [PR #3](https://github.com/chialecode/manga/pull/3)；如需复核行边缘拖选，按下方步骤操作 |

从仓库根执行 `node scripts/m1b.mjs package` 重新打包；若要避免覆盖已提交证据，先设置 `M1B_EVIDENCE_DIR` 指向临时目录。然后用独立合成 Profile 打开（不读取真实资料）：

```powershell
$reviewRoot = Join-Path $env:TEMP 'manga-act01-recheck'
$env:MANGA_CHANNEL = 'test'
$env:MANGA_PROFILE_ROOT = Join-Path $reviewRoot 'profile'
$env:MANGA_DOCUMENTS_DIR = Join-Path $reviewRoot 'documents'
$env:MANGA_POINTER_FILE = Join-Path $reviewRoot 'launcher/pointer.json'
& ./dist/desktop/packages/MANGA-win32-x64/MANGA.exe
```

首次启动时选择暂不配置 AI，在“小说 → 导入书籍”中选择 `docs/evidence/m1b-reading-notes/act01-fix/` 下的 `repeated.pdf`、`multiline.pdf` 和 `accent-forms.pdf`。检查以下几点：从行首字、左边距或行末之外开始拖选一整行，都应只选中该行文字，“记下选区”可用且没有复核提示；记笔记后打开来源，只高亮所选的那一行。`accent-forms.pdf` 的第二行（预组合）应显示完整的 é；第一行是有意保留的分解形式，其撇号显示问题已登记 [LOOP-04](../decisions/open-questions.md#loop-04)。故障时先对照 [edge-drag-review.json](m1b-reading-notes/act01-fix/edge-drag-review.json) 与 [a-pdfjs-review.json](m1b-reading-notes/act01-fix/a-pdfjs-review.json)。
