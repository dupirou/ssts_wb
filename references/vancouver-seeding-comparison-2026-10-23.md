# 温哥华三张种子分析截图与原预测的对比

本次按用户提供的三张 C48A `SEEDING ANALYSIS` 截图逐项录入；均为第 1/2 页。录入范围仅限图片可见小组，未补造第 2 页、直通者或道次。

比较基准是录入前 main 的 `e24103a`：2026-10-23 00:01:42 UTC 的报项及世界排名快照。该版本已改为只排列有世界排名者，无排名者单列为待报名成绩确定。它与更早使用固定哈希暂估无排名队尾的模型不同。

## 结论

**三张图中，所有 64 位有世界排名者，其 World Rank 和预测组号均与原预测一致；另外 67 位无世界排名者原来没有分配组号，本次取得实际分组，不能把他们计为预测命中或错误。**

| 男子项目 | 可见组 | 可见人数 | World Rank 一致 | 有排名者组号一致 | 原先未排组者 |
|---|---|---:|---:|---:|---:|
| 500m Preliminaries | P1–P9 | 44 | 24/24 | 24/24 | 20 |
| 1000m Preliminaries | P1–P9 | 45 | 21/21 | 21/21 | 24 |
| 1500m Heats | H1–H6 | 42 | 19/19 | 19/19 | 23 |
| 合计 | 24 组 | 131 | 64/64 | 64/64 | 67 |

131 条记录均能匹配此前报项中的选手 ID；没有发现截图可见选手不在此前报项的情况。图片缺页，因此不能由未出现的姓名判断退赛或直通，也不能由本页组数推断完整首轮组数。原模型分别为 10、10、7 组，本次仍仅录入看到的 9、9、6 组。

## 截图可见的中国队分组

| 项目 | 选手 | 组别 | Assigned Rank | 原预测 |
|---|---|---|---:|---|
| 500m | LI Kun | P6 | 1010 | 无世界排名，未排组 |
| 500m | ZHANG Bohao | P9 | 1006 | 无世界排名，未排组 |
| 1000m | ZHU Yiding | P1 | 1018 | 无世界排名，未排组 |
| 1000m | SONG Kerui | P3 | 1015 | 无世界排名，未排组 |
| 1000m | LI Kun | P5 | 1013 | 无世界排名，未排组 |
| 1500m | ZHANG Zixia | H4 | 1002 | 无世界排名，未排组 |
| 1500m | SONG Kerui | H5 | 1023 | 无世界排名，未排组 |

Assigned Rank 为报表列出的官方分配排名，按原值保存，**不是报名时间，也不是出发位**。这三张图片不能用来验证世界排名缺失者的报名成绩或全部直通资格。三张图中未出现的中国选手不作额外推断。

## 原图与复核文件

- [男子 500m 原图](../web/sources/vancouver-men-500-seeding-page1.jpg)，打印时间 2026-10-22 11:52 Vancouver。
- [男子 1000m 原图](../web/sources/vancouver-men-1000-seeding-page1.jpg)，打印时间 2026-10-22 11:54 Vancouver。
- [男子 1500m 原图](../web/sources/vancouver-men-1500-seeding-page1.jpg)，打印时间 2026-10-22 10:31 Vancouver。
- [手工转录](../data/reviewed_groups/vancouver.json)：图像 SHA-256、打印时间、页码、头盔号、姓名、ISU Member、World Rank、Assigned Rank 和原选手 ID。
- [原预测快照](../data/reviewed_groups/vancouver_prediction_baseline.json)、[逐人比较结果](../data/reviewed_groups/vancouver_comparison.json)。
- 重算：`python tools/compare_reviewed_groups.py`。

姓名保留截图拼写；身份匹配有两处明确别名：截图 `DEMIRKHAN Aibek` 对应原报项 `Aibek TEMIRKHAN`，截图 `RIVERO MAERSCHALCK Alejandro` 对应原报项 `Aleyandro RIVERO MAERSCHALCK`。未将拼写差异当成新增运动员。

发布时将截图分组补充到静态接口和赛程弹窗，注明仅第 1 页，并链接实际原图。定时同步仍写原 API 快照，避免覆盖手工资料；一旦同轮次有官网 API 分组或成绩，整轮优先采用 API，移除对应截图补充。
