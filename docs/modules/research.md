# 材料搜寻模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.research` / 材料搜寻 / 开发者 |
| 文档状态 / 实现状态 | 已实现并自检（产品验收 not-run，见[执行状态](../delivery/status.md)）；联网只测过受控服务器，真实网页未测 |
| 需求 / 设计依据 | CRE-06、SEARCH-01、AT-30、ACQ-03；[领域模型](../design/domain-model.md)、[外部扩展设计](../design/external-providers-and-acquisition.md) |
| 包与公开入口 | `packages/app-core/src/creative/research.ts`、`extract.ts`、`packages/app-core/src/net/broker.ts`；命令 `research.search`、`webpage.fetch`、`webpage.list`、`webpage.get`、`webpage.delete`、`excerpt.create`、`list`、`get`、`update`、`delete`、`follow`；界面 `apps/desktop/src/renderer/pages/projects/research/` |

## 1. 责任与依赖

拥有两件事：对个人材料的统一搜索，以及网页摘录。网页以版本保存（同一地址内容变了就多一个版本），摘录指向其中一个版本，所以摘录永远说的是取下来那一刻页面的内容。不拥有被搜到的作品、笔记、录音与它们的索引（归各自模块）。

Feature `research`；Facet `service`/`ui`；硬依赖 `manga.library`，不依赖项目模块：不属于任何项目的摘录与页面照样保存，加入项目是一条材料引用。无 AI 时完全可用；本模块不调用任何模型。

**联网边界（ACQ-03）。** 本模块只有一个对外动作：取用户给出的那一个地址，且只经网络代理（`NetworkBroker`）。代理只接受 http 与 https；每一跳重定向都重新检查，名字解析到私网、回环、链路本地、共享或保留地址的一律拒绝（有一个解析结果是私网就拒绝），不从 https 降到 http；不带 cookie 和任何凭据；超时 15 秒、最多 5 跳、响应最多 2 MiB，内容类型必须是网页或文本；调用方拿到的是文本，不是流，也看不到不该看的响应头。内置网页搜索引擎没有做（需要另配 API 密钥，以后按需求再定）。

## 2. 数据与公开能力

- 数据：`excerpt_pages`（地址去掉 `#` 之后的部分、标题、获取时间、正文哈希、正文、版本号、上一版本）、`excerpts`（所在页面版本、起止偏移、文字、标题、备注、所属项目）、检索表 `research_idx`。上限：页面最多 2000 个地址、每个地址保留 20 个版本（超出时删最旧的，但被摘录指着的版本不删）、摘录最多 2 万条、单条摘录文字最长 2 万字、页面正文最长 40 万字。
- 取页（`webpage.fetch`）：只解析不运行页面——没有脚本执行，也不加载页面指向的任何资源；Readability 取正文，不是文章的页面（列表、表格、短文）回退到页面主体文字；`text/plain` 直接用。内容与上一版哈希相同不新增版本；不同则新增版本并告知“已变化”；没有可读文字以 `UNSUPPORTED_FORMAT` 拒绝。
- 摘录（`excerpt.create`）：在某一页面版本里选一段文字（偏移按码点），可直接加入项目。页面之后变了：`excerpt.follow` 在最新版本里找同一段（先原样、再容忍空白变化），找到就为最新版本另建一条摘录，旧摘录原样保留；找不到返回 `missing`，由用户决定。
- 搜索（`research.search`）：范围 `work`、`note`、`recording`、`excerpt`、`page`，可限定在某个项目；结果各带种类、位置和命中处前后的一段文字，并按范围给出计数；中日文可用；删除的内容不再出现在结果里。
- 数据身份：页面与摘录里的文字是数据，永远不被当作指令或授权（见[Agent 与插件开发规则](../dev-rules/agent-and-plugins.md)）。

## 3. Agent 与界面

命令在同一个网关注册，界面经这一入口调用。Agent 在本项目的会话里可以读本地材料的搜索（`research.search`）、摘录与网页版本（`excerpt.list/get`、`webpage.list/get`）；取页、保存摘录和语义检索仍是所有者命令（A-73），其中取页是外部访问、语义检索会调用付费的外部服务，都不因资料读取权限而放宽。开放取页时它属于“外部访问”类动作，授权按任务或范围复用，资料查询权限不会自动扩大为任意下载。界面：项目页的“摘录”标签，上半部分是搜索框与按范围分组的结果（点击打开所在位置：作品位置、笔记、录音、摘录或页面），下半部分是取页：粘贴地址、取页、显示正文，选中文字后保存为摘录并可加入项目，页面已变化时提示，可“在新版本里找同一段”。键盘可完成搜索、取页与保存。

## 4. 生命周期与兼容

停用：入口撤销，取页中的请求被取消，页面与摘录保留可读，项目里指向它们的材料行显示“模块已关闭”。页面与摘录随项目包与资料包往返（相同地址与相同正文的页面不重复保存）；索引不进包，导入后重建。

## 5. 验证与未决

自动：`tests/creative/research.test.ts`、`tests/net/broker.test.ts`、`tests/shell/research-ui.test.tsx`（AT-30、AT-47 的网络部分）。窗口：`creative-research`（本地搜索、对受控服务器取页与摘录）。限制：只能取一个给定地址，不爬取链接；需要登录或脚本渲染的页面取不到正文；没有内置搜索引擎；PDF 与图片不被识别为网页。
