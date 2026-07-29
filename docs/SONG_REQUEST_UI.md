# 点歌前台与控制台

Phase 4G-A 将 Phase 4C 的统一点歌队列接入现有网站。它没有建立第二条队列，也没有改变点歌、积分、礼物或 B站事件契约。

## 页面

- `/playlists`：现有网页歌单，同时提供观众点歌和公开队列。
- `/admin/song-requests`：点歌控制台，仅管理员、主播或具有 `live_control.manage` 权限的登录用户可访问。

前台沿用网站账号 JWT。浏览器只提交 `song_id` 和 `Idempotency-Key`；请求者身份、来源、状态和队列位置全部由 Backend 决定。未登录用户仍可浏览歌单，但不能提交点歌。

## 统一队列

`website`、`manual`、`bilibili_danmaku`、`simulation` 和 `replay` 都写入现有 `song_requests`。公开层只有简体或繁体“点歌”命令，不存在“播放”指令或第二条播放队列。`sung` 与 `played` 仅是主播处理中的内部 `fulfillment_type`。

公开队列只返回：

- request public ID
- 原始请求歌名
- 匹配后的公开歌曲信息
- 可公开的点歌者显示名
- status
- fulfillment type
- queue order
- requested time

公开响应不包含 numeric UID、open_id、event_id、网站 user ID、内部 reason、version、原始直播事件或凭据。

## API

### 公开读取

- `GET /api/song-requests/catalog`
  - 参数：`query`、`tag`、`page`、`limit`
  - `limit` 最大 500。
  - 搜索覆盖歌名、歌手和现有别名。
  - 简繁转换仅用于搜索键，不改写原始显示文字。
- `GET /api/song-requests/current`
  - 不传 target 时只在恰好一个 active session 的情况下返回队列。
  - 多个 active session 时安全返回冲突，不猜测目标。

### 网站点歌

- `POST /api/song-requests`
  - 必须登录。
  - 必须提供 8 至 128 字符的 `Idempotency-Key`。
  - Phase 4G-A 页面只提交 `song_id`。
  - Backend 根据歌曲所属歌单解析唯一 open session，并再次验证歌曲归属。
  - 同一 Key 与同一请求返回 duplicate；同一 Key 对应不同请求返回 conflict。
  - 独立写入限流为每个来源地址每小时 30 次。

### 控制台

- `GET /api/live-control/sessions/active`
- `GET /api/live-control/sessions/recoverable`
- `GET /api/live-control/sessions/:publicId/requests`
- `GET /api/live-control/history`
- 其余场次、请求、排序和 fulfillment 路由沿用 `docs/API.md` 的 Phase 4C 契约。

历史查询支持 `query`、`status`、`source`、`page` 和 `limit`；`limit` 最大 100。所有筛选使用固定 SQL 和参数化值，不接受客户端排序字段。

## 操作规则

- 同一场次同时最多一条 `active` 请求。激活操作锁定场次行并在事务内检查已有 active 请求。
- complete 前必须选择 `sung` 或 `played`。
- skip 沿用 Phase 4C 状态机。
- “移除”等价于将合法等待请求转换为 `cancelled`，并要求二次确认。
- reorder 必须提交场次 `expected_version` 和完整的可排序 request public ID 集合。
- stale version 返回 409，前端重新读取服务器状态，不把冲突当作成功。
- 所有管理 mutation 由 Backend 再次检查管理员、主播或 `live_control.manage` 权限。
- 同一 target 的重复建立和同一 session 的重复 start、pause、resume、close 会在 Backend 权威层按资源串行化或共享结果。前端按钮 disabled 只改善操作体验，不是唯一防重边界。
- 前端会在同步进入 action handler 时登记资源锁；失败、超时或拒绝后通过安全清理路径释放，之后可以合法重试。不同 session 不共用全局锁。

## 场次恢复

控制台挂载、重新整理或重新进入时读取 Backend 的 `sessions/recoverable`，并恢复真实 `public_id`、status 与 version，不使用 browser storage 建立第二套草稿状态。

- open/paused 场次优先于 draft。
- 没有 active 场次时只恢复唯一 draft。
- 多个 draft 返回明确冲突并停止自动选择。
- closed 等终态不会恢复。
- 恢复既有 draft 不会建立新 draft；后续 open/close 使用恢复出的 session identity。

## 更新策略

公开页和控制台使用约 5 秒 polling。页面隐藏时不发起周期请求，重新可见后立即刷新；mutation 成功后立即重新读取服务器状态。

控制台为 sessions、queue、history 和 catalog 分别维护单调递增的 request identity，并在 mutation 开始时使旧读取 generation 失效。只有当前 request 且组件仍挂载时才能提交 data、error 或 loading；旧 polling、手动 refresh、初始 draft recovery 的迟到 success/error 都不会覆盖较新的操作结果。终止或过期请求不显示为当前操作错误，最新有效请求的真实错误仍会保留。

## 本阶段边界

- 不连接 B站 API 或 WSS。
- 不启用 Listener。
- 不发送弹幕。
- 不产生礼物积分。
- 不控制 OBS 或播放器。
- 不提供全站简繁切换。
- 不修改正式数据库、正式 Compose 或正式 `.env`。

本轮没有改变管理事件正文 DTO、`event_ref`、live status 查询结构、R1 migration 或 R2 WSS fail-closed 规则，也没有启用正式 Listener。
