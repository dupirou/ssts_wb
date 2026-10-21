# ISU 数据同步与中国队自动高亮

## 运动员与比赛查询接口（2026-10-20 新增）

Cloudflare Worker 读取由 Python 校验并生成的静态快照；访问接口不会触发上游抓取。
现有页面和 `/data/vancouver.json` 保持兼容；新分组会自动供给现有中国队高亮。分站页接入完整报名名单、国家与性别筛选；对应轮次的详情弹窗显示官方分组、成绩、晋级代码与判罚。排名有数据时显示独立折叠列表。接口失败保留赛程及成功加载的列表，提供重试。

| GET 接口 | 内容 |
|---|---|
| `/api/v1/events` | 七站的数据可用状态 |
| `/api/v1/events/vancouver` | 该站接口列表 |
| `/api/v1/events/vancouver/entries` | 全站报名，含 active/substitute |
| `/api/v1/events/vancouver/rounds` | 正式出场分组及参赛者，含 `has_china` |
| `/api/v1/events/vancouver/predictions` | 首轮非官方分组推演；单项种子名单不全时返回等待原因 |
| `/api/v1/events/vancouver/results` | 已发布的逐组选手成绩、名次与晋级代码 |
| `/api/v1/events/vancouver/penalties` | 官方明确给出 PEN/YC/RC 的记录 |
| `/api/v1/events/vancouver/rankings` | 已取得官方文件中的单站/世巡赛/世界排名 |

支持 GET 和 HEAD；其他方法返回 405。未知赛事返回 404，未知/无效/重复筛选参数返回 400。
`country=CHN`、`gender=women`、`distance_m=500`、`round_key=...`、
`athlete_id=...`、`ranking_type=event|world_tour|world` 可组合，使用 URLSearchParams 编码。
例如 `/api/v1/events/vancouver/results?country=CHN&gender=women&distance_m=500`。
报名数据无距离/轮次字段，不能按报名表推断某个项目参赛；不存在的字段筛选得到空列表。
按国家筛选 `rounds` 会选出包含该国的比赛，并保留同组对手；`results` 和 `penalties` 只返回匹配运动员。

统一响应：`schema_version`、`event_id`、`resource`、`status`、`update_status`、
`checked_at`、`updated_at`、`source_urls`、`stale`、`total`、`items`。
`checked_at` 是上次公开发布的成功核对时间（每天或数据变化时刷新）；
`updated_at` 是内容变化时间。`status=not_published` 和空数组表示尚无可用官方数据，不能视为无人参赛。
当前温哥华报名 189 人、CHN 12 人；分组、成绩、排名暂未发布。

### 首轮分组预测

分站页提供独立的“分组预测”折叠面板，切换男女及 500/1000/1500m，可只看含中国队的预测组。预测不会写入 `rounds`、`results`、中国队确认高亮或官方赛程时间；某项目的官方分组出现后，该项目优先展示官方入口。

规则依据：[ISU 2026 Sports Rules](https://isudam.blob.core.windows.net/isudamcontainer/2026-Short-Track-Sport-Rules-20260513-FINAL-as-of-1-June-2026-1780065543-3994.pdf) Rule 293.3–5；[Communication 2806](https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/CMS/Corporate-Site/Governance/Transparency/ISU-Communications/2806-ISU-Short-Track-World-Tour-2026-27-1782891715-3107.pdf) §7；2026/27 晋级表第 1–4 页（来源保存在 `data/prediction_tables.json`）。种子蛇形分配；除四分之一决赛/半决赛外，尝试同一排内移位及交换以回避同国选手。裁判可决定调整前排、无法回避时保留原组等，这些裁量不作唯一答案预测，残留冲突会标明。预测不生成出发道次，也不预测胜负、后续晋级者或接力分组。

现从 ISU 温哥华站 **Entries** 标签逐个读取六项的官方 `event_result_id` 与该项目的选手列表。此前的整站报名 PDF 仅作为发现官网上传不完整的保守检查，不据此添加任何单项参赛者。同期分页取得官网历史单项分类和世界排名，通过官方 `skaters_id` 匹配；完整性、项目身份及每一页数量必须通过校验。官网接口只返回当前已上传的部分名单时，展示已读取的名单与历史排名，并保持预测等待态。

每个项目名单须至少连续两次核验稳定（相隔约 30 分钟），并满足官方晋级表人数及当前轮次一致，才能发布模型分组。若有直通第 20 名并列、世界排名并列、或无世界排名选手的报名成绩及抽签顺序无法核实，该项目保持等待态，不以 API 返回顺序或整站名单补齐。已公布的正式分组始终优先。

温哥华首站的排名依据应分开核对：通告 2806 §7(a) 按 **2025/26 World Tour Distance Classification（单项世巡赛最终排名）**确定已报名选手中的前 20 名直通者；§7(b–d)、§14 按 **World Ranking（单项世界排名）**确定分组种子顺序，赛季初取 2025/26 四站中的最好三站成绩及对应世界排名积分。两者均按距离区分，不采用三项合计的 Overall 总排名。§14 表下注明，世锦赛成绩从 **2027/28** 才计入该 World Ranking，因此温哥华不能直接以上赛季世锦赛名次作种子。普通首轮无世界排名者按该单项最终报名成绩排在有排名者之后；同分与无成绩的未决抽签顺序仍需核对。单项报名确认后，可以据这些历史排名推导种子，无需以官方已经分好组为前提。

自动同步结果保存在 `data/prediction_inputs/{event}.json`。其 `observed_lists` 保存各单项实际报项、排名、未解决原因与官方来源；只有满足完整性及顺序检查的项目才写入 `seed_lists`。每份可预测名单包含项目、`complete: true`、官方来源、核验时刻以及连续 `seed_rank` 和明确的 `prequalified`。报名接口中的 `entry_index` 为空时不得当作无排名选手的抽签次序。

构建时校验官方来源、项目、名单完整性、直通人数和实际首轮赛程，再根据晋级表选择组数。当前支持表内 26–95 人的标准首轮；未覆盖人数保留等待态。500/1000m 超过 40 人、1500m 超过 63 人时，20 名直通者单列，不放入前置轮次。未来官网更正单项报项或排名后自动重算；抓取失败保留上次快照并标记同步错误。接口仅支持 `gender`、`distance_m`、`round_key` 筛选。
其他站的报名、分组与成绩按同一流程自动同步（见“多站自动更新”）；预测模型只用于温哥华。

`rounds` 中 `evidence=official_start_list` 或 `official_results`；
`result_status` 原样保留官方 provisional/official 状态。只有明确的 A/B 决赛标签才关联对应赛程。
`source_start` 原样保留 ISU 返回值，不以它推算精确开赛时间；使用已核对赛程的 `round_key` 关联页面。
队伍由官方 `started_for_nf_code` 判断，CHN、HKG、TPE 严格区分。
接力成绩属于参赛队，`athlete_id` 为队伍 ID，不能归到报名表中全部队员名下。
运动员在报名 PDF 中没有官方 ID，因此本地 ID 使用国家、性别、姓名词元生成；
官方成绩同时保留 `official_skater_id`，不能用本地 ID 充当 ISU 永久人物编号。

判罚记录只复制官方判罚结果，`penalty={code:"PEN",infringement_code:null}`。
当前公开成绩接口未提供具体动作原因时不补推断；DNS、DNF、ADV 不计为判罚。
排名来自官方 PDF 列，不自行按积分规则重算；未提供的 `points` 为 null，
`official_details` 保留其他官方表格字段。排名来源未发布时接口保持空态。

### 多站自动更新（每站同一条流程）

`data/stations.json` 是唯一的分站配置：城市、日期、时区、场馆，以及该站在 ISU 官网的赛事页（`isu.slug` 与 `isu.event_id`）。其余来源地址都由它推出：`?tab=schedule_<id>`、`documents_<id>`、`results_<id>`、`entries_<id>`。新赛季只需更新这一个文件；`isu` 留空时，赛程同步会在 ISU 赛事列表里按“城市 / 国家代码 + 日期”自动找到赛事页并写回。

| 环节 | 何时检查 | 接受条件 | 写入 |
|---|---|---|---|
| 官方赛程 `sync_schedule.py` | 开赛前 45 天至最后一个比赛日 | 赛事页城市与日期相符；九个世巡赛项目都排到 A 组决赛；全部在本站日期内、按时间顺序、无重复 | `data/schedules/<id>.csv`、`data/sync_meta.json` |
| 报名、分组、成绩、排名 `sync_competitions.py` | 开赛前 14 天起持续核对（已是正式成绩的轮次不再请求） | 文件与页面标注本站城市和年份 | `data/competitions/<id>.json` |
| 中国队小组 `sync_china.py` | 开赛前 1 天至赛后 3 天，且已有赛程 | 结果页标注本站城市和年份 | `data/china_auto.json`（各站共用，按 `round_key` 日期区分） |
| 首轮预测 `sync_predictions.py` | 只对 `competition_sources.json` 配了 `prediction` 的站（目前仅温哥华，因直通规则只适用世巡赛第一站） | 见上文 | `data/prediction_inputs/<id>.json` |

赛程规则：
- 某站第一次出现完整赛程时直接录入，页面随即出现该站详细赛程，“新动态”提示“详细赛程已公布”。
- ISU 在开赛前仍可能整体调整暂定赛程，此时以新的完整赛程整体替换。
- 开赛后只接受时间变动；一次超过 10 处，或轮次结构改变，都拒绝并保留原数据，等待人工处理。
- 赛事页已有 Schedule 标签却读不到任何轮次（例如改为浏览器端加载），视为失败并在日志中警告，不当作“未公布”。

各同步脚本都是逐站处理，某站失败只影响该站，其他站照常写入；Actions 日志中以 `::warning::` 标出。

世锦赛在 `stations.json` 中只登记了 ISU 赛事页，页面仍显示日期与倒计时；以上自动同步目前只覆盖七个世巡赛分站。

报名与成绩同步从开赛前 14 天起不设结束时间，以免已结束的分站在 API 中被标为 stale；已是正式成绩的轮次不再重复请求，每个已结束分站每次约 2 个页面请求。赛季后段若请求量偏大，再为已结束分站设截止并同步调整 stale 判定。

### 抓取、更新及回退

- `data/competition_sources.json` 只保存逐站的额外来源（目前是温哥华的预测配置）；通用地址由 `data/stations.json` 推出。
- `tools/sync_competitions.py` 每次从 Documents 重新发现最新报名 PDF/排名文件，避免写死替换后的 PDF URL。
- `tools/isu_results.py` 读取新官网公开 `eventResultsData` 元数据，再调用官网使用的 `front-api.isu.org` 轮次及逐组接口。
- `data/competitions/<event>.json` 为最近成功快照；`tools/build.py` 输出 `dist/data/competitions/`。
- Cloudflare Cron 在比赛时段每 10 分钟、比赛窗口其他时间每小时触发 Actions；GitHub 自身每天 00:17、12:17 UTC 尝试兜底，可能延迟或跳过。`tools/sync_predictions.py` 在每次实际启动时同步逐项报项、历史单项分类与世界排名，只有数据变化或每天发布一次核对时间才产生提交。预测接口的 `checked_at` 是最近**公开发布**的核对时间，项目的 `updated_at` 是内容变化时间；两者不同，不是秒级比分服务。
- 网络/格式/赛事身份校验失败时保留既有记录，标记 `update_status=error`、`stale=true`。
  已有数据超过 36 小时未成功核对也会标为 stale。
- 成功解析的完整报名表替换旧名单；成功解析的同一轮次替换其全部小组，允许官方撤销报名、更正分组或撤销 PEN。
- PDF 只解析公开报名和排名表；热次成绩使用已验证 JSON 适配器。解析失败不会发布猜测结果。

本地操作：

```sh
python -m pip install -r requirements.txt
python tools/sync_schedule.py --station montreal
python tools/sync_competitions.py --event montreal
python tools/build.py
python -m unittest discover -s tests -v
node --test tests/test_api.mjs
npx wrangler@4.151.2 dev --local
```

`wrangler.jsonc` 增加 `/api/*` Worker 路由及 `ASSETS` 绑定，普通页面继续按静态文件托管。
部署见 [Cloudflare 部署说明](DEPLOY_CLOUDFLARE.md)。不需要额外数据库、密钥或管理员写接口。

以下章节描述旧版中国队静态高亮兼容流程；新接口不依赖旧版结果页发现器。

## 模块职责

| 文件 | 职责 |
|---|---|
| `data/stations.json` | 分站与世锦赛配置：日期、时区、ISU 赛事页 |
| `tools/stations.py` | 读取分站配置，推出各站官方地址、同步时间窗与赛程文件路径 |
| `tools/sync_schedule.py` | 自动发现各站 ISU 赛事页，录入并核对官方赛程，完整且一致才接受变化 |
| `data/schedules/<id>.csv` | 各站已核验的官方赛程（当地日期、时间、项目、轮次） |
| `tools/sync_china.py` | 从 ISU 官方结果索引发现各站结果页，依次读取项目、轮次、Heat |
| `data/china_sources.json` | 自动发现失败时可按站指定经过核验的 ISU 结果主页（`event_results_urls`） |
| `data/china_auto.json` | 自动导入的已核验中国队小组证据 |
| `data/china.json` | 人工核查后的备选/覆盖记录（优先级高） |
| `tools/build.py` | 验证所有证据、关联赛程、估算非官方小组时间，为每个已有赛程的分站生成 `dist/data/<id>.json` |
| `tools/updates.py` | 构建时生成“新动态”：对比 `data/updates.json` 已记录的里程碑，把新出现的名单、正式分组、正式成绩、赛程时间调整与排名写成通知 |
| `.github/workflows/sync.yml` | Cloudflare 按比赛窗口触发；GitHub 每 12 小时定时兜底；数据变化或每日核对记录更新时重新部署 |

## 当前数据状态（2026-10-20）

ISU 官网已经公布温哥华站**轮次**时间；ISU 2026 年温哥华站的**逐组结果/Start List** 尚未出现在当前可读取的官方结果索引中。本项目的自动分组抓取会安全地跳过空源。此时 `china_auto.json` 为空，前端不显示 CHN 高亮。不能按报名项目推断选手参加所有轮次。

自动发现算法：官方结果索引 → 2026 Vancouver 结果赛事首页 → 各距离/接力项目页 → Preliminaries / Heats / Rep. / Quarterfinals / Semifinals / Finals → 官方 Heat 数据中 CHN 国别 → 稳定 `round_key`。

若赛事开始后官方尚未将结果添加到索引，可以将官方赛事**结果页面**（不是赛事宣传页）按站填进 `data/china_sources.json` 的 `event_results_urls`（如 `"montreal": "https://…"`），后续由定时任务自动更新；但页面必须能够明确验证属于该站的城市和年份。也可以本地运行：

`python tools/sync_china.py --station montreal --event-url https://www.isu-skating.com/en/short-track/results/实际结果赛事链接/ --dry-run`

上面的 URL 仅表示格式，不能照抄为实际地址。

## 安全边界

- 不接收第三方转载作为自动确认，只有 ISU 官方域名下的具体赛事/轮次数据才生效。
- 所有抓取统一使用 certifi 的根证书列表（`tools/tls.py`），不依赖 Actions 运行环境里可能过时的系统列表；浏览器撤销信任的证书机构（如 2026 年 10 月 eMudhra 的 emSign ECC Root CA – G3）随 certifi 更新一并失效。
- 每条记录包含赛事轮次 `round_key`、Heat 序号、CHN 选手/接力队、官方原始 URL 和核验时间。
- 不会把 HKG、TPE 当作 CHN。
- A/B 组决赛须能在原始内容中明确识别 Final A 或 Final B；否则**不自动猜测**。
- 不能根据上一轮晋级结果直接高亮下一轮：必须在下一轮名单/结果中再次确认。
- 官网超时、尚未发布或解析结构改变，不删除已有已核验数据。
- `CHN` 高亮与单组**估算时间**是两层数据，模型估算只决定时间范围，不决定出场资格。
- 样例与单元测试中的运动员姓名仅为合成测试数据，不能发布到生产 JSON。

## GitHub Actions

推送和手动触发的工作流会执行：
1. 各站官网赛程核对；某站失败则该站不更新赛程 CSV。
2. 中国队小组核对，未公布则无修改；解析异常时记录失败而保留上一版。
3. 本地数据构建、Python 单测、JS 语法检测。
4. 有内容变化才提交 `dist/` 与已确认的数据文件到 main，Cloudflare Workers/Pages GitHub 集成随后部署。

需要关注 [GitHub Actions](https://github.com/dupirou/ssts_wb/actions) 的日志，不要将“Actions 成功执行”理解为“官网已公布全部分组”。

前端不需要免责声明横幅；必须继续区分时间的**官方轮次开始**与**单组预计**。原始来源可在赛程卡上以简洁链接提供。

官方来源：
- [ISU 温哥华站赛程](https://www.isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230)
- [ISU 短道赛果索引](https://www.isu-skating.com/en/short-track/results/)

## 新动态通知

`tools/updates.py` 在每次构建时运行，只读取同步已经接受的数据，不额外访问 ISU。`data/updates.json` 的 `facts` 记录已经通知过的里程碑，`events` 是通知列表；工作流随构建结果一并提交，前端读取 `dist/data/updates.json`（只含 `events`，新的在前）。

| 类型 `kind` | 何时产生 | 时间 `at` |
|---|---|---|
| `schedule` | 某站详细赛程首次录入（`count` 轮，`local_date` 为首个比赛日）；已有赛程的站不补发 | 赛程核对时间 |
| `entries` | 报名名单首次公布，或名单成员变化（`changed: true`） | 名单数据的 `updated_at` |
| `groups` | 某轮次首次出现官方分组或成绩（含中国队名单 `china`） | 分组数据的 `updated_at` |
| `results` | 某轮次所有 Heat 均为 Official 成绩；A 组决赛附前三名 `podium` | 同上 |
| `time_change` | 官方轮次开始时间变化（`previous` / `current` 为北京时间）；首次运行只建立基线，不通知 | 赛程核对时间 |
| `rankings` | 分站排名首次公布或变化 | 排名数据的 `updated_at` |

每个里程碑只通知一次，暂时消失再出现也不会重复；暂定（Unofficial）成绩只算分组公布。通知时间全部取自数据本身，同一份数据重复构建得到相同结果。保留最近 30 天、最多 150 条。

## 页面结构与加载

分站页使用“赛程 / 运动员 / 分组预测”三个标签，默认赛程；`?view=athletes` 或 `?view=predictions` 可直达对应内容。切换不会重建赛程，日期、时区与名单筛选保留。赛程概览默认收起，展开后才绘制比赛时段和奖牌赛；排名明细同样在展开时渲染。窄于 350px 时筛选栏换行，保留时区切换。

默认进入已录入的分站仅请求 calendar、该站 schedule、updates 和 rounds 四项数据（原先六项；updates 很小且不阻塞首屏）。正式分组在首屏绘制后独立加载，只补充赛程详情按钮；报名及排名在进入运动员标签后独立加载，预测在进入预测标签后加载。请求去重，成功数据在当前页面复用 60 秒，过期后再次进入标签时刷新并保留筛选；API 使用已有的 60 秒 HTTP 缓存。每项请求超时 8 秒，失败可单独重试；赛程不依赖运动员接口成功。后台标签暂停每秒时钟更新，回到前台立即校时。

验收包括慢排名接口不阻塞名单、并发去重、单项重试、缓存过期刷新、标签键盘导航及日期/时区/赛程定位回归。请求数量是自动化验证的加载策略指标，不等同于真实网络环境下的 LCP 提升比例。
