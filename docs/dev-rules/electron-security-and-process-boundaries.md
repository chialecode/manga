# Electron 安全与进程边界

> 触发：修改 Renderer、preload、`BrowserWindow`、CSP、自定义协议、Fuses、导航行为或任何 Electron 特权能力前。
> 设计依据见 [`docs/architecture.md`](../architecture.md) §3。

## 1. 三条不变量

放宽任一条视为安全变更，需重新评审并提交 ADR。

### 1.1 渲染进程零特权

渲染进程**没有** Node API、**没有**文件系统句柄、**没有**数据库连接、**没有**任何密钥、**不能**执行命令。

窗口配置固定为：

```ts
webPreferences: {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
  preload: PRELOAD_PATH,
}
```

`preload` 只暴露三个方法，不得增加第四个：

```ts
contextBridge.exposeInMainWorld('__rpc', {
  invoke(method: string, payload: unknown, callId: string): Promise<unknown>,
  stream(method: string, payload: unknown, callId: string, port: MessagePort): void,
  cancel(callId: string): void,
})
```

禁止在 preload 中暴露 `fs`、`path`、`child_process`、`app`、`shell`、`dialog` 或任何 Electron 模块。需要打开文件选择器时，走 RPC 方法由主进程调用。

### 1.2 媒体 URL 只用不透明 token

**禁止把真实文件路径放进任何 URL、任何传给渲染进程的对象、任何日志。**

```
media://<opaqueToken>/<subPath>
book://<opaqueToken>/<opfRelativePath>
```

- token 为 128-bit 随机值，映射表在主进程内存中。
- token 绑定签发它的 window session，TTL 30 分钟，可续期。
- 协议处理器只接受已签发且未过期的 token。

### 1.3 电子书内容 `script-src 'none'`

EPUB 规范允许内嵌脚本。本项目**不支持**电子书脚本内容。

内容通过 `blob:`/自定义 scheme 同源提供，iframe sandbox 在需要 `allow-scripts` 的场景下不可靠，因此 **CSP 是唯一防线**。

## 2. CSP

主界面：

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' media: data: blob:;
media-src 'self' media: blob:;
font-src 'self';
connect-src 'self';
frame-src book:;
worker-src 'self' blob:;
form-action 'none';
base-uri 'none';
```

电子书内容框架：

```
default-src 'none';
script-src 'none';
style-src 'unsafe-inline' book:;
img-src book: data:;
font-src book:;
```

两串字符串由 `csp-assert` 闸门断言，改动会导致 CI 失败。要改必须同时改断言，并在 PR 中说明为什么放宽是安全的。

## 3. Fuses

打包时通过 `@electron-forge/plugin-fuses` 写入，全部由 `fuses-assert` 闸门验证：

| Fuse | 值 |
|---|---|
| `runAsNode` | false |
| `enableNodeOptionsEnvironmentVariable` | false |
| `enableNodeCliInspectArguments` | false |
| `enableCookieEncryption` | true |
| `enableEmbeddedAsarIntegrityValidation` | true |
| `onlyLoadAppFromAsar` | true |
| `loadBrowserProcessSpecificV8Snapshot` | false |
| `grantFileProtocolExtraPrivileges` | false |

前三项关闭后**开发调试也受影响**。开发模式用未打包运行（`pnpm dev`），Fuses 只作用于打包产物。不要为了调试方便在打包配置里临时放开。

## 4. 路径解析

任何文件访问必须经 `apps/desktop/src/main/capability-gate`。其他位置禁止 import `node:fs`（由 `no-direct-fs` 闸门断言）。

`resolve(rootId, relPath)` 的处理顺序不可调整：

```
1. 查 rootId 是否为已授权且启用的库根
2. 拒绝绝对路径、拒绝含 NUL 的输入
3. path.resolve(rootPath, relPath)
4. fs.realpath()  —— 展开符号链接与 junction
5. 用 path.relative(rootPath, real) 校验：结果不以 '..' 开头且不是绝对路径
6. 拒绝 Windows 保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9）
```

**第 4 步不可省略**。仅做字符串前缀判断会被 junction 绕过。

攻击用例集在 `apps/desktop/src/main/capability-gate/__tests__/traversal.test.ts`，覆盖：`../` 与 `..\` 变体、URL 编码与双重编码、Unicode 规范化变体、8.3 短名、symlink/junction 跨界、UNC 路径、设备名、超长路径。**新增任何路径处理逻辑时必须同时新增用例。用例集只增不减。**

## 5. 导航与外部链接

- `webContents.setWindowOpenHandler` 一律返回 `{ action: 'deny' }`。需要打开外部链接时经 RPC 走主进程的 `shell.openExternal`，且**必须校验协议为 `https:`**。
- `will-navigate` 一律 `preventDefault()`。界面路由是自研的内存路由，不产生真实导航。
- `webviewTag: false`，产品明确不内嵌第三方内容网站。

## 6. 自定义协议注册

协议名从 `packages/contract/identity.ts` 导入，**源码中禁止字面量**。命名规则见 [`naming-and-identifiers.md`](./naming-and-identifiers.md) §4。

```ts
import { SCHEME_MEDIA, SCHEME_BOOK } from '@manga/contract/identity'

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME_MEDIA, privileges: {      // 'media'
      standard: true, secure: true, supportFetchAPI: true,
      stream: true, corsEnabled: false, bypassCSP: false } },
  { scheme: SCHEME_BOOK, privileges: {       // 'book'
      standard: true, secure: true, supportFetchAPI: true,
      stream: false, corsEnabled: false, bypassCSP: false } },
])
```

`bypassCSP` 永远为 `false`。

`media` 的处理器必须实现 Range：解析 `Range` 头，命中时返回 206 + `Content-Range` + `Accept-Ranges: bytes`，`ETag` 用内容指纹。不实现 Range 会让视频 seek 与大图加载退化为全量下载。

**系统深链接**（`manga://` / 开发版 `manga-dev://`）与上述两个内部协议是不同层面的东西：它进 OS 注册表、跨应用可见、正式版与开发版必须用不同 scheme。见 `naming-and-identifiers.md` §2。

## 7. 新增窗口

新增任何 `BrowserWindow` 必须复用 `apps/desktop/src/main/window` 的创建函数，不得直接 `new BrowserWindow`。该函数统一施加第 1.1 节的配置、CSP 注入、导航拦截与窗口状态持久化。另造一套平行实现会绕过全部安全基线。
