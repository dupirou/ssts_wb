# 第二轮历史来源审计（未完成）

基线 `dd5adb67c0a71580c2cb70af4bced684cb9c6f5b`；首次审计见 PR #53。修复见 Draft PR #54。用户指定 33 条接力采用 A 决赛名次作为统计及显示名次，2015 埃尔祖鲁姆站采用旧成绩册；这是用户裁定，不是官方修订先后已经查明。记录和修复只在 PR #54，main 暂未更新。

## 冬奥来源

IOC 奥林匹克资料库搜索引擎的索引文本包含官方 event classification：两届冬奥共 41 条中国队记录的名次和状态与基线一致，其中 38 条有数值名次，3 条为无数值名次的 PEN。北京男子 1000 的成绩表标记 `74A v2.0`，报告创建 2022-02-09 22:01，修订说明与刘少林的轮次结果相关；不能将索引抓取日期当作官方修订日期。逐条结果见 [ioc-indexed-sample.json](ioc-indexed-sample.json)。

来源为 [2018 IOC 资料库](https://library.olympics.com/Default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=173359&parentDocumentId=173345) 和 [2022 IOC 资料库](https://library.olympics.com/Default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=1568649&parentDocumentId=1568639)。搜索引擎返回了原报告索引文本，但直接打开链接返回要求 JS 和 Cookie 的 HTML；本次未取得原 PDF 字节、无法计算其哈希，不能声称已保存 PDF 或直接核验全部页面。冬奥会使用官方结果页面作为来源本身正常；资料是否已逐条核对另行记录。

第一轮的 41 条冬奥记录已逐条对照索引文本中的名次和状态；其他 115 条的当前进度见下方。已找到其他官方来源，但尚未建立可逐条重现的完整采集链。未核验不能标为通过。

## 其他发现

2019/20 盐湖城女子 3000 接力，Swiss Timing [官方成绩册](https://www.shorttrack.swisstiming.com/Data/PDFs/WC1920USA.pdf)的 EVENT CLASSIFICATION 搜索索引列中国第一，与用户选定的 A 决赛第一一致；其与当前接口总名次第七的修订先后尚未证实。本次仅看到索引文本，未取得该文档原始字节。

## 温哥华首轮修正

[vancouver-relay-evidence.md](vancouver-relay-evidence.md) 区分了快照的 world_tour 累计榜与独立官方 C74B 单站分类。中国混合接力第 11 可直接由第 105 页 C74B 的 Rank 列证实，不以累计排名或组内名次反推；首轮未充分解释这一证据链。

## 2023 四大洲拉瓦尔站：官方分类资料与仓库不一致

官方 [Laval 官方成绩册](https://app-prod-isu-stk-archive-westeurope.azurewebsites.net/Data/PDFs/FCC24.pdf)的 EVENT CLASSIFICATION 给出中国女子接力总第 5（仓库 B 组第 1）、男子接力总第 2、混合接力第 5 且 PEN（仓库为 A 组第 3、classified）。女子 1000 米张佳宁第 13、郝唯英和宋佳瑞并列第 18 且 PEN；男子 1000 米钟宇晨第 16、李文龙第 4。仓库对应个人成绩有 4 条总名次为空，另 1 条为 A 组第 4。逐条记录见 [laval-2023-findings.json](laval-2023-findings.json)。

女子接力仓库第 1 明确为 B 组名次，不能作为总名次；混合接力的决赛记录与官方成绩册半决赛 PEN 不一致，可能涉及赛事关联或修订，原因及官方版本先后未查明。未取得 PDF 字节，本次使用 ISU 归档 PDF 的网页缓存文本，暂不把这一来源当作已证明的最新版，也不直接改写仓库。

## 2022/23 阿拉木图、德累斯顿与 2024/25 米兰

通过 Swiss Timing 官方成绩册的搜索引擎索引文本，对三站原先无法匹配的 30 条记录找到逐条单站分类；详见 [concentrated-15.json](concentrated-15.json)。阿拉木图女子 500 米第二次王晔为总第 9（仓库 B 组第 3）、男子 500 米第二次李昆为总第 9（仓库 B 组第 4）；德累斯顿女子 1500 米第二次臧一泽总第 11（仓库 B 组第 4）。其他已找到来源的空名次也分别保留在机器可读文件中。

阿拉木图女子 1000 米贾慧玲官方分类第 33，末轮 DNS，且有此前有效时间；仓库状态为 classified，可能涉及状态语义或来源版本，应结合逐轮证据追查，不能仅据旧索引认定现行官方版本。两份 Swiss Timing PDF 原地址当前返回 HTTP 404，本轮仅取得搜索索引中的 C74 表格文本，未保存原始 PDF 字节，官方修订先后未确认。

初始 115 条中 8 条拉瓦尔记录与本批 30 条已找到可比的官方分类文本（部分仍有来源或状态争议）；另 77 条尚未定位逐条分类。本批没有更改生产成绩。

德累斯顿男子 1500 米第二次：宋嘉华官方总第 10（仓库 B 组第 2），李文龙第 8 且 PEN，刘冠逸第 15 且末轮 DNS、此前有有效成绩；阿拉木图男女接力均为第 8、PEN。详见对账文件；均未直接改写生产数据。


米兰站官方分类索引还列混合接力第 8、女子 500 米王欣然第 11、张楚桐第 14、范可新第 20 且 PEN，以及男子 1500 米朱易定第 15、李文龙第 16、孙龙第 24。德累斯顿女子 500 米王晔第 16、张楚桐第 27 PEN、王欣然第 45 PEN。来源仍为索引文本，不等于取得原件。
