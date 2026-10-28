# 数据与接口

所有数据都来自 ISU 官网，由 GitHub Actions 的 `sync.yml` 抓取、核对后写入 `data/`，再由 `tools/build.py` 生成 `dist/`。线上 Worker 只读这些静态快照，访问接口不会触发抓取。

## 分站配置

`data/stations.json` 是唯一的分站配置：城市、日期、时区、场馆，以及 ISU 赛事页（`isu.slug`、`isu.event_id`）。其余官方地址由它推出（`?tab=schedule_<id>`、`documents_<id>`、`results_<id>`、`entries_<id>`）。新赛季只改这一个文件；`isu` 留空时，赛程同步按“城市 / 国家代码 + 日期”在 ISU 赛事列表里自动找到并写回。

世锦赛只登记了赛事页，页面显示日期与倒计时；自动同步目前只覆盖七个世巡赛分站。

## 同步流程

各脚本逐站处理，某站失败只影响该站，Actions 日志以 `::warning::` 标出。

| 脚本 | 何时检查 | 接受条件 | 写入 |
|---|---|---|---|
| `sync_schedule.py` 官方赛程 | 开赛前 45 天至最后比赛日 | 城市与日期相符；九个项目都排到 A 组决赛；时间在本站日期内、按序、无重复 | `data/schedules/<id>.csv`、`data/sync_meta.json` |
| `sync_competitions.py` 报名、分组、成绩、排名 | 开赛前 14 天起持续 | 文件与页面标注本站城市和年份 | `data/competitions/<id>.json` |
| `sync_china.py` 中国队小组 | 开赛前 1 天至赛后 3 天 | 结果页标注本站城市和年份 | `data/china_auto.json` |
| `sync_predictions.py` 单项报项与排名 | 配置了 `prediction` 的站（目前温哥华），直到各项都有官方分组 | 六个单项各自的官方报项 | `data/prediction_inputs/<id>.json` |

**赛程**：第一次出现完整赛程时直接录入；开赛前可整体替换；开赛后只接受时间变动，一次超过 10 处或轮次结构改变则拒绝并保留原数据。赛事页有 Schedule 标签却读不到轮次，视为失败而不是“未公布”。比赛开始后 ISU 的赛程标签改为在浏览器里加载（页面只有 `loading_schedule`），此时已存的赛程保持不变（结果 `live`）；浏览器所用的 getschedule 接口在比赛中出现过与实际不符的时间，不自动采用，比赛日的改动按官方逐组时间人工核对：`python tools/check_live_schedule.py --station <id>` 只读地列出每轮的已存时间与官方第 1 组计划时间（`moved` / `missing` / `extra` / `no_heats`），见 [log.md](log.md)。

**报名**：每次从 Documents 重新发现最新的报名 PDF（ISU 更新时会换 URL）；整站名单只说明谁报了这一站，不能据此推断单项。

**姓名写法**：官方来源写法不一（报名 PDF 为 `LI Kun`，结果接口为 `Kun LI`，也有 `Margherita Betti`、`SONG KERUI`）。`data/` 保留原文；构建时按 `athlete_id` 统一成“名 姓（姓大写）”，以报名 PDF 的大写部分判断姓（全大写的两段名如 `SONG KERUI` 按 PDF 姓在前写成 `Kerui SONG`），判断不了时用已是该形式的其他来源（`competition_data.display_names`）。

**分组与成绩**：`tools/isu_results.py` 读取官网的 `eventResultsData` 与 `front-api.isu.org` 轮次、逐组接口。成功解析的同一轮次整体替换，允许官方更正分组或撤销判罚。已是正式成绩的轮次不再请求。

**排名**：只解析官方 PDF 的列，不自行按积分重算。

**接力队员**：接力的报项和出发名单只列队名；ISU 在队员确定后（比赛前或比完）把上场队员填进逐组接口，同步时存为该队的 `participants[].members`（姓名、选手 ID，按个人项目同一 `athlete_id` 统一写法），中国队接力行的“第 N 组”也随之写出队员。已出正式成绩、但存于此功能之前的接力轮次会再请求一次以补上队员。

**晋级规则**：每轮的 `qualification_rule`（如 “The first and second placed skaters from each race and up to a maximum of six fastest third place skaters qualify for Heats.”）按 `round_key` 存入快照的 `rounds.rules`，未公布分组的轮次也有；已结束而不再请求的项目保留上次的原文。构建时由 `tools/qualification.py` 转成 `2Q+6q` 和中文说明写入赛程的 `entries[].qualification`；不认识的写法不显示，不猜。

**单项报项**：从 Entries 标签读取六个单项各自的选手名单，按 ISU 选手 ID 匹配上赛季单项世巡赛排名（WCD）与世界排名（WRD）；上赛季榜单只抓一次，缓存在 `historic_rankings.json`。同一份报项也给运动员名单加上每人报的单项（`entries[].distances`）。

## 售票

`data/tickets.json` 按分站登记人工核对的售票信息：`sale_start`（带该站当地 UTC 偏移）、ISU 售票说明 `isu_url` 和订票链接 `booking_url`。订票域名必须在 `tools/build.py` 的 `BOOKING_SITES` 白名单中，按钮名称也取自那里；新增售票平台只需加一行。分站结束后售票卡自动消失。

## 中国队高亮

只有某个具体轮次（`round_key`）的官方分组里出现 CHN，才在赛程中高亮该轮次。来源依次是官方分组接口、`data/china_auto.json`（自动导入）和 `data/china.json`（人工覆盖，优先）。CHN、HKG、TPE 严格区分；不根据报名或上一轮晋级推断下一轮。

每个中国队小组的出场时间是按组号与单组时长上下限估算的区间，页面写成“约 00:02–00:04”，与官方轮次开始时间区分。

## 首轮分组预测

规则与出处见 [isu-seeding-2026-27.md](isu-seeding-2026-27.md)。`tools/predict_groups.py` 只放**已知种子**：有单项世界排名的选手按 Rule 293.4 蛇形分组，首轮不是四分之一决赛时按 293.5(a) 在同一排内移位或交换以回避同国。无世界排名者按 ISU 不公开的报名成绩排序，程序不猜位置，每组只显示总人数和待定人数。20 名直通者按 WCD 从实际报名者中选出，不足时以 WRD 递补；第 20 名处并列则该项目不出预测。

某项目出现官方分组后，该项目改为指向官方分组；所有项目都有官方分组后，分站页不再显示“分组预测”标签（`calendar.json` 的 `stations[].predictions`）。温哥华站的预测与官方分组完全一致，见 [log.md](log.md)。

## 接口

| GET | 内容 |
|---|---|
| `/api/v1/events` | 各站数据可用状态 |
| `/api/v1/events/<id>` | 该站接口列表 |
| `/api/v1/events/<id>/entries` | 全站报名（含替补、单项 `distances`） |
| `/api/v1/events/<id>/rounds` | 官方分组及参赛者，含 `has_china` |
| `/api/v1/events/<id>/results` | 已发布的逐人成绩、名次与晋级代码 |
| `/api/v1/events/<id>/penalties` | 官方给出的 PEN / YC / RC |
| `/api/v1/events/<id>/rankings` | 官方文件中的单站 / 世巡赛 / 世界排名 |
| `/api/v1/events/<id>/predictions` | 首轮非官方分组预测 |

筛选参数：`country`、`gender`、`distance_m`、`round_key`、`athlete_id`、`ranking_type`（预测只支持前三个与 `round_key`）。未知参数和资源不支持的参数均返回 `400 invalid_filter`，未知赛事返回 404，非 GET / HEAD 返回 405。按国家筛选 `rounds` 时保留同组对手。`athlete_id` 只匹配报名运动员或接力队的主 `athlete_id`；不会递归匹配接力队 `participants[].members` 中的上场队员。

统一响应字段：`schema_version`、`event_id`、`resource`、`status`、`update_status`、`checked_at`（最近成功的同步链路心跳，KV 不可用时为原快照时间）、`data_checked_at`（原始数据校验时间）、`updated_at`（内容变化）、`freshness_source`、`freshness_degraded`、`source_urls`、`stale`、`total`、`items`。`status=not_published` 加空数组表示尚未公布，不等于没人参赛。比赛 session 心跳超过 30 分钟、其他时段超过 36 小时或该资源校验失败时 `stale=true`；KV 故障时使用原快照的 36 小时判定并标记降级。

## 新动态

`tools/updates.py` 在每次构建时对比 `data/updates.json` 已记录的里程碑，把新出现的数据写成通知，前端读取 `dist/data/updates.json`。

| `kind` | 何时产生 |
|---|---|
| `schedule` | 某站详细赛程首次录入 |
| `entries` | 报名名单首次公布或成员变化 |
| `groups` | 某轮次首次出现官方分组（附中国队名单） |
| `results` | 某轮次全部为正式成绩（A 组决赛附领奖台；`china_results` 记每名中国选手或中国队的去向） |
| `time_change` | 官方轮次开始时间变化（首次运行只建基线） |
| `rankings` | 分站排名公布或变化 |

每个里程碑只通知一次；暂定成绩只算分组公布。保留最近 30 天、最多 150 条。

`china_results` 的去向：决赛记名次（A 组前三即奖牌）；其他轮次按成绩里的晋级标记（Q、q、ADV）算 `advanced`；半决赛后出现在 B 组决赛名单里的算 `final_b`；没有晋级标记、但出现在同项目复活赛名单里的算 `repechage`；其余为 `out`，有判罚时附 `penalty`。复活赛名单常在成绩之后才公布，所以 `groups`、`results` 两类通知保留首次发布的时间，其余内容每次构建按当前数据刷新。

是否复活赛看 ISU 的轮次名（“Rep. Heats”等），不看所在时段：温哥华混合接力半决赛排在复活赛时段里，但它是正赛半决赛。

## 失败、回退与请求量

- 网络、格式或赛事身份校验失败时保留既有数据，标记 `update_status=error`。
- 只有数据变化，或每天一次刷新核对时间时才提交，避免反复部署。
- 已确定的数据不再请求：正式成绩的轮次、已解析的同一份 PDF、上赛季排名、各项都有官方分组后的报项。

## 安全边界

- 只接受 ISU 官方域名的数据；不用第三方转载自动确认任何分组。
- 所有抓取使用 certifi 的根证书（`tools/tls.py`），不依赖运行环境里可能过时的系统列表。
- 页面数据以 DOM 文本节点插入，不作为 HTML 解析；测试同时使用合成夹具和已收录的官方历史记录。
