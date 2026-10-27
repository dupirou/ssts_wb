# SSTS-WB · 短道速滑赛程

非官方的 2026/27 ISU 短道速滑世巡赛与世锦赛赛程站：北京时间换算、官方报名与分组、中国队场次高亮、首轮分组预测。线上地址 https://stss.fusu.uk ，可安装为手机主屏幕应用。

## 页面入口

- `/`：当前或下一场赛事与售票信息
- `/events/`：完整赛季赛历
- `/events/2026-27/vancouver/`：分站详情（原 `/?station=vancouver` 等链接继续可用）
- `/results/`：中国队成绩总览、赛事成绩、周期／赛季档案与对比；原 `/history/` 入口继续可用
- `/athletes/`：运动员目录与已公布的本赛季世巡赛单项排名

历史成绩截至 2026-10-27：官方目录 76 场均已建档，74 场有中国队成绩，共 1,726 条。只统计个人 500 / 1000 / 1500 米及接力；全能和个人超级 3000 不计，缺接力阵容不影响团队成绩。整项缺失已补齐，剩余名次问题和逐季数量见 [历史成绩说明](docs/history.md)。

## 怎么运转

```
ISU 官网 / front-api.isu.org
        │  GitHub Actions：sync.yml（比赛时段每 10 分钟，由 Cloudflare Cron 触发；另有每天两次兜底）
        ▼
data/  ← 只写入通过核对的官方数据（赛程、报名、分组、成绩、单项报项）
        │  tools/build.py：校验、换算时间、估算中国队出场、生成新动态
        ▼
dist/  ← 静态页面与 JSON，随数据一起提交到 main
        │  Cloudflare Workers Builds 自动部署
        ▼
Worker stsswb：静态文件 + 只读 /api/v1（src/worker.mjs）
```

没有数据库和后台服务；同步失败时保留上次的可信数据，并在接口里标记 `stale`。

## 目录

| 路径 | 内容 |
|---|---|
| `data/stations.json` | 唯一的分站配置：日期、时区、场馆、ISU 赛事页 |
| `data/schedules/` `data/competitions/` | 已核对的官方赛程、报名、分组与成绩 |
| `data/history/` | 中国队历史赛事索引、固定运动员身份与官方最终成绩 |
| `data/prediction_inputs/` | 单项报项与上赛季单项排名（预测和运动员报项用） |
| `data/china*.json` | 中国队分组证据（自动导入与人工覆盖） |
| `data/updates.json` | 已通知过的“新动态” |
| `tools/` | 同步脚本（`sync_*.py`）、构建（`build.py`）、预测、图标渲染 |
| `web/` | 前端源文件；`dist/` 为构建产物，不要手改 |
| `tools/site_catalog.py` | 从快照生成赛果摘要、运动员索引与本赛季世巡赛排名 |
| `src/worker.mjs` | Cloudflare Worker：API 与比赛时段定时触发 |
| `tests/` | Python 与 Node 测试 |
| `docs/` | 详细说明（见下） |

## 本地运行

```sh
python -m pip install -r requirements.txt   # Python 3.11+
python tools/build.py
python -m http.server 8000 --directory dist  # 打开 http://127.0.0.1:8000（只有静态页面）
npx wrangler@4.151.2 dev --local            # 含 /api：运动员、分组、成绩与预测
python -m unittest discover -s tests
npm ci --ignore-scripts && node --test tests/*.mjs
ruff format tools tests && ruff check tools tests   # Python 格式与检查（pyproject.toml）
```

同步脚本需要能访问 ISU 官网，一般只在 Actions 里运行；单站检查可用 `python tools/sync_schedule.py --station montreal`。

## 文档

- [docs/backend.md](docs/backend.md)：数据同步、接口、预测、新动态、安全边界
- [docs/architecture.md](docs/architecture.md)：页面架构、赛季／周期回顾、对比形式与实施顺序
- [docs/history.md](docs/history.md)：中国队历史成绩收录、导入与覆盖范围
- [docs/frontend.md](docs/frontend.md)：页面结构、视觉规则、文案约定
- [docs/deploy.md](docs/deploy.md)：Cloudflare 部署与比赛时段定时同步
- [docs/isu-seeding-2026-27.md](docs/isu-seeding-2026-27.md)：直通、种子与分组规则（含官方条款出处）
- [docs/log.md](docs/log.md)：工作日志与核查记录
