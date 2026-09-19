# 当前执行状态

核对日期：2026-09-19。用例定义与需求追踪矩阵仅在 [交付计划](roadmap-and-acceptance.md)维护；本页汇总实际状态并链接证据。

## 当前事实

| 项目 | 状态 | 依据 / 下一动作 |
| --- | --- | --- |
| 产品需求与详细设计 | 已有评审稿，局部方向已确认 | [文档导航](../README.md)、[确认台账](../decisions/open-questions.md) |
| 文档治理框架 | 已建立；当前文档基线 0.6 | [框架建立记录](../evidence/2026-09-19-documentation-framework.md)、[文档复核](../evidence/2026-09-19-documentation-revision.md)、[GitHub 建立记录](../evidence/2026-09-19-github-bootstrap.md) |
| 应用工程、依赖、UI、数据库与安装包 | 未建立 | M0 验证与选型后按范围建立 |
| Git 与远端 | 已建立独立历史，空 README 根提交已推送 main | [建立报告](../evidence/2026-09-19-github-bootstrap.md) |
| CI 与分支规则 | 首次 CI 已成功，确认必需状态身份；最终 Ruleset 按初始化顺序启用 | [Git 与 GitHub](../dev-rules/git-and-github.md)、[验证记录](../evidence/2026-09-19-github-bootstrap.md)、[实时规则](https://github.com/chialecode/manga/rules) |
| GitBook、自动 AI reviewer | GitBook 仅准备配置；不启用自动 AI review | ADR-0002；接入和发布需另行确定 |
| M1—M4 产品验收 | 全部未执行 | 无应用实现，不能据文档判断已完成 |

## M0 跟踪

| 编号 | 状态 | 证据 | 下一动作 |
| --- | --- | --- | --- |
| POC-01 | not-run | 无 | 准备文本/EPUB 定位样本 |
| POC-02 | not-run | 无 | 明确设备、采集与时间映射样本 |
| POC-03 | not-run | 无 | 建立视频/字幕/粗剪样本矩阵 |
| POC-04 | not-run | 无 | 最小契约、生命周期与独立宿主原型 |
| POC-05 | not-run | 无 | 输入法、选区、编辑与互嵌原型 |
| POC-06 | not-run | 无 | 数据、搜索、打包与恢复原型 |
| POC-07 | not-run | 无 | 运行时候选的统一契约与维护成本验证 |
| POC-08 | not-run | 无 | 两个假元数据提供者 |
| POC-09 | not-run | 无 | 受控 HTTP 与文件/入库崩溃样本 |

## 验收记录方式

截至本次核对，AT-01—AT-48 均为 not-run。开始执行时按“用例 ID + 里程碑/子场景 + 被测版本”新增记录并链接 [验证报告](../templates/validation-report.md)；例如 AT-07 的 M1 静态阅读与 M2 动态视频分别记录，不能相互替代。

状态统一使用 not-run、running、passed、failed、blocked；blocked 必须说明具体阻塞和负责人，passed 必须有该版本的实际结果。变更使旧结果不再适用时保留历史报告，并将当前受影响范围改为待重新验证。
