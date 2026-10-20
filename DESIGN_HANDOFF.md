# 前端美化交接规范 · Ice 赛事信息站

**仅修改 web/index.html、web/site.css、web/app.js（展示层）；不要改 data/、tools/ 或官方时间。** 构建命令 python tools/build.py；GitHub Actions 将构建产物写入 dist/，不要直接长期编辑 dist。

## 视觉要求

- 背景 #0B1F33；数据面板 #102A43；主高亮 #55D6FF；辅助 #BFE8F5；警示/当前日期 #E63946；文字 #F7FBFF；次级文字 #D3E1EE / 说明文字 #AFC2D3（深色背景下保证可读）。
- 系统无衬线字体；时间等数字用本地 DIN Alternate / Bahnschrift（回退系统字体）+ tabular-nums。
- 主页面要有赛事、温哥华站、Pacific Coliseum、日期、时区、官方数据核对状态。
- 清晰的时间表：日期、当地时间、北京时间、项目、轮次、组别、备注。桌面为标准表格；平板（681–1179px）每行两张赛程卡，手机（≤680px）单列赛程卡，极窄屏（≤350px）进一步压缩控件。单组时间与北京时间优先级分明，不强制横向滚动、不压小字。打印恢复完整七列表格。
- 中国队已确认的轮次**在主表默认高亮**，与“仅中国队”筛选无关。当前数据中没有真实官方分组，正确行为就是不显示 CHN 高亮。
- 非官方出场估算必须明确写“估算”，不和轮次官方开始时间混淆。
- 背景光晕、冰场轮廓用 CSS；赛道、图标均为 JS 生成的**内联 SVG**。不要外部图片、外部字体、CDN。
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

## 已实施的视觉版本（面向观众的赛事信息站）

定位是给观众看的赛事信息分享页，不是后台。原则：

- **色彩做减法**：只保留两种强高亮——中国队 = 红 `#E63946`，A 组决赛 / 奖牌赛 = 金 `#F4C95D`。其余全部为冰蓝中性色；男子/女子/混合标签低饱和。不再按资格赛/复活赛/决赛阶段分色，改用文字标题区分。
- **对比度**：次级文字提亮为 `#D3E1EE`（当地时间、轮次描述），最弱的说明文字也不低于 `#AFC2D3`。卡片与面板统一 `1px solid rgba(85,214,255,.2)` 细边框 + 圆角。
- **贴合观看场景**：所有北京时间都带时段（凌晨 / 早上 / 上午 / 中午 / 下午 / 晚上），方便判断要不要熬夜；比赛日按北京日期显示，并给出当天首项开赛时段和奖牌赛场数。
- 数字用本地 DIN Alternate / Bahnschrift（回退系统字体）+ `tabular-nums`，无外部字体。

**首页 `/`**
- 标题区之后是全宽的“下一站”主卡片：城市、日期、场馆、时差，大号倒计时（到首项开赛），下一项比赛，以及三个比赛日小卡（北京日期、首项时段、轮次数、奖牌赛数，点击直达 `/?station=vancouver&day=YYYY-MM-DD`）。赛道 SVG 仅作右侧小装饰（手机上为低透明度背景）。
- 赛季时间轴、七站卡片；卡片底部站序号水印透明度 0.05。

**分站页 `/?station=<id>`**
- 标题区（城市、日期、场馆、时差、ISU 暂定）、数字条（比赛日 / 轮次 / 奖牌赛 / 中国队已确认）、官方核对状态；右侧“下一项”倒计时卡与中国队状态。
- “三天赛程一览”：每个比赛日一条时间轴，浅色底带标出资格赛 / 复活赛 / 决赛阶段；普通轮次是细而暗的刻度，B 组决赛略亮，A 组决赛为粗亮金色刻度，中国队红色，红线为现在；点击刻度滚动到对应行。
- 奖牌赛面板：9 场 A 组决赛（手机上横向滑动）。
- **吸顶筛选栏**：比赛日标签（有奖牌赛的日子带金点）+“筛选”按钮（徽标显示已选条件数）+ 北京/当地切换。项目、轮次、“只看中国队”收进筛选面板（桌面下拉，手机底部抽屉，Esc / 点遮罩关闭）；已选条件在列表上方以可移除标签显示。`?day=` 可直接打开某一天。
- 平板/手机赛程卡为紧凑三栏：主时间 + 时段 /“当地”或“北京”次时间 | 项目 + 轮次 | A/B 组徽章；与日标题重复的日期（`.dt-same`）在卡片中隐藏，打印时恢复。
- 屏幕上的表格隐藏“日期”列（日标题已给出），打印恢复完整七列。
- 时间轴状态只依据**计划开赛时间**：已过去的轮次变暗，最近开赛的标“已开赛”，下一轮标“下一项”，两者之间插入“现在”分隔线；不代表实际比赛进度。

**深色 / 浅色主题**
- 默认跟随手机/系统的深浅色设置（`prefers-color-scheme`），系统切换时页面实时跟随。页眉太阳/月亮按钮可手动切换并记住（localStorage `ssts.theme`）；手动切回与系统一致的主题时清除记录，恢复跟随系统。`?theme=light` / `?theme=dark` 只在本次访问内生效（sessionStorage），不改变访客自己的设置。主题在 `index.html` 头部内联脚本中于首屏绘制前应用，同步更新 `theme-color`。
- 所有颜色都是 `site.css` 顶部的变量：`:root` 为深色，`:root[data-theme="light"]` 覆盖为浅色。半透明色调用 RGB 三元组变量（如 `rgb(var(--cyan-rgb) / .2)`），两套主题共用同一份样式规则；新增样式请只用变量，不要写死颜色。
- 浅色主题：页面 `#F3F8FC`、卡片白色、主色 `#0E7CC4`、正文 `#0B1F33`；中国队红与奖牌金保留，金色文字加深为 `#A66A00` 以保证白底可读。赛道 SVG 颜色同样由 CSS 变量控制。

**调试**：`?now=2026-10-25T01:20:00Z` 可预览比赛进行中的页面状态（仅前端时钟偏移，不改数据）。

**后端补充**：`calendar.json` 的 `stations[]` 新增 `country`（ISO 三字母，如 CAN / KOR / CHN），仅用于展示（中国站标记）。
