# 历史分组数据覆盖率与质量核验报告（`data_coverage.md`）

> 由 `tools/check_heats.py` 自动生成。

## 1. 全量汇总

- 覆盖赛事数：**27** 站（2022/23–2025/26）
- 总组数（Heats）：**4784**
- 总出场人次数（Starts）：**25078**
- 选手主档人数：**469**（均已绑定 `official_skater_ids` / `skr-<id>`，零 `tmp-` 临时 ID）
- 2026/27 `ath-*` 对照映射数：**236**（`rounds.json` 100% 映射；仅未出场替补/新人未映射到 `skr-`：**30** 人）
- 赛前撤赛幽灵占位行剔除：**3** 条
- 资格赛 `DNF` 合法进入复活赛实例：**12** 人次
- 复活半决赛胜者进入正赛外道校验：**444/445** 居标准最外道（5/7 号道及以上）
- 校验错误数：**0**

## 2. 分赛季覆盖率与判罚基线

| 赛季 | 站数 | 组数 | 人次数 | `PEN` | `YC` | `RC` | `DNF` | `DNS` | `NO_TIME` | `ADV` | 犯规率（PEN+YC+RC / 发枪） |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2022/23 | 7 | 1184 | 6225 | 230 | 3 | 0 | 18 | 55 | 151 | 137 | 3.78% |
| 2023/24 | 7 | 1252 | 6674 | 261 | 13 | 0 | 23 | 49 | 120 | 152 | 4.14% |
| 2024/25 | 7 | 1215 | 6521 | 217 | 18 | 1 | 15 | 48 | 166 | 154 | 3.65% |
| 2025/26 | 6 | 1133 | 5658 | 239 | 5 | 0 | 18 | 30 | 126 | 181 | 4.34% |

## 3. 跨协会代表变更选手清单（`athletes.json`）

共发现 **3** 名跨代表协会变更记录：

| 主键 | 姓名 | 代表协会变更轨迹 |
|---|---|---|
| `skr-20498` | Alena KRYLOVA | AIN (2025-10-10..2026-02-16) → AIN2 (2026-11-20..2026-11-20) |
| `skr-20499` | Daniil NIKOLAEV | AIN (2025-10-09..2025-11-29) → AIN2 (2026-11-20..2026-11-20) |
| `skr-20501` | Elena SEREGINA | AIN (2025-10-09..2025-11-29) → AIN2 (2026-11-20..2026-11-20) |

## 4. 手工历史数据交叉核验（`src/historical-*.mjs`）

### src/historical-heats.mjs (25/26 Men 1500m): 匹配 126/155 组（官方完赛有时间组 159）

| 序号 | 赛事 | 轮次组别 | 手工录入（`historical-*.mjs`） | 官方 ISU 记录 |
|---:|---|---|---|---|
| 7 | `2025-26-worldtour-montreal-1` | Heats Heat 7 | KAZHGALI Nurtil ek (KAZ) | Nurtilek KAZHGALI |
| 21 | `2025-26-worldtour-montreal-1` | Rep. Quarterfinals Heat 3 | BOZDAG Muhammed (TUR) | (country mismatch) |
| 22 | `2025-26-worldtour-montreal-1` | Rep. Quarterfinals Heat 4 | HANDEI Oleh (UKR) | (country mismatch) |
| 23 | `2025-26-worldtour-montreal-1` | Rep. Quarterfinals Heat 5 | WOLF Tobias (AUT) | (country mismatch) |
| 26 | `2025-26-worldtour-montreal-1` | Rep. Quarterfinals Heat 8 | KAZHGALI Nur tilek (KAZ) | Nurtilek KAZHGALI |
| 47 | `2025-26-worldtour-montreal-2` | Quarterfinals Heat 1 | BOZDAG Muhammed (TUR) | (country mismatch) |
| 49 | `2025-26-worldtour-montreal-2` | Quarterfinals Heat 3 | THOMAS Neithan (POL) | Michal NIEWINSKI |
| 50 | `2025-26-worldtour-montreal-2` | Quarterfinals Heat 4 | NADALINI Thomas (ITA) | Pietro Sighel |
| 52 | `2025-26-worldtour-montreal-2` | Quarterfinals Heat 6 | HANDEL Oleh (UKR) | Oleh HANDEI |
| 52 | `2025-26-worldtour-montreal-2` | Quarterfinals Heat 6 | IVCHENKO Gleb (KAZ) | (country mismatch) |
| 68 | `2025-26-worldtour-montreal-2` | Semifinals Heat 3 | de CLEMENTE Clayton (USA) | (country mismatch) |
| 73 | `2025-26-worldtour-gdansk-3` | Heats Heat 4 | SCHLOSSARECK Rafael (GER) | Rafael SCHLOSSAREK |
| 75 | `2025-26-worldtour-gdansk-3` | Heats Heat 6 | THOMAS Neithan (POL) | (country mismatch) |
| 79 | `2025-26-worldtour-gdansk-3` | Heats Heat 10 | ANDERMANN Nico (AUT) | Nicolas ANDERMANN |
| 82 | `2025-26-worldtour-gdansk-3` | Quarterfinals Heat 2 | BASTIER Simon (FRA) | (country mismatch) |
| 90 | `2025-26-worldtour-gdansk-3` | Rep. Quarterfinals Heat 3 | CHANGMAI Phoripat (THA) | Phooripat CHANGMAI |
| 93 | `2025-26-worldtour-gdansk-3` | Rep. Quarterfinals Heat 6 | SCHLOSSARCEK Rafael (GER) | Jonas HAMMERMULLER, Rafael SCHLOSSAREK |
| 94 | `2025-26-worldtour-gdansk-3` | Rep. Quarterfinals Heat 7 | HANDEL Oleh (UKR) | (country mismatch) |
| 97 | `2025-26-worldtour-gdansk-3` | Rep. Semifinals Heat 1 | LAI TSAI Huan-Chen (TPE) | (country mismatch) |
| 98 | `2025-26-worldtour-gdansk-3` | Rep. Semifinals Heat 2 | HANDEL Oleh (UKR) | Oleh HANDEI |
| 98 | `2025-26-worldtour-gdansk-3` | Rep. Semifinals Heat 2 | COLLINS Theo (GBR) | Peter RICHES |
| 99 | `2025-26-worldtour-gdansk-3` | Semifinals Heat 1 | KRUZBERGS Roberts (LAT) | (country mismatch) |
| 105 | `2025-26-worldtour-dordrecht-4` | Heats Heat 2 | HANDEI Oleh (UKR) | (country mismatch) |
| 107 | `2025-26-worldtour-dordrecht-4` | Heats Heat 4 | KAZHGALI Nur tilek (KAZ) | Nurtilek KAZHGALI |
| 107 | `2025-26-worldtour-dordrecht-4` | Heats Heat 4 | ANDERMANN Nico (AUT) | Nicolas ANDERMANN |
| 111 | `2025-26-worldtour-dordrecht-4` | Heats Heat 8 | CHANGMAI Phoripat (THA) | Phooripat CHANGMAI |
| 113 | `2025-26-worldtour-dordrecht-4` | Heats Heat 10 | SCHLOSSARECK Rafael (GER) | Rafael SCHLOSSAREK |
| 114 | `2025-26-worldtour-dordrecht-4` | Quarterfinals Heat 1 | ANDERMANN Nico (AUT) | Nicolas ANDERMANN |
| 120 | `2025-26-worldtour-dordrecht-4` | Quarterfinals Heat 7 | SPECHENHAUSER Luca (ITA) | (country mismatch) |
| 122 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 2 | SPECHENHAUSER Luca (ITA) | (country mismatch) |
| 123 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 3 | GYUROY Assen (BUL) | Assen GYUROV |
| 123 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 3 | SCHLOSSARECK Rafael (GER) | Rafael SCHLOSSAREK |
| 124 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 4 | ANDERMANN Nico (AUT) | Nicolas ANDERMANN |
| 124 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 4 | EIBOG Daniil (UZB) | (country mismatch) |
| 130 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 10 | LIBEAU Tymeo (FRA) | Etienne BASTIER |
| 141 | `2025-26-worlds-montreal` | Quarterfinals Heat 5 | STERMANIS Maris Janis (LAT) | Maris Janis STERNMANIS |
| 143 | `2025-26-worlds-montreal` | Quarterfinals Heat 7 | SPECHENHAUSER Luca (ITA) | (country mismatch) |
| 145 | `2025-26-worlds-montreal` | Rep. Quarterfinals Heat 1 | HANDEL Oleh (UKR) | Oleh HANDEI |
| 145 | `2025-26-worlds-montreal` | Rep. Quarterfinals Heat 1 | WOLF Tobias (AUT) | (country mismatch) |
| 148 | `2025-26-worlds-montreal` | Rep. Quarterfinals Heat 4 | JAGAL Eklavya (IND) | (country mismatch) |
| 149 | `2025-26-worlds-montreal` | Rep. Quarterfinals Heat 5 | STERMANIS Maris Janis (LAT) | Maris Janis STERNMANIS |
| 149 | `2025-26-worlds-montreal` | Rep. Quarterfinals Heat 5 | WAREHAM Lucas (AUS) | (country mismatch) |
| 150 | `2025-26-worlds-montreal` | Rep. Semifinals Heat 1 | SPECHENHAUSER Luca (ITA) | (country mismatch) |
| 155 | `2025-26-worlds-montreal` | Finals Final A | DANDJINOU William (CAN) | Maxime LAOUN, Felix ROUSSEL |

未完全匹配组（29）：
- 第 36 组（len=7）: `[['NADALINI Thomas', 'ITA'], ['HANDEI Oleh', 'UKR'], ['CECH Ernestas', 'LTU']]`
- 第 37 组（len=6）: `[['LIN Xiaojun', 'CHN'], ['DESMET Stijn', 'BEL'], ['NIKOLAEV Daniil', 'AIN']]`
- 第 38 组（len=7）: `[['DUBOIS Steven', 'CAN'], ['JASIC Luka', 'SRB'], ['PIGEON Felix', 'POL']]`
- 第 39 组（len=6）: `[['HONG Kyung Hwan', 'KOR'], ['AYRAPETYAN Denis', 'UZB'], ['TAPROM Chonlachart', 'THA']]`
- 第 40 组（len=7）: `[['de CLEMENTE Clayton', 'USA'], ['EIBOG Daniil', 'UZB'], ['O BRIEN Liam', 'IRL']]`
- 第 41 组（len=6）: `[['THOMAS Neithan', 'POL'], ['KAZHGALI Nurtilеk', 'KAZ'], ['AKAR Furkan', 'TUR']]`
- 第 42 组（len=7）: `[['MOON Wonjun', 'HUN'], ['KOO Lucas Henry', 'BRA'], ['WAREHAM Lucas', 'AUS']]`
- 第 43 组（len=6）: `[['FERCOQ Quentin', 'FRA'], ['FAJKUS Radek', 'CZE'], ['DONCHEV Ivan', 'BUL']]`
- 第 44 组（len=6）: `[['BERZINS Reinis', 'LAT'], ['RICHES Peter', 'GBR'], ['NOGRADI Bence', 'HUN']]`
- 第 45 组（len=6）: `[['JASZAPATI Peter', 'HUN'], ['GALIAKHMETOV Adil', 'KAZ'], ['van DAMME Warre', 'BEL']]`
- 第 46 组（len=6）: `[['IVCHENKO Gleb', 'KAZ'], ['WOLF Tobias', 'AUT'], ['MURPHY Peter', 'LUX']]`
- 第 48 组（len=6）: `[['HEO Andrew', 'USA'], ['de CLEMENTE Clayton', 'USA'], ['KOS Daan', 'NED']]`
- 第 51 组（len=5）: `[['COREY Brendan', 'AUS'], ['BERZINS Reinis', 'LAT'], ['EIBOG Daniil', 'UZB']]`
- 第 53 组（len=6）: `[['DUBOIS Steven', 'CAN'], ['HONG Kyung Hwan', 'KOR'], ['SUN Long', 'CHN']]`
- 第 54 组（len=6）: `[['MOON Wonjun', 'HUN'], ['ORS Denis', 'TUR'], ['THOMAS Neithan', 'POL']]`
- 第 55 组（len=7）: `[['RICHES Peter', 'GBR'], ['EIBOG Daniil', 'UZB'], ['MACDONALD Lukas', 'NZL']]`
- 第 56 组（len=6）: `[['FERCOQ Quentin', 'FRA'], ['LOU Zhanshuo', 'HKG'], ['KOO Lucas Henry', 'BRA']]`
- 第 57 组（len=7）: `[["van 'T WOUT Jens", 'NED'], ['SPECHENHAUSER Luca', 'ITA'], ['HAMMERULLER Jonas', 'GER']]`
- 第 58 组（len=7）: `[['NIEWINSKI Michal', 'POL'], ['GALIAKHMETOV Adil', 'KAZ'], ['LYU Xiucheng', 'HKG']]`
- 第 59 组（len=7）: `[['NADALINI Thomas', 'ITA'], ['NOGRADI Bence', 'HUN'], ['AYRAPETYAN Denis', 'UZB']]`

### src/historical-women-1000.mjs (25/26 Women 1000m): 匹配 58/67 组（官方完赛有时间组 132）

| 序号 | 赛事 | 轮次组别 | 手工录入（`historical-*.mjs`） | 官方 ISU 记录 |
|---:|---|---|---|---|
| 2 | `2025-26-worldtour-montreal-1` | Preliminaries Heat 2 | LAUT Kiera Alexandra (INA) | Kierana Alexandra LAUT |
| 10 | `2025-26-worldtour-montreal-1` | Rep. Quarterfinals Heat 3 | LAUT Kiera Alexandra (INA) | Kierana Alexandra LAUT |
| 16 | `2025-26-worldtour-montreal-2` | Preliminaries Heat 3 | SYDORKO Yelyzaveta (UKR) | (country mismatch) |
| 17 | `2025-26-worldtour-montreal-2` | Preliminaries Heat 4 | AZHGALIYEVA Alina (KAZ) | (country mismatch) |
| 20 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 3 | LEVEQUE Aurelie (FRA) | (country mismatch) |
| 20 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 3 | GAKOVA Barbora (CZE) | (country mismatch) |
| 22 | `2025-26-worldtour-montreal-2` | Rep. Quarterfinals Heat 1 | ZANG Yize (CHN) | (country mismatch) |
| 24 | `2025-26-worldtour-montreal-2` | Rep. Quarterfinals Heat 3 | BURIC Katarina (CRO) | (country mismatch) |
| 25 | `2025-26-worldtour-montreal-2` | Rep. Quarterfinals Heat 4 | AZHGALIYEVA Alina (KAZ) | Olga TIKHONOVA |
| 38 | `2025-26-worldtour-gdansk-3` | Finals Final B | VELZEEBOER Xandra (NED) | Xandra VELZEBOER |
| 49 | `2025-26-worldtour-dordrecht-4` | Heats Heat 4 | MICHIELSEN Minthe (BEL) | Mirthe MICHIELSEN |
| 60 | `2025-26-worldtour-dordrecht-4` | Rep. Quarterfinals Heat 7 | AZHGALYEVA Alina (KAZ) | Alina AZHGALIYEVA |
| 63 | `2025-26-worldtour-dordrecht-4` | Quarterfinals Heat 2 | OLLIVIER Chloe (FRA) | Cloe OLLIVIER |

未完全匹配组（9）：
- 第 15 组（len=5）: `[['ZANG Yize', 'CHN'], ['LAM Ching Yan', 'HKG'], ['YERMEK Malika', 'KAZ']]`
- 第 18 组（len=5）: `[['ECKSTEIN Lisa', 'GER'], ['CHATTHAISONG Thanutchaya', 'THA'], ['den DULK Tineke', 'BEL']]`
- 第 19 组（len=5）: `[['SEREGINA Elena', 'AIN'], ['BACSKAI Sara Luca', 'HUN'], ['GREEN Annabelle', 'GBR']]`
- 第 21 组（len=5）: `[['WATANABE Aoi', 'JPN'], ['VANKOVA Petra', 'CZE'], ['LEE Eunice', 'USA']]`
- 第 23 组（len=6）: `[['MAZUR Nikola', 'POL'], ['SZILICZEI-NEMET Rebeka', 'HUN'], ['BETTI Chiara', 'ITA']]`
- 第 26 组（len=6）: `[['SEREGINA Elena', 'AIN'], ['BACSKAI Sara Luca', 'HUN'], ['YERMEK Malika', 'KAZ']]`
- 第 27 组（len=6）: `[['CONFORTOLA Elisa', 'ITA'], ['LEE Eunice', 'USA'], ['LAM Ching Yan', 'HKG']]`
- 第 28 组（len=6）: `[['ASCIC Valentina', 'CRO'], ['KIM Hyo Jin', 'AUS'], ['JANSONE Anna', 'LAT']]`
- 第 56 组（len=4）: `[['BRUNELLE Florence', 'CAN'], ['TIKHONOVA Olga', 'KAZ'], ['MAZUR Nikola', 'POL']]`

## 5. 2026/27 仅报名未出场 `ath-*` 选手（待出场后自动补齐 ISU ID）

共 30 名仅在 `entries`/`rankings` 出现且无历史出赛记录的选手：

- `ath-039907ab5c24748ad431`: SULC Samuel Oliver (CZE, men)
- `ath-077872580b1b8aae252d`: ZHANISSOV Sanzhar (KAZ, men)
- `ath-0825b63f2e5a0d39d37d`: BOER Brian (NED, men)
- `ath-08702fca8b9ba9e8da12`: AMSCHL Kira Judit (HUN, women)
- `ath-0f29f7a792674f648f26`: NAN JIAYAN (CHN, women)
- `ath-13b1ac10dd587685314e`: NIJBOER Sophie (NED, women)
- `ath-154610d4b0cb7055236f`: Z MOLNAR Borisz (HUN, men)
- `ath-234078166799fe66f9af`: CHEN Steven (AUS, men)
- `ath-2d225339f0d18b4884df`: MIDJO Henri Stenskrog (NOR, men)
- `ath-3e4b0c909237d556e304`: FIRDAUS Marva Kayana Putra (INA, men)
- `ath-42b64227cadaf8aed18f`: CASAGRANDE Lucrezia (ITA, women)
- `ath-4d45ed1e46ea24682647`: PHUATRAKUL Kritsanapon (THA, men)
- `ath-4f8c78d76cf65d27796e`: HAYASHI Daigo (JPN, men)
- `ath-51159f075dd58717d23c`: FUCHIGAMI Yuta (JPN, men)
- `ath-5473e6b679d75d058541`: KHOKHELKO Mariia (UKR, women)
- `ath-5841e606f54c10b441b3`: PICCHIARELLI Alessandro (ITA, men)
- `ath-672e318a34c40e9d2d36`: GYUROV Asen (BUL, men)
- `ath-95a05227a237238b7f28`: POPL Matej (CZE, men)
- `ath-98db35bb9bcbaa999fe0`: WU  Jiawei David (HUN, men)
- `ath-b106122a7b88d60c9d6f`: KIDA Raito (JPN, men)
- `ath-bce034b453ac1a32fe62`: VISSER Leon (NED, men)
- `ath-c1101796a5a03fa62c35`: LI Yuheng (CHN, men)
- `ath-c4ab9f2cd627c879d71d`: DE JONG Mijntje (NED, women)
- `ath-c4afc40915345c5ed35c`: MIYOSHI Teruhisa (JPN, men)
- `ath-db28039908817b14b389`: RHODEHAMEL Elizabeth (USA, women)
- `ath-dd2b3b0d39813eac69b7`: WANG Tianyou (CHN, men)
- `ath-df8be78e157cff13f05d`: LECLERC Emanuelle (CAN, women)
- `ath-e5c572b5a7978d920d74`: SASAKI Taiga (JPN, men)
- `ath-ec4063401c9171e4725a`: NAM Yoonchang (KOR, men)
- `ath-ff741909bf21a9f5f316`: PAGE Kiera (CAN, women)

## 6. 部分覆盖赛事说明（上游 ISU API 缺损）

- `2025-26-worldtour-montreal-2`: 已导入 222 组 / 763 人次 — ISU front-api omits ~35% of skaters across 171 heats; official Protocol PDF STWT-2-Montreal-2025-26-1761561207-5928.pdf is vector-outlined without a text layer.

