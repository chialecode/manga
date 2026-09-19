# M0 收尾审查摘要

> 历史交付记录：本页保留 Cursor 当时的覆盖与结论；后续发现、修复和准确边界见[最终复核](../2026-09-19-m0-closure-review.md)。当前一致证据在 `../m0-final-review/`。本目录的 `format-matrix.json` 曾由复核中间运行更新，不是全文件统一源码快照。

> 公开整理说明（2026-09-19）：设备标识与本机专属信息已脱敏；测试数据、状态和当时结论保留，未重新执行实验。文中的旧待决范围仅代表报告时点，当前决定见 [确认记录](../../decisions/confirmed-decisions.md)。

| 字段 | 内容 |
| --- | --- |
| 报告 ID / 日期 | EV-20260919-m0-closure-summary |
| 分支 / HEAD | `feat/m0-tech-contract-validation` / `a0b97796e193b1c3aa4fb62426550bb6c4c1a381`（工作区有未提交收尾改动） |
| 源码指纹 | `eb126a5981c913b5f836213c401a629a84f51a397ae41582712c0af81d2edc07`（`packages/`、`experiments/`、`scripts/` 等，见 `summary.json`） |
| 参考机 | Windows 11；脱敏参考环境；Node 24.19.0；Electron 37.4.0 |
| 历史 | `docs/evidence/m0/` 与 `docs/evidence/m0-review/` 不覆盖 |

## 判断

| 问题 | 结论 |
| --- | --- |
| 可执行工程是否完成、可否交审 | **是**。R1—R6 可自动工作已实施并验证，R7 测量/门禁/文档/具体 ADR 建议齐全。剩余项只有明确物理操作或正式决定。 |
| M0 是否满足退出 | **否**。ADR-0003—0006 仍为 proposed；Q-02/Q-03/Q-04 未定稿；耳机/串音/拔插/硬件采样偏移 not-run。 |
| M1 是否满足进入 | **否**。M0 未退出；M1 范围锁定（Q-01）仍开放。POC 自动通过不是 AT-01—48 产品验收。 |

## 重跑

跨卷测试使用会话已授权的 `M0_VOL_A` / `M0_VOL_B`，只新建唯一子目录。

```powershell
node scripts/verify.mjs
node scripts/verify-m0.mjs
node scripts/m0.mjs package
node scripts/m0.mjs bench
node scripts/m0.mjs report
./scripts/open-m0-package.ps1
```

独立包：`dist/latest-package.json` 指向本次解包目录中的 `MANGA-M0.exe`（未签名）。

## 本轮优先修复（已自动验证）

- 无时长 WebM：索引派生 `.playback.webm`，不覆盖原件；烟测首次拖动时长有限。
- 播放器独立 dock：笔记自动保存不再 `replaceChildren` 掉正在播放的元素。
- 稳定「导出录音」：主进程校验附件、取消不报成功；烟测含成功与取消。
- 保存重试：同一 idempotency key 不产生第二条录音。
- Electron：H.264/AAC 实际播放；HEVC 解码拒绝；权限拒绝路径有 UI 错误。

## 需求 6.2（本机，目标未降低）

| 项目 | 目标 | 实测 |
| --- | --- | --- |
| 输入状态 p95 | ≤ 100 ms | 0.20 ms（n=100，不含合成器） |
| 轻量上下文 p95 | ≤ 150 ms | 36.4 ms（n=30） |
| 全文搜索 p95 | ≤ 500 ms | 0.11 ms（n=100；1e4 资源 / 5e4 块） |
| 进程启动 max | ≤ 5 s | 464 ms（n=30） |
| 10 MiB TXT 首屏 p95 | ≤ 2 s | 35.8 ms 服务 + 107 ms UI 一次渲染 8000 字 |
| 录音状态 | ≤ 300 ms | 71.6 ms（fake device，n=1） |
| 自动保存 | ≤ 1 s | 830 ms（n=1，含 400 ms 防抖） |
| 进度写入 p95 | ≤ 2 s | 2.0 ms（n=30） |

未生成 30 MiB EPUB 样本；合成 EPUB 1615 字节上的 getResource p95 为 0.77 ms，不能外推 30 MiB。

## 集中决定清单（请一次确认；现为 proposed）

1. 编辑：原生 textarea + 自研块命令（[ADR-0003](../../decisions/0003-m0-ui-editing.md)）。
2. 存储：`node:sqlite` WAL + 文件锁；目录 `%LOCALAPPDATA%/MANGA`，`MANGA_PROFILE_DIR` 覆盖，便携标记旁 `data/`（[ADR-0004](../../decisions/0004-m0-storage-host.md)）。
3. 运行时：只保留自研 kernel（[ADR-0005](../../decisions/0005-m0-composition-runtime.md)）。MinimalActivator 只是门禁反例。
4. 媒体：H.264/AAC MP4、外置 SRT/VTT 文件、PNG/JPEG CBZ 预算内；HEVC/ASS 不作为首轮支持（[ADR-0006](../../decisions/0006-m0-media-and-performance.md)）。
5. 性能：维持需求 6.2；参考机即当前 Windows 11 电脑。

## 必要人工

见 [检查单](../2026-09-19-m0-human-checklist.md)。已通过的输入法/缩放/基础录音不重测。可选：新包上短体验进度条与导出。仍缺：耳机对照、外放串音、系统权限框、拔插、硬件偏移。

## 已知限制

- 未签名、非安装程序；FFmpeg 来自系统 PATH，再分发涉及 GPL。
- 可信进程边界不是第三方安全沙箱。
- 真实 ASR、真实站点、完整阅读器/漫画/粗剪产品不在本轮。
- AT-01—48 仍为 not-run。
