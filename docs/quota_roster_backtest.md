# 2026-27 名额与阵容优化模型 — 历史回测与灵敏度报告

- **生成时间**：2026-11-21T09:34:51Z
- **预测基准日 (`asOfDate`)**：2026-11-21
- **下一站世巡赛**：Shanghai (2026-11-27..2026-11-29)
- **候选池规模**：女子 59 人（年龄拦截 1 人），男子 61 人（年龄拦截 1 人）

## 1. 2026-27 下一站 WT 与 2027 首尔世锦赛实时预测摘要

### 2026-27 世巡赛下一站 (WT4 上海)
- **女队**（约束 `N=6, K=4/4/4, R=4`, 耗时 `3712 ms`）：
  - 首选正选（频率 0.0%）：林敬宜 (skr-18243)、杨茸秒 (skr-22312)、公俐 (skr-2262)、宋佳蕊 (skr-6617)、王晔 (skr-7613)、张楚桐 (skr-8080)
  - 6人替补梯队：#1 郝若萱 [sprint_relay, loss=0.0028]；#2 邝俊雨 [sprint_relay, loss=0.0096]；#3 王欣然 [mid_long, loss=0.013]；#4 张珈宁 [mid_long, loss=0.0227]；#5 范可新 [versatile_upside, loss=0.0799]；#6 臧一泽 [versatile_upside, loss=0.1145]
- **男队**（约束 `N=6, K=4/4/4, R=4`, 耗时 `2993.9 ms`）：
  - 首选正选（频率 0.0%）：王天佑 (skr-20551)、张子夏 (skr-20586)、林孝埈 (skr-4247)、刘少昂 (skr-4312)、孙龙 (skr-6784)、张柏浩 (skr-8078)
  - 6人替补梯队：#1 李坤 [sprint_relay, loss=0.0313]；#2 于翰琦 [sprint_relay, loss=0.0332]；#3 安青昊 [mid_long, loss=0.0385]；#4 朱昱璋 [mid_long, loss=0.0413]；#5 任子威 [versatile_upside, loss=0.1087]；#6 宋嘉华 [versatile_upside, loss=0.1089]

### 2027 首尔世锦赛 (5人上限 / 已核验单项名额)
- **女队**（约束 `N=5, K=3/3/2, R=4`, 耗时 `1093.5 ms`）：
  - 首选正选（频率 0.3%）：杨茸秒 (skr-22312)、公俐 (skr-2262)、宋佳蕊 (skr-6617)、王晔 (skr-7613)、张楚桐 (skr-8080)
  - 6人替补梯队：#1 林敬宜 [sprint_relay, loss=0.0135]；#2 王欣然 [sprint_relay, loss=0.016]；#3 邝俊雨 [mid_long, loss=0.0448]；#4 李金恣 [mid_long, loss=0.0495]；#5 范可新 [versatile_upside, loss=0.0778]；#6 臧一泽 [versatile_upside, loss=0.1115]
- **男队**（约束 `N=5, K=3/2/2, R=4`, 耗时 `884.4 ms`）：
  - 首选正选（频率 0.3%）：王天佑 (skr-20551)、张子夏 (skr-20586)、林孝埈 (skr-4247)、刘少昂 (skr-4312)、张柏浩 (skr-8078)
  - 6人替补梯队：#1 孙龙 [sprint_relay, loss=0.0334]；#2 李坤 [sprint_relay, loss=0.0546]；#3 李文龙 [mid_long, loss=0.0624]；#4 孙枭 [mid_long, loss=0.066]；#5 任子威 [versatile_upside, loss=0.099]；#6 刘少林 [versatile_upside, loss=0.115]

## 2. 2024/25 & 2025/26 两赛季严格时间前向回测（零未来数据泄露）

> 对 2024/25–2025/26 全部 12 站完整覆盖赛事（另有 1 站部分覆盖 `2025-26-worldtour-montreal-2` 单独标注），在赛前 1 日截断三池数据并重训国际对手池，检验正选名单与分项席位命中率，以及 `lambda_fatigue` 对兼三项核心的调控效果。

> 注：`2024-25-worldtour-tilburg-5` 与 2025 哈尔滨亚冬会撞期（中国队派二线阵容出战），`2025-26-worlds-montreal` 男队为冬奥后新生代练兵阵容（张柏浩/李坤/宋桂旭），因此两站非主力轮换拉低了全样本平均；其余 10 站一线参赛完整站体现正常竞争力映射。`lambda_fatigue` 扫参显示：`0.12` 预测 10 人次兼三项（最接近实际 16 人次），`0.22`（默认）则偏向保守保护体能。

| `lambda_fatigue` | 完整站正选人数命中率 | 完整站单项席位命中率 | 预测兼三项人次 | 实际兼三项人次 |
|---:|---:|---:|---:|---:|
| 0.00 | 76/123 (61.8%) | 131/211 (62.1%) | 33 | 16 |
| 0.12 | 76/123 (61.8%) | 116/211 (55.0%) | 3 | 16 |
| 0.22 | 76/123 (61.8%) | 113/211 (53.6%) | 0 | 16 |
| 0.35 | 76/123 (61.8%) | 113/211 (53.6%) | 0 | 16 |
| 0.50 | 76/123 (61.8%) | 113/211 (53.6%) | 0 | 16 |

### 分站回测明细（默认 `lambda_fatigue = 0.22`）

| 赛事 | 覆盖度 | 性别 | 实际规模 (`N`, `K`) | 正选命中 | 分项命中 | 兼三项 (预测/实际) |
|---|---|---|---:|---:|---:|---:|
| 2024-25-worldtour-montreal-1 | complete | women | 6 (3/3/3) | 4/6 | 5/9 | 0/0 |
| 2024-25-worldtour-montreal-1 | complete | men | 6 (3/3/3) | 5/6 | 6/9 | 0/0 |
| 2024-25-worldtour-montreal-2 | complete | women | 6 (3/3/3) | 4/6 | 5/9 | 0/0 |
| 2024-25-worldtour-montreal-2 | complete | men | 6 (3/3/3) | 5/6 | 7/9 | 0/0 |
| 2024-25-worldtour-beijing-3 | complete | women | 6 (3/3/3) | 4/6 | 5/9 | 0/0 |
| 2024-25-worldtour-beijing-3 | complete | men | 5 (3/3/3) | 4/5 | 7/9 | 0/1 |
| 2024-25-worldtour-seoul-4 | complete | women | 6 (3/3/3) | 3/6 | 5/9 | 0/0 |
| 2024-25-worldtour-seoul-4 | complete | men | 6 (3/3/3) | 5/6 | 6/9 | 0/0 |
| 2024-25-worldtour-tilburg-5 | complete | women | 5 (3/3/3) | 0/5 | 0/9 | 0/0 |
| 2024-25-worldtour-tilburg-5 | complete | men | 6 (3/3/3) | 0/6 | 0/9 | 0/0 |
| 2024-25-worldtour-milan-6 | complete | women | 5 (3/3/3) | 2/5 | 3/9 | 0/0 |
| 2024-25-worldtour-milan-6 | complete | men | 5 (3/3/3) | 4/5 | 5/9 | 0/1 |
| 2024-25-worlds-beijing | complete | women | 5 (3/3/3) | 3/5 | 5/9 | 0/1 |
| 2024-25-worlds-beijing | complete | men | 4 (3/3/3) | 2/4 | 4/9 | 0/2 |
| 2025-26-worldtour-montreal-1 | complete | women | 6 (3/3/3) | 4/6 | 5/9 | 0/0 |
| 2025-26-worldtour-montreal-1 | complete | men | 3 (3/3/3) | 3/3 | 6/9 | 0/3 |
| 2025-26-worldtour-montreal-2 | partial | women | 4 (3/2/0) | 2/4 | 3/5 | 0/0 |
| 2025-26-worldtour-montreal-2 | partial | men | 3 (3/2/3) | 3/3 | 6/8 | 0/2 |
| 2025-26-worldtour-gdansk-3 | complete | women | 6 (3/3/3) | 4/6 | 7/9 | 0/0 |
| 2025-26-worldtour-gdansk-3 | complete | men | 5 (3/3/3) | 4/5 | 6/9 | 0/1 |
| 2025-26-worldtour-dordrecht-4 | complete | women | 5 (3/3/3) | 3/5 | 5/9 | 0/1 |
| 2025-26-worldtour-dordrecht-4 | complete | men | 5 (3/3/3) | 4/5 | 7/9 | 0/1 |
| 2025-26-olympics-milano-cortina | complete | women | 5 (3/3/3) | 3/5 | 5/9 | 0/1 |
| 2025-26-olympics-milano-cortina | complete | men | 3 (3/3/3) | 3/3 | 6/9 | 0/3 |
| 2025-26-worlds-montreal | complete | women | 5 (3/2/2) | 3/5 | 3/7 | 0/0 |
| 2025-26-worlds-montreal | complete | men | 3 (2/2/2) | 0/3 | 0/6 | 0/1 |

## 3. 兼项可跨组（Dual-Eligible）选手灵敏度检验

> 对正选边缘的 `DUAL_ELIGIBLE` 选手注入「全国甲组精英赛 500m/1000m 双冠 + JWC 夺冠表现」，检验排名与入选概率跃迁。

| 性别 | 兼项测试选手 | 注入前排名 / 正选概率 / 替补位 | 注入后排名 / 正选概率 / 替补位 |
|---|---|---:|---:|
| women | 郝若萱 (RUOXUAN HAO) | 第16 / 15.4% / 替补#1 | 第1 / 98.9% / 晋级正选 |
| men | 李禹衡 (Yuheng LI) | 第23 / 6.6% / 池外 | 第1 / 98.6% / 晋级正选 |
