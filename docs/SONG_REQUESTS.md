# 统一点歌队列

## 产品边界

公开点歌只支持一个概念：`点歌`。所有 B站弹幕、网站和人工请求进入同一条队列，不建立“播放”指令，也不建立第二条播放队列。主播处理请求时才可选择 `sung`（演唱）或 `played`（背景播放）；观众提交时不能选择。

本阶段只实现 backend、数据库 Schema 与 API，不修改前端，不连接真实 B站，不控制 OBS 或酷狗，不扣积分，也不发送弹幕。

## 指令语法

在检查单行、安全控制字符和最大长度后，对整条输入执行 Unicode NFKC 与外层空白处理。只接受：

```text
^(点歌|點歌)[ \t\u3000]+(.+?)$
```

有效示例：

- `点歌 年轮`
- `點歌 年輪`
- `点歌　后来`
- `點歌    後來`

无效示例：

- `点歌年轮`
- `点歌：年轮`
- `播放 年轮`
- `播歌 年轮`
- `我想点歌 年轮`
- `点歌`
- 多行、NULL 字符、危险控制字符或超长输入

Parser 是纯函数，不访问数据库。`raw_request_text` 与 `requested_title` 始终保留原文。

## 文字正规化

每份查询与候选文字派生以下只读概念：

1. `raw_text`：原始输入，永不覆盖。
2. `nfkc_text`：Unicode NFKC，用于统一全形英文、数字与宽度差异。
3. `whitespace_normalized`：去除外层空白，将连续半形空格、Tab 与全形空格折叠为一个空格。
4. `script_key`：通过 `opencc-js` 转为统一简体形式，只用于比较。
5. `loose_candidate_key`：在 script key 上折叠英文大小写，只用于候选。

不删除中文，不随意移除标点，不做拼音、语义翻译或全站文案转换。歌曲标题、歌手、站点名称、商品、棉花糖、用户名和管理员备注均保持原文。

## 匹配顺序

匹配范围只限当前场次指定的 playlist：

1. 歌曲原始标题大小写敏感精确匹配。
2. NFKC 与空白正规化后的精确匹配。
3. 简繁 `script_key` 精确匹配。
4. 别名原文大小写敏感精确匹配。
5. 别名 `script_key` 精确匹配。
6. 使用包含关系或英文大小写折叠产生最多五个候选。
7. 没有候选时标记 `unmatched`。

每一优先层级只有恰好命中一首歌时才自动选择；同层多首立即标记 `ambiguous`，低优先层级不能覆盖高优先层级结果。候选匹配永不自动选歌。

歌曲目录与别名均加载后在应用层做大小写敏感比较，不依赖 MySQL 默认 Collation。因此：

- `fancy` 只命中 `fancy`。
- `FANCY` 只命中 `FANCY`。
- `Fancy` 返回 ambiguous，并列出两首候选。

别名保留原文；同一首歌的等价别名不能重复，不同歌曲可以共享冲突别名，此时必须人工确认。不为现有 447 首歌曲批量生成别名。

## 场次状态机

允许转换：

```text
draft -> open -> paused -> open
  |        |       |
  +------> closed <+
```

- `draft -> open | closed`
- `open -> paused | closed`
- `paused -> open | closed`
- `closed` 不可重新开启

同一 `site_id + room_id` 同时最多一个 `open` 或 `paused` 场次。只有 open 场次自动接收新请求；paused、draft、closed 或无场次时，直播点歌只保留为未归属的 `observed`，不分配 `queue_order`。

## 请求状态机

允许转换：

```text
observed -> needs_match -> queued -> active -> completed
    |            |           |         |
    |            |           |         +-> skipped
    |            |           |         +-> failed -> queued
    |            |           +-> rejected / cancelled / skipped
    |            +-> rejected / cancelled
    +-> queued / rejected / cancelled
```

`observed -> queued` 与 `needs_match -> queued` 必须通过明确的场次指派、人工选歌或接受 unmatched 操作，不能借普通 requeue 绕过人工确认。terminal 状态不能回到 active，completed 不可再修改。

`fulfillment_type` 建立时固定为 `undecided`，只有管理权限可在 queued 或 active 阶段设为 `sung` 或 `played`。completed 前必须完成选择；rejected、cancelled、skipped 不要求选择；completed 后不可修改。

## 事件一致性

Phase 4B 首次 accepted 的 danmaku 与其派生请求使用同一 MySQL 事务：

- live event 与 request 全部成功后一起提交。
- Parser、匹配或 request 写入失败时一起回滚。
- duplicate 与 event_id conflict 不再次解析。
- `song_requests.source_event_id` 非空时全局唯一。
- replay 保留原始 `event_id`。

该流程不调用 `pointsService`，不写积分表，不把 open_id 映射为数字 UID，也不按显示名推测网站用户。

## 网站幂等与排序

网站点歌必须登录并携带稳定的 `Idempotency-Key`。服务器从 JWT 登录状态确定 `requester_user_id`，不接受 Body 伪造。相同用户、相同 Key、相同请求返回 duplicate；同 Key 对应不同请求返回冲突。

同一首歌由不同观众请求时会产生不同队列项，不按歌名自动去重。队列序号在事务内锁定场次行后，通过数据库当前读生成；并发新增不会使用进程内计数器。`needs_match` 与 `queued` 都参与普通拖曳排序，active 与终态不参与。

重排必须提交场次 `expected_version`，并恰好包含该场次所有可重排请求一次。过期版本返回 `409 version_conflict`；遗漏、重复、跨场次或混入 active/终态返回 `invalid_reorder_set`。排序变化写入 history。

## 权限、隐私与审计

普通登录用户可以通过 `/api/song-requests` 点歌；当前队列是只含安全字段的公开读取接口。场次、请求、排序和别名管理只允许管理员或具有 `live_control.manage` 权限的用户。实现不会自动向正式用户写入该权限。

open_id 属于平台个人识别资料，只保存在内部数据库，不通过公开 API 返回，也不连接现有数字 UID。日志不得记录完整 open_id、邮箱、Cookie、Secret、身份码、HMAC 签名、弹幕全文、SC 全文或原始请求体。

每次状态、匹配、排序、`fulfillment_type` 或场次归属变化都会新增一条 `song_request_history`。API 不提供修改或删除历史记录的能力；删除别名也不改变已有请求历史。

## 后续阶段

全站简体/繁体界面切换属于未来独立阶段，本阶段没有实现。OBS Overlay、主播本地 Helper、酷狗适配器、私有中控台和真实 B站沉默监听器也不属于本阶段。

## Phase 4D 离线契约验证

离线模拟器通过真实签名 HTTP 入口验证以下既有规则，不改变状态机或匹配逻辑：

- `点歌 年轮` 精确匹配，“點歌 年輪”通过简繁键匹配并保留原文。
- 普通聊天、`播放 年轮` 和 `点歌年轮` 不建立请求。
- 不存在的歌名进入 `needs_match`，不会猜测其他歌曲。
- `fancy` 与 `FANCY` 分别精确匹配，`Fancy` 保持 ambiguous。
- duplicate、conflict、非 danmaku 不重复建立请求。
- 相同歌曲由不同观众请求时保留独立且稳定递增的队列项。
- 受控数据库失败时 live_event 与 song_request 在同一事务中回滚。

模拟器仍然只验证单一统一点歌队列。公开层不存在“播放”指令，唱或播继续由主播通过内部 `fulfillment_type` 决定。详见 [LIVE_EVENT_SIMULATOR.md](LIVE_EVENT_SIMULATOR.md)。
