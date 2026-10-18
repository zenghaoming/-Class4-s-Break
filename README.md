# 四班抽象之奕 · 联机版

基于 zenghaoming 创作的网页卡牌桌游，当前版本为 2.5.1。

游戏网址：[class4game.top](https://class4game.top)。四名玩家填写相同房间代码即可同桌，房主可以补齐 AI 玩家。人物设定、阵营和羁绊规则位于 `public/rules.js`，页面内提供玩法说明。

## 运行

需要 Node.js 22 或以上，以及 pnpm 11.25.0。生产环境使用 Node.js 24.22.0。

```sh
pnpm install --frozen-lockfile
pnpm start
```

默认监听端口为 3000，可通过环境变量 `PORT` 指定。浏览器打开运行服务的主机地址，健康检查接口为 `/healthz`。

公网部署需要支持 WebSocket 的 HTTPS 入口。当前线上游戏通过 Cloudflare Tunnel 提供访问。

默认最多 8 个房间、40 个实时连接，每个浏览器会话最多保留 2 个连接。8 个房间提供 32 个真人席位。HTTP 请求和会话申请分别设置频率限制，超过限制时返回 HTTP 429 和重试等待时间。

`MAX_ROOMS`、`MAX_SOCKET_CONNECTIONS`、`MAX_HTTP_CONNECTIONS` 可以配置房间、实时连接和 TCP 连接的上限。`TRUST_PROXY` 指定可信反向代理地址，默认仅信任本机回环地址。

`deploy/compose.yaml` 提供共用服务器的容器配置：游戏使用最多 0.35 个 CPU 核心、256 MiB 内存，隧道使用最多 0.15 个 CPU 核心、128 MiB 内存。应用文件系统只读，游戏 HTTP 服务仅在独立的内部容器网络提供，由 Cloudflare Tunnel 发布公网网址。部署时通过 `CLASS4_GAME_IMAGE`、`CLASS4_TUNNEL_IMAGE`、`CLASS4_TUNNEL_CONFIG` 和 `CLASS4_TUNNEL_CREDENTIALS` 指定镜像和运维文件。

## 代码与测试

| 路径 | 用途 |
| --- | --- |
| `server.js` | HTTP、会话、房间管理和 Socket.IO 通信 |
| `game.js` | 规则引擎、AI 决策和卡牌数量检查 |
| `public/` | 网页、人物规则、样式及图片资源 |
| `tests/engine.test.cjs` | 规则、技能组合和完整对局测试 |
| `tests/network.test.cjs` | 真实 HTTP 与 WebSocket 联机测试 |
| `tests/limits.test.cjs` | 请求频率、连接配额、房间释放和 TCP 上限验证 |
| `tests/deployment/verify-domain.cjs` | HTTPS、资源、四人联机与重连检查 |

```sh
pnpm test
```

测试会启动独立的测试服务，并在结束后关闭。公网部署检查在项目根目录运行，参数为目标 HTTPS 地址：

```sh
node tests/deployment/verify-domain.cjs https://class4game.top
```

该检查会创建独立测试房间、连接四个客户端，并在结束时退出房间。测试输出保存到仓库之外的日志目录。

## 数据与维护

房间、会话、对局和聊天保存在游戏进程内存中。每桌保留最近 150 条对局日志和 100 条聊天记录；开始新局时重置对局日志和结果。所有真人明确离开时立即释放房间；断线保留的房间在无人连接且闲置约 30 分钟后清理。游戏进程重启会清空内存数据。

依赖使用 `pnpm-lock.yaml` 固定版本。规则修改需要更新对应测试和玩法说明，正式发布记录 Git 提交编号。运行程序、隧道配置、凭据、日志和安装后的依赖分别由部署环境管理。
