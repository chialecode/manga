# 架构不变量

> 触发：修改 package 依赖方向、`packages/domain` 的纯度、进程拓扑，或新增 utility / child 进程前。
> 设计依据见 [`docs/architecture.md`](../architecture.md) §3、§4。

## 1. 依赖方向（CI 强制）

```
features ──► ui
    │
    ▼
  rpc(client) ──► contract ──► domain
                      ▲            ▲
  rpc(host) ──────────┘            │
    ├──► data ───────────────────► │
    ├──► epub ──► zip ───────────► │
    ├──► comic ──► zip ──────────► │
    ├──► media ─────────────────► │
    ├──► player ──► media ──────► │
    ├──► subtitle ──────────────► │
    ├──► ai ────────────────────► │
    └──► providers ─────────────► │
```

**四条铁律**，由 `scripts/__tests__/module-boundary.test.mjs` 解析 import 图断言：

1. **`domain` 不 import 任何包，也不 import 任何 Node 或 DOM API。** 它必须能在 Node、浏览器、Worker 中原样运行，且单元测试不需要任何 mock。
2. **`contract` 只 import `domain` 与 `zod`。**
3. **UI 侧（`ui`、`features`、`rpc/client`）不 import 任何主机侧包**（`data`、`media`、`epub`、`zip`、`comic`、`player`、`ai`、`providers`）。
4. **传输实现隔离在 `packages/rpc/src/transport/electron.ts` 单文件。** 其他任何位置不得 import `electron`。

第 4 条是容器可替换性的全部保障。破坏它等于放弃更换桌面容器的能力。

## 2. domain 的纯度

`packages/domain` 中禁止出现：

- 任何 `import ... from 'node:*'`
- 任何 DOM 全局（`document`、`window`、`navigator`、`fetch`）
- `Date.now()`、`Math.random()`、`process.*`

需要时间或随机数时，从参数传入。这不是洁癖：`domain` 承载锚点失效判定、指纹算法、排序规则、播放决策矩阵——这些必须能被确定性地重放和测试。

## 3. 进程拓扑

常驻进程固定为五个：`main`、`renderer`、`GPU`、`svc-db`、`svc-scan`。按需进程：媒体、下载、AI，空闲 30 秒后回收。

**新增常驻进程需要 ADR。** 每个进程都计入内存预算（架构正本 §2 的 N4）。

| 进程 | 唯一职责 | 禁止 |
|---|---|---|
| `main` | 特权能力、窗口、协议、调度、监督、网关、RPC 路由 | 承载业务算法；执行耗时同步操作 |
| `renderer` | 界面与交互 | 任何特权能力（见 electron-security 规则） |
| `svc-db` | 数据库读写 | 网络访问；拉起子进程 |
| `svc-scan` | 文件遍历、指纹、缩略图 | 直接写数据库（走 RPC 提交） |
| 媒体 child | FFmpeg 调用 | 网络访问；持有密钥 |

**数据库只有 `svc-db` 持有写连接。** 其他进程一律通过 RPC 提交写操作。

## 4. 子进程管理

全部子进程必须经 `apps/desktop/src/main/supervisor` 拉起，禁止在其他位置 import `node:child_process`（由 `no-direct-spawn` 闸门断言）。

Supervisor 保证：

- 子进程加入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Windows Job Object，主进程异常退出时由内核回收，杜绝孤儿进程。
- 心跳 5 秒一次，15 秒无心跳判定挂起并 kill。
- 退避重启 1s / 2s / 4s，连续 3 次失败进入熔断并向界面报告。
- `env` 显式构造，不继承任何密钥。

## 5. 第三方类型不跨包

被准入的第三方库，其类型只允许出现在直接包装它的 package 内。例如 `pdfjs-dist` 的类型不得出现在 `domain`、`contract` 或 `features`。跨包传递时转换为本仓自有类型。

## 6. 修改本文件

依赖方向与进程拓扑的任何变更都需要 ADR，并同步更新 `module-boundary.test.mjs` 的断言。**先改断言，再改代码**——否则闸门会在你不知情时被削弱。
