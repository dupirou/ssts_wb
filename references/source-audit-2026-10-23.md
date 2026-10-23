# 蒙特利尔报名与温哥华分组来源核查

核查时间：2026-10-23，北京时间 10:43–10:47。此记录区分已取得的官方数据与尚未取得的原件，供后续接入和复核使用。

## 蒙特利尔报名：已自动入库并上线

- [ISU 本站 Documents 页面][montreal-documents]列出 Entries 文件。
- [官方 Entries PDF][montreal-pdf]标题为 `Entries_stwt2can22026_website.xlsx`。
- 当前仓库 [data/competitions/montreal.json](../data/competitions/montreal.json) 已保存 **197 人**，其中 **CHN 12 人**，男女各 6 人，均为 Active。
- 2026-10-23 再次从官网发现文件并执行现有解析程序，得到同一份名单，无抓取错误。[分支核验运行记录][entries-check]
- 浏览器确认[正式站蒙特利尔运动员页][montreal-live]已显示“报名名单 197 人 / CHN 12 人”和对应官方 PDF 入口。因此本次不重复写入相同名单，也不人为修改内容更新时间。

该 PDF 是整站报名，不能据此确定某位运动员报名了哪些单项。本站官网当前尚无 Entries 单项页面入口，单项报项仍应等待明确来源。

## 温哥华分组：截图已见，公开原件尚未取得

用户提供的两张图片均为赛事抬头 `ISU Short Track World Tour 2026/27 - Vancouver (CAN)`，报表标题 `SEEDING ANALYSIS`，分别为男子 500m、1000m Preliminaries。页脚分别标注 2026-10-22 11:52、11:54，且都为 **Page 1 of 2**。它们证明已有种子分组分析报表，但不能据不完整页面补齐其他组、直通名单或其他项目。

已检查的公开入口：

| 入口 | 核查结果 |
|---|---|
| [温哥华 ISU Results][vancouver-results] | 页面列出九个项目；男子 500m 详情显示 `No data available` |
| 官网使用的 `POST https://front-api.isu.org/events/get-event-result-round` | 对官网九个当前 `event_result_id` 分别请求，全部返回 `status: 200, data: []`；[接口核验运行记录][rounds-check] |
| [温哥华 ISU Documents][vancouver-documents] | 仅发现 Announcement 与 Entries，未发现上述 Seeding Analysis PDF |
| `https://www.shorttrack.swisstiming.com/` | 当前查询环境及 GitHub 核验运行均返回 403，未取得赛事索引 |
| `https://shorttrack.sportresult.com/` | GitHub 核验运行返回域名解析失败，浏览器访问也未取得内容 |

以上只是这些入口在核查时的状态，**不等于分组未公布**。截图显示已存在报表；仍需找到实际公开 PDF 或计时赛事详情页，才能核对其完整性和后续修订。

## 后续接入所需原件

取得完整官方链接后，应先核对城市、年份、距离、轮次及两页是否齐全，再解析报表里的组别、头盔号、姓名、ISU Member、World Rank 和 Assigned Rank。`Assigned Rank` 不是运动员滑出的时间，也不是出发道次；不能反推报名成绩。

当前 `tools/isu_results.py` 从官网 JSON 接口读取正式分组，`tools/sync_competitions.py` 的 PDF 报表适配仅覆盖排名，不支持 C48A Seeding Analysis。应取得原始 PDF 后按真实文本布局增加解析及回归样本，再接入既有同步流程。正式分组录入后应覆盖对应预测，并更新具体轮次的中国队高亮。

后续按用户要求，已录入三张截图可见的 24 组、131 条记录，并提供原图链接及“仅第 1 页”说明；不完整页面不作为整轮完整名单。逐人核对结论与复现方法见[分组对比](vancouver-seeding-comparison-2026-10-23.md)。公开 PDF 原件仍待定位，PR 暂不合并。

[montreal-documents]: https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-2-montreal/?tab=documents_16272
[montreal-pdf]: https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/ecf91af0c829137ee15c6a3ef30bc04fd36959e82037f19def6320cd934128f0.pdf
[montreal-live]: https://stss.fusu.uk/?station=montreal&view=athletes
[vancouver-results]: https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=results_16230
[vancouver-documents]: https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=documents_16230
[entries-check]: https://github.com/dupirou/ssts_wb/actions/runs/39891150218
[rounds-check]: https://github.com/dupirou/ssts_wb/actions/runs/39891321109
