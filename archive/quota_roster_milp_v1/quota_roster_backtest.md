# 2026-27 名额与阵容优化模型 — 历史回测与灵敏度报告

- **生成时间**：2026-11-21T15:34:34Z
- **预测基准日 (`asOfDate`)**：2026-11-21
- **下一站世巡赛**：Shanghai (2026-11-27..2026-11-29)
- **候选池规模**：女子 13 人（年龄拦截 1 人），男子 16 人（年龄拦截 1 人）

## 1. 2026-27 下一站 WT 与 2027 首尔世锦赛实时预测摘要

### 2026-27 世巡赛下一站 (WT4 上海)
- **女队**（约束 `N=6, K=4/4/4, R=4`, 耗时 `2531.8 ms`）：
  - 首选正选（频率 1.4%）：张延 (skr-19401)、公俐 (skr-2262)、宋佳蕊 (skr-6617)、王晔 (skr-7613)、张楚桐 (skr-8080)、张珈宁 (skr-8090)
  - 替补梯队（最多 2 人，实际 2 人）：#1 王欣然 [sprint_relay, loss=0.021]；#2 邝俊雨 [mid_long, loss=0.0687]
- **男队**（约束 `N=6, K=4/4/4, R=4`, 耗时 `2012.3 ms`）：
  - 首选正选（频率 0.5%）：王天佑 (skr-20551)、张子夏 (skr-20586)、李坤 (skr-4167)、孙龙 (skr-6784)、张柏浩 (skr-8078)、朱祎玎 (skr-8157)
  - 替补梯队（最多 2 人，实际 2 人）：#1 宋柯睿 [mid_long, loss=0.0211]；#2 李禹衡 [sprint_relay, loss=0.0379]

### 2027 首尔世锦赛 (5人上限 / 已核验单项名额)
- **女队**（约束 `N=5, K=3/3/2, R=4`, 耗时 `583.1 ms`）：
  - 首选正选（频率 0.8%）：张延 (skr-19401)、公俐 (skr-2262)、王晔 (skr-7613)、张楚桐 (skr-8080)、张珈宁 (skr-8090)
  - 替补梯队（最多 6 人，实际 6 人）：#1 宋佳蕊 [sprint_relay, loss=0.01]；#2 王欣然 [sprint_relay, loss=0.0176]；#3 邝俊雨 [mid_long, loss=0.022]；#4 南佳延 [mid_long, loss=0.029]；#5 杨茸秒 [versatile_upside, loss=0.0316]；#6 李金恣 [versatile_upside, loss=0.0383]
- **男队**（约束 `N=5, K=3/2/2, R=4`, 耗时 `434.8 ms`）：
  - 首选正选（频率 0.9%）：王天佑 (skr-20551)、张子夏 (skr-20586)、李坤 (skr-4167)、孙龙 (skr-6784)、张柏浩 (skr-8078)
  - 替补梯队（最多 6 人，实际 6 人）：#1 姜浩阳 [sprint_relay, loss=0.0216]；#2 郭骏达 [sprint_relay, loss=0.0227]；#3 朱昱璋 [versatile_upside, loss=0.0231]；#4 高君镇 [versatile_upside, loss=0.0235]；#5 李禹衡 [mid_long, loss=0.0243]；#6 于翰琦 [mid_long, loss=0.0299]

## 2. 2024/25 & 2025/26 两赛季严格时间前向回测（零未来数据泄露）

> 对 2024/25–2025/26 全部 12 站完整覆盖赛事（另有 1 站部分覆盖 `2025-26-worldtour-montreal-2` 单独标注），在赛前 1 日截断三池数据并重训国际对手池，检验正选名单与分项席位命中率，以及 `lambda_fatigue` 对兼三项核心的调控效果。

> 注：`2024-25-worldtour-tilburg-5` 与 2025 哈尔滨亚冬会撞期（中国队派二线阵容出战），`2025-26-worlds-montreal` 男队为冬奥后新生代练兵阵容（张柏浩/李坤/宋桂旭），因此两站非主力轮换拉低了全样本平均；其余 10 站一线参赛完整站体现正常竞争力映射。默认 `lambda_fatigue = 0.045` 预测兼三项 14 人次（实际 16 人次）。

| `lambda_fatigue` | 完整站正选人数命中率 | 完整站单项席位命中率 | 预测兼三项人次 | 实际兼三项人次 |
|---:|---:|---:|---:|---:|
| 0.000 | 79/123 (64.2%) | 131/211 (62.1%) | 28 | 16 |
| 0.020 | 79/123 (64.2%) | 129/211 (61.1%) | 22 | 16 |
| 0.045 | 79/123 (64.2%) | 127/211 (60.2%) | 14 | 16 |
| 0.080 | 79/123 (64.2%) | 125/211 (59.2%) | 11 | 16 |
| 0.120 | 80/123 (65.0%) | 121/211 (57.3%) | 4 | 16 |

### 分站回测明细（默认 `lambda_fatigue = 0.045`）

| 赛事 | 覆盖度 | 性别 | 实际规模 (`N`, `K`) | 正选命中 | 分项命中 | 兼三项 (预测/实际) |
|---|---|---|---:|---:|---:|---:|
| 2024-25-worldtour-montreal-1 | complete | women | 6 (3/3/3) | 5/6 | 6/9 | 0/0 |
| 2024-25-worldtour-montreal-1 | complete | men | 6 (3/3/3) | 4/6 | 5/9 | 0/0 |
| 2024-25-worldtour-montreal-2 | complete | women | 6 (3/3/3) | 5/6 | 7/9 | 0/0 |
| 2024-25-worldtour-montreal-2 | complete | men | 6 (3/3/3) | 4/6 | 6/9 | 0/0 |
| 2024-25-worldtour-beijing-3 | complete | women | 6 (3/3/3) | 4/6 | 4/9 | 0/0 |
| 2024-25-worldtour-beijing-3 | complete | men | 5 (3/3/3) | 5/5 | 8/9 | 0/1 |
| 2024-25-worldtour-seoul-4 | complete | women | 6 (3/3/3) | 3/6 | 4/9 | 0/0 |
| 2024-25-worldtour-seoul-4 | complete | men | 6 (3/3/3) | 5/6 | 8/9 | 1/0 |
| 2024-25-worldtour-tilburg-5 | complete | women | 5 (3/3/3) | 0/5 | 0/9 | 0/0 |
| 2024-25-worldtour-tilburg-5 | complete | men | 6 (3/3/3) | 1/6 | 0/9 | 1/0 |
| 2024-25-worldtour-milan-6 | complete | women | 5 (3/3/3) | 1/5 | 1/9 | 0/0 |
| 2024-25-worldtour-milan-6 | complete | men | 5 (3/3/3) | 5/5 | 9/9 | 1/1 |
| 2024-25-worlds-beijing | complete | women | 5 (3/3/3) | 2/5 | 3/9 | 0/1 |
| 2024-25-worlds-beijing | complete | men | 4 (3/3/3) | 3/4 | 8/9 | 2/2 |
| 2025-26-worldtour-montreal-1 | complete | women | 6 (3/3/3) | 4/6 | 6/9 | 0/0 |
| 2025-26-worldtour-montreal-1 | complete | men | 3 (3/3/3) | 2/3 | 6/9 | 2/3 |
| 2025-26-worldtour-montreal-2 | partial | women | 4 (3/2/0) | 3/4 | 4/5 | 0/0 |
| 2025-26-worldtour-montreal-2 | partial | men | 3 (3/2/3) | 2/3 | 6/8 | 2/2 |
| 2025-26-worldtour-gdansk-3 | complete | women | 6 (3/3/3) | 4/6 | 7/9 | 0/0 |
| 2025-26-worldtour-gdansk-3 | complete | men | 5 (3/3/3) | 3/5 | 6/9 | 1/1 |
| 2025-26-worldtour-dordrecht-4 | complete | women | 5 (3/3/3) | 5/5 | 8/9 | 0/1 |
| 2025-26-worldtour-dordrecht-4 | complete | men | 5 (3/3/3) | 3/5 | 6/9 | 1/1 |
| 2025-26-olympics-milano-cortina | complete | women | 5 (3/3/3) | 4/5 | 8/9 | 1/1 |
| 2025-26-olympics-milano-cortina | complete | men | 3 (3/3/3) | 2/3 | 6/9 | 2/3 |
| 2025-26-worlds-montreal | complete | women | 5 (3/2/2) | 5/5 | 5/7 | 0/0 |
| 2025-26-worlds-montreal | complete | men | 3 (2/2/2) | 0/3 | 0/6 | 2/1 |

## 3. 兼项可跨组（Dual-Eligible）选手灵敏度检验

> 对正选边缘的 `DUAL_ELIGIBLE` 选手注入「全国甲组精英赛 500m/1000m 双冠 + JWC 夺冠表现」，检验排名与入选概率跃迁。

| 性别 | 兼项测试选手 | 注入前排名 / 正选概率 / 替补位 | 注入后排名 / 正选概率 / 替补位 |
|---|---|---:|---:|
| women | 杨茸秒 (RONGMIAO YANG) | 第9 / 31.1% / 替补池外 | 第1 / 87.6% / 晋级正选 |
| men | 李禹衡 (Yuheng LI) | 第9 / 29.0% / 替补#2 | 第1 / 84.2% / 晋级正选 |
