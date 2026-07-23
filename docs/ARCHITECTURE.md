# 架构与数据流

## 总览

```text
Browser / React SPA
        |
        | REST + Bearer JWT
        v
Express API ---------------------- MySQL 8
    |                                  |
    |                                  |-- 用户与权限
    |                                  |-- 单站歌曲列表与标签
    |                                  |-- 棉花糖
    |                                  |-- 积分钱包、账号、事件与流水
    |                                  `-- 商品、购物车、地址与订单
    |
    |-- Bilibili public / QR API
    |-- Optional Aliyun Captcha
    |-- Optional Tencent SES
    `-- Optional bili-bot WebSocket event source
```

前端只持有站点展示配置、用户资料和短期 JWT。数据库、B站扫码临时凭据、云服务密钥、积分结算和订单事务全部留在后端。

## 后端分层

- `routes/`：声明 URL、认证、权限与异步错误包装。
- `controllers/`：输入校验、HTTP 状态和业务编排。
- `services/`：积分账本、事件幂等、内部歌单与 WebSocket 桥。
- `middleware/`：JWT 实时角色检查、可选认证和细粒度权限。
- `utils/`：外部服务客户端、统一输入限制与辅助函数。
- `config/`：MySQL、运行时安全校验和全新安装基线。

所有异步路由通过 `asyncHandler` 将拒绝交给 Express 错误中间件，避免 Express 4 遗漏 Promise 异常。

## 前端分层

- `SiteSettingsContext` 加载公开站点配置并生成 CSS 变量。
- `services/` 统一添加 Bearer Token、处理 401 和访问 REST API。
- `ProtectedRoute` 根据角色或权限控制管理页面。
- 页面 CSS 使用主题变量，管理页与用户页共享同一套色彩语义。
- `/uploads/*` 资源通过 API 服务域名解析，静态内置资源直接由前端提供。

## 配置优先级

站点展示字段按以下顺序解析：

```text
settings 表 > 后端环境变量 > 代码默认值
```

数据库设置适合管理员在线修改；环境变量适合首次启动、基础设施和密钥。数据库永远不会覆盖数据库连接、JWT、CORS、云密钥或 Bot Token。

## 单站歌曲列表

公开版业务上只有一份歌曲列表，但保留 `playlists` 表兼容旧数据：

1. `settings.site_playlist_id` 指向内部歌单。
2. 首次写入时在事务和行锁中创建或复用内部歌单。
3. 读取时聚合所有历史歌单，旧歌曲不会丢失。
4. 前端不再创建、选择或切换歌单容器。

## 积分与订单

`bilibili_point_events.source_event_id` 唯一。礼物或 SC 先幂等入库，再按房间、起算时间和兑换比例结算。

购物车不会预扣积分。结账事务按以下顺序执行：

1. 锁定用户钱包、商品与商品选项。
2. 验证商品状态、库存、地址和积分余额。
3. 创建订单与兑换行。
4. 记录不可变积分流水并扣减库存。
5. 清理已结算购物车并提交。

拒绝或取消订单时使用唯一退款引用和 `refunded_at`，防止重复退款与重复回库存。

## B站扫码绑定

- 二维码会话只存在于当前后端进程内，默认三分钟过期。
- 会话与网站用户 ID 绑定，其他用户无法轮询。
- Cookie 和 refresh token 只用于一次服务端查询，不返回前端、不写数据库。
- UID 唯一绑定到一个网站用户；解绑后积分流水仍保留。

多实例部署时，应将临时二维码会话迁移到带 TTL 的共享存储，或保证同一会话固定路由到同一后端实例。

## 信任边界

- 浏览器输入、Bot 事件和第三方 API 响应均视为不可信数据。
- 后端使用参数化 SQL、长度限制、枚举校验和事务锁。
- 管理页面隐藏不是安全边界；后端权限中间件始终执行最终检查。
- 上传图片验证 MIME 声明、魔数和大小，并使用随机文件名落盘。
- 生产环境必须配置固定 CORS 来源、强 JWT 和正确代理跳数。

## 公开版边界

本仓库不包含 Bot 管理、QQ/AI 配置、盲盒、礼物截图或展示、OBS、激活码、主播房间管理和电影票币种。bili-bot 仅通过公开事件协议接入，扩展约定见 [API 文档](API.md#bili-bot-websocket-接口)。

## Live Control API 边界

Phase 4B 在现有 Express backend 内新增默认关闭的 `POST /api/internal/live-events/v1/ingest`，只负责服务签名、严格 Schema、目标白名单、幂等判定与 `live_events` 持久化：

```text
future silent listener
        |
        | signed normalized event (HMAC-SHA256)
        v
Live Control Event API
        |
        `-- live_events only

users / UID bindings / point_accounts / points ledger   (no connection)
sing queue / playback queue / OBS / Kugou / danmaku     (not implemented)
```

未来的 B站沉默监听器必须是独立进程：它连接官方直播开放平台、维护心跳与重连、标准化和重播事件，但不能直接写 MySQL。backend 是唯一数据库写入方；监听器也不能持有网站用户 JWT 或管理员 Token。

`live_events.actor_open_id` 保存官方开放平台的 `open_id`。它不等于现有 `point_accounts.bilibili_uid` 数字 UID，两者之间没有外键。未来若要自动积分，必须先设计经过用户明确确认、可审计且一对一的身份映射；禁止通过昵称、头像或字符串相似度推测。当前 `live_events` 与 `botEventBridge`、`bilibili_point_events`、`pointsService` 及全部钱包/流水表完全隔离。

本阶段不包含演唱/播放双队列、OBS Overlay、酷狗控制、本地 Helper、私有中控台或发送弹幕。上述模块未来只能消费经过授权的派生事件或命令，不能绕过 backend 直接修改业务数据库。

旧 `botEventBridge.stopBotEventBridge()` 仍存在已知停机问题：主动关闭 socket 后，`close` 处理器可能再次安排重连。本阶段不修改该旧桥接器；在未来启用或下线旧 Bot 前必须单独修复并补停机测试。

`open_id` 与 `union_id` 属于平台个人识别资料。数据库备份、运维访问和保留期限应遵循最小权限；应用日志禁止保存完整标识、弹幕/SC 正文、Secret、签名和官方原始事件包。

## Phase 4C 统一点歌队列

Phase 4C 在 Phase 4B 的持久化事件入口之后增加单一、统一的点歌队列：

```text
silent listener                          website user
      | signed standard event                 | JWT + Idempotency-Key
      v                                       v
live_events -- accepted danmaku --> strict command parser
                                      |
                                      v
                              song_requests
                                      |
                     +----------------+----------------+
                     |                                 |
             live_sessions                      song_aliases
                     |
             song_request_history
```

backend 仍是唯一数据库写入者。首次 accepted 的 `danmaku` 与其派生 `song_request` 在同一个 MySQL 事务中提交；解析、匹配或请求写入失败时，`live_event` 也会回滚，因此不会留下无法恢复的半条数据。duplicate 与 conflict 不再次解析，`source_event_id` 唯一约束提供第二层幂等保护。普通弹幕及 gift、super_chat、guard_buy、like、room_enter、live_start、live_end 不创建请求。

所有观众请求进入同一条队列。公开层只有 `点歌`/`點歌`，不存在播放指令或背景播放队列。`sung` 与 `played` 只是主播处理时设置的内部 `fulfillment_type`；请求建立时固定为 `undecided`。

简繁处理只作用于命令前缀与歌曲/别名匹配键。数据库歌曲、歌手、别名原文及弹幕原文不会被覆盖，前端也不执行全站转换。匹配先做大小写敏感的原文精确比较，再依次使用 NFKC/空白、简繁脚本键、别名原文与别名脚本键。包含匹配及英文大小写折叠只产生最多五个候选，不会自动选歌；因此 `fancy` 与 `FANCY` 可分别精确命中，而 `Fancy` 必须人工确认。

`live_sessions` 用生成列与唯一索引保证同一 `site_id + room_id` 同时最多一个 open/paused 场次。新增与重排请求都锁定场次行；队列序号使用数据库当前读生成，不依赖 Node.js 内存计数器。场次 `version` 在队列成员或顺序改变时推进，过期重排会稳定返回冲突。

`song_requests.requester_open_id` 与网站 `requester_user_id` 保持隔离：open_id 不连接数字 UID，也不按显示名推测网站用户。公开队列只使用 public ID 和安全显示字段。全部管理操作需要管理员或 `live_control.manage` 权限，并写入不可变 history；本阶段不自动向正式用户授予权限。

本阶段不修改前端，不建立全站简繁切换，不连接真实 B站，不调整积分，不依赖旧 Bot，不发送弹幕，也不控制 OBS、酷狗或本地 Helper。当前实现可在未启用正式事件入口、未迁移正式数据库时作为影子代码接受审核。

## Phase 4D 离线模拟边界

Phase 4D 在 `tools/live-event-simulator` 提供独立的 loopback-only 测试客户端。它使用 Node.js 内建 crypto 对原始 JSON bytes 签名，再通过真实 HTTP Middleware、Schema、Controller、Service 和隔离 MySQL 交易验证 Phase 4B 到 Phase 4C 的边界。

模拟器不导入 Backend Controller 或 Service 来替代 HTTP 验收，也不直接连接 MySQL。测试夹具负责建立和断言专属临时数据库；事件产生的业务写入仍只经过 Backend。隔离 Backend 从空临时工作目录启动，不读取正式 `.env`，并只允许合成 target。

```
synthetic fixture -> signer -> loopback HTTP -> Live Event API
                                             -> live_events
                                             -> strict 点歌 parser
                                             -> song_requests + history
```

该工具不加入正式 Docker Compose，不改变现有三个服务的启动方式，不连接 B站、Cloudflare 或远程域名。未来沉默 listener 可以重用事件工厂、签名契约与脱敏边界，但必须独立实现官方连接、心跳和重连。
