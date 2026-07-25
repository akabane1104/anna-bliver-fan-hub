# 数据库版本迁移

本项目使用显式、版本化的 MySQL 迁移工具升级既有安装。迁移不会随 Backend
启动自动执行，也不会自动读取项目 `.env`。管理员必须先备份，再通过受控环境向
迁移进程提供 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD` 和 `DB_NAME`。
不要把密码放入命令行参数、Git 文件或终端记录。

## 安装路径

`backend/src/config/schema.sql` 只用于全新空数据库。它创建 27 张业务表及初始站点
设置；Docker 的初始化挂载也只会在全新空 MySQL volume 首次启动时执行该文件。

全新安装在执行 `schema.sql` 后，仍应执行版本化迁移的 `apply` 与 `postcheck`。
迁移会严格核对已经存在的五张 Phase 4B/4C 表，创建 `schema_migrations` 帐本，
并将完全相符的结构登记为已应用，不会重建这些表。

既有 22 表安装不得再次执行完整 `schema.sql`，必须使用本文件的迁移命令。

## 当前迁移

| 版本 | 名称 | Additive 变更 |
|---|---|---|
| `202607240001` | `phase_4b_4c_live_control` | 新增 `live_events`、`live_sessions`、`song_requests`、`song_request_history`、`song_aliases` |
| `202607240002` | `live_events_received_at_index` | 为 `live_events` 新增 `idx_live_event_received (received_at, id)` |

建立顺序为：

1. `live_events`：无外键。
2. `live_sessions`：引用既有 `playlists.id`、`users.id`。
3. `song_requests`：引用 `live_sessions.id`、既有 `users.id`、`songs.id`。
4. `song_request_history`：引用 `song_requests.id`、既有 `users.id`。
5. `song_aliases`：引用既有 `songs.id`、`users.id`。

第一份迁移只执行 additive `CREATE TABLE IF NOT EXISTS`。执行前后都会按列顺序、型别、
nullable、default、主键、唯一约束、索引、外键、engine、charset 与 collation
核对结构，因此不会把同名但不相容的表误认为成功。

第二份迁移只执行 `ALTER TABLE ... ADD INDEX`。`received_at` 是事件列表时间筛选
和 `received_at DESC, id DESC` 稳定排序前缀，`id` 是同时间戳的稳定键。Runner
会先检查指定索引或等价 `(received_at, id)` 非唯一索引：等价索引已存在时直接
采用，不会建立重复索引；同名但栏位顺序不符时 fail closed。隔离 MySQL 8
`EXPLAIN` 已验证事件排序和最近五分钟范围查询选择该索引。

## Migration catalog

Runner 只读取 `backend/migrations` 目录中符合
`<12位版本>_<小写名称>.sql` 的普通 SQL 文件，并要求每个版本都有内建结构
contract。SQL 文件名、contract 名称、唯一版本、依赖顺序或 catalog 完整性不符
都会 fail closed；不会加载任意路径、符号链接或未知 SQL。迁移按版本稳定排序，
在同一数据库 advisory lock 内依次执行。

Backend 最终 Docker image 将该目录复制到 `/app/migrations`，与 Runner 从
`/app/src/migrations/../../migrations` 解析出的实际位置一致。Compose 只提供
catalog 和数据库连接环境，不会在 Backend 启动时自动执行 migration。

`202607240002` 明确依赖 `202607240001`。空白／22 表安装先执行 R1，再建立 R4
索引；已登记 R1 的安装只执行 R4。每一份 migration 只有在 DDL 与独立 postcheck
成功后才写入自己的 ledger row。R4 失败不会把 `202607240002` 标记为已完成，
重跑时已登记且 checksum 相同的 R1 保持 no-op。

## 帐本与并发

迁移工具建立 `schema_migrations`，字段为：

- `version`：固定且唯一的版本，主键。
- `name`：迁移名称。
- `checksum`：迁移 SQL 原始 bytes 的 SHA-256。
- `state`：成功记录固定为 `applied`。
- `applied_at`：成功完成后的时间。

工具使用按数据库名派生的 MySQL advisory lock。无法立即取得 lock 时会非零退出，
不会等待或与另一进程重叠执行。每个相同版本与 checksum 重跑会先完成严格 postcheck，
然后返回 `noop`；相同版本但 checksum 不同会以
`migration_checksum_conflict` fail closed。

MySQL DDL 不是完整事务。工具不会宣称可以原子回滚：只有全部 DDL 及结构检查通过
后才写入成功帐本。如果执行途中失败，已建立且结构完全相符的表会在下一次
preflight 被识别，修复实际原因后可以安全重跑；任何不相容对象都会阻止继续。

## 部署命令

以下命令不会自动读取 `.env`。执行前应由受控 shell、systemd credential 或密钥
管理系统设置正确的 `DB_*` 环境变量，并确认目标数据库名称。

```bash
npm run db:migrate:status --prefix backend
npm run db:migrate:preflight --prefix backend
npm run db:migrate:apply --prefix backend
npm run db:migrate:postcheck --prefix backend
```

Docker Compose 部署先确认 `.env` 已通过初始化与密钥检查，并只启动目标项目的
MySQL。随后由最终 Backend image 明确执行：

```bash
docker compose --env-file .env up -d mysql
docker compose --env-file .env run --rm --no-deps backend npm run db:migrate:preflight
docker compose --env-file .env run --rm --no-deps backend npm run db:migrate:apply
docker compose --env-file .env run --rm --no-deps backend npm run db:migrate:postcheck
```

这些命令不是自动 migration；执行前仍须备份并确认 Compose project、volume 与
`DB_NAME` 都指向预期数据库。

命令用途：

- `status`：按顺序显示全部版本、checksum、帐本状态与资源状态。
- `preflight`：检查 MySQL 8.0、数据库名称及 collation、22 张依赖表、必要主键、
  advisory lock、帐本 checksum，以及五张目标表和 R4 索引是否缺少或完全相符。
- `apply`：取得 lock，按版本执行或采用迁移，逐份严格验证后才登记成功。
- `postcheck`：要求每份迁移均已登记，并重新验证完整结构与索引。

任何命令返回非零都必须停止部署。输出只包含稳定错误码及结构 metadata，不包含
密码、连接字符串或业务记录。

## 正确部署顺序

1. 保持 B站 Listener、`LIVE_EVENT_INGEST_ENABLED` 与相关自动化关闭。
2. 使用现有备份脚本备份 MySQL 与 uploads，验证 manifest、文件 checksum 及 database default
   metadata，并在隔离目标执行标准 restore 流程确认 metadata 与资料均可恢复。
3. 在待部署版本上完成测试和构建，但不要先启动新 Backend。
4. 设置受控的 `DB_*` 环境，执行 `status` 与 `preflight`。
5. 执行 `apply`，随后必须执行 `postcheck`。
6. 只有 postcheck 成功后，才部署使用新表的 Backend 与 Frontend。
7. 验证旧功能、健康检查与新入口；Listener 仍保持关闭。
8. Listener 的真实连接与启用必须留给独立、再次授权的阶段。

## 失败恢复与回退

以下四种操作不能混为同一个“rollback”：

### Application rollback

停止使用新 API/UI 的应用版本，将 Backend 与 Frontend 回退至迁移前兼容版本。
五张新业务表、R4 索引、`schema_migrations` 及其中数据全部保留。迁移前版本会忽略额外表，
不需要也不得删除它们。

### Feature disable

Listener 持续关闭，事件入口保持默认关闭。若新 API/UI 尚未正式启用，回退应用
版本就是当前的停用边界；本轮不为此重构路由或新增全局 feature flag。

### Failed migration recovery

不要继续部署应用。读取稳定错误码与结构差异，修复权限、collation 或不相容对象
的来源后，重新执行 `preflight` 和同一个 forward migration。相容的部分状态会被
采用，不相容状态会继续 fail closed。

### Destructive schema removal

本仓库没有自动删除这些表的 rollback。禁止直接 `DROP` 或 `TRUNCATE`。只有另一次
明确授权、完成并验证备份、确认数据可以删除后，才可单独设计移除程序。

## 已验证状态

R1 隔离 MySQL 8 测试已覆盖：

- 空数据库 fresh schema 后的安全采用。
- 从 22 张旧表及纯合成数据执行升级。
- 相同 migration 第二次执行为 no-op。
- checksum 冲突与并发 lock fail closed。
- 完全相容的 partial state 可继续。
- 不相容同名表停止且不改写。
- fresh 与 upgraded 五张表的完整 metadata 等价。
- migration 前应用版本可在升级后 schema 上启动。
- 未提供 Listener 变量时，旧版与当前 Backend 均可启动。

R4 隔离测试另覆盖：

- 空白 schema 先采用 R1，再执行 R4。
- 22 表安装依次建立 R1 表与 R4 索引。
- 已应用 R1 的数据库不会重跑 R1。
- R4 失败不会写入成功帐本。
- 等价索引被采用且不会重复建立。
- `received_at DESC, id DESC` 与最近时间范围的真实 MySQL `EXPLAIN`。

测试只使用随机 loopback 端口、tmpfs 的临时 MySQL 8 容器及纯合成数据；容器已在
测试结束后精确清理。该证据不等于已经授权正式数据库部署。
