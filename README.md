# SSTS-WB · 短道速滑世巡赛赛程

非官方短道速滑赛程查询站，目标托管：Cloudflare Pages（Cloudflare DNS）。前端为零依赖原生 JS + CSS（内联 SVG 赛道动画、实时倒计时、赛程总览刻度条），适配电脑／平板／手机与打印，提供深色与白蓝浅色两套主题，说明见 [DESIGN_HANDOFF.md](DESIGN_HANDOFF.md)。

## 已实现
- 新增运动员后端 API：报名、正式分组、成绩、排名、判罚；按国家/性别/距离/轮次筛选。
  已接温哥华官方报名 PDF；分组/成绩适配 ISU 新官网公开 JSON 接口，等待本赛季公布。
  分站页可展开报名名单，默认查看中国队，支持国家和性别筛选；对应赛程可查看已发布的分组、成绩与判罚，排名发布后显示。API 及 Cloudflare Worker 部署见 [BACKEND.md](BACKEND.md)。
- 新增首轮分组预测面板与只读 `predictions` 接口，依据 ISU 2026 Rule 293、世巡赛通告 2806 与晋级表。单项报项与历史单项排名通过 ISU 官方公开接口自动同步；官网名单未齐、排名并列或无排名选手抽签未定时显示等待态，预测不参与官方中国队高亮，细节见 [BACKEND.md](BACKEND.md)。
- 2026/27 赛季七站入口；温哥华站共 62 个官方暂定的**轮次开始时间**（14／25／23），转换成北京时间。
- 日期、项目、轮次和时区筛选。
- 默认高亮有**官方具体轮次分组证据**的中国队场次；显示参赛名字、Heat 编号及**非官方估算区间**。
- Cloudflare Cron 在比赛时段每 10 分钟、比赛窗口其他时间每小时触发同步；GitHub Actions 自身每天 00:17、12:17 UTC 尝试兜底，窗口外也会运行。GitHub 定时任务可能延迟或跳过；仅在数据变化或每日成功核验记录更新时提交。只有官方网页完整 62 条、项目和轮次顺序严格匹配时才接纳时间修改，否则保留已有的可信数据并提示失败。
- Python 构建静态 JSON 和页面，没用数据库、CDN、外部字体。

## 数据源的当前状态

中国队官方结果页面发现及 Heat 自动采集已接入 GitHub Actions，但赛事分组/结果尚未在可核实的公开入口中发布。详见 [后端数据同步说明](BACKEND.md)。因此 data/china.json 与 data/china_auto.json 目前均为空，此时不高亮任何场次，**未知不代表中国队没有参赛**。这一层的数据模型、来源校验、估时和前端显示已经具备；要启用自动识别中国队，还需要接通已验证的官方分组数据源。赛事成绩不是实时比分源。

ISU HTML 自动核对是 best-effort，能否正常采集应看 Actions 日志。ISU 若改变页面结构或比赛项目数量，将停止更新并等待人工检查，不能把无数据理解为无比赛。

## 操作

本地：Python 3.11+（需系统时区数据库）；执行 python tools/build.py，然后 python -m http.server 8000 --directory dist 。访问 http://127.0.0.1:8000 。

测试：`python -m unittest discover -s tests -v`；`npm ci --ignore-scripts && node --test tests/test_api.mjs tests/test_athlete_ui.mjs`。

检查官网：先 pip install beautifulsoup4；然后 python tools/sync_schedule.py --dry-run。仅实际全量验证后才可以写入 CSV。

产物 dist/data/calendar.json 和 dist/data/vancouver.json。源文件 data/vancouver.csv 禁止前端自行改动。

## 中国队自动采集

同步脚本：`python tools/sync_china.py`。项目会从 ISU 官方结果索引自动发现具体赛事、项目和轮次；公布前不会创建 CHN 行。每次更新都需对应的官方页面证据。具体逻辑见 [BACKEND.md](BACKEND.md)。

## 中国队数据结构

data/china.json 的 heats 数组每条为一个经过官方证据核对的**具体轮次**，须包含 round_key、country = CHN、evidence = official_start_list、source_url（ISU 官方或 shorttrack.sportresult.com 的实际名单 URL）、verified_at（带时区）和 heats:[{number, athletes:[...]}]。

Heat 估算是默认工程参数，不是 ISU 官方逐组时间，也未经过历史数据统计回测；应以区间和“非官方”标注。**不要写入虚构选手、组别，不能用官方首页代替实际分组表。**

## Cloudflare Pages 部署

请按 [DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md) 操作：连接 GitHub 仓库、main 分支、无框架、构建命令留空、根目录留空、输出目录 dist。首次部署完成后可使用 Pages 自动分配的 pages.dev 测试域名；若需要自定义域名，务必先在 Pages > Custom domains 添加，再由 Cloudflare 自动建立 DNS 记录。大陆可达性要在实际运营商网络验证，不作保证。

官方来源：
- https://www.isu-skating.com/ja/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230
- https://www.isu-skating.com/en/short-track/news/isu-short-track-event-calendar-202627/

## 单项报项与分组预测自动同步

`tools/sync_predictions.py` 从 ISU 温哥华 Entries 标签的六个单项独立 result ID 读取实际报项，并分页读取 2025/26 单项 World Tour Classification（用于直通）及单项 World Ranking（用于种子）。匹配使用 ISU 选手 ID；整站报名 PDF 只作名单更新是否齐全的保守检查，不产生任何单项参赛记录。同步由 Cloudflare Cron 触发的 Actions 执行，另有每天两次的 GitHub 定时兜底；结果写入 `data/prediction_inputs/vancouver.json`，构建后由预测接口提供。

官网目前可能逐国上传报项。只有名单两次核对稳定、单项人数匹配官方赛程和晋级表、世界排名顺序与直通边界可以确定，才发布模型分组。无排名选手的报名成绩或抽签顺序未公开、官方排名并列未分出顺序时，只展示已验证的单项报项与历史排名，预测继续等待。详见 [BACKEND.md](BACKEND.md)。
