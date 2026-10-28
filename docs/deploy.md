# 部署

网站是 Cloudflare Worker `stsswb`（`wrangler.jsonc`）：静态目录 `dist`，资产绑定 `ASSETS`，只有 `/api/*` 先经过 `src/worker.mjs`。不需要数据库或管理员写接口。

## 发布流程

1. GitHub Actions `sync.yml` 同步官方数据、构建、跑测试，有变化时把 `dist/` 与数据提交到 `main`。
2. Cloudflare Workers Builds（Git 集成）检测到 `main` 的新提交后部署，部署命令 `npx wrangler@4.151.2 deploy`，构建命令留空（`dist/` 已提交）。
3. 分支推送同样会生成预览部署（PR 上的 “Workers Builds: stsswb” 检查）。

同步推送遇到 `main` 更新时，先 rebase，再按最新依赖重新构建并通过测试后重试；rebase、构建或测试失败即停止推送。

没有新提交就不会有新部署；只手动跑 Actions 而数据没变化时，Cloudflare 不会重新部署。

部署后检查：首页、`/?station=vancouver`、`/api/v1/events`、`/api/v1/events/vancouver/entries?country=CHN`。本地预览 Worker：`npx wrangler@4.151.2 dev --local`。

## 比赛时段的准时同步

GitHub 自带的定时任务（每天 00:17、12:17 UTC）常常延迟。Worker 配了每 10 分钟一次的 Cron Trigger，由 `scheduled()` 决定是否调用 GitHub API 运行 `sync.yml`：

- 比赛进行时段（每个比赛日首项开赛前 2 小时至末项开赛后 2 小时）：每 10 分钟；
- 比赛窗口内其他时间（开赛前 2 天至结束后 3 天）：每小时；
- 窗口外：不触发，只靠 GitHub 的兜底。工作流有并发组，不会重复写入。

一次性设置（未设置时 Worker 只记日志并跳过，不影响网站）：

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens：只授权 `dupirou/ssts_wb`，权限 **Actions: Read and write**，有效期覆盖赛季。
2. Cloudflare → Workers & Pages → `stsswb` → Settings → Variables and Secrets：添加 Secret `GITHUB_DISPATCH_TOKEN`。
3. 部署后在 Settings → Trigger events 可见 `*/10 * * * *`；由它触发的 Actions 运行类型为 `workflow_dispatch`。

令牌只存放在 Cloudflare Secret 中，不要写进仓库或聊天记录。

## 自定义域名

域名在 Workers 的 Custom domains 中添加，由 Cloudflare 自动建立 DNS 记录与证书；不要只手工加 CNAME。中国大陆的可达性需在实际运营商网络与微信内置浏览器中验证，不作保证。


## 同步心跳与 KV 健康度

Worker 使用 `SYNC_HEALTH_KV` 记录最后一次完整同步、构建、测试、发布成功的时间。KV 是运行状态存储，**不是赛事数据源**；官方数据仍只能由经过校验的 `data/` 提供。

- `wrangler.jsonc` 通过无 ID 绑定声明 KV；当前 Wrangler 版本支持在首次部署时自动创建资源。上线时先在 Cloudflare Worker 的 Settings → Bindings 中确认 `SYNC_HEALTH_KV` 已成功绑定。如果 Worker Builds 不支持自动配置，需手动创建 KV 命名空间并将实际 ID 填入配置，不要使用占位 ID。
- Cloudflare Worker Secrets 添加 `HEARTBEAT_SECRET`（随机长度至少 32 字符）；GitHub Actions 仓库 Secret 添加**相同值** `SYNC_HEARTBEAT_SECRET`。
- GitHub Actions 仓库 Variable 添加 `SYNC_HEARTBEAT_URL=https://stss.fusu.uk/internal/heartbeat`。需要与 Cloudflare 实际已绑定的生产域名核对。
- 缺任一配置时不会发送伪心跳。日志会记录 `Heartbeat not configured`，API 使用既有快照时间并返回 `freshness_degraded=true`。配置齐全后，成功的 workflow 才会 POST 心跳；密钥不写入响应、日志或仓库。
- 比赛进行时段心跳超过 30 分钟后标记 stale；其他时段保持 36 小时。KV 故障或无可信心跳时回退旧快照时间（36 小时）。

**上线顺序：** 先确认 Worker KV 绑定和密钥，然后配置 GitHub Secret / Variable；手动运行一次 `sync.yml` 并检查 Step Summary 中的心跳结果，再核对 API 的 `freshness_source`、`freshness_degraded`。即使心跳成功，已标记 `update_status=error` 的资源仍保持 stale。
