# 命名与标识符

| 项 | 值 |
|---|---|
| 状态 | authoritative |
| 适用 | 应用名、appId、目录、协议、互斥体，以及一切会进入用户机器的字符串 |

这些标识符一旦发布就**不可更改**：改安装目录会留下孤儿安装，改数据目录等于用户数据凭空消失，改协议名会让已签发的媒体 token 全部失效。本文件是唯一正本，任何地方出现的字面量都必须与此处一致。

---

## 1. 大小写规则

> **仅「显示名」使用大写 `MANGA`。安装目录、数据目录、缓存目录、appId、协议名、包名一律小写。**

理由：Windows 文件系统大小写不敏感但大小写保留，混用会在跨平台（未来 macOS）与脚本比对时产生难以复现的分歧。统一小写消除整类问题。

---

## 2. 标识符总表

| 项 | 正式版 | 开发版 |
|---|---|---|
| 显示名 | `MANGA` | `MANGA Dev` |
| appId / AppUserModelId | `app.manga.desktop` | `app.manga.desktop.dev` |
| 安装目录 | `%LOCALAPPDATA%\Programs\manga` | `%LOCALAPPDATA%\Programs\manga-dev` |
| 漫游数据（`userData`） | `%APPDATA%\manga` | `%APPDATA%\manga-dev` |
| 本地数据与缓存 | `%LOCALAPPDATA%\manga` | `%LOCALAPPDATA%\manga-dev` |
| 系统深链接 | `manga://` | `manga-dev://` |
| 单实例锁 | 随 `userData` 自动隔离 | 同左 |

**开发版深链接必须是 `manga-dev://`。** 系统深链接是 OS 级注册，同名时后注册者覆盖先注册者 —— 若两版共用 `manga://`，开发版一旦运行就会劫持正式版的深链接，且卸载开发版后正式版的注册也不会自动恢复。

---

## 3. 环境隔离

开发版与正式版必须能在同一台机器上**同时安装、同时运行、互不影响**。

### 3.1 隔离清单

| 资源 | 隔离方式 |
|---|---|
| 用户数据（数据库、录音） | `userData` 路径不同 |
| 缓存（缩略图、字幕、转封装临时文件） | 本地数据根不同 |
| 日志、崩溃转储 | 本地数据根不同 |
| 单实例锁 | Electron 的单实例锁基于 `userData` 目录，隔离 `userData` 即自动隔离锁 |
| 任务栏分组与跳转列表 | AppUserModelId 不同 |
| 系统深链接 | scheme 不同 |
| 安装目录与卸载项 | 安装目录与 appId 不同 |

### 3.2 实现约束

环境判定由**构建期常量**决定，不读运行期环境变量：

```ts
// packages/contract/identity.ts —— 唯一定义处
export const CHANNEL = __BUILD_CHANNEL__            // 'stable' | 'dev'，由构建注入
export const APP_DIR_NAME = CHANNEL === 'dev' ? 'manga-dev' : 'manga'
export const APP_ID       = CHANNEL === 'dev' ? 'app.manga.desktop.dev' : 'app.manga.desktop'
export const DEEP_LINK    = CHANNEL === 'dev' ? 'manga-dev' : 'manga'
export const DISPLAY_NAME = CHANNEL === 'dev' ? 'MANGA Dev' : 'MANGA'
```

路径设置必须在 `app.whenReady()` **之前**完成，否则 Electron 已用默认路径创建了目录：

```ts
app.setName(APP_DIR_NAME)                    // 影响 userData 默认值
app.setAppUserModelId(APP_ID)
app.setPath('userData',    join(app.getPath('appData'),  APP_DIR_NAME))
app.setPath('sessionData', join(app.getPath('appData'),  APP_DIR_NAME))
app.setPath('logs',        join(app.getPath('userCache'), APP_DIR_NAME, 'logs'))
app.setPath('crashDumps',  join(app.getPath('userCache'), APP_DIR_NAME, 'crashes'))
```

> `app.setName()` 用的是**目录名**（小写），不是显示名。显示名只出现在窗口标题、关于框、安装器界面与任务栏悬停文字中，走 i18n 消息目录的品牌键，不参与任何路径拼接。

---

## 4. 自定义协议

### 4.1 命名规则

> **内部资源协议使用通用短名，禁止带产品前缀。**

理由：这一层是与产品无关的字节流服务（取一段带 Range 的资源、渲染一份受限文档），带上 `manga-` 前缀会把可复用的基础设施钉死在这个产品上。通用命名让协议层可以整体搬到别的项目。

正式版与开发版**使用相同的内部协议名**。这些协议通过 `registerSchemesAsPrivileged` 注册在应用自己的 session 内，不进 OS 注册表，不跨应用可见，无冲突可能。

### 4.2 协议总表

| 协议 | 用途 | 关键特性 |
|---|---|---|
| `media://` | 媒体字节流：图片、视频、音频 | 必须实现 Range（206 + `Content-Range` + `Accept-Ranges`），`ETag` 用内容指纹 |
| `book://` | 电子书内容框架 | 只读，无 Range，CSP `script-src 'none'` |
| `manga://` / `manga-dev://` | 系统深链接 | OS 级注册，唯一带产品名的协议 |

URL 形态：

```
media://<opaqueToken>/<subPath>
book://<opaqueToken>/<opfRelativePath>
```

`<opaqueToken>` 为 128-bit 随机值，绑定 window session，TTL 30 分钟。**URL 中不出现任何真实文件系统路径。**

### 4.3 单一定义处

全部协议名定义在 `packages/contract/identity.ts` 中作为常量导出，**源码中禁止出现协议名字符串字面量**（CSP 字符串由常量拼接生成）。

这条同时服务两个目的：让 `csp-assert` 闸门能机器校验，以及让将来重命名协议是一处改动而非全仓搜索。

---

## 5. 包与仓库命名

| 项 | 值 |
|---|---|
| 仓库名 | `manga` |
| npm workspace 根包名 | `manga`（`private: true`） |
| 应用包 | `apps/desktop`、`apps/svc-db`、`apps/svc-scan` |
| 内部包作用域 | `@manga/*`（如 `@manga/domain`、`@manga/contract`） |

内部包作用域带产品名是可以的 —— 它只存在于源码与 lockfile 中，不进用户机器。§4.1 的「禁止产品前缀」只约束**运行期用户可见的协议**。

---

## 6. 变更成本

| 标识符 | 发布后修改的后果 |
|---|---|
| 数据目录名 | **用户数据视同丢失**，需要写一次性迁移逻辑并保证幂等 |
| 安装目录名 | 留下孤儿安装，两份程序同时存在 |
| appId | 任务栏分组断裂，旧卸载项残留，更新器认不出已装版本 |
| 内部协议名 | 已签发 token 全部失效（可接受，token 本就短命）；但 CSP、Fuses 校验、EPUB 内链重写全部要同步改 |
| 深链接 scheme | 已发出的外部链接全部失效 |
| 显示名 | 无技术后果，随时可改 |

**显示名之外的任何一项，都必须在首个公开发布前定死。**
