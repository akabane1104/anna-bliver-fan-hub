# 直播状态与事件记录后台

Phase 4G-B 在现有直播中控权限边界内增加两个只读管理页面：

- `/admin/live-status`：查看网站、数据库、直播场次、Listener、B站连接和事件入站状态。
- `/admin/live-events`：分页查询已经保存在 `live_events` 中的标准化事件。

两个页面和对应 API 只允许管理员或具有 `live_control.manage` 权限的已登录用户访问。前端路由保护和导航隐藏只用于改善体验，Backend 中间件始终执行最终鉴权。本阶段不会自动向任何正式用户授予权限。

## 状态来源

页面将不同来源的状态分开显示，不合并成一个“直播中”状态：

| 区块 | 权威来源 | 说明 |
| --- | --- | --- |
| Backend | 当前管理 API 响应 | 只表示网站 Backend 可响应 |
| Database | Backend 的有界 `SELECT 1` | 只表示当前数据库查询可用 |
| 网站直播场次 | `live_sessions` | `open` 或 `paused` 不代表 B站连接成功 |
| 事件入站活动 | `live_events` 有界聚合查询 | 最近有事件不代表当前 WSS 仍连接 |
| Listener | 可注入的只读状态提供者 | 当前部署没有安全的跨进程运行时状态通道 |
| B站 API / WSS | Listener 权威状态提供者 | 缺少权威状态时返回 `unknown` |

当前 Backend 不扫描 Listener 进程、不读取 Listener 配置、不接受客户端提供的状态 URL，也不会为了读取状态而发起 B站 API、WSS 或其他外部连接。因此当前部署默认显示：

- Listener：`unavailable`
- 原因：`listener_status_not_reported`
- B站 API：`unknown`
- B站 WSS：`unknown`

这是能力边界，不是错误伪装。后续若增加进程间状态通道，必须保持只读、固定服务端配置、短超时和字段白名单。

当前状态提供者没有 URL、网络 client、DNS、redirect 或底层 `fetch` 调用链。
因此本阶段没有加入推测性的 endpoint 或 SSRF 规则，也不能声称 AbortSignal 已传到
不存在的 fetch。未来建立权威跨进程通道时，必须独立设计 endpoint allowlist、
redirect 禁止、caller abort 与 timeout abort。

## 管理 API

### 状态

```http
GET /api/live-control/status
Authorization: Bearer <website JWT>
```

响应分别包含 `backend`、`database`、`sessions`、`listener`、`bilibili_connection` 和 `ingestion`。缺少权威数据时使用 `unknown` 或 `unavailable`，不会根据场次或历史事件推测连接成功。

### 事件记录

```http
GET /api/live-control/events?page=1&limit=20
Authorization: Bearer <website JWT>
```

支持以下可选参数：

| 参数 | 限制 |
| --- | --- |
| `query` | 1–200 字符，搜索允许的显示名称、内容摘要和歌曲名称 |
| `event_type` | Phase 4B 的八种标准事件类型 |
| `status` | 当前只能为 `recorded` |
| `source` | `live`、`simulation` 或 `replay` |
| `session` | 直播场次公开 UUID |
| `start` / `end` | 带时区的 ISO-8601 时间，开始时间不得晚于结束时间 |
| `page` | 最小为 1 |
| `limit` | 1–100，默认 20 |

查询使用参数化 SQL，固定按 `received_at DESC` 和内部稳定键降序排列，不接受客户端排序字段。场次筛选使用场次 target 和开始／结束时间窗口，不会把其他场次的事件混入结果。

## 安全 DTO

事件 API 在 Backend serializer 边界只返回白名单字段，包括：

- Backend 生成的版本化 opaque `event_ref`
- 标准事件类型、来源模式和安全命令名
- target 安全显示信息
- 场次公开 ID 与标题
- 公开显示名称
- 不含事件正文的固定类型摘要
- 保存状态和安全 reason code
- 已派生点歌请求的公开信息

`event_ref` 使用专用 `LIVE_EVENT_REF_SECRET`、`live-event-reference:v1` domain
separator 与 HMAC-SHA256，由 Backend 根据内部记录生成，格式为
`ler:v1:<64 hex>`。密钥必须至少 32 bytes；缺少或不合格时，只有实际需要序列化
事件记录的管理入口以 503 安全失败，Backend 启动和 Listener-disabled 状态页不受
影响。`event_ref` 不是上游 `event_id`，也不是 authentication token。

更换专用密钥会改变管理页面引用；当前没有在线 key rotation 或双 key 验证契约，
不得宣称已经支持无缝轮换。历史事件无需回填：Phase 4B 的 duplicate/conflict 与
legacy replay 始终以数据库中的上游 `event_id` 唯一约束和 `content_hash` 判定，
从不依赖展示用 `event_ref`，所以新算法不会插入第二份历史事件。

API、页面和错误信息不返回：

- Secret、Token、Cookie、Access Key、身份码或 HMAC
- 完整 WSS URL、请求 Header、原始请求体或事件正文
- `open_id`、`union_id`、数字 UID 或网站内部用户 ID
- 上游 `event_id`、source message/session ID 或数据库内部 ID
- `normalized_payload`、未筛选 payload、`content_hash`、SQL 错误或堆栈

Repository 的事件列表投影也不再选择 `normalized_payload`。搜索条件仍可在数据库
内部对允许字段做参数化匹配，但 payload 不会进入 service DTO、错误响应或页面。

## 有界状态聚合与索引

状态读取固定执行数据库 health、active sessions 和 ingestion summary 三类查询。
active sessions 先在 CTE 中固定最多 100 个 `open`／`paused` 场次，再由 SQL
分别进行事件与点歌请求 grouped aggregation，最终最多返回 100 行；不再为每个
场次建立相关 scalar subquery，也不会把事件历史搬到 JavaScript。

ingestion summary 只返回一行 scalar：数据库内的精确总数、按
`received_at DESC, id DESC LIMIT 1` 取得的最后事件，以及最近五分钟计数。精确
总数仍由 MySQL 聚合计算，但不会把历史 row 传给 service。迁移
`202607240002_live_events_received_at_index.sql` 建立
`(received_at, id)`，同时支持固定排序、最后事件和时间范围前缀；实际隔离 MySQL
8 `EXPLAIN` 已验证排序与最近时间范围选择该索引。

当前 `live_events` 只持久化成功写入的 `recorded` 事件。`duplicate` 和 `event_id_conflict` 是入站 ACK，不会另建事件记录；未持久化的失败也无法由本页伪造成历史状态。

## 页面更新

- 状态页和事件第一页约每 5 秒刷新。
- 页面隐藏时暂停轮询，恢复可见时立即刷新。
- 同一资源不会产生重叠请求。
- 离开页面、切换筛选或切换分页时会取消旧请求并清理定时器。
- 事件第二页及以后不自动插入新事件，避免旧分页跳动。
- 两页均提供手动刷新；部分状态不可用不会导致整页白屏。

桌面事件记录使用表格，窄屏改为卡片，不依赖横向滚动。正文由 React 默认转义，不使用 `dangerouslySetInnerHTML`。

## 明确边界

本轮没有新增数据库表或字段，也没有修改事件写入流程或新增公开直播事件 API；
只通过独立 additive migration 增加上述查询索引。管理页面不会：

- 建立或控制 B站 API／WSS 连接
- 启停 Listener、容器、Cloudflare 或直播场次
- 修改、删除或重放事件
- 调整积分、创建第二条队列或发送弹幕
- 读取正式凭据或把浏览器直接连接到 Listener
