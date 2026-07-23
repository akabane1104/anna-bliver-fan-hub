# REST API、权限与 bili-bot 接口

## 通用约定

- 默认基础地址：`http://localhost:5000/api`
- 受保护接口：`Authorization: Bearer <jwt>`
- JSON 请求上限由 `REQUEST_BODY_LIMIT` 控制。
- 成功响应可能直接返回对象，也可能使用 `{ "success": true, "data": ... }`；前端服务层已统一解包商城响应。
- 错误响应至少包含 `{ "message": "..." }`。
- `401` 表示登录失效，`403` 表示权限不足，`429` 表示触发限流。

## REST 路由

### 认证与用户

| 方法 | 路径 | 访问 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/auth/send-code` | 公开、独立限流 | 启用邮件验证时发送验证码 |
| `POST` | `/auth/register` | 公开、独立限流 | 注册；密码 10–64 位 |
| `POST` | `/auth/login` | 公开、独立限流 | 登录并返回 JWT |
| `GET` | `/auth/profile` | 登录 | 当前用户与积分概览 |
| `GET` | `/auth/users` | 管理员 | 分页用户列表 |
| `PUT` | `/auth/users/:id/role` | 管理员 | 更新角色，禁止降级最后一个管理员 |

### 站点配置

| 方法 | 路径 | 访问 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/settings/captcha` | 公开 | Captcha 是否启用及公开前端参数 |
| `GET` | `/settings/registration` | 公开 | 注册开关与邮箱验证状态 |
| `GET` | `/settings/site` | 公开 | 站点文案、品牌与主题 |
| `PUT` | `/settings/registration` | `site_config.manage` | 修改注册开关 |
| `PUT` | `/settings/site` | `site_config.manage` | 事务化保存站点配置 |
| `POST` | `/settings/site/logo` | `site_config.manage` | 上传 2 MB 以内 PNG/JPG/WebP Logo |

### 歌曲列表

| 方法 | 路径 | 访问 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/playlists/songs` | 公开 | 聚合全部历史容器中的歌曲 |
| `GET` | `/playlists/tags` | 公开 | 标签列表 |
| `GET` | `/playlists` | 公开兼容 | 旧歌单容器列表 |
| `GET` | `/playlists/:id` | 公开兼容 | 旧歌单及歌曲 |
| `POST` | `/playlists/songs` | `playlist.manage` | 新增歌曲并自动初始化内部歌单 |
| `POST` | `/playlists/songs/batch` | `playlist.manage` | 最多批量新增 500 首 |
| `PUT` | `/playlists/songs/:id` | `playlist.manage` | 更新歌曲与标签 |
| `DELETE` | `/playlists/songs/:id` | `playlist.manage` | 删除歌曲 |
| `POST/PUT/DELETE` | `/playlists/tags...` | `playlist.manage` | 标签维护 |

### 棉花糖

| 方法 | 路径 | 访问 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/marshmallows` | 公开、独立限流 | 匿名或登录投递，正文最多 10000 字 |
| `GET` | `/marshmallows/my` | 登录 | 当前用户认领的内容 |
| `POST` | `/marshmallows/bind` | 登录 | 使用投递 UUID 认领 |
| `GET` | `/marshmallows/admin` | `marshmallow.manage` | 管理列表 |
| `PUT` | `/marshmallows/:id/reply` | `marshmallow.manage` | 回复 |
| `POST` | `/marshmallows/:id/read` | `marshmallow.manage` | 标记已读 |
| `POST` | `/marshmallows/delete` | `marshmallow.manage` | 最多批量删除 100 条 |

### 积分

`GET /points/summary` 与 `GET /points/transactions` 只需要登录。`/points/admin/*` 全部要求 `points.manage`，包括账号创建、资料刷新、流水查询、手工调整、CSV 预览/提交/导出和手工结算。

### 商城

- `GET /prizes`、`GET /prizes/:id`：公开商品读取。
- `/prizes/cart/*`、`/prizes/shipping-addresses/*`、`/prizes/user/*`：登录用户自己的购物车、地址和订单。
- `POST /prizes/redeem`、`POST /prizes/cart/checkout`：积分事务结账，单行数量 1–99。
- `/prizes/admin/*`：要求 `prize.manage`，覆盖商品、图片、排序、库存、订单状态和退款。

商品 Base64 图片会在服务端验证 PNG/JPG/WebP 魔数与 2 MB 上限，写入 `backend/uploads/prizes/`，数据库只保存站内 URL。

### 权限

| 方法 | 路径 | 访问 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/permissions/types` | 登录 | 可分配权限类型 |
| `GET` | `/permissions/my` | 登录 | 当前角色与显式权限 |
| `GET` | `/permissions/users` | 管理员 | 用户及权限 |
| `GET/PUT` | `/permissions/users/:id` | 管理员 | 查看或更新角色和权限 |

### B站资料与绑定

- `GET /bilibili/info`：读取站点配置 UID 的公开资料。
- `/bilibili-binding/*`：全部要求登录；创建二维码、轮询、查看绑定、设为主账号和解绑。

## bili-bot WebSocket 接口

### 角色与连接方向

网站后端是 **WebSocket 客户端**，bili-bot 或事件网关是 **WebSocket 服务端**：

```text
bili-bot / event gateway  <==== WebSocket ====  fan-hub backend
        sends events                         stores + settles + ACKs
```

配置 `BOT_WS_URL` 后启用。若同时配置 `BOT_WS_TOKEN`，握手会携带：

```http
Authorization: Bearer <BOT_WS_TOKEN>
```

生产环境必须使用 `wss://`、随机 Token 和服务端来源限制。不要把 B站 Cookie 放入事件消息。

### 连接与补偿

连接成功后网站发送：

```json
{
  "type": "resume",
  "settled_before": "2026-07-22T12:00:00.000Z"
}
```

事件服务应把该消息视为补偿/重放请求，并重新发送仍可能未被网站确认的稳定事件。网站按 `event_id` 幂等，因此安全重放优于遗漏。

连接关闭后网站从 1 秒开始指数退避，最大 30 秒。Bot 端也应维护未确认队列：收到 `accepted` 或 `duplicate` 才移除；`rejected` 进入人工检查或有上限的重试队列。

### 礼物事件

```json
{
  "type": "gift",
  "event_id": "bili:room-123:gift:opaque-stable-id",
  "room_id": "123456",
  "uid": "501066866",
  "username": "Demo User",
  "total_coin": 1000,
  "timestamp": "2026-07-22T20:00:00+08:00"
}
```

### SC 事件

```json
{
  "type": "super_chat",
  "event_id": "bili:room-123:sc:opaque-stable-id",
  "room_id": "123456",
  "uid": "501066866",
  "username": "Demo User",
  "total_coin": 3000,
  "timestamp": "2026-07-22T20:01:00+08:00"
}
```

字段要求：

| 字段 | 要求 |
| --- | --- |
| `type` | 当前仅 `gift`、`super_chat` |
| `event_id` | 来源侧稳定且全局唯一；重发不得生成新值 |
| `room_id` | 可转为正整数，结算时与 `POINTS_ROOM_ID` 比较 |
| `uid` | B站 UID |
| `username` | 可选公开昵称 |
| `total_coin` | 非负整数币值，由 `POINTS_COIN_PER_POINT` 折算 |
| `timestamp` | 可解析的事件发生时间，不应使用重发时间 |

### ACK

```json
{
  "type": "event_ack",
  "event_id": "bili:room-123:gift:opaque-stable-id",
  "status": "accepted",
  "reason": ""
}
```

状态：

- `accepted`：首次持久化成功。
- `duplicate`：该 `event_id` 已存在，可停止重试。
- `rejected`：格式、业务或数据库处理失败；`reason` 仅用于诊断，不应包含密钥或完整 Cookie。

ACK 表示事件已进入网站账本，不保证已经折算为积分。房间或起算时间不匹配的事件会在结算阶段被记录为过滤结果。

### 扩展新事件

建议保持现有事件向后兼容，并按以下顺序扩展：

1. 为新类型定义稳定 `event_id`、最小字段和币值语义。
2. 在 `botEventBridge.handleMessage` 白名单中加入类型。
3. 在 `bilibili_point_events.event_type` 数据库枚举或新事件表中加入类型。
4. 明确它是否产生积分；纯弹幕、关注等非积分事件不要硬塞进积分表。
5. 增加幂等、重复发送、乱序、断线补偿和无 Bot 模式测试。

适合独立扩展的方向：

- `guard` / 舰长事件：定义币值或专属奖励流水。
- `task_reward`：由可信任务服务签名后发放积分。
- `danmaku`：进入独立互动流，不进入积分账本。
- 网站到 Bot 的命令：新建反向命令通道并加入请求 ID、权限、超时和 ACK，不复用当前单向事件格式。

若协议需要多个版本，新增顶层 `schema_version`，旧消息缺失时按版本 `1` 处理；不要改变已有字段含义。

## Live Control Event API v1

这是供未来独立沉默监听器调用的服务到服务入口，与上面的旧 `bili-bot` WebSocket 积分链彼此独立。

### 开关与目标

接口路径：

```http
POST /api/internal/live-events/v1/ingest
```

运行配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIVE_EVENT_INGEST_ENABLED` | `false` | 只有精确设置为 `true` 才启用；关闭时返回 `404` |
| `LIVE_EVENT_INGEST_SECRET` | 空 | HMAC 服务密钥，启用时至少 32 bytes，示例或占位密钥无效 |
| `LIVE_EVENT_MAX_SKEW_SECONDS` | `300` | 请求时间戳允许偏差，范围为 1–3600 秒 |
| `LIVE_EVENT_ALLOWED_TARGETS` | 空 | 逗号分隔的 `site_id:room_id` 明确配对，例如 `main-site:123456,backup-site:789012` |

目标列表为空、含通配符、格式错误或 Secret 不合格时，即使开关为 `true` 也会安全失败并返回 `503 ingest_unavailable`。接口不接受网站 JWT、管理员 Token、Cookie 或浏览器 `Origin` 作为服务身份。

### 请求签名

请求必须使用 `Content-Type: application/json`，不接受压缩，请求体解压前后的最大允许值均以未压缩 JSON 为准且不得超过 64 KiB。请求头：

```http
X-Live-Timestamp: <Unix seconds>
X-Live-Signature: <64 lowercase or uppercase hexadecimal characters>
```

签名输入是收到的原始 JSON bytes，不是重新序列化后的对象：

```text
HMAC-SHA256(
  LIVE_EVENT_INGEST_SECRET,
  X-Live-Timestamp + "." + raw_request_body
)
```

服务端使用 Node.js `crypto.timingSafeEqual` 比较固定长度摘要。调用方应先完成 JSON 序列化，再对同一组 bytes 签名；时间戳超出允许偏差会被拒绝。Secret、完整签名及原始请求体不得进入日志。

### 标准事件 Envelope

所有字段均为必填，只有各事件表中标记为可选的子字段例外。对象采用严格 Schema，未知字段会直接拒绝，不会保存官方原始完整包。

```json
{
  "schema_version": "1.0",
  "event_id": "source:stable:event:identifier",
  "event_type": "danmaku",
  "site_id": "main-site",
  "room_id": "900719925474099312345",
  "mode": "simulation",
  "source": {
    "platform": "bilibili_live_open",
    "cmd": "LIVE_OPEN_PLATFORM_DM",
    "message_id": "source-message-id",
    "session_id": "source-session-id"
  },
  "actor": {
    "open_id": "platform-open-id",
    "union_id": "optional-platform-union-id",
    "display_name": "公开昵称",
    "avatar_url": "https://example.com/avatar.png"
  },
  "occurred_at": "2026-07-23T08:00:00+08:00",
  "received_at": "2026-07-23T08:00:01+08:00",
  "payload": {
    "text": "合成测试内容",
    "dm_type": "text"
  },
  "delivery": {
    "attempt": 1,
    "replay": false,
    "trace_id": "listener-local-trace"
  }
}
```

`schema_version` 当前只接受 `1.0`；`mode` 只接受 `live`、`simulation`、`replay`。`room_id` 始终作为数字字符串处理，可安全保存超过 JavaScript 安全整数范围的值。`replay` 模式必须同时设置 `delivery.replay=true`，并保留来源最初生成的 `event_id`。

`actor.open_id` 是官方直播开放平台身份。`danmaku`、`gift`、`super_chat`、`guard_buy`、`like`、`room_enter` 必须提供；`live_start` 与 `live_end` 可将 `actor` 设为 `null`。不接受 `uid`，也不会根据昵称、头像或其他模糊资料推测数字 UID。

### 事件类型与 Payload

| `event_type` | `source.cmd` | 严格 Payload |
| --- | --- | --- |
| `danmaku` | `LIVE_OPEN_PLATFORM_DM` | `text`；可选 `dm_type=text/emoji`、`emoji_url` |
| `gift` | `LIVE_OPEN_PLATFORM_SEND_GIFT` | `gift_id`、`gift_name`、`gift_num`、`paid`、原始字符串 `price`、可选 `r_price`、`price_unit=bilibili_price` |
| `super_chat` | `LIVE_OPEN_PLATFORM_SUPER_CHAT` | `message_id`、`message`、原始字符串 `rmb`、`currency_unit=CNY` |
| `guard_buy` | `LIVE_OPEN_PLATFORM_GUARD` | `guard_level=1/2/3`、`guard_num`、`guard_unit=month/year`、原始字符串 `price`、`price_unit=bilibili_guard_price` |
| `like` | `LIVE_OPEN_PLATFORM_LIKE` | 正整数 `like_count` |
| `room_enter` | `LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER` | 空对象 `{}` |
| `live_start` | `LIVE_OPEN_PLATFORM_LIVE_START` | 可选 `title`、`area_name` |
| `live_end` | `LIVE_OPEN_PLATFORM_LIVE_END` | 可选 `title`、`area_name` |

金额字段保留监听器从官方事件取得的原始单位和字符串精度。入口不会换算人民币、硬币或积分，也不会调用 `pointsService`。

### ACK、错误与幂等

| HTTP | `status` | `reason` | 含义 |
| --- | --- | --- | --- |
| `201` | `accepted` | 无 | 首次验证并写入 `live_events` |
| `200` | `duplicate` | 无 | 相同 `event_id` 与规范化内容已存在 |
| `409` | `rejected` | `event_id_conflict` | 相同 `event_id` 对应不同规范化内容，原记录不变 |
| `400` | `rejected` | `invalid_json` | JSON 或 UTF-8 无效 |
| `401` | `rejected` | `invalid_service_signature` / `timestamp_out_of_range` | 签名或时间窗口无效 |
| `403` | `rejected` | `service_identity_required` / `target_not_allowed` | 使用了浏览器/网站身份，或目标配对不在白名单 |
| `413` | `rejected` | `payload_too_large` | 请求体超过 64 KiB |
| `415` | `rejected` | `unsupported_media_type` / `unsupported_content_encoding` | 不是未压缩 JSON |
| `422` | `rejected` | `invalid_event_schema` | 标准事件 Schema 无效 |
| `500` | `rejected` | `database_error` | 持久化失败，绝不返回 `accepted` |
| `503` | `rejected` | `ingest_unavailable` | 已开启但安全配置不完整 |

`event_id` 在 `live_events` 全局唯一。`content_hash` 对严格校验后的完整事件做稳定键排序后计算，因此 JSON Object 键顺序不同仍会得到 `duplicate`。冲突不会覆盖、合并或更新原记录。

### 隐私与处理边界

数据库会保存未来明确身份映射所需的 `actor_open_id` 与可选 `actor_union_id`；二者属于平台个人识别资料，应按最小权限、备份保护和保留期限管理。日志只允许事件 ID、类型、站点、房间、模式、处理结果、脱敏错误码和耗时，不记录 open_id、union_id、弹幕/SC 正文、原始包或鉴权资料。

此入口不接受网站用户 Token，不建立用户会话，不调整积分，不推送 WebSocket，不控制 OBS、播放器或酷狗，也不发送直播弹幕。Phase 4C 起，首次 `accepted` 的 `danmaku` 会在同一数据库事务中执行严格点歌观察；只有完整匹配 `点歌 歌名` 或 `點歌 歌名` 的弹幕才派生一条 `song_requests` 记录。普通弹幕、其他七类事件、`duplicate` 与 `event_id_conflict` 均不创建点歌请求。

## 统一点歌 API

公开层只有“点歌”一个概念，不存在“播放”指令或第二条播放队列。观众提交时不能选择唱或播；主播处理请求时才可将内部 `fulfillment_type` 设为 `sung` 或 `played`。

### 指令语法

直播弹幕只接受以下完整单行格式：

```text
^(点歌|點歌)[ \t\u3000]+(.+?)$
```

前缀与歌名之间至少有一个半形空格、Tab 或全形空格。`点歌年轮`、`点歌：年轮`、`播放 年轮`、`我想点歌 年轮` 和空歌名均不识别。原始弹幕与原始请求歌名会保留；简繁转换只生成匹配键，不修改显示内容。

### 网站用户点歌

```http
POST /api/song-requests
Authorization: Bearer <website JWT>
Idempotency-Key: <8-128 character stable key>
Content-Type: application/json
```

```json
{
  "site_id": "main-site",
  "room_id": "123456",
  "query": "年輪"
}
```

也可以提交属于当前场次歌单的 `song_id`；`song_id` 与 `query` 至少提供一个。请求必须来自已登录网站用户，并且目标必须存在 `open` 场次。`requester_user_id` 只从服务器登录状态取得，Body 中的用户 ID、open_id、角色、积分或 `fulfillment_type` 会被严格 Schema 拒绝。

相同用户重放相同 `Idempotency-Key` 与相同规范化请求时返回 `200 duplicate`；同一 Key 对应不同请求时返回 `409 idempotency_key_conflict`。首次建立返回 `201 accepted`。请求不扣积分、不发送 B站弹幕、不调用旧 Bot，也不控制 OBS 或播放器。

### 当前安全队列

```http
GET /api/song-requests/current?site_id=main-site&room_id=123456
```

该接口无需登录，只返回场次公开 ID、标题、状态，以及请求公开 ID、请求歌名、匹配歌曲公开资料、请求者显示名、状态、`fulfillment_type`、排序号和请求时间。不会返回 open_id、网站用户 ID、数据库内部 ID、邮箱、Token、Cookie、钱包、管理员备注或原始直播事件。

### 直播中控

以下路由均要求网站登录，并且用户是管理员或具有 `live_control.manage` 权限。代码只提供权限检查，不会自动向任何正式用户写入该权限。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/live-control/sessions` | 建立 `draft` 场次 |
| `GET /api/live-control/sessions/current` | 按明确 `site_id`、`room_id` 查询当前场次 |
| `POST /api/live-control/sessions/:publicId/open` | 开启 draft 或恢复 paused 场次 |
| `POST /api/live-control/sessions/:publicId/pause` | 暂停 open 场次 |
| `POST /api/live-control/sessions/:publicId/resume` | 恢复 paused 场次 |
| `POST /api/live-control/sessions/:publicId/close` | 关闭未结束场次 |
| `GET /api/live-control/sessions/:publicId/requests` | 查询场次请求 |
| `PUT /api/live-control/sessions/:publicId/reorder` | 事务内批量重排 |
| `GET /api/live-control/requests/observed` | 查询尚未归属场次的 observed 请求 |
| `POST /api/live-control/requests` | 人工新增请求 |
| `POST /api/live-control/requests/:publicId/assign` | 将 observed 请求指派到未关闭场次 |
| `POST /api/live-control/requests/:publicId/match` | 人工选择歌单内歌曲 |
| `POST /api/live-control/requests/:publicId/accept-unmatched` | 明确接受未匹配歌名 |
| `POST /api/live-control/requests/:publicId/reject` | 拒绝请求 |
| `POST /api/live-control/requests/:publicId/cancel` | 取消请求 |
| `POST /api/live-control/requests/:publicId/activate` | 标记处理中 |
| `POST /api/live-control/requests/:publicId/fulfillment` | 选择 `sung` 或 `played` |
| `POST /api/live-control/requests/:publicId/complete` | 完成请求 |
| `POST /api/live-control/requests/:publicId/skip` | 跳过请求 |
| `POST /api/live-control/requests/:publicId/fail` | 标记失败 |
| `POST /api/live-control/requests/:publicId/requeue` | 将 failed 请求重新排队 |
| `GET /api/live-control/songs/:id/aliases` | 查询歌曲别名 |
| `POST /api/live-control/songs/:id/aliases` | 新增歌曲别名 |
| `DELETE /api/live-control/aliases/:id` | 删除别名，不改历史请求 |

所有状态变更、匹配、排序、`fulfillment_type` 与场次归属变化都会写入不可变 `song_request_history`。API 不提供历史修改或删除路由。

### 并发与稳定错误

状态变更与重排请求必须提交当前 `expected_version`。过期版本返回 `409 version_conflict`。重排列表必须恰好包含该场次所有 `needs_match` 与 `queued` 请求，各一次；不能包含 active、终态、重复项或其他场次请求。

常用稳定错误码：

| HTTP | `code` | 含义 |
| --- | --- | --- |
| `400` | `invalid_idempotency_key` | 缺少或错误的网站幂等键 |
| `401` | 现有认证错误 | 未登录或 JWT 无效 |
| `403` | 现有权限错误 | 缺少管理员或 `live_control.manage` 权限 |
| `409` | `no_open_session` | 网站点歌时没有 open 场次 |
| `409` | `idempotency_key_conflict` | 幂等键已用于不同请求 |
| `409` | `version_conflict` | 乐观并发版本过期 |
| `409` | `active_session_exists` | 同一站点与房间已有 open/paused 场次 |
| `409` | `invalid_session_transition` | 场次状态转换非法 |
| `409` | `invalid_request_transition` | 请求状态转换非法 |
| `409` | `fulfillment_type_required` | 完成前未选择 sung 或 played |
| `409` | `match_confirmation_required` | ambiguous/observed 请求未经明确人工确认 |
| `422` | `invalid_request` | 严格请求 Schema 校验失败 |
| `422` | `song_not_in_session_playlist` | 歌曲不属于场次指定歌单 |
| `422` | `invalid_reorder_set` | 重排集合不完整、重复或跨场次 |

平台 `open_id` 可存于内部请求记录，属于平台个人识别资料；它不与数字 UID 建立外键，也不会通过公开队列返回。网站用户 ID 只能来自经过验证的登录状态，二者不会按昵称或头像推测映射。
