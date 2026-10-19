# 前端美化交接规范 · Ice Broadcast Control Room

**仅修改 web/index.html、web/site.css、web/app.js（展示层）；不要改 data/、tools/ 或官方时间。** 构建命令 python tools/build.py；GitHub Actions 将构建产物写入 dist/，不要直接长期编辑 dist。

## 视觉要求

- 背景 #0B1F33；数据面板 #102A43；主高亮 #55D6FF；辅助 #BFE8F5；警示/当前日期 #E63946；文字 #F7FBFF；次级文字 #7A8A99（小字号必要时提高对比）。
- 系统无衬线字体；时间、组别、轮次用等宽字体。
- 主页面要有赛事、温哥华站、Pacific Coliseum、日期、时区、官方数据核对状态。
- 清晰的时间表：日期、当地时间、北京时间、项目、轮次、组别、备注。桌面表格，手机横向滚动或卡片，不压小字。
- 中国队已确认的轮次**在主表默认高亮**，与“仅中国队”筛选无关。当前数据中没有真实官方分组，正确行为就是不显示 CHN 高亮。
- 非官方出场估算必须明确写“估算”，不和轮次官方开始时间混淆。
- 微弱背景细网格、弯道轨迹、计时器刻度可以用 CSS；不要外部图片、SVG 海报、外部字体、CDN。
- 悬停可轻微高亮，不做闪烁和大幅动画。打印白底黑字，隐藏控制按钮和装饰。

## 数据契约（不可改变字段语义）

页面请求相对路径 data/calendar.json 和 data/vancouver.json。

calendar.json:
- stations[]: id, city, city_en, date_start, date_end, timezone, venue, detail_status。

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

本项目是非 ISU 官方网站。