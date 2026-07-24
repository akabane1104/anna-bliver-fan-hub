# 本地 Docker 运行说明

本文档用于 Windows 11 Docker Desktop 本地基线。站点继续使用原项目的简体中文界面、GPL-3.0-or-later 许可证、`NOTICE`、项目标识与原作者署名。Phase 0 不导入正式歌单、商品或品牌资料，也不连接 bili-bot、阿里云 Captcha、腾讯云 SES 或真实 B 站 Cookie。

## 环境要求

- Windows 11 与已启动的 Docker Desktop（Linux containers 模式）
- Docker Engine 和 `docker compose`
- 首次构建时可访问 Docker Hub 与 npm registry
- 建议至少预留 4 GB 内存和 10 GB 磁盘空间

Node.js 与 npm 只用于宿主机测试；容器构建固定使用现有 `package-lock.json` 和 `npm ci`。

## 第一次启动

在项目根目录打开 PowerShell：

```powershell
.\scripts\docker-start.ps1 -Initialize
```

`-Initialize` 在 `.env` 不存在时创建它，并为 `MYSQL_ROOT_PASSWORD`、`MYSQL_PASSWORD`、`JWT_SECRET` 与 `LIVE_EVENT_REF_SECRET` 生成各自独立的随机值。`LIVE_EVENT_REF_SECRET` 使用至少 32 bytes 的安全随机值；已有非空值不会在重跑时轮替。脚本不会显示密钥全文，也不会创建默认管理员密码。

启动完成后访问：

- 前端网站：`http://localhost:3000`，默认仅绑定 `127.0.0.1`
- 后端健康检查：`http://localhost:5000/api/health`
- MySQL：`127.0.0.1:3306`，仅绑定本机回环地址

查看容器与 HTTP 状态：

```powershell
.\scripts\docker-status.ps1
```

## 创建管理员

1. 先在 `http://localhost:3000/register` 正常注册账号，自行设置密码。
2. 使用注册邮箱提升该账号：

```powershell
.\scripts\docker-promote-admin.ps1 -Email 'your-admin@example.com'
```

重新登录后即可进入管理页面。此流程不创建固定密码，也不导入演示歌单或商品。

仓库原有的 `seed:demo` 仅用于明确需要演示数据的场景，必须通过 `DEMO_ADMIN_PASSWORD` 环境变量提供至少 12 位密码。Phase 0 不执行该命令。

## 停止与重新启动

停止服务并保留容器、MySQL 与 uploads 数据：

```powershell
.\scripts\docker-stop.ps1
```

使用已有镜像重新启动：

```powershell
.\scripts\docker-start.ps1 -NoBuild
```

重新构建并启动：

```powershell
.\scripts\docker-start.ps1
```

移除容器和网络但保留数据卷：

```powershell
.\scripts\docker-stop.ps1 -RemoveContainers
```

这些脚本不会执行 `docker compose down --volumes`。不要在没有有效备份时手工删除命名卷。

## 备份 MySQL 与 uploads

服务运行时执行：

```powershell
.\scripts\docker-backup.ps1
```

每次备份会创建 `backups\yyyyMMdd-HHmmss\`，其中包含：

- `mysql.sql`：`anna_bliver_fan_hub` 数据库逻辑备份
- `uploads.tar.gz`：`backend/uploads` 持久化内容
- `manifest.json`：时间与两个文件的 SHA-256

`backups/` 已被 Git 忽略。备份可能包含用户资料、订单、地址与上传文件，应加密保存并限制访问。

## 还原

还原会覆盖当前数据库与 uploads。脚本默认先备份当前状态，并要求输入确认文本：

```powershell
.\scripts\docker-restore.ps1 -BackupDirectory '.\backups\20260723-120000'
```

自动化场景可加 `-Force` 跳过交互确认。只有在当前环境无法备份且已确认风险时，才使用 `-SkipSafetyBackup`。

## 数据持久化

Compose 使用两个命名卷：

- `${COMPOSE_PROJECT_NAME}_mysql_data`：MySQL 数据目录
- `${COMPOSE_PROJECT_NAME}_uploads_data`：容器内 `/app/uploads`，对应项目的 `backend/uploads`

停止、重启或重新创建容器不会删除这两个卷。`schema.sql` 只会在全新的空 MySQL 卷首次初始化时运行。

## 可选集成状态

Phase 0 的 `.env` 中以下变量必须保持空白：

- `BOT_WS_URL`、`BOT_WS_TOKEN`
- `BILIBILI_COOKIE`
- 全部 `ALIYUN_*`
- `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY` 与全部 `SES_*` 凭据/模板

在这些值为空时，网站、注册登录、人工积分、CSV、商城与管理功能仍由本地服务独立运行。

## 常见诊断

```powershell
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 200 mysql
docker compose --env-file .env logs --tail 200 backend
docker compose --env-file .env logs --tail 200 frontend
```

若 `3000`、`5000` 或 `3306` 已被占用，在 `.env` 中修改对应的 `FRONTEND_PORT`、`BACKEND_PORT`、`MYSQL_PORT` 后重新启动。修改 `FRONTEND_PORT` 时必须同时把 `PUBLIC_ORIGIN` 改为相同端口；不要修改容器内部端口。

`FRONTEND_BIND_HOST` 默认并建议保持为 `127.0.0.1`。未来公开部署应通过 HTTPS 反向代理访问，不应直接把前端、后端或 MySQL 的本机开发端口暴露到公网。
