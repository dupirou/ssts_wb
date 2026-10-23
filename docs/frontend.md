# 前端

`web/index.html`、`web/site.css`、`web/app.js` 是全部前端源码：零依赖原生 JS，不用外部字体、图片或 CDN。`tools/build.py` 复制到 `dist/`，不要直接改 `dist/`。`index.html` 与 `manifest.webmanifest` 中的 `{{SEASON}}`、`{{DESCRIPTION}}` 在构建时按 `data/stations.json` 填入，页面脚本里的赛季文字也都取自 `calendar.json`，换赛季不必改前端。

## 页面

- **首页 `/`**：下一站主卡（城市、日期、场馆、时差、到首项开赛的倒计时、三个比赛日小卡）、售票卡、赛季时间轴、七站卡片、世锦赛卡。
- **分站页 `/?station=<id>`**：标题区与数字条；倒计时卡和中国队下一场；“赛程 / 运动员 / 分组预测”三个标签（预测只在仍有首轮未出官方分组时出现）。`?day=`、`?view=athletes|predictions` 可直达。
- **赛程**：赛程概览（比赛时段刻度与奖牌赛，默认收起）；吸顶筛选栏（比赛日、筛选面板、北京 / 当地时间）；按比赛日分组的列表。桌面为表格，平板两列卡片，手机单列卡片，打印恢复完整七列表格。
- **分组弹窗**：有官方分组的轮次显示“查看分组 / 查看成绩”，弹窗按组列出出发位、姓名、国家、头盔号；有成绩时显示名次、成绩、晋级与判罚。
- **运动员**：报名名单（默认 CHN，国家与性别筛选，名字后小字写性别与所报单项）和排名。
- **新动态横条**：只显示上次关闭后的新条目，首访显示最近 3 天；涉及中国队为红点，A 组决赛成绩为金点，时间调整为蓝点。

`?now=2026-10-25T01:20:00Z` 可预览比赛进行中的状态（只偏移前端时钟）。

## 视觉规则

所有颜色都是 `site.css` 顶部的变量：`:root` 为夜间“极光冰蓝”（CSS 注释中的 Arctic Sky），`:root[data-theme="light"]` 为白蓝浅色。主题默认跟随系统，页眉按钮手动切换并记住；`?theme=` 只影响本次访问。

每种用途一种外观：

| 用途 | 外观 |
|---|---|
| 所在位置（分站导航当前站） | 全页唯一的实心主色块 |
| 视图切换（赛程 / 运动员 / 分组预测） | 下划线标签 |
| 筛选与设置（日期、北京 / 当地、筛选项） | 分段控件 `--seg-*` |
| 操作 | 主按钮深蓝实心 `--cta-*`；次要按钮主色描边 |
| 小状态标签与计数 | 主色淡底 `--sel-*` |
| 静态信息（“ISU 暂定赛程”、DAY 1） | 无容器，图标 + 文字 |

强调色只有两种：中国队红、A 组决赛 / 奖牌赛金。数字用 DIN Alternate / Bahnschrift（回退系统字体）+ `tabular-nums`。动画限于赛道光点、倒计时、入场淡入；`prefers-reduced-motion` 时全部停止。

## 文案约定

- 不放免责声明、法律提示或解释算法的说明句；“非官方”只在预测面板标一次。
- 多个事实用“ · ”分隔且只在“·”处换行（`phrases()` 或 `.nowrap`），短注释不加句号。
- 时间带时段（凌晨 / 早上 / 上午 / 中午 / 下午 / 晚上）。估算时间写“约 00:02–00:04”，官方时间不加前缀。
- 数据时间写“更新于 / 核对于 + 北京时间”或相对时间；同一处不重复写两种时间。
- 来源链接只放一处：赛程行不放来源，分组弹窗与名单底部各有一个“官方来源”。
- 未知信息只在一处说明，未公布的数据不显示“待更新”。

## 数据契约

页面读取 `data/calendar.json`、`data/<id>.json`（赛程）、`data/updates.json` 和 `/api/v1/events/<id>/<resource>`。

- `calendar.json`：`stations[]`（`id`、`city`、`city_en`、`country`、`date_start`、`date_end`、`timezone`、`venue`、`detail_status`、`ticketing`、`predictions`、`source_url`）与 `championships[]`。`source_url` 是该站自己的 ISU 赛事页（尚未找到时为赛季赛历），未出赛程的分站与世锦赛页链接到它。
- `<id>.json` 的 `entries[]`：`round_key`（稳定）、当地与北京的日期时间、`session`（qualifying / repechage / main）、`gender`、`format`、`distance_m`、`round`、`group`（A / B）、`china`。
- `china.status` 为 `confirmed` 才高亮 CHN；`china.heats[]` 含 `number`、`athletes`、`estimate`（非官方估算区间）。
- `sync.last_successful_schedule_check_utc` 为空表示尚未成功核对，不能伪造时间。

## PWA

`web/manifest.webmanifest`、`web/icons/`、`web/sw.js`：先走网络，失败或 4 秒无响应才用缓存，离线时顶部显示“当前离线”。所有页面地址共用一份页面外壳缓存，带查询参数的接口请求不缓存，缓存只包含固定的一组文件。主屏幕图标的快捷入口由构建生成，指向最后一个比赛日尚未结束的分站（之后是世锦赛），每天两次的构建会把它切到下一站；已安装的应用要等浏览器重新读取清单后才会更新。缓存版本按页面外壳文件计算，发布后旧缓存自动清除。

图标源文件 `web/icons/icon.svg`（发光赛道 + 选手点，边缘渐变到 `#070B12`，与启动屏背景无缝），改完运行 `python3 tools/render_icons.py`。从主屏幕打开时先显示同款深色启动页，选手点逆时针滑行，首屏就绪后至少约 0.7 秒淡出。
