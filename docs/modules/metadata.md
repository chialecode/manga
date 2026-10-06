# 元数据模块

| 字段 | 内容 |
| --- | --- |
| 模块 ID / 产品名称 / 负责人 | `manga.metadata` / 元数据与封面 / 开发者 |
| 文档状态 / 实现状态 | M2 已实现并自检（产品验收 not-run，见 [M2 交付报告](../evidence/m2-media-mvp-delivery.md)）；Bangumi 只读契约测试已用真实服务执行并通过（≤ 10 次请求）；人工检查见[用户待办](../../USER-ACTIONS.md#checks)的 H-M2-02。**M2 返工已实施并自检**（产品验收 not-run）：只在作品主页手动匹配、按条目 ID 或链接关联、关联与刷新先预览差异、不自动同步；网络资料、封面原图、角色与声优、制作人员存数据库（A-51），实施与证据见[M2 交付报告第 16 节](../evidence/m2-media-mvp-delivery.md#16-返工交付2026-10-06)；真实契约测试已增加角色与制作人员两个端点并通过 |
| 需求 / 阶段 / 设计依据 | META-01—03、LIB-02；M2；[外部扩展设计 3.3](../design/external-providers-and-acquisition.md#33-首个实现bangumim2)、[领域模型](../design/domain-model.md) |
| 包与公开入口 | `packages/app-core/src/metadata`；命令 `metadata.providers`、`setProvider`、`search`、`candidates`、`link`、`unlink`、`refresh`、`related`、`findMissing`，以及返工新增的 `metadata.resolveRef`、`metadata.preview`、`metadata.characters`；库命令 `works.setOverride`、`covers.list/select/lock/fromImage/handles` |

## 1. 责任与依赖

拥有元数据来源注册（`OnlineProvider` 接口：`search`/`detail`/`image`/`pageUrl`）、搜索与候选、作品—条目关联、抓取快照、字段投影与封面候选。不拥有作品身份（本地作品 ID 独立于站点 ID）、封面的最终选择（归资料库 `covers.*`）和进度。Feature `metadata`；Facet `service`/`ui`；硬依赖 `manga.library`；可整体关闭，关闭后只剩本地来源。

**来源：** 在线来源首个实现为 Bangumi API v0（只读，类型来自固定提交的官方 OpenAPI，Zod 在运行时校验用到的字段；允许的主机白名单，重定向到白名单外一律拒绝，白名单内的重定向逐跳重新检查后才跟随；桌面宿主经 Electron 网络栈请求（跟随系统代理），其中手动重定向由 `net.request` 取得 3xx 应答，因为 `net.fetch` 遇到手动重定向会直接报错（`apps/desktop/src/main/net-fetch.ts`，A 审查 F-01）；私网/回环地址拒绝；单体与图片大小上限；限流 429/5xx 时按 `Retry-After` 退避重试，仍被拒绝则报告为可重试错误；401/403 认证失败不重试）。本地来源 `local-file` 读取文件自带资料：ComicInfo.xml、EPUB OPF、MOBI EXTH、PDF Info、视频标签与封面，不访问网络。第二个来源（测试中的替身）证明来源可替换而不动资料库。字段合并优先级：用户覆盖或锁定 → 已确认的在线来源 → 文件内置 → 文件名 → 已脱离的快照；缺字段的来源不清空别的来源的值。

## 2. 数据与公开能力

- 数据：`work_links`（作品—条目关联，含命名空间、条目类型、关联状态、匹配依据、证据）、`metadata_snapshots`（抓取字段、来源地址、抓取时间、API 版本、是否脱离）、`metadata_candidates`（搜索结果与状态，不含远端图片地址）、`covers`（file/bangumi/user 三种来源；原图在附件区，缩略图在缓存区）、作品 `projection_json`（每个字段保留全部候选与胜出来源）。
- 搜索：`metadata.search` 支持单源、回退、多源三种模式，部分来源失败时返回 `partial` 与失败清单；视频按动画类型搜索并保留集标题，从文件名给出清洗后的建议词；候选图片只由主进程拉取并转为短期句柄（渲染进程不拿到远端地址）；非图片或过大的候选图被丢弃而候选保留。
- 关联：`metadata.link` 只在用户确认后写入（高置信自动匹配不做，Q-15）；已关联到另一作品的条目会标注，多作品关联同一条目只在用户明确选择时发生；`unlink` 把已存详情保留为脱离快照，可再关联；`refresh` 不改变用户覆盖与锁定；来源不可达时返回过期状态并保留旧快照；换源（`setProvider`/多来源）不改变进度和引用。
- 相关作品：`metadata.related` 返回 Bangumi 关联条目（标注关系、标记本库已有）和本库中标签相近的作品（不调用模型）；`findMissing` 在后台为未关联作品批量搜索，只产出候选，从不自动关联，模块停用时取消。
- 封面：自动封面按来源等级升级（文件 < Bangumi < 用户），用户锁定的封面永不被替换；用户指定的图片必须是用户选择的路径句柄且是图片，≤ 32 MiB；Bangumi/用户封面原图进入备份，是否随资料包导出为 Q-20。
- **手动匹配与预览（A-51）：** 只从作品主页发起（书架不再有“为未匹配作品查找”的入口，`findMissing` 命令保留、只生成候选）。`metadata.resolveRef` 接受条目号、`subject/<号>` 或 `bgm.tv`、`bangumi.tv`、`chii.in`（可带 `www.`）的条目页地址，只取出号码，地址本身不被请求或保存；角色页、人物页、其他页面与带多余路径的地址以具体原因拒绝。`metadata.preview` 取得条目并返回字段与封面相对当前投影的差异，不写库；用户逐项选择后 `link`/`refresh` 才写入，选择保留本地值的字段以覆盖形式保存来源值，使之后可“恢复来源值”；刚预览过的条目（最多 8 个、短时间内）在应用时不再请求远端。用户覆盖与锁定优先，远端缺字段不清空本地。
- **角色与制作人员：** 关联与刷新时保存角色（含声优）与制作人员（`subject_characters`、`subject_persons`，`GET /v0/subjects/{id}/characters` 与 `/persons`），头像只取 `grid`/`small` 尺寸、每个条目最多 20 个（`MAX_AVATARS`），失败不影响关联；`metadata.characters` 读取已存的结果。
- **图片表（A-51）：** 封面原图（Bangumi 与用户指定）与头像存入 `images` 表，以内容哈希去重，列表查询不读字节；文件提取的封面仍是可重建缓存。v7 → v8 迁移把已有的封面原图文件导入图片表并核对哈希，缺失或哈希不符的保留文件引用（`area = attachments`）。资料包导出默认附带封面原图。
- 凭据：Bangumi token 可选，只存受保护的凭据库，仅发往配置的 API 源（API 请求被重定向到其他允许主机时也不携带），不发往图片主机，不进入日志、事件、导出或 Agent 上下文。
- 错误：来源关闭 `CAPABILITY_UNAVAILABLE`；条目不存在或应答不合规 `NOT_FOUND`/校验错误且不写入任何数据；Agent 调用 `FORBIDDEN`。

## 3. Agent 与界面

界面：作品主页的“匹配资料”流程（粘贴号码或链接、关键词搜索、差异预览与逐项选择、字段来源与抓取时间、角色与制作人员、相关作品、集标题）；空字段也显示并可手动填写，可锁定、可恢复来源值、封面选择（候选/文件提取/本地图片/锁定）、设置中的来源开关与 token。断网时库、已关联详情和封面照常，搜索显示失败原因而不抛错。`metadata.*` 与 `covers.*` 全部只给所有者：Agent 调用一律 `FORBIDDEN`、不触发任何网络请求，Agent 看到的作品视图也不含关联来源详情（`tests/metadata/metadata-commands.test.ts`）。网络请求跟随系统代理，不内置代理（Q-19）。

## 4. 生命周期与兼容

停用：取消网络请求与后台批量搜索，撤销候选图片句柄；已确认资料、覆盖和封面保留，重新启用后立即可用。停用期间的用户修改不会被重新启用后的刷新覆盖。资料包导出包含关联、快照、候选和附件封面（Q-20 的默认值可调整）。数据由 v6 迁移追加，旧资料不改写。

## 5. 验证与未决

自动：`tests/metadata`（Bangumi 客户端的限流/重定向/大小/认证、本地文件元数据、命令流程、覆盖与锁、第二来源、模块停用）、`tests/helpers/fake-bangumi.ts` 本地假服务；真实契约 `tests/real/bangumi-contract.test.ts`（`MANGA_LIVE_BANGUMI=1`，不进 CI；含角色与制作人员端点，一次运行不超过 10 个请求）、`tests/metadata/metadata-rework.test.ts`（链接解析、预览与应用、角色与人员、头像上限）；打包烟测覆盖导入与封面。未决：Q-15（自动高置信匹配阈值）、Q-19（大陆可达性与代理）、Q-20（封面随资料包导出）、Q-21（相似作品推荐）；人工项 H-M2-02。
