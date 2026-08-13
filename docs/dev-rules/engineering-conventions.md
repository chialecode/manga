# 通用工程规范

> 触发：修改日志、错误处理、时间单位、UI 文案与 i18n、命名约定前。

## 1. 时间单位（不变量）

**全系统整数毫秒。**

- 跨进程、入库、进入 `domain` 的时间值一律为 `number` 整数毫秒。
- 浮点秒只允许存在于两个读取点：`HTMLMediaElement.currentTime` 与 FFmpeg 的 PTS 输出。**在读取的同一个表达式内**完成 `Math.round(x * 1000)` 转换，不允许浮点秒作为变量在函数间传递。
- 时间变量命名必须以 `Ms` 结尾（`startMs`、`durationMs`、`positionMs`）。数据库列以 `_ms` 或 `_at` 结尾。
- zod schema 中时间字段用 `.int()`。

违反这条的代价是 seek 误差、字幕漂移、锚点错位，而且极难定位。

## 2. 日志

- 结构化 JSONL，写到 `%LOCALAPPDATA%\manga\logs\`，滚动保留 7 天 / 50 MB。
- 统一用 `packages/ui` 与 `apps/desktop` 各自的 logger，禁止裸 `console.*`（ESLint 拦截，`console.error` 在顶层错误边界中例外）。

### 2.1 脱敏（不变量，只增不减）

logger 的 redact 中间件必须过滤：

| 类别 | 处理 |
|---|---|
| 绝对路径 | 替换为 `<root:{rootId}>/<sha1-8(relPath)>` |
| 文件名、书名、作品标题 | 替换为 `<title:{workId}>` |
| API Key、token、`Authorization` 头 | 替换为 `<redacted>` |
| 媒体 token | 替换为 `<token>` |
| 用户笔记、AI 对话内容 | 完全不记录 |

`log-redaction` 闸门用一组包含上述内容的样本跑 logger，断言输出中不出现原文。

**放宽任一条视为隐私变更**，需要在 PR 中显式说明并重新评审。调试级别的功能日志是用户内容最主要的泄漏源——需要临时打详细日志时，用本地未提交的 patch，不要合进主干。

### 2.2 traceId

每个 RPC 调用生成 `traceId`，贯穿主机端全部日志行。回传给渲染进程的 `WireError` 只带 `traceId`，不带任何细节。用户报障时提供 `traceId`，开发者据此在本地日志中定位。

## 3. 错误处理

- 主机端：捕获后转换为 `WireError`（见 [`ipc-contract.md`](./ipc-contract.md) §7），完整错误写日志。
- 渲染端：错误边界按 `ErrorCode` 决定文案与恢复动作，不展示 `traceId` 以外的技术细节（`traceId` 放在可展开的详情里）。
- **禁止吞异常**。`catch {}` 空块会被 ESLint 拦截；确实要忽略时写 `catch { /* 理由 */ }` 并说明。
- **禁止用异常做控制流**。预期内的失败（文件不存在、格式不支持、用户取消）用返回值表达。

## 4. i18n

- 自研类型安全消息目录，位于 `packages/ui/i18n/`。
- `zh-CN.ts` 是基准，`Messages` 类型由它推导；其余语言用 `satisfies Messages`，缺键 / 多余键 / 参数签名不匹配都是编译错误。
- 首发语言：`zh-CN`、`ja`、`en`。
- **UI 中禁止硬编码可见文案**。ESLint 规则拦截 JSX 中的中日英文字面量。
- 带参数的消息写成函数，不做字符串拼接：

```ts
'reader.pageOf': (a: { cur: number; total: number }) => `${a.cur} / ${a.total}`
```

- 产品术语在三种语言中必须一致。新增术语先加到 `packages/ui/i18n/glossary.md`，再使用。

## 5. 命名

| 对象 | 约定 |
|---|---|
| 包 | `@manga/<name>` |
| 文件 | kebab-case；React 组件文件 PascalCase |
| 类型与接口 | PascalCase，不加 `I` 前缀 |
| 枚举值与常量 | SCREAMING_SNAKE 仅用于真正的常量表；其余用字符串联合类型 |
| RPC 方法 | `<域>.<动作>` |
| 数据库表 | 单数 snake_case（`file`、`work`、`anchor`） |
| 数据库列 | snake_case；布尔用 `is_` / `has_` 前缀并存 INTEGER 0/1 |
| 时间 | 见 §1 |

## 6. TypeScript

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "verbatimModuleSyntax": true,
  "module": "nodenext",
  "moduleResolution": "nodenext"
}
```

- **禁止 `any`**。确实需要未知类型时用 `unknown` 并收窄。
- **禁止 `as` 断言绕过类型检查**，除非紧跟一行注释说明为什么类型系统在这里不够用。
- **禁止 `@ts-ignore`**；`@ts-expect-error` 必须带说明。
- 全 ESM。不写 CommonJS。

## 7. 注释

写「为什么」，不写「做什么」。以下三类必须有注释：

1. 有非显然性能理由的写法（如「这里不用 map 是因为 10 万条时会产生中间数组」）。
2. 绕过某个上游 bug 的代码，注明 issue 链接与移除条件。
3. 安全相关的顺序依赖（如能力网关中 `realpath` 必须在前缀校验之前）。

## 8. 跨平台

首发只有 Windows，但代码中：

- 路径分隔符统一用 `/` 存储，只在调用系统 API 时转换。
- 不假设大小写敏感性。文件名比较用规范化后的形式。
- 不硬编码 `%APPDATA%` 等，走 `app.getPath()`。
- 平台特定代码集中在 `apps/desktop/src/main/platform/`，用运行时分支而非编译期分支——这样 macOS 支持时改动范围可见。
