# 配置与环境变量

后端从 `backend/.env` 读取基础设施、密钥和首次启动默认值；前端从 `frontend/.env` 读取构建时变量。不要提交真实 `.env`。

## 后端基础配置

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DB_HOST` | 是 | `127.0.0.1` | MySQL 地址 |
| `DB_PORT` | 是 | `3306` | MySQL 端口 |
| `DB_USER` | 是 | `fan_hub` 示例 | MySQL 用户；SQL 不自动创建该用户 |
| `DB_PASSWORD` | 是 | 占位符 | MySQL 密码 |
| `DB_NAME` | 是 | `anna_bliver_fan_hub` | 数据库名 |
| `JWT_SECRET` | 是 | 占位符 | 生产环境至少 32 个随机字符且不能是占位符 |
| `JWT_EXPIRES_IN` | 否 | `24h` | `jsonwebtoken` 支持的有效期 |
| `NODE_ENV` | 是（生产） | `development` | 生产部署设为 `production` |
| `PORT` | 否 | `5000` | API 监听端口 |
| `TRUST_PROXY` | 否 | `0` | 直连为 `0`；单层 Nginx 为 `1` |
| `REQUEST_BODY_LIMIT` | 否 | `4mb` | JSON 请求上限，需覆盖 2 MB 图片的 Base64 开销 |
| `CORS_ORIGIN` | 是（生产） | 本地开发地址 | 逗号分隔的精确前端来源，不带末尾 `/` |

生产启动会验证 JWT、CORS 和代理配置。开发环境未配置 CORS 时只允许 `localhost:3000` 与 `127.0.0.1:3000`。

## Live Control 密钥

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `LIVE_EVENT_REF_SECRET` | 是（管理事件记录） | 空 | opaque `event_ref` 专用密钥，至少 32 bytes；缺少或不合格时相关权威边界安全失败 |
| `LIVE_EVENT_INGEST_SECRET` | 是（仅启用事件入口时） | 空 | Listener 向 Backend 投递事件的 HMAC 密钥，至少 32 bytes |

两个密钥用途不同，不得互相共用，也不得复用 `JWT_SECRET` 或数据库密码。Docker
初始化脚本会在缺少 `LIVE_EVENT_REF_SECRET` 时安全生成，已有非空值不会被轮替；
`LIVE_EVENT_INGEST_SECRET` 仍保持空白，直到另行授权启用 Listener。

## B站 Listener

Listener 的 `BILIBILI_LISTENER_ENABLED`、`BILIBILI_OFFICIAL_API_ENABLED`、
`BILIBILI_OFFICIAL_WSS_ENABLED` 与 Backend 的 `LIVE_EVENT_INGEST_ENABLED`
是四个独立 gate，默认都为 `false`。Disabled Listener 可健康运行，但不会读取
B站凭据或建立网络连接。

正式启用还需要 `BILIBILI_APP_ID`、`BILIBILI_ACCESS_KEY_ID`、
`BILIBILI_ACCESS_KEY_SECRET`、`BILIBILI_IDENTITY_CODE`、
`LISTENER_SITE_ID`、`LISTENER_INSTANCE_ID` 与 `LISTENER_ROOM_ID`。
这些值只写入受保护的 repository `.env`，不得写入 Git 或命令行。

`BILIBILI_GIFT_AUTO_CREDIT_ENABLED` 必须保持 `false`。目前没有经过证据确认的
`open_id` 网站账号映射，礼物只做可靠入库和幂等，不自动增加积分。完整契约见
[B站 Listener](BILIBILI_LISTENER.md)。

## 站点默认值

管理员保存到 `settings` 表的值优先于以下变量。

| 变量 | 说明 |
| --- | --- |
| `SITE_TITLE` | 浏览器与站点标题 |
| `SITE_BRAND_MODE` | `image`、`text` 或 `icon-text` |
| `SITE_BRAND_TEXT` | 导航栏品牌文字 |
| `SITE_LOGO_URL` | HTTPS 或站内绝对路径 |
| `SITE_FAVICON_URL` | favicon 地址 |
| `CREATOR_DISPLAY_NAME` | 主播展示名 |
| `BILIBILI_UID` | 首页 B站资料 UID |
| `SITE_HOME_TITLE`、`SITE_HOME_SUBTITLE` | 首页文案 |
| `SITE_ICP_TEXT` | 备案文本 |
| `SITE_PUBLIC_SECURITY_TEXT` | 公安备案或其他公开安全文本 |

首页卡片、歌单、棉花糖和全部主题色也可在网站配置页面保存。对应环境变量名称可在 `backend/src/controllers/settingsController.js` 的 `SITE_FIELDS` 中查看。

## 积分结算

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `POINTS_ROOM_ID` | 空 | 自动结算目标直播间；空值时跳过自动结算 |
| `POINTS_START_AT` | 示例时间 | 只结算该时间之后的事件 |
| `POINTS_COIN_PER_POINT` | `100` | 原始金瓜子/电池币值折算一积分所需数量 |

## bili-bot

| 变量 | 说明 |
| --- | --- |
| `BOT_WS_URL` | Bot 事件 WebSocket 地址；留空即完全关闭 |
| `BOT_WS_TOKEN` | 可选 Bearer Token，生产建议始终配置 |

协议见 [API 文档](API.md#bili-bot-websocket-接口)。网站是 WebSocket 客户端，Bot 或事件网关是服务端。

## B站服务端查询

`BILIBILI_COOKIE` 仅用于可选的公开资料刷新。不要使用主账号长期 Cookie；未配置时相关接口按无 Cookie 模式工作。扫码绑定返回的 Cookie 不使用该变量，也不会持久化。

## Captcha

以下四项必须全部存在才启用：

- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_CAPTCHA_SCENE_ID`
- `ALIYUN_CAPTCHA_PREFIX`

任一缺失时，后端校验函数返回“功能未启用”，前端不显示 Captcha。

## 腾讯云 SES

注册邮件验证需要以下四项：

- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`
- `SES_FROM_EMAIL`
- `SES_TEMPLATE_ID`

`SES_FROM_NAME` 可选。商城通知另需 `SES_REDEMPTION_TEMPLATE_ID` 与 `SES_REDEMPTION_TO_EMAIL`；棉花糖通知另需 `SES_MARSHMALLOW_TEMPLATE_ID` 与 `SES_MARSHMALLOW_TO_EMAIL`。通知配置不完整时只跳过通知。

## 演示数据

`DEMO_ADMIN_PASSWORD` 只在执行 `npm run seed:demo` 时读取，必须至少 12 位。执行结束后应从当前 shell 移除。

## 前端配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REACT_APP_API_URL` | `http://localhost:5000/api` | 构建时 API 基础 URL |
| `REACT_APP_ALIYUN_CAPTCHA_PREFIX` | 空 | 与后端 Captcha Prefix 一致 |
| `REACT_APP_ALIYUN_CAPTCHA_SCENE_ID` | 空 | 与后端 Captcha Scene ID 一致 |

生产构建后再修改前端 `.env` 不会生效，必须重新执行 `npm run build`。
