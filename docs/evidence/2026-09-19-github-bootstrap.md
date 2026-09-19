# Git 与 GitHub 建立记录

| 字段 | 内容 |
| --- | --- |
| 报告 ID / 日期 | EV-20260919-github-bootstrap / 2026-09-19 |
| 关联 | ADR-0002；用户授权建立独立 Git 历史、必要 CI 和低频协作 |
| 范围 | 本地 Git、远端初始化、治理工具、Actions、Ruleset 及 GitBook 准备 |
| 环境 | Windows、PowerShell 7、Node.js 24.19.0、Git |
| 检查结论 | passed：本地门禁、基础设置读回及一次真实 GitHub CI 均通过；本报告覆盖初始化验证快照 |

## 已核实事实

- 目标为 `chialecode/manga`，建立前为公开空仓库，无分支或提交引用。
- 根提交 `0fa1c54` 只包含 0 字节的 `README.md`，已推送至 `main`；正文与其他现有文档保留在工作区，在后续提交纳入历史。
- 维护凭据具备本仓库 admin 权限；凭据不写入配置、日志或版本库。
- 建立前没有 Ruleset；Secret scanning 与 Push protection 已启用，Actions 默认令牌只读且禁止创建/批准 PR。
- checkout v7.0.1 与 setup-node v7.0.0 的完整 SHA 已通过各自官方仓库标签核对。

## 本次验证

| 验证 | 结果 |
| --- | --- |
| `node scripts/verify.mjs` | passed：治理脚本语法、JSON 语法、文档及 Git diff 检查通过 |
| 文档结构与追踪 | 44 份 Markdown、301 个内部链接、62 项需求、48 个 AT、9 个 POC |
| 独立临时夹具 | 正常副本退出 0；断开的 Markdown 链接、无效 GitHub JSON、MJS 语法错误分别使统一入口退出 1 |
| 配置解析 | PyYAML 6.0.3 解析 6 个 YAML；人工与解析结果核对 CI 事件、job/Ruleset 名称及 GitBook 目标文件 |
| 远端仓库开关 | 已读回核对：仅 squash、关闭 auto merge、合并后删任务分支；Issues 开启，Wiki/Projects/Discussions 关闭 |
| Actions 权限 | 已读回核对：仅 checkout/setup-node、强制完整 SHA、默认只读、禁止 Actions 创建/批准 PR |
| 安全入口 | 私密漏洞报告已开启并读回；Secret scanning/Push protection 保持开启；自动安全修复 PR 保持关闭 |
| 本地 Git | main 跟踪 origin/main；已启用仓库级 pre-push hook、LF、仅快进 pull 与 fetch prune |
| GitHub CI | [运行 35432262755](https://github.com/chialecode/manga/actions/runs/35432262755)在提交 `c6116f3592788fe1da383c7e9f6c2798ec24250a` 上 completed / success；仅手动触发一次 |
| 必需状态身份 | GitHub 返回 `repository-quality`、conclusion=success、App ID=15368，与 Ruleset 定义一致 |
| 本地文档内容范围 | 所有登记 Markdown 已检索，未包含机器绝对目录或超出 MANGA 自身范围的项目叙述 |

初始化顺序为：空 README 根提交 → 文档及配置提交 → 一次远端 CI → 本次验证记录提交 → 启用最终 Ruleset 并读回核对。该顺序允许先验证真实检查，再要求后续 PR 提供同名状态。最终规则以 [GitHub 规则页面](https://github.com/chialecode/manga/rules)为实时执行状态，仓库预期定义为 [main.json](../../.github/rulesets/main.json)。本报告后的普通变更使用 PR，不再使用初始化直推流程。

最后的证据更新只涉及本文和执行台账，本地门禁再次执行；上述远端成功结果归属于其注明的配置提交，不冒称证据更新后的每个提交都运行过 CI。首次 bootstrap 验证了手动入口，真实外部 PR 路径与合并操作尚未执行，不为生成额外演示记录创建空 PR。

解析工具仅用于本次配置核验，不是应用依赖或 CI 的隐式安装步骤。Dependabot 已配置月度更新，但尚未观测到更新 PR；GitBook 本次不连接或发布。应用 POC、产品 AT 和 GitBook 渲染均不在本次基础设施验证范围内。
