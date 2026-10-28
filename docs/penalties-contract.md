# 2026/27 世巡赛累计判罚：数据契约

本赛季的累计判罚以各站 ISU 官方完整 Protocol 的 **WORLD TOUR PENALTIES / C98P** 表为准；逐轮判罚代码取同一 Protocol 的 **INFRINGEMENT REPORT / C89I2**。不能把网页接口中所有 `PEN` 直接当作累计次数。

温哥华站（2026-10-23 至 10-25）核验基线：

- 官方 Protocol：<https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf>
- 第 124–125 页：35 名运动员、39 次有效累计判罚。
- 第 126–127 页：44 次 PEN，其中 2 次接力、3 次 `OFF` 不计入累计。
- 官方备注列出的不计入代码：`ST6`、`EQP`、`EMB`、`OFF`、`SR`。**`S6` 不等于 `ST6`**。
- 采用同站 `gender + country + helmet_number` 关联 PDF 两类表，再按项目与轮次对照已经验证的官方逐轮成绩；不得只用英文姓名相等关联。

自动同步：`tools/sync_competitions.py` 更新官方成绩后，`tools/sync_penalties.py` 验证 PDF 并将接受的站点快照保存到 `data/penalties/<station>.json`，同时在 `data/competitions/<station>.json` 中填充 `infringement_code`。解析/匹配/统计失败不发布猜测的数据，保留上次已核验结果；整站快照与文件源留有 URL、SHA-256 和 PDF 页码。

构建器生成 `dist/data/penalties/index.json` 和分站累计快照。前端在运动员页面展示官方累计数据，在赛果列表显示原始裁判代码。下一站限制只标注跨越 3/5/7 阈值时的个人单项**限报项数**；不能据此推断具体距离，也不能重复触发同一个阈值。没有官方确认的数据不填 0。

验证：`python -m unittest tests.test_penalty_protocol -v`、`bash tools/ci_run.sh build`、`bash tools/ci_run.sh test`，以及完整官方温哥华 Protocol 的一次性核验工作流记录（最终删除临时工作流）。
