# M0 阶段总结

| 字段 | 内容 |
| --- | --- |
| 阶段 | M0：技术与契约验证（含 2026-09-19 的文档框架与 GitHub 建立） |
| 合并 | [PR #1](https://github.com/chialecode/manga/pull/1)，`main` @ `dc925e9`；文档治理基线 `4f9306a` |
| 归档 | 过程文档、复核报告和轮次证据留在合并提交中：`https://github.com/chialecode/manga/tree/dc925e9/docs/evidence`、`.../docs/delivery`。工作树不再保留副本 |
| 整理 | M2 的 C1/C2（A-45）。提炼时状态不升不降：下表的 passed 只限定被测版本与合成子集，blocked / not-run 原样保留 |
| 结论 | M0 的自动化验证与原型已交付并经复核；它们不是产品验收。AT-01—48 在 M0 时均未执行，后续阶段按各自范围记录 |

## 1. 做了什么

1. **文档框架与 GitHub 建立（2026-09-19）。** 建立根入口、文档分层、规则、决定与事项台账、模板和文档检查（`scripts/check-docs.mjs`，11 种故障样本全部被检出）；本地优先的 Git 历史、DCO、Ruleset、一次真实 CI 运行（`repository-quality` success）、仓库开关与 Actions 权限读回均已核对。GitBook 只准备配置，未连接。当时的结构检查、链接数和摘要不代表后续快照；当前入口见 [文档导航](../README.md) 与 [Git 与 GitHub](../dev-rules/git-and-github.md)。
2. **M0 原型。** pnpm workspace、公开契约、自研 kernel、SQLite 存储、九项 POC 的合成场景测试（`experiments/m0`）和一个人工检查窗口（`experiments/m0-desktop`，已在 M2 删除）。
3. **复核与收尾。** Cursor 的原交付经 Codex 复核后发现“自动化工作全部完成”的结论不成立（保存只创建不恢复、录音控件缺失、打包入口未实现、跨卷用例只比较盘符），逐项修复；随后按收尾计划 R0—R7 补齐 Electron 实际播放、真实跨卷、独立打包、性能口径和报告门禁，并做最终复核。

## 2. POC 结论（最终复核时点）

| 编号 | 结论 | 限制与去向 |
| --- | --- | --- |
| POC-01 文本/EPUB 定位 | 合成范围 passed：UTF-8 BOM、中日文/emoji/ZWJ 按码点锚定，重复句进入 `needs_review`，拒绝路径穿越与超大条目 | 非 UTF-8 实档、复杂 CFI 未测；M1b 起由 `tests/reading`、`tests/notes` 守护 |
| POC-02 采集与来源映射 | 映射与 ASR 协议夹具 passed；声学/设备人工项 not-run，POC-02 整体 blocked | 录音已并入 M2（R1—R4），设备项见[用户待办](../../USER-ACTIONS.md#checks)的 H-M2-06；产品用例替代后从 `experiments/m0` 移除 |
| POC-03 媒体边界 | 合成 MP4 H.264/AAC 探测、copy 切、Electron 实际播放 passed；HEVC 在当时 Electron 上解码被拒（记录为 rejected，不是支持通过）；MKV/HEVC/ASS/VFR 只测探测 | M2 重新按“容器 × 编码 × 音频 × 字幕 × 播放路径”验证，现行结论见[视频模块](../modules/video.md) |
| POC-04 生命周期 | 原型 passed：UI/Agent 同命令、幂等、50 次启停、旧 epoch 拒绝、Node 子进程 IPC | 非第三方插件沙箱；产品内由 kernel 与 `tests/runtime` 继续验证 |
| POC-05 编辑 | 编辑基础 passed；真实输入法于 2026-09-19 由用户报告通过（见第 4 节） | 新编辑器在 M1b 重建并复测 |
| POC-06 存储与恢复 | 单写入、CJK 检索、崩溃边界、未知载荷备份往返 passed；打包冒烟随后补测通过 | 生产存储改为 better-sqlite3 + Drizzle（ADR-0007） |
| POC-07 组合运行时 | 自研 kernel 通过硬门槛，不释放资源的 naive 实现被淘汰；ADR-0005 于 2026-09-20 accepted | — |
| POC-08 元数据 | 假提供者契约 passed（歧义→待确认、用户锁定优先、停用后覆盖仍在）；不证明真实站点 | M2 P5 用产品测试和 Bangumi 契约测试替代，`experiments/m0` 中对应用例同步移除 |
| POC-09 获取与恢复 | 幂等入库、不覆盖、私网重定向、配额与注入磁盘不足 passed；用户授权的两个真实卷上双向跨卷 passed；未验证 BT | M4 获取替代后删除（见[仓库地图](../dev-rules/repo-map.md)的退出条件） |

## 3. 复核中修复的问题（摘要）

请求旧修订时返回当前正文、emoji 选区与跨资源定位混淆；拆块更新覆盖其他块；资料包信任不完整行与附件路径并可能越界；解析 worker 停用后无法重新启用；同提供者重新确认元数据时旧链接处理不正确；WebM 缺有限时长导致进度不可靠、三点菜单不稳定；报告门禁可遗漏必需项或混用旧指纹。修复均有先失败后通过的回归，现位于 `experiments/m0` 的回归文件或产品测试中。当时遗留的已知限制：资料包“发布后、提交前进程退出”和位置迁移的恢复（后由 M1a 的 F-24—F-25 关闭）、文件发布后事务前退出可能留下未关联附件。

## 4. 支持矩阵（M0 最终版，仅对已测组合有效）

| 范围 | 已测结论 |
| --- | --- |
| 文本/EPUB | UTF-8(+BOM) TXT、中日文/emoji、重复句、基础多章 EPUB 已验证；非法路径/超大条目拒绝；复杂 CSS/加密/音频 EPUB 未验证 |
| 漫画图像 | 目录 PNG/CBZ 数字排序（非连续编号、重复名）、长图分类、超预算拒绝；当时没有阅读器 |
| 视频 | MP4 H.264+AAC 探测与 Electron 播放通过；外置 SRT/VTT 存在；HEVC copy 切与 Electron 解码被拒；MKV HEVC+ASS、分数帧率、VFR、非零起始只做探测 |
| 录音回放 | MediaRecorder WebM：桌面转临时 PCM/WAV 回放，seek/重启/导出通过；64 MiB PCM 上限，长录音方案留给 M1b/M2 |
| 性能 | 当前 Windows 11 参考机：检索 p95 0.08 ms（10,000 资源/50,000 块）、输入状态 p95 0.2 ms、新进程启动 p95 469 ms、保存 414 ms（单样本）、上下文 p95 15.9 ms；均达需求 6.2，不外推到其他设备，也不代表显示合成延迟 |

用户 2026-09-19 撤销旧 4 核/16 GiB 基准，改以当前 Windows 11 电脑作首轮参考机并保留响应目标（需求 6.2、A-14）。

## 5. 人工清单与实机反馈（2026-09-19，当时版本）

| 项 | 结果与边界 |
| --- | --- |
| 中文输入法、美式键盘、100%/125%/150% 缩放 | 用户报告 passed；用于 M0 原型的 textarea 编辑，不继承到新编辑器 |
| 外接麦克风 + 扬声器外放录音、保存、回放 | 用户报告基础路径可用 |
| 回放进度显示 | 用户报告间歇异常 → failed。诊断：WebM 缺有限时长（`duration = Infinity`）、列表重建替换播放器、Blob URL 未释放；已由收尾 R1 修复并以独立包实测 |
| 原生三点菜单 | 不稳定 → 提供独立“导出录音”入口 |
| 耳机对照、外放误收录、权限拒绝、设备断开、硬件采样偏移、暂停/倍速/跳转误差 | not-run；转入 M2 R1—R4 与[用户待办](../../USER-ACTIONS.md#checks)的 H-M2-06 |

## 6. 遗留事项去向

| 事项 | 现在由谁承接 |
| --- | --- |
| Q-02/Q-03 技术选型 | ADR-0004/0005/0007 已 accepted（2026-09-20）；开放问题见[用户待办](../../USER-ACTIONS.md) |
| 视频/漫画目标格式与 HEVC 后端 | M2（本阶段） |
| 真实麦克风、耳机/外放、设备断开 | [用户待办](../../USER-ACTIONS.md#checks)的 H-M2-06 |
| 获取/BT、第三方执行隔离 | M4（Q-06） |
| AT-01—48 产品验收 | 各阶段按版本和子集记录，不用 POC 子集标整条 passed |

## 7. 清理记录（M2 的 C0—C5）

| 项 | 内容 |
| --- | --- |
| 已删除的文档 | `docs/delivery/m0-execution-plan.md`、`m0-cursor-prompt.md`、`m0-closure-plan.md`、`m0-closure-cursor-prompt.md`；`docs/evidence/2026-09-19-*.md`（21 份：文档框架、文档整理、GitHub 建立、M0 环境、POC-01—09、M0 汇总/审查摘要/支持矩阵/人工清单/实机反馈/复核/收尾复核）；`docs/design/modules/`（M0 验证模块规格：内容已由[组合设计](../design/composable-ai-native-architecture.md)、`docs/modules/` 和[仓库地图](../dev-rules/repo-map.md)中 `experiments/m0` 的说明覆盖） |
| 已删除的证据目录 | `docs/evidence/m0`、`m0-closure`、`m0-cursor-original`、`m0-review`、`m0-final-review`（JSON、截图、旧包记录；数值已写入上文） |
| 已删除的代码与脚本 | `experiments/m0-desktop`（人工窗口原型，录音人工项改在产品中进行）；`scripts/bench-m0.mjs`、`package-m0.mjs`、`verify-m0.mjs`、`m0-report*.mjs`、`m0-required-cases.json`、`open-m0-package.ps1`（由通用的 `scripts/stage.mjs` 与 `scripts/verify.mjs` 取代，迁移映射见 [M1b 总结](m1b-summary.md#迁移映射)） |
| 保留 | `experiments/m0`（`verify.mjs` 继续运行其回归，POC-09 未被产品替代）与 `scripts/m0.mjs` |
| 提炼去向 | 决定与许可 → 确认记录/ADR；验收定义 → 路线；未完成项 → 事项总表；支持矩阵与性能 → 上文；Git/GitHub 建立 → [Git 与 GitHub](../dev-rules/git-and-github.md) |
| 归档提交 | `dc925e9`（`git merge-base --is-ancestor dc925e9 origin/main` 为真） |
