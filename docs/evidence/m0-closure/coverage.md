# M0 收尾覆盖台账

> 历史交付记录：本页保留 Cursor 当时的覆盖与结论；后续发现、修复和准确边界见[最终复核](../2026-09-19-m0-closure-review.md)。当前一致证据在 `../m0-final-review/`。本目录的 `format-matrix.json` 曾由复核中间运行更新，不是全文件统一源码快照。

> 公开整理说明（2026-09-19）：设备标识与本机专属信息已脱敏；测试数据、状态和当时结论保留，未重新执行实验。文中的旧待决范围仅代表报告时点，当前决定见 [确认记录](../../decisions/confirmed-decisions.md)。

| 字段 | 内容 |
| --- | --- |
| 报告 ID / 日期 | EV-20260919-m0-closure-coverage |
| 源码范围 | `packages/`、`experiments/`、`scripts/`；机器指纹见同目录 `summary.json` |
| 旧报告 | `docs/evidence/m0/`、`docs/evidence/m0-review/` 保留为历史，不覆盖 |

本表区分：函数级自动断言、Electron 界面链路、真实设备、未执行。POC 子集通过不能把 AT-01—48 标为 passed。

## R0—R7

| 包 | 必需场景 | 入口 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| R0 | 现场 dirty tree、verify、覆盖表 | `git status`；`node scripts/verify.mjs` | 本文件；`summary.json` | 已执行 |
| R1 | 无时长 WebM 索引且不覆盖原件；保存幂等；独立播放器；显式导出 | Node `closure-r1-playback.test.ts`；包烟测 `smoke.cjs` | `poc-02-r1.json`；`package.json` | 自动 passed；修复后构建的听感确认仍为可选人工 |
| R2 | 长章全文、DOM 选区锚点、块分拆/合并/循环嵌入 | Node `closure-r2-r6.test.ts`；烟测选区 | `poc-01-r2.json`；`smoke-initial.json` | 自动 passed；IME 沿用用户已通过证据 |
| R3 | 采样时钟不含权限等待；暂停/倍速/seek；ASR 夹具；联合测试入口 | Node `closure-r3-capture.test.ts`；窗口「开始联合测试」 | `poc-02-r3.json`；`poc-02.json` | 自动/模拟 passed；硬件偏移/耳机/串音 not-run |
| R4 | 探测/拒绝矩阵；copy 切实际时长；图像预算；Electron 播放 | `review-formats.test.ts`；`closure-r2-r6`；包内加载样本 | `format-matrix.json`；`poc-03-r4.json`；`media-electron.json` | 探测与 Node 输出 passed；Electron 播放以 package 结果为准 |
| R5 | worker 取消/退出；UI/Agent 同命令；停用丢弃晚到；阅读器/换源/下载停用保留数据 | `closure-r2-r6`；`poc-04`；`poc-07`；`poc-09` | 各 POC JSON | 自动 passed；非第三方沙箱 |
| R6 | 显式确认关联；资料包往返；缺提供者仍可读；非空拒绝重复导入 | `closure-r2-r6`；窗口导出/导入资料包 | `poc-08` 与 `poc-03-r4` 旁的 R6 用例 | 自动 passed |
| R7 | 需求 6.2 测量、门禁、审查包、ADR 建议、退出判断 | `m0.mjs bench/report`；`verify-m0.mjs` | `bench.json`；`summary.json` | 测量后填写；ADR 保持 proposed |

## 人工证据（有版本限制）

| 子项 | 状态 | 边界 |
| --- | --- | --- |
| 中文输入法、美式键盘 | passed，用户报告 | 针对修复前 textarea 原型；未换编辑器故沿用 |
| 100%/125%/150% 缩放 | passed，用户报告 | 未提供逐档窗口尺寸 |
| 外接麦克风 录音/保存/基础回放 | passed，用户报告 | 不覆盖进度条缺陷；缺陷已在本轮自动修复 |
| 回放进度 / 三点菜单 | 原 failed；本轮改为自定义进度与「导出录音」 | 建议在新独立包上做一次可选确认 |
| 耳机/串音/拔插/系统权限框 | not-run | 窗口已有错误路径与联合测试入口 |
| 硬件采样/声学偏移 | not-run | 不得把软件时钟标成硬件校准 |

## 重跑

```powershell
$env:M0_VOL_A = "<authorized-volume-a>"
$env:M0_VOL_B = "<authorized-volume-b>"
node scripts/verify.mjs
node scripts/verify-m0.mjs
node scripts/m0.mjs package
node scripts/m0.mjs bench
node scripts/m0.mjs report
./scripts/open-m0-package.ps1
```
