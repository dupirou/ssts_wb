# 温哥华接力官方分类核对

核对日期：2026-10-28。来源为 ISU / Swiss Timing 官方温哥华成绩册，SHA-256 `f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9`：[PDF](https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf)。

独立单站最终分类确实存在：各页标题为 `EVENT CLASSIFICATION`，表格为 `C74B 1.0`。女子 3000 米接力第 91 页中国队总体第 5，男子 5000 米接力第 97 页中国队总体第 3，混合 2000 米接力第 105 页中国队总体第 11。后者四分之一决赛 QF 栏为第 3，对应四位队员的该轮 X；第 11 是该表 Rank 列独立给出的最终名次，不由世巡赛累计榜或组内名次推算。

第一轮报告需要澄清：快照中第 11 名是 `world_tour`，不能将其作为 `event` 分类。第一轮对总第 11 的结论能由上述官方 C74B 原表独立支持，但未明确说明快照缺少该分类是解析缺口。其他两项也不能将 Final B 第 1 和 Final A 第 3 的组内结果直接当成总分类。采集解析器当前只识别包含 Name 和 ISU 的表头，C74B 使用 Team 表头，需扩展解析和投影，且保持原来源与组别区别。

官方来源与当前快照获取时间不构成官方修订时间。应保留页码、哈希和版本信息；不能以榜单相同推测等价。
