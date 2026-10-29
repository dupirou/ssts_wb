# 2026/27 当季：温哥华站

官方 [127 页成绩册](https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf) SHA-256 `f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9`。赛事官方指南列九个项目。本次从官方 API 独立取回 52 个轮次、215 个组，现存 1,109 个参赛行的国家、号码、位置、组内名次、结果、晋级标记六个字段可匹配；发现的组号均能对应官方。此结果不证明所有官方运动员反向全覆盖，也不覆盖所有身份、特殊状态、阵容和修订字段。[逐行结果](vancouver_heat_checks.jsonl)、[轮次](vancouver_round_coverage.json)。

官方 C74 中 359 条个人赛数值最终名次与仓库对应值一致：[逐条结果](vancouver_all_individual_rank_checks.json)。另按中国队核查 3 项接力：两项仓库只保存决赛组内名次，不能当总名次；混合接力缺失。其他国家接力最终分类和完整出赛、报名、世巡赛积分及赛季排名尚未完整核验。

## D02/U01 中国混合接力遗漏

[官方成绩册第 105 页](https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf#page=105)显示中国队总排名 11，四分之一决赛第 4 组第 3，2:51.826。原始温哥华快照含该轮次；真实浏览器赛事详情显示该记录，而成绩档案缺失，对比页显示“未收录”。首次丢失位于 `tools/history_data.py:414-458`：接力仅从决赛组投影，个人排名过滤不补回接力。记录缺失会使相关档案和对比不完整；不可虚构接力成员。

## 判罚

官方 C98P / C89I2 的 35 项累计及 44 项逐项判罚代码与快照对应值一致，见 [证据](vancouver_penalty_checks.json)；仅限已列字段，不等于完整验证所有排除项、限制距离和后续停赛。ISU [2026/27 世巡规则第 7 页](https://www.skoyteforbundet.no/siteassets/kortbane/lover-og-regler/2806-isu-short-track-world-tour-2026-27.pdf)列阈值 3/5/7 并排除接力和世锦赛；对最高排名引用的具体榜单及未明情形不作推断，禁赛项目和页面派生限制未完整验收。世巡排名 C98A 见官方成绩册第 111–121 页，本轮尚未逐项对账。
