# 2026/27 世巡赛累计判罚：数据契约

本赛季的累计判罚以各站 ISU 官方完整 Protocol 的 **WORLD TOUR PENALTIES / C98P** 表为准；逐轮判罚代码取同一 Protocol 的 **INFRINGEMENT REPORT / C89I2**。不能把网页接口中所有 `PEN` 直接当作累计次数。

温哥华站（2026-10-23 至 10-25）核验基线：

- 官方 Protocol：<https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf>
- 第 124–125 页：35 名运动员、39 次有效累计判罚。
- 第 126–127 页：44 次 PEN，其中 2 次接力、3 次 `OFF` 不计入累计。
- 官方备注列出的不计入代码：`ST6`、`EQP`、`EMB`、`OFF`、`SR`。**`S6` 不等于 `ST6`**。
- 采用同站 `gender + country + helmet_number` 关联 PDF 两类表，再按项目与轮次对照已经验证的官方逐轮成绩；不得只用英文姓名相等关联。

自动同步：`tools/sync_competitions.py` 更新官方成绩后，`tools/sync_penalties.py` 验证 PDF 并将接受的站点快照保存到 `data/penalties/<station>.json`，同时在 `data/competitions/<station>.json` 中填充 `infringement_code`。解析/匹配/统计失败不发布猜测的数据，保留上次已核验结果；整站快照与文件源留有 URL、SHA-256 和 PDF 页码。

构建器生成 `dist/data/penalties/index.json` 和分站累计快照。前端在运动员页面展示官方累计数据，在赛果列表显示原始裁判代码。没有官方确认的数据不填 0。

**下一站禁赛距离（ISU Communication 2806 §8）**：累计首次达到 3 次时，下一站禁报排名最高的一个个人距离；达到 5 次时禁报排名最高的两个个人距离；达到 7 次时禁报全部三个个人距离（500m、1000m、1500m）。仅对触发门槛后的**下一站世巡赛**有效，不能每站重复处罚。接力犯规不累计、锦标赛不参与。本条依据：[ISU 2806，PDF 第 7 页](https://www.skoyteforbundet.no/siteassets/kortbane/lover-og-regler/2806-isu-short-track-world-tour-2026-27.pdf)。

`next_restriction` 保留 `event_id` 和 `blocked_individual_distances`，新增 `distances_m`（确定时为具体禁赛距离数组；有禁赛但无法确证时为 `null`；无新限制时为 `[]`）、`ranking_source_url`、`ranking_event_id`。对 3／5 次禁赛，根据最新已核验站次的 ISU `world_tour` 个人距离排名按名次升序选取；仅在官方排名可用、所需项目均有排名且分界处不存在并列时，发布具体距离。**不能用判罚发生在哪个项目代替排名，也不能按 500/1000/1500 固定顺序推断。** 7 次则明确全部个人距离。缺排名或排名并列时，仅显示禁报最高排名的 1／2 项，不猜测距离。

注意：第 2806 号通讯只写了 “highest rank”，未进一步明示排名榜单口径。当前具体距离的机器判定依据已核验的 ISU World Tour Distance Classification，带官方来源供复核；若 ISU 对排名基准另有正式解释，应据此修正计算，不把自动解析结果冒充单独的官方停赛裁定。

验证：`python -m unittest tests.test_penalty_protocol -v`、`bash tools/ci_run.sh build`、`bash tools/ci_run.sh test`，以及完整官方温哥华 Protocol 的一次性核验工作流记录（最终删除临时工作流）。
