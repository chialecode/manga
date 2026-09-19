# 已确认决定与正本索引

核对日期：2026-09-21。这里保留 A 编号和决定来源，具体行为以链接的职责正本为准。用户在本次会话明确答复的决定持续有效；它们不等于功能已经实现或验收通过。已解决的问题已从 [待决事项](open-questions.md)移除。

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
| A-21 | 同一交付未 push 的本地 Agent 审查修复 amend 原提交，消息描述最终结果；不同里程碑或独立交付分别提交，已推送提交默认追加修复，远端改写需明确授权 | [Git 审查提交规则](../dev-rules/git-and-github.md#review-commits)、[ADR-0002](0002-local-first-github.md)；2026-09-19 用户要求减少审查过程提交，并明确 M0 与 M1a 保留独立提交 |
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

A-06（第三方插件）与 A-10（Game）仍在待决事项。A-11/A-13 已由用户于 2026-09-20 定稿；选择完成不等于产品验收通过。成熟基础库与业务协议自主管理并存，新增功能必须同时设计 UI 与 Agent 可用的能力接口。
