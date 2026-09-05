# 悠哉世界服务状态

部署到 Cloudflare Workers 的 Nuxt 4 状态站，对外域名为 `status.mcyzw.top`。

## 监控内容

- 官网 `mcyzw.top`
- API 服务端 `api.mcyzw.top`
- 静态资源服务 `assets.mcyzw.top`
- 域名邮件处理器 `mailservice.mcyzw.top`
- `EQAD-003` 运行节点与最近 24 小时可用性
- `play.mcyzw.top:25565` Minecraft 游戏服务

Worker 每 5 分钟执行一次计划检测并写入 Cloudflare 日志，同时通过 D1 保存按 5 分钟时间桶聚合的状态样本，自动保留最近 72 小时。页面及 `/api/status` 也会获取带短时缓存的实时快照。`GET /api/health` 用于检查状态站本身。

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
