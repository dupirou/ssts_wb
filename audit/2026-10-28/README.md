# SSTS-WB 成绩审计（进行中）

- 基线：`dupirou/ssts_wb` `main` @ `dd5adb67c0a71580c2cb70af4bced684cb9c6f5b`；核验时间 2026-10-28（本地时间）。本分支只含审计材料，未修改产品文件，未部署或合并。
- **结论：尚不满足全量逐条官方复核和跨页面验收。** 本报告保留明确缺口；统计数字按所述字段而非完整记录计算。
- [资产与覆盖](data-audit.md) · [历史专项](history-audit.md) · [当季专项](season-audit.md) · [页面专项](page-audit.md) · [修复路线图](repair-roadmap.md)
- [结构化差异](findings.json) · [每场复核矩阵](history_verified_matrix.csv) · [完整资产矩阵](history_event_matrix.csv) · [逐行 API 对账](history_record_checks.jsonl) · [逐行 PDF 对账](history_pdf_checks.jsonl) · [投影矩阵](projection_event_matrix.csv)
- [Node 测试日志](node-tests.log) · [Python 测试日志](python-tests.log)；测试结果和官方对账分开解释。

已确认 8 条实际出赛但整项起跑数被漏算，1 条温哥华中国队混合接力遗漏；另有 33 条 A 决赛组内排名与当前总排名不一致，不能自动判断是否为官方更正或解析错误。源头未给出可证明修订先后的版本资料；保留两种证据，不能仅凭接口“当前”断言其为经过证实的最新正式裁定。

审计工具只写本目录；原始 API 响应及下载到的 PDF 保存于此工作区旁 `ssts-audit-evidence-20261028/`，不包含在 Git 提交中。仓库材料保留 URL、请求参数、响应哈希和部分 PDF 页码；克隆后的读者无法仅靠本分支获得这些外部原文，应重新抓取并核验哈希。ISU 归档 PDF 仅从网页索引读取到内容，未下载到可保存的 PDF 原件。
