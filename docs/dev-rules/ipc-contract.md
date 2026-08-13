# IPC 契约

> 触发：新增或修改 RPC 方法、流式通道、取消语义、背压策略或错误模型前。
> 设计依据见 [`docs/architecture.md`](../architecture.md) §5。

## 1. 两条硬性约束

- **无 zod schema 的方法不得注册。** `RpcRouter` 只接受由 `method()` 构造的定义，`ipc-contract` 闸门断言每个已注册方法都有 input/output schema。
- **契约中不得存在返回明文密钥的字段。** 闸门扫描 output schema 的字段名，命中 `apiKey`、`token`、`secret`、`password`、`credential` 等模式即失败。密钥只能写入和使用，不能读出。

## 2. 定义方法

方法名与 schema 只有一处定义，客户端与主机端共同 import：

```ts
// packages/contract/library.ts
export const listWorks = method({
  name: 'library.listWorks',
  input: z.object({
    kind: z.enum(['novel', 'manga', 'anime']).optional(),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).default(60),
  }),
  output: z.object({
    items: z.array(WorkSummary),
    nextCursor: z.number().int().nullable(),
  }),
})

export const scanRoot = method({
  name: 'library.scanRoot',
  input: z.object({ rootId: z.number().int() }),
  stream: ScanProgress,        // 存在 stream 字段即为流式方法
  output: z.object({ scanned: z.number().int(), changed: z.number().int() }),
})
```

命名：`<域>.<动作>`，域与 package 对应（`library`、`reader`、`player`、`anchor`、`ai`、`provider`、`task`）。

## 3. 双向校验

主进程**假定所有来自渲染进程的数据是攻击载荷**。入参在路由层 `schema.parse()`，不信任 TypeScript 类型。

出参同样校验：防止主机端因为 bug 把内部字段（路径、密钥、内部 id）泄漏给渲染进程。出参校验在开发与测试构建中始终开启，生产构建中对高频只读方法可跳过——**但对任何涉及凭证、路径、审计的方法永不跳过**。

## 4. 传输选择

| 场景 | 通道 |
|---|---|
| 请求-响应 | `ipcRenderer.invoke` → `ipcMain.handle` |
| 流式、大数据 | `MessageChannelMain` 专用 `MessagePort` |
| 二进制载荷 | `ArrayBuffer` 作为 transferable，零拷贝 |

帧格式：

```ts
type Frame =
  | { t: 'chunk';  seq: number; data: unknown }
  | { t: 'end';    result: unknown }
  | { t: 'error';  error: WireError }
  | { t: 'credit'; n: number }        // 消费者 → 生产者
```

## 5. 背压

信用制，不可省略。

- 消费者建流时授予初始信用 32。
- 每消费 16 个 chunk 回发 `{ t: 'credit', n: 16 }`。
- 生产者信用耗尽即挂起，**禁止无限缓冲**。

无背压的流式实现会在慢消费者场景下把内存打爆——扫描进度、AI 流式回复、日志尾随都是真实的慢消费者场景。

## 6. 取消

- 每次调用携带 `callId`（cuid2）。
- 客户端调 `cancel(callId)`；主机端从 `callId → AbortController` 表中取出并 abort。
- **`AbortSignal` 必须贯穿到最底层**：数据库查询的 `interrupt()`、undici 的 `signal`、子进程的 kill、Worker 的 terminate。中途吞掉 signal 是缺陷。
- 取消成功后 **200 ms 内**停止一切资源消耗。
- **已产生的部分结果不丢弃**，由业务层决定是否持久化：AI 回复标 `partial=1`，扫描保留 cursor，转封装保留已写入的缓存段。

## 7. 错误模型

```ts
type WireError = {
  code: ErrorCode                 // 稳定枚举，UI 据此决定文案与恢复动作
  message: string                 // 已脱敏，可直接展示
  retryable: boolean
  details?: Record<string, string | number | boolean>   // 已脱敏
}
```

**禁止**把 stack、绝对路径、SQL 语句、异常原文回传渲染进程。主机端把完整错误连同 `traceId` 写本地日志，只回传 `traceId`。

`ErrorCode` 定义在 `packages/contract/errors.ts`。新增枚举值需要 ADR：它是稳定协议的一部分，UI 与未来的日志分析都依赖它。

`retryable` 必须诚实：网络超时是 `true`，schema 校验失败是 `false`。UI 的自动重试逻辑依赖它，标错会造成无意义的重试风暴。

## 8. 缓存失效

主机端在数据变更后通过专用流式通道推送失效标签，界面按标签丢弃自研查询缓存中的条目。标签命名与方法名的域一致（`library`、`anchor`…）。

**写方法必须声明它使 which 标签失效**，在 `method()` 的 `invalidates` 字段中列出。漏声明会导致界面显示陈旧数据，这类 bug 极难定位。

## 9. 新增方法检查表

- [ ] input/output schema 完整，无 `z.any()`
- [ ] 名称遵循 `<域>.<动作>`
- [ ] 写方法声明了 `invalidates`
- [ ] 长耗时方法是流式的，且实现了信用制背压
- [ ] 可取消的方法把 `AbortSignal` 传到了最底层
- [ ] 错误路径返回结构化 `WireError`，不含路径与 stack
- [ ] output 中没有任何凭证类字段
- [ ] 有对应的契约测试
