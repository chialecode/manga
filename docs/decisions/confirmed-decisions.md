# 已确认决定与正本索引

核对日期：2026-10-03。这里保留 A 编号和决定来源，具体行为以链接的职责正本为准。用户在本次会话明确答复的决定持续有效；它们不等于功能已经实现或验收通过。尚需决定、人工/配置/外部动作及后续 loop 统一见[事项总表](open-questions.md)。

| 编号 | 当前决定与范围 | 负责正本 / 依据 |
| --- | --- | --- |
| A-01 | 本地单用户，基础功能无需登录；在线服务独立凭据 | [产品原则](../product-rules/core-product-principles.md)；2026-09-19 用户确认 |
| A-02 | Windows 11 x64 首发，其他桌面系统后续独立验收 | 产品原则；2026-09-19 用户确认 |
| A-03 | M1 先交付 Agent 主页面、OpenAI 格式文本/转录、连接设置、首次配置及资源总览，再接入阅读/记录 | [需求](../product/requirements.md)、[交付计划](../delivery/roadmap-and-acceptance.md)；本次优先级答复 |
| A-04 | SQLite + better-sqlite3 + Drizzle；附件与媒体使用文件系统 | [ADR-0007](0007-technology-stack.md)；本次沿用选型答复 |
| A-05 | React、编辑基础、Vite + Forge 等按 ADR-0007 接入；当前锁定工具版本与正式验收分别记录 | ADR-0007；本次沿用选型答复 |
| A-07 | 文本 TXT/EPUB/MOBI/PDF；漫画 PNG/JPEG 目录/CBZ、EPUB/PDF/MOBI；视频 MP4/MKV、H.264/HEVC（H.265）、AAC、ASS、多音轨界面、VFR 同步 | 需求 READ、交付计划 AT-52/53；本次格式答复，实际支持仍待验证 |
| A-08 | 粗剪首版只做编码/容器一致且流参数兼容的无转码剪切拼接 | 需求 CLIP、AT-33；本次粗剪答复 |
| A-09 | 主动录音同时支持按住/切换；文字和提示灯；后台悬浮框可设默认位置/大小 | 需求 VOICE、[交互](../design/interaction-and-workflows.md)；本次录音答复。其余音频策略仍待定 |
| A-12 | M2 首批元数据 Bangumi；M4 首批下载使用 BitTorrent，可选装配 | [外部扩展](../design/external-providers-and-acquisition.md)；本次提供者答复，具体 BT 引擎后续决定 |
| A-14 | 保留需求 6.2 响应目标，以已确认的 Windows 11 参考环境进行首轮测量；不外推最低配置 | 需求 NFR-01；2026-09-19 用户确认。公开证据脱敏设备标识 |
| A-15 | 基础技术按 ADR-0007 实施，后续新增选型在需要时决定 | 本次沿用选型答复；无需重复询问已选库 |
| A-16 | 资源、工程及所有安装目录外的应用生成内容位置均由用户配置；默认系统文档目录；开发/正式路径隔离 | 需求 DATA-04、UI-04；本次目录答复 |
| A-17 | 首版中文 UI，保留多语言扩展 | 需求 UI-05、设计规则；本次语言答复 |
| A-18 | 项目采用 Apache-2.0 | 根 [LICENSE](../../LICENSE)；本次许可证答复 |
| A-19 | 公开内容只描述本项目，不保留外部工程参考关系、私密材料或本机专属环境信息 | [文档治理](../governance/documentation-policy.md)、[质量门禁](../dev-rules/quality-gates.md)；本次发布前检查要求 |
| A-20 | 开发采用 A 规划 → B 连续执行/自检 → A 集中审查；本地 Git 准备按任务处理，A 直接修局部问题，较大缺口整批返工，非阻塞审批/配置/人工项集中交付，真正阻塞决定只暂停依赖部分 | [开发协作](../dev-rules/development-workflow.md#agent-handoff)、[连续执行](../dev-rules/development-workflow.md#continuous-execution)、[Git 节奏](../dev-rules/git-and-github.md#1-本地优先与工作节奏)；2026-09-19 用户明确要求少打断、统一审批并减少 A/B 往返，不改变产品 Agent 权限或外部操作授权 |
| A-21 | 一个阶段（里程碑或明确子阶段）一个分支、一个提交：push 前阶段内的实现、返工、审查记录、修复与人工反馈修复全部 amend 进该提交，消息描述最终结果；不按执行角色、审查轮次、内容类型或“独立功能/修复”拆分，只有不同阶段分别提交。已推送提交默认追加修复，远端改写需明确授权 | [Git 审查提交规则](../dev-rules/git-and-github.md#review-commits)、[ADR-0002](0002-local-first-github.md)；2026-09-19 用户要求减少审查过程提交，并明确 M0 与 M1a 保留独立提交；2026-10-03 用户重申一个阶段的提交不再区分、全部 amend，替代原“独立交付分别提交”的表述 |
| A-11 | 自研 kernel 正式作为唯一生产组合运行时 | [ADR-0005](0005-m0-composition-runtime.md)；2026-09-20 用户决定 |
| A-13 | better-sqlite3，一个 Profile 一个写入宿主 | [ADR-0004](0004-m0-storage-host.md)；2026-09-20 用户决定 |
| A-22 | BYOK；首版实际支持自研与 PI 两种 AI runtime，在设置中更换 | [ADR-0007](0007-technology-stack.md)、[模型协议](../design/agent-and-plugins.md#92-供应商适配)；2026-09-20 用户决定 |
| A-23 | 建立忽略的本地环境文件；指定兼容 API/模型用于后续本地测试，使用已指定的动画、漫画、小说真实资源根 | [最新审查](../evidence/m1a-acceptance-review.md)；2026-09-20 用户授权。地址/密钥/个人路径保留本地，授权不代表迁移已执行；外部原件按索引语义保留 |
| A-24 | push、创建 PR、合并只在阶段完成且用户明确表示时执行；A 全部审查后可推荐 | [Git 规则](../dev-rules/git-and-github.md#13-pushpr-与授权)；2026-09-20 用户决定，替代此前可提前远端交审的默认节奏 |
| A-25 | 字体采用系统字体与可选字体方案，先形成一版可替换的临时主题，后续转为自有视觉基线 | [交互设计](../design/interaction-and-workflows.md#31-初始视觉参数)、Q-08；2026-09-20 用户授权原型路线，未最终确认全部数值 |
| A-26 | 每个 Agent 角色结束后必须给出首选下一步，交给另一 Agent 时提供可复制 prompt | [下一步规则](../dev-rules/development-workflow.md#next-step)；2026-09-20 用户要求 |
| A-27 | LLM、Embedding、ASR 分别使用对应类型的模型，独立配置与测试；音频只发给 ASR，缺 ASR 不向 LLM 回退，转录文本才可交给 LLM 整理 | [模型路由](../design/agent-and-plugins.md#91-三层配置)；2026-09-20 用户纠正模型用途，已提供的模型仅为文本用途 |
| A-28 | 已提供独立 ASR 的本地测试配置并授权合成音频实测；此前“产品默认 ASR 预设”的解释由 A-29 更正，仅作为本地测试配置使用 | [短测证据](../evidence/m1a-asr-siliconflow/live-api.json)；2026-09-20 用户提供 ASR 配置，历史样本通过不代表产品流程通过 |
| A-29 | 文档不预设具体模型或测试服务；开发测试按用途读取忽略的环境变量，当前 LLM/ASR/Embedding 均已提供独立 OpenAI 兼容测试配置；仅在必要测试缺配置时询问开发者对应字段 | [本地模型测试配置](../dev-rules/development-workflow.md#model-test-config)；2026-09-20 用户纠正，替代 A-28 的产品预设解释；2026-09-21 补充 Embedding 本地测试配置，应用继续 BYOK |
| A-30 | 后续支持几十分钟录音，上传远端 ASR 前在本地筛除无人声区间；设置可选保留/不保留音频，以气泡或分段进度条回顾；每个转录语音段对应采集当时的小说位置、漫画页或动画时间 | [VOICE-06—08](../product/requirements.md#55-语音记录)、[时间映射](../design/domain-model.md#9-语音采集与位置映射)、AT-57—59；2026-09-20 用户新增需求，M1b 基础、M2 媒介扩展，尚未实现/验收 |
| A-31 | M1b 先安排阅读与人工记录；新增响应式隐藏侧栏、按钮悬停显示可操作浮层与沉浸式标题，当前模式菜单切换工作模式（入口位置后由 A-32 明确为左侧栏顶部），主面板优先提升空间利用率 | [UI-06—08](../product/requirements.md#511-界面与数据管理)、[交互设计](../design/interaction-and-workflows.md#2-应用壳与三栏布局)、AT-60—62、[M1b 计划](../delivery/m1b-execution-plan.md)；2026-09-22 用户明确要求；具体断点/尺寸仍待实测，本次未实施或验收 |
| A-32 | 正常宽窗侧栏常驻占位，窄窗才浮出；标题最左端使用侧栏图标；模式菜单移到左栏顶部，下方为功能与已打开资源/工程会话，每个会话绑定独立右侧 Agent/上下文/环境；未播放媒体低占用，窗口支持手机比例 | [UI-06—08](../product/requirements.md#511-界面与数据管理)、[交互设计](../design/interaction-and-workflows.md#2-应用壳与三栏布局)；2026-09-22 本次人工反馈，替代 A-31 的标题区模式入口解释；未宣称完整实现 |
| A-33 | 后续开发先让小说、漫画阅读器与动画播放器可供日常试用，再据反馈迭代；小说字体缩放、三种背景、目录/笔记/行距/边距，漫画左右翻页/缩放/铺满，动画自定义倍速/数字逐帧定位/按住右键倍速/音量/方向键；进度、笔记、划线与 Agent 联动 | [READ/CTX](../product/requirements.md#53-阅读与播放)、[交付顺序](../delivery/roadmap-and-acceptance.md#2-里程碑)；2026-09-22 用户新增方向，不视为本轮 M2 实施或产品验收授权 |
| A-34 | 人工参与前在交付结论直接列启动命令、合成样本、操作步骤与预期；开发启动自动处理 SQLite ABI；桌面中间产物集中管理，不混淆原型源码与生成物 | [工作流](../dev-rules/development-workflow.md#next-step)、[仓库地图](../dev-rules/repo-map.md)；2026-09-22 用户反馈 |
| A-35 | UI 使用 React + Tailwind CSS + shadcn/ui；整个项目依赖尝试最新稳定版，含后续主版本迁移，Tailwind 不限定 v4。精确版本经兼容验证后锁定，不兼容项记录实测与后续条件 | [ADR-0007](0007-technology-stack.md)、[唯一计划第 11—12 节](../delivery/m1b-execution-plan.md#11-ui-实施路径与-figma-的角色)；2026-09-23 用户补充并纠正 v4 限定；先写计划再继续原复核，当前未完成依赖升级或 shadcn 接入 |
| A-36 | 补充 GitHub 依赖更新 bot 和适合本项目的后续自动化计划；优先原生依赖更新，再评估设计/模板检查、DCO 与建议性 AI review 等 | [唯一计划第 12 节](../delivery/m1b-execution-plan.md#12-最新稳定依赖与维护-bot-路线)、[Git 规则](../dev-rules/git-and-github.md#5-bot-与低频操作)；2026-09-23 用户要求纳入后续计划；未授权本轮外部 App 安装、secrets、push/PR/合并或发布 |
| A-37 | 双模式显示名改为观测者/造物主，保留内部模式值和既有状态。按用户提供的页面图统一现有阅读、笔记与 Agent 的白灰粉三栏界面，并增加明确标注的动画演示页；演示使用静帧、模拟时间、预设对话和本次会话临时笔记，不接正式媒体导入、字幕解析、逐帧或模型调用 | [交互设计](../design/interaction-and-workflows.md#33-首版界面切片)、[同一计划](../delivery/m1b-execution-plan.md#113-2026-09-24-界面增补)；2026-09-24 用户要求及范围答复。覆盖先收敛功能再做 UI 的执行顺序，允许本轮独立 UI 实施；F-07—09、M2、正式 H 和 Q-08 仍分别判断 |
| A-38 | 本轮 A 复核后将 M1b 规划/实施两个未 push 提交合为一个，保留规划正文和旧证据；待决定、人工检查、配置及外部授权集中到 open-questions，不再分散维护；评估阅读/播放开源方案及可开关解耦，评估不等于已选库 | [唯一计划第 13—14 节](../delivery/m1b-execution-plan.md#13-下一实施批次与问题承接2026-09-25)、[事项总表](open-questions.md)；2026-09-25 用户追加要求，替代本批规划提交单独保留，不授权远端操作或真实数据迁移 |
| A-39 | 全软件先形成包含所有基本功能的 MVP，再根据反馈按 loop 持续迭代；可隔离的非阻塞项记录后移，不逐小样例在 A/B 间往返，B 以完整基本流程批次连续完成；不静默放弃正确性、来源、数据/权限/恢复门槛 | [MVP 基线与循环](../delivery/roadmap-and-acceptance.md#mvp-loop)、[开发规则](../dev-rules/development-workflow.md#mvp-loop)、[后续条目](open-questions.md#followup-loops)；2026-09-25 用户明确流程要求，不表示 MVP 已完成或本轮已启动所有后续阶段 |
| A-40 | 全项目优先采用可用且活跃的开源方案，重点转向将不同方案适配、组合进 MANGA，避免重复实现通用能力；Agent A 制定技术方案前必须查证官方维护/发行及适用证据。自研例外给出实证理由，上游问题保留最小复现与回归，不自动对外提交 | [开源选型规则](../dev-rules/architecture-and-contracts.md#open-source-first)、[总体架构](../design/architecture.md#9-开源组合与-manga-责任边界)、[本轮候选证据](../delivery/m1b-execution-plan.md#145-全项目开源整合与维护证据)；2026-09-25 用户明确调整全项目方案并补充 A 的前期查证职责。替代“通用能力优先自研”的解释；现有 kernel/双 AI runtime 是迁移基线，不证明已替换或取消已确认行为 |
| A-41 | PDF 路线转为移除自编解析/绘制生产路径、优先开源引擎，先交可用 MVP 再迭代；继续 A 定方案、B 一次性实施。B 8.23 已接入 PDF.js 6.3.289，待 A 复核，不表示产品验收通过 | [唯一计划 14.6](../delivery/m1b-execution-plan.md#pdfjs-mvp)、[B 交付 8.23](../evidence/m1b-reading-notes-delivery.md#b10-pdfjs-mvp)；2026-09-25 用户要求停止自研 PDF 的持续返工 |
| A-42 | 当前 M1b 批次在 A 复核确认不阻塞下一阶段后，可 push、创建 PR，CI 无问题后合并，再清理阶段分支并同步远端/main；此为条件授权，非立即执行。未授权发布、真实模型或真实 Profile 迁移。原“不改写现有历史”已由 2026-10-03 用户要求替代：M1b 未推送的四个提交按 A-21 归并为一个阶段提交；同日用户明确要求 push 并创建 PR | [ACT-03](open-questions.md)、[Git 规则](../dev-rules/git-and-github.md)；2026-09-25 用户本轮末句追加授权，替代当前动作“全未授权”的旧快照。8.22 存在 F-07/F-09 与严格报告失败，条件尚未满足 |
| A-43 | 以后所有提交都带 DCO `Signed-off-by` 签名，使用提交者本人的 Git 身份；本仓由 `prepare-commit-msg` hook 自动补签。DCO App 是否改为 Ruleset 必需检查另行决定；已推送的未签名提交补签需改写历史，另需授权 | [Git 规则 1.2](../dev-rules/git-and-github.md#12-commit-的内容与检查)、[ADR-0002](0002-local-first-github.md)；2026-10-03 用户在 M1b PR 的 DCO 失败后选择“以后都签”，替代此前“不强制 DCO sign-off”；同日用户另行授权 M1b PR 补签并强推 |

A-06（第三方插件）与 A-10（Game）仍在待决事项。A-11/A-13 已由用户于 2026-09-20 定稿；选择完成不等于产品验收通过。成熟基础库与业务协议自主管理并存，新增功能必须同时设计 UI 与 Agent 可用的能力接口。
