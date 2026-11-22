# 2026-27 名额与阵容预测系统 — V1 (三池校准 + 0-1 MILP + 1000次蒙特卡洛) 存档

本目录归档了 `feat/quota-roster-system` 分支在简化重构前的 V1 完整运筹与蒙特卡洛实现（同时保存在 Git 分支 `archive/quota-roster-milp-v1` 中，对应提交 `e446e4b`）。

## 归档文件清单

- `fusion.mjs`：三池（成年组世巡赛、青年世界杯双路径校准、国内甲组锚点回归）逆方差加权（IVW）融合管线。
- `optimizer.mjs`：对标国际强手池的 Plackett-Luce 奖牌/A组决赛期望值（LUT）、五维资源格点 0-1 动态规划 MILP 求解器、1000 次高斯蒙特卡洛阵容抽样与基于反事实 MILP 边际替代损失（`marginal_loss`）的 6 人替补选择器。
- `build_quota_roster.mjs`：V1 预测 JSON 构建与 2024/25–2025/26 两赛季 `lambda_fatigue` 网格回测脚本。
- `roster.js`：V1 前端视图（含单项报项概率矩阵、`μ ± σ`、状态动量、Top-3 最高频阵容方案及替补边际替代损失）。
- `quota_roster_backtest.md`：V1 历史回测与兼项灵敏度报告。

## 重构原因

V1 引入过多超参数（`lambda_relay`、`lambda_form`、`lambda_fatigue`、`lambda_top40_protect`、`uncertainty_risk_aversion`）与大方差蒙特卡洛抽样，导致组合空间发散且前端指标晦涩。V2 回归核心需求：确定性核算「世界排名与名额临界关系」，并基于实际出勤、世界排名保席任务与国内/青杯选拔实绩，透明划分「稳固主力」「轮换/缩编淘汰边缘」与「专项替补顺位」。
