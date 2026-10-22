# SSTS-WB · 短道速滑世巡赛赛程

非官方短道速滑赛程查询站，目标托管：Cloudflare Pages（Cloudflare DNS）。前端为零依赖原生 JS + CSS（内联 SVG 赛道动画、实时倒计时、赛程总览刻度条），适配电脑／平板／手机与打印，提供深色与白蓝浅色两套主题，说明见 [DESIGN_HANDOFF.md](DESIGN_HANDOFF.md)。

## 已实现
- 新增运动员后端 API：报名、正式分组、成绩、排名、判罚；按国家/性别/距离/轮次筛选。
  已接温哥华官方报名 PDF；分组/成绩适配 ISU 新官网公开 JSON 接口，等待本赛季公布。
  分站页可展开报名名单，默认查看中国队，支持国家和性别筛选；对应赛程可查看已发布的分组、成绩与判罚，排名发布后显示。API 及 Cloudflare Worker 部署见 [BACKEND.md](BACKEND.md)。
- 首轮分组预测面板与只读 `predictions` 接口依据 ISU 2026 Rule 293、世巡赛通告 2806 与晋级表。实际单项报项与历史排名自动同步；无世界排名者先按已核实的单项报名成绩排序，未公开的队尾顺序作可复现的暂估。预测不参与官方中国队高亮，细节见 [BACKEND.md](BACKEND.md)。
- 2026/27 赛季七站世巡赛入口，外加独立的 2027 年首尔短道速滑世锦赛页面（3 月 12–14 日，详情以 ISU 官方赛历为准）；各站官方暂定的**轮次开始时间**在 ISU 公布后自动录入并转换成北京时间（温哥华站 62 轮已录入）。
- 日期、项目、轮次和时区筛选。
- 默认高亮有**官方具体轮次分组证据**的中国队场次；显示参赛名字、Heat 编号及**非官方估算区间**。
- Cloudflare Cron 在比赛时段每 10 分钟、比赛窗口其他时间每小时触发同步；GitHub Actions 自身每天 00:17、12:17 UTC 尝试兜底，窗口外也会运行。GitHub 定时任务可能延迟或跳过；仅在数据变化或每日成功核验记录更新时提交。赛程须完整（九个项目都排到 A 组决赛、日期与赛事页相符）才录入；开赛后只接纳时间修改，否则保留已有的可信数据并提示失败。分站配置集中在 `data/stations.json`，见 [BACKEND.md](BACKEND.md) 的“多站自动更新”。
- Python 构建静态 JSON 和页面，没用数据库、CDN、外部字体。

## 数据源的当前状态

中国队官方结果页面发现及 Heat 自动采集已接入 GitHub Actions，但赛事分组/结果尚未在可核实的公开入口中发布。详见 [后端数据同步说明](BACKEND.md)。因此 data/china.json 与 data/china_auto.json 目前均为空，此时不高亮任何场次，**未知不代表中国队没有参赛**。这一层的数据模型、来源校验、估时和前端显示已经具备；要启用自动识别中国队，还需要接通已验证的官方分组数据源。赛事成绩不是实时比分源。

ISU HTML 自动核对是 best-effort，能否正常采集应看 Actions 日志。ISU 若改变页面结构或比赛项目数量，将停止更新并等待人工检查，不能把无数据理解为无比赛。

## 操作

本地：Python 3.11+（需系统时区数据库）；执行 python tools/build.py，然后 python -m http.server 8000 --directory dist 。访问 http://127.0.0.1:8000 。

测试：`python -m unittest discover -s tests -v`；`npm ci --ignore-scripts && node --test tests/*.mjs`。

检查官网：先 pip install -r requirements.txt；然后 `python tools/sync_schedule.py --station montreal`（不带参数则检查所有临近的分站）。仅完整验证后才写入 CSV。

产物 dist/data/calendar.json 和每个已有赛程的分站 dist/data/<id>.json。源文件 data/schedules/<id>.csv 只由同步脚本写入。

## 中国队自动采集

同步脚本：`python tools/sync_china.py`。项目会从 ISU 官方结果索引自动发现具体赛事、项目和轮次；公布前不会创建 CHN 行。每次更新都需对应的官方页面证据。具体逻辑见 [BACKEND.md](BACKEND.md)。

## 中国队数据结构

data/china.json 的 heats 数组每条为一个经过官方证据核对的**具体轮次**，须包含 round_key、country = CHN、evidence = official_start_list、source_url（ISU 官方或 shorttrack.sportresult.com 的实际名单 URL）、verified_at（带时区）和 heats:[{number, athletes:[...]}]。

Heat 估算是默认工程参数，不是 ISU 官方逐组时间，也未经过历史数据统计回测；应以区间和“非官方”标注。**不要写入虚构选手、组别，不能用官方首页代替实际分组表。**

## Cloudflare Pages 部署

请按 [DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md) 操作：连接 GitHub 仓库、main 分支、无框架、构建命令留空、根目录留空、输出目录 dist。首次部署完成后可使用 Pages 自动分配的 pages.dev 测试域名；若需要自定义域名，务必先在 Pages > Custom domains 添加，再由 Cloudflare 自动建立 DNS 记录。大陆可达性要在实际运营商网络验证，不作保证。

官方来源：
- 各站 ISU 赛事页见 data/stations.json（如温哥华 https://www.isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230 ）
- https://www.isu-skating.com/en/short-track/news/isu-short-track-event-calendar-202627/

## 单项报项与分组预测自动同步

`tools/sync_predictions.py` 从 ISU Entries 标签的六个单项独立 result ID 读取实际报项，并分页读取 2025/26 单项 World Tour Classification（用于直通）及单项 World Ranking（用于种子）。匹配使用 ISU 选手 ID，不根据整站名单推断报项。同步由 Cloudflare Cron 触发的 Actions 执行，另有每天两次的 GitHub 定时兜底；结果写入 `data/prediction_inputs/vancouver.json`，构建后由预测接口提供。

报项与官方赛程、晋级表对应后立即计算预测。排序为有世界排名者在前、无排名者按最终报名提交的单项成绩从快到慢、未公开报名成绩者在队尾暂估；相同成绩的未决顺序采用可复现模拟。报名成绩尚未公开不等于没有提交成绩。2026-10-22 核查的六项公开报项接口没有提供成绩，Entries PDF 也只有整站名单。

公开官方报名成绩或种子表经人工核对后，写入 `data/prediction_inputs/{event}_entry_times.json` 的 `items`，每条包含 `gender`、`distance_m`、`official_skater_id`、`time`（如 `1:23.456`）和实际官方文件的 `source_url`。根对象包含 `schema_version: 1` 与 `event_id`。下次同步自动按赛事、单项和选手 ID 应用；个人资料 PB、显示顺序和其他距离成绩不能代替报名成绩。当前温哥华补充文件为空。详见 [BACKEND.md](BACKEND.md)。

## 首尔站售票链接

`data/tickets.json` 保存经过人工核对的首尔站票务信息，`tools/build.py` 将其写入 `dist/data/calendar.json` 的 `stations[].ticketing`，供赛季首页及首尔站详情共用。包含 ISU 中文售票公告、Ticketlink 国际版入口和 2026-10-23 14:00 KST 开售时间（北京时间 13:00）。票务链接是静态信息，不参与报名、成绩、分组预测和定时抓取。

## 世锦赛独立页面

`tools/build.py` 的 `CHAMPIONSHIPS` 维护 2027 年首尔短道速滑世界锦标赛信息，输出到 `dist/data/calendar.json` 的 `championships` 数组。首页在七站世巡赛之后单独展示世锦赛，导航及 `?station=worlds-2027` 独立可访问。ISU 官方 2026/27 赛历显示比赛时间 2027-03-12 至 2027-03-14；当前仅展示日期、城市、北京时间倒计时和官方赛历链接。未发布具体日程、场馆、名单或分组时不造数据；不把世巡赛的种子与直通模型套用到世锦赛，且不计入世巡赛七站或现有自动同步接口。

## 安装到手机（PWA）

网站可以“添加到主屏幕”，像 App 一样全屏打开：安卓 Chrome / Edge 在菜单里选“安装应用”，iPhone 用 Safari 的“分享 → 添加到主屏幕”。`web/manifest.webmanifest` 与 `web/icons/` 提供名称和图标，`web/sw.js` 是 Service Worker：所有请求先走网络，网络失败或 4 秒无响应时才用上次保存的副本，因此联网时数据不会变旧，断网时也能打开已看过的赛程，页面顶部会注明“当前离线”。`tools/build.py` 按页面外壳文件计算版本号写入 `dist/sw.js`，发布新版本后旧缓存自动清除。图标源文件为 `web/icons/icon.svg`。

