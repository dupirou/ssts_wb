# 人工维护清单

自动同步只处理 ISU 官网公布的赛程、报名、分组、成绩和排名。下面这些内容没有可靠的官方接口，需要手工改文件并通过 PR 合并；合并后 `sync.yml` 会重新构建并发布。

## 每站开赛前

| 事项 | 文件 | 说明 |
|---|---|---|
| 场馆 | `data/stations.json` 的 `venue` | 留空时开赛前显示“场馆待公布”，结束后不显示 |
| 售票信息 | `data/tickets.json` | 开售时间带当地 UTC 偏移；订票域名须在 `tools/build.py` 的 `BOOKING_SITES` 白名单里 |
| 中国队中文名 | `data/athlete_names_zh.json` | 键为全站统一写法“名 姓（姓大写）”，如 `Long SUN`；新队员首次报名后补一行，未列出的队员显示 ISU 拼写 |
| 单项报项与分组预测 | `data/competition_sources.json` 的 `prediction` | 只有配置了的分站才显示每人所报单项和首轮预测；第 3 站起直通规则不同，见 [isu-seeding-2026-27.md](isu-seeding-2026-27.md) |

比赛日如官方临场调整时间，用 `python tools/check_live_schedule.py --station <id>` 对照后手工更正，见 [backend.md](backend.md)。

## 换赛季

1. `data/stations.json`：赛季、各站城市、日期、时区；`isu` 可留空，赛程同步会按城市和日期在 ISU 赛事列表里找到并写回。世锦赛写在 `championships`。
2. `data/tickets.json`、`data/athlete_names_zh.json`：清掉过期售票信息，补新队员。
3. `data/competition_sources.json`：删除上赛季的 `prediction` 配置。
4. `tools/localize.py` 的 `TEAMS`：出现新的国家或地区代码时补中文队名，未列出的接力队显示 ISU 原文。
5. `docs/isu-seeding-<赛季>.md`：按新赛季通告核对直通与分组规则。
6. 上赛季成绩并入历史档案：见 [history.md](history.md)。

## 运行与密钥

| 事项 | 位置 | 说明 |
|---|---|---|
| 触发同步的 GitHub 令牌 | Cloudflare Worker Secret `GITHUB_DISPATCH_TOKEN` | 2027 年 4 月到期；过期后比赛时段同步退回每天两次且无提示 |
| 同步心跳 | GitHub `SYNC_HEARTBEAT_SECRET`、`SYNC_HEARTBEAT_URL`；Worker `HEARTBEAT_SECRET`、`SYNC_HEALTH_KV` | 未配置时 API 以快照核对时间判断是否过期 |
| 同步失败告警 | 自动 | 连续三次运行失败（任何触发方式、任何步骤）会开一个 Issue，恢复后自动关闭 |

## 测试与线上数据

同步工作流在发布前运行全部测试，测试失败就不发布。断言不要写死“某一站此刻的状态”（未公布、人数、名次），用夹具或从数据里动态取。
