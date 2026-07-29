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
| `GET` | `/permissions/my` | 登录 | 当前角色、角色默认权限与用户显式权限 |
| `GET` | `/permissions/users` | 管理员 | 用户及权限 |
| `GET/PUT` | `/permissions/users/:id` | 管理员 | 查看或更新角色和权限 |

角色 key 固定为 `fan_club`、`captain`、`admiral`、`governor`、
`streamer`、`admin`。前四种观众角色共享基础权限；`streamer` 默认取得歌单、
棉花糖、商城、积分、安全品牌设置、直播中控和 OBS 测试能力。角色与权限管理、
注册开关及管理员指派仍为 `admin` 专用。Backend 会从数据库实时读取角色，
不会永久信任旧 JWT 中缓存的角色。

### B站资料与绑定

- `GET /bilibili/info`：读取站点配置 UID 的公开资料。
- `/bilibili-binding/*`：全部要求登录；创建二维码、轮询、查看绑定、设为主账号、重新同步和解绑。

扫码完成后，Backend 会用同一进程内的临时凭证调用身份 provider；Cookie 与
refresh token 不进入响应、数据库或日志，并在尝试结束后清除。每个绑定的公开
状态包括粉丝勋章、大航海等级、同步状态和最后成功时间。前端提交的
`guard_level`、目标主播 UID 或直播间 ID 不参与身份判断。

以下管理接口要求 `viewer_identity.manage`。主播和管理员默认具有该能力；后端
还会检查操作者角色、目标用户当前角色、同步状态和补录目标：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/viewer-identities/users` | 查看用户绑定与同步状态 |
| `GET` | `/viewer-identities/users/:userId/audit` | 查看身份同步与补录记录 |
| `POST` | `/viewer-identities/users/:userId/bindings/:uid/sync` | 重新同步一个已验证绑定 |
| `PUT` | `/viewer-identities/users/:userId/bindings/:uid/fallback` | 为失败／待确认的观众绑定设置临时补录 |
| `DELETE` | `/viewer-identities/users/:userId/bindings/:uid/fallback` | 撤销有权管理的临时补录 |

主播只能处理四种观众角色，不能重新同步或修改主播／管理员账号，不能指派
`streamer` 或 `admin`，也不能修改目标直播间或权限矩阵。舰长、提督和总督补录
必须包含未来截止时间；自动同步恢复后会覆盖补录。默认 provider 仍返回稳定的
`identity_source_not_configured`，不会伪造粉丝团结果。服务器维护者明确设置
`VIEWER_IDENTITY_PROVIDER=guard_tab_top_list` 后，Backend 才会使用匿名完整名单
对账；前端不能选择 provider、目标直播间、周期、超时或重试参数。

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

此入口不接受网站用户 Token，不建立用户会话，不调整积分，不推送 WebSocket，不控制 OBS、播放器或酷狗，也不发送直播弹幕。Phase 4C 起，首次 `accepted` 的 `danmaku` 会在同一数据库事务中执行严格点歌观察；只有完整匹配简体或繁体“点歌”命令的弹幕才派生一条 `song_requests` 记录。普通弹幕、其他七类事件、`duplicate` 与 `event_id_conflict` 均不创建点歌请求。

## 统一点歌 API

公开层只有“点歌”一个概念，不存在“播放”指令或第二条播放队列。观众提交时不能选择唱或播；主播处理请求时才可将内部 `fulfillment_type` 设为 `sung` 或 `played`。

### 指令语法

直播弹幕只接受以下完整单行格式：

```text
^(点歌|\u9ede\u6b4c)[ \t\u3000]+(.+?)$
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
  "query": "年轮"
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
| `GET /api/live-control/sessions/recoverable` | 恢复控制台可继续操作的 active 场次或唯一 draft |
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

同一 Backend 进程内，相同 target 的 draft 建立与相同 session 的状态变更在进入第一个异步数据库步骤前登记为单次执行。相同操作共享同一结果；同一 session 上不同的并发操作返回 `409 session_operation_pending`。进程间状态变更仍由事务行锁、`expected_version` 和既有 active session 唯一约束裁决；本机制不宣称为 draft 提供新的跨进程唯一约束。

`sessions/recoverable` 以 Backend 数据为权威来源：存在 open/paused 场次时只返回 active 场次；否则只允许恢复一个 draft。多个 draft 返回 `409 ambiguous_draft_sessions`，closed 等终态不会返回。再次建立相同 target 时，既有唯一 draft 会原样返回，不创建第二份草稿。

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
| `409` | `ambiguous_draft_sessions` | 可恢复范围内存在多个 draft，必须人工确认 |
| `409` | `session_operation_pending` | 同一场次正在执行另一项状态操作 |
| `409` | `invalid_session_transition` | 场次状态转换非法 |
| `409` | `invalid_request_transition` | 请求状态转换非法 |
| `409` | `fulfillment_type_required` | 完成前未选择 sung 或 played |
| `409` | `match_confirmation_required` | ambiguous/observed 请求未经明确人工确认 |
| `422` | `invalid_request` | 严格请求 Schema 校验失败 |
| `422` | `song_not_in_session_playlist` | 歌曲不属于场次指定歌单 |
| `422` | `invalid_reorder_set` | 重排集合不完整、重复或跨场次 |

平台 `open_id` 可存于内部请求记录，属于平台个人识别资料；它不与数字 UID 建立外键，也不会通过公开队列返回。网站用户 ID 只能来自经过验证的登录状态，二者不会按昵称或头像推测映射。

## Phase 4D 离线事件模拟

`tools/live-event-simulator` 通过真实 loopback HTTP 请求验证 `POST /api/internal/live-events/v1/ingest`。它直接复用本节既有的 Header、原始 JSON bytes、HMAC-SHA256、严格事件 Schema 与 ACK 语义，不定义第二套事件协议。

模拟器只接受 `http://127.0.0.1`、`http://localhost` 和受支持的 IPv6 loopback，不接受 preview、正式域名或局域网地址。Secret 只能由进程环境变量提供，不接受网站 Token、CLI 参数或 fixture 中的值。完整使用方法与场景见 [LIVE_EVENT_SIMULATOR.md](LIVE_EVENT_SIMULATOR.md)。

Phase 4D 没有新增公开 API，也没有改变点歌、幂等、积分或错误响应规则。

## Phase 4G-B 直播管理只读 API

以下接口要求网站登录，并由既有权限中间件确认用户为管理员或具有
`live_control.manage` 权限：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/live-control/status` | 分别读取 Backend、数据库、场次、Listener、B站连接和事件入站状态 |
| `GET /api/live-control/events` | 分页查询 `live_events` 的管理端安全 DTO |

事件查询支持 `query`、`event_type`、`status`、`source`、`session`、
`start`、`end`、`page` 和 `limit`。`limit` 最大为 100；排序固定为
`received_at DESC` 加内部稳定键，不接受客户端 SQL 排序表达式。非法筛选返回
`400 invalid_live_event_query`。

状态接口缺少权威 Listener 运行时来源时返回 `unavailable`，并将 B站 API 与
WSS 标记为 `unknown`。它不会根据 open session 或历史事件推测连接状态，也
不会为了读取状态而建立外部连接。

事件响应采用 Backend 明确 allowlist，不包含上游 `event_id`、`open_id`、数字
UID、事件正文、原始／未筛选 payload、HMAC、Secret、Token、Cookie 或数据库
内部 ID。`event_ref` 是 `ler:v1:` 前缀的专用 HMAC 去识别化引用，不是鉴权
token；专用密钥缺失或不合格时，实际事件序列化入口安全失败。当前数据库只保存
`recorded` 事件；
`duplicate`、`event_id_conflict` 和未持久化失败是入站 ACK，不会伪造成独立
历史记录，legacy replay 仍由上游 `event_id` 与 `content_hash` 判定，不依赖
`event_ref`。状态页使用固定行数的 SQL 聚合；事件时间排序和最近事件查询由
`(received_at, id)` 索引支持。完整契约与页面更新规则见
[直播状态与事件记录后台](LIVE_STATUS_AND_EVENTS_UI.md)。

## Phase 4H-A 直播首页与中控 API

`GET /api/live-home` 是公开、只读且经过明确 DTO 清洗的聚合接口。它一次返回
`offline`、`live` 或 `syncing` 模式、统一 `song_requests` 队列的 current／next／
等待数、持久化点歌开关、有效的今日活动、最近五笔付费 Gift／Guard 安全摘要，
以及由唯一 `LISTENER_ROOM_ID` 产生的直播间 URL。响应不包含平台身份、原始
payload、Listener 内部错误或管理端 override 细节。

以下接口继续使用既有网站认证与 `live_control.manage` 权限：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/live-control/home` | 读取中控快照与安全 Listener 摘要 |
| `PUT /api/live-control/home/override` | 设置 `auto`、`force_live` 或 `force_offline` |
| `PUT /api/live-control/home/song-requests` | 持久化开放／关闭点歌 |
| `PUT /api/live-control/home/activity` | 保存或清除最小今日活动 |
| `POST /api/live-control/home/requests/:publicId/advance` | 事务内完成／跳过当前歌曲，并可切换下一首 |

点歌开关由 Backend 中央 service 在网站、管理员代点与 B站 DM 三个建立入口共同
强制执行；关闭不会清空既有 queue。current、next 与 queue count 始终来自既有
`song_requests` 生命周期，不存在首页专用队列。

Listener 的 `POST /api/internal/live-events/v1/status` 与事件 ingest 使用同一个
service-only HMAC、timestamp skew 与 target allowlist。状态报告具有独立 UUID 与
UTC 时间，重送或倒退报告会被拒绝；该接口不会公开 Listener `health.json`。
