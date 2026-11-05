# 阶段交付报告：Agent 的待审操作与门禁提速

日期：2026-11-08。角色：B 实施、重新检查与修复。唯一计划为[当前阶段计划](stage-plan.md)。基线 `main @ fd32430`，分支 `feat/m9-next`；继续已有的一个阶段提交，保留本轮开始前的改动，最终版本在聊天交付消息中给出。未 push、未创建 PR、未合并；A 已于 2026-11-08 集中审查并收敛（[第 11 节](#a-review)），`productAcceptance` 保持 `not-run`。

本次复查修复了确认与所有者执行之间的竞态、提议创建重放、导出发布与完成恢复、任务范围外的预览泄露、上下文预算下结果丢失，以及批量确认和失败提示。没有缩减计划的验收或把实现缺口改成人工检查。最终源码的正式门禁已通过，证据与复用范围见第 9 节，等待 A 复核。

<a id="cleanup"></a>
## 1. 阶段开始的整理（C0）

- 复用 A 的阶段整理：以前的计划与报告改为固定 Git 归档链接，仍有效的结论保留在正本；登记表的当前阶段为 `m9`，计划和报告只保留这一份。文档治理检查仍校验过期文件和旧阶段标签。
- 保留 `.env.local`、`dist/design-refs/`、`dist/tools/`、`dist/samples/`、`dist/keys/` 与已有本地分支；它们是配置、参考、工具、样本或签名材料。未读取与任务无关的配置和私钥。
- `dist/desktop/`、`dist/plugins/` 与 `dist/evidence-runs/current/` 由最终门禁重建；[`docs/evidence/gate/`](../evidence/gate/) 只在全部通过后替换，截图检查后才入库。依赖查询的本地记录保留在被忽略的 `dist/evidence-runs/deps/`。
- 保留用户已要求的小写 `manga` 路径、目录升级与安装行为（A-118、A-119），由本阶段全套打包、安装和位置走查重新验证。
- 本次故意改坏选择器的超时反例留下两个合成 `manga-package-*` 现场。清理已核对其绝对路径限于系统临时目录，但执行环境自动审批拒绝了递归删除（只返回 `blocked by policy`），现场保留供诊断。随后完整包的媒体失败留下七个现场，完整包和局部包的窗口失败各留下两个；没有把这十三个既有失败现场写成已清理。正式门禁统计各次运行新增目录，旧现场不混入新增计数；反例的可公开摘要为 `timeout-check.json`。

<a id="dependencies"></a>
## 2. 依赖盘点（D1）

2026-11-07 重新执行 `pnpm outdated -r`，并对 65 个直接依赖并行查询官方 npm registry 的 `versions` 与 `time`，全部查询成功。按当天满 14 天的稳定版本判断，不绕过发行龄；查询快照位于忽略目录，公开结论写入 [ADR-0007](../decisions/0007-technology-stack.md)。`outdated` 的非零结果表示有新版，不能写成检查失败。

| 依赖 | 本阶段版本 | 官方发行证据与处理 |
| --- | --- | --- |
| `@earendil-works/pi-ai` | 1.3.0 → 1.4.0 | [npm registry](https://registry.npmjs.org/@earendil-works%2Fpi-ai)：1.4.0 为 2026-10-21 22:43 UTC，已满龄；最新 1.5.0 为 11-02，未满龄。保留升级，双运行时契约纳入完整回归 |
| `@tanstack/react-virtual` | 3.14.21 → 3.14.22 | [npm registry](https://registry.npmjs.org/@tanstack%2Freact-virtual)：3.14.22 为 2026-10-22 12:04 UTC，已满龄；最新 3.14.26 为 11-03，未满龄。长对话、卡片动态行高和窗口基准继续覆盖 |
| `linkedom` | 保持 0.18.13 | [npm registry](https://registry.npmjs.org/linkedom)：满龄的 0.18.14 实际发行于 2026-10-21。此前试升时主进程打包报 `MISSING_EXPORT`（依赖 `@acemir/cssom` 的 CommonJS `parse` 导出不能识别），已回退；复查条件与保留理由见 ADR-0007。最新版 0.18.15 未满龄 |
| Electron、dockview、Vitest、Vite、Tiptap、PDF、ONNX、其余直接依赖 | 保持现版本 | 除上述 linkedom 例外，已安装版本均为同主版本中满龄的最新；后续发行未满龄。修正了旧报告把已安装的 Vite 8.3.5、Tiptap 3.32.0、Vitest 5.0.5 写成未满龄的错误 |
| `@types/node` | 保持 24.19.2 | 留在与 Electron/CI 相同的 Node 24 主版本；最新 26.x 不据此自动切换运行时 |

没有新增生产依赖。A 已查证的人工审批候选和整合路线见[计划第 3 节](stage-plan.md#31-候选)。本地功能参考索引未提供对应的工具审批实现，没有从外部工程复制代码。

<a id="mapping"></a>
## 3. 工作包映射

| 包 | 需求 / 验收 | 实现位置 | 实际验证与边界 |
| --- | --- | --- | --- |
| C0 阶段整理 | A-45、A-56、A-57 | 文档登记表、阶段计划/报告、导航 | 文档治理与公开内容检查；反例现场因执行环境拒绝清理而保留 |
| D1 依赖盘点 | A-35、NFR-05 | 两个依赖清单、锁文件、ADR-0007 | 官方发行时间；双 runtime、长会话、完整包回归 |
| W1 存放与 schema v14 | DATA-01；AT-156 | `packages/storage-drizzle/src/sql.ts`、`store.ts`；`packages/app-core/src/conversations.ts`、`creative/projects.ts`、`creative/proposals.ts` | `tests/library/schema-v14-migration.test.ts` 的 4 个场景涵盖备份、数据不变、实际退出、写失败、回滚重试、第二次打开与较新资料拒绝；`migrate-v14` 窗口观察 |
| W2 五种提议 | AGENT-01、03；AT-151、153、154、85 | `packages/contracts/src/inputs-proposals.ts`；`commands/creative.ts`、`creative/proposals.ts`、`creative/agent-access.ts` | `proposals.test.ts`、`creative-tools.test.ts`、`proposal-integrity.test.ts`；提出不改对象、归属限制、创建重放、预览边界 |
| W3 决定、执行与恢复 | AGENT-01、03、DATA-01；AT-151、152 | `creative/proposals.ts`、`commands/creative.ts`、`product-app.ts`、`commands/agent.ts`、`ops/stream.ts`；项目包与粗剪导出服务 | 同步事务、实际崩溃、成功回执与仅开始请求、文件发布恢复、取消/失败、预算延后通知；详见第 4 节 |
| W4 对话卡片 | AGENT-03、UI-02；AT-151、154 | `apps/desktop/src/renderer/components/chat/messages.tsx`、`hooks/use-session-stream.ts`、中文文案与样式 | `tests/shell/proposals-ui.test.tsx`；批量清单固定、错误提示、目录取消、导出进度/取消；窗口与截图 |
| W5 按任务能力 | AGENT-04、05；AT-155、11、13、44、129 | `contracts/src/inputs.ts`；`commands/access.ts`、`commands/creative.ts`、`commands/agent.ts`、`product-app.ts`；`workspace/agent.tsx`、`components/chat/composer.tsx` | 原授权、模块、追踪与空范围测试全部保留并扩充；假 Embedding 与回环网页，重试沿用且不放宽范围 |
| W6 条件等待 | NFR-01；LOOP-29 | `apps/desktop/src/main/smoke/driver.ts` 与走查文件；`scripts/stage/lib.mjs`、`package.mjs`、`report.mjs`、`gate.json` | helper 超时正反例、真实打包反例、未注明原因的固定等待为 0；记录并强制 `window-walk ≤ 240 s` |
| W7 测试临时目录 | LOOP-28 | `tests/helpers/global-temp.ts`、`app.ts`、`plugin-fixtures.ts`；`scripts/stage/test.mjs`、`report.mjs` | 每轮独立根、成功清理、失败保留；新尝试立即作废旧通过结果；缺失计数和残留反例 |
| W8 测试、走查与基准 | AT-151—156 与既有回归 | `smoke/proposals-walk.ts`、`scripts/stage/bench-creative.mjs`、`gate.json`、新增/扩充测试 | 必需用例、所有既有窗口观察与 60 项性能目标保留；最终结果见第 9 节 |
| W9 文档与门禁 | 受影响正本 | 需求、验收、设计、开发规则、ADR、状态、用户待办、证据 | 修正与代码不符的字段、路径与状态说明；A 复核待执行，产品验收 `not-run` |

<a id="proposals"></a>
## 4. 本次复查的问题、修复与依据（W1—W4）

以下是 B 已修复、交 A 核实的稳定编号，不宣称 A 已关闭。

| 编号 / 严重度 | 触发与原问题 | 修复与定向证据 |
| --- | --- | --- |
| B-01 / P1 | 确认抢占之后、所有者处理函数运行之前，用户仍可能修改目标；仅在抢占时核对会按旧预览删掉新内容。效果与回执分开保存也会留下无法判断的退出窗口 | 在所有者处理函数中重新核对，同步删除、改名与粗剪编辑的效果和成功回执在同一 SQLite 事务里提交。实际子进程分别在抢占后、效果写入后但事务未提交、命令已提交后退出；恢复与只执行一次均通过 |
| B-02 / P1 | 已添加的新引用与项目子对象改动未必改变目标行，旧删除/导出预览仍可执行；完整卡片返回模型会泄露任务范围外的引用标题或原始失败诊断 | 删除修订附加反向引用摘要（含项目材料），项目包修订附加实际导出内容/快照摘要；工具只返回 `{proposalId,status,summary}`，完整卡片限所有者；新引用、文稿修改、私人笔记隔离及超长含路径诊断的分类通知测试通过 |
| B-03 / P1 | 提议是直接插入而创建回执依赖后续网关提交，重放或重启可能多建卡片；只有 `command_requests` 的退出记录不能证明对象已修改 | 提议与最小创建回执同事务保存，重放仍返回同一编号；恢复要求命令一致且成功的 `operations` 回执，未完成请求清除后回到待确认；创建重放/重启与仅开始请求测试通过 |
| B-04 / P1 | 项目包已经发布但回执未写时重启会再导出一份；粗剪登记任务就把卡片标为已执行，随后取消或 FFmpeg 失败仍被报告为成功 | 项目包采用唯一临时文件与不可覆盖发布，发布前记录大小/哈希/目标，发布后退出可核对成品补回执；粗剪任务关联与回执一起登记，按持久任务的真正完成状态更新卡片。发布前/后、任务登记时的实际崩溃与导出取消/失败测试通过 |
| B-05 / P1 | 下一轮先消费所有决定，再裁剪材料上下文，预算不足会把未发送结果标成已汇报 | 只消费实际预算可容纳的结果，放在材料前部，在创建运行的事务里标记 `reportedRunId`；余项保留后续轮次。小预算、多结果、长项目说明与重试冻结测试覆盖 |
| B-06 / P2 | 批量确认弹窗打开后，新卡片可能被加入执行；选择器或命令失败静默，粗剪兼容性代码直接显示英文 | 批量清单固定为弹窗展示时的卡片，每条失败可见且继续其他条；目录取消保留待确认；进度和取消入口按真实任务状态展示，复用粗剪的中文问题说明。新增 UI 场景通过 |
| B-07 / P2 | 门禁把缺失临时计数当作 0，没有强制窗口用时；新测试尝试早退时旧通过结果仍可被复用 | 新尝试先写 `running` 并删除旧用例结果，缺 Vitest/缺报告记失败；临时计数必须实际存在，窗口用时必须有效、与阶段样本相同且不超过 240 秒。22 个脚本自测包括残留、缺失计数、陈旧结果与用时反例 |
| B-08 / P2 | 原报告引用不存在的服务/命令/helper，虚构表字段、动作、撤销与回执键，部分依赖日期错误 | 按实际源码重写本报告并同步设计、状态、规则与用户待办；`knip.json` 登记真实崩溃子进程入口；文档与公开检查不替代产品验收 |
| B-09 / P2 | 媒体走查等到虚拟行后，在另一次渲染脚本中无保护地重新查找并点击；行在两次调用间移除会抛错，Electron 原来只返回通用异常 | `loop-media.ts` 复用 `clickTestId`，在同一查找中等待并点击，超时仍报失败；`common.ts` 保留渲染器错误和失败脚本，监听器随调用清除。原完整包的具体抛错行未重现，不把推测写成根因；诊断构建的两次局部走查均通过，修复构建和三次完整包结果见第 9 节 |
| B-10 / P2 | 退出全屏时，浏览器已退出、原生窗口仍在退出的短暂状态会触发再次点击而重新进入全屏；弹幕走查仅等视口和图层相对父容器一致，分屏面板还未布局时会在旧尺寸上读数与截图 | `waitWindowFullscreen` 等原生事件，`exitScreenFullscreen` 只在浏览器未退出时才用按钮退回，所有相关媒体/覆盖层走查复用；真实点击等命中并重读坐标，弹幕尺寸等待同时核对面板与当前容器/视口。新增延迟退出与超时测试，辅助件 7/7；重建包 `media` 通过、`window-walk` 85/85，保留全部宽窗口、像素、截图与全屏断言 |
| B-11 / P2 | 基准仍要求 Agent 的 `proposal.delete` 返回完整卡片，与只返回精简回执的安全契约不一致，导致基准在 597 秒失败 | 基准核对 `{proposalId,status,summary}`，再通过宿主 `app.proposals.getCard()` 验证预览与反向引用。单独重跑 bench 通过，提出/确认 p95 为 1.63/6.93 ms；本轮临时目录清理 7 个、剩余 0 个 |

### 4.1 实际存储与生命周期

`PRODUCT_SCHEMA_VERSION = 14`。提议表为 `agent_proposals(id, session_id, run_id, project_id, kind, command_id, input_json, preview_json, target_json, reason, status, result_json, created_at, decided_at)`，索引为 `agent_proposals_session_status(session_id, status, created_at)`。没有另外的消息/工具事件列、修订列、布尔 `unreported` 列或三个虚构索引；会话流按 `run_id` 把提议挂到助手消息。

`target_json` 是 `{kind,targetId,title,revision}`。白板/导图/粗剪的摘要包括对象行、内容与历史操作状态；文稿包括实际版本、正文与标题；项目包括当前行。删除附加反向引用，项目导出附加 `collectBundle` 的内容与快照（固定导出时间用于比较）。列表刷新和确认都核对修订，最后执行点再核对一次。

状态为 `pending → applying → applied / failed`、`pending → rejected / stale`；确认后发现变化可从 `applying` 成为 `stale`。同一对话最多 20 条待确认。删除对话或项目连同提议清除；完整备份保留提议，可移植项目/资料包不包含提议。实际所有者命令使用提议编号作为幂等键，没有 `proposal:` 前缀。

### 4.2 预览与恢复

| 提议 | 已实现预览与执行 |
| --- | --- |
| 删除 | 白板卡片/连线、导图节点、文稿版本/字数、粗剪片段/时长；引用来源标题与总数（最多展开 5 处）；明确不能撤销 |
| 改名 | 原名、新名、同名提醒；调用既有 rename 或 `project.update`，可再次改名，不虚构独立撤销记录 |
| 项目包 | 实际对象/材料计数、估计大小与建议 `.manga-project.zip` 文件名；没有 `includeMedia` 开关。确认先由宿主选择目录，取消不调用 apply；输出与所有者直接导出相同 |
| 粗剪编辑 | `add/update/move/remove`，1—200 步；内存试跑，每步说明与前后片段数/时长。确认调用 `roughcut.edit`，`Agent：` 标签的一步记录保存在 `creative_ops`，一次撤销可整步复原 |
| 粗剪导出 | 原有 `roughcut.plan` 的请求/实际区间、关键帧偏移、模式与兼容性；任务登记后保持执行中，校验成品后成功，取消/失败/中断有明确失败原因 |

同步操作按成功 `operations` 回执恢复；仅开始请求返回待确认。项目包发布意图仅限主进程（公开卡片移除 `_exportIntent`），重启核对成品的文件类型、大小与 SHA-256，恢复时只处理本次命名的临时文件。粗剪按任务的持久完成状态恢复，不能用“非空文件”替代其输出校验。已失败的提议不会自动重试。

`commands/agent.ts` 在本轮实际材料预算下准备决定摘要，置于其他材料之前，和运行一起提交 `reportedRunId`；不能容纳的结果不消费。模型收到简短中文失败类别，原始所有者诊断不进入通知，避免本机路径泄露与超长结果阻塞。Agent 直接删除/改名/导出/粗剪编辑仍拒绝，内部误发所有者 grant 也不能令 Agent 越权。

### 4.3 schema v14

`store.ts` 沿用现有迁移：检查 `schema_meta.schemaVersion`，较新版本以 `API_INCOMPATIBLE` 拒绝；迁移前 checkpoint 并生成 `manga.sqlite.premigrate-v13`（调用追踪 `agent_requests` 不进入备份），DDL 与版本发布在同一事务。退出或写失败回滚，再启动可继续；第二次打开不再迁移。4 个 v14 测试场景覆盖多个断言，不写成 8 个测试。

<a id="opt-in"></a>
## 5. 按任务加上的能力（W5）

`allowCommands` 的枚举与上限为 `metadata.search / semantic.search / webpage.fetch`、至多 3 项。本轮临时 grant 和快照冻结授权，重试沿用，发送成功清空输入框选择。语义项只在模块开启且有 Embedding 连接时显示；网页项只在研究模块开启、当前上下文是项目时显示。关闭模块或未勾选时，工具清单与命令层都拒绝。

`semantic.search` 仍限制当前允许资源、笔记、录音、摘录与防剧透边界，`webpage.fetch` 的目标项目由任务提供。验证使用假 Embedding 与本机回环网页，未调用真实模型、Embedding、网页、Bangumi 或其他产品服务。真实配置与手感在[用户待办](../../USER-ACTIONS.md#checks)保持未执行。

<a id="w6-waits"></a>
## 6. 条件等待与计时（W6）

实际 helper 是 `smoke/driver.ts`：复用 `waitUntil`、`waitForTestId`，补充 `waitText`、`waitFrames`、`waitDrawn`、`waitWindowFullscreen`；没有 `smoke/helpers.ts` 或报告原列出的 selector helper。条件超时返回 false，由走查保留的业务断言记失败。UI 等待改为属性、文本、元素是否绘制、布局和原生窗口完成；保留的 `sleep` 仅限真实按住、播放/录音、计时器/动画窗口、内存/帧采样或轮询节流，每处有 `// real time:` 原因。

- `findUncommentedSmokeSleeps` 接入 `verify`，未注明原因的调用必须为 0；自测可抓出故意的无注释等待。
- `tests/package/smoke-isolation.test.ts` 实际执行 helper，缺失 selector 超时为 false，可匹配表达式为 true。
- 2026-11-07 临时把 `runMigratedSmoke` 的项目标签条件改为不存在的 `nonexistent-spot-check-tab`，重建后只运行 `workspace-migrated`。烟测超时并失败，唯一问题为 `the project tab did not mount in the active context host`；原选择器与后续所有断言已恢复。可公开反例摘要为 `timeout-check.json`。
- `package.json.phaseTimings` 记录实际各阶段秒数，`windowWalk.seconds` 必须与 `phaseTimings["window-walk"]` 一致、有效且 `≤ 240`；缺失、负数、不一致和超限都会被报告拒绝。
- 模型弹窗先滚动到“模型能力”，等待三个上限输入框全部在 modal 可视区后拍照；正式包产生最终截图。
- 第一次跑到打包的正式门禁中 `loop-media` 返回 Electron 通用渲染异常，提议与迁移观察都通过。补充诊断的同一构建两次只跑 `loop`，12 项观察均通过，原具体抛错行未复现。代码检查同时修复了虚拟行查找与点击分离的竞态；没有删除媒体投递、调用记录、过期重提取和源变化拒绝断言。局部通过不写为完整包证据。
- 后续完整包发现 `danmaku-layer` 的全屏失败与 `danmaku-window-top` 的旧几何读数；修复全屏往返后，局部包再现了窗口已到 `1500×520`、内部面板却仍保持旧尺寸的情况。Dockview 的 `ResizeObserver` 在下一帧布局，图层与旧父容器一致不能证明布局完成。补齐面板条件后，重建包的 `window-walk` 85 项观察全部通过。真实点击必须命中当前元素；原生退出超时和面板未布局均明确失败，不通过扩大容差或删除断言修复。

<a id="w7-tempdirs"></a>
## 7. 测试临时目录与门禁结果（W7）

全局辅助件实际使用 `MANGA_TEST_TMP_ROOT`，并给 worker/子进程设置同根的 `TMP/TEMP/TMPDIR`；`app.ts` 与 `plugin-fixtures.ts` 经 `testTempRoot()` 建目录。`stage test` 给每次尝试一个独立 `manga-vitest-*` 根，global setup 与 JSON reporter 都放在里面。Vitest、脚本自测和必需用例都通过后才删该根，失败保留合成 Profile 与报告用于定位。

新尝试开始先将 `test-run.json` 写为 `running` 并删除旧 `cases.json`；Vitest 缺失或没生成报告不能复用旧通过结果。前后实际统计系统临时目录的 `manga-*`，写 `{before,after,removed,left,prefixes}`；`left` 是本轮新增而未清理的目录数，必须为 0。报告拒绝缺失计数和残留。既有故意失败现场在 `before/after` 中如实保留，不写成已清理。

<a id="migration-map"></a>
## 8. 测试与走查的覆盖（W8）

既有直接所有者命令拒绝、metadata 临时授权、模块停用、任务范围、追踪、迁移回滚、虚拟列表/贴底与全部窗口业务断言保留。新增五工具与两个 opt-in 的断言补在现有文件，没有用提议测试替代原安全测试。

新增 `tests/agent/proposal-integrity.test.ts` 的 14 个场景和 `tests/helpers/proposal-crash-child.ts` 实际验证执行竞态、任务外预览隔离、创建重放/重启、引用/导出依赖、三个同步退出点、两个文件发布退出点、粗剪任务登记退出、取消/失败与预算延期结果。子进程确实退出 99 后重新打开合成资料，不只手改提议状态。`knip.json` 登记此独立入口。

正式门禁仍要求 AT-151—156 与全部既有必需用例，7 条新增窗口观察（删除改名、失效一次、粗剪、项目包、重启、按次授权与迁移）及全部既有观察；提议提出/确认两个性能指标和 v14 迁移记录来自实际样本。定向验证已通过：先前 6 个受影响文件 81/81，随后竞态与 UI 回归 24/24，再补粗剪登记退出后 integrity 文件 14/14；最终全量结果以第 9 节为准。

<a id="gate"></a>
## 9. 最终门禁与源码指纹（W8、W9）

状态：最终源码的 `node scripts/stage.mjs gate` passed。依次执行 verify（不重复跑 Vitest）→ test → package → installer → bench → package 至同指纹连续 3 次 → report；中途失败先修复，按各步骤的依赖指纹复用仍有效的结果。

本次第一次正式 gate 在公开内容检查阶段检出了新增诊断测试中的写死合成盘符路径（`machine-path`），尚未运行测试、包或基准。已改为由 `tempProfile()` 生成同样的隔离路径，泄露与预算断言不变，再运行正式 gate；未豁免公开检查。

随后 gate 的 verify 通过（24 秒），全量测试通过（94 秒，2855 项：2845 通过、10 跳过、0 失败），打包在 `loop-media` 失败（265 秒）并停止，未继续安装与基准。这些通过结果在烟测源码修复后按指纹过期，最终证据重新生成；没有把失败的完整包算进连续通过次数。

媒体修复后的 gate 中 verify 通过（24 秒）、测试通过（70 秒，同样 2855 项），完整包在窗口弹幕走查失败（205 秒）并停止。诊断与修复采用局部包：原生退出和真实点击修复后媒体通过，窗口中的旧布局读数仍失败；补齐面板条件后，局部窗口 85/85 通过。局部结果不计连续完整包次数，最终源码的正式 gate 结果见下文。

新增原生等待辅助件的第一次静态检查发现 Electron 事件字符串联合不能匹配其重载类型（26 秒即停止，未跑测试或包）。已改成分别注册具体事件，`node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` 通过，再运行完整 gate。

最终源码的首次完整尝试：verify 25 秒通过；test 74 秒通过，2857 项中 2847 通过、10 跳过、0 失败；第一次 package 335 秒通过；installer 146 秒通过；bench 运行 597 秒后因 B-11 失败。修正基准后单独重跑 bench 通过，保留原有计时边界与目标。最终 gate 耗时 682 秒：verify 24 秒通过，test、第一次 package、installer 和 bench 因各自依赖指纹未变而复用；第二、第三次 package 分别 321、335 秒通过，连续通过次数为 3；report 通过。最终包的 `window-walk` 为 114 秒。

另行执行不跳过测试的 `node scripts/verify.mjs`，退出成功：Vitest 2857 项中 2845 通过、12 跳过、0 失败；与 stage test 的跳过数量分别按各自运行结果记录。`node scripts/stage.mjs report` 在文档与证据同步后再次通过，产品验收仍为 `not-run`。

test 的临时目录前后均为 15，本轮清理 1、剩余 0；最后一次 package 清理 9、剩余 0；bench 清理 7、剩余 0。既有失败现场计入前后基数，仍然保留。基准全部门槛通过，v14 迁移 100 次运行样本耗时 24.82 ms 且有备份；原始样本见 [`bench.json`](../evidence/gate/bench.json)。源码指纹为 `6b4dfa571c828cec4a8203b602a984e4797fa914554095376fed2abdb224041e`，bench 脚本指纹为 `c73470c4c99069e45da9141f053d6e82507d8b21cf16cd414ef37a9b67f2eac0`。报告为 `self-check-passed`、`engineeringReviewable=true`，`productAcceptance=not-run`。

[`docs/evidence/gate/`](../evidence/gate/) 已替换为最终结果与超时反例摘要，总计 2,278,527 字节。提议卡片、已决定状态、任务能力菜单和模型上限的五张截图已查看；深色删除卡片的红色警告对比偏暗，留给 A 视觉复核。截图检查不等于人工产品验收。

<a id="limits"></a>
## 10. 交付边界与下一步

B 的重新检查和局部补测不等于 A 审查或产品验收。真实模型/Embedding、显示器/DPI、输入法与用户手感未由本次自动门禁验收，H-33、H-88—H-91 继续在[用户待办](../../USER-ACTIONS.md#checks)保持 `not-run`；Q-37 仍按推荐默认实现，已更正粗剪默认位置并补充执行中/取消的预期。未授权 push、PR、合并或发布。

首选下一步：把同一分支、最终提交、唯一计划、本报告和 B-01—B-11 交给 Agent A 集中复核。A 核实修复、检查证据并直接处理可确定的局部问题；审查收敛后才在用户待办登记远端操作授权请求。人工检查不是 A 复核或后续授权的前提。

<a id="a-review"></a>
## 11. A 集中审查（2026-11-08）

角色：A。范围：同一分支的阶段提交、B-01—B-11、W1—W9 的实现与证据。做法：通读提议服务（`creative/proposals.ts`）的创建、核对、执行、恢复与结果回传，授权表（`commands/access.ts`、`creative/agent-access.ts`）、任务能力的开启条件（`commands/agent.ts`）、网页抓取的网络边界（`net/broker.ts`）与对话卡片（`components/chat/messages.tsx`），对照 `proposal-integrity`、`proposals` 与 `proposals-ui` 的用例；B-01—B-11 的修复在源码里都能找到对应处，相关用例在本次门禁里通过。A 直接修了下面两处，没有需要交回 B 的缺口。

| 编号 / 严重度 | 问题 | 修复与证据 |
| --- | --- | --- |
| A-01 / P1 | 项目包导出提议的修订用 `collectBundle` 的全部内容算摘要，其中包括项目保存的标签与布局（`workspace_contexts.updated_at`）、阅读进度和白板视口。界面上任何切换标签、调整分屏、翻页或平移白板都会重存这些状态，提议随即被标为“已失效”；用户在查看卡片的过程中就可能让它失效，AT-154 的路径在实际使用里基本走不通。试验：只把同一份布局原样保存一次，待确认的导出提议就变成 `stale` | 修订只算项目行、内容表与快照，去掉 `project_progress`、`project_workspace` 与白板的 `viewport_json`；内容改动仍让提议失效（原用例保留）。新增 `proposal-integrity` 用例：保存布局、平移白板后提议仍待确认，确认后导出一个包；去掉修复时该用例失败 |
| A-02 / P2 | 深色主题没有覆盖 `--color-danger`，提议卡片的警告、“不能撤销”与失败状态是 12 px 的 `#B42318` 文字，落在 `#1F232E` 上对比度 2.39:1，低于设计规则对次要文字 4.5:1 的要求（B 在第 9 节留给 A 的视觉复核） | 新增语义 token `--color-danger-text`（浅色 `#B42318`，6.57:1；深色 `#F97066`，5.63:1），卡片的警告、不可撤销与失效/失败状态改用它；危险按钮的底色不变。`sidebar-tokens` 用例断言两种主题都 ≥ 4.5:1，并拒绝提议样式再把文字写成 `--color-danger`；新的深色截图已核对 |

**看过、不改的地方。** 网页抓取对 Agent 开放后仍经网络代理，回环、内网与链路本地地址一律拒绝（测试用的回环服务走显式白名单）。批量确认的清单在打开确认框时固定，一条失败不阻止其余，失败逐条显示。粗剪模块在重启时被关掉的极端情况下，执行中的粗剪导出提议要等模块重新开启才会变成“失败”，影响只是卡片多停留在“执行中”，记为观察项，不在本阶段处理。

**门禁。** A 修复后在最终源码上运行 `node scripts/stage.mjs gate`，全部通过：verify 24 s；test 69 s，Vitest 2859 项，2849 passed、10 skipped、0 failed（多出的 2 项是 A-01、A-02 的回归用例），临时目录前后 22、清理 1、剩余 0；package 连续三次 319、333、307 s，`window-walk` 113 s（124 项观察）；installer 101 s；bench 589 s，60 项门槛全部达标，提出与确认提议 p95 为 2.32、7.16 ms；report 为 `self-check-passed`、`engineeringReviewable=true`，`productAcceptance=not-run`。源码指纹 `fbd0b6994c782f5af1a2a32d915fc9b1b8f9a852d6a823e4d74cfefa4170da66`。[`docs/evidence/gate/`](../evidence/gate/) 已换成这次的结果（2,273,178 字节）。第 9 节保留 B 那一轮的数字作为过程记录。

**结论。** 审查收敛，Agent 侧完成，可以请求用户授权远端操作（[ACT-16](../../USER-ACTIONS.md#act-16)）。人工检查 H-33、H-88—H-91 与 Q-37 仍为 not-run 或当前默认，不是授权的前提；产品验收保持 `not-run`。
