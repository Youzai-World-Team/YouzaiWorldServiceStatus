# 悠哉世界服务状态

部署到 Cloudflare Workers 的 Nuxt 4 状态站，对外域名为 `status.mcyzw.top`。

## 监控内容

- 官网 `mcyzw.top`
- API 服务端 `api.mcyzw.top`
- 静态资源服务 `assets.mcyzw.top`
- 域名邮件处理器 `mailservice.mcyzw.top`
- `EQAD-003` 运行节点与最近 24 小时可用性
- `play.mcyzw.top:25565` Minecraft 游戏服务

Worker 每 5 分钟执行一次计划检测并写入 Cloudflare 日志；页面及 `/api/status` 也会获取带短时缓存的实时快照。`GET /api/health` 用于检查状态站本身。

## 命令

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm deploy
```

部署前在 Cloudflare Workers 中绑定 `status.mcyzw.top` 自定义域名。`wrangler.jsonc` 已包含 5 分钟 Cron Trigger。
