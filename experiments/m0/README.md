# M0 验证工程

这是 MANGA 的 **M0 技术与契约验证**实验工程，不是产品发行目录。仅保留回归：POC-09（获取）尚未被产品替代，**退出条件：M4 获取替代 POC-09 后删除本目录**。POC-02（采集映射与 ASR 夹具）、POC-08（假提供者元数据）的用例已在 M2 由产品测试替代并移除（映射见 [M2 交付报告](../../docs/evidence/m2-media-mvp-delivery.md)）；原型宿主里服务这些用例的代码因仍被 POC-04/06/07 使用而保留到整体删除。POC-03 的 MKV/HEVC/ASS 用例需要带 libx264/libx265 的系统 FFmpeg，缺少时记为跳过而不是通过。候选实现可替换；正式选型见 proposed ADR，不能把本目录当作已定稿生产架构。

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

## 命令

在仓库根、已执行 `pnpm install` 后：

```powershell
node scripts/m0.mjs fixtures
node scripts/m0.mjs typecheck
node scripts/m0.mjs test
node scripts/verify.mjs
```

数据目录默认使用进程临时目录下的 `manga-m0/`，不写入用户资料库。环境变量 `MANGA_M0_DIR` 可改隔离根。测试输出写入 `dist/evidence-runs/m0/`。

## 依赖候选

实验锁定见根 `pnpm-lock.yaml`：pnpm workspace、TypeScript 7、zod、fflate、parse5、Node 24 `node:sqlite`。本工程不含 Electron。
