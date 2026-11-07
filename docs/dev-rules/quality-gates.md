# 验证与质量门禁

按变更风险选择最小充分检查。已通过后只有新改动、失败或未解决风险才扩大/重复验证。不能为了形式给错字修复增加应用测试，也不能以文档检查代替迁移或运行验证。

## 1. 当前可以执行的检查

前置条件：Git 与 Node.js 24 或更新版本；CI 使用 `.node-version`（Node.js 24.19.0）。从仓库根：

```powershell
pnpm install
node scripts/verify.mjs
```

`verify.mjs` 是本地与 CI 共用的统一入口，依次检查：`scripts/` 顶层 MJS 语法；文档登记表与 GitHub 配置 JSON；文档结构（`check-docs.mjs`）；公开内容检查及其反例；文档检查与阶段报告门禁的反例自测；包依赖方向（`check-deps.mjs`，含内置反例）；根与 `apps/desktop` 两个 `tsc --noEmit`；全部 Vitest；`experiments/m0` 的三份回归（契约 schema、评审回归、收尾评审）；`git diff --check` 与 `git diff --cached --check`。它不安装依赖；缺少 `node_modules` 或 vitest 时非零退出，不使用 `--if-present`。10 MiB TXT 与 30 MiB EPUB 等大文件用例只在 `MANGA_LARGE_FILES=1` 时运行，阶段入口会设置它。需要合成样本、固定 FFmpeg 或语音模型的用例在这些前置缺失时失败；只有声明了 `MANGA_MEDIA_PREREQUISITES=absent` 的环境（CI）才把它们记为跳过，阶段入口会清除这个变量。

开发启动用 `pnpm dev`，自动检查 Electron SQLite ABI 并隔离开发 Profile；目录约定见 [仓库地图](repo-map.md#生成物约定)。人工检查的启动、样本、操作和预期写在[用户待办](../../USER-ACTIONS.md#checks)，写到用户能直接照做，不只引用本页。

### 1.1 公开内容检查

统一入口已包含 `node scripts/check-publication.mjs` 和其回归测试。脚本枚举 Git 已跟踪文件与未忽略的新文件，分别检查工作树与暂存版本，防止清理工作树后仍提交旧敏感内容。它检查个人绝对路径、常见凭据、含凭据 URL 和私有数据文件；报错只显示文件/行号/类别，不回显匹配值。反例测试覆盖暂存泄漏、未跟踪报告及可移植示例。

这是一组有限规则，不是全量密钥或语义识别器。外部工程叙述、设备标识、私密正文、二进制/图片、任意格式的新令牌，以及待推送提交中被后来删除的内容仍需人工/Agent 检查；脚本不扫描 Git 历史。推送前核对最终待推送提交/变更集和公开候选文件名，必要时补查相关历史；失败时修复后再验证。第三方库/官方接口链接与合法许可证声明保留。

报告生成后重新运行公开检查；性能报告只输出平台/架构/版本，不采集具体 CPU/内存标识到公开报告。真实资源根只用于开发者本机的只读试验，证据里只写数量与类别，不写文件名、标题或路径。

### 1.2 文档检查

只检查文档时执行 `node scripts/check-docs.mjs`。根目录按脚本自身位置解析，不依赖机器盘符。返回码 0 表示声明的检查通过，1 表示失败；输出具体文件和原因。修改治理脚本时用 `scripts/check-docs.test.mjs` 的临时夹具验证失败传播，修改 workflow/ruleset 时另外解析配置并核对必需 job 名与 GitHub 返回结果。

| 当前自动覆盖 | 边界 |
| --- | --- |
| 仓库自有 Markdown 与登记表相互覆盖，状态/角色/日期等字段、替代目标合法 | 不识别真实用户审批；不检查第三方依赖和构建输出 |
| 登记表 `currentStage` 与条目 `retireAfter`：当前阶段晚于 `retireAfter` 而文件仍存在则失败 | 阶段顺序固定在脚本中；不判断提炼是否充分，由 A 抽查 |
| Markdown 行内相对链接、引用式定义和本地锚点存在，目标不逃逸仓库 | 不访问网络链接，不充当完整 Markdown/HTML 解析器；不检查代码块内示例路径 |
| CLAUDE 只引用 AGENTS | 不验证所有宿主是否自动加载仓库指令 |
| PRD 需求 ID 唯一、交付矩阵完整且不引用不存在需求/AT、AT/POC 定义唯一 | 不证明测试覆盖深度或需求合理性，不推断阶段子场景已通过 |
| 执行台账完整登记 POC 定义 | 不证明报告里的实际结果真实 |

链接采用仓库相对路径、ATX 标题或显式 HTML `id` 锚点；避免在文件名/链接内使用空格或嵌套括号。复杂 HTML 导航、外部 URL、Mermaid 语义和视觉渲染人工核对。

## 2. 阶段证据入口

每个阶段有一份配置 `scripts/stages/<阶段>.json`（指纹覆盖范围、必需用例、基准目标与规模、包烟测阶段），统一入口为：

```powershell
node scripts/stage.mjs m2 test      # 全部 Vitest + 脚本自测，按必需用例匹配并写 cases.json、test-run.json
node scripts/stage.mjs m2 bench     # 10,000 元数据 / 50,000 检索块的服务与隐藏 Electron 窗口基准，另含 5000 文件后台扫描、封面读取与 1000 条消息右栏
node scripts/stage.mjs m2 package   # Windows 未签名包及其烟测阶段，写 package.json 与 scenarios.json
node scripts/stage.mjs m2 report    # 核对上述结果并写 report.json
```

- 输出默认写到 Git 忽略的 `dist/evidence-runs/<阶段>/<跑次>/`（跑次默认 `current`，`STAGE_RUN` 指定其他）；路径计算正本为 `scripts/desktop-paths.ts`。只把审查需要引用的最终结果复制进 `docs/evidence/<阶段>/`，单阶段入库证据不超过 5 MiB。
- 报告门禁核对源码（`packages`、`apps/desktop`、`experiments/m0` 及清单）、锁文件、测试与样本脚本、构建脚本四类指纹；结果缺失、指纹不一致、必需用例缺项/重复/重分类/未通过、基准指标缺失或超目标、规模不足、打包烟测阶段缺失，一律非零退出。已声明的 blocked / not-run 项必须带负责人和复测入口（`limits.json`）。报告固定 `productAcceptance: "not-run"`，不计算阶段验收。
- 必需用例由测试的完整名称（含 `describe`）用正则匹配到用例编号；改测试名要同步 `scripts/stages/<阶段>.json`。`scripts/stage-report.test.mjs` 用夹具验证缺项、旧指纹、失败基准、被重命名的用例和越权的验收声明都会被拒绝。
- 打包烟测用真实 Windows 包在合成样本和隔离 Profile 上驱动：初次启动/重启、Agent 发送与重启恢复（含运行中与停止态、重启后会话恢复）、阅读→记录→来源→重启恢复、四类格式页（含 LOOP-06：选中时页面只绘制一次且节点仍在文档中）、媒体（漫画与视频样本矩阵）、录音（Chromium 假采集设备播放合成语音）、返工 `rework`（独立的全新 Profile，走过壳与导航、作品主页、右栏聊天窗口、调试面板、设置各页、扫描、手动匹配、快捷任务与三种窗口尺寸（含悬浮胶囊不压住播放器与漫画页的任何控件），每个场景写入 `scenarios.json`，`productAcceptance` 恒为 not-run）；包内缺少随包工具时必须在启动时报错并点名。烟测装置在 `apps/desktop/src/main/smoke/`，只在 `--manga-smoke` 时动态加载，正常启动不加载（`tests/package/smoke-isolation.test.ts`）。
- 合成样本由 `node scripts/samples/generate-media-samples.mjs` 生成到 `dist/samples/m2`（含清单与哈希），不提交；随包工具由 `scripts/tools/fetch-ffmpeg.mjs`、`fetch-silero-vad.mjs` 按锁定版本与哈希下载到 `dist/tools`。
- 返工基准（`scripts/stage/bench-rework.mjs`）：合成 5000 个文件（20 个系列 × 100 + 3000 个零散文件）的后台扫描连续 3 次，门禁要求主进程事件循环延迟 p99 ≤ 100 ms（≥ 1000 个 5 ms 采样）、扫描期间常用操作反馈 p95 ≤ 100 ms（≥ 300 个答复样本），并记录扫描吞吐、200 个封面的图片表读取与句柄冷/热读、1000 条消息的右栏滚动与输入（在打包窗口的 `bench-pane` 阶段测量，页面实际载入 ≥ 1000 条）；原始样本与摘要一致性同样核对。
- 窗口性能指标由实际 Electron 原始样本计算，门禁核对有限非负数、p95 阈值、样本数量及摘要一致性；隐藏窗口计时截至 DOM 可用，不是绘制帧或显示器延迟，也不外推到其他设备。

### 2.1 真实服务与本机资源（默认关闭，不进 CI）

| 开关 | 内容与边界 |
| --- | --- |
| `MANGA_LIVE_BANGUMI=1` | Bangumi 只读契约（含条目、角色与人员端点）：不用凭据，每次不超过 10 个请求，证据只含端点、结果与计数；网络不可达记 blocked（可带 `NODE_USE_ENV_PROXY=1` 与代理） |
| `MANGA_LIVE_ASR=1` | 本地忽略的测试配置里的 ASR 服务：只发送样本生成器的合成 TTS 语音，每次不超过 10 个请求，配置缺失记 not-run；配置值不打印、不写入证据 |
| `MANGA_LIVE_MODELS=1` + `node scripts/live-models.mjs` | LLM/Embedding/ASR 的有限短测，只发送合成内容；视觉/OCR 与 LLM 整理的真实调用未获授权，不运行 |
| `MANGA_REAL_SAMPLE_ROOTS` | 开发者自己资源根的只读打开试验；不复制、不写入源目录，摘要只含数量与类别 |

这些结果只证明被测接口当时的形状与协议，不代表服务的长期可用或产品验收。

### 2.2 M0 回归

`experiments/m0` 保留 POC-09 等尚未被产品替代的回归，退出条件见[仓库地图](repo-map.md)。`node scripts/m0.mjs fixtures|typecheck|test` 运行全部原型测试，`verify.mjs` 只运行其中三份。需要系统 FFmpeg（含 libx264/libx265）的 MKV/HEVC 用例在缺少时记为跳过，不记为通过。

## 3. 应用与工程门禁

正式工程的测试工具按 [ADR-0007](../decisions/0007-technology-stack.md) 采用 Vitest、Testing Library/jsdom 和对应浏览器烟测的 playwright-core。jsdom 测试用文件头 `/** @vitest-environment jsdom */`，共享设置在 `tests/helpers/`；jsdom 和浏览器烟测不替代 Electron 原生输入法与设备实测。

产品 AT 仍按阶段执行，不能用 POC 子集标为 passed。

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

## 4. 证据与失败处理

按 [报告模板](../templates/validation-report.md)记录输入、版本、环境、实际结果和限制，更新 [执行状态](../delivery/status.md)。检查基础设施变化至少验证能检出一个真实反例，避免脚本永远返回成功。

已合并阶段的过程证据按[阶段收尾清理](../governance/documentation-policy.md#stage-cleanup)在下一阶段提炼进 `docs/evidence/<阶段>-summary.md` 并删除，Git 历史是归档。

环境失败、业务失败和未执行分别报告。不能删测试、弱化断言、重写旧结果或改验收目标来制造通过；合理需求调整由有效决定驱动并同步正本。模型、网络和设备的非确定性场景使用可控故障夹具验证协议，有限真实测试验证实际适配。

## 5. CI 接线与扩展

`.github/workflows/ci.yml` 在面向 main 的 PR 更新及手动触发时运行统一入口，必需状态名称为 `repository-quality`。不设置路径过滤、main push 重复检查或定时全量扫描；触发、权限、Ruleset 与失败处理见 [Git 与 GitHub](git-and-github.md)，实际远端结果以对应 PR 为准。

当前 CI 安装锁定依赖并运行 `verify.mjs`。Windows 包、完整阶段测试与性能走阶段入口，不纳入无 Windows 桌面的 CI；CI 以 `MANGA_MEDIA_PREREQUISITES=absent` 运行，需要合成样本、固定 FFmpeg 或语音模型的用例（M2 时约 140 个）在 CI 记为跳过，由本地 `verify.mjs` 与 `stage <阶段> test` 覆盖（`tests/helpers/prerequisites.ts`）；真实服务与设备项不进 CI。人工评审仍负责语义和证据质量。不把 CI 成功当作阶段退出或产品发布验证。新增 Actions 需同时更新远端 allowlist，新增必需 job 需先验证真实产出再切换 Ruleset。

门禁反例：`scripts/check-deps.mjs` 内置错误导入自测（含越出包目录的相对导入必须报错、包内相对导入必须通过）；`scripts/stage-report.test.mjs` 检查报告对缺项、陈旧指纹、失败包和性能的拒绝；`scripts/check-docs.test.mjs` 检查过期文档与登记缺口会被拒绝。失败必须非零。
