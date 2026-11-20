# D0 仓库与 ISU 数据源实测审计报告（`data_audit.md`）

> **审计日期**：2026-11-19  
> **审计分支**：`data/heat-history-2022-2026`（基于 `origin/main` `9691a57`）  
> **抽样缓存位置**：`.cache/isu/`（已加入 `.gitignore`）  
> **抽样目标赛事**：
> - `3912`：2022/23 World Cup #1 Montréal（单站双赛与 2022 规则基准）
> - `1950`：2024/25 World Tour #1 Montréal（世巡赛首站与 2024 规则基准，另附 Protocol PDF 核验）
> - `22`：2025/26 Olympic Winter Games Milano Cortina（冬奥会数据可用性与字段差异）
> - `1`：2025/26 ISU World Championships Montréal（世锦赛 API 可用性与 Protocol PDF 判罚表核验）
> - **补充交叉核验样本**（仅查 SF→Final A 道次）：`1599`（2024/25 WT #6 Milan）、`1502`（2024/25 Worlds Beijing）、`793`（2025/26 WT #3 Gdansk），以及仓库内 2026/27 样本 `data/competitions/vancouver.json`、`data/competitions/montreal.json`。

---

## 1. 现有工具资产审计摘要

| 文件 | 当前功能与可复用部分 | 历史全量分组导入（D1–D3）需改造/注意之处 |
|---|---|---|
| `tools/import_history_api.py` | 封装 `SourceCache`（URL + form hash 缓存、sha256 指纹、重试）与 `official_race_number()` | 目前在 L276/L285/L302 仅保留 `CHN` 且跳过非决赛轮次；`official_race_number()` 解析 `(1)/(2)` 后缀可直接复用 |
| `tools/isu_results.py` | `embedded_results()`、`api_data()`、`heat_items()`、`BOOKKEEPING` 去重 | 1) `heat_items()` L124 要求 `result_status` 为 `official/unofficial/provisional`，但 `3912`（22/23）所有 heat 的 `result_status` 为 `""`；2) L109 仅匹配 `Heat (\d+)`，会漏掉 `22`（冬奥）的 `Quarterfinal N`/`Semifinal N`；3) L83 未回退 `skaters.organization_code`，会在 `1950` `Thea JOHANSSON`（`started_for_nf_code=""`）处报错；4) `placeholder()` 仅在同选手重行时剔除，未剔除跨选手占道幽灵行（`Wonjun MOON`） |
| `tools/isu_transport.py` | 严格白名单 HTTP 客户端与 `next_property()` | 需注意 Protocol PDF 托管在 `isu-d8g8b4b7ece7aphs.a03.azurefd.net` 与 `isudam.blob.core.windows.net`；`isu_transport.USER_AGENT` 与 `tls.CONTEXT` 可直接复用 |
| `tools/qualification.py` | `describe()` 解析标准 ISU `qualification_rule` 文本 | 仅匹配 `"The first and second placed skaters..."` 句式，**不匹配**冬奥 `22` 的 `"The 2 best athletes..."` 句式，且 `3912`/`1950` 的 API 字段 `qualification_rule` 为空字符串 |
| `tools/penalty_protocol.py` | 解析 Protocol PDF `C98P` 与 `C89I2`（`INFRINGEMENT REPORT`）并关联 `ST/S/C/F` 子代码 | `1`（25/26 世锦赛）Protocol 含 `C89I2`（无 `C98P`），而 `1950`（24/25 WT1）Protocol 无 `C89I2` 表 |
| `tools/import_olympic_history.py` | 用 Poppler `pdftotext -bbox-layout` 解析 2018/2022 IOC C74 PDF | 2026 米兰冬奥会（`22`）已完整进入 `front-api.isu.org`，不再依赖 IOC PDF |
| `tools/sync_competitions.py` | 2026/27 现行赛事同步、entries/reports PDF 解析、`collect_event_classifications` | `data/competitions/*.json` 为格式兼容基准；注意 2026/27 `rounds.json` 在半决赛使用 `Q`/`q`/`ADV`，而 22/23–25/26 API 使用 `QA`/`qA`/`QB`/`qB`/`ADVA`/`ADVB` |

---

## 2. ISU Front-API 原始 JSON 字段全集实测

### 2.1 `events/list` 与 `embedded_results`（项目列表）

1. **`https://front-api.isu.org/events/list`**（POST form：`discipline_id=3, state=Finished, season=YYYY/YYYY`）：
   - 返回赛事级元数据：`event_id`, `name`, `city`, `country_code`, `country_name`, `from_date`, `from_date_utc`, `to_date`, `to_date_utc`, `time_zone`, `odf_code`, `season`, `season_id`, `slug`。
   - **重要陷阱（`time_zone` 不可信）**：API 返回的 `time_zone` 字段存在脏值：`1950`（Montréal）返回 `"Etc/UTC"`，`1`（Montréal）返回 `"America/Halifax"`，`22`（Milano Cortina）返回 `"Europe/Berlin"`。D2 必须基于经过校验的 `city -> IANA timezone` 映射表（复用 `data/stations.json` 口径，如 Montréal → `America/Toronto`），不可直接使用 API 的 `time_zone`。
   - **`venue` 字段缺失**：`events/list`、`embedded_results` 与 `heats` 接口均**不返回**场馆名（`venue`/`arena`）；场馆仅出现在 Protocol PDF 页眉（如 `1950` 与 `1` 均标注 `Maurice-Richard Arena, Montreal (CAN)`）及 2026/27 的 `data/stations.json`。

2. **赛事页内嵌 `eventResultsData`**（`embedded_results()`）：
   - 字段全集：`api_id`, `created_at`, `discipline_distance`, `discipline_id`, `discipline_name`, `discipline_type`, `display_order`, `event_id`, `event_name`, `event_result_id`, `gender`, `is_round_team_event`, `is_show_medalists`, `is_team_event`, `name`, `sport_api_code`, `sport_code`, `start_date`, `status`, `updated_at`。
   - 个人单项：`discipline_type == "Singles"`（接力为 `"Couples"`），`gender` 为 `"Ladies"` / `"Women"` / `"Men"`，`discipline_distance` 为 `"500"` / `"1000"` / `"1500"`。

### 2.2 `get-event-result-round`（轮次列表）

字段全集（13 个字段）：
`api_id`, `code`, `created_at`, `date`, `display_order`, `event_id`, `event_result_id`, `event_result_round_id`, `name`, `qualification_rule`, `round_type_name`, `status`, `updated_at`。

实测特征：
- `code`、`status`、`round_type_name` 在 4 个样本赛事中均为 `""`（空字符串）。
- `qualification_rule`：
  - `3912`（22/23）与 `1950`（24/25）：全部轮次均为空字符串 `""`（实际规则文本仅印在 Protocol PDF 的 `C73_ResultList` 底部 `NOTE`）。
  - `22`（25/26 冬奥）：非决赛轮有值，采用 IOC 句式，如 `"The 2 best athletes in each Heat (Q) and the 4 fastest 3rd placed athletes (q) qualify for the quarterfinals."`、`"The 2 best athletes in each Semifinal (Q) and the fastest 3rd placed athlete (q) qualify for Final A. The next 5 athletes qualify for Final B."`。
  - `1`（25/26 世锦赛）：非决赛轮有值，采用 ISU 标准句式，如 `"The first and second placed skaters from each race and up to a maximum of three fastest third place skaters qualify for Semifinals."`、`"...Remainder may qualify for Final B."`（注意 `Rep. Semifinals` 文本中偶见缺句点拼写 `Rep Semifinals` 与 `Rep. Semifinals` 并存）。

### 2.3 `get-event-result-round-heats-stk-single`（Heat 与选手明细）

1. **Heat 对象字段全集**（12 个字段）：
   `api_id`, `created_at`, `date`, `display_order`, `event_result_id`, `event_result_round_heats_competitors`, `event_result_round_heats_id`, `event_result_round_id`, `name`, `result_status`, `status`, `updated_at`。
   - **`result_status`**：`3912`（22/23）全部为 `""`；`1950`（24/25）、`22`（25/26 冬奥）、`1`（25/26 世锦赛）全部为 `"Official"`。
   - **开赛时间戳 `heat.date`（关键陷阱）**：格式为 `"2022-10-28T09:30:11.000Z"`（`3912`）、`"2024-10-25T09:00:43.000Z"`（`1950`）、`"2026-02-10T10:33:07.000Z"`（`22`）。**实测确证该时间戳实质为比赛地当地时间（Wall-Clock Local Time）伪装成 `.000Z` 后缀**（例如 Montréal 早场预赛均为 `09:00–09:30`，冬奥 1500m 晚场为 `20:15`）。因此 `local_date` 可直接取 `date[:10]`，而 `start_time_utc` 必须先剥离 `Z` 按场馆 IANA 时区解释后再转为 UTC，切勿直接将 `date` 当作 UTC 使用。

2. **Competitor 对象字段全集**（21 个字段）：
   `bib_number` (int), `competitors_api_id` (uuid), `created_at`, `event_result_round_heats_competitors_id`, `event_result_round_heats_id`, `final_points` (int, 通常 0), `final_rank` (int/null), `final_rank_index` (int), `final_result` (str), `lap` (list[dict]), `qualification_code` (str), `record_flag` (str), `result_status` (str), `skaters` (dict), `skaters_id` (int), `skaters_team_id` (null), `started_for_nf_code` (str), `started_for_nf_country_name` (str), `started_for_nf_name` (str), `starting_position` (int), `updated_at`。
   - **`skaters` 子对象字段全集**（13 个字段）：
     `id` (int, 与 `skaters_id` 一致), `api_id` (uuid), `discipline_id`, `first_name`, `last_name`, `full_name`, `gender` (`"F"`/`"M"`), `nationality_code`, `organization_code`, `slug`, `image`, `thumbnail_image`, `featured_image`。
   - **`starting_position`**：全部 4 个样本赛事均完整返回 `1..N` 整数起跑道次（仅 `1950` 出现 1 例幽灵撤赛行占位冲突，见 §6）。
   - **分段与分圈计时 `lap`**：**API 完整返回分圈数组**！每个元素包含 `{"LapNumber": "1", "Rank": 2, "LapTime": "13.920", "Time": "13.920", "ResultDiff": "+0.130"}`。
     - 正常完赛选手均有完整 `lap`（如 500m 5 圈、1000m 9 圈、1500m 14 圈）；`LapNumber == "1"` 的 `LapTime` 即为 `opening_split_s`，全部 `LapTime` 序列即为 `lap_times_s`。
     - `no time` 选手仍保留实际滑过的部分 `lap`（如 `3912` 女 1000m `Michelle VELZEBOER` 有前 6 圈，`Rikki DOAK` 有前 3 圈）；`PEN`/`DNF`/`DNS` 或未过第一圈摔倒者 `lap` 为 `[]`。
   - **状态值与完赛结果实测全集**（4 站合计）：
     - `final_result` 非时间值：`""`（仅幽灵行）、`"no time"`（注意为全小写！）、`"DNF"`、`"DNS"`、`"PEN"`、`"YC"`。
     - `result_status`：`""`（正常完赛及 `"no time"` 均为 `""`）、`"Did Not Finish"`、`"Did Not Start"`、`"Penalty"`、`"Yellow Card"`（注：`RC` 在规则中存在，样本 4 站未触发，但导入器需保留映射）。
     - `qualification_code`：`""`、`"Q"`、`"q"`、`"QA"`、`"qA"`、`"QB"`、**`"qB"`**（重要新增发现！见 §7）、`"ADV"`、`"ADVA"`、`"ADVB"`。
   - **判罚子代码（`ST1–ST6` / `S1–S9` / `C1–C5` / `F1–F3+`）**：**JSON API 不返回任何犯规子代码**，仅返回 `PEN`/`YC`；子代码仅能从 2025/26 起的 Protocol PDF `INFRINGEMENT REPORT`（`C89I2`）补充关联。实测 `1950`（24/25 WT1）的官方 Protocol PDF 中**尚无** `C89I2` 表格与 `ST/S/C/F` 子代码，而 `1`（25/26 世锦赛）Protocol PDF 第 99–100 页完整包含 `INFRINGEMENT REPORT`（含 `S1/S2/S6/S8/C1/F3` 及共同责任 `SR`）。

---

## 3. 复活赛与单站双赛在 API 中的精确特征

### 3.1 单站双赛（Double Distance，`3912`）

在 `3912`（2022/23 WC1 Montréal）的 `eventResultsData` 共 11 个项目中，1000m 举行了两次：
- `event_result_id=2294`: `name="Women 1000 m (1)"`, `discipline_name="Women 1000 m"`, `discipline_distance="1000"`, `start_date="2022-10-28T09:30:00.000Z"`, `display_order=0`
- `event_result_id=2385`: `name="Women 1000 m (2)"`, `discipline_name="Women 1000 m"`, `discipline_distance="1000"`, `start_date="2022-10-28T15:04:00.000Z"`, `display_order=7`
- 同理 `2298` `"Men 1000 m (1)"` 与 `2399` `"Men 1000 m (2)"`。

`discipline_name` 与 `discipline_distance` 在两次比赛中完全相同，必须通过 `name` 末尾的 `\((\d+)\)` 正则（与 `import_history_api.official_race_number()` 一致）并辅以 `(start_date, display_order, event_result_id)` 排序来确定 `event_distance_instance`（`1` 或 `2`）。

### 3.2 轮次命名与复活赛（`session_type` / `round` / `round_tier`）

4 个样本赛事中出现的全部轮次 `round_meta["name"]` 及 `heat["name"]` 实测如下：

| API `round_meta.name` | 出现赛事 | `session_type` | `round` | `round_tier` | API `heat.name` 实测写法 |
|---|---|---|---|---|---|
| `Preliminaries` | `3912`, `1950`, `1` | `PRELIM` | `preliminaries` | `0` | `Heat 1` .. `Heat 12` |
| `Heats` | `3912`, `1950`, `22`, `1` | `PRELIM` | `heats` | `1` | `Heat 1` .. `Heat 9` |
| `Rep. Quarterfinals` | `3912`, `1950`, `1` | `REPECHAGE` | `quarterfinal` | `2` | `Heat 1` .. `Heat 8` |
| `Rep. Semifinals` | `3912`, `1950`, `1` | `REPECHAGE` | `semifinal` | `3` | `Heat 1` .. `Heat 2` |
| `Quarterfinals` | `3912`, `1950`, `22`, `1` | `MAIN` | `quarterfinal` | `2` | `Heat 1`..`Heat 8`（`22` 冬奥 1500m 为 `Quarterfinal 1`..`6`） |
| `Semifinals` | `3912`, `1950`, `22`, `1` | `MAIN` | `semifinal` | `3` | `Heat 1`..`Heat 3`（`22` 冬奥为 `Semifinal 1`..`3`） |
| `Finals` | `3912`, `1950`, `22`, `1` | `MAIN` | `final` | `4` (`FB`) / `5` (`FA`) | `Final A`, `Final B` |

> [!NOTE]
> - 4 站样本虽未出现 `Rep. Heats`（`round="heats"`, `round_tier=1`, `session_type="REPECHAGE"`）与 `Pre-preliminaries`（`round="pre_preliminaries"`, `round_tier=-1`），但 `docs/isu_rules_evolution.md` 实证 25/26 蒙特利尔站存在 `Rep. Heats`，导入器正则需完整支持。
> - 复活赛链路实证验证：在 `3912`（1 例 `Reinis BERZINS`）与 `1950`（2 例 `Diane SELLIER`, `Zhanshuo LOU`）中，资格赛 `DNF` 选手均合法进入了后续复活赛；且在 `3912`（16 名 RSF 胜者）、`1950`（12 名）、`1`（12 名）中，`Rep. Semifinals` 胜者在进入正赛首轮（500/1000m QF 或 1500m SF）时均排在标准最外道（5 人组第 5 道、7 人组第 7 道；仅当同组有 `no time` 判进选手溢出至 6/8 人时，无时间判进者居最外道 6/8，RSF 胜者居 5/7）。

---

## 4. 半决赛 → 决赛出发道次实测验证（重大发现！）

依据 `heat-data-backfill-plan.md` 与 `docs/isu_rules_evolution.md` §4.2 的验证要求，我们对 **2022/23–2026/27** 各赛季共 **9 站**赛事的全部个人项目 `Semifinals -> Final A` 道次（`starting_position` 1..N）进行了逐项实测比对，结果如下：

| 赛季 | 赛事（ID / 日期） | 实测 SF → Final A 道次排序规则 | 典型实证 |
|---|---|---|---|
| **2022/23** | WC1 Montréal (`3912`, 2022-10) | **`time_first`** | 女 1000m (2)：SF2 第 3 名 `qA`（1:30.135）排 **第 4 道**，快于 SF1 第 2 名 `QA`（1:30.264，**第 5 道**）；男 1000m (1)：SF1 第 3 名 `qA`（1:24.611）排 **第 3 道**，快于 SF2 第 1/2 名 `QA`（1:26.012 / 1:26.068，**第 4/5 道**） |
| **2024/25** | WT1 Montréal (`1950`, 2024-10) | **`time_first`**（5/6 项；男 1000m 因 SF1 全组 `no time` 例外） | 男 1500m：SF2 第 2 名 `QA`（2:12.012）排 **第 2 道**，领先 SF1 第 1 名（2:15.624，**第 3 道**）；男 500m：SF2 第 3 名 `qA`（40.372）排 **第 4 道**，领先 SF1 第 2 名 `QA`（40.786，**第 5 道**）；女 1000m：SF2 第 3 名 `qA`（1:30.093）排 **第 3 道**，领先 SF1 第 1 名 `QA`（1:30.160，**第 4 道**） |
| **2024/25** | WT6 Milan (`1599`, 2025-02) | **`time_first`**（6/6 项全量） | 女 500m：SF2 第 3 名 `qA`（43.156）排 **第 4 道**，领先 SF1 第 2 名 `QA`（43.443，**第 5 道**）；男 1000m：SF1 第 3 名 `qA`（1:24.492）排 **第 3 道**，领先 SF2 第 1 名 `QA`（1:24.515，**第 4 道**） |
| **2024/25** | Worlds Beijing (`1502`, 2025-03) | **`time_first`**（6/6 项全量） | 男 1000m：SF1 第 3/4 名 `ADVA`（1:23.554 / 1:23.743）排 **第 3/4 道**，领先 SF2 第 1/2 名 `QA`（1:24.480 / 1:24.652，**第 5/6 道**）；男 1500m：SF3 第 4 名 `ADVA`（2:13.333）排 **第 5 道**，领先 SF1 第 1/2 名 `QA`（2:16.533 / 2:16.642，**第 6/7 道**） |
| **2025/26** | WT3 Gdansk (`793`, 2025-11) | **`time_first`**（6/6 项全量） | 男 1500m：SF1 第 5 名 `ADVA`（2:18.194）排 **第 5 道**，领先 SF2 第 1/2 名 `QA`（2:18.610 / 2:18.636，**第 6/7 道**）；男 500m：SF1 第 3 名 `qA`（40.911）排 **第 3 道**，领先 SF2 第 1 名 `QA`（41.352，**第 4 道**） |
| **2025/26** | Olympics Milano (`22`, 2026-02) | **`time_first`**（6/6 项全量） | 女 500m：SF1 第 3 名 `qA`（41.760）排 **第 3 道**，领先 SF2 第 1/2 名 `QA`（42.463 / 42.672，**第 4/5 道**）；男 500m：SF2 第 3 名 `qA`（40.295）排 **第 3 道**，领先 SF1 第 1 名 `QA`（40.752，**第 4 道**） |
| **2025/26** | Worlds Montréal (`1`, 2026-03) | **`time_first`**（6/6 项全量） | 女 1500m：SF2 第 3 名 `qA`（2:20.943）排 **第 3 道**，领先 SF3 第 1 名 `QA`（2:28.777，**第 4 道**）；女 500m/男 1000m/女 1000m 的 `qA` 均凭更快时间排在第 3 道，领先慢组 `QA` |
| **2026/27** | WT1 Vancouver (`16230`, 2026-10) | **`rank_then_time`**（6/6 项全量） | 女 500m：第 1 名（42.851, 42.901）→ 第 2 名（42.993, 43.719）→ `q`（43.215）排 **第 5 道** |
| **2026/27** | WT2 Montréal (`16272`, 2026-11) | **`rank_then_time`**（6/6 项全量） | 女 500m：SF2 第 1 名（42.705）排 **第 2 道**，领先 SF1 第 2 名（42.627，**第 3 道**）；男 1500m：3 名第 1 名全占 **1–3 道**，3 名第 2 名全占 **4–6 道** |

> [!IMPORTANT]
> **核心结论**：与最初预期（2024/25 起切换为 `rank_then_time`）不同，**2024/25 全季与 2025/26 全季（含米兰冬奥会与蒙特利尔世锦赛）在实际比赛中仍全部执行 `time_first` 道次分配**（2024 版规则仅将轮次间分组排位切换为名次优先，而**道次分配切换至 `rank_then_time` 是在 2026 年 6 月《短道速滑运动规则》生效后的 2026/27 赛季才正式实施**）。  
> **对 D3 `season_config.json` 的影响**：建议将 2022/23、2023/24、2024/25、2025/26 四季的 `lane_mode` 均配置为 `"time_first"`，仅 2026/27 配置为 `"rank_then_time"`（请在进入 D1–D5 前确认）。

---

## 5. 2025/26 冬奥会（`22`）与世锦赛（`1`）组别级数据获取方案

实测确认：**无需使用 PDF 重建赛果**，ISU `front-api.isu.org` 已完整发布这两站全部组别级数据：

1. **2025/26 米兰-科尔蒂纳冬奥会（`event_id=22`）**：
   - `embedded_results` 返回全部 9 个小项（6 个个人项目 + 3 个接力）；
   - `get-event-result-round` 与 `get-event-result-round-heats-stk-single` 完整返回全部轮次与全部 Heat（共 431 名选手次，403 条含分圈 `lap` 数据），`starting_position`、`final_rank`、`final_result`、`qualification_code`、`qualification_rule`、`result_status="Official"` 全数齐备，零空缺、零重复占位。
2. **2025/26 蒙特利尔世锦赛（`event_id=1`）**：
   - `embedded_results` 返回全部 9 个小项；
   - API 完整返回全部 Preliminaries / Heats / Rep. QF / Rep. SF / QF / SF / Finals（共 834 名个人选手次，792 条含分圈 `lap` 数据），`starting_position` 100% 齐备；
   - **额外增强来源**：`data/history/catalog.json` 已登记官方 Protocol PDF（`Protocol-1773648916-2179.pdf`, sha256 `57ccbe99f3fde1200422cca42f405b2bd9fced5d351c709679e7dba5ab3d344a`），其第 99–100 页 `INFRINGEMENT REPORT` 完整记录了全部 `ST/S/C/F` 判罚子代码及 `SR`（共同责任），D2/D3 可直接按 `(gender, distance_m, round_label, country, helmet_number)` 关联至 API heats。

---

## 6. 实测脏数据与边界情况清单

1. **撤赛幽灵行造成同组道次重复（`1950`）**：
   - `1950` `Men 1000 m` `Rep. Quarterfinals` `Heat 4` 中，`Wonjun MOON`（`skaters_id` 对应 HUN，赛前退赛）以 `starting_position=3, final_rank=None, final_result="", result_status="", qualification_code="", lap=[], started_for_nf_code=""` 残留在数组中，与同组 `starting_position=3` 的实际参赛者 `Yerkebulan SHAMUKHANOV` 冲突（`1950_wt1.pdf` 第 82 页底部注明 *"Skater 122 MOON Wonjun (HUN) has been withdrawn from competition"*）。
   - **处理方案**：若某条记录满足 `final_rank is None and not final_result and not result_status and not qualification_code and not lap`，判定为赛前撤赛幽灵占位行（而非 `DNS`），在同道次已有实际完赛/出发选手时直接剔除（避免破坏 `starting_position` 唯一性约束）。
2. **`started_for_nf_code` 为空字符串（`1950`）**：
   - `1950` 中瑞典选手 `Thea JOHANSSON` 在全部 6 个小组记录中 `started_for_nf_code` 均为 `""`，但 `skaters.organization_code` 和 `skaters.nationality_code` 均为 `"SWE"`。
   - **处理方案**：`country` 取值优先级应为 `started_for_nf_code or skaters.organization_code or skaters.nationality_code`。
3. **中立运动员 `AIN`（`22`）**：
   - `22` 中 `Alena KRYLOVA` 与 `Ivan POSASHKOV` 的 `started_for_nf_code == "AIN"`、`skaters.organization_code == "AIN"`、`skaters.nationality_code == "RUS"`。`country` 应取 `"AIN"`（当场代表标识，与 2026/27 `rounds.json` 一致）。
4. **单组整组无时间故障（`1950` Men 1000m SF Heat 1）**：
   - 该组 6 名选手全部记为 `final_result="no time"`（计时系统故障），`1950_wt1.pdf` 页 85 确认全部为 `No time`。此时 `status="NO_TIME"`、`time_s=null`，且该轮道次排位按组内名次交替插入另一组有时间选手之后（仅影响道次校验的故障豁免）。
5. **冬奥会 Heat 命名格式差异（`22`）**：
   - `22` 中 `Quarterfinals` 的 `heat.name` 为 `"Quarterfinal 1..6"`、`Semifinals` 为 `"Semifinal 1..3"`，而非 `"Heat 1..N"`。`heat_number` 正则必须兼容 `(?:Heat|Quarterfinal|Semifinal)\s+(\d+)`。
6. **时间戳伪 UTC 后缀（`3912`/`1950`/`22`/`1`）**：
   - `heat.date` 形如 `2024-10-25T09:00:43.000Z` 实为当地墙上时间，且 `events/list` 的 `time_zone` 对 `1950`/`1` 返回错误时区。必须通过城市时区表转换得出 `start_time_utc`。
7. **2022/23 `heat.result_status` 为空（`3912`）**：
   - `3912` 全部 heat 的 `result_status` 为 `""`，不能沿用 `isu_results.py` 仅靠 `result_status in {'official', ...}` 判断是否已完赛，需结合选手 `final_rank`/`final_result` 非空来判定 `evidence="official_results"`。
8. **环境依赖备注**：
   - 宿主机默认 Python 仅有 `certifi` 与 `requests`，无 `pip`/`python3-venv`/`pdftotext`；纯 Python wheel（`beautifulsoup4`、`pypdf`）可免 `pip` 解压至 `.cache/pylib` 运行，无需修改系统环境。

---

## 7. 对 `heat-data-backfill-plan.md` §3 字段映射的确认与微调建议

经 4 站实测，§3 绝大部分字段（`athletes.json` 主键 `skr-<id>`、Heat 兼容字段、`opening_split_s`、`lap_times_s`、`NO_TIME`/`DNF`/`DNS`/`PEN`/`YC`/`RC`/`ADV`）均可直接由 API 落地，仅以下 **4 处细节**建议确认后再进入 D1：

1. **`qual_flag_raw` 与 `qual_type` 补充 `"qB"`**：
   - 计划 §3.2 仅列出了 `Q / q / QA / qA / QB / ADV / ADVA / ADVB`，但实测 2022/23–2025/26 半决赛中高频出现 **`"qB"`**（如 500m/1000m 半决赛第 5 名或 1500m 半决赛第 5 名按规则递补进 Final B）。
   - 建议 `qual_flag_raw` 保留原始 `"qB"`；`qual_type` 建议对 `"QB"` 与 `"qB"` 统一归入 `"QB"`（或保留 `"QB"`/`"qB"` 两枚举，`qual_target="FB"`, `advanced=false`）。请确认偏好。
2. **2026/27 `rounds.json` 与历史 API 的 `qual_flag_raw` 统一**：
   - 2026/27 `data/competitions/*.json` 在半决赛返回的 `qualification` 为 `"Q"` / `"q"` / `"ADV"`（API 新版本取消了 `A`/`B` 后缀，直接用 `Q`/`q` 进 Final A），而 22/23–25/26 为 `"QA"` / `"qA"` / `"QB"` / `"qB"` / `"ADVA"` / `"ADVB"`。`qual_type`（`Q`/`q`/`ADV`/`QB`/`OUT`）+ `qual_target`（`NEXT`/`FA`/`FB`）已足够统一两者，建议在导出宽表时按此归一化口径对齐 2026/27。
3. **`lane_mode` 赛季开关修正**：
   - 如 §4 实测所示，建议 `data/heats/rules/season_config.json` 中 **2022/23、2023/24、2024/25、2025/26 均设 `lane_mode="time_first"`**，仅 **2026/27 设 `lane_mode="rank_then_time"`**（同时在注释中说明：2024/25–2025/26 的**轮次间分组种子排位**已转向名次优先，但**半决赛→决赛出发道次**实测仍维持时间优先）。
4. **`penalty_code`（`ST/S/C/F`）历史覆盖范围**：
   - 2022/23–2024/25 API 与 2024/25 Protocol PDF 均不含 `ST/S/C/F` 细分子代码，仅 2025/26 世锦赛等含 `C89I2` 的 Protocol PDF 可提取子代码。确认历史早期赛季 `penalty_code` 合法留空为 `null`，仅 `penalty` 保留 `"PEN"`/`"YC"`/`"RC"`。
