# 悠哉世界服务状态

部署到 Cloudflare Workers 的 Nuxt 4 状态站，对外域名为 `status.mcyzw.top`。

## 监控内容

- 官网 `mcyzw.top`
- API 服务端 `api.mcyzw.top`
- 静态资源服务 `assets.mcyzw.top`
- 域名邮件处理器 `mailservice.mcyzw.top`
- `EQAD-003` 运行节点与最近 24 小时可用性
- `play.mcyzw.top:25703` Minecraft 游戏服务

Worker 每 5 分钟执行一次计划检测并写入 Cloudflare 日志，同时通过 D1 保存按 5 分钟时间桶聚合的状态样本，自动保留最近 72 小时。页面及 `/api/status` 也会获取带短时缓存的实时快照。`GET /api/health` 用于检查状态站本身。

公共 HTTP 探测及节点数据请求绕过上游缓存。Minecraft 由 Worker 通过 Cloudflare DNS over HTTPS 解析 `_minecraft._tcp.play.mcyzw.top`，再用 `node:net` 直接进行 Java 版服务器列表握手；连接 SRV 目标时仍保留原始域名作为握手地址。DNS、连接和响应读取共用 8 秒时限，不再依赖官网后端的 `/api/craftping/get_status`。需要保留 `wrangler.jsonc` 中的 `nodejs_compat`，且 Worker 必须能够出站连接 SRV 目标端口。

## 接口

- `GET /api/status`：当前服务、运行节点、Minecraft 状态和最近 24 小时简化可用性曲线。
- `GET /api/status/history?hours=72`：供官网和 API 服务端同步的完整历史样本，最多返回 72 小时。
- `GET /api/health`：状态 Worker 健康检查。

## 命令

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm deploy
```

部署前在 Cloudflare Workers 中绑定 `status.mcyzw.top` 自定义域名。`wrangler.jsonc` 已包含 5 分钟 Cron Trigger。

首次部署前请在 `wrangler.jsonc` 中替换 `database_id`，或执行 `wrangler d1 create youzaiworld-service-status` 后填入返回的数据库 ID；随后使用 `wrangler d1 migrations apply youzaiworld-service-status --remote` 应用 `migrations/0001_status_samples.sql`。

## 2026-09-11 误报排查

提供的日志导出包含 150 条记录，其中 43 次 Cron 均执行成功，但持续记录 Minecraft 异常；这份导出并不是连续七天的全部采样。真实请求定位到以下问题：

| 项目      | 证据                                                                                                                                        | 修复                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Minecraft | 域名 SRV 指向 `frp-top.com:52531`；直接协议握手成功，返回 `26.2`、`0/20`。官网 craftping 接口传入原域名或实际目标都返回 504。               | Worker 直接解析 SRV 和握手；探测失败保留 `unknown`，不把上游接口故障认作游戏离线。 |
| 节点      | 同时请求时，线上 Worker 读到约 61 分钟前的数据，直接请求节点接口得到约 2 秒前的数据。                                                       | 节点请求增加 `cache: no-store` 和禁止使用缓存的请求头；保留十分钟过期阈值。        |
| 历史      | 线上 `/api/status/history` 报 D1 错误，历史仅有进程内样本。D1 官方实现的 `exec()` 按换行拆分 SQL，旧多行建表语句会触发 `incomplete input`。 | 改为逐条 `prepare().run()`，兼容配置中的两个 D1 绑定名，并保留初始化失败后重试。   |
| 检测卡住  | 旧 HTTP 超时在收到响应头后就清除，读取 JSON 可能一直等待。                                                                                  | 解析和校验响应体也受请求超时限制。                                                 |

活动接口的原始响应是合法的 `[]`。PowerShell 转换中出现的 `{ value: [], Count: 0 }` 不是服务端响应，本次保留数组校验。Cron 日志现在包含各项状态、HTTP 状态码、延迟、节点数据年龄及错误原因；部分服务恢复时不会删除其他尚未恢复项目的错误。

北京时间 2026-09-11 23:31 的对比实测中，当前源码检测六项服务均为 `operational`，Minecraft 约 820 ms；已部署的旧 Worker 仍返回节点过期、Minecraft 超时和存储错误。此结果验证了本地源码访问真实端点的行为，**不代表已部署或完成 Cloudflare 出站网络验证**。

最终源码于北京时间 2026-09-12 00:04 再次复测：四个 HTTP 服务均返回 200，节点数据约 6 秒前更新，Minecraft `26.2`、`0/20`，直连约 1855 ms；无离线或未知项目。该次 API 请求耗时约 5958 ms，按原有 2500 ms 阈值标记为 `degraded`（在线但较慢），因此总体也是 `degraded`。31 项回归测试、服务端/页面类型检查及测试/复测脚本的严格类型检查均通过。

## 不启动服务器的验证路径

在本项目目录执行：

```powershell
node --experimental-strip-types --test "test/*.test.ts"
node_modules\.bin\vue-tsc.cmd --noEmit --pretty false -p .nuxt/tsconfig.server.json
node_modules\.bin\vue-tsc.cmd --noEmit --pretty false -p .nuxt/tsconfig.app.json
git diff --check
```

类型检查依赖 Nuxt 生成的声明；依赖安装后若路径变化，仅用 `node_modules\.bin\nuxt.cmd prepare` 更新声明即可，无需构建或启动开发服务器。

- `test/status-monitor.test.ts`：完整采集、缓存旧节点与实时节点差异、ISO 时间边界、失败隔离、重试、响应体超时及短期状态复用。
- `test/minecraft-probe.test.ts`：真实 SRV 格式、原域名握手、分片数据、无 SRV、DNS/连接超时、提前断开及无效/超大数据包；连接均为内存模拟。
- `test/status-db.test.ts`：内存 SQLite 模拟 D1 接口，复现多行 `exec()` 错误，验证建表、历史读写、冷启动、绑定、时间桶及过期清理；不连接线上数据库。

真实端点复测：

```powershell
node --experimental-strip-types scripts/probe-status.ts --compare-deployed
```

也可运行 `pnpm test:live`，只执行当前源码的一次真实探测。Node 24+ 环境若需要使用已有的环境代理，可添加 `--use-env-proxy`。脚本输出 `local-code/live-endpoints` 与可选的 `deployed-worker` 两份结果，不启动服务器、不直接连接线上 D1、不执行部署；对比已部署接口时会触发该接口原有的采样流程。

发布新版本后应再检查 `https://status.mcyzw.top/api/status` 的节点时间戳、Minecraft 在线状态和 `errors.storage`，并在两个五分钟采样周期后检查 `/api/status/history?hours=24`。已存的历史误报不自动改写，会按 72 小时保留规则过期。
