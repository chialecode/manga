# 依赖准入

> 触发：引入任何新的第三方依赖前。绕过本规则直接加依赖视为 P0。

## 1. 唯一标准

> **只有当「自研 = 重新实现一份成熟的公开规范或数值内核」时，才允许引入第三方依赖。其余一律自研。**

本仓的默认答案是自研。提出依赖的一方负责举证，而不是反对的一方负责举证。

## 2. 允许的四类

| 类别 | 判据 | 已准入实例 |
|---|---|---|
| ① 规范 / 格式实现 | 规范文本数百页以上，或需要长期兼容性积累 | SQLite、FFmpeg、PDF.js、libass（JASSUB）、libvips（sharp）、zlib |
| ② 平台原语 | 无法自研的运行时 | Electron、Node、Chromium |
| ③ 语言与构建工具链 | 编译、打包、测试的基础设施 | TypeScript、Vite、Vitest、ESLint、electron-forge、drizzle-kit |
| ④ 无障碍交互原语 | WAI-ARIA Authoring Practices 的正确实现（焦点陷阱、层叠、键盘导航、屏幕阅读器语义） | Radix UI 单包、Floating UI |

## 3. 禁止的类别

一律自研，不接受讨论：

状态管理、数据获取与缓存、路由、HTTP 客户端封装、ORM 之上的抽象层、UI 组件库、CSS 框架、i18n 框架、AI SDK、动画库、日期库、工具函数库（lodash 类）、图表库、Markdown 渲染框架。

## 4. 准入流程

新增生产依赖必须提交 ADR，回答全部五问：

1. 它属于第 2 节的哪一类？
2. 自研为何等价于重写一份规范实现？给出规范体量或数值复杂度的具体依据。
3. 它引入 native 二进制吗？若是，如何随 Electron ABI 升级？
4. 许可证是什么？有无传染性？分发义务是什么？
5. 移除路径是什么？被它污染的类型有多少处？

## 5. 硬性约束

- **native 依赖上限 5 个**：当前为 `better-sqlite3`、`electron`、`esbuild`、`sharp`、`@parcel/watcher`。新增 native 依赖必须先移除一个，或提交专项 ADR 提高上限。
- **构建脚本白名单**：pnpm `onlyBuiltDependencies` 只列上述五项。任何依赖想跑 postinstall 都必须显式入白名单。
- **精确锁定**：`electron`、`zod`、`better-sqlite3` 在 `package.json` 中不带 `^`；高风险传递依赖在 pnpm `overrides` 中锁定。
- **第三方类型不得跨包泄漏**：被准入的库，其类型只允许出现在直接包装它的那个 package 内。例如 `pdfjs-dist` 的类型不得出现在 `packages/domain` 或 `packages/features`。这是移除成本的上限控制。

## 6. 定期复核

每次 Electron 大版本升级时复核一次依赖清单：是否有依赖已被平台能力取代、是否有依赖停止维护、native 依赖是否仍有 prebuild。结论写入该次升级的 PR 描述。
