# 部署与发布验收

以下示例以 Ubuntu 22.04/24.04、Backend Node.js 20、Frontend build Node.js 22.22.0 或更新版本、MySQL 8、Nginx 和 systemd 为基准。Frontend Docker build stage 固定使用 Node.js 24。其他平台只要提供同等的 HTTPS、进程守护和持久化能力也可以部署。

## 目录建议

```text
/srv/anna-bliver-fan-hub/          # 代码
/srv/anna-bliver-fan-hub/frontend/build/
/srv/anna-bliver-fan-hub/backend/uploads/  # 需要持久化和备份
/etc/anna-bliver-fan-hub/backend.env
```

不要把生产 `.env` 放进公开 Git 仓库。部署用户应只拥有应用目录和必要日志目录的权限。

## 数据库账号

全新空数据库先运行基线：

```bash
mysql -u root -p < backend/src/config/schema.sql
```

随后使用显式版本化迁移登记并复核 schema：

```bash
npm run db:migrate:preflight --prefix backend
npm run db:migrate:apply --prefix backend
npm run db:migrate:postcheck --prefix backend
```

再在 MySQL 中创建独立账号。请替换密码和允许连接的主机：

```sql
CREATE USER 'fan_hub'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
ON anna_bliver_fan_hub.* TO 'fan_hub'@'127.0.0.1';
FLUSH PRIVILEGES;
```

后端启动会执行公开积分结构的兼容检查，因此账号需要 `CREATE`、`ALTER` 与 `INDEX`。如果部署流程单独执行迁移，可在迁移结束后按实际查询进一步收紧权限。

`schema.sql` 只面向全新空数据库，不是旧生产数据库迁移工具。既有安装必须先备份，
再使用版本化 migration；不要在旧库上直接反复执行完整 schema。迁移命令不会自动
读取 `.env`，也不会随 Backend 启动。完整 preflight、status、失败恢复、数据保留
回退及禁止破坏性删表的流程见
[数据库版本迁移](SCHEMA_MIGRATIONS.md)。

Backend Docker image 包含 `backend/migrations` catalog，但 Compose 不会自动执行
既有数据库升级。使用 Compose 时先只启动健康的 MySQL，再通过 Backend image
明确执行 `preflight`、`apply` 与 `postcheck`；任一步骤非零都必须停止部署。

## 生产环境变量

至少设置：

```dotenv
NODE_ENV=production
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=fan_hub
DB_PASSWORD=<strong-database-password>
DB_NAME=anna_bliver_fan_hub
JWT_SECRET=<at-least-32-random-characters>
LIVE_EVENT_REF_SECRET=<independent-at-least-32-byte-random-secret>
JWT_EXPIRES_IN=24h
PORT=5000
TRUST_PROXY=1
CORS_ORIGIN=https://example.com
REQUEST_BODY_LIMIT=4mb
```

生成 JWT 示例：

```bash
openssl rand -base64 48
```

`LIVE_EVENT_REF_SECRET` 用于管理事件的 opaque reference，必须与
`LIVE_EVENT_INGEST_SECRET`、`JWT_SECRET` 和数据库密码完全独立。Compose 初始化
脚本会在缺少时生成且不会轮替已有非空值；不要在日志、Git 或命令行参数中显示它。
网站首发仍保持 `LIVE_EVENT_INGEST_ENABLED=false`，不要求启用 B站 Listener。

Compose 包含独立 `bilibili-listener` service，但所有 gate 默认关闭。Disabled
部署不会接触 B站，且不会取得 MySQL credential、published port、uploads 或
backup volume。只有正式凭据、主播身份码、允许 target 与独立 ingest secret
全部存在时，才可依 [B站 Listener](BILIBILI_LISTENER.md) 的顺序启用 Backend
ingest 与 Listener；不得使用 Cookie 或手动 WSS URL。

单层 Nginx 反向代理使用 `TRUST_PROXY=1`；后端直接暴露时使用 `0`。Cloudflare、负载均衡器和 Nginx 叠加时，必须按真实可信跳数配置，不能猜测。

## 安装与构建

```bash
npm ci --prefix backend
npm ci --prefix frontend
REACT_APP_API_URL=https://example.com/api npm run build --prefix frontend
npm test
```

Captcha 的两个 `REACT_APP_*` 值也是构建时变量。启用 Captcha 后必须重新构建前端。

## systemd

`/etc/systemd/system/anna-fan-hub.service`：

```ini
[Unit]
Description=Anna BLive Fan Hub API
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=anna-fan-hub
Group=anna-fan-hub
WorkingDirectory=/srv/anna-bliver-fan-hub/backend
EnvironmentFile=/etc/anna-bliver-fan-hub/backend.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/srv/anna-bliver-fan-hub/backend/uploads

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now anna-fan-hub
sudo systemctl status anna-fan-hub
```

## Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    root /srv/anna-bliver-fan-hub/frontend/build;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

使用 Certbot 或等效服务配置 TLS，并将 HTTP 永久重定向到 HTTPS。后端端口只应监听内网或由防火墙限制。

## 上传与备份

需要持久化：

- MySQL `anna_bliver_fan_hub` 数据库。
- `backend/uploads/branding/`。
- `backend/uploads/prizes/`。

推荐每日数据库备份、上传目录增量备份和定期恢复演练。备份不得进入公开仓库。
标准备份格式同时保存 database default character set／collation，并在 manifest 中记录
`mysql.sql`、uploads archive 与 `database-metadata.json` 的大小及 SHA-256。发布前必须使用标准
restore 流程完成隔离恢复，确认目标数据库 default metadata 精确恢复；缺少 metadata 的旧格式备份
只能经显式 legacy override 使用，不得当作完整恢复点。

## 更新流程

1. 备份数据库和上传目录。
2. 在临时目录执行 `npm ci`、测试和前端构建。
3. 保持 Listener 与事件入口关闭，执行 migration `status`、`preflight`、`apply` 和 `postcheck`。
4. 只有 postcheck 成功后才替换构建产物并重启后端。
5. 检查健康接口、日志和核心业务。
6. 保留可回退的上一版本代码与构建产物；应用回退必须保留新增表及数据。

## 发布验收

- [ ] `npm test`、前端 Jest、`npm run build` 全部通过。
- [ ] 前后端 `npm audit --omit=dev` 没有高危或严重漏洞。
- [ ] `NODE_ENV=production` 能通过启动配置校验。
- [ ] `CORS_ORIGIN` 只包含实际前端域名，未知来源返回 403。
- [ ] 登录、注册开关、Captcha/无 Captcha、邮件/无邮件场景符合配置。
- [ ] 四种观众角色权限一致且互相独立，主播日常运营权限与管理员专用边界分别验证，未授权请求返回 403。
- [ ] 歌曲单条/批量新增、标签、冠名流程正常。
- [ ] 棉花糖匿名投递、认领、回复和批量删除正常。
- [ ] B站绑定二维码仅创建者可轮询，绑定上限与主账号切换正常。
- [ ] 商城图片、选项、购物车、地址、结账、拒绝退款和回库存正常。
- [ ] bili-bot 未配置时网站独立启动；配置后 ACK、重复事件和断线补偿正常。
- [ ] 桌面和移动端首页、资料、商城及管理页没有控制台错误。
- [ ] 上传目录可写且已经纳入备份。
- [ ] Git 工作区干净，所有新增运行文件已提交，远端 CI 通过。
