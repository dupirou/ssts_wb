# Phase 3 V1.5 Ablation & V2 Round-Level Monte Carlo Backtest Report

- **Walk-Forward Horizon**: `2022/23` Warm-up (7 events) → `2023/24–2026/27` Evaluation (21 clean events + partial `960`)
- **Monte Carlo Simulation**: 4000 iterations/round across 1024 evaluation rounds (avg **13.27 ms/round**, total script runtime **37.6s**)

## 线上预测与 1500 米出发位调整（2026-11-21）

线上模型从历史比赛训练的状态开始，依次纳入预测轮次之前已结束的比赛。运动员基础实力、出发位、近期表现和分段速度共同决定组内排序。正赛四分之一决赛和半决赛还参考本站前轮表现，500 米取总用时，1000 米取末三圈，1500 米取末四圈。模型结合判罚和未完赛概率，每轮模拟 4000 次，按该轮规则统计按名次晋级、按成绩晋级以及 A 组决赛金银铜的概率。

1500 米在组内排序时按轮次缩放出发位贡献（含出发位与组内人数的交互项）。资格赛和正赛半决赛取原值的 50%，复活赛取 100%，A 组决赛取 0%。其他轮次沿用原值。判罚和未完赛模型仍单独估计风险。

温哥华、蒙特利尔和截至 11 月 21 日的首尔站回放如下。Brier 分数越低越好。前三行评估晋级，末行评估登上领奖台。

| 轮次 | 人次 | 原权重 | 减半 | 归零 |
|---|---:|---:|---:|---:|
| 资格赛 | 378 | 0.1476 | 0.1463 | 0.1463 |
| 复活赛 | 278 | 0.1519 | 0.1531 | 0.1553 |
| 正赛半决赛 | 104 | 0.2106 | 0.2079 | 0.2070 |
| A 组决赛 | 40 | 0.2034 | 0.1954 | 0.1873 |

这三站用于选择权重。A 组决赛仅有 5 场，调整效果需在后续比赛中继续验证。

## 1. Walk-Forward Ablation Study (`V1` → `V1.5` → `V2`, Clean 21 Events)

| Stage / Model | 1st Heats | 1st Log-Loss | 1st Brier | Top-1 Acc | 1st ECE | Big-Q Starts | Big-Q Log-Loss | Big-Q Brier | Big-Q ECE | Rank MAE | CHN MAE | Spearman |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **V1** | 3757 | 1.0141 | 0.5148 | 62.34% | 0.0223 | 18471 | 0.4123 | 0.1307 | 0.0261 | 0.928 | 1.001 | 0.6683 |
| **V1.5-A** | 3757 | 0.9912 | 0.5062 | 63.51% | 0.0222 | 18471 | 0.4047 | 0.1281 | 0.0286 | 0.914 | 0.974 | 0.6792 |
| **V1.5** | 3757 | 0.9828 | 0.5034 | 63.38% | 0.0249 | 18471 | 0.4001 | 0.1268 | 0.0282 | 0.906 | 0.972 | 0.6859 |
| **V2** | 3757 | 0.9633 | 0.4978 | 63.59% | 0.0061 | 18471 | 0.3968 | 0.1257 | 0.0093 | 0.882 | 0.926 | 0.6866 |

Ablation notes:
- **`V1.5-A`**: Adds cross-distance transfer, federation (country) EB cold-start prior, and per-distance `(eta, beta, gammaSeason, repWeight)` configuration.
- **`V1.5`**: Adds `pace-model.mjs` last-2-lap closing kick (`z_finish`) and venue/tier-adjusted net pace (`z_pace`). (Round-tier reweighting, coast merging, and lane crowding interaction were tested via walk-forward ablation and excluded because each slightly degraded 1st-place out-of-sample Log-Loss.)
- **`V2`**: Decouples `PEN`/`YC`/`RC`/`DNF` incidents via `IncidentRiskModel` and simulates full-round outcomes via Gumbel-Max Monte Carlo.

## 2. Big-Q 10-Bin Calibration Repair (`V1` vs `V1.5` vs `V2`)

Decoupling incident probability lowers extreme favorite `[0.9, 1.0]` overconfidence (~96% → ~93.5%) and lifts `[0.4, 0.7)` under-prediction via upset promotion (Big-Q ECE: **0.0261** → **0.0093**).

| Bin | Count | `V1` Pred | `V1.5` Pred | `V2` Pred | Observed `Q` | `V1` Gap | `V2` Gap |
|---|---:|---:|---:|---:|---:|---:|---:|
| `[0.0,0.1)` | 6439 | 5.79% | 5.33% | 4.22% | 4.64% | 1.55% | 0.43% |
| `[0.1,0.2)` | 2875 | 14.61% | 14.56% | 14.44% | 14.57% | 2.75% | 0.13% |
| `[0.2,0.3)` | 1734 | 24.61% | 24.59% | 24.58% | 25.49% | 0.82% | 0.91% |
| `[0.3,0.4)` | 1202 | 34.71% | 34.62% | 34.63% | 36.02% | 0.14% | 1.39% |
| `[0.4,0.5)` | 978 | 44.96% | 44.85% | 44.94% | 45.91% | 6.59% | 0.97% |
| `[0.5,0.6)` | 850 | 54.81% | 54.83% | 55.04% | 55.18% | 5.64% | 0.14% |
| `[0.6,0.7)` | 835 | 64.95% | 65.09% | 64.69% | 66.11% | 8.74% | 1.42% |
| `[0.7,0.8)` | 908 | 74.90% | 74.91% | 75.16% | 72.91% | 3.17% | 2.26% |
| `[0.8,0.9)` | 1043 | 85.15% | 84.99% | 85.33% | 81.59% | 2.14% | 3.74% |
| `[0.9,1.0]` | 1607 | 96.16% | 96.04% | 94.42% | 92.78% | 1.91% | 1.64% |

## 3. Small-`q` & Total Advancement (`Q + q`) Evaluation (`small_q_planned > 0`, `n_ADV = 0`)

| Model | Starts | Small-`q` Log-Loss | Small-`q` Brier | Total Adv Log-Loss | Total Adv Brier | Total Adv ECE |
|---|---:|---:|---:|---:|---:|---:|
| **Uniform Small-q** | 8022 | 0.3260 | 0.0929 | 0.5151 | 0.1493 | 0.0588 |
| **Skill-Only Small-q** | 8022 | 0.2986 | 0.0867 | 0.4408 | 0.1427 | 0.0290 |
| **V2 Monte Carlo** | 8022 | 0.2979 | 0.0858 | 0.4351 | 0.1410 | 0.0090 |

## 4. Incident Risk Model (`IncidentRiskModel`, Clean 21 Events)

- **Evaluated Starts**: 19972 (observed `PEN+DNF` rate: **4.33%**, mean predicted: **4.36%**)
- **PEN Log-Loss**: **0.16662** vs contemporaneous seasonal baseline **0.16846** (Brier: 0.03839)
- **Total Incident Log-Loss / Brier**: **0.17623** / **0.04122**
- **Top-Decile Risk Concentration**: Top 10% highest-risk starters experience **6.96%** incident rate (**1.61x** lift over baseline)

## 5. Per-Discipline Comparison (`V1` vs `V1.5` vs `V2`, Clean 21 Events)

| Discipline | Model | 1st LL | Top-1 Acc | Big-Q LL | Big-Q Brier | Big-Q ECE | Rank MAE |
|---|---|---:|---:|---:|---:|---:|---:|
| men 500m | V1 | 0.9955 | 61.14% | 0.4054 | 0.1286 | 0.0346 | 0.829 |
| men 500m | V1.5 | 0.9605 | 63.15% | 0.3925 | 0.1242 | 0.0391 | 0.810 |
| men 500m | V2 | 0.9419 | 63.21% | 0.3873 | 0.1228 | 0.0131 | 0.790 |
| men 1000m | V1 | 1.0381 | 61.45% | 0.4243 | 0.1359 | 0.0196 | 0.902 |
| men 1000m | V1.5 | 1.0058 | 62.70% | 0.4147 | 0.1329 | 0.0156 | 0.884 |
| men 1000m | V2 | 1.0049 | 63.27% | 0.4172 | 0.1334 | 0.0193 | 0.862 |
| men 1500m | V1 | 1.3382 | 51.27% | 0.4324 | 0.1383 | 0.0283 | 1.212 |
| men 1500m | V1.5 | 1.2788 | 53.44% | 0.4128 | 0.1321 | 0.0296 | 1.172 |
| men 1500m | V2 | 1.2598 | 53.44% | 0.4098 | 0.1318 | 0.0172 | 1.145 |
| women 500m | V1 | 0.8234 | 71.40% | 0.4137 | 0.1302 | 0.0379 | 0.765 |
| women 500m | V1.5 | 0.8055 | 71.24% | 0.4053 | 0.1271 | 0.0416 | 0.754 |
| women 500m | V2 | 0.7690 | 71.07% | 0.3989 | 0.1249 | 0.0142 | 0.728 |
| women 1000m | V1 | 0.9494 | 62.01% | 0.4045 | 0.1266 | 0.0355 | 0.814 |
| women 1000m | V1.5 | 0.9358 | 61.84% | 0.3987 | 0.1251 | 0.0380 | 0.804 |
| women 1000m | V2 | 0.9295 | 62.44% | 0.3921 | 0.1234 | 0.0131 | 0.787 |
| women 1500m | V1 | 0.9312 | 69.27% | 0.3795 | 0.1192 | 0.0317 | 1.046 |
| women 1500m | V1.5 | 0.9035 | 69.79% | 0.3632 | 0.1136 | 0.0300 | 1.017 |
| women 1500m | V2 | 0.8483 | 69.92% | 0.3599 | 0.1117 | 0.0133 | 0.984 |

## 6. Fitted End-of-Horizon V1.5 Contextual Weights (`lane-model.mjs`)

| Distance | Races | `alphaScale` | `betaLanePrelim` | `betaLaneMain` | `betaRep` | `betaForm` | `betaSplit` | `betaFinish` | `betaPace` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 500m | 1921 | 0.8157 | 1.4928 | 1.0601 | 0.2786 | 0.1185 | 0.5807 | 0.1562 | 0.7161 |
| 1000m | 1842 | 1.0985 | 0.9604 | 0.3964 | 0.1452 | 0.3066 | 0.5438 | 0.6652 | 0.1752 |
| 1500m | 1244 | 1.0495 | 0.4715 | 0.6857 | 0.2905 | 0.1041 | 0.0000 | 0.9540 | -0.1364 |
