# Phase 4J：OBS Browser Source 画面元件

Phase 4J 提供透明背景、匿名读取的 OBS Browser Source。它读取 Phase 4I 的
canonical 点歌状态，不建立第二套点歌队列，也不依赖 OBS WebSocket。

## Browser Source

`/obs` 与所有 `/obs/*` 都是透明直播输出，不挂载网站 navbar、footer、备案信息、
作者署名或其他网站外壳。一般网站与 `/admin/obs-overlays` 仍保留正常网站署名；
管理页内的 OBS 预览内容本身仍遵守输出页例外。此行为由 route composition 与
protected runtime loader 决定，不使用 CSS 隐藏、裁切或透明化署名。

| 画面 | URL | 建议尺寸 |
|---|---|---|
| 正在演唱 | `/obs/now-playing` | 900 x 180 |
| 下一首 | `/obs/next-song` | 700 x 110 |
| 点歌队列 | `/obs/song-queue` | 520 x 480 |
| 今日点歌 | `/obs/today-count` | 300 x 100 |
| 今日活动 | `/obs/activity-progress` | 720 x 130 |
| 礼物感谢 | `/obs/gift-ticker` | 900 x 100 |
| 上舰提醒 | `/obs/guard-alert` | 1920 x 1080 |
| 棉花糖 | `/obs/cotton-candy` | 900 x 500 |
| AI 气泡 | `/obs/ai-bubble` | 640 x 240 |
| 直播通知 | `/obs/notice` | 700 x 160 |
| 全量预览 | `/obs/preview` | 浏览器窗口 |

在 OBS 新增 Browser Source，输入网站 origin 加上对应路径，并把宽高设为表中尺寸。
画面没有 canonical 数据时会保持透明，不显示空卡或错误。队列可使用
`?maxItems=1` 到 `?maxItems=10` 调整显示数量；无效值安全回到 5。

## 数据与即时更新

`GET /api/public/obs-overlay/state` 返回完整匿名 snapshot；
`GET /api/public/obs-overlay/stream` 使用原生 SSE 发送初始 snapshot、状态更新与
heartbeat。SSE 断线时浏览器每 2.5 秒轮询，恢复后停止高频轮询，并每 30 秒低频
对账。Frontend Nginx 只为 stream 路径关闭 buffering。

点歌资料来自 `songRequestService.getCenter()` 的公开 DTO：只包含歌曲、公开排序、
ETA 与既有遮罩显示名称。不会返回 user ID、open ID、原始点歌文字、内部备注、
邮箱、地址、电话、token、积分或原始数据库 row。今日点歌计数以北京时间日界
统计成功进入点歌系统的有效 request，并排除取消、拒绝等无效状态。
活动来自直播中控的既有 activity setting。

## 权限与事件

`/admin/obs-overlays` 需要 `live_control.manage`，可复制 URL、查看预览、发送手动
通知／AI 气泡，以及发送纯模拟礼物与上舰事件。棉花糖管理页的“展示到 OBS”仍
需要 `marshmallow.manage`。事件 payload 依类型严格 allowlist，只允许纯文字，
并以 source 加 idempotency key 去重。

Simulator 事件只写 `obs_overlay_events`，不会写入积分、`live_events` 或
`bilibili_point_events`。当前没有正式礼物／上舰来源，没有连接 B站 REST/WSS，
没有启用 Listener ingest，也没有安装或调用本地 AI。AI 气泡目前只是主播手动
输入；`source=ai` 仅保留为未来内部来源分类，管理 API 不接受它。

## 常见状态

- OBS 重新开启 Browser Source 后会重新读取完整 snapshot。
- SSE 被暂时中断时会自动使用轮询，恢复后自动回到事件更新。
- 元件持续空白时，先在 `/obs/preview` 确认画面，再检查公开 snapshot 是否有对应
  canonical 数据。
- 临时事件可在管理页结束显示；事件过期后也会自动停止重播。
