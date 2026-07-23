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
