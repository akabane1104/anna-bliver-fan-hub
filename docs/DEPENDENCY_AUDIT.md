# Phase 0.5 依赖安全检查

检查日期：2026-07-23

起始提交：`2c0da7954da51153d394a063200cb18c9b2a343d`

## Audit 对照

| 目标 | 修改前 | 修改后 |
| --- | --- | --- |
| backend 全部依赖 | 0 低危 / 2 中危 / 0 高危 / 0 严重 | 0 低危 / 2 中危 / 0 高危 / 0 严重 |
| backend production | 0 低危 / 2 中危 / 0 高危 / 0 严重 | 0 低危 / 2 中危 / 0 高危 / 0 严重 |
| frontend 全部依赖 | 10 低危 / 15 中危 / 23 高危 / 2 严重，共 50 | 10 低危 / 12 中危 / 23 高危 / 2 严重，共 47 |
| frontend production | 0 | 0 |

执行命令：

```powershell
npm audit --prefix backend
npm audit --prefix backend --omit=dev
npm audit --prefix frontend
npm audit --prefix frontend --omit=dev
```

没有执行 `npm audit fix --force`，没有降级 `react-scripts`，也没有进行 CRA/Vite 迁移。

## 已实施的最小修复

上表以 Windows 宿主 Node.js 24/npm 11 执行四条指定命令的结果为准。Docker 的 Node.js 20/npm 10 构建树会安装一个额外的可选 peer，并报告 46 项完整工具链告警；两种环境的 frontend production audit 都是 0。

前端已有 `postcss` override。修改前锁定版本为 `8.5.6`，处于 audit 公告的 `<8.5.10` 受影响范围。将 override 安全下限从 `^8.4.31` 提高到 `^8.5.10` 后，使用 Dockerfile 同款 Node.js 20/npm 10 重新解析锁文件：

- `postcss 8.5.22`
- `nanoid 3.3.16`，由新版 PostCSS 的合法依赖范围带入
- `yaml 1.10.3`，将 CRA 工具链中受影响的 `1.10.2` 更新到同一 major 的安全补丁
- `yaml 2.9.0`，满足 Tailwind/PostCSS 配置加载器的可选 peer

安全修复没有跨 major，也没有增加直接运行时依赖。按宿主 npm 11 的 audit 口径，修复消除了 PostCSS 本身及其上传播到 `resolve-url-loader` 的两个中危计数，并消除了 `yaml 1.10.2` 的一个中危计数。

## 前端正式镜像边界

`frontend/Dockerfile` 使用多阶段构建。实际检查正式容器得到：

- 存在 Nginx、`index.html` 与 React `static/` 构建文件
- 不存在 `node`、`npm`、`node_modules` 或 `react-scripts`
- 构建阶段工具不会进入正式镜像

因此 frontend 完整 audit 的剩余 47 项属于 CRA 5 开发、测试和构建工具链，不会随 Nginx 正式镜像发布。`npm audit --omit=dev` 保持 0。开发服务器仍不应暴露到不可信网络，处理外部贡献的源码、SVG、YAML 或构建配置时也应视为不可信输入。

## 腾讯云 SDK 与 uuid

实际依赖链：

```text
backend
└─ tencentcloud-sdk-nodejs 4.1.272
   └─ uuid 9.0.1
```

检查时 npm registry 最新版 `tencentcloud-sdk-nodejs` 为 `4.1.273`，仍声明 `uuid ^9.0.1`；单纯升级该 patch 版本无法消除 `GHSA-w5hq-g745-h8pq`。安全版 uuid 要求 `>=11.1.1`，跨越了 SDK 当前依赖范围，因此没有添加强制 override，也没有为了降低 audit 数字而降级腾讯 SDK。

现有 SES 路径在配置完整时调用 `SesClient.SendEmail()`。腾讯 SDK 的公共请求客户端使用 `uuid.v4()` 生成 `X-TC-TraceId`，没有传入 `buf`；公告描述的触发条件是 v3/v5/v6 在调用方提供缓冲区时缺少边界检查。当前 SES 调用路径不会触发该条件，且 Phase 0 默认关闭 SES，因此实际可利用性较低。

残余风险仍按上游中危记录：未来代码若直接使用受影响的 v3/v5/v6 缓冲区接口，或 SDK 改变内部调用方式，需要重新评估。应持续跟踪腾讯 SDK 何时把 uuid 依赖提升到安全 major，再通过正常 SDK 更新消除告警。

## 后续建议

- 保持 frontend 正式镜像只发布静态构建产物，不在生产容器安装开发依赖。
- 定期重新执行四组 audit，分别观察 production 与完整工具链。
- 等待腾讯 SDK 官方升级 uuid，不使用未经上游验证的跨 major override。
- 将 CRA 工具链替换作为独立迁移项目处理，不在依赖安全补丁中混入框架迁移。
