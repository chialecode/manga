# 验证与质量门禁

按变更风险选择最小充分检查。已通过后只有新改动、失败或未解决风险才扩大/重复验证。不能为了形式给错字修复增加应用测试，也不能以文档检查代替迁移或运行验证。

## 1. 当前可以执行的检查

前置条件：Git 与 Node.js 24 或更新版本；CI 使用 `.node-version`（Node.js 24.19.0）。从仓库根：

```powershell
pnpm install
node scripts/verify.mjs
```

`verify.mjs` 检查脚本语法、文档登记、GitHub JSON、文档结构、`git diff --check`、依赖方向、公开内容及报告门禁反例，并在 `node_modules` 存在时运行 `tsc --noEmit` 及契约/修复回归（含 `closure-review.test.ts`）。它不安装依赖；缺少 `node_modules` 时类型检查非零退出。

完整 M0 自动验证需要先生成同一源码版本的 Windows 包和性能结果。PowerShell 示例：

```powershell
$env:M0_EVIDENCE_DIR='docs/evidence/m0-next-run'
node scripts/m0.mjs package
node scripts/m0.mjs bench
node scripts/verify-m0.mjs
```

`M0_EVIDENCE_DIR` 统一控制测试、包、性能和汇总目录；为新版本选择独立目录，不能覆盖历史证据。未设置时为兼容旧脚本仍默认 `docs/evidence/m0-closure/`。最新完整复核结果在 `docs/evidence/m0-final-review/`，旧目录的版本边界见[复核报告](../evidence/2026-09-19-m0-closure-review.md)。真实跨卷另以 `M0_VOL_A` / `M0_VOL_B` 指定已授权测试位置。

`verify-m0.mjs` 运行环境/依赖及反例、类型、合成样本、全部 Node 场景测试和报告核对；它不会自动生成 Windows 包或性能结果。报告要求必需文件/用例恰好存在、指纹与当前源码一致、必需包阶段和性能指标/目标通过，否则非零退出。`node --test scripts/m0-report.test.mjs` 验证缺项、旧证据和失败结果会被拒绝。

报告的 `automationStatus: tested-subset-passed`、`engineeringReviewable: true` 仅描述已测原型子集；`m0Exit` / `m1Entry` 固定标明 `not-assessed-see-stage-gates`，不由脚本推断正式阶段通过。实际判断回到[执行状态](../delivery/status.md)与当前阶段门槛。

证据齐全后单独重查报告，或打开最近独立包：

```powershell
node scripts/m0.mjs report
./scripts/open-m0-package.ps1
```

依赖方向反例：`node scripts/check-deps.mjs --self-test-only` 必须通过（内部确认错误导入会被检出）。

只检查文档时执行 `node scripts/check-docs.mjs`。依赖方向与反例：`node scripts/check-deps.mjs`。M0 子命令见 [仓库地图](repo-map.md)。


统一入口检查 `scripts/` 顶层 MJS 语法、文档登记和 GitHub 配置 JSON 的语法、文档结构，以及工作树/暂存区的 `git diff --check`；子检查失败返回非零。它不校验 JSON 的 GitHub schema、不解析 YAML，也不证明服务端设置已经生效。CI 工作树通常是干净快照，diff 检查不是历史提交格式审计。

只检查文档时执行 `node scripts/check-docs.mjs`。根目录按脚本自身位置解析，不依赖机器盘符。返回码 0 表示声明的检查通过，1 表示失败；输出具体文件和原因。修改治理脚本时用临时夹具验证失败传播，修改 workflow/ruleset 时另外解析配置并核对必需 job 名与 GitHub 返回结果。

| 当前自动覆盖 | 边界 |
| --- | --- |
| 仓库自有 Markdown 与登记表相互覆盖，状态/角色/日期等字段、替代目标合法 | 不识别真实用户审批；不检查第三方依赖和构建输出 |
| Markdown 行内相对链接、引用式定义和本地锚点存在，目标不逃逸仓库 | 不访问网络链接，不充当完整 Markdown/HTML 解析器；不检查代码块内示例路径 |
| CLAUDE 只引用 AGENTS | 不验证所有宿主是否自动加载仓库指令 |
| PRD 需求 ID 唯一、交付矩阵完整且不引用不存在需求/AT、AT/POC 定义唯一 | 不证明测试覆盖深度或需求合理性，不推断阶段子场景已通过 |
| 执行台账完整登记 POC 定义 | 不证明报告里的实际结果真实 |

链接采用仓库相对路径、ATX 标题或显式 HTML `id` 锚点；避免在文件名/链接内使用空格或嵌套括号。复杂 HTML 导航、外部 URL、Mermaid 语义和视觉渲染人工核对。

### 1.1 公开内容检查

统一入口已包含 `node scripts/check-publication.mjs` 和其回归测试。脚本枚举 Git 已跟踪文件与未忽略的新文件，分别检查工作树与暂存版本，防止清理工作树后仍提交旧敏感内容。它检查个人绝对路径、常见凭据、含凭据 URL 和私有数据文件；报错只显示文件/行号/类别，不回显匹配值。反例测试覆盖暂存泄漏、未跟踪报告及可移植示例。

这是一组有限规则，不是全量密钥或语义识别器。外部工程叙述、设备标识、私密正文、二进制/图片、任意格式的新令牌，以及待推送提交中被后来删除的内容仍需人工/Agent 检查；脚本不扫描 Git 历史。推送前核对最终待推送提交/变更集和公开候选文件名，必要时补查相关历史；失败时修复后再验证。第三方库/官方接口链接与合法许可证声明保留。

报告生成后重新运行公开检查；当前性能报告生成器只输出平台/架构/版本，不采集具体 CPU/内存标识到公开报告。旧报告仅脱敏，不重跑或修改测量结果。

## 2. 应用与 M0 工程门禁

正式工程的测试工具按 [ADR-0007](../decisions/0007-technology-stack.md)采用 Vitest、Testing Library/jsdom 和对应浏览器烟测的 playwright-core；这些选型尚未接入，不能把它们列成当前已执行命令。既有 node:test 门禁持续有效，迁移时保留场景覆盖；jsdom 和浏览器烟测不替代 Electron 原生输入法与设备实测。

M0 验证工程建立后，下列命令已经存在并应实际运行。产品 AT 仍按阶段执行，不能用 POC 子集标为 passed。


| 变更范围 | 必需验证 |
| --- | --- |
| 文档 | 本地文档检查；确认正本、决定和验收语义一致 |
| 业务代码 | 受影响包类型检查、静态检查与有意义的场景测试 |
| 公共契约、依赖或构建 | 使用方兼容、依赖边界、相关集成与打包冒烟 |
| 数据、锚点、迁移、备份 | 旧数据夹具、版本/引用保持、失败恢复、备份往返 |
| Agent、插件、装配 | 可控提供者、范围限制、取消/重试、激活失败、停用竞态与旧代次拒绝 |
| 媒体、录音、外部适配器 | 固定样本、设备/时钟、格式组合、限流/断网与必要真实服务契约 |
| UI | 键盘/输入法、窗口/DPI、完整状态、已承诺主题与最终界面证据 |
| 发布 | 当前阶段 AT、目标平台安装包、升级/恢复、支持矩阵与已知限制 |

应用相关命令存在后必须运行相应检查；命令不存在时补齐实现或明确记录阻塞，不能使用 `--if-present` 静默把缺少关键检查当成成功。合理低风险豁免写明不适用原因。

## 3. 证据与失败处理

按 [报告模板](../templates/validation-report.md)记录输入、版本、环境、实际结果和限制，更新 [执行状态](../delivery/status.md)。检查基础设施变化至少验证能检出一个真实反例，避免脚本永远返回成功。

环境失败、业务失败和未执行分别报告。不能删测试、弱化断言、重写旧结果或改验收目标来制造通过；合理需求调整由有效决定驱动并同步正本。模型、网络和设备的非确定性场景使用可控故障夹具验证协议，有限真实测试验证实际适配。

## 4. CI 接线与扩展

`.github/workflows/ci.yml` 在面向 main 的 PR 更新及手动触发时运行统一入口，必需状态名称为 `repository-quality`。不设置路径过滤、main push 重复检查或定时全量扫描；触发、权限、Ruleset 与失败处理见 [Git 与 GitHub](git-and-github.md)，实际远端结果见 [建立报告](../evidence/2026-09-19-github-bootstrap.md)。

当前 CI 安装锁定依赖并运行 `verify.mjs`（文档 + 公开检查及其反例 + 依赖方向 + 类型检查 + 契约/修复回归）。Windows 包与性能分别运行 `node scripts/m0.mjs package`、`node scripts/m0.mjs bench`，不纳入无 Windows 桌面的 CI。人工评审仍负责语义和证据质量。完整 POC、Windows 设备与打包走 `verify-m0` / 人工检查单。不把 CI 成功当作 M0 退出或产品发布验证。新增 Actions 需同时更新远端 allowlist，新增必需 job 需先验证真实产出再切换 Ruleset。

门禁反例：`scripts/check-deps.mjs` 内置错误导入自测；`scripts/m0-report.test.mjs` 检查报告对缺项、陈旧指纹、失败包和性能的拒绝。失败必须非零。报告只核对原型证据，不自动计算里程碑退出。
