# SSTS-WB · 短道速滑世巡赛赛程

非官方短道速滑赛程查询站，目标托管：帽子云，Cloudflare DNS。前端仅有可替换的线框布局。

## 已实现
- 2026/27 赛季七站入口；温哥华站共 62 个官方暂定的**轮次开始时间**（14／25／23），转换成北京时间。
- 日期、项目、轮次和时区筛选。
- 默认高亮有**官方具体轮次分组证据**的中国队场次；显示参赛名字、Heat 编号及**非官方估算区间**。
- GitHub Actions 每 30 分钟尝试核对 ISU 公开赛程，只有官方网页完整 62 条、项目和轮次顺序严格匹配时才接纳时间修改；否则保留已有的可信数据并提示失败。
- Python 构建静态 JSON 和页面，没用数据库、CDN、外部字体。

## 尚未打通的数据源

2026 温哥华站的官方 Start List/晋级结果自动采集接口**尚未核实**。因此 data/china.json 默认为空，此时不高亮任何场次，**未知不代表中国队没有参赛**。这一层的数据模型、来源校验、估时和前端显示已经具备；要启用自动识别中国队，还需要接通已验证的官方分组数据源。赛事成绩不是实时比分源。

ISU HTML 自动核对是 best-effort，能否正常采集应看 Actions 日志。ISU 若改变页面结构或比赛项目数量，将停止更新并等待人工检查，不能把无数据理解为无比赛。

## 操作

本地：Python 3.11+（需系统时区数据库）；执行 python tools/build.py，然后 python -m http.server 8000 --directory dist 。访问 http://127.0.0.1:8000 。

测试：python -m unittest discover -s tests -v 。

检查官网：先 pip install beautifulsoup4；然后 python tools/sync_schedule.py --dry-run。仅实际全量验证后才可以写入 CSV。

产物 dist/data/calendar.json 和 dist/data/vancouver.json。源文件 data/vancouver.csv 禁止前端自行改动。

## 中国队数据结构

data/china.json 的 heats 数组每条为一个经过官方证据核对的**具体轮次**，须包含 round_key、country = CHN、evidence = official_start_list、source_url（ISU 官方或 shorttrack.sportresult.com 的实际名单 URL）、verified_at（带时区）和 heats:[{number, athletes:[...]}]。

Heat 估算是默认工程参数，不是 ISU 官方逐组时间，也未经过历史数据统计回测；应以区间和“非官方”标注。**不要写入虚构选手、组别，不能用官方首页代替实际分组表。**

## 帽子云部署

在仓库 Actions 首次成功运行后，dist/ 应自动生成并提交。帽子云静态应用关联本仓库，输出目录填写 dist；若平台要求构建命令，使用 python tools/build.py。先测试平台域名，再按帽子云实际控制台 CNAME 提示在 Cloudflare 增加子域名，使用 DNS Only（灰云）并完成 HTTPS 验证。大陆可达性要做实际测试，不作保证。

官方来源：
- https://www.isu-skating.com/ja/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230
- https://www.isu-skating.com/en/short-track/news/isu-short-track-event-calendar-202627/
