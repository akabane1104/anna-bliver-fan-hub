<p align="center">
  <img src="frontend/public/annapiggy-logo.png" alt="小猪anna的秘密基地" width="320" />
</p>

# Anna BLive Fan Hub

`anna-bliver-fan-hub` 是一个面向 B站直播社区的开源全栈站点。它从原 `anna_site` 的公开业务中整理而来，保留网页歌单、匿名棉花糖、B站账号绑定、积分账本、积分商城和可配置主题，同时将 Bot、验证码与邮件都设计为可选集成。

项目采用 React 19、Express、MySQL 8 和 JWT。公开版只处理积分币种，不包含盲盒、电影票、OBS、激活码、QQ/AI 配置或私有 Bot 管理页面。

![桌面端首页](docs/screenshots/home-desktop.png)

<details>
<summary>查看移动端首页</summary>

![移动端首页](docs/screenshots/home-mobile.png)

</details>

## 功能

- 单站歌曲列表：搜索、标签、冠名、单条维护和批量导入。
- 棉花糖：匿名投递、登录后认领、管理回复和已读状态。
- B站绑定：扫码绑定最多五个 UID，共享同一积分钱包。
- 积分账本：手工调整、CSV 导入、事件幂等、余量电池和完整流水。
- 积分商城：商品选项、图片、购物车、地址、事务结账、订单和幂等退款。
- 权限管理：歌曲、棉花糖、积分、商城和站点配置可分别授权。
- 站点配置：标题、文案、Logo、favicon、首页 UID、备案和多套主题色卡。
- 直播首页与中控：统一点歌队列、自动／手动直播状态、今日活动和安全的礼物／上舰摘要。
- 可选集成：阿里云 Captcha、腾讯云 SES 和 bili-bot WebSocket。

## 项目结构

```text
anna-bliver-fan-hub/
├─ .github/workflows/ci.yml       # GitHub Actions 测试、构建与依赖审计
├─ backend/
│  ├─ scripts/seed_demo.js        # 可选演示数据
│  ├─ src/config/                 # 数据库、基线 SQL、运行配置校验
│  ├─ src/controllers/            # REST 控制器
│  ├─ src/middleware/             # JWT、可选认证、细粒度权限
│  ├─ src/routes/                 # API 路由
│  ├─ src/services/               # 积分、内部歌单、bili-bot 事件桥
│  ├─ src/utils/                  # Captcha、邮件、B站 API、输入校验
│  └─ test/                       # Node.js 回归与单元测试
├─ frontend/
│  ├─ public/                     # favicon、默认 Logo 和 PWA 元数据
│  └─ src/
│     ├─ components/              # 导航、Footer、反馈、绑定等通用组件
│     ├─ context/                 # 站点配置与主题上下文
│     ├─ pages/                   # 用户页面与管理页面
│     ├─ services/                # REST 客户端
│     └─ styles/                  # 全站和管理主题
├─ docs/                          # 架构、API、配置与部署文档
├─ CONTRIBUTING.md
├─ SECURITY.md
└─ package.json                   # 根目录聚合命令
```

更详细的模块与数据流见 [架构说明](docs/ARCHITECTURE.md)，REST、权限和 bili-bot 协议见 [API 文档](docs/API.md)。

## 本地运行

### 要求

- Backend 与 Listener：Node.js 20 LTS 或更新版本
- Frontend 测试与构建：Node.js 22.22.0 或更新版本
- npm 10 或更新版本
- MySQL 8

根目录没有 `npm start`，因为前后端需要两个常驻进程。根目录只提供安装、测试、构建和演示数据聚合命令。

### 1. 安装依赖

```bash
npm run install:all
```

### 2. 初始化数据库

Windows PowerShell 或 CMD：

```powershell
cmd /c "mysql -u root -p < backend\src\config\schema.sql"
```

Linux、macOS、Git Bash：

```bash
mysql -u root -p < backend/src/config/schema.sql
```

SQL 会为全新空数据库创建 `anna_bliver_fan_hub` 和 27 张业务表，但不会替你创建 MySQL 登录用户。既有数据库不得重跑完整 `schema.sql`，必须先备份，再依次执行 migration 的 `preflight`、`apply` 与 `postcheck`。最简单的本地方式是将后端 `.env` 的 `DB_USER` 改为已有的 MySQL 用户；独立数据库用户、Docker migration 与完整升级流程见 [部署文档](docs/DEPLOYMENT.md#数据库账号)。

### 3. 创建本地配置

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

Bash：

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

至少修改后端的数据库账号和 `JWT_SECRET`。生产环境会拒绝占位 JWT、缺失的 `CORS_ORIGIN` 或无效的 `TRUST_PROXY`。完整变量说明见 [配置参考](docs/CONFIGURATION.md)。

### 4. 分别启动

终端一：

```bash
cd backend
npm start
```

终端二：

```bash
cd frontend
npm start
```

默认地址：前端 `http://localhost:3000`，后端健康检查 `http://localhost:5000/api/health`。

### 5. 可选演示管理员

演示账号不会使用默认密码，密码至少 12 位。

PowerShell：

```powershell
$env:DEMO_ADMIN_PASSWORD='replace-with-a-local-password'
npm run seed:demo
Remove-Item Env:DEMO_ADMIN_PASSWORD
```

Bash：

```bash
DEMO_ADMIN_PASSWORD='replace-with-a-local-password' npm run seed:demo
```

演示邮箱为保留域名 `demo-admin@example.invalid`，演示数据不对应真实用户、UID 或订单。

## 可选验证与邮件

- 四项 `ALIYUN_*` 全部存在时启用 Captcha；任一缺失即关闭。
- `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`SES_FROM_EMAIL`、`SES_TEMPLATE_ID` 全部存在时启用注册邮箱验证。
- 商城和棉花糖通知还需要各自的模板 ID 与收件地址；不完整时只跳过通知，不回滚业务。
- 未配置 `BOT_WS_URL` 时 bili-bot 桥完全关闭，网站、手工积分、CSV 与商城独立运行。

## 角色与权限

管理员始终拥有所有权限，并可给普通用户或高级用户分配：

| 权限 | 能力 |
| --- | --- |
| `playlist.manage` | 歌曲、标签、冠名和批量导入 |
| `marshmallow.manage` | 查看、回复、标记与删除棉花糖 |
| `points.manage` | 积分账号、流水、导入、调整和结算 |
| `prize.manage` | 商品、图片、库存、订单和退款 |
| `site_config.manage` | 站点资料、主题、Logo 与注册开关 |

权限管理本身只允许管理员进入，并禁止降级最后一个管理员。

## bili-bot 预留接口

网站可作为 WebSocket 客户端连接公开或自建的 bili-bot 事件服务。当前支持 `gift` 与 `super_chat`，以稳定的 `event_id` 幂等入库并回复 `event_ack`；连接成功后会发送 `resume` 请求，断线采用指数退避重连。

该接口只负责“事件进入积分账本”，不要求 Bot 与网站部署在同一台机器，也不会在网站仓库保存 Bot 登录凭证。完整消息、ACK、鉴权、重试约定及未来弹幕/舰长/任务事件扩展见 [API 与 bili-bot 扩展文档](docs/API.md#bili-bot-websocket-接口)。

## 测试与构建

```bash
npm test
npm run build
```

前端单元测试：

```bash
npm run test:frontend
```

依赖审计：

```bash
npm audit --prefix backend
npm audit --prefix frontend
```

GitHub Actions 会在 push 和 pull request 时执行后端测试、前端测试、生产构建和生产依赖高危漏洞审计。浏览器与真实 MySQL 流程仍应在发布前按 [部署验收清单](docs/DEPLOYMENT.md#发布验收) 手工验证。

## 文档

- [架构与数据流](docs/ARCHITECTURE.md)
- [配置与环境变量](docs/CONFIGURATION.md)
- [REST API、权限与 bili-bot WebSocket](docs/API.md)
- [部署与发布验收](docs/DEPLOYMENT.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 作者

<table>
  <tr>
    <td><img src="https://github.com/LinusLieu.png?size=96" width="72" alt="Linus_Lieu" /></td>
    <td>
      <strong>Linus_Lieu</strong><br />
      项目开发与维护<br />
      <a href="https://github.com/LinusLieu">GitHub 主页</a>
    </td>
  </tr>
</table>

## 友情链接

<table>
  <tr>
    <td rowspan="2"><img src="frontend/public/annapiggy-logo.png" width="180" alt="小猪anna的秘密基地" /></td>
    <td><a href="https://annapiggy.live"><strong>小猪anna的秘密基地</strong></a></td>
    <td>原站与项目视觉、公开业务的来源。</td>
  </tr>
  <tr>
    <td><a href="https://space.bilibili.com/501066866"><strong>小猪anna的 B站个人空间</strong></a></td>
    <td>UID：501066866</td>
  </tr>
</table>

## License 与作者署名

本项目采用 [GNU GPL v3 或更高版本](LICENSE) 开源。任何人都可以在 GPL
条款下使用、研究、修改和分发代码；分发修改版时同样需要提供对应源码并
保留许可证声明。

网站页脚中的 `© 2026 Linus_Lieu` 是依据 GPLv3 第 7(b) 条指定的合理作者
署名。修改版可以调整页脚样式，但不得删除、遮挡或冒充该署名；完整要求见
[NOTICE](NOTICE)。
