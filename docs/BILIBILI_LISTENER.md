# B站沉默 Listener

## 边界

`services/bilibili-listener` 是 B站直播开放平台的独立、只读接收进程。它只会：

1. 调用固定来源 `https://live-open.biliapi.com` 的 `app/start`、`app/heartbeat`、`app/end`。
2. 连接同一次成功 `app/start` 回应中的 WSS 候选。
3. 接收 `LIVE_OPEN_PLATFORM_DM` 与 `LIVE_OPEN_PLATFORM_SEND_GIFT`。
4. 通过现有 HMAC 入口 `POST /api/internal/live-events/v1/ingest` 投递事件。

它不发送弹幕、私信、点赞、关注或直播间操作，不执行任何付费行为，不使用
Cookie、二维码登录或浏览器资料，也不直接连接 MySQL。

弹幕点歌仍由 Backend 既有 parser 和同一个 `song_requests` queue 处理，只接受
`点歌` 与 `點歌`。来源为 `bilibili_danmaku`。Listener 没有任何 B站输出能力。

## 官方契约

实现依据 B站官方开放平台文档：

- [项目开启、心跳与关闭](https://open-live.bilibili.com/document/9737fadc-12e8-2eaa-2d16-69f16c14d420)
- [统一鉴权与错误码](https://open-live.bilibili.com/document/74eec767-e594-7ddd-6aba-257e8317c05d)
- [长链数据协议](https://open-live.bilibili.com/document/657d8e34-f926-a133-16c0-300c1afc6e6b)
- [直播事件 CMD](https://open-live.bilibili.com/document/f9ce25be-312e-1f4a-85fd-fef21f1637f8)

`app/start` 返回 `game_id`、`websocket_info.auth_body`、候选
`websocket_info.wss_link` 和主播房间。API 与 WSS heartbeat 都按 20 秒保守间隔
运行。正常关闭时 `app/end` 最多调用一次。

官方事件中的 `uid` 已废弃并固定为 0。Listener 只将 `open_id` 和非空
`union_id` 当成 opaque string；不以 UID 0、昵称或大小写转换映射网站账号。

Gift 的 `price` 与 `r_price` 保留官方整数单位（`1000 = 1 元 = 10 电池`），
`gift_num` 不做浮点换算。Combo 只保留官方的 `combo_base_num`、
`combo_count`、`combo_id`、`combo_timeout`。当前网站只有旧数字 UID 积分规则，
没有经证明的 `open_id` 账号映射，所以礼物会可靠入库并标记
`points_status=not_processed`；`BILIBILI_GIFT_AUTO_CREDIT_ENABLED=true` 会安全失败。

## WSS 动态信任

官方文档没有保证长期不变的 WSS hostname/path allowlist。因此正式实现保留：

- 静态证据旗标仍为 `false`，静态 allowlist 仍为空。
- WSS URL 只能来自本进程、同一次通过 schema 验证的官方 `app/start` 回应。
- env、CLI、database 或手动 URL 一律不能成为连接来源。
- URL 必须为 `wss:`，不得含 userinfo、fragment、IP literal、内部 hostname，
  port 只能省略或为 443。
- 第一次验证及连接前都会 DNS 解析；任一结果若为 loopback、private、
  link-local、multicast 或 reserved address，整条候选会失败。
- `auth_body` 保存在不可枚举的 session trust store 中，只能用于同一 session
  已验证的候选，不能跨 session 取用。
- 日志不包含 URL query、`auth_body`、签名、Access Key 或事件正文。

固定官方 REST origin、TLS、`redirect=error` 和上述 session trust 共同组成信任链。

## 事件与投递

稳定事件 ID 为：

```text
bilibili:{room_id}:{msg_id}
```

缺少 `room_id` 或可靠 `msg_id` 的业务事件会拒绝，不使用昵称或时间戳补 ID。
Listener 直接复用 `backend/src/schemas/liveEventSchema.js`，没有第二套 schema。

每次投递对实际 raw JSON bytes 计算：

```text
HMAC-SHA256(
  LIVE_EVENT_INGEST_SECRET,
  X-Live-Timestamp + "." + raw_request_body
)
```

ACK 行为：

| 回应 | 行为 |
| --- | --- |
| `201 accepted` / `200 duplicate` | 删除 durable pending |
| `409 event_id_conflict` | quarantine |
| `400` / `422` | 永久拒绝并 quarantine |
| `401` / `403` | 保留 pending、进入 degraded，不盲目重试 |
| ingest disabled | 保留 pending、使用较慢的有界重试 |
| 网络、timeout、`429/5xx` | 有限 HTTP retry；耗尽后保留 pending 再调度 |

事件在进入内存 queue 前先原子写入 `LISTENER_DATA_DIR/pending`。写入采用
temporary file、`fsync`、rename；重启会 replay。损坏、异常 temporary file 和
永久拒绝会进入 `quarantine`。容量同时限制 entry 数量、总 bytes 和单 entry
bytes。日志只记录不可逆的 event fingerprint，不记录正文或平台身份。

## 生命周期与健康

Official Adapter 完成：

- `app/start`、WSS 候选验证、AUTH 与 AUTH_REPLY。
- REST heartbeat 与 WSS heartbeat/reply 的独立计时。
- Version 0 与 Version 2 zlib，多 packet frame。
- frame、packet、JSON、解压 bytes、解压比例、递归深度与节点数量限制。
- bounded exponential reconnect、generation 隔离和候选 failover。
- `LIVE_OPEN_PLATFORM_INTERACTION_END`、SIGINT、SIGTERM 与 graceful `app/end`。

单实例由 Listener data volume 内的锁强制。健康状态写入该 volume 的
`health.json`，包含启用状态、session/WSS 状态、两种 heartbeat 时间、
最后 packet、最后成功投递、pending/quarantine 数量和 degraded reason，不包含
credential 或事件 body。

Disabled 模式不会读取 B站凭据、不会建立 runtime、不会接触官方 REST/WSS，
但进程和 healthcheck 正常运行，不形成 restart storm。

## 配置

四个启用／ingest gate 独立存在，另有一个当前固定 fail-closed 的 Gift gate：

| 变量 | 默认值 |
| --- | --- |
| `BILIBILI_LISTENER_ENABLED` | `false` |
| `BILIBILI_OFFICIAL_API_ENABLED` | `false` |
| `BILIBILI_OFFICIAL_WSS_ENABLED` | `false` |
| `LIVE_EVENT_INGEST_ENABLED` | `false` |
| `BILIBILI_GIFT_AUTO_CREDIT_ENABLED` | `false`，当前不可启用 |

Listener active 模式必须同时开启前三个 B站/Listener gate 与 Backend ingest，
并提供：

- `BILIBILI_APP_ID`
- `BILIBILI_ACCESS_KEY_ID`
- `BILIBILI_ACCESS_KEY_SECRET`
- `BILIBILI_IDENTITY_CODE`
- `LISTENER_SITE_ID`
- `LISTENER_INSTANCE_ID`
- `LISTENER_ROOM_ID`
- `LIVE_EVENT_INGEST_SECRET`

`BILIBILI_ACCESS_KEY_SECRET` 与 `LIVE_EVENT_INGEST_SECRET` 必须独立。不要将任何
secret 放入 CLI、Git 或日志。程序不加载 dotenv；Compose 才从受保护的
repository `.env` 注入。

Durable 设置：

| 变量 | 默认值 |
| --- | --- |
| `LISTENER_DATA_DIR` | Compose 固定 `/var/lib/bilibili-listener` |
| `LISTENER_SPOOL_MAX_ENTRIES` | `10000` |
| `LISTENER_SPOOL_MAX_BYTES` | `67108864` |
| `LISTENER_SPOOL_MAX_ENTRY_BYTES` | `65536` |
| `LISTENER_DURABLE_RETRY_DELAY_MS` | `30000` |
| `LISTENER_INGEST_DISABLED_RETRY_MS` | `60000` |

## Docker

Compose service 为 `bilibili-listener`：

- 独立 Node 20 non-root image。
- 无 published port。
- 不取得 MySQL credential，不挂载 MySQL、uploads 或 backups。
- 只有 `listener_data` volume。
- read-only root filesystem、drop all capabilities、no-new-privileges。
- 固定单一 service，不包含 replica 扩展。

默认部署命令：

```powershell
docker compose --env-file .env --file docker-compose.yml up --detach --no-deps --wait bilibili-listener
```

在所有 gate 为 `false` 时，这只部署 disabled service，不接触 B站。更新受保护
`.env` 后，明确开启 Backend ingest 并 recreate Backend，再开启 Listener。

## 离线验证

```powershell
npm run check --prefix services/bilibili-listener
npm run test:unit --prefix services/bilibili-listener
npm run test:integration --prefix services/bilibili-listener
npm run test:official --prefix services/bilibili-listener
npm run test:e2e:official --prefix services/bilibili-listener
npm run test:e2e --prefix services/bilibili-listener
npm run dry-run --prefix services/bilibili-listener
```

Official E2E 使用 fake REST、fake WSS、公开地址的注入 DNS 结果与本机 fake Backend；
不会接触官方 API/WSS 或真实 B站。真实连接只有在受保护 `.env` 中已有合法凭据与
主播身份码后才允许执行。
