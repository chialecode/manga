# 开发规则索引

这里规定如何实现和验证 MANGA。产品行为见 [产品规则](../product-rules/README.md)，精确协议仍在 [详细设计](../README.md)。仅在修改对应范围时读取专题。

| 文档 | 触发条件 |
| --- | --- |
| [仓库地图](repo-map.md) | 首次工作、定位代码、建立工程或变更目录/环境 |
| [开发流程](development-workflow.md) | Agent 连续执行、集中审批、需求落地、修复与交付 |
| [Git 与 GitHub](git-and-github.md) | 分支/commit/push 的时机、频率、交接，以及 PR、CI、Ruleset、bot、安全入口与 GitBook |
| [架构与契约](architecture-and-contracts.md) | 包依赖、模块、进程职责、公开接口与选型 |
| [数据与安全](data-and-security.md) | 身份、定位、保存、迁移、IPC、凭据、来源和下载 |
| [Agent 与插件](agent-and-plugins.md) | 工具、上下文、模型、模块生命周期与插件 |
| [质量门禁](quality-gates.md) | 选择验证命令、处理失败、建立测试/CI 或发布 |

规则约束新增和正在修改的范围；与任务无关的历史问题登记后另行治理。实现必须符合本仓契约和有效决定。
