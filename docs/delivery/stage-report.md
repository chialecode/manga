# 阶段交付报告：依赖升级与 Agent 工程循环

日期：2026-11-04 至 2026-11-06。角色：B 实施与自检；A 2026-11-06 集中审查（[第 11 节](#review)）。计划见[当前阶段计划](stage-plan.md)；本报告按“工作包 / 需求 / 验收 → 实现位置 → 验证证据 → 状态与限制”映射。产品验收保持 not-run；人工检查 H-80—H-87 与需重测的 H-07、H-09、H-12、H-16—H-18、H-25、H-42、H-43、H-46、H-47、H-53 在[用户待办](../../USER-ACTIONS.md#checks)。

<a id="cleanup"></a>
## 1. 阶段开始的整理（C0）

- A 在计划所在的提交里已做：上一阶段报告提炼后删除、登记表 `currentStage` 改为 `m6`、确认记录与需求的同步、删除 `dist/gate-package/`、87 份零散日志与构建缓存（计划 5.1）。
- B 复核计划 5.1 的两张表：`.env.local`、`dist/design-refs/`、`dist/tools/`、`dist/samples/`、`dist/keys/`、`dist/plugins/` 原样保留；`dist/desktop/` 先用来生成 4.1 的旧版凭据 Profile（`dist/samples/legacy-e44-credentials/`，Electron 44.9.3），之后被本阶段的打包覆盖；`dist/evidence-runs/current/` 由本阶段的门禁覆盖。
- 系统临时目录里上一阶段留下的 `manga-*` 目录：确认没有 MANGA、Electron 或 Vitest 进程在运行后删除 126 个，剩 0 个（只记数量）。
- 以前阶段的标签：文档检查报出的只有 `tests/shell/chat-long-session.test.tsx` 里形如 `m10` 的消息编号（检查把它认成阶段标签），改为 `msg-10` 这类写法，断言不变；文档检查通过。

<a id="dependencies"></a>
## 2. 依赖盘点（D1）

实施开始（2026-11-03）与门禁前（2026-11-04）各跑一次 `pnpm outdated -r`，按“满 14 天的最新精确版本”取，最小发行龄不绕过、没有写入豁免。门禁前逐个查了 npm registry 的发行时间：所有依赖都已是满 14 天的最新版本。

| 依赖 | 前 | 后 | 说明 |
| --- | --- | --- | --- |
| electron | 44.9.3 | 45.0.0 | W1；当天满龄的只有 45.0.0（45.1.0 在 11-10、45.2.x 更晚） |
| @earendil-works/pi-ai | 0.85.1 | 1.3.0 | W2；1.4.0 在 2026-11-04 22:43 UTC 满龄，晚于门禁前的盘点；下次盘点取满龄的最新 1.x |
| electron-builder（新增，开发依赖） | — | 26.18.0 | W11；26.18.1 未满龄 |
| knip | 6.41.0 | 6.42.1 | 满龄的最新 |
| @types/node | 24.5.2 | 24.19.2 | 留在 24.x（Electron 45 与 CI 用 Node 24） |
| linkedom | 0.18.13 | 0.18.13 | 复试 0.18.14 失败后回退，见 ADR-0007 的例外；0.18.15 未满龄 |
| 其余（tiptap、@xyflow/react、dockview-react、@tanstack/react-virtual、lucide-react、pdfjs-dist、onnxruntime-web、vitest、tailwindcss 等） | — | 不变 | 有新版的都不满 14 天 |

**Electron 45 的破坏性变更逐条核对（计划 3.1）。** 同步的 `safeStorage` 接口废弃：凭据改用异步接口（W1），源码里只有生成旧版 Profile 的样本脚本 `scripts/samples/legacy-credentials-e44.ts` 用同步接口，`scripts/check-deps.mjs` 守护别处不用；沙箱预加载里不再有 `Buffer`、`setImmediate` 与 Node 模块：预加载没有用到；ASAR 里的文件描述符只能经 `fs`：没有直接的文件描述符用法。原生模块（better-sqlite3、sharp、@napi-rs/canvas、onnxruntime）按 Electron 45 的 ABI 重建，打包烟测通过。

**pi-ai 1.x 的破坏性变更逐条核对（计划 3.1）。** 0.86 自定义提供者的输入改为 `TranscriptContext`：MANGA 不注册自定义提供者；0.99 图像模型并入 `Provider` / `Models`：只用文字模型的流接口，不受影响；1.0.3 Azure 提供者改名：不用；1.1 流函数必须返回 `AssistantMessageEventStream`：适配器按新类型消费事件；1.4 `telemetryContext` 改名、删除 `getPiUserAgent()`：不用；1.5 主入口不再转出 TypeBox：工具参数直接写 JSON Schema（`packages/model-protocol/src/pi-ai.ts`），不再导入 `Type`，所以 1.4、1.5 都能直接用。

<a id="mapping"></a>
## 3. 工作包映射

| 包 | 需求 / 验收 | 实现位置 | 验证证据 | 状态与限制 |
| --- | --- | --- | --- | --- |
| W1 Electron 45 与凭据 | NFR-03、NFR-05；AT-141 | `packages/app-core/src/credentials.ts`（唯一的读取函数、合并同时的读取、只在密文未变时写回、不可用时 `CREDENTIAL_UNAVAILABLE`）、`apps/desktop/src/main/index.ts` 的 `ElectronSafeStorageVault`、模型连接、弹幕、Bangumi 与视觉读取的六处调用、`scripts/check-deps.mjs` | `tests/runtime/credentials-async.test.ts`（AT-141）；打包观察 `credentials-async` 与重启（Electron 44 的产物保存的 Profile） | 已实现 |
| W2 pi-ai 1.x | MODEL-05、NFR-05；AT-142 | `packages/model-protocol/src/pi-ai.ts`、`openai-http.ts`、`mock-server.ts` | `tests/agent/runtime-contract.test.ts`（AT-142，两个协议 × 两个运行时） | 已实现 |
| W3 长对话 | AGENT-06、NFR-01；AT-143 | `apps/desktop/src/renderer/components/chat/messages.tsx`（虚拟列表、锚点、自动载入、跳转机制）、`hooks/use-session-stream.ts`（`from` 刷新、一次一个更早页的请求）、`packages/app-core/src/ops/stream.ts`（`from`，上限 5000） | `tests/shell/chat-long-session.test.tsx`（AT-143）、`tests/library/operations.test.ts`；打包观察 `chat-long-session`；基准 `chatOpen`、`chatInput`、`chatLateFrame`、`chatOlderPage` | 已实现；“从笔记跳到一条消息”的产品入口还没有，见第 10 节 |
| W4 图像的存放与保留 | CTX-02、DATA-01；AT-144 | `packages/app-core/src/agent-media.ts`、`commands/agent.ts`、`commands/agent-run.ts`、`agent-settings.ts`、`packages/storage-drizzle/src/migrate-agent-media.ts`、`store.ts`、`sql.ts`（v13）、`apps/desktop/src/renderer/components/trace-dialog.tsx`（图像与过期占位）、`pages/settings/agent-page.tsx` | `tests/agent/agent-media.test.ts`、`tests/library/schema-v13-migration.test.ts`（AT-144）、`tests/agent/trace-ui.test.tsx`；打包观察 `agent-media-retain`、`migrate-v13`、重启与 `migrate-v13-newer`；基准 `freeze4mb` | 已实现 |
| W5 PDF 与视频输入 | MODEL-05、AGENT-07；AT-145、AT-146 | `packages/app-core/src/agent-native-input.ts`、`agent-materials.ts`、`agent-trace.ts`（发送记录）、`video/service.ts`（`clipBytes`）、`packages/model-protocol/src/http.ts`、`openai-http.ts`、`packages/contracts/src/inputs-models.ts`（`limits`）、`connection-dialog.tsx`、`lib/model-profile.ts` | `tests/agent/agent-media-native.test.ts`（AT-145、AT-146）、`tests/agent/models-page.test.tsx`、`connection-dialog.test.tsx`；打包观察 `agent-media-native`；基准 `clip60` | 已实现 |
| W6 工作区余项 | UI-09；AT-147 | `apps/desktop/src/renderer/workspace/controller.ts`（只给没有保存过布局的上下文放默认标签）、`openers.ts`（`libraryTabFor`）、`apps/desktop/src/main/smoke/bench-workspace.ts`（四宫格用项目的文稿页） | `tests/shell/sidebar-ui.test.tsx`（AT-147）、`tests/shell/workspace-controller.test.ts`；打包观察 `workspace-last-tab-empty`、`library-tab-single`；基准 `quadLateFrame`、`quadMemory` | 已实现；第 1 项（最后一个标签）的缺陷由新的窗口观察发现：保存过、但所有标签都已关掉的上下文在重新载入时又被放上默认标签，现在只有从没保存过的上下文才放 |
| W7 门禁工程 | LOOP-26、LOOP-13、LOOP-27 | `scripts/stage/temp-dirs.mjs`、`package.mjs`、`bench.mjs`、`apps/desktop/src/main/smoke/power-throttling.ts`、`hold-walk.ts`、`frame-walk.ts`、`tests/shell/search-box-ui.test.tsx` | 证据里的 `tempDirs`；第 6、7 节 | 已实现 |
| W8 走查、测试与基准 | — | `apps/desktop/src/main/smoke/{loop-walk,loop-media,stage-walks,bench-chat}.ts`、`scripts/stage/bench-agent-media.mjs`、`gate.json` | 第 8、9 节 | 已实现 |
| W9 文档 | — | 需求、路线图、领域模型、数据与安全、Agent 与插件协议、交互设计、质量门禁、仓库地图、ADR-0007、执行状态、用户待办 | 文档检查 | 已实现 |
| W10 数据的存放位置 | DATA-04；AT-148、AT-149、AT-51 | `packages/app-core/src/locations.ts`（两个根、系统登记的文件夹、新指针、旧位置的升级）、`library-locations.ts`、`commands/settings.ts`（`settings.cleanLegacyLocation`）、`apps/desktop/src/main/index.ts`（通道写进产物、崩溃转储）、`pages/settings/location-groups.tsx`、`general-page.tsx` | `tests/runtime/data-locations.test.ts`（AT-148、AT-149）、`tests/shell/data-locations-ui.test.tsx`；打包观察 `data-locations-fresh`、`data-locations-upgrade` | 已实现；见第 5 节 |
| W11 安装包 | DATA-06；AT-150 | `scripts/stage/installer-lib.mjs`（NSIS 配置、默认目录）、`installer.mjs`（真实安装与卸载）、`apps/desktop/forge.config.ts`（通道） | `tests/runtime/installer-config.test.ts`（AT-150）；`node scripts/stage.mjs installer` | 已实现；不签名、不发布 |

<a id="stick-to-bottom"></a>
## 4. 贴底的路线试验（W3）

按计划 4.3 先试“`@tanstack/react-virtual` 的虚拟列表 + use-stick-to-bottom 贴底”。两者共用 use-stick-to-bottom 的滚动容器，虚拟列表的 `scrollMargin` 取列表在容器里的偏移。

**窗口里发现的两处问题与处理**（打包观察 `chat-long-session`，5000 条消息）：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 打开后第一屏不在最底下；回答流式输出时，12 次取样里有 9 次离底部几十到几百像素 | `resize="smooth"`：内容变高时 use-stick-to-bottom 用弹簧动画追到底部。虚拟列表在行量出实际高度后改总高，打开时还会先载入一页更早的消息，动画一直落后 | 改为 `resize="instant"`，内容变高时直接到底 |
| 改成 `instant` 后，回答期间 12 次取样仍有 1 次离底部 157 px | use-stick-to-bottom 的 ResizeObserver 挂在被量行的祖先上，按 ResizeObserver 的规则要到下一帧才收到，收到后滚动又要再等一帧（`wait: true`）；新的一段字在这一帧画出时列表还没到底 | 列表在每次提交后的布局阶段补一步：上一次滚动停在最底下、且 use-stick-to-bottom 没有因为用户上滚而解除贴底时，把滚动位置放回底部，画出前就到位。用户上滚（滚轮立即解除）与回到记住的位置（滚动事件记下“不在底部”）不受影响 |
| 基准里从另一本书切回 5000 条的对话时，列表停在最早载入的一页 | 同一个列表换了会话，内容先变短，浏览器把滚动位置往上压，补的那一步把这当成了用户上滚 | 只有内容没有变短时，滚动位置变高才算用户上滚；换会话时重新从“贴底”开始（记住的位置仍由滚动记忆放回）。新增列表用例 |

**结论**：两者没有争夺滚动位置（虚拟列表只在“不在底部、变化的行在视口之上”时修正位置），保留 use-stick-to-bottom 管“是否贴底”的判断、滚动到底的按钮与用户上滚的识别，只补上面这一步，不改为整套自己贴底。贴底的判断方式与门槛没有改；窗口观察每 150 ms 取一次与底部的距离，要求全部 ≤ 8 px。

<a id="locations"></a>
## 5. 位置迁移与安装、卸载的验证（W10、W11）

全部在系统临时目录与合成 Profile 上进行，没有碰本机真实的 Profile 和真实安装。

**位置迁移**：打包烟测 `data-locations-fresh-*` 与 `data-locations-upgrade`，在最终源码上连续三次 `stage package` 都通过。

| 检查 | 结果（最后一次） |
| --- | --- |
| 两个频道全新启动 | 应用数据在 `LOCALAPPDATA` 之下，文稿在“文档”、下载在“下载”；设置页分三组显示；没有写到其他地方的文件（0 个） |
| 中断 | 复制过程中让进程退出（`MANGA_UPGRADE_CRASH_AT=upgrade-copy`，退出码 99）：没有写新指针，旧根也没有标记 |
| 下一次启动继续 | 搬了应用数据（61 个文件），复制后校验再切换；作品、项目、附件、资源、导出、下载 6 个分区记成覆盖，留在原处；笔记文件与截图仍从原位置打开；旧根留下 `RELOCATED.json`，旧位置的文件一个都没少（旧文件不自动删除） |
| 再次启动 | 不再搬动 |
| 旧版本按旧指针启动 | 跟着标记打开新位置（1.5 s）。这一步用本版本模拟旧指针，见第 10 节 |

**v13 迁移**（同一组烟测）：合成 v12 库里有 300 次运行、340 张图像，去重后 201 份，迁移耗时 16 ms；迁移前后图像的哈希集合相等，运行快照里不再内嵌图像；一次刚失败的旧运行在迁移后重试成功。schema 为 14 的库被本版本拒绝打开，库本身没有被改动。

**安装与卸载**：`stage installer`，21 步，在最终打包产物上通过。
- 两个频道各生成一个不签名的按用户 NSIS 安装包（约 202 MB），不需要管理员权限，装到所选的临时文件夹；两个频道可以同时安装。
- 首次启动后，数据、文稿、下载都在对应位置；漫游配置文件（roaming）里没有写入任何东西。
- 程序正在运行时可以覆盖安装。
- 卸载后，开始菜单项、桌面快捷方式、注册表卸载项与按用户的注册表键都已清掉；用户的数据与文件保留。
- 结束时残留的注册表卸载项与快捷方式数量都是 0。
- 安装包没有发布。

<a id="loop-13"></a>
## 6. 节能降速的评估（LOOP-13）

计划 4.7 要比较三种办法：（1）Chromium 开关；（2）对基准的 Electron 进程调用 `SetProcessInformation(ProcessPowerThrottling)`，关闭执行速度节流；（3）什么都不做。

- **办法（1）**：基准窗口本来就带有 Chromium 的后台节流开关。下表 C 那次就带着它跑，导图折叠与白板打开仍接近门槛，所以单靠它不够。
- **办法（2）**：通过 PowerShell `Add-Type` 调用，没有加依赖，不需要 koffi。实现在 `apps/desktop/src/main/smoke/power-throttling.ts`：只有 `bench*` 阶段、并且 `MANGA_BENCH_NO_THROTTLE=1` 时才会执行；它每 2 秒取一次本应用新出现的进程，跑完把处理过的进程数写进日志。产品本身从不调用它。

同一份源码、同一时段，用完整基准测的结果如下（ms；“导图折叠”是 1000 个节点折叠展开的 p95，门槛 100；“EPUB 末尾”是 30 MiB EPUB 末尾，门槛 2000）：

| 运行 | 会话 | 节流 | 导图折叠 p95 | 白板打开 | EPUB 末尾 | 扫描事件循环 p99 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 工作站锁定 | 交给 Windows | 95.1 | 81.9 | 746 | 99.6 |
| C | 解锁、启动它的应用在前台 | 交给 Windows | 92.4 | 80.0 | 728 | 103.2 |
| B | 解锁、启动它的应用在前台 | 基准进程关闭 | 43.1 | 53.0 | 720 | 101.0 |

**结论**：办法（2）有效。窗口这边接近门槛的两项（导图折叠、白板打开）降到约一半；EPUB 末尾三次都远低于门槛，几乎不受影响。所以 `scripts/stage/bench.mjs` 默认设置 `MANGA_BENCH_NO_THROTTLE=1`，只作用于基准自己的进程，`bench.json` 的 `records.powerThrottling` 记录当次的设置；设为 `0` 时交给 Windows 管理，用于对照。门槛和测量方法都没有改。

**与计划的偏差**：计划要求前台、后台各跑 3 次完整基准。本次只跑了上表 3 次：其中一段时间工作站处于锁定状态，那段数据（A）不能当作“后台”对照；而且在这台已经长时间运行的机器上，每次完整基准都要很久。

**服务层的数字也受节流影响**：5000 个文件的扫描、调用追踪开销等服务层数字，是在 `stage bench` 自己的 Node 进程里测的，前面那步不覆盖它。最终门禁的前几次完整基准里，扫描吞吐约 72 文件/秒（上一阶段 207—214），事件循环 p99 为 102—105 ms，调用追踪开销 p95 为 9.7—10.2 ms（上一阶段 3.1），慢了约 3 倍，与 LOOP-13 记录的节能降速幅度一致。上一阶段的提交在同一时段也测得这么慢，起初我把它归为机器长时间运行后的状态。随后在同一时段、同一个 Node 进程里只测扫描，并切换节流设置：交给 Windows 时为 72.4 文件/秒、p99 101.8 ms；关闭节流后为 180.1 文件/秒、p99 37.8 ms。现在 `stage bench` 也为自己的进程关闭节流（`scripts/stage/power-throttling.mjs`），`records.powerThrottling` 分别记录进程与窗口两边的结果。最终基准的结果见[第 9 节](#gate)。

<a id="loop-27"></a>
## 7. 三条观察的判断方式（LOOP-27）

| 观察 | 以前 | 现在 |
| --- | --- | --- |
| `hold-rate-hint-only` | 脚本这边按住按键后用自己的时钟等待（按住时长 + 150 ms），再看页面上有没有进入临时倍速 | 页面记下按键与倍速变化的时刻（`performance.now()`，`window.__holdClock`），按页面时间判断：按住 900 ms 内只出提示、不进入临时倍速，松开后 300 ms 内提示消失；脚本的等待（最多 4 s）只用来等结果出现。记录 `judged: "page clock"` |
| `hold-rate-recovers` | 同上 | 进入临时倍速在按下后 450 ms 内、松开后恢复原倍速在 600 ms 内，都按页面时间判断，记下实际的时刻 |
| `frame-window-controls` | 悬停后直接取色 | 取色前确认窗口有焦点、指针命中按钮、按钮处于 `:hover`；不满足时重新聚焦重做一次，记下 `hoverRetries` |

按住时长、门槛与取色的判定都没有改。`tests/shell/search-box-ui.test.tsx`：先在测试里把按键监听的注册推迟 300 ms 复现了“找不到 `search-box`”，再把 `openBox` 改为等搜索框出现、只在没出现时再按一次 `Ctrl+K`；在放慢的环境里通过后去掉了复现代码，14 条用例通过，断言不变。

<a id="walks"></a>
## 8. 走查与测试的迁移

断言不减。改写与替代：

| 原来 | 现在 | 替代的断言 |
| --- | --- | --- |
| `measurePaneBench` 数页面里的 `bubble-note-*` 节点作为“已载入的消息数” | 读虚拟列表的 `data-count` | 列表只画看得见的行，节点数不再等于载入数；“载入 ≥ 1000 条”的断言照旧，改由列表自己报的数目判断。页面节点数另由 `chat-long-session` 断言不超过 60 |
| 四宫格基准的第四栏是一篇笔记标签（`openNote`、`ids.note`） | 项目的文稿页（`openDraft`、`ids.draft`，在项目上下文里） | “四栏都画出”“晚到帧 ≤ 2 %”“内存增量 ≤ 600 MiB”的断言不变 |
| v7—v12 迁移用例断言 `PRODUCT_SCHEMA_VERSION` 为 12、迁移到 12 | 断言为 13、迁移到 13 | 各自的转换断言不变；v12 → v13 另有 `schema-v13-migration.test.ts` |
| 模型档案的默认值 | 多出 `fileMiB`、`videoMiB`、`videoSeconds` | 原有字段的断言不变，新增上限的校验断言 |
| “设置 › 智能体”的用例宿主只有 `limits` 与 `trace` | 加 `media` | 原有断言不变，新增保留天数的用例 |
| 命令注册快照 | 加 `settings.cleanLegacyLocation` | 快照比较不变 |
| `search-box-ui` 的 `openBox` 只按一次 `Ctrl+K` | 等搜索框出现，没出现时再按 | 14 条用例的断言不变 |
| 同步的 `CredentialVault` 与内联的 `FrozenImage.base64` | 异步接口与哈希引用 | 原有凭据与冻结图像的用例按新接口调用（`await`），断言不变；新增写回、并发、v13 迁移的用例 |

新增的走查（`loop` 阶段、`credentials-async`、`migrate-v13`、`data-locations-*`）与它们核对的内容见[质量门禁](../dev-rules/quality-gates.md#2-阶段证据入口)。

<a id="gate"></a>
## 9. 门禁与基准

最终源码上的门禁由 A 在审查时（2026-11-06）用 `node scripts/stage.mjs gate` 跑完（Windows 开发机，Node 26.12.1，不是基准参考机；第 11 节）。整套用时约 51 分钟：verify 24 s、test 69 s（同一组输入上已通过，这次沿用）、package 699 s、installer 150 s、bench 769 s、第 2、3 次 package 701 s 与 703 s、report。

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify.mjs` | passed（最终源码，审查的文档改动之后整套再跑一次）：类型检查、knip、文档检查、发布检查、依赖边界与全部 Vitest 用例 |
| `node scripts/stage.mjs test` | passed：必需用例 184/184；Vitest 2818 个用例，2808 passed、10 skipped（默认关闭的真实服务与真实样本探针） |
| `node scripts/stage.mjs package` | 连续三次 passed（`passStreak` 3）：Electron 45.0.0 未签名本地包，25 个烟测阶段，117 个窗口观察全部通过；临时目录删除 26 个、剩 0 个 |
| `node scripts/stage.mjs installer` | passed（见第 5 节） |
| `node scripts/stage.mjs bench` | passed：58 项门槛全部在目标内；基准自己的进程与窗口都关闭了节能降速（`records.powerThrottling`） |
| `node scripts/stage.mjs report` | passed；`productAcceptance` 恒为 not-run |

与本阶段相关或靠近门槛的数字（ms，门槛在括号里）：对话 5000 条打开 p95 56.7（300）、输入 3.2（50）、连续滚动晚到帧 0 %（2 %）、翻出更早一页 24.2（150）；截取 60 s 片段 131.5（2000）；冻结 4 MB 图像 28.7（200）；导图 1000 个节点折叠 p95 43.7（100）、白板打开 36.1（1500）、30 MiB EPUB 末尾 712.4（2000）、扫描期间事件循环 p99 40.2（100）、调用追踪开销 p95 2.6（10）、笔记文件写入 3.5（25）。记录项：扫描吞吐 164—167 文件/秒；v12 → v13 迁移（300 次运行、340 张图像去重为 201 份）16 ms，数据库 3.5 MiB → 2.5 MiB；从旧位置升级复制 501 MiB（51 个文件）1.5 s。

B 交付时的情况：最终源码上 verify、test、连续三次 package 与 installer 已通过；bench 与 report 那一轮被用户叫停，最后一次跑完的基准（只比最终源码少 BT 基准删除临时目录的几行）58 项全部通过。之前几轮的失败：网络 504 一次；`formats` 读错了隐藏面板的正文两次，`frame-resize` 的拖动丢了移动一次，`split-focus-keys` 一次（后两次失败时机器正被使用）；修正见第 10 节。

证据：`docs/evidence/gate/` 已整体替换为这次的结果（约 2 MiB）：各入口的 JSON、`gate-run.json`（每步用时），以及四张截图：长对话列表、运行详情里过期的图像占位、设置的位置页（三组，路径是合成的临时目录、不含账户名）、用 Electron 44 保存的凭据在新版本上测试连接通过。模型弹窗那张截图停在弹窗顶部、没有拍到 PDF 与视频的上限（走查截图前没有滚动到那一节，断言本身核对了上限的输入框），所以没有入库，见第 10 节。

<a id="limits"></a>
## 10. 偏差、限制与后续

- **“从笔记跳到一条还没载入的消息”没有产品入口。** 列表的跳转机制（先载入更早的页、再居中并高亮）已实现并有单元用例；产品里还没有从笔记或别处请求它的入口，所以 `chat-long-session` 的跳转一步记为 not-run，人工检查 H-81 写明了这一点。
- **5000 条消息的样本里没有录音条目**，只有提问、回答与笔记。
- **“旧版本跟着标记打开新位置”用本版本模拟。** 没有保留上一版本的打包产物可以启动；`data-locations-upgrade` 用本版本按旧指针启动，这条路径（旧指针 → 旧根 → `authoritativeRoot` 跟随标记）在 `e05fda3` 里就已存在。这一步只核对应用数据跟到新位置：用户文件留在原处是新指针里的覆盖，旧版本不读新指针；而且迁移后的库是 v13，旧版本本来就拒绝打开（`migrate-v13-newer`）。
- **新走查发现并修复的问题。** 这些问题都是首次在打包窗口里跑本阶段的新走查时发现的：
  - 保存过、但所有标签都已关掉的上下文，重新载入时又被放上默认标签（LOOP-24 第 1 项，控制器只在从没保存过时放默认标签，新增控制器用例）。
  - 长对话贴底的两处问题，见第 4 节，新增列表用例。
- **走查本身的修正**（都不减断言）：
  - 搜索框结果行的选择器。
  - “最近”重新载入后先回到主页再切换上下文。
  - 被删的旧笔记按时间戳选在已载入页里。
  - 回退为帧图时不要求请求里有图（帧图由模型经工具取，替身模型不取；判断依据是发送记录的类型与原因，与单元用例 AT-146 相同）。
  - 运行详情的入口先把列表滚到那条消息（列表虚拟化后，旧消息不在页面里）。
  - 凭据走查改按页面上的“测试连接”（`connections.probe`，结果留在连接上），打开页面前重新载入，因为连接是在主进程里改的。重启后把两条连接重新指向这次启动的替身模型，密钥不动。
  - v13 迁移的重试改用一条“刚失败”的旧运行。种子里的运行是成功的、授权是占位的、没有预算，成功的运行重试时什么也不发。
  - 位置走查先把资源库目录加为资源库路径。
  - 临时目录的删除在 Windows 晚释放句柄时重试。
  - 对话栏基准（`bench-chat`，本阶段新增）第一次完整运行时没有取到样本。修正：等带 `:user` 后缀的消息节点；停靠栏选问答模式（笔记模式只列笔记）；切换时点阅读器标签（作品主页的标签与书同名）；载入更早一页前先用滚轮向上（贴底的库把没有滚轮的程序滚动当成内容变化，又贴回底部）。已有基准的测量方法不变。
  - 工作区基准的标签切换：以前三个书架各开一个资源库标签；现在资源库标签至多一个（LOOP-24 第 4 项），这一栏只剩 7 个标签，低于门禁要求的 8 个。现在多开第二个视频，这一栏有 8 个标签，其中 4 个是阅读器；测量方法与门槛不变。
  - `frame-resize` 的拖动：以前只在列宽完全没动时重拖一次。最终门禁里有一次只动了 1 px（后面的移动丢了，当时机器正被使用、负载约 34%）。现在没到指针的位置也重拖一次，只拖还差的距离；判断（拖动中与保存后的宽度在 ±3 px 内）不变。
  - BT 回环基准（`bench-bt.mjs`）用的测试辅助件会在系统临时目录建 `manga-test-*` 与 `manga-plugin-*`，用完没删。以前的基准都因为别的指标失败而保留现场，这个问题被盖住了；指标全部通过后，LOOP-26 的检查把它查了出来。现在基准结束时只删这次新建的同类目录，原有的不动。
  - trace 走查读剪贴板改为等到内容出现（最多 4 s），断言不变。
  - 截图前等两帧，最多等 1 s。被遮住的窗口不出帧，`reading-loop` 曾因此在写完报告后卡到超时。但只设上限，截到的就是窗口上一次画出的画面：`ui-settings-locations.png` 截成了先前的“资源库”页，而页面上其实已经是“常规”。现在等不到帧时，先不抢焦点地显示窗口并要求重画，再等一次；仍然没有帧就不截图，只记错误。位置走查记录截图前后各是哪一页，不是“常规”时算失败。
- **截图发现的界面问题**：“常规”页的三组位置，组名贴着卡片左边、组内的行没有分隔线（本阶段新增的界面）。现在组名与行对齐，组内的行有分隔线（`styles-workspace.css`）。
- **运行详情显示冻结的图像**：本阶段新增的界面，为了让过期占位在窗口里可见。
- **`formats` 阶段在最终源码上失败了两次。** 两次都是重新载入后第一个打开的 TXT 判为没有显示。补记的诊断表明：获得焦点的就是 `sample.txt` 的阅读器，但检查读到的正文是前一阶段留下的另一本书。前一阶段恢复的阅读器仍挂在隐藏的面板里，`document.querySelector` 先找到了它。单独跑这个阶段时没有恢复的阅读器，所以不出现。现在只读获得焦点的面板里的正文与页面图像，判断更严，没有放宽；失败时仍记录 `misses`。
- **Vitest 仍在系统临时目录留下少量目录。** 一次完整 `stage test` 约留 4 个（`manga-plugin-*` 来自 `tests/helpers/plugin-fixtures.ts` 的 `tmpDir()`，`manga-test-*` 来自 `tests/helpers/app.ts`；个别用例没有删）。上一阶段就有，不影响门禁；LOOP-26 只覆盖打包烟测与基准。登记为执行状态的后续项。
- **模型弹窗的截图没有拍到上限一节。** `ui-model-limits.png` 停在弹窗顶部；上限输入框由走查的断言核对，截图前没有滚动到“模型能力”一节。下次改这条走查时先滚动再截图（[LOOP-29](status.md#loop-29) 一并处理），人工检查 H-82 照常覆盖。
- 真实模型对 PDF 与视频输入的试验需要 [ACT-14](../../USER-ACTIONS.md#act-14)；真实 Profile 的迁移重放归 [ACT-11](../../USER-ACTIONS.md#act-11)。

<a id="review"></a>
## 11. A 的集中审查（2026-11-06）

**按计划第 9 节逐项核对，结论：可以合并，没有需要退回 B 的缺口。**

| 审查点 | 结论 |
| --- | --- |
| 凭据 | 六处解密都经 `readCredential`；同一凭据同时读取只解一次；平台换钥后只在密文未变时写回（`UPDATE … WHERE ciphertext = ?`），写回失败不影响读取；没有平台保护时先拒绝、不取走秘密、不写明文。源码里没有同步的 `safeStorage` 调用（`check-deps` 守护） |
| v13 迁移 | 在迁移事务里分批移出内联图像，迁移前后按字节重算的哈希多重集合不等就抛错、整个事务回滚；备份、中断与较新版本拒绝由既有迁移框架与 `migrate-v13`、`migrate-v13-newer` 覆盖 |
| 保留期与重试 | 清理只动已结束的运行，在事务里再确认一次状态，重试中的运行不会被清；读取图像一条语句取出并校验哈希；过期后按来源重新提取前核对修订与文件戳 |
| PDF 与视频 | 四个条件（模型档案、运行时与协议、整份且由用户放入并读完、大小与预算）都满足才发原文件或片段，否则退回并记原因代码，调用记录不含内容；片段终点取区间终点、当前位置与防剧透上限的最小值，PDF 发送时再核对哈希 |
| 位置迁移 | 只复制应用数据的分区（不含 `cache`），逐分区比对指纹、数据库做完整性检查后才写新指针；失败或中断时删掉已复制的部分、不写指针、本次用旧位置，下次重试；旧文件不删，旧根写标记与 `relocatedRoot`；“文档”“下载”取系统登记的位置。旧指针指向自选的根时也会搬到新位置，这是计划 4.9 第一段的约定 |
| 安装与卸载 | 只装到临时目录，结束时核对开始菜单、快捷方式与卸载项都清掉 |
| 门禁里的走查修正 | 第 8 个标签（多开一个视频）、等不到帧就不截图、`formats` 只读获得焦点的面板、`frame-resize` 补拖剩余距离、BT 基准只删本次新建的同类临时目录：都只改走查本身，断言、门槛与测量方法不变 |
| LOOP-13 | `power-throttling.mjs` 只由 `stage bench` 调用；`power-throttling.ts` 只在 `--manga-smoke` 的 `bench*` 阶段且 `MANGA_BENCH_NO_THROTTLE=1` 时执行，产品不调用 |

**A 在审查中直接做的改动（门禁的效率，LOOP-27）。** 用户指出 B 的门禁太慢：最终门禁一轮约 68 分钟（verify 8、test 8、package 3 × 12、installer 2、bench 与 report 13），B 在约 5 小时里开了 7 轮。原因与处理：

| 原因 | 处理 |
| --- | --- |
| 任何改动都让全部结果过期（四类指纹，每份结果都比全部） | 指纹按输入分组（产品源码、锁文件、构建、门禁公共代码，以及测试、打包、基准、安装各自的脚本），报告只比较这份结果依赖的组（`gate.json` 的 `fingerprintOf`）；`scripts/stage` 与 `scripts/samples` 下没有归组的文件直接报错。指纹在运行开始时取，运行期间的修改让结果判为过期 |
| 测试逐个文件跑（`fileParallelism: false`，从最早的阶段沿用、没有记录原因），而且 verify 与 stage test 各跑一遍 | Vitest 按文件并行、用一半逻辑处理器：约 70 s（原约 480 s）；8 次完整运行里只有改之前的第一次失败一处，是 `sidebar-ui` 的一处用例在首次渲染后同步取元素，改为等它出现（断言不变）。`stage gate` 里的 verify 带 `--skip-tests`，测试只跑一遍 |
| 基准排在最后，问题最晚暴露 | `node scripts/stage.mjs gate`：verify → test → package → installer → bench → 把 package 补到连续 3 次 → report，第一个失败就停，结果仍有效的步骤不重跑 |
| 连续三次打包靠人数 | `package.json` 记 `passStreak`，报告要求 ≥ 3；`installer` 只接受当前输入打出的包，`installer.json` 也由报告核对 |
| 打包时联网取 Electron 的校验和，GitHub 504 让一轮作废 | 改用已安装的 `electron` 包自带的 `checksums.json` |

新增的报告自测：只改基准代码时只有 `bench.json` 过期；只改测试时只有测试结果过期；改产品源码时全部过期；未归组的脚本报错；连续通过不足与安装失败或缺失都被拒绝。窗口走查里约 430 处固定等待登记为 [LOOP-29](status.md#loop-29)，下一阶段处理。

**最终源码上的门禁**：见[第 9 节](#gate)。
