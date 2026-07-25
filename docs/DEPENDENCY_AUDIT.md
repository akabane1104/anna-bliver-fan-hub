# Phase 0.5 依赖安全检查

检查日期：2026-07-25

起始提交：`e63a723534aa65115aab081eb35bd182e38a220b`

## Audit 对照

| 目标 | 修改前 | 修改后 |
| --- | --- | --- |
| backend 全部依赖 | 0 低危 / 2 中危 / 3 高危 / 0 严重 | 0 低危 / 0 中危 / 3 高危 / 0 严重 |
| backend production | 0 低危 / 2 中危 / 0 高危 / 0 严重 | 0 |
| frontend 全部依赖 | 10 低危 / 14 中危 / 23 高危 / 2 严重，共 49 | 10 低危 / 12 中危 / 23 高危 / 2 严重，共 47 |
| frontend production | 0 低危 / 2 中危 / 0 高危 / 0 严重 | 0 |

执行命令：

```powershell
npm audit --prefix backend
npm audit --prefix backend --omit=dev
npm audit --prefix frontend
npm audit --prefix frontend --omit=dev
```

没有执行 `npm audit fix` 或 `npm audit fix --force`，没有降级或升级 `react-scripts`，也没有进行 CRA/Vite 迁移。

## 已实施的最小修复

上表以 Windows 宿主 Node.js 24/npm 11 执行四条指定命令的结果为准。Frontend Docker build stage 同样使用 Node.js 24。Backend 与 frontend 的 production audit 均为 0；剩余项目只位于现有开发、测试和构建工具链。

前端已有 `postcss` override。修改前锁定版本为 `8.5.6`，处于 audit 公告的 `<8.5.10` 受影响范围。将 override 安全下限从 `^8.4.31` 提高到 `^8.5.10` 后，使用 Dockerfile 同款 Node.js 24 重新解析锁文件：

- `postcss 8.5.22`
- `nanoid 3.3.16`，由新版 PostCSS 的合法依赖范围带入
- `yaml 1.10.3`，将 CRA 工具链中受影响的 `1.10.2` 更新到同一 major 的安全补丁
- `yaml 2.9.0`，满足 Tailwind/PostCSS 配置加载器的可选 peer

`yaml 2.9.0` 作为 devDependency 固定 Tailwind/PostCSS 配置加载器的可选 peer；CRA 的旧消费者继续使用兼容的 `yaml 1.10.3`。这项构建树约束不会进入 production dependency tree。

## 前端正式镜像边界

`frontend/Dockerfile` 使用多阶段构建。实际检查正式容器得到：

- 存在 Nginx、`index.html` 与 React `static/` 构建文件
- 不存在 `node`、`npm`、`node_modules` 或 `react-scripts`
- 构建阶段工具不会进入正式镜像

因此 frontend 完整 audit 的剩余 47 项属于 CRA 5 开发、测试和构建工具链，不会随 Nginx 正式镜像发布。`npm audit --omit=dev` 为 0。开发服务器仍不应暴露到不可信网络，处理外部贡献的源码、SVG、YAML 或构建配置时也应视为不可信输入。

## 腾讯云 SDK 与 uuid

实际依赖链：

```text
backend
└─ tencentcloud-sdk-nodejs 4.1.272
   └─ uuid 11.1.1（scoped override）
```

`backend/package.json` 只在 `tencentcloud-sdk-nodejs` 子树内把 `uuid` 覆盖为 `11.1.1`，没有增加 direct uuid dependency，也没有使用全局 override。腾讯 SDK 仍锁定为 `4.1.272`。离线兼容性测试确认 CommonJS 加载、Captcha Client 构造和 `uuid.v4()` 正常，且 HTTP、HTTPS、DNS、socket 与 fetch 调用数均为 0。

## React 19 与 React Router 8

Frontend 使用 React / React DOM `19.2.7`、React Router `8.3.0` 与 `qrcode.react 4.2.0`，并移除 `react-router-dom`。应用仍采用 Declarative Mode，没有引入 Framework Mode、SSR、RSC、loader 或 action。

CRA 5 的 Jest 27 默认不能执行 React Router 8 的纯 ESM。`frontend/config/jest/reactRouterTransform.cjs` 复用 CRA 原 Babel transformer，只允许 `react-router` 与 `cookie-es` 经过测试转换，并只在 React Router 的精确 `routeModules.js` 路径中把唯一一个 Vite HMR `import.meta.hot` 改为 `undefined`。路径或出现次数变化会使测试失败。该 bridge 与 `setupTests.js` 都只用于测试，不进入 production bundle，也不 mock Router。

## 后续建议

- 保持 frontend 正式镜像只发布静态构建产物，不在生产容器安装开发依赖。
- 定期重新执行四组 audit，分别观察 production 与完整工具链。
- 持续跟踪腾讯 SDK 正式支持 uuid 11+ 的版本，届时移除 scoped override。
- 将 CRA 工具链替换作为独立迁移项目处理，不在依赖安全补丁中混入框架迁移。
