# B站沉默 Listener 离线骨架

## 用途与当前状态

`services/bilibili-listener` 是未来 B站直播开放平台监听器的独立进程边界。Phase 4E 只建立离线可测试的核心、来源 Adapter 接口、事件转换、投递、重连和关闭机制。

当前实现不会连接 B站、主播直播间、Cloudflare、preview 或其他远程服务，也没有正式 B站 Adapter。`start` 模式固定安全失败并返回 `bilibili_adapter_not_implemented`，不会回退到 Synthetic Adapter 假装正式运行。真实连接必须留待后续独立阶段重新审核。

“沉默”表示 Listener 只能接收、转换并投递事件：

- 不发送弹幕、回复、私信、关注或其他互动。
- 不执行禁言、踢人、购买、赠送或领取。
- 不使用 Cookie、二维码登录或浏览器资料。
- 不控制 OBS、酷狗、播放器或直播间。
- 不直接处理积分、点歌或商城业务。
- 不直接连接或写入 MySQL。

所有业务写入只能通过现有 Backend 的 Live Control Event API 完成。点歌指令解析仍由 Backend 负责，Listener 不理解“点歌”语义。

## 与 Phase 4D 的差异

Phase 4D 模拟器是一次性 HTTP 契约测试客户端。Phase 4E Listener 是未来常驻进程的架构骨架，增加来源 Adapter、Supervisor、心跳、来源重连、有界队列、投递重试、backpressure、状态快照和 graceful shutdown。

两者都只允许 loopback Backend、沿用同一 HMAC 和 Backend Zod schema。Phase 4E 不修改 Phase 4D，也不把 dry-run 当成正式 Listener。

## 组件

```text
future official adapter (not implemented)
              |
              | decoded internal Source Event
              v
      ListenerSupervisor
       |      |       |
       |      |       +-- source heartbeat/reconnect
       |      +---------- bounded FIFO/backpressure
       +----------------- mapper -> Backend Zod validator
                                      |
                                      v
                            signed loopback delivery
                                      |
                                      v
                        Live Control Event API v1
```

- `config.js`：只从显式传入的 env 对象及受控 override 读取设置，不加载 `.env`。
- `sourceAdapter.js`：定义来源连接边界，并提供尚未实现的 production factory。
- `syntheticAdapter.js`：只供 dry-run 与测试使用，网络连接计数始终为零。
- `listenerSupervisor.js`：管理状态机、generation、心跳、来源重连、队列和关闭。
- `eventMapper.js`：将内部 Source Event 转为 v1 标准事件，并直接调用 Backend validator。
- `eventQueue.js`：总容量有界的内存 FIFO。
- `deliveryClient.js`：一次序列化、原始 bytes HMAC、ACK 分类和有限重试。
- `logger.js` / `status.js`：白名单结构化日志及不含正文的状态快照。

## Source Adapter 接口

未来正式 Adapter 至少提供：

- `connect({ siteId, roomId, instanceId, signal })`
- `disconnect()`
- `onEvent(handler)`
- `onHeartbeat(handler)`
- `onDisconnect(handler)`
- 可选 `pause()` / `resume()`

`connect` 必须遵守 `AbortSignal`，保证连接超时或 shutdown 后没有重叠连接。回调注册应返回可重入的取消函数。Adapter 负责官方认证、长连接、心跳封包、官方事件解码、断线原因和官方事件 ID 提取；核心不写死任何 SDK。

Synthetic Source Event 是 Adapter 解码后的测试结构，不是、也不声称是 B站官方原始封包格式。Synthetic Adapter 不建立任何网络连接，不读取用户目录、浏览器 Cookie 或任意外部 fixture。

## 事件转换与稳定 ID

Phase 4E 合成测试覆盖 `danmaku` 与 `gift`。其他来源类型返回 `unsupported_source_event` 并增加 `ignored`；缺失稳定来源 ID、目标不符或格式错误会增加 `invalid`，不会使进程崩溃。

来源事件必须提供稳定 `provider_event_id`。标准事件 ID 为：

```text
provider + ":" + room_id + ":" + provider_event_id
```

同一解码后来源事件的 `occurred_at`、`received_at`、provider ID 和正文必须在重放时保持一致。Listener 在入队前完成一次映射与一次 JSON 序列化；Backend 投递重试复用相同 `event_id` 和 raw body，不重新映射。缺少可靠来源 ID 时直接拒绝，不生成随机 ID。

Mapper 只构造 Backend 已支持的字段，随后调用 `backend/src/schemas/liveEventSchema.js`。项目内没有第二套 Zod schema。弹幕原文按 Backend 契约保存在事件 body 中，但不会进入 Listener 日志。礼物金额保持 `bilibili_price` 原始字符串，不换算积分。

## HMAC 与 ACK

每次 HTTP 尝试使用当次 Unix 秒时间戳，对实际发送的同一份 raw body 计算：

```text
HMAC-SHA256(
  LIVE_EVENT_INGEST_SECRET,
  X-Live-Timestamp + "." + raw_request_body
)
```

请求头为 `X-Live-Timestamp` 与 `X-Live-Signature`。请求 timeout 覆盖响应正文读取，ACK 正文采用流式读取且最多 `16 KiB`；`redirect` 固定为 `error`。Secret、签名、Header、request body 和 response body 均不进入日志。同一事件快速重试时，即使系统时钟仍处于同一秒，也会为下一次尝试使用单调递增的秒级时间戳并重新签名；事件正文与 `event_id` 保持不变。

| HTTP / ACK | 分类 | 行为 |
| --- | --- | --- |
| `201 accepted` | 成功 | 停止重试，增加 `accepted` |
| `200 duplicate` | 安全成功 | 停止重试，增加 `duplicate` |
| `409 event_id_conflict` | 终态冲突 | 停止重试，增加 `conflict` |
| `500 database_error` | 暂时失败 | 在上限内重试 |
| `429`、`502`、`504` | 暂时失败 | 在上限内重试 |
| 网络错误、timeout | 暂时失败 | 在上限内重试 |
| `400/401/403/413/415/422` | 永久失败 | 不重试 |
| `503 ingest_unavailable` | 配置性永久失败 | 不重试 |
| 其他或无效 ACK | 永久失败 | 不回显 response body |

投递重试次数有限，超过上限增加 `failed`。投递重试的 timer 与来源重连 timer 完全分离。

## 队列与 Backpressure

队列是内存 FIFO，默认总容量 `1000`、并行度 `1`。总容量包含处理中和等待中的事件；并行度允许配置为 `1–4`。FIFO 保证出队及开始投递顺序；默认并行度 `1` 同时保证完成顺序。显式提高并行度后，较慢的请求或有限重试可能晚于后续请求完成，因此需要顺序敏感的部署必须保持默认值。队列满时明确返回 `queue_full`、增加 `queue_rejected`，不会静默丢弃。

若 Adapter 支持 `pause/resume`，队列拒绝会触发 pause，深度下降后触发 resume。当前没有磁盘持久化、dead-letter 文件或事件正文日志；进程崩溃时尚未成功投递的内存事件可能丢失，正式连接阶段必须再次评估持久化策略。

## 生命周期与重连

状态为：

```text
idle -> starting -> connecting -> connected
                         |             |
                         +-> backing_off
idle/connected/backing_off -> stopping -> stopped
fatal
```

每次连接都有递增 generation。旧 generation 的事件、心跳与断线 callback 会被忽略。任一时刻最多一个 connect、一个心跳 timer 和一个重连 timer。连接 timeout 或 shutdown 会 Abort 当前 connect。

来源重连使用 capped exponential backoff 与 0.8–1.2 jitter；成功连接后重置 backoff。心跳 timeout 对同一 generation 只触发一次断线处理。Backend delivery 使用独立的有限指数退避，不影响来源状态。

Shutdown 先停止接收、取消来源连接与重连，再在 `LISTENER_SHUTDOWN_DRAIN_TIMEOUT_MS` 内 drain 队列。停止期间不会因队列深度变化重新 `resume` 来源；超时后取消投递 retry、明确取消等待项，并报告剩余数。重复 stop 复用同一关闭结果。SIGINT、SIGTERM、未捕获异常、未处理 Promise rejection 与显式结束共用同一可重入关闭入口。核心不调用 `process.exit`；只有 CLI 外层设置 ExitCode。

## 设置

正式模式预留以下环境变量：

| 变量 | 默认值 | 范围或说明 |
| --- | --- | --- |
| `LISTENER_SITE_ID` | 无 | Backend `site_id` 格式 |
| `LISTENER_INSTANCE_ID` | 无 | 小写 slug，最长 64 |
| `LISTENER_ROOM_ID` | 无 | Backend 数字字符串格式 |
| `LISTENER_BACKEND_URL` | 无 | 仅明确 loopback HTTP 根 URL |
| `LIVE_EVENT_INGEST_SECRET` | 无 | 非 placeholder，至少 32 bytes |
| `LISTENER_CONNECT_TIMEOUT_MS` | `10000` | `100–60000` |
| `LISTENER_HEARTBEAT_TIMEOUT_MS` | `30000` | `1000–120000` |
| `LISTENER_RECONNECT_INITIAL_MS` | `1000` | `50–60000` |
| `LISTENER_RECONNECT_MAX_MS` | `30000` | `50–300000` |
| `LISTENER_DELIVERY_MAX_ATTEMPTS` | `3` | `1–10` |
| `LISTENER_DELIVERY_TIMEOUT_MS` | `5000` | `100–30000` |
| `LISTENER_DELIVERY_RETRY_INITIAL_MS` | `250` | `10–10000` |
| `LISTENER_DELIVERY_RETRY_MAX_MS` | `5000` | `10–60000` |
| `LISTENER_QUEUE_MAX_LENGTH` | `1000` | `1–10000` |
| `LISTENER_DELIVERY_CONCURRENCY` | `1` | `1–4` |
| `LISTENER_SHUTDOWN_DRAIN_TIMEOUT_MS` | `10000` | `100–120000` |

Secret 只能由调用进程环境提供，没有默认值，也不接受 `--secret`。配置不会自动读取 `.env`。Backend URL 仅接受 `http://127.0.0.1`、`http://localhost` 和受支持的 `http://[::1]` 明确字面形式；拒绝 HTTPS、远端、LAN、credentials、query、hash、非根路径、redirect 及各种数字 IPv4 别名。

## 日志与状态

日志使用字段白名单：timestamp、level、code、component、state、site/instance/room、event type、queue depth、retry attempt、duration、计数器、安全 fingerprint 和结果。

日志不接受 Error 对象、Secret、Token、Cookie、Authorization、Access Key、Session Key、完整签名、Header、body、raw payload、open_id、UID、用户名、弹幕或礼物留言。

状态快照仅包含：

- `state`、`uptime_ms`、`connection_generation`、`queue_depth`
- `received`、`mapped`、`ignored`、`invalid`
- `accepted`、`duplicate`、`conflict`、`retried`、`failed`
- `queue_rejected`、`reconnect_count`
- `last_connected_at`、`last_delivery_success_at`

Phase 4E 不为状态快照新增 HTTP Server、Port 或公开 Endpoint。

## 离线运行与测试

Dry-run 使用内建 Synthetic Adapter，不需要 Secret，不建立 HTTP、Backend、MySQL 或 B站连接：

```powershell
npm run dry-run --prefix services/bilibili-listener
npm run dry-run --prefix services/bilibili-listener -- --json
```

内建场景包含 synthetic 弹幕、礼物、不支持事件、错误事件、重复来源事件、断线重连和 queue backpressure。不能指定外部 fixture。

测试命令：

```powershell
npm run test:unit --prefix services/bilibili-listener
npm run test:integration --prefix services/bilibili-listener
npm run test:e2e --prefix services/bilibili-listener
npm run check --prefix services/bilibili-listener
```

隔离 E2E 使用唯一 Compose project、临时 MySQL 8、随机 loopback Port、随机进程内 Secret 和隔离 Backend。它不会读取正式 `.env`，结束或中断时只清理精确的临时 project 与 volume。

## 后续真实接入前检查

未来正式 Adapter 接入前必须独立确认：

1. 只使用经过确认的 B站官方开放平台流程与文档。
2. 明确凭据保管、轮换、最小权限和泄漏响应。
3. 验证官方事件 ID、心跳、断线原因和重放语义。
4. 验证 Adapter 遵守 connect AbortSignal、pause/resume 和 generation 约束。
5. 重新评估内存队列的崩溃恢复与磁盘持久化。
6. 在隔离环境重新完成隐私、限速、重连和长期运行测试。
7. 保持沉默边界，不新增发送弹幕或直播间操作能力。

在这些检查完成前，不得把 dry-run 或 Synthetic Adapter用于正式运行。
