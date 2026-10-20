# 前端美化交接规范 · Ice Broadcast Control Room

**仅修改 web/index.html、web/site.css、web/app.js（展示层）；不要改 data/、tools/ 或官方时间。** 构建命令 python tools/build.py；GitHub Actions 将构建产物写入 dist/，不要直接长期编辑 dist。

## 视觉要求

- 背景 #0B1F33；数据面板 #102A43；主高亮 #55D6FF；辅助 #BFE8F5；警示/当前日期 #E63946；文字 #F7FBFF；次级文字 #7A8A99（小字号必要时提高对比）。
- 系统无衬线字体；时间、组别等数字用本地运动风格字体（DIN Alternate / Bahnschrift 回退系统字体）+ tabular-nums。
- 主页面要有赛事、温哥华站、Pacific Coliseum、日期、时区、官方数据核对状态。
- 清晰的时间表：日期、当地时间、北京时间、项目、轮次、组别、备注。桌面为标准表格；平板（681–1179px）每行两张赛程卡，手机（≤680px）单列赛程卡，极窄屏（≤350px）筛选控件也单列。单组时间与北京时间优先级分明，不强制横向滚动、不压小字。打印恢复完整七列表格。
- 中国队已确认的轮次**在主表默认高亮**，与“仅中国队”筛选无关。当前数据中没有真实官方分组，正确行为就是不显示 CHN 高亮。
- 非官方出场估算必须明确写“估算”，不和轮次官方开始时间混淆。
- 背景细网格、计时器刻度用 CSS；赛道、图标均为 JS 生成的**内联 SVG**。不要外部图片、外部字体、CDN。
- 动画限于赛道滑行光点、倒计时、入场淡入和“下一项”提示；`prefers-reduced-motion` 时全部停止。打印白底黑字，隐藏控制按钮和装饰。

## 数据契约（不可改变字段语义）

页面请求相对路径 data/calendar.json 和 data/vancouver.json。

calendar.json:
- stations[]: id, city, city_en, date_start, date_end, timezone, venue, country, detail_status。

vancouver.json:
- entries[]: id、round_key（随时间变化仍稳定）、local_date、local_time、local_start、utc_start、beijing_date、beijing_time、session、gender、format、distance_m、round、group、status、china。
- status=scheduled **不表示实际比赛进行中**。
- session: qualifying、repechage、main（决赛阶段含淘汰赛）。
- round: preliminaries（初赛）、heats（预赛）、quarterfinal、semifinal、final。final 的 group=A/B。
- china.status: unknown 或 confirmed；仅 confirmed 才能亮 CHN。
- china.heats[]: number、athletes[]、estimate（earliest_local、latest_local、earliest_beijing、latest_beijing、status=model_estimate_not_official）。
- sync.last_successful_schedule_check_utc: 最近全量官方赛程核对时间；为 null 时必须表示尚未成功同步，不要伪造时间戳。

## 页面与交互

首页展示七站赛历。单站详情通过 /?station=vancouver 等查询参数访问；只有温哥华有当前详细数据。其他六站提示“详细赛程尚未录入”，不能生成模拟赛程。

日期/项目/轮次筛选和北京时间/温哥华时间切换已有，可替换 DOM 和 CSS，不改变逻辑。不要额外添加登录、分享、通知、一键复制等未提出功能。

## 安全和正确性

- 数据插入 DOM 使用 textContent 或安全的等价方法；禁止未经转义的 innerHTML。
- 官方分组需具体到 round_key，不能以“报名500米”自动高亮“500米决赛”。
- 出场模型仅依小组编号和配置的单组时长上下限预测，并非官方逐组开赛时间。
- GitHub Actions 官网同步失败时保留上次可信快照，前端不能删除“核对未成功”提示。

UI 约定：不再显示大段免责声明、法律提示或重复的“分组未核实”文字。保留数据来源链接和必要的“估算”小标签即可。
## 已实施的响应式数据展示

- 保持单一语义表格 DOM；CSS 在平板和手机自动把每条比赛重排为卡片，表格和卡片使用同一份数据，不重复构建。
- `web/app.js` 给每个 `td` 写入随时区切换更新的 `data-label`，CSS 使用它展示卡片字段标题。请美化模型保留 `match-row`、`session-row`、`primary-time`、`secondary-time`、`event-cell`、`round-cell`、`group-cell`、`notes-cell` 这些结构类。
- `china-row` 的自动高亮跨设备保持一致，未知分组不高亮；`notes-cell` 仅在有中国队信息时出现。
- 筛选选择框最小触控高度 44px，输入字号不低于 16px；平板、手机均无页面级横向溢出。
- 桌面/平板/手机的打印样式统一恢复可阅读的完整表格，页面不显示多余免责声明。

## 已实施的视觉版本（Ice Broadcast · 体育转播风格）

整体语言参考体育赛事转播包装：斜切平行四边形标签（`clip-path`）、切角面板、斜体粗数字（本地 DIN Alternate / Bahnschrift，无外部字体）、计分板式倒计时、描边大字水印（SHORT TRACK / 城市英文名 / 分站编号）、奥运图标风格的滑行者 SVG 与速度线、斜向速度纹背景与椭圆冰场轮廓。时间等数字不再使用等宽字体，改用 `tabular-nums` 保证对齐。

平板/手机赛程卡为紧凑三栏（约 60px 高）：左栏主时间 + “当地/北京”次时间，中栏项目与轮次，右栏 A/B 组徽章；与日标题重复的日期（`.dt-same`）在卡片中隐藏，打印时恢复。

**首页 `/`**
- 主视觉：标准 111.12m 短道赛道 SVG（逆时针滑行光点 + 拖尾、弯道标志块），旁边是“下一站／正在进行”卡片，含到首项开赛（有逐项赛程时）或开幕日（当地 0 点）的实时倒计时。
- 赛季时间轴：按日期比例排布七站，红色三角为今天；已结束分站变暗。
- 分站卡片：阶段号、状态（进行中 / 下一站·N 天后 / 已结束）、日期与星期、UTC 偏移及与北京时差、场馆、是否已录入；中国站（`country=CHN`）带“中国站”标记。

**分站页 `/?station=<id>`**
- 顶部分站切换条（可横向滑动，自动居中当前站）+ 页眉双时钟（北京 / 当地）。
- 主卡片：下一项倒计时、项目轮次、北京与当地开赛时间、“定位到赛程”；下方一行中国队状态（无已确认分组时仅显示“官方分组公布后自动标记”）。
- KPI：比赛日、轮次、奖牌赛（A 组决赛）数量、中国队已确认轮次；官方核对时间以相对时间显示，`last_successful_schedule_check_utc` 为 null 时显示红色“核对尚未成功”。
- 赛程总览：每个当地比赛日一条时间轴，刻度颜色区分资格赛 / 复活赛 / 决赛阶段，金色 = A 组决赛，红色 = 已确认中国队，红色竖线 = 现在；点击刻度滚动到对应行。
- 奖牌赛面板：全部 A 组决赛及时间（手机上为可横滑卡片条）。
- 筛选：分段按钮（日期 / 项目 / 轮次 / 时区）+“仅中国队”（无已确认数据时禁用）+ 重置。筛选语义与原线框相同；时区偏好保存在 localStorage。
- 屏幕上的表格隐藏“日期”列（日分组标题已给出当地与北京日期，时间单元格内也带日期），打印时恢复完整七列。
- 时间轴状态只依据**计划开赛时间**：已过去的轮次变暗，最近开赛的标“已开赛”，下一轮标“下一项”，两者之间插入“现在”分隔线；不代表实际比赛进度。

**调试**：`?now=2026-10-25T01:20:00Z` 可预览比赛进行中的页面状态（仅前端时钟偏移，不改数据）。

**颜色补充**：资格赛 `#55D6FF`、复活赛 `#A99BFF`、决赛阶段 `#4FE3B5`、A 组决赛金 `#F4C95D`、B 组银 `#C3D1DE`、中国队红 `#E63946` 配金星。

**后端补充**：`calendar.json` 的 `stations[]` 新增 `country`（ISO 三字母，如 CAN / KOR / CHN），仅用于展示。
