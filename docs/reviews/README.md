# 审查记录索引

审查是特定时间的快照，现行行为以 [架构](../architecture.md)、[前端](../frontend.md)、[成绩契约](../results-contract.md) 和 [历史成绩](../history.md) 为准。

- [赛事对比与加载审查](event-comparison.md)：2026-10-28 的产品、架构、加载量和验证结果；附手机及桌面截图。
- PR #36 历史验收（2026-10-28）：成绩搜索、按需加载、响应式和离线测试。完整原始材料固定保存在合并前的 Git 版本中：[审计](https://github.com/dupirou/ssts_wb/blob/84038025de49a05f7e951293924f86d18aaaa536/docs/reviews/pr36-audit.md)、[最终验收](https://github.com/dupirou/ssts_wb/blob/84038025de49a05f7e951293924f86d18aaaa536/docs/reviews/pr36-final.md)、[上一轮报告和截图](https://github.com/dupirou/ssts_wb/tree/84038025de49a05f7e951293924f86d18aaaa536/docs/reviews/pr36)。旧报告的数量、性能测量和产品文案不代表当前状态。

当前浏览器验收命令为 `node tools/verify_results_ui.mjs`，需要安装 npm 依赖、Chromium 和中文字体；运行产物写入 `artifacts/ui/`，不会改写历史报告。
