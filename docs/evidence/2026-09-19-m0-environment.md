# M0 环境与工具预检

> 公开整理说明（2026-09-19）：设备标识与本机专属信息已脱敏；测试数据、状态和当时结论保留，未重新执行实验。文中的旧待决范围仅代表报告时点，当前决定见 [确认记录](../decisions/confirmed-decisions.md)。

> 历史记录：以下保留 Cursor 原交付时的结果与判断。复核发现部分通过结论证据不足，当前状态、修复和补测以 [后续复核报告](2026-09-19-m0-followup-review.md) 为准；旧基准设备要求已撤销。

| 字段 | 内容 |
| --- | --- |
| 报告 ID / 日期 / 执行者 | EV-20260919-m0-environment；实施 Agent |
| 关联 | T00；POC-01—09 |
| 被测版本 | 任务分支 `feat/m0-tech-contract-validation`；相对 HEAD `a0b97796e193b1c3aa4fb62426550bb6c4c1a381` 的未提交工作树 |
| 环境 | Windows 11 x64 build 26200；Node 24.19.0；pnpm 11.24.0；Git 2.55.0.windows.5；FFmpeg/FFprobe 9.0.1；SQLite 3.53.3 via `node:sqlite` |
| 样本 | 合成样本，生成器 `experiments/m0/src/fixtures/generate.ts` |
| 结论 | 可开始并已执行自动化 M0；人工设备/基准机/打包仍 not-run |

## 步骤与结果

| 用例 / 命令 | 前提与操作 | 预期 | 实际 | 状态 / 证据 |
| --- | --- | --- | --- | --- |
| 工具探测 | 运行 `node scripts/m0.mjs doctor` | 记录已证实与未核查 | Node 24.19.0、pnpm 11.24.0、ffmpeg/ffprobe 9.0.1、`node:sqlite` 可用；本机未见 `cl`/`cmake`；Electron 未装入根依赖。Windows 上 `--version` 非零退出仍计为已发现 | passed |
| 依赖安装 | `pnpm install` | 锁文件安装成功 | 根 workspace 安装成功；tsx/esbuild 因 pnpm build 审批未采用，改用 Node 类型剥离 | passed |
| 反例门禁 | `node scripts/check-deps.mjs` 内置自测 | 领域导入 electron 非零 | 自测捕获 electron 导入；正式树 0 错误 | passed |

## 限制与决定

硬件明细和本机盘符已脱敏；当时结果不能证明旧基准。可见多个卷不等于完成实际跨卷实验。音频设备存在（耳机/麦），未经本任务人工朗读。
