# 开发规则索引

`docs/dev-rules/` 下的全部文档状态均为 `authoritative`，对代码有约束力。触发条件见根 `AGENTS.md` 的「当前规则索引」。

| 文档 | 何时必须读 |
|---|---|
| [dependency-admission.md](./dependency-admission.md) | 引入任何新的第三方依赖前 |
| [repo-map.md](./repo-map.md) | 首次接触本仓、判断新代码归属 package 时 |
| [environment-setup.md](./environment-setup.md) | 首次安装、修复依赖、更新 `vendor-bin`、准备新 worktree 时 |
| [architecture-invariants.md](./architecture-invariants.md) | 修改依赖方向、`domain` 纯度、进程拓扑前 |
| [electron-security-and-process-boundaries.md](./electron-security-and-process-boundaries.md) | 修改 Renderer、preload、CSP、协议、Fuses、路径解析前 |
| [ipc-contract.md](./ipc-contract.md) | 新增或修改 RPC 方法、流式、取消、背压、错误模型前 |
| [database-and-migrations.md](./database-and-migrations.md) | 修改 schema、migration、FTS、备份恢复或运行期访问前 |
| [engineering-conventions.md](./engineering-conventions.md) | 修改日志、错误处理、时间单位、UI 文案与 i18n 前 |
| [testing-and-gates.md](./testing-and-gates.md) | 新增或修改测试、CI 闸门前 |

设计依据与完整规格见架构正本 [`docs/architecture.md`](../architecture.md)。本目录只写「改动时必须遵守什么」，不重复架构论证。
