# 数据库与迁移

> 触发：修改数据库 schema、migration、FTS 索引、备份恢复或运行期数据库访问前。
> 设计依据见 [`docs/architecture.md`](../architecture.md) §6、§12。

## 1. 红线：已发布的 migration 不可修改

一旦某个 migration 文件进入过任何已发布版本，它的内容**永久冻结**。需要改动时只能追加新 migration。

由 `scripts/__tests__/migration-freeze.test.mjs` 拦截：它比对 `packages/data/migrations/` 下每个文件的哈希与 `migrations.lock.json` 中的记录。

修改已发布 migration 会让已升级用户的数据库与新装用户的数据库出现结构差异，且无法检测。**这是 P0。**

## 2. 分工

| 工具 | 职责 | 不做什么 |
|---|---|---|
| drizzle-orm | schema 单一事实源、类型导出 | 不执行热路径查询 |
| drizzle-kit | 从 schema 生成迁移 SQL | 不在运行时出现 |
| 自研执行器 | 按 `PRAGMA user_version` 顺序执行迁移 | — |
| `db.prepare()` | 全部运行期查询 | — |

**热路径查询用原生 SQL + 预编译语句**，在模块加载时一次性 `prepare` 并复用。媒体库列表、搜索、页面查询、锚点查询都属于热路径。

理由：SQLite 上真正影响性能的是查询计划与语句复用，查询构建器在这两点上没有帮助，反而遮蔽了 `EXPLAIN QUERY PLAN` 的可读性。

## 3. 连接配置

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -32000;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;
```

**例外**：锚点、笔记、录音元数据的写入使用独立的 `synchronous = FULL` 事务。这些是用户不可再生的产出，值得为它们付出额外的 fsync。

## 4. 并发

- **只有 `svc-db` 进程持有写连接。** 其他进程通过 RPC 提交写操作。
- 只读查询在 `svc-db` 内用独立只读连接并发执行。
- 不使用 shared cache（better-sqlite3 默认已 `SQLITE_OMIT_SHARED_CACHE`）。
- 长事务禁止跨 RPC 调用边界。需要多步原子性时，把整个操作做成一个 RPC 方法。

## 5. 迁移的三道闸门

| 闸门 | 断言 |
|---|---|
| `migration-freeze` | 已发布迁移文件哈希未变 |
| `validate-migrations` | 序号连续、无重复、每个迁移有对应的回滚说明文档（说明文档，不是回滚脚本） |
| `migration-replay` | 从每个历史版本的空库重放到最新，得到的结构与直接建库一致 |

三者都在 `pnpm test:migration` 中运行，且是 CI 阻塞项。

## 6. 写迁移

- 每个迁移一个文件，命名 `NNNN_<slug>.sql`，序号连续。
- 整个迁移在单事务内执行。SQLite 支持事务性 DDL，利用它。
- 执行器在跑迁移前自动 `VACUUM INTO` 生成备份到 `data/backup-pre-<version>.sqlite`，成功后保留最近 3 份。
- 表重建（SQLite 的 ALTER 限制导致的 create-copy-drop-rename）必须先 `PRAGMA foreign_keys=OFF`，重建后 `PRAGMA foreign_key_check`，再恢复。这个顺序写进模板，不要临时发挥。
- 每个迁移在 `docs/adr/` 或迁移文件头部注释中说明：为什么改、旧数据如何处理、不可逆之处在哪。

## 7. FTS5

- 分词器固定为 `trigram`。better-sqlite3 未编译 ICU，`unicode61` 对中日文无效。
- 排序用 `bm25(search_fts, 8.0, 4.0, 2.0, 1.0)`（标题 / 别名 / 标签 / 正文）。
- **小说正文与字幕文本默认不建索引**，由用户按单本 / 单集触发。trigram 索引体积约为原文 3–4 倍，全量索引会让数据库膨胀到 GB 级。
- schema 中保留 `tokenizer_version` 字段。将来更换分词策略时，据此做后台增量重建，而不是阻塞式全量重建。

## 8. 备份与恢复

- 备份用 SQLite Online Backup API（`db.backup()`），产生一致快照且不阻塞写入。**不要**用文件复制。
- 备份包为 zip：`db.sqlite` + `assets/`（录音、抽取字幕）+ `manifest.json`（schema 版本、库根路径映射表、生成时间）。
- 恢复：校验 schema 版本 → 若旧则先跑迁移 → 替换文件 → 应用路径映射表。
- 跨机器迁移依赖 `manifest.json` 的路径映射表。因锚点绑定 `file.id` 而非路径，映射后全部锚点存活。

## 9. 崩溃一致性

启动时必须执行：

```sql
UPDATE task SET state='pending', attempts=attempts+1
WHERE state='running' AND lease_until < :now;
```

否则崩溃前正在执行的任务会永久停留在 `running`，成为僵尸。

`pnpm test:db` 中包含随机 kill 测试：写入压力下随机 `taskkill /F`，重启后校验 `PRAGMA integrity_check` 为 ok、无僵尸任务、已提交事务无丢失。

## 10. 新增表检查表

- [ ] 主键为 `INTEGER PRIMARY KEY`（rowid 别名，不用 UUID 做主键）
- [ ] 时间字段为 `INTEGER`，单位毫秒，命名以 `_at` 或 `_ms` 结尾
- [ ] 外键写明 `ON DELETE` 行为，且行为是有意选择的（`RESTRICT` 用于阻止误删有引用的数据）
- [ ] 枚举列有 `CHECK` 约束
- [ ] JSON 列有 `CHECK (json_valid(col))`，且关键字段有 `json_extract` 的 `CHECK`
- [ ] 查询模式对应的索引已建，且用 `EXPLAIN QUERY PLAN` 验证过
- [ ] 部分索引优先（`WHERE status <> 'valid'` 这类）
- [ ] 若属于派生内容（L5），有 `derived INTEGER NOT NULL DEFAULT 1 CHECK (derived = 1)`
