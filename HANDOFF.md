# Phase 0 交接说明

## 交接范围

当前基线只提供可重复的本地与 Linux Docker 运行环境，没有修改网站品牌、页面外观或业务规则，没有导入正式歌单与商品，也没有启用外部机器人、验证码、邮件或真实 B 站 Cookie。

保留内容包括 GPL-3.0-or-later、`LICENSE`、`NOTICE`、网站项目标识、页脚 `© 2026 Linus_Lieu` 及其原作者链接。前端构建仍执行仓库原有的受保护公开资源完整性校验。

## 运行结构

| 服务 | 镜像/构建 | 本机入口 | 持久化 |
| --- | --- | --- | --- |
| `mysql` | `mysql:8.0` | `127.0.0.1:3306` | `mysql_data` |
| `backend` | `backend/Dockerfile`，Node.js 20 + Express | `127.0.0.1:5000` | `uploads_data` |
| `frontend` | `frontend/Dockerfile`，React 生产构建 + Nginx | `0.0.0.0:3000` | 无状态 |

Nginx 同源反向代理 `/api/` 与 `/uploads/` 到后端。MySQL 健康后才启动后端，后端健康后才启动前端；三个服务都配置了健康检查和 `unless-stopped` 重启策略。

## 接手后的日常命令

```powershell
.\scripts\docker-start.ps1 -Initialize  # 仅第一次
.\scripts\docker-start.ps1              # 构建并启动
.\scripts\docker-start.ps1 -NoBuild     # 直接重启
.\scripts\docker-status.ps1
.\scripts\docker-stop.ps1
.\scripts\docker-backup.ps1
```

完整操作与管理员创建方式见 `LOCAL_SETUP.md`。

## 已完成的本机验收

2026-07-23 在 Windows 11 Docker Desktop 上完成以下实测：

- 后端测试 34/34、前端测试 3/3、受保护公开资源校验与 React 生产构建通过
- MySQL、backend、frontend 三个容器健康，数据库创建 22 张基线表
- 注册、登录、管理员提升、用户资料、歌单、棉花糖、人工积分、CSV、商城与管理 API 正常
- 首页及对应前台/管理 SPA 路由均返回 HTTP 200
- 完整停止并重启后，数据库测试账号与 uploads 测试文件仍存在
- MySQL + uploads 备份、覆盖测试数据、还原及 SHA-256 校验通过
- 验收用账号、上传标记与测试备份已清理；最终保持 0 用户、0 歌曲、0 商品

## 搬到另一台电脑

1. 在源机器运行 `.\scripts\docker-backup.ps1`。
2. 复制整个项目源码和选定的 `backups\时间戳\` 目录到目标机器。不要复制 `node_modules`、前端 `build` 或 Docker 原始卷目录。
3. 通过安全通道单独传输 `.env`；若不需要保留现有登录令牌，也可在目标机器使用 `-Initialize` 生成新密钥。
4. 在目标机器启动 Docker Desktop，进入项目根目录运行 `.\scripts\docker-start.ps1`。
5. 使用 `.\scripts\docker-restore.ps1 -BackupDirectory '.\backups\时间戳'` 还原数据库与 uploads。
6. 运行 `.\scripts\docker-status.ps1`，再测试登录、管理页和上传文件。

不要把 `.env`、备份或任何真实 Cookie 提交到 Git。

## 搬到 Linux 云端主机

同一份 `docker-compose.yml` 与 Dockerfile 可直接使用。PowerShell 脚本是 Windows 运维入口；Linux 上使用等价的 `docker compose --env-file .env ...` 命令，备份内容仍可跨平台还原。

上线前至少调整：

- `PUBLIC_ORIGIN=https://实际域名`
- 若外层还有反向代理，将 `FRONTEND_BIND_ADDRESS` 设为 `127.0.0.1`，并按真实代理跳数设置 `TRUST_PROXY`
- 配置 HTTPS、防火墙、主机级备份、日志轮转与监控
- 用安全通道配置生产密钥，不复用示例值或测试管理员密码

云端部署、正式品牌资料、正式商品/歌单与外部集成属于下一阶段，不在本次 Phase 0 范围内。

## 安全与维护注意事项

- `.env.example` 只包含占位符；本机 `.env` 由启动脚本生成随机密钥并受 `.gitignore` 保护。
- 后端与 MySQL 默认只绑定 `127.0.0.1`，前端默认监听 `3000`。
- 备份是敏感数据，应加密、限制访问并定期演练还原。
- 不要运行带 `--volumes` 的 Compose 删除命令，除非已确认要永久清空数据。
- 更新代码前先备份，再执行 npm 测试、前端生产构建和 Docker 镜像重建。
- 站点与管理后台继续固定使用简体中文，不根据操作系统或浏览器语言自动切换。

## 已知问题

- Phase 0.5 最小修复后，后端仍有 2 个腾讯 SDK/uuid 上游中危告警；前端完整开发工具链有 47 个告警，但 production audit 为 0。
- 详细依赖路径、正式镜像边界、风险判断和后续策略见 `docs/DEPENDENCY_AUDIT.md`。
- Favicon 仍沿用原文件，Phase 1A 不设计或替换；待取得正式品牌图标后单独处理。
- `BOT_WS_URL`、`BOT_WS_TOKEN` 保持空白并关闭，不启用 Bot。
- 原作者现有 Bot 直接写入原作者本地数据库，无法接入本项目的独立 Docker 数据库。
- 当前 WebSocket 接口仅为未来公开版 Bot 或自建 Bot 预留。
- 当前积分通过后台人工调整或 CSV 导入维护。
