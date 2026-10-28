# 第二轮历史来源审计（未完成）

基线 `dd5adb67c0a71580c2cb70af4bced684cb9c6f5b`；首次审计见 PR #53。修复见 Draft PR #54。用户指定 33 条接力采用 A 决赛名次作为统计及显示名次，2015 埃尔祖鲁姆站采用旧成绩册；这是用户裁定，不是官方修订先后已经查明。记录和修复只在 PR #54，main 暂未更新。

## 冬奥来源

IOC 奥林匹克资料库搜索引擎的索引文本包含官方 event classification：平昌女子、男子 500 米各 3 名中国选手，北京男子 1000 米 3 名及女子 3000 米接力中国队共 10 条名次和状态与基线一致。北京男子 1000 的成绩表标记 `74A v2.0`，报告创建 2022-02-09 22:01，修订说明与刘少林的轮次结果相关；不能将索引抓取日期当作官方修订日期。逐条结果见 [ioc-indexed-sample.json](ioc-indexed-sample.json)。

来源为 [2018 IOC 资料库](https://library.olympics.com/Default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=173359&parentDocumentId=173345) 和 [2022 IOC 资料库](https://library.olympics.com/Default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=1568649&parentDocumentId=1568639)。搜索引擎返回了原报告索引文本，但直接打开链接返回要求 JS 和 Cookie 的 HTML；本次未取得原 PDF 字节、无法计算其哈希，不能声称已保存 PDF 或直接核验全部页面。冬奥会使用官方结果页面作为来源本身正常；资料是否已逐条核对另行记录。

第一轮的 41 条冬奥记录中，本轮对其中 10 条进行了名次和状态的索引文本比对，剩余 31 条、另外 115 条未核名次仍待核。已找到其他官方来源，但尚未建立可逐条重现的完整采集链。未核验不能标为通过。

## 其他发现

2019/20 盐湖城女子 3000 接力，Swiss Timing [官方成绩册](https://www.shorttrack.swisstiming.com/Data/PDFs/WC1920USA.pdf)的 EVENT CLASSIFICATION 搜索索引列中国第一，与用户选定的 A 决赛第一一致；其与当前接口总名次第七的修订先后尚未证实。本次仅看到索引文本，未取得该文档原始字节。

## 温哥华首轮修正

[vancouver-relay-evidence.md](vancouver-relay-evidence.md) 区分了快照的 world_tour 累计榜与独立官方 C74B 单站分类。中国混合接力第 11 可直接由第 105 页 C74B 的 Rank 列证实，不以累计排名或组内名次反推；首轮未充分解释这一证据链。
