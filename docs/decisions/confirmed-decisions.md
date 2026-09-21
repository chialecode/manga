# 已确认决定与正本索引

核对日期：2026-09-19。这里保留 A 编号和决定来源，具体行为以链接的职责正本为准。用户在本次会话明确答复的决定持续有效；它们不等于功能已经实现或验收通过。已解决的问题已从 [待决事项](open-questions.md)移除。

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

A-06（第三方插件）、A-10（Game）与 A-11（组合内核）仍在待决事项；A-13 的单写入宿主属于待技术验证的建议，不能从目录要求推导为用户已选择某个进程方案。成熟基础库与业务协议自主管理并存，新增功能必须同时设计 UI 与 Agent 可用的能力接口。
