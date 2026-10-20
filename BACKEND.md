# ISU 数据同步与中国队自动高亮

## 模块职责

| 文件 | 职责 |
|---|---|
| `tools/sync_schedule.py` | 核对温哥华站 62 个官方轮次时间，完整且一致才接受变化 |
| `tools/sync_china.py` | 从 ISU 官方结果索引发现 2026 Vancouver，依次读取项目、轮次、Heat |
| `data/china_sources.json` | 自动发现失败时可指定经过核验的 ISU 单站结果主页 |
| `data/china_auto.json` | 自动导入的已核验中国队小组证据 |
| `data/china.json` | 人工核查后的备选/覆盖记录（优先级高） |
| `tools/build.py` | 验证所有证据、关联赛程、估算非官方小组时间，生成 dist/data/vancouver.json |
| `.github/workflows/sync.yml` | 每30分钟尝试同步，只有内容改变才重新部署 |

## 当前数据状态（2026-10-20）

ISU 官网已经公布温哥华站**轮次**时间；ISU 2026 年温哥华站的**逐组结果/Start List** 尚未出现在当前可读取的官方结果索引中。本项目的自动分组抓取会安全地跳过空源。此时 `china_auto.json` 为空，前端不显示 CHN 高亮。不能按报名项目推断选手参加所有轮次。

自动发现算法：官方结果索引 → 2026 Vancouver 结果赛事首页 → 各距离/接力项目页 → Preliminaries / Heats / Rep. / Quarterfinals / Semifinals / Finals → 官方 Heat 数据中 CHN 国别 → 稳定 `round_key`。

若赛事开始后官方尚未将结果添加到索引，可以将官方赛事**结果页面**（不是赛事宣传页）填进 `data/china_sources.json` 的 `event_results_url`，后续由定时任务自动更新；但地址必须能够明确验证属于 **2026 温哥华站**。也可以本地运行：

`python tools/sync_china.py --event-url https://www.isu-skating.com/en/short-track/results/实际结果赛事链接/ --dry-run`

上面的 URL 仅表示格式，不能照抄为实际地址。

## 安全边界

- 不接收第三方转载作为自动确认，只有 ISU 官方域名下的具体赛事/轮次数据才生效。
- 每条记录包含赛事轮次 `round_key`、Heat 序号、CHN 选手/接力队、官方原始 URL 和核验时间。
- 不会把 HKG、TPE 当作 CHN。
- A/B 组决赛须能在原始内容中明确识别 Final A 或 Final B；否则**不自动猜测**。
- 不能根据上一轮晋级结果直接高亮下一轮：必须在下一轮名单/结果中再次确认。
- 官网超时、尚未发布或解析结构改变，不删除已有已核验数据。
- `CHN` 高亮与单组**估算时间**是两层数据，模型估算只决定时间范围，不决定出场资格。
- 样例与单元测试中的运动员姓名仅为合成测试数据，不能发布到生产 JSON。

## GitHub Actions

推送和手动触发的工作流会执行：
1. 官网赛程核对，失败则不更新赛程 CSV。
2. 中国队小组核对，未公布则无修改；解析异常时记录失败而保留上一版。
3. 本地数据构建、Python 单测、JS 语法检测。
4. 有内容变化才提交 `dist/` 与已确认的数据文件到 main，Cloudflare Workers/Pages GitHub 集成随后部署。

需要关注 [GitHub Actions](https://github.com/dupirou/ssts_wb/actions) 的日志，不要将“Actions 成功执行”理解为“官网已公布全部分组”。

前端不需要免责声明横幅；必须继续区分时间的**官方轮次开始**与**单组预计**。原始来源可在赛程卡上以简洁链接提供。

官方来源：
- [ISU 温哥华站赛程](https://www.isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230)
- [ISU 短道赛果索引](https://www.isu-skating.com/en/short-track/results/)
