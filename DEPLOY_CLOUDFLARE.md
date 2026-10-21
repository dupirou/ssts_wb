# Cloudflare Pages 部署指南（SSTS-WB）

## 新增 Worker API 部署

现有域名使用 Cloudflare Workers 时，新增接口由根目录 `wrangler.jsonc` 指定：
入口 `src/worker.mjs`，静态目录 `dist`，资产绑定 `ASSETS`，只对 `/api/*` 先运行 Worker。
保留现有 Workers Git 集成，部署命令使用 `npx wrangler@4.151.2 deploy`，从仓库根目录执行。
同步工作流已生成并提交 `dist`，Cloudflare 的构建命令可继续留空。
配置中 Worker 名称为 `stsswb`，应与现有项目名称一致；不在此文件配置或更改 DNS。

先检查打包：`npx wrangler@4.151.2 deploy --dry-run`。
部署后检查 `/api/v1/events`、`/api/v1/events/vancouver/entries?country=CHN`，以及原首页。
若继续使用纯静态 Pages，`/data/competitions/*.json` 可用，但无后缀的 `/api/v1/` 路由需要 Worker；
不能把新增接口的 Python 抓取脚本当作长驻服务器运行。

以下为原有纯静态 Pages 操作参考。

## 1. 现状

- GitHub 源码仓库：https://github.com/dupirou/ssts_wb
- 生产分支：`main`
- 静态站点文件：`dist/index.html`、`dist/app.js`、`dist/site.css`、`dist/data/*.json`
- `dist/` 由 GitHub Actions 从 `tools/build.py` 生成、验证并提交。
- Cloudflare Pages **只负责静态托管**，不承担定时抓取或后台计算。

## 2. 在 Cloudflare Pages 创建网站

1. 打开 https://dash.cloudflare.com/ → **Workers & Pages**。
2. 创建 **Pages** 项目，选择 **Connect to Git**／连接 Git 仓库（不要误选 Workers）。
3. 授权 Cloudflare GitHub 应用访问 `dupirou/ssts_wb`；如使用“仅选定仓库”，只勾选本仓库即可。
4. 生产分支：`main`。
5. 填入如下配置：

| 设置 | 值 |
| --- | --- |
| Framework preset | None／无框架 |
| Root directory | 留空，表示仓库根目录 |
| Build command | 留空（若界面强制要求，则使用 `exit 0`） |
| Build output directory | `dist` |
| Environment variables | 暂不需要 |
| Production branch | `main` |

6. 部署，等待 Cloudflare 实际给出 `<project>.pages.dev` 域名。**不要猜测测试 URL**。
7. 分别打开 `/`、`/?station=vancouver` 和 `/data/vancouver.json`，确认静态文件完整。

`dist` 已经提交到 GitHub；无构建命令是有意设计。不要把 Build output 写成 `/dist/index.html`，也不需要在 Cloudflare 安装 Python 依赖。

## 3. 接入已在 Cloudflare DNS 的自有域名

1. 首次 Pages 部署确认成功后，打开项目的 **Custom domains → Set up a domain**。
2. 添加希望公开使用的子域名，例如 `shorttrack.example.com`（请替换为真实域名）。
3. 若域名就在同一 Cloudflare 账户下管理，Cloudflare 通常自动创建所需的 CNAME 及配置证书。
4. **必须通过 Pages 的 Custom domains 启用域名；不能只手工在 DNS 里添加 CNAME**，否则可能出现 522。
5. 不修改主域名的 NS／其他解析记录；也不需要将之前帽子云的灰云配置直接照搬到 Pages。
6. 中国大陆的电信、移动、联通以及微信内置浏览器进行实际访问测试。未备案的境外 Pages 路线不保证每一条国内线路稳定。

Cloudflare 官方帮助：
- Git：https://developers.cloudflare.com/pages/get-started/git-integration/
- Custom domains：https://developers.cloudflare.com/pages/configuration/custom-domains/
- Build：https://developers.cloudflare.com/pages/configuration/build-configuration/

## 4. 自动更新、免费构建配额和故障回退

- GitHub Actions 每半小时尝试核对 ISU 官网公开赛程，若源站无法解析或 62 条项目/轮次不匹配，会拒绝覆盖既有数据。
- **无变化不反复部署**：自动发布仅在赛程改变或每天一次官方验证记录刷新时产生新提交，避免每半小时重建；Cloudflare Pages 免费版构建次数有月度限制。
- Cloudflare Git 集成在新提交时自动部署；如果只是手动运行 Actions 但没有生成新提交，不应期待 Cloudflare 出现新部署。
- 中国队的官方分组自动采集当前尚未接通。无官方证明的 CHN 行保持未知，不可擅自高亮。
- 数据时间戳表示“上次公开发布的完整官方核对记录”，非秒级实时比分。

## 5. 比赛期间的准时同步（Cloudflare Cron Trigger）

GitHub 的定时任务经常延迟数小时。`wrangler.jsonc` 为 Worker `stsswb` 配置了每 10 分钟一次的 Cron Trigger；`src/worker.mjs` 的 `scheduled()` 只在比赛窗口内（各站开赛前 2 天至结束后 3 天，按 `data/calendar.json`）调用 GitHub API 手动运行 `sync.yml`，其余时间直接跳过。GitHub 自身的定时任务保留为兜底；同步工作流有并发组，不会重复写入。

一次性设置（未设置时 Worker 只记录日志并跳过，不影响网站）：

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → 新建：仅授权仓库 `dupirou/ssts_wb`，权限 **Actions: Read and write**（其余保持无权限），有效期覆盖赛季。
2. Cloudflare 控制台 → Workers & Pages → `stsswb` → Settings → **Variables and Secrets** → 添加类型为 Secret 的 `GITHUB_DISPATCH_TOKEN`，值为上面的 token。
3. 部署后可在 `stsswb` → Settings → Trigger events 看到 `*/10 * * * *`；比赛窗口内的 GitHub Actions 运行记录事件类型为 `workflow_dispatch`。

注意：没有你的 Cloudflare 账户连接权限，本指南**不会**创建 Pages 项目、授权 GitHub App 或改变 DNS。完成控制台步骤后可将系统实际提供的 pages.dev URL 发来进行公开访问校验。
