# 弹幕模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.danmaku`（Feature `danmaku`）/ 弹幕 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检：假服务下的匹配、缓存、显示与设置、凭据隔离都有自动化验证，打包窗口里走过一遍；真实服务尚未验证（发行方的 AppId 还没有通过审核，见[用户待办 ACT-10](../../USER-ACTIONS.md#act-10)），产品验收 not-run，见[执行状态](../delivery/status.md) |
| 需求 / 阶段 / 设计依据 | READ-04；AT-94；A-81、Q-28；[阶段计划第 15 节](../delivery/stage-plan.md#review-rework-2)、[交互设计 3.7](../design/interaction-and-workflows.md) |
| 包与公开入口 | `packages/app-core/src/danmaku/`（`sign.ts` 签名、`client.ts` 客户端、`parse.ts` 解析、`service.ts` 匹配与缓存）；`packages/contracts/src/inputs-danmaku.ts`；渲染进程 `apps/desktop/src/renderer/readers/danmaku-*.ts(x)`、`hooks/use-danmaku*.ts`、`pages/settings/danmaku-page.tsx`；主进程的凭据 `apps/desktop/src/main/danmaku-credentials.ts` 与构建注入 `apps/desktop/danmaku-define.ts`；命令 `danmaku.status`、`danmaku.match`、`danmaku.search`、`danmaku.choose`、`danmaku.setOffset`、`danmaku.load`、`danmaku.getSettings`、`danmaku.setSettings`、`danmaku.setCredentials`、`danmaku.clearCache`、`danmaku.around` |

## 1. 责任与依赖

拥有弹幕的来源接入（弹弹play 开放 API v2）、剧集匹配及其保存、评论缓存、显示设置与屏蔽规则、用户自己填的凭据。不拥有作品与资源的身份（归资料库）、播放（归视频模块）、条目映射（归元数据模块，只读取）。

- Feature `danmaku`；Facet `service`（命令与网络）与 `ui`（播放器里的弹幕层与设置页）；提供能力 `manga.danmaku` 1.0.0；硬依赖 `manga.library`，可选依赖 `manga.video`（没有视频模块时没有可显示的地方，命令仍可用）。
- 所有命令只接受所有者授权。网络请求只由 `danmaku.match`、`danmaku.search`、`danmaku.load` 发出，在主进程里，跟随系统代理。
- **凭据（Q-28）：** 发行方申请一份 AppId 与 AppSecret，构建时从环境变量 `MANGA_DANDANPLAY_APP_ID`、`MANGA_DANDANPLAY_APP_SECRET`（本机打包读被忽略的 `.env.local`，以后 CI 打包用加密变量）注入主进程；签名只在主进程里算，渲染进程、预加载桥、仓库、日志、证据与报告里都没有。设置里可以填自己的一份覆盖内置的，存进保险库；两者都没有时弹幕不可用，面板说明原因，不发送任何请求。冒烟与测试使用专门的假凭据，只连到本机回环地址上的假服务。
- **没有 AI、没有界面、缺少提供者时：** 与 AI 无关；没有界面宿主时命令照常可用；视频模块或凭据缺失只让显示与请求不可用，不影响其他模块。

## 2. 数据与公开能力

- 数据（schema v10 起，见[领域模型](../design/domain-model.md)；v11 只增删除条目所需的表与列，弹幕表不变）：`danmaku_matches`（按资源版本保存来源、番剧与剧集编号、标题、偏移、方法 `bangumi|hash|name|manual`、是否用户确认、时间）；`danmaku_cache`（来源、剧集、获取与过期时间、条数、压缩后的内容，是可重建的派生缓存）；`danmaku_consent`（未关联 Bangumi 的作品是否允许发送文件的名称、指纹、大小与时长）。显示设置与屏蔽规则存在元数据键 `danmaku.settings`；自己的凭据只存保险库引用（`danmaku.credentialRef`）。
- 匹配：已关联 Bangumi 的作品先用条目映射找到弹弹play 的番剧，再按本集序号选剧集；否则用文件名（不含扩展名）、前 16 MiB 的 MD5、大小与时长匹配；都不确定时返回候选，由用户在搜索框里按番剧名与集数选。未关联的作品第一次匹配前返回 `needs_consent`，同意前不发送文件信息。结果按资源版本保存，可以重新选择、改偏移。
- 请求规则：只在用户打开这一集且弹幕开启时请求，不预取整季；缓存分三档（播出 100 天内约 1 小时、一般约 6 小时、播出一年以上约 3 天），读缓存不联网；手动刷新每集每分钟最多一次；302 跳转只跟随 https 的弹弹play 域名且不带签名头；403 读 `X-Error-Message`；429 按服务端要求退避，不自动反复重试；网络与限流时给出已过期的缓存并附原因。
- 解析：评论的 `p` 字段为“时间,模式,颜色,发送者”，模式 4 是底部、5 是顶部，其余已知模式（含逆向与定位）都按滚动显示，无法识别的丢弃；每集最多保留 30000 条，单条文字最多 200 字；时间以毫秒记，显示时加偏移；发送者前的 `[来源]` 前缀是可以关掉的来源。
- 错误：`DANMAKU_FAILURES`（`no_credentials`、`forbidden`、`rate_limited`、`network`、`bad_response`、`no_match`、`needs_consent`、`needs_choice`、`offline_cache_only`）都有中文说明，不静默无弹幕。
- Agent：只有 `danmaku.around`，取某一时刻附近的条数和少量评论，只读缓存，且不晚于已看过的位置（防剧透）；Agent 不能请求网络，也不能读写凭据。

## 3. Agent 与界面

- **显示：** 渲染进程用 `danmaku` 2.0.10 的 canvas 引擎，层覆盖画面所在的区域（不是整个播放器），在字幕与底栏之下，与播放、暂停、倍速、跳转同步，窗口大小、屏幕全屏与窗口全屏变化时自动调整。画布的数据属性（`data-count`、`data-visible`）供窗口检查使用。
- **播放器：** 底栏的弹幕按钮开关（默认键 D），旁边的小箭头打开面板：当前剧集与匹配方式、偏移微调（±0.5 s、±5 s，重置）、刷新、重新选择、搜索、未关联作品的“是否允许发送文件信息”。所有状态与失败原因都在面板里说明。
- **设置 › 弹幕：** 开关；不透明度、字号、速度、“弹幕速度跟随倍速”（默认开）、显示区域（1/4—全屏）；滚动、顶部、底部、彩色；相似合并；屏蔽词与正则（正则经检查，会被拒绝的写法见 `validPattern`）；来源开关；简繁转换；截图是否带弹幕；自己的凭据（覆盖内置的一份）；清除缓存。每处显示弹幕的地方都有“弹幕来自弹弹play开放弹幕网络”。
- **速度与倍速（A-92，AT-106）：** `danmaku` 的 `speed` 是“媒体时间每秒移动多少像素”，所以倍速为 2× 时屏幕上滚动弹幕快一倍、顶部与底部弹幕的停留时间减半。`readers/danmaku-model.ts` 的 `engineSpeed` 按“弹幕速度跟随倍速”换算：开（默认，与以前一致）时原样交给引擎；关时交给引擎的是设定速度 ÷ 当前倍速，屏幕上每秒移动的像素不变，`danmaku-engine.ts` 监听播放器的 `ratechange`：倍速变化时重算引擎的速度，并把每条正在显示的弹幕的起点按新旧速度之比挪动，使它在屏幕上的位置不跳；顶部与底部弹幕的停留时间由同一个速度决定，所以同样不随倍速变（`tests/danmaku/danmaku-rate.test.ts` 核对三种倍速下的屏幕速度、停留时间与换速时的位置连续）。
- **截图：** 默认不含弹幕；设置里选择带弹幕后，截图把屏幕上的评论合成进去。字幕另有“设置 › 阅读与播放”的“截图带字幕”（默认开），与弹幕互不影响，记录里的 `composited` 写出两者合成了什么。

## 4. 生命周期与兼容

- 停用：正在进行的请求被取消，界面入口消失；缓存、匹配与设置保留，重新启用后原样可用。
- 升级：schema v9 → v10 新建三张表，旧数据不受影响；新版本回退时三张表被忽略。
- 备份：匹配与设置随数据库备份；缓存可以重建，凭据引用只指向保险库，明文不进备份与资料包。
- 清除缓存只删除 `danmaku_cache`，不删匹配与设置。

## 5. 验证与未决

- 自动化：`tests/danmaku/` 下的客户端（签名、跳转、403/429）、模块（匹配、同意、缓存、刷新限频、设置、偏移、Agent 读取）、凭据（构建注入、渲染进程产物与日志里搜不到假凭据）、显示层与设置页；窗口检查 `danmaku-layer`、`danmaku-privacy`、`danmaku-network`（假服务看到的全是用假凭据签的请求、没有本地路径）。
- 基准：3000 条弹幕的一集在打包窗口里播放时晚到帧的占比；见[阶段报告](../delivery/stage-report.md#rework-2)。
- 限制：未用真实服务验证；未关联作品的匹配准确度取决于文件名；后续 loop：弹幕密度曲线与高能位置、相似弹幕的模糊合并，见[执行状态](../delivery/status.md#followup-loops)。
