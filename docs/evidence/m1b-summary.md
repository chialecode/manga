# M1b 阶段总结

| 字段 | 内容 |
| --- | --- |
| 阶段 | M1b：阅读与人工记录（TXT/EPUB/MOBI/PDF、笔记编辑与来源闭环、桌面壳）。录音子阶段未实施，已并入 M2 |
| 合并 | [PR #3](https://github.com/chialecode/manga/pull/3)，`main` @ `5504c97`（2026-10-03）；上一阶段 `a688713`（见 [M1a 总结](m1a-summary.md)） |
| 归档 | 计划、交付/审查报告、近 30 个轮次证据目录（共约 187 MB）留在合并提交中：`https://github.com/chialecode/manga/tree/5504c97/docs/evidence`、`.../docs/delivery` |
| 结论 | 自动化与 A 的技术复核收敛；用户 2026-10-03 在 `be1d2fd` 包上完成集中复核（第 4 节）。**产品验收 not-run**；解析候选的生产选型除 PDF.js 外未定 |

## 1. 交付内容

- **数据**：schema v4 → v5（备份后追加全文分块列）；旧笔记载荷 schema v1 原样保留、读入内存升到文档 schema 2；布局偏好在 `config` 的 `shell.layout`。
- **格式**：TXT、EPUB（含固定版面与逐章插图）、MOBI（PalmDOC/KF8 的 HTML 页与图片记录）、PDF。PDF 起初为自研解析与绘制，A 复核证明自研字形/字距路径无法关闭整类缺陷后，按用户要求（A-41）改为 **PDF.js 6.3.289（Apache-2.0）**：页身份与规范化文本经 `mapCanonicalPieces`，文本层用同包官方 `TextLayerBuilder`；自研 PDF 解释路径已删除。EPUB/MOBI 仍为仓内适配器（`accepted=false`）。ZIP/PDF 解压有实际输出上限，伪造声明大小不能绕过。
- **阅读器**：位置恢复、已读区间（跳转不扩大已读）、书签、搜索结果跳转、样式（字体、行距、边距、背景）、10 MiB TXT / 30 MiB EPUB 的末段可读。
- **笔记**：块文档，Tiptap（富文本）与 CodeMirror 6（源码）两个视图共用权威块状态、撤销历史与输入法屏障；拆分/复制/移动保持块与锚点身份，未知块载荷在替换后保留；标签、搜索、历史与修订恢复。
- **来源闭环**：阅读 → 选区 → 笔记 → 来源卡片跳转与返回；失效来源显示状态并可重新指定原件；重复句进入 `needs_review`；Agent 发送时把选区与笔记修订冻进 `snapshot_json`，防剧透默认关闭。
- **资料包**：空库/冲突库预览与逐行策略（skip/duplicate/replace）、引用重映射、托管媒体 `file_locations` 重建；不相容组合在写入前拒绝并整体回滚（F-09 三个已通过组合：`duplicate anchor` / `duplicate resource` 冲突拒绝、`replaced anchor` 保行）。
- **桌面壳（AT-60—62）**：宽窗停靠左右栏、窄窗悬停浮层（180 ms 离开延迟，Esc 恢复焦点）、阅读行宽 680 与壳宽分离、模式菜单键盘可用；窗口最小 360 × 360；每个已打开资源有独立会话。

## 2. 审查问题（F-01—F-10 及其后续）与关闭情况

| 编号 | 内容 | 结论 |
| --- | --- | --- |
| F-01、F-03、F-04、F-05、F-06、F-10 | 来源卡片与返回、块编辑与输入法屏障、Agent 材料冻结与可见路径、资源会话、位置恢复、阅读样式/书签/笔记管理 | 已关闭（A 逐项复核） |
| F-02 | 选区保存整段而非实际码点范围 | 已修复 |
| F-07 | 格式正确性：PDF 页树/ToUnicode/字体宽度/逐字形布局、EPUB 插图与固定页、MOBI HTML、扫描页 | 经 PDF.js 接入关闭；8.26 的三个子项（文本层几何、规范选区、晚到原件/文本/取消）A 复核关闭 |
| F-08 | 门禁与证据：必需用例映射过窄、基准只测点击派发、包烟测不含端到端闭环 | 已补：同规模（10k/50k + 10 MiB TXT/30 MiB EPUB）窗口基准；闭环烟测（读到末章→记录→来源→重启）；报告拒绝缺项/失败/旧指纹 |
| F-09 | 资料包依赖图：skip/duplicate/replace 混合时笔记、历史、refs、索引、附件必须跟随真正持久化的行 | 通过依赖矩阵测试与预写拒绝关闭 |

## 3. 度量（B 自检的最后一轮，隐藏窗口截至 DOM 可用，非显示器延迟）

同规模窗口：界面反馈 p95 10.1 ms、保存回执 p95 627 ms、导入到可读 p95 150 ms、10k 冷启动 3,474 ms、10 MiB TXT 尾段 p95 559.8 ms、30 MiB EPUB 尾段 p95 893.3 ms。Vitest 164（含两个大文件用例）通过；A 复核跑 21 项 PDF 打包反例全部 passed；Windows 包八阶段烟测通过。

## 4. 人工检查：步骤与结果（ACT-01）

M1b 计划第 8 节的 H 步骤与 2026-10-03 的结果如下（不再保留计划文件）。尚未完成的 H-01 新包复核，当前步骤与状态见[用户待办](../../USER-ACTIONS.md#h-01)。

| 编号 | 步骤 | 预期 | 2026-10-03 用户结果 |
| --- | --- | --- | --- |
| H-01 | 无模型配置导入合成书，读到末章，选中中日文/emoji，记录评论并保存，点来源再返回，重启 | 引用片段/版本准确，位置恢复 | PDF 行首/行尾拖选 failed，A 8.27 修复；**新包复核 not-run**，并入 M2 的 H-01 复核 |
| H-02 | 新编辑器用实际中文输入法组合、选词、Enter、粘贴、跨块选区、撤销重做，切换代码/纯文本源编辑 | 不误提交、不抢焦点、不丢块 ID 或来源 | 未发现问题（user-reported passed） |
| H-03 | 宽屏、1280×840、960×640、720×540、800×1200 间切换；100%/125%/150% 缩放，记录实际 CSS 视口 | 主面板优先，浮层与保存/停止/关闭可达，无壳级横向溢出 | 未发现问题 |
| H-04 | 长标题下拖动/双击标题、最大化/还原/贴靠；纯键盘切换模式并在任务运行期间切换 | 控件不触发拖动，任务不重发、授权不变 | 未发现问题 |
| H-05 | 合成数据备份恢复/资料包导入，查看缺媒体与来源失效提示，审阅宽窗行宽 | 入口与状态可理解，结果与自动核对一致 | 未发现问题；Q-08 当前视觉暂无问题 |

用户同时反馈：标题栏最小化/最大化/关闭按钮尚未跟随沉浸主题（M2 已安排）；现有页面仍像测试界面（M2 提供参考图后重做）；PDF 撇号显示仍有问题（LOOP-04，M2 的 L1 已定位为样本生成器问题）。passed 仅限该包与用户实际执行的步骤。

**A 8.27 的两个根因（已修）：** (1) Electron 37（Chromium 138）在绝对定位文本层的空白处原生拖选会跳到任意位置，端点落在容器/`<br>`/空白处时旧实现回退为整段引文匹配而判重复句 → 文本层改用官方 `TextLayerBuilder`，端点换算为行首/行尾，普通单击拖选由产品按最近行边缘计算，复核提示移出页面流；(2) 合成 PDF 样本给组合标记 1000 单位前进宽度且无组合定位。

## 5. 依赖与维护路线（提炼自计划第 12 节，现行规则见 [Git 与 GitHub](../dev-rules/git-and-github.md#5-bot-与低频操作)）

- **A-35**：整个项目尝试采用最新稳定依赖；每次实施重新查询 npm/GitHub Releases，精确版本进入 manifest 与锁文件，不用浮动 `latest`，不默认选 beta/rc；不兼容时记录尝试版本、失败命令、上游限制、保留版本和复查条件。D0（清单）至 D4（收敛）的批次已由 M2 的 U1 接续（LOOP-02）。
- **bot 路线（LOOP-03，ACT-04 外部启用）**：B0 Dependabot 原生 npm/Actions（每周，minor/patch 分组，major 单独审查，无自动合并）；B1 PR 设计依据与模板检查；B2 复核既有 DCO App；B3 可选建议性 AI review（先手动试跑，不向 fork 暴露 secrets）；B4 发布前评估 CodeQL/依赖审查与签名。优先复用 GitHub 原生能力，不启用 stale/欢迎/自动标签。
- **选型候选（提炼自第 14 节，现行记录在 [Q-14](../../USER-ACTIONS.md#q-14) 与 [M2 计划第 3 节](../delivery/m2-media-mvp-plan.md#3-开源查证与整合路线a-40)）**：PDF.js 已采用；EPUB 比较 epub.js / Readium Web / foliate-js，MOBI/KF8 候选 foliate-js（接口不稳定）；播放走 Chromium 原生 + FFmpeg（M2 实测）；画布/导图候选 React Flow、Excalidraw（M3 前补证）；获取候选 libtorrent、WebTorrent（M4）。2026-09-25 的官方维护查询只证明样本级活跃，不构成适配结论。
- 阅读引擎可替换的最小合同：格式能力负责打开/页/文本/位置/资源读取，阅读 UI 消费能力，资源库持有永久身份；换引擎不静默创建修订，旧锚点映射失败时显示待修复；停用要释放任务/worker/object URL 并拒绝旧 epoch 结果。

## 6. 遗留事项去向

| 事项 | 承接 |
| --- | --- |
| H-01 新包复核、撇号显示 | [用户待办 H-01 复核](../../USER-ACTIONS.md#h-01) / [LOOP-04](../delivery/status.md#loop-04)（M2 L1） |
| Q-08 最终视觉、标题栏按钮主题 | M2 P6；最终视觉见[用户待办 Q-08](../../USER-ACTIONS.md#q-08) |
| EPUB/MOBI 生产引擎选型 | Q-14 |
| 录音（VOICE-01—08） | M2 R1—R4 |
| 真实模型调用、真实 Profile 迁移 | ACT-05，未授权 |

## 7. 清理记录（M2 的 C1—C3）

| 项 | 内容 |
| --- | --- |
| 已删除的文档 | `docs/delivery/m1b-execution-plan.md`、`m1b-cursor-prompt.md`；`docs/evidence/m1b-reading-notes-delivery.md`（181 KB，上文已提炼） |
| 已删除的证据目录 | `docs/evidence/m1b-reading-notes`（约 187 MB）、`m1b-m1a-regression`；其中 `act01-fix` 的样本 PDF 与 `edge-drag-review.json` 以固定链接可取回 |
| 已删除的一次性脚本 | `audit-m1b-{a-b7-review,b5-review,b6-review,b7-rework,recheck}.mjs`、`review-m1b-*.mjs`（8 个真实窗口审查脚本）：断言已由下表的能力测试或 `scripts/stage/package.mjs` 的打包烟测覆盖，窗口截图类检查不再保留 |
| 样本生成 | `build-m1b-samples.py`、`build-m1b-review-samples.py` → `scripts/samples/build-reading-samples.py`、`build-scan-pdf-sample.py`；外部样本 → `tests/fixtures/external-samples/` |
| 归档提交 | `5504c97`（`git merge-base --is-ancestor 5504c97 origin/main` 为真） |

<a id="迁移映射"></a>
### 迁移映射

测试按能力重命名与合并，去掉轮次名。旧文件与新文件一一对应（标注合并的除外），用例逐一保留，例外只有三处：旧阅读页的整库分页用例（`lets the reader page through the whole library and open a row past the first window`）随资源库页面重做，由 `tests/shell/shelf.test.tsx` 的分页用例与 `tests/library/works.test.ts` 的游标分页取代，阅读页保留 `pages every resource, finds the oldest by title and opens it`；`surface-binding` 中“副驾驶页”用例因该页并入右栏改名为“Agent 页”，并新增漫画/视频阅读器绑定一例；三个 P0 用例合并。其余测试数变化只来自 M2 新增。

| 旧文件 | 新文件 |
| --- | --- |
| `tests/m1a/p0-contracts.test.ts` | `tests/contracts/contracts-i18n.test.ts` |
| `tests/m1a/p0-playwright.test.ts`、`p0-testing-library.test.tsx`、`p0-react-copy.test.ts`（各 1 个用例） | 合并为 `tests/shell/toolchain-wiring.test.tsx`（3 个用例） |
| `tests/m1a/p1-grants.test.ts` | `tests/runtime/grants-lifecycle.test.ts` |
| `tests/m1a/a-review.test.ts` | `tests/runtime/grants-package-inventory.test.ts` |
| `tests/m1a/p2-storage.test.ts` | `tests/runtime/storage-locations-recovery.test.ts` |
| `tests/m1a/p3-agent.test.ts`、`p5-faults.test.ts`、`model-routing.test.ts`、`live-models.test.ts` | `tests/agent/loop.test.ts`、`protocol-faults.test.ts`、`model-routing.test.ts`、`live-models.test.ts` |
| `tests/m1a/p4-ui-service.test.ts`、`f27-app.test.tsx` | `tests/shell/chinese-workspace-flows.test.ts`、`app-restore.test.tsx` |
| `tests/m1a/acceptance-review.test.ts`、`reverify-boundaries.test.ts` | `tests/runtime/acceptance-regressions.test.ts`、`failure-boundaries.test.ts` |
| `tests/m1a/f24-f32.test.ts`、`a-reverify.test.ts` | `tests/runtime/location-ownership-idempotency.test.ts`、`location-switch-recovery.test.ts` |
| `tests/m1a/helpers.ts`、`tests/m1b/pdf-pixels.ts`、`pdfjs-reader.ts` | `tests/helpers/app.ts`、`pdf-pixels.ts`、`pdfjs-reader.ts` |
| `tests/m1b/formats.test.ts`、`large-files.test.ts`、`external-samples.test.ts` | `tests/reading/formats.test.ts`、`large-files.test.ts`、`external-samples.test.ts` |
| `tests/m1b/b5-rework`、`b6-rework`、`b7-rework`、`b8-rework`、`b9-rework`、`b9-integration`、`b11-pdfjs-text`、`pdf-page-lifecycle` | `tests/reading/parsers-package-identity`、`pdf-text-layer-scale`、`page-presentation`、`page-geometry`、`glyph-layout`、`font-widths`、`pdfjs-text`、`pdf-page-lifecycle`（包依赖矩阵类用例随原文件保留，G-01/AT-18 门禁按用例名匹配） |
| `tests/m1b/reading-notes`、`rework-closure`、`rework2-closure`、`a-b5-review` | `tests/notes/reading-notes`、`reading-closure`、`source-repair`、`unicode-source-navigation` |
| `tests/m1b/a-recheck.test.ts` | `tests/package/preview.test.ts` |
| `tests/m1b/agent-surface.test.ts`、`shell-ui.test.tsx` | `tests/agent/surface-binding.test.ts`、`tests/shell/shell-ui.test.tsx` |
| `tests/m1b/samples/external/*` | `tests/fixtures/external-samples/*` |

脚本映射：`m0/m1a/m1b.mjs`、`verify-m0/m1a/m1b.mjs`、`m1a|m1b-fingerprint.mjs`、`m0|m1a|m1b-report.mjs`、`m0|m1a|m1b-required-cases.json`、`package-m0/m1a/m1b.mjs`、`bench-m0/m1a/m1b*.mjs` → `scripts/stage.mjs <阶段> test|bench|package|report` 与 `scripts/stage/*`、`scripts/stages/<阶段>.json`（报告门禁的反例自测：m0 1 个、m1a 1 个、m1b 10 个合并为 `scripts/stage-report.test.mjs` 的 11 个，另加 M2 的新增）；`scripts/m0.mjs` 保留（`experiments/m0`）；`inventory-m1b-deps.mjs` → `inventory-deps.mjs`；`m1a-live.mjs` → `live-models.mjs`。
