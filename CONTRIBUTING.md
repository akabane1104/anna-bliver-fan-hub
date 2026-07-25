# Contributing

> 本项目采用 GPL-3.0-or-later。提交代码即表示你同意贡献内容按该协议发布。
> 网站页脚的作者署名属于 [NOTICE](NOTICE) 指定的 GPLv3 第 7(b) 条合理法律
> 声明；重构或调整样式时必须保留 `© 2026 Linus_Lieu` 及作者链接。

感谢参与 Anna BLive Fan Hub。提交应保持公开版边界、可独立运行和可审查性。

## 开发准备

1. 阅读 [README](README.md)、[架构](docs/ARCHITECTURE.md) 和 [安全策略](SECURITY.md)。
2. 从 `.env.example` 创建本地配置，不提交真实 `.env`。
3. Backend 与 Listener 使用 Node.js 20 LTS 或更新版本；Frontend 测试与构建使用 Node.js 22.22.0 或更新版本；数据库使用 MySQL 8。
4. 执行 `npm run install:all`，然后分别启动前后端。

## 代码原则

- 使用参数化 SQL；涉及余额、库存、绑定或多表写入时使用事务和必要行锁。
- 所有异步 Express 控制器必须通过 `asyncHandler` 或显式 `next(error)` 进入统一错误处理。
- 新的管理能力必须同时声明后端权限、前端路由与入口，不依赖隐藏按钮保护。
- 所有外部字符串、数组、数量、ID、URL 和文件都要在应用层设置上限。
- 新颜色使用站点主题 CSS 变量，不在管理页重新写固定品牌色。
- 保留无 Bot、无 Captcha、无邮件时的独立运行能力。
- 不重新引入电影票、盲盒、OBS、激活码、QQ/AI 配置或其他私有模块。

## 测试

提交前执行：

```bash
npm test
npm run build
npm run test:frontend
```

涉及数据库事务时，应增加真实 MySQL 集成测试或提供明确的手工验收记录；源码正则回归不能替代运行时验证。

涉及页面时，至少检查桌面与移动端、普通用户、委派管理员和完整管理员三类状态。

## bili-bot 扩展

修改事件协议前先更新 [API 文档](docs/API.md#bili-bot-websocket-接口)。新类型必须定义稳定事件 ID、幂等、ACK、重试、乱序与补偿行为。纯互动事件不要未经设计直接写入积分账本。

## Pull Request 清单

- [ ] 变更目的和公开版边界清楚。
- [ ] 没有真实 UID 之外的个人资料、订单、Cookie、密钥或备份。
- [ ] 后端测试、前端测试、生产构建和依赖审计通过。
- [ ] 数据库变更同时更新基线、兼容策略和文档。
- [ ] API、环境变量、权限或 UI 变化已经更新对应文档。
- [ ] 新文件没有被 `.gitignore` 意外排除。
- [ ] 没有无关格式化或覆盖其他未提交工作。
