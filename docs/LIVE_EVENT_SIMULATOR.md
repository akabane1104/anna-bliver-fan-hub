# 离线直播事件模拟器

## 用途

`tools/live-event-simulator` 是 Phase 4D 的离线测试工具。它生成明确的合成直播事件，按 Live Control Event API v1 的原始字节签名协议发送到 loopback Backend，并验证 HTTP 状态和稳定 ACK。它用于验证 Phase 4B 事件入口到 Phase 4C 统一点歌队列的完整路径，不是正式 B站 listener。

模拟器不会连接 B站、主播直播间、Cloudflare preview 或任何远程服务，不会发送 B站弹幕，不读取正式 `.env`，也不直接连接 MySQL。所有业务数据写入只能由 Backend 完成。

## 安全边界

- 目标只允许 `http://127.0.0.1`、`http://localhost` 和实现支持时的 `http://[::1]`。
- 只接受上述主机的明确字面形式；会被 URL 解析器归一化为 loopback 的整数、十六进制、八进制或缩写 IPv4 形式同样拒绝。
- HTTPS、preview 域名、正式域名、局域网地址、通配地址、带凭据 URL 和非根路径全部拒绝。
- 不提供 `--allow-remote`、`--force-remote` 或其他远程绕过参数。
- `LIVE_EVENT_INGEST_SECRET` 只能由调用进程的环境变量提供，不能通过 CLI 参数、fixture 或 JSON 传入。
- 模拟器不自动加载任何 `.env`。测试每次运行都生成新的临时随机 Secret。
- 输出不包含 Secret、完整签名、请求 Header、Cookie、Token、open_id 或原始请求体。
- `site_id` 必须使用 `phase4d-` 合成前缀，`room_id` 必须使用测试专用的 `99` 长数字格式。
- 所有场景均使用合成用户、合成 open_id、合成房间和合成事件内容。

签名完全复用现有 Phase 4B 契约：

```text
HMAC-SHA256(secret, timestamp + "." + raw_request_body)
```

请求头仍为 `X-Live-Timestamp` 与 `X-Live-Signature`。事件在发送前使用 Backend 现有严格 Zod schema 验证，不维护第二套协议定义。

## dry-run

dry-run 只生成并验证 fixture，不建立 HTTP 连接，也不需要 Secret：

```powershell
npm run dry-run --prefix tools/live-event-simulator -- --scenario all
```

指定单一场景和合成目标：

```powershell
node tools/live-event-simulator/src/cli.js dry-run `
  --scenario traditional-request `
  --site-id phase4d-synthetic `
  --room-id 99000000000000000001 `
  --fixture phase4d-synthetic-session
```

## run

run 要求调用进程已经注入本次测试临时生成的 `LIVE_EVENT_INGEST_SECRET`，且隔离 Backend 使用同一个临时值：

```powershell
node tools/live-event-simulator/src/cli.js run `
  --base-url http://127.0.0.1:5001 `
  --scenario all `
  --site-id phase4d-synthetic `
  --room-id 99000000000000000001 `
  --fixture phase4d-synthetic-session
```

禁止把 Secret 写入命令、脚本、fixture、文档或 Git 文件。`--secret` 会被明确拒绝。

## 场景

`all` 包含以下场景：

- `simplified-request`：`点歌 年轮`。
- `traditional-request`：`點歌 年輪`，匹配数据库原文“年轮”。
- `ordinary-chat`：普通弹幕，不建立请求。
- `playback-command-rejected`：`播放 年轮`，不建立请求。
- `missing-space`：`点歌年轮`，不建立请求。
- `unmatched-song`：不存在的合成歌名，进入待人工处理。
- `case-variants`：分别验证 `fancy`、`FANCY` 和 ambiguous 的 `Fancy`。
- `duplicate`：同一事件重放，验证 201 后返回 200。
- `conflict`：相同 event_id、不同内容，验证 409 且不覆盖。
- `same-song-viewers`：不同合成观众点同一首歌，建立独立队列项。
- `gift-event`：礼物事件只写入 live_events，不建立点歌请求或积分。

`transaction-rollback` 只供隔离端到端测试使用。测试先在专属临时 MySQL 中建立受控失败条件，再验证 Backend 返回 `database_error` 且 live_event 与 song_request 同时回滚。

系统目前不存在公开“播放”指令，也不存在第二条播放队列。`played` 仅是主播处理统一点歌请求时使用的内部 `fulfillment_type`。

## 输出与 ExitCode

默认输出只有场景数、通过/失败数、HTTP 请求数、accepted、duplicate、conflict、database_error 和预期点歌请求数。`--json` 提供同样的脱敏计数，供自动测试解析。

- ExitCode `0`：全部 fixture、HTTP 状态和 ACK 断言通过。
- ExitCode `1`：参数、安全限制、网络、schema 或 ACK 断言失败。

失败输出只包含稳定错误码，不回显响应正文、请求正文、Header 或凭据。

## 隔离测试

```powershell
npm run test:e2e --prefix tools/live-event-simulator
```

该测试使用唯一 Compose project name、临时 MySQL 8 容器、随机 loopback 端口和专属 volume。完整 schema 与最小合成 fixture 只写入该临时数据库。隔离 Backend 从空临时工作目录启动，因此不会读取项目正式 `.env`。

测试结束、断言失败、未处理异常或收到 SIGINT/SIGTERM 时，都复用同一套可重入清理流程。它会继续尝试每个清理步骤，并只按精确 Compose project name 删除本次临时容器与 volume；不会执行全局 prune，也不接触现有三个服务、正式 volume、uploads 或备份。

## 与未来 listener 的边界

未来正式沉默 listener 可以重用：

- `src/eventFactory.js` 的标准事件构造约定。
- `src/signer.js` 的原始字节 HMAC 契约。
- `src/scenarios.js` 中不含凭据的合成 fixture 结构。
- `src/redaction.js` 的敏感字段边界。

正式 listener 仍应作为独立进程实现心跳、重连、官方凭据管理和事件接收。模拟器不会演变成 B站连接器，也不能用于正式远程域名。
