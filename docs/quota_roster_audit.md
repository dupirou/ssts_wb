# 2026–27 赛季名额核算与动态阵容预测系统 — Phase 0 审计报告 (`quota_roster_audit.md`)

> **审计日期**：2026-11-21  
> **基准提交**：`main` @ `20f1cbc`（开发分支：`feat/quota-roster-system`）  
> **规则与需求基准**：ISU Comm. 2805 / 2806 / 2807（2026-08-06 修订）/ 2811、CER 2026 Art. 9.2、2026 ST Sports Rules、Qualifying Tables（2026-11-17）及《PLAN_QUOTA_ROSTER.md》

---

## 1. 现有仓库资产与模型接口审计

| 模块 / 文件 | 现状与可复用接口 | 新模块接入与隔离策略 |
|---|---|---|
| `tools/isu_transport.py` | 严格域名白名单、TLS 根证书（`certifi`）、限流与字节上限 HTTP 客户端 | 直接复用，白名单已覆盖 `front-api.isu.org`、`www.isu-skating.com` 与 `isu-d8g8b4b7ece7aphs.a03.azurefd.net` |
| `tools/isu_results.py` | `embedded_results()` 从赛事详情 HTML 提取 `eventResultsData`（`event_result_id` 列表） | 实测对青年世界杯 / 世青赛页面 **100% 兼容**（含单站重复距离 `(1)`/`(2)` 及 3000m 青年男/女接力） |
| `tools/import_heats.py` | `ThrottledCache`（1.0s 限速 + 磁盘哈希缓存 + 离线重放）、分圈 `lap` 解析、选手 ID 归一化 | 青年组爬虫 `tools/sync_junior_isu.py` 复用相同请求契约，但缓存目录（`.cache/isu_junior/`）与落盘目录（`data/quota_roster/junior/`）**严格独立** |
| `tools/sync_world_tour.py` / `tools/isu_rankings.py` | `get-world-standings-list`（`season_id=47`）与 `ranking_rows()` 分页读取 | 实测 `season_id=47` 完整提供 32 张官方榜单（见 §2.2），可直接扩展拉取接力 `WCD` 与世界排名 `WRD` 供 Phase 1 名额核算 |
| `tools/sync_penalties.py` / `data/penalties/*.json` | 已收录 WT #1 温哥华、WT #2 蒙特利尔官方 Protocol 核验的 `C98P` 累计犯规与 `C89I2` 判罚明细（已排除 `EMB/EQP/OFF/SR/ST6`） | Phase 1 世巡赛累计犯规禁报检查直接读取 `data/penalties/*.json` 最新快照，无需推算 |
| `src/prediction/rating.mjs` / `pace-model.mjs` / `monte-carlo.mjs` | 成年组 V1.5/V2 贝叶斯 Plackett-Luce（OpenSkill）评分引擎与分组蒙特卡洛模拟器；离线快照为 `data/heats/prediction_state.json`（469 名成年选手，含 40 名 CHN） | **严格只读复用**：青年池独立实例化新的 `DynamicRatingEngine`；严禁向 `data/heats/` 或 `prediction_state.json` 回写任何青年/国内记录 |

---

## 2. ISU 官网青年组 API、选手出生日期与官方榜单实测

### 2.1 青年赛事接口实测（2024/25 – 2026/27）

调用 `POST https://front-api.isu.org/events/list`（`discipline_id=3, state="Finished", event_level="ISU"`），在近三个赛季共稳定检出 **9 站**已完赛 ISU 青年赛事：

| 赛季 | `event_id` | 赛事名称 | 城市 | 日期 | `slug` |
|---|---|---|---|---|---|
| 2024/25 | `1900` | ISU Junior World Cup Short Track Speed Skating (#1) | Bormio (ITA) | 2024-11-08 ~ 11-10 | `isu-junior-world-cup-short-track-speed-skating-3` |
| 2024/25 | `1870` | ISU Junior World Cup Short Track Speed Skating (#2) | Bormio (ITA) | 2024-11-14 ~ 11-16 | `isu-junior-world-cup-short-track-speed-skating-2` |
| 2024/25 | `1562` | ISU Junior World Cup Short Track Speed Skating (#3) | Quebec (CAN) | 2025-02-21 ~ 02-23 | `isu-junior-world-cup-short-track-speed-skating` |
| 2024/25 | `1548` | ISU World Junior Short Track Speed Skating Championships | Calgary (CAN) | 2025-02-27 ~ 03-02 | `isu-world-junior-short-track-speed-skating-championships` |
| 2025/26 | `71` | ISU Short Track Junior World Cup #1 | Astana (KAZ) | 2025-11-07 ~ 11-09 | `isu-junior-world-cup-short-track-speed-skating-6` |
| 2025/26 | `57` | ISU Short Track Junior World Cup #2 | Astana (KAZ) | 2025-11-13 ~ 11-15 | `isu-junior-world-cup-short-track-speed-skating-5` |
| 2025/26 | `15` | ISU Short Track Junior World Championships | Salt Lake City (USA) | 2026-01-29 ~ 02-01 | `isu-world-junior-short-track-speed-skating-championships-2` |
| 2026/27 | `16223` | ISU Short Track Junior World Cup #1 | Bormio (ITA) | 2026-11-06 ~ 11-08 | `isu-short-track-junior-world-cup-1` |
| 2026/27 | `16244` | ISU Short Track Junior World Cup #2 | Bormio (ITA) | 2026-11-12 ~ 11-14 | `isu-short-track-junior-world-cup-2` |

对样本站 `16223`（2026/27 JWC #1 Bormio）的实测结论：
1. 赛事页 `https://www.isu-skating.com/en/short-track/events/eventdetail/{slug}/?tab=results_{event_id}` 内嵌完整 `eventResultsData`（11 个小项，含 `Men/Women 1000 m (1)/(2)` 重复距离与 `Men/Women 3000 m Relay`、`Mixed Team Relay`）。
2. `get-event-result-fsk-single`（距离终榜）、`get-event-result-round`（轮次列表）与 `get-event-result-round-heats-stk-single` / `-team`（逐组与接力上场队员）均返回 200 且字段结构与成年组一致（含 `lap`、`final_rank`、`final_result`、`starting_position`、`skaters.id`、`skaters.slug`）。
3. **出生日期（DOB）来源实测**：`front-api.isu.org` 的 `skaters` 子对象不含出生日期，但官网选手主页 `https://www.isu-skating.com/en/short-track/skaters/{slug}/` 返回明确 `YYYY-MM-DD` 官方出生日期（如实测 `yuheng-li-1` -> `2008-06-19`，准确落入 `DUAL_ELIGIBLE` 区间 `2007-07-01..2009-06-30`）。

### 2.2 2026/27 官方积分与世界排名目录实测（`season_id=47`）

`get-world-standings-list` 返回全部 32 张官方表：
- 成年世巡赛单项 `WCD`：`4266 / 4283 / 4267`（男 500/1000/1500m）、`4285 / 4268 / 4286`（女 500/1000/1500m）
- 成年世巡赛接力 `WCD`：`4284`（男 5000m）、`4269`（女 3000m）、`4270`（混接 2000m）—— 直接驱动 2027 世锦赛接力前 12 名核算
- 成年世界排名 `WRD`：`4220..4222`（男单项）、`4224..4226`（女单项）、`4223 / 4227 / 4228`（接力）—— 直接驱动世巡赛“单距离 Top 40 占 ≥ 3 人报 4 人”特例判定
- 成年个人/团队水晶球：`4263 / 4264`（`WCO`）、`4265`（`WCT`）、`4229 / 4230`（`WRO`）
- 青年世界杯 `WCD`：`4422 / 4407 / 4408 / 4487`（男）、`4423 / 4409 / 4410 / 4424`（女）、`4411`（混接）

### 2.3 Comm. 2805 原始 PDF 坐标校对关键发现

对官方 `Comm. 2805` PDF 第 5 页（2027 世锦赛个人单项名额三栏表）执行 `(x, y)` 坐标对齐解析，并交叉核对 `2026 蒙特利尔世锦赛` 官方 Protocol（`.cache/isu/1_worlds.pdf` C81 距离终榜）后，**修正并锁定中国男队 2027 世锦赛个人席位**：

| 性别 | 500m | 1000m | 1500m | 2026 蒙特利尔世锦赛 C81 实证 |
|---|---|---|---|---|
| **中国女队（CHN Women）** | **3 席** | **3 席** | **2 席** | W500: 王晔 14、张楚桐 8、王欣然 12（3 人前 16）；W1000: 张楚桐 6、公俐 8（2 人前 16）；W1500: 杨婧茹 9、公俐 21（1 人前 16、2 人前 32） |
| **中国男队（CHN Men）** | **3 席** | **2 席** | **2 席** | M500: 张柏浩 14、李坤 16（**2 人前 16 → 3 席**）；M1000: 李坤 16、张柏浩 20（仅 1 人前 16 → **2 席**）；M1500: 张柏浩 11、宋桂旭 33（仅 1 人前 32 → **2 席**） |

> 该核验解决了规划文档中标注的“Comm. 2805 PDF 无竖线三栏文本解析列位错移风险”，确保配置文件与官方 PDF 100% 一致。

---

## 3. 运行环境、依赖适配与存储边界

| 维度 | 当前运行环境实测 | 工程落地方案（零原生 C 依赖冲突） |
|---|---|---|
| **Python 依赖** | Python `3.12.3`；已装 `PyYAML 6.0.1`、`pypdf 7.1.1`、`beautifulsoup4 4.15.0`；无系统 `pip`/`venv`，未装 `scipy`/`numpy`/`pandas`/`pyarrow`/`pdfplumber`/`fitz` | - 规则引擎与爬虫使用纯 Python + `PyYAML` + `pypdf`<br>- 国内甲组 PDF 解析器采用 `pypdf` 坐标级 `visitor_text(x, y)` 聚行分列解析（不依赖 OCR，不硬编码字符列宽，按表头坐标动态定位六列） |
| **数据存储格式** | 仓库全部持久化数据采用 UTF-8 JSON（便于 Git diff 与 Worker/Node 直接读取） | 独立落盘至 `data/quota_roster/`（`junior/`、`domestic_recent_results.json`、`quotas_2026_27.json`、`chn_roster_forecast.json`），不引入二进制 Parquet，且与 `data/heats/` 彻底隔离 |
| **Node.js 与 MILP 求解** | Node.js `v22.23.4`（现有 `src/prediction/*.mjs` 运行时） | 三池融合校准（Phase 3）与 0-1 MILP + 1,000 次蒙特卡洛 + 6 人替补（Phase 4）在 `src/quota-roster/` 下以纯 ESM 实现：利用问题结构（每性别 `N_max <= 6, K_d <= 4, sum(r) = 4`，状态空间最多 `7×5×5×5×5 = 4,375`）构造**精确动态规划 0-1 MILP 求解器**，数学上严格等价于 `scipy.optimize.milp` 全局最优解，单性别 1,000 次求解实测预计 `< 0.5 s` |
| **中国选手映射表初始状态** | `data/athlete_names_zh.json` 仅含 13 名 2026/27 世巡赛现役选手；`data/heats/athletes.json` 含 40 名近 4 季成年 CHN 选手；`data/history/athletes.json` 含历史 CHN 选手 | 新建 `config/chn_name_mapping.yaml`，以 `姓名 + 代表单位` 为复合主键，初始化覆盖全部成年/青年 CHN 选手与 `official_skater_id` / `birth_date` / `aliases`，解析国内 PDF 遇到未映射姓名或冲突时强制输出告警并分配 `dom-tmp-*`，严禁静默丢弃 |
| **国内样例 PDF 现状** | 当前工作区尚无用户放入的真实国内甲组比赛 PDF（`data/raw/domestic_pdf/` 待放入） | Phase 2 提供完备的 CLI（`tools/parse_domestic_pdf.py`）、CSV 覆盖导入及合成中文甲组 PDF 端到端单测（覆盖表头正则、单站 0.85 等比 vs 多站累计判定、并列名次保留、重名消歧告警）；待用户放入真实国内 PDF 后即可一键增量入库 |
