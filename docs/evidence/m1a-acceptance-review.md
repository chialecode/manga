# M1a 最新验收审查与集中返工

2026-09-21 接续：[F-24—F-32 独立复验](m1a-f24-f32-review.md)为当前技术结论。下文保留 2026-09-20 的发现、决定与原验证边界，不将 B 后续自检改写成 A 审核。

日期：2026-09-20。Agent A 对 M1a P0—P5、真实代码、既有证据和本次用户决定进行验收审查。起始版本为分支 feat/m1a-agent-foundation 的 62fd4ed，工作区干净；前置为未合并的 M0 a33b115。本次修复按同一交付 amend，最终版本由包含本文的提交解析。

**结论：A 本轮审查已完成，但 M1a 阶段验收不通过，技术审查未收敛。** 不推荐 push、创建 PR、合并或进入 M1b。上一轮 [交付报告](m1a-delivery.md)的“本地自动子集齐全/技术审查通过”仅是当时判断，本次实际复现已推翻该完整性结论；旧证据仍保留为原版本子集证据。已完成的技术定稿和人工短测不再列为待用户决定。

## 1. 已生效决定与本地准备

| 用户事项 | 本次落实与边界 |
| --- | --- |
| kernel / 写入宿主 | ADR-0005/0004 改为 accepted：自研 kernel、一个 Profile 一个 better-sqlite3 写入宿主。定稿不代表迁移恢复验收通过 |
| 新 React IME / 键盘 / 缩放 | 用户于 2026-09-20 报告人工测试无误，记录为 user-reported passed；未虚构测试包哈希或逐档步骤。本次未改 React 输入界面，复用该反馈；B 后续改变受影响界面时只短复测变动部分 |
| 真实 API | 已建立 Git 忽略的 .env.local，分别保存独立用途的 LLM/ASR 测试配置，密钥仅在本地。Node 测试须显式 --env-file=.env.local，普通测试不加载；当前桌面应用没有自动导入该文件的功能，不能声称设置页已配置。配置和历史 ASR 实测见第 7 节，文档不把它们当产品默认 |
| 真实资源根 | 已授权使用动画、漫画、小说三类真实资源根；本地变量为 MANGA_TEST_LIBRARY_ANIME/MANGA/NOVEL。仅核实三个目录存在，未读取正文、迁移或修改文件。当前只有文本导入和 Profile 迁移，不能把非空媒体目录当作 Profile 迁移目标。默认保留外部原件，通过受控索引接入；实现与恢复门槛补齐后按已有授权继续，不重复问是否允许使用 |
| 远端操作 | 阶段完成且用户明确表示执行相应动作后才 push/PR/合并；本次未执行，A 完成全部审查后可推荐 |
| 视觉 | 已核对本地参考中的系统字体、HarmonyOS Sans SC、JetBrains Mono 可选项及语义主题机制，记录可替换的一版路线；未在本次验收中重做界面，也未定稿全部数值。参考路径只在忽略配置中的 MANGA_LOCAL_REFERENCE_ROOT |
| 原生工具链 | vswhere 检出带 VC x86/x64 工具的 Visual Studio 18.10.1，纠正“本机未安装”旧记录。采用独立打包暂存目录 rebuild + ABI/asar 核验路线；当前源码仍走 prebuild，未声称已执行 node-gyp 源码编译 |
| BYOK / PI | A-22、ADR-0007、需求、协议与 AT-50 同步首版自研/PI 双 runtime、设置切换；实际实现缺口列 F-28，已不是用户待决定项 |
| 旧烟测指针 | 用户报告移除的指针经存在性检查确认已不存在；未再次删除文件 |

## 2. 审查发现与处置

编号续接上一轮 F-01—F-20。已修项目有新增反例先失败、修复后通过的证据；未关闭项均是开发责任，不包装成人工待办。

| 编号 / 严重度 | 触发、实际结果与依据 | 处置、位置与关闭条件 |
| --- | --- | --- |
| F-21 / P1 | Responses 工具仍套用 Chat 的嵌套 function 格式，工具历史改成 user 文本，丢失 call_id；违反 P3/AT-50 两套协议分别适配 | **已关闭**。在 packages/model-protocol/src/openai-http.ts 分离工具定义与 function_call/function_call_output 输入映射；流式/非流式请求均有 HTTP 捕获回归，mock 识别 Responses 工具回执 |
| F-22 / P1 | mapHttpError 返回供应商 body，错误可能反射认证或材料，进入 UI/任务错误记录；违反凭据/日志边界 | **已关闭此入口**。packages/model-protocol/src/http.ts 仅返回通用错误、状态和分类；合成敏感正文 400/404/500 回归不再回显，不代表全部日志已穷尽审计 |
| F-23 / P1 | 空 enumerated Agent grant 调用 inventory.overview 得到全库标题、笔记和 Profile 路径；违反 P1 的返回前过滤 | **已关闭此入口**。product-app.ts 按 grant 查询可读资源/可写对象，不返回 Profile 路径或无关附件；空范围回归返回空结果 |
| F-24 / P1 | proposeLocations 接受非空目标并登记 running；从未复制也能 recoverJobs rollback，旧实现递归删除目标各分区，合成预存文件确实被删 | **已止损，完整恢复未关闭**。domain/library-package.ts 对位置迁移保留全部目标并标 needs-review；新增回归保留预存文件。B 建立持久的逐文件所有权、planned/copying/committed 状态与当前 Profile 保护，正确处置 needs-review，恢复只能处理本任务产物，不删除冲突文件 |
| F-25 / P1 | applyLocations 切换 pointer 后旧实例仍可 notes.create 成功，重开目标库看不到该笔记；目标复制库还保留 running checkpoint；违反 P2/AT-51 已确认保存与恢复 | **未关闭，合成复现**。product-app.ts:applyLocations、locations.ts:persistPointer 需宿主写入屏障、目标锁/防重入、durable 切换与旧宿主停止写入；处理重叠/嵌套/重解析目录，原子发布指针，恢复以唯一权威库为准。覆盖复制/校验/发布/提交/配置切换的真实子进程退出，以及切换后写入重启读回 |
| F-26 / P1 | owner notes.create 后，另一个 Agent 以相同 key/输入调用得到 owner 的对象回执（ok、idempotentReplay=true）；call 只核对 command/input，不绑定原 actor/任务/授权 | **未关闭，合成复现**。product-app.ts:call 的 requests/pending/operations 与 grant/epoch 需一致设计，兼容旧回执，回放前校验当前对象/资源范围与模块状态。增跨 actor、不同任务、权限缩小、停用重启、并发 pending 反例；不能只改命令 hash 再宣称安全 |
| F-27 / P1 | sendAgent 等整轮结束才返回 runId；App.send await 后才 setRun，执行中停止按钮发空 ID/上次 runId。页面只保留一轮结果，无会话历史恢复；Tabs 不消费 runtime Facet，入口仍静态 | **未关闭，源码可定位**。product-app.ts:sendAgent/getRun、renderer/App.tsx:send/AgentPane 需先返回任务身份、可订阅状态/流、当前任务取消、刷新后会话与输入历史恢复、模块入口真实撤销。用实际 App/Electron 与受控慢提供者完成发送→切副驾驶→停止→重启恢复，不用玩具组件或字符串断言替代 |
| F-28 / P1 | pi-ai.ts 只调用自研 HTTP，未导入 PI；schema/upsert/UI 没有 runtime 选项。A-22 已明确首版双 runtime | **未关闭，新增决定落实项**。服务侧实际接 PI 已安装版本，设置持久化选项，旧配置兼容自研，运行冻结 runtime；保持同一授权、上下文、工具校验/取消。分别验证两种实际调用链与切换重启。并入当前 M1a 收尾，不回问用户二选一 |
| F-29 / P1 | 设置表单固定 Chat/text，只展示 URL/模型/key；不能编辑/删除/测试现有连接或选择 Responses/ASR/超时。产品无授权音频文件转录命令/界面；testConnection 上传四个零字节假 WAV，tools 无调用也标成功，未收到终结也标 streaming 通过，配置更改不清 verified | **未关闭**。App.tsx:SettingsPane、product-app.ts:testConnection/upsertConnection、preload/main/contracts 需完整连接管理、按 A-27 独立的 LLM/Embedding/ASR 模型配置、文本/ASR 路由与授权文件转录链、有效合成音频探针和严格能力记录。设置保存错误可见，替换/删除密钥清理旧引用，传递 timeout；文件不因测试连接自动外传。上一轮误用 LLM 的 HTTP 400 仍是无效 ASR 证据；随后使用独立环境配置完成第 7 节合成短测，Embedding 未配置、not-run，不跨用途回退。用途错配拒绝已修复；完整独立用途设置与产品文件转录仍待 B；测试配置按 A-29 读取，不内置具体模型默认，不能用 API 短测关闭 |
| F-30 / P1 | 首次配置只放 sr-only 提示，条件依赖 !workspace 而空 workspace 对象也为真；设置只整体 root 迁移，未提供各分区/指针修改。总览资源/笔记 bytes 恒 0、available 恒 true，backup/cache 恒 0，无真实索引/离线/打开定位修复；scan 的整个扫描仍同步 | **未关闭**。按 P2/P4、UI-04/DATA-04/LIB-04 实现真实首次配置与可编辑分区、异步可取消扫描、准确占用/可用状态和可执行管理入口。完善外部资源根只索引接入，原件不随默认根移动；真实根已有授权，本轮先合成验证，不把未实现媒体阅读硬塞入 M1a |
| F-31 / P1 | bench 仅 200 资源、保存 n=1，缺 10,000/50,000 基线及新栈冷启动/可见交互/上下文；verify-m1a 仅跑 Vitest 后写 passed，不核验 package/bench 必需字段、失败/缺项/旧指纹 | **未关闭**。P5 必须补合成规模、定义口径和原始值；报告验证器及缺项/失败/旧源码反例接入统一入口。不继承 M0 包/性能，不以本次小样本重跑代替门槛 |
| F-32 / P1 | runAgentLoop 仅截首条用户文本，工具结果无总预算，duration 只在每步前检查且未传连接 timeout，无费用限制；retryRun 创建新 runId，丢 readResourceIds 并换工具幂等键，已提交修改可能重复；新运行不复用历史，快照没有强制捕获材料修订，正文工具读 latest | **未关闭**。按 P3/AT-10/13/50 完成不可变材料/会话历史、上下文/输出与费用预算（未知价不伪造费用）、贯穿请求/工具的 deadline、重试恢复和稳定副作用回执。补第一次已提交工具后断线再重试无重复、授权保持、材料修订变化、预算中途耗尽/文本无完成事件的场景 |

F-24—F-32 耦合数据、授权、运行状态和界面，按 A/B 流程一次性交 B 连续实现。A 的局部修复不掩盖剩余风险，真实用户资料接入等到这些门槛满足；不要求用户再授权已指定的根目录。

另已修复 benchmark 的测试目录隔离：scripts/bench-m1a.mjs 现显式把 Documents 与 pointer 放在独立临时 Profile 下，避免后续基准重新写入用户 Documents 的烟测指针。规模/口径不足仍属 F-31，不能以隔离修复关闭。

## 3. 实际验证和版本边界

- 新增 tests/m1a/acceptance-review.test.ts 5 条测试在修复前全部失败，修复后全部通过；全部 Vitest 共 11 文件/48 测试通过。根与桌面 tsc 通过。
- [test-run.json](m1a-acceptance/test-run.json)记录本轮源码指纹；新生成的包证据保留在 docs/evidence/m1a-acceptance/，旧 m1a-review/ 原内容保留。包只验证 initial/restart 的同 Profile 笔记持久化，不覆盖尚未完成的产品流程。
- [审计复现](m1a-acceptance/audit.json)：跨 actor 同 key 得原对象回执；迁移后旧实例写入成功，新实例看不到；复制 checkpoint 仍待处理。仅使用临时合成 Profile。
- [真实 API](m1a-acceptance/live-api.json)：合成文本、流式及工具参数生成 passed（未执行业务工具）；历史上误用 LLM 模型发起静音 WAV 转录请求，返回 HTTP 400；该测试配置错误，结果不能用于判断 ASR 可用性，当时独立 ASR 未配置、not-run；随后新增的有效 ASR 短测见第 7 节。未发送用户正文/音视频，未记录请求凭据或供应商正文；此有限样本不证明完整 Agent、多轮工具或转录准确率。Responses 真实端点未测，两套协议本地受控回归继续。
- 本次不重跑旧设备测试；IME/键盘/缩放复用用户反馈。未源码编译 node-gyp；独立包仍为未签名本地产物。未对真实库做迁移或全量扫描。原型和小样本性能均不能签署 AT 整条或阶段通过。

最终验证记录如下（仅已测子集）：

| 命令 / 检查 | 退出与结果 |
| --- | --- |
| node scripts/verify.mjs | 0，文档/公开内容/依赖/两套类型检查、Vitest 48 条及 M0 契约/审查回归 15 条通过 |
| node scripts/verify-m1a.mjs | 0，11 files / 48 tests；不把此命令当作尚未实现的完整报告门禁 |
| node scripts/m1a.mjs package | 最终 0，initial/restart 均通过，restart 读回标记；一次 Forge 打包遇到临时 EBUSY，未杀用户进程或放宽检查，同源码顺序重试成功 |
| node scripts/m1a.mjs bench | 0，200 资源服务查询 p95 0.431 ms、保存 0.742 ms（n=1）；仍不足以关闭 F-31 |
| 本轮证据核对 | test-run/package/bench 的 sourceFingerprint 均为 9c75d6523d99f0ca9ba4d23f2619caf91c18920cfb0b443c06cc7b4599533870，m1aSourceFingerprint 均为 48e7512fb7888d9d4bf58381778c5fae69428b539afab6a1c4bab2a4ab3c2bdb；三张公开截图已检查，无私人材料/路径 |

真实 API 与审计复现生成于本轮修复后、最终 benchmark 隔离/注释更新前，JSON 保留实测指纹；这两项后续改动未影响其调用路径，复用结果而不冒充重新调用。汇总见 [quality.json](m1a-acceptance/quality.json)。

## 4. 交给 B 的差异任务和验收顺序

详细原计划仍是 [M1a 执行计划](../delivery/m1a-execution-plan.md)，不重建工程、不重做已通过且未受影响范围。当前优先顺序：F-24/25/26 的数据与授权 → F-27/32 的任务服务 → F-28/29 的双 runtime/连接转录 → F-30 的设置总览 → F-31 的规模/门禁与最终独立包。同时落实已授权的可替换字体/主题原型与隔离 rebuild 路线；相关回归随改动加入，不按工作包请求继续。

B 在原 [交付报告](m1a-delivery.md)追加按本编号的实现/验证表，A 复核后才关闭编号。本次已完成的是审查和止损，不是整批返工实现。给 B 的可复制 prompt 见 [当前执行入口](../delivery/m1a-cursor-prompt.md)。

## 5. 下一步与唯一用户事项

**首选下一步：将当前执行入口交给 Agent B，一次性完成 F-24—F-32，再交 Agent A 复验。** 现在不需要用户重复人工短测或重新确认 kernel/单写入、API、本地根、双 runtime。B 的完工回复必须给 A 审查 prompt，不能自行签署产品验收。

LLM 与 ASR 已按独立环境配置完成有限真实短测；这些是本地测试事实，不构成文档中的服务或模型默认。Embedding 仍未配置（not-run）。此前误用 LLM 的转录短测仍是无效 ASR 证据；新的有效结果见第 7 节。先由 B 完成稳定的设置、文件转录和能力探测入口，再按受影响范围验收。A-30 的长录音筛选、音频保留、分段回顾和跨媒介映射属于 M1b/M2，不扩大本轮 F-24—F-32。Q-08 最终自有视觉、Q-05 其余音频策略仍按各自截止点，不提前重问。

阶段满足退出条件、A 全部审查完成后，才给出明确 push/PR/合并推荐并等待对应用户指示。当前不推荐新阶段；此次本地 commit/amend 已有授权，远端操作未执行。

## 6. 模型用途纠正（2026-09-20，接续 485f4f9）

本节保留用户提供独立 ASR 配置前的执行记录；ASR 短测事实由第 7 节接续，现行配置规则见第 8 节。

用户明确 LLM、Embedding、ASR 使用不同类型的模型；A 承认此前把 openrouter/free 用于音频转录探测的错误。历史 HTTP 400 原始记录保留并追加无效测试判定，不能据此要求用户更换一个“失败的 ASR 服务”。真实 ASR/Embedding 尚未配置，保持 not-run；没有再次发起真实请求。

A 已在 product-app.ts 的 secretFor 增加用途检查：先核对 purpose，再解密凭据和调用探针；文本→转录、ASR→文本/工具/流式错配均本地拒绝。tests/m1a/model-routing.test.ts 新增 5 条：四种错配网络次数为零且不标记能力，以及正确 ASR 探针只使用选定 ASR 的地址/模型/凭据。此修复不等于完整路由/向量功能已交付，F-29 保持未关闭。

当时本地 .env.local 的真实模型改为 MANGA_TEST_LLM_*，独立 MANGA_TEST_ASR_* / MANGA_TEST_EMBEDDING_* 留空；本地探测脚本移除音频探测和默认执行，--check 只检查配置、不联网，--llm 才显式发文本请求。当时配置检查结果 LLM=true、ASR=false、Embedding=false、networkRequests=0；后续 ASR 配置见第 7 节，现行测试规则见第 8 节。

第 3 节及 m1a-acceptance 目录保留前一审查版本验证；本次新源码证据单独写入 m1a-model-routing，不覆盖旧测量。实际结果如下：

| 命令 / 检查 | 本次结果与边界 |
| --- | --- |
| node scripts/verify.mjs | 0；文档、公开内容、依赖、根与桌面类型检查通过；Vitest 12 文件 / 53 条及 M0 契约/审查回归 15 条通过 |
| node scripts/verify-m1a.mjs | 0；同一源码 53 条通过，生成独立 [test-run.json](m1a-model-routing/test-run.json)；F-31 报告完整性缺口仍在 |
| node scripts/m1a.mjs package | 0；未签名 Windows 包 initial/restart 通过，restart 读回初次写入标记，见 [package.json](m1a-model-routing/package.json) |
| 本地模型配置检查 | LLM 已配置，ASR/Embedding 留空；检查及本轮纠正均无真实模型 API 请求，无音频上传 |
| 证据与公开内容复核 | 测试/包与当前源码指纹一致；三张新烟测截图已检查，无私人材料或个人路径；汇总见 [quality.json](m1a-model-routing/quality.json) |

本次 sourceFingerprint 为 8adb9dc95973efaf6a8dc57acbc253ac59d93aea284ad70459f39daa9e6bfa01，m1aSourceFingerprint 为 126d42cb0b9d3e70500c856f5bb8e2be61d325bf48a150f1231fc6fab5b4a832。本轮只改连接探针的用途拒绝，性能基准未重跑，旧性能仍按第 3 节版本边界引用。M1a 阶段结论和首选下一步保持不变：B 集中完成 F-24—F-32，再交 A 复验。

## 7. ASR 本地配置与历史真实短测（2026-09-20，接续 72e27f4）

开发者提供了独立 ASR 测试配置，已写入 Git 忽略的 .env.local：MANGA_TEST_ASR_API_BASE_URL、API_KEY、MODEL_ID、PROTOCOL；配置只用于本次本地测试，文档不将其预设为产品默认。LLM 配置保持独立，Embedding 留空。密钥没有进入报告、源码、日志或暂存区；本地 ASR 脚本必须显式传 --asr 才请求服务，--check 仅检查配置。

使用本地 Windows System.Speech 合成中文短句，经现有 packages/model-protocol/src/transcription.ts 的 transcribeAudio 发送 multipart file/model。仅向独立 ASR 端点发起一次 POST，没有发送到 LLM，没有读取或上传用户录音、资源正文。

| 测量项 | 结果 |
| --- | --- |
| 样本 | 7.5 秒 WAV，16 kHz、16-bit PCM、单声道，240,046 bytes；样本文件仅本地保留 |
| 合成原文 | 你好，这是语音转录测试。今天我们测试独立的语音识别模型。 |
| HTTP / 用时 | 200；单次短测 1,594 ms，非性能基线 |
| 返回转录 | 你好，这是语音转录测试。今天我们测试独立的语音识别模型。 |
| 内容核对 | 非空，文字与原文一致；规范化比对通过 |
| 证据 | [live-api.json](m1a-asr-siliconflow/live-api.json)，保留时间、样本格式/哈希、源码指纹、请求次数及范围 |

这是一个有效的 ASR 连接与合成中文文件转录样本，不证明真实麦克风、噪声、长音频或完整产品流程已验收。F-29 保持未关闭；桌面设置尚无环境文件自动导入或完整连接管理界面。B 按更新后的执行入口继续，必要测试缺配置时才按 A-29 向开发者索取对应字段。

本轮未修改应用源码，第 6 节测试/包的两类源码指纹与此次真实请求一致；旧 API 和用途纠正证据保留各自当时的状态，不把后续成功回写成此前已经通过。

本轮 node scripts/verify.mjs 退出 0：文档、公开内容、依赖、两套类型检查、12 文件 / 53 条 Vitest 与 15 条 M0 契约/审查回归通过。未重跑未受影响的 Windows 包、性能或设备测试；仍不以此次单样本成功关闭阶段缺口。

## 8. 环境配置规则与后续语音需求（2026-09-20，接续 3d81a15）

A-29 更正此前把开发者一次测试配置解释为产品默认预设的记录。公开职责文档与 B prompt 已移除具体提供者/模型预设，测试从独立用途的本地环境变量读取。LLM 与 ASR 当前均为 OpenAI 兼容接口；必要测试缺配置时才询问相应字段，Embedding 未配置不阻塞当前独立工作。历史请求的配置、结果与耗时不改写为新测试。

A-30 已同步为 VOICE-06—08 与 AT-57—59：几十分钟录音在本地筛除无人声后上传；可选保留音频并以分段形式回顾；原始采集区间经过筛选/分块/转录仍映射到当时小说位置、漫画页或动画时间。文本/映射须在临时音频清理后保留，纯文本 ASR 不虚构精确段时间。这些是 M1b/M2 的后续契约，尚未实现或验收，不增加 M1a 返工范围。

本轮仅同步规则/设计/验收及忽略的本地探针，不修改产品源码；不重跑真实 API、打包或设备测试。M1a 验收结论保持未通过，首选下一步仍是 B 集中完成 F-24—F-32，再交 A 复验。

本轮验证：`node scripts/verify.mjs` 退出 0，含文档、公开内容、依赖边界、两套类型检查、12 文件 / 53 条 Vitest、15 条 M0 回归；文档检查覆盖 86 份文档、638 个本地链接、72 条需求和 59 个验收用例。忽略的本地探针已移除具体服务/模型断言和历史证据覆盖；`--check` 确认 LLM/ASR 已配置、ASR URL/协议有效、Embedding 未配置，网络请求数为 0。这些检查不执行 AT-57—59，不改变阶段验收结论。

## 9. B 自检交接（2026-09-20）

F-24—F-32 的实现与定向回归已由 B 连续完成，细节见 [交付报告第 7 节](m1a-delivery.md)。本页 A 原发现表保留，编号须经 A 复验后才能关闭。B 自检 **不是** A 审核，也 **不是** 产品验收通过。VOICE-06—08 未纳入。独立证据目录不得覆盖本节既有跑次。
