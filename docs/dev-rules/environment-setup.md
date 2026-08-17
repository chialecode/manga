# 开发环境

> 触发：首次安装、修复依赖、更新 `vendor-bin` 二进制、准备新 worktree 时。

## 1. 前置

| 项 | 版本 |
|---|---|
| Node.js | 24.x（Active LTS） |
| pnpm | 10.x |
| Windows | 10 21H2+ / 11 x64 |
| Visual Studio Build Tools | C++ 桌面开发工作负载（`better-sqlite3` 重编需要） |
| Python | 3.x（node-gyp 需要） |

## 2. 首次安装

```bash
pnpm install
```

`postinstall` 会依次执行：

1. `scripts/ensure-vendor-bin.mjs` —— 按平台下载 `vendor-bin/` 二进制并校验 sha256
2. `@electron/rebuild` —— 按当前 Electron ABI 重编 native 模块

两步任一失败都会中断安装。**不要用 `--ignore-scripts` 绕过。**

## 3. 中国大陆网络配置

仓库根 `.npmrc` 已配置镜像。开发机额外需要的环境变量：

```
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
```

`better-sqlite3` 的预编译产物走自建 prebuild 缓存，地址在 `.npmrc` 的 `prebuild-host` 中配置。若缓存不可用，回退到源码编译（需要第 1 节的 Build Tools）。

**CI 不使用镜像**，走官方 registry 以保证 npm 包签名完整性校验有效。

## 4. vendor-bin

`vendor-bin/` 下的二进制**不进 Git**，由 `scripts/ensure-vendor-bin.mjs` 下载。

- 版本与 sha256 记录在 `scripts/vendor-bin.manifest.json`，**该文件必须入库**。
- 下载后校验 sha256，不匹配即失败并删除产物。
- 应用运行时在首次调用前再次校验，不匹配则拒绝执行并提示重新安装。
- 更新二进制版本：改 manifest 的 version 与 sha256 → 跑 `pnpm ensure-vendor-bin --force` → 跑 `pnpm test:guard` → 提 PR。**只改 version 不改 sha256 会被 `vendor-sha256` 闸门拦下。**

当前内容：

| 二进制 | 来源 | 变体 |
|---|---|---|
| `ffmpeg/ffmpeg.exe`、`ffmpeg/ffprobe.exe`、`ffmpeg/libav*.dll` | 上游 `BtbN/FFmpeg-Builds` 的 `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip`，**镜像到自建对象存储后固定 URL** | `lgpl-shared` |

**不自行构建 FFmpeg。** 上游已提供符合要求的 LGPL 变体（明确排除 `libx264` / `libx265`），自建一份不带来任何收益，只增加维护面。

两条硬性要求：

1. **URL 必须指向上游的月度保留构建。** 上游保留策略是「每月最后一个构建保留两年，日构建只保留最近 14 个」，固定 `latest` 或日构建会在两周内 404。`vendor-sha256` 闸门断言 URL 中不含 `latest` 与日构建标记。自建镜像推迟到阶段 10（残留风险见架构正本 §22 R10）。
2. **必须是 `lgpl` 变体，禁止 `gpl` / `nonfree`。** GPL 变体含 `libx264`，会让整个分发落入 GPL。`vendor-sha256` 闸门附带断言：产物的 `-version` 输出中不得出现 `--enable-gpl` 与 `libx264`。

LGPL 义务：对应版本的 FFmpeg 源码 tarball（取自 `ffmpeg.org`）与上游构建标识一并镜像发布。

## 5. 常用命令

```bash
pnpm dev              # 启动开发模式（electron-forge start）
pnpm typecheck        # 全仓类型检查
pnpm lint             # ESLint
pnpm test:unit        # 单元测试（提交前必跑）
pnpm test:guard       # 架构与供应链闸门
pnpm test:all         # 全部测试层
pnpm make             # 产出 NSIS 安装包
pnpm licenses:generate  # 生成第三方声明与 SBOM
```

## 6. worktree

新任务用独立 worktree 时，`vendor-bin/` 与 `node_modules/` 不共享，需要在新 worktree 中重新 `pnpm install`。**不要**手动 symlink `node_modules`：native 模块按 Electron ABI 编译，跨 worktree 复用会在升级 Electron 后产生难以定位的加载失败。

## 7. 排障

| 症状 | 原因 | 处理 |
|---|---|---|
| `Module did not self-register` 或 `NODE_MODULE_VERSION` 不匹配 | native 模块未按 Electron ABI 重编 | `pnpm rebuild:native` |
| `ensure-vendor-bin` 校验失败 | 下载被劫持或 manifest 过期 | 检查网络出口；确认 manifest 的 sha256 与官方发布一致 |
| 启动时提示二进制校验失败 | `vendor-bin` 被篡改或不完整 | 删除 `vendor-bin/` 后重新 `pnpm install` |
| `pnpm install` 卡在 Electron 下载 | 镜像未配置 | 见第 3 节 |
