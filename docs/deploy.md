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
