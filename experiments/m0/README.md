# M0 验证工程

这是 MANGA 的 **M0 技术与契约验证**实验工程，不是产品发行目录。候选实现可替换；正式选型见 proposed ADR，不能把本目录当作已定稿生产架构。

## 布局

| 路径 | 职责 |
| --- | --- |
| `packages/contracts` | 命令封装、错误码、定位、模块清单等公开契约 |
| `packages/plugin-sdk` | 模块 `activate/deactivate` 与资源登记 |
| `packages/kernel` | 自研组合运行时、计划器、命令网关、提交租约 |
| `packages/storage-sqlite` | `node:sqlite` 单写入、FTS n-gram、备份、崩溃回放 |
| `experiments/m0/src/domain` | 只依赖公开契约的定位/EPUB/笔记/采集/媒体/元数据/获取 |
| `experiments/m0/src/application` | 验证用应用服务与命令实现 |
| `experiments/m0/src/hosts` | 无 Electron 的 Node IPC 宿主 |
| `experiments/m0-desktop` | Electron 人工检查窗口（`m0 desktop` 会单独安装 electron） |

## 命令

在仓库根、已执行 `pnpm install` 后：

```powershell
node scripts/m0.mjs doctor
node scripts/m0.mjs fixtures
node scripts/m0.mjs typecheck
node scripts/m0.mjs test
node scripts/verify-m0.mjs
node scripts/verify.mjs
node scripts/m0.mjs bench    # 本机性能子集及原始数据
node scripts/m0.mjs package  # Windows 独立解包原型与两次启动验证
```

数据目录默认使用进程临时目录下的 `manga-m0/`，不写入用户资料库。环境变量 `MANGA_M0_DIR` 可改隔离根。真实跨卷测试需要 `M0_VOL_A` 与 `M0_VOL_B`。

## 依赖候选

实验锁定见根 `pnpm-lock.yaml`：pnpm workspace、TypeScript 5.9、zod 3.25、fflate、parse5、Node 24 `node:sqlite`。Electron 与 electron-builder 不进入根生产/CI 依赖。
