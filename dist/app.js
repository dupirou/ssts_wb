/* SSTS-WB presentation layer. Reads data/*.json only; never alters official times.
   All data reaches the DOM through textContent / attributes (no innerHTML). */
(async function () {
  'use strict';
  const root = document.getElementById('app');
  const clocks = document.getElementById('clocks');
  const params = new URLSearchParams(location.search);
  // ?now=2026-10-24T17:00:00Z previews the live states; it never changes data.
  const previewNow = Date.parse(params.get('now') || '');
  const skew = Number.isFinite(previewNow) ? previewNow - Date.now() : 0;
  const now = () => Date.now() + skew;
  const BJ = 'Asia/Shanghai';
  const DAY = 86400000;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- DOM helpers ---------- */
  function h(name, props, ...kids) {
    const el = document.createElement(name);
    setProps(el, props);
    append(el, kids);
    return el;
  }
  function s(name, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
    append(el, kids);
    return el;
  }
  function setProps(el, props) {
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }
  // replaceChildren() would print null/false; fill() skips them like h().
  const fill = (el, ...kids) => { el.replaceChildren(); append(el, kids); return el; };
  const external = (href, ...kids) => h('a', {href, target: '_blank', rel: 'noopener noreferrer'}, ...kids, icon('external', 'ico ico-xs'));
  const cls = (...names) => names.filter(Boolean).join(' ');

  const ICONS = {
    calendar: [['rect', {x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5}], ['path', {d: 'M3.5 10h17M8 3v4M16 3v4'}]],
    pin: [['path', {d: 'M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z'}], ['circle', {cx: 12, cy: 10, r: 2.4}]],
    globe: [['circle', {cx: 12, cy: 12, r: 8.5}], ['path', {d: 'M3.5 12h17M12 3.5c2.8 3 2.8 14 0 17M12 3.5c-2.8 3-2.8 14 0 17'}]],
    star: [['path', {d: 'M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.6l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z', class: 'fill'}]],
    medal: [['path', {d: 'M8 3l2.6 6M16 3l-2.6 6'}], ['circle', {cx: 12, cy: 14.5, r: 5.5}], ['path', {d: 'M12 12v5'}]],
    back: [['path', {d: 'M14.5 6l-6 6 6 6'}]],
    arrow: [['path', {d: 'M5 12h13M13 7l5 5-5 5'}]],
    down: [['path', {d: 'M12 5v13M7 13l5 5 5-5'}]],
    up: [['path', {d: 'M12 19V6M7 11l5-5 5 5'}]],
    external: [['path', {d: 'M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'}]],
    relay: [['path', {d: 'M4 9h13l-3-3M20 15H7l3 3'}]],
    check: [['path', {d: 'M5 12.5l4.2 4.2L19 7'}]],
    alert: [['path', {d: 'M12 4l9 16H3z'}], ['path', {d: 'M12 10v4.5M12 17.2v.3'}]],
    filter: [['path', {d: 'M4 6.5h16M7 12h10M10 17.5h4'}]],
    close: [['path', {d: 'M6 6l12 12M18 6L6 18'}]],
    sun: [['circle', {cx: 12, cy: 12, r: 4}], ['path', {d: 'M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6'}]],
    moon: [['path', {d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'}]]
  };
  function icon(name, className) {
    return s('svg', {viewBox: '0 0 24 24', class: className || 'ico', 'aria-hidden': 'true', focusable: 'false'},
      ICONS[name].map(([tag, attrs]) => s(tag, attrs)));
  }

  /* ---------- time helpers ---------- */
  const WEEK = '日一二三四五六';
  const pad = n => String(n).padStart(2, '0');
  const md = iso => Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
  const dot = iso => iso.slice(5, 7) + '.' + iso.slice(8, 10);
  const wk = iso => '周' + WEEK[new Date(iso.slice(0, 10) + 'T12:00:00Z').getUTCDay()];
  // Viewers in China decide by "is this 凌晨 or 上午", so every headline time carries it.
  function dayPart(hm) {
    const hr = Number(hm.slice(0, 2));
    return hr < 6 ? '凌晨' : hr < 9 ? '早上' : hr < 12 ? '上午' : hr < 13 ? '中午' : hr < 18 ? '下午' : '晚上';
  }
  const fmtCache = {};
  function parts(tz, t) {
    const f = fmtCache[tz] ??= new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
    const o = {};
    for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
    return {date: o.year + '-' + o.month + '-' + o.day, hm: o.hour + ':' + o.minute, sec: o.second,
      utc: Date.UTC(+o.year, o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second)};
  }
  const tzOffset = (tz, t) => Math.round((parts(tz, t).utc - Math.floor(t / 1000) * 1000) / 60000);
  function zoned(date, hm, tz) {
    const guess = Date.parse(date + 'T' + hm + ':00Z');
    return guess - tzOffset(tz, guess - tzOffset(tz, guess) * 60000) * 60000;
  }
  function utcLabel(tz, t) {
    const m = tzOffset(tz, t);
    return 'UTC' + (m < 0 ? '−' : '+') + (Math.abs(m) / 60);
  }
  function bjDiff(tz, t) {
    const d = (tzOffset(tz, t) - tzOffset(BJ, t)) / 60;
    return d === 0 ? '与北京时间相同' : (d < 0 ? '比北京晚 ' : '比北京早 ') + Math.abs(d) + ' 小时';
  }
  function ago(t) {
    const m = Math.max(0, Math.round((now() - t) / 60000));
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 48 * 60) return Math.round(m / 60) + ' 小时前';
    return Math.round(m / 1440) + ' 天前';
  }
  function split(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return {d: Math.floor(total / 86400), h: Math.floor(total / 3600) % 24, m: Math.floor(total / 60) % 60, s: total % 60};
  }
  const bjWhen = r => md(r.beijing_date) + ' ' + wk(r.beijing_date) + ' ' + dayPart(r.beijing_time) + ' ' + r.beijing_time;

  /* One shared 1s heartbeat drives clocks, countdowns and the live row state. */
  const tickers = new Set();
  setInterval(() => tickers.forEach(fn => fn()), 1000);
  function tick(fn) { tickers.add(fn); fn(); }

  function setClocks(zones) {
    clocks.replaceChildren();
    const items = zones.map(([label, tz]) => {
      const hm = h('span'), sec = h('span', {class: 'sec'});
      clocks.append(h('span', {class: 'clock'}, h('small', {text: label}), h('b', {class: 'num'}, hm, sec)));
      return [hm, sec, tz];
    });
    tick(() => {
      const t = now();
      for (const [hm, sec, tz] of items) {
        const p = parts(tz, t);
        hm.textContent = p.hm;
        sec.textContent = ':' + p.sec;
      }
    });
  }

  function countdown(className) {
    const el = h('div', {class: 'countdown ' + (className || ''), role: 'timer'});
    const cells = ['d', 'h', 'm', 's'].map(k => {
      const v = h('b', {class: 'num'});
      el.append(h('span', {class: 'cd-' + k}, v, h('small', {text: {d: '天', h: '时', m: '分', s: '秒'}[k]})));
      return [k, v];
    });
    el.set = ms => {
      const p = split(ms);
      el.classList.toggle('no-days', p.d === 0);
      for (const [k, v] of cells) v.textContent = k === 'd' ? String(p.d) : pad(p[k]);
    };
    return el;
  }

  /* Light/dark switch. index.html applies the stored theme before first paint. */
  function themeToggle() {
    const html = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    const btn = h('button', {type: 'button', class: 'theme-btn', onclick: () => apply(html.dataset.theme === 'light' ? 'dark' : 'light', true)},
      icon('sun', 'ico ico-sun'), icon('moon', 'ico ico-moon'));
    function apply(theme, save) {
      html.dataset.theme = theme;
      if (meta) meta.content = theme === 'light' ? '#F3F8FC' : '#0B1F33';
      btn.setAttribute('aria-label', theme === 'light' ? '切换为深色主题' : '切换为浅色主题');
      btn.title = btn.getAttribute('aria-label');
      if (save) { try { localStorage.setItem('ssts.theme', theme); } catch (_) { /* private mode */ } }
    }
    apply(html.dataset.theme === 'light' ? 'light' : 'dark', false);
    return btn;
  }
  clocks.after(themeToggle());

  /* ---------- naming ---------- */
  const gender = {women: '女子', men: '男子', mixed: '混合'};
  const roundNames = {preliminaries: '初赛', heats: '预赛', quarterfinal: '1/4决赛', semifinal: '半决赛', final: '决赛'};
  const ROUND_ORDER = ['preliminaries', 'heats', 'quarterfinal', 'semifinal', 'final'];
  const session = {qualifying: '资格赛', repechage: '复活赛', main: '决赛阶段'};
  const sessionNote = {qualifying: '', repechage: '', main: '含淘汰赛'};
  const eventName = r => gender[r.gender] + ' ' + r.distance_m + 'm' + (r.format === 'relay' ? ' 接力' : '');
  const roundName = r => r.round === 'final' ? r.group + '组决赛' : roundNames[r.round];
  const isChina = r => r.china && r.china.status === 'confirmed';
  const isMedal = r => r.round === 'final' && r.group === 'A';

  function stageMeter(r) {
    const at = ROUND_ORDER.indexOf(r.round);
    return h('span', {class: 'meter', 'aria-hidden': 'true'},
      ROUND_ORDER.map((_, i) => h('i', {class: i < at ? 'done' : i === at ? 'on' : ''})));
  }

  /* ---------- decorative rink ---------- */
  let uid = 0;
  function trackArt(className, skaters = 3) {
    const id = 'trk' + (++uid);
    // Counter-clockwise lap, as raced. Straights x 130→270, curve radius 55.
    const lap = 'M270 45H130A55 55 0 0 0 130 155H270A55 55 0 0 0 270 45Z';
    const svg = s('svg', {viewBox: '0 0 400 200', class: 'track-art ' + (className || ''), 'aria-hidden': 'true'},
      s('defs', {},
        s('linearGradient', {id: id + 'ice', x1: 0, y1: 0, x2: 1, y2: 1},
          s('stop', {offset: '0', class: 'rk-a'}), s('stop', {offset: '1', class: 'rk-b'})),
        s('radialGradient', {id: id + 'glow'},
          s('stop', {offset: '0', class: 'rk-glow', 'stop-opacity': '.9'}), s('stop', {offset: '1', class: 'rk-glow', 'stop-opacity': '0'})),
        s('path', {id: id + 'lap', d: lap})),
      // Colours come from CSS classes so the rink follows the light/dark theme.
      s('rect', {x: 18, y: 8, width: 364, height: 184, rx: 92, fill: 'url(#' + id + 'ice)', class: 'rk-edge', 'stroke-width': 1.5}),
      s('path', {d: 'M200 8V192', class: 'rk-red', 'stroke-width': 1.2}),
      s('circle', {cx: 200, cy: 100, r: 20, fill: 'none', class: 'rk-red', 'stroke-width': 1.2}),
      [62, 72].map(r => s('path', {d: `M270 ${100 - r}H130A${r} ${r} 0 0 0 130 ${100 + r}H270A${r} ${r} 0 0 0 270 ${100 - r}Z`,
        fill: 'none', class: 'rk-lane', 'stroke-width': 1, 'stroke-dasharray': '3 5'})),
      s('use', {href: '#' + id + 'lap', fill: 'none', class: 'rk-lap', 'stroke-width': 1.6}),
      // Seven blocks on each curve, as on a real short track rink.
      [-90, -60, -30, 0, 30, 60, 90].flatMap(a => {
        const rad = a * Math.PI / 180;
        return [s('circle', {cx: 130 - 55 * Math.cos(rad), cy: 100 + 55 * Math.sin(rad), r: 2.4, class: 'block'}),
          s('circle', {cx: 270 + 55 * Math.cos(rad), cy: 100 + 55 * Math.sin(rad), r: 2.4, class: 'block'})];
      }),
      Array.from({length: skaters}, (_, i) => {
        const begin = (-i * 0.6 - 0.2).toFixed(2) + 's';
        const dur = '8s';
        return s('g', {},
          s('use', {href: '#' + id + 'lap', fill: 'none', class: i ? 'rk-trail' : 'rk-trail rk-lead', 'stroke-width': 3, 'stroke-linecap': 'round',
            pathLength: 100, 'stroke-dasharray': '7 93', opacity: .5},
            s('animate', {attributeName: 'stroke-dashoffset', from: 7, to: -93, dur, begin, repeatCount: 'indefinite'})),
          s('circle', {r: 9, fill: 'url(#' + id + 'glow)'},
            s('animateMotion', {dur, begin, repeatCount: 'indefinite'}, s('mpath', {href: '#' + id + 'lap'}))),
          s('circle', {r: 3.4, class: i ? 'rk-dot' : 'rk-dot rk-lead'},
            s('animateMotion', {dur, begin, repeatCount: 'indefinite'}, s('mpath', {href: '#' + id + 'lap'}))));
      }));
    if (reduceMotion) queueMicrotask(() => svg.pauseAnimations && svg.pauseAnimations());
    return svg;
  }

  /* ---------- data ---------- */
  const fetchData = async file => {
    const response = await fetch('./data/' + file, {cache: 'no-cache'});
    if (!response.ok) throw new Error('数据请求失败: ' + response.status);
    return response.json();
  };
  function prepare(data) {
    data.entries.forEach((r, i) => { r.t = Date.parse(r.utc_start); r.i = i; });
    return data;
  }
  function stationWindow(st, detail) {
    if (detail && detail.entries.length) {
      const e = detail.entries;
      return {start: e[0].t, end: e[e.length - 1].t + 45 * 60000, exact: true};
    }
    return {start: zoned(st.date_start, '00:00', st.timezone), end: zoned(st.date_end, '23:59', st.timezone) + 60000, exact: false};
  }
  const phase = w => now() < w.start ? 'upcoming' : now() < w.end ? 'live' : 'done';
  function liveIndex(entries) {
    const next = entries.findIndex(r => r.t > now());
    return next < 0 ? entries.length : next;
  }
  // One entry per competition day (local date), with what a viewer cares about.
  function raceDays(entries) {
    const days = [];
    for (const r of entries) {
      let d = days[days.length - 1];
      if (!d || d.local !== r.local_date) days.push(d = {local: r.local_date, n: days.length + 1, items: []});
      d.items.push(r);
    }
    for (const d of days) {
      d.first = d.items[0];
      d.last = d.items[d.items.length - 1];
      d.bj = d.first.beijing_date;
      d.medals = d.items.filter(isMedal).length;
      d.china = d.items.filter(isChina).length;
    }
    return days;
  }
  const stationHref = (id, day) => '?station=' + encodeURIComponent(id) + (day ? '&day=' + encodeURIComponent(day) : '');

  /* ---------- season page ---------- */
  function renderSeason(cal, details) {
    setClocks([['北京时间', BJ]]);
    const stations = cal.stations.map((st, i) => ({...st, n: i + 1, win: stationWindow(st, details[st.id]), detail: details[st.id]}));
    const focus = stations.find(st => phase(st.win) === 'live') || stations.find(st => phase(st.win) === 'upcoming');
    const first = stations[0], last = stations[stations.length - 1];

    const head = h('section', {class: 'season-head'},
      h('p', {class: 'eyebrow', text: 'ISU 短道速滑世界巡回赛'}),
      h('h1', {}, cal.season + ' 赛季赛程'),
      h('p', {class: 'lead'}, stations.length + ' 站 · ' + first.date_start.slice(0, 7).replace('-', '.') + ' — ' +
        last.date_end.slice(0, 7).replace('-', '.') + ' · 全部时间已换算为北京时间'));

    root.replaceChildren(head,
      focus ? nextCard(focus) : h('section', {class: 'next-card is-done'}, h('h2', {text: '本赛季全部分站已结束'})),
      seasonLine(stations, focus), stationGrid(stations, focus),
      h('p', {class: 'source-line'}, '赛历来源：', external(cal.source_url, 'ISU 官方赛历')));
  }

  // The centrepiece: where and when the next racing happens, in Beijing time.
  function nextCard(st) {
    const live = phase(st.win) === 'live';
    const cd = countdown('cd-xl');
    const label = h('p', {class: 'next-label'});
    const item = h('p', {class: 'next-item'});
    const main = h('div', {class: 'next-main'},
      h('p', {class: 'next-kicker'},
        h('span', {class: cls('pill', live ? 'pill-live' : 'pill-accent')}, live ? h('i', {class: 'pulse'}) : null, live ? '正在进行' : '下一站'),
        h('span', {text: '第 ' + st.n + ' 站'})),
      h('h2', {class: 'next-city'}, st.city + '站', h('small', {text: st.city_en})),
      h('ul', {class: 'meta-list'},
        h('li', {}, icon('calendar'), dot(st.date_start) + ' ' + wk(st.date_start) + ' — ' + dot(st.date_end) + ' ' + wk(st.date_end)),
        h('li', {}, icon('pin'), st.venue || '场馆待公布'),
        h('li', {}, icon('globe'), '当地' + bjDiff(st.timezone, st.win.start).replace('与北京时间相同', '与北京同时区'))),
      h('div', {class: 'next-count'}, label, cd, item));
    if (st.detail) {
      main.append(h('ul', {class: 'day-chips'}, raceDays(st.detail.entries).map(d => h('li', {},
        h('a', {href: stationHref(st.id, d.local)},
          h('b', {}, wk(d.bj) + ' ', h('span', {class: 'num', text: md(d.bj)})),
          h('span', {}, dayPart(d.first.beijing_time) + ' ', h('span', {class: 'num', text: d.first.beijing_time}), ' 开赛'),
          h('small', {}, d.items.length + ' 轮', d.medals ? h('em', {class: 'gold-text'}, ' · ' + d.medals + ' 场奖牌赛') : null))))));
    }
    main.append(h('a', {class: 'btn', href: stationHref(st.id)}, st.detail ? '查看完整赛程' : '查看分站信息', icon('arrow')));
    tick(() => {
      let target = st.win.start;
      if (st.detail) {
        const e = st.detail.entries, i = liveIndex(e);
        if (i < e.length) {
          target = e[i].t;
          label.textContent = i === 0 ? '距首项开赛还有' : '距下一项开赛还有';
          item.textContent = eventName(e[i]) + ' ' + roundName(e[i]) + ' · 北京时间 ' + bjWhen(e[i]);
        } else {
          label.textContent = '全部轮次已按计划开赛';
          item.textContent = '';
        }
      } else {
        label.textContent = '距开幕还有';
        item.textContent = '按当地时间 ' + dot(st.date_start) + ' 0 点计算 · 逐项赛程待官方公布';
      }
      cd.hidden = target < now();
      cd.set(target - now());
    });
    return h('section', {class: cls('next-card', live && 'is-live'), 'aria-label': (live ? '正在进行：' : '下一站：') + st.city},
      main, h('div', {class: 'next-art', 'aria-hidden': 'true'}, trackArt('next-track')));
  }

  function seasonLine(stations, focus) {
    const from = Date.parse(stations[0].date_start.slice(0, 8) + '01T00:00:00Z');
    const endD = new Date(stations[stations.length - 1].date_end + 'T00:00:00Z');
    const to = Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth() + 1, 1);
    const pos = t => Math.min(100, Math.max(0, (t - from) / (to - from) * 100));
    const today = parts(BJ, now()).date;
    const todayPct = pos(Date.parse(today + 'T12:00:00Z'));
    const line = h('div', {class: 'sl'},
      h('div', {class: 'sl-rail'}, h('i', {class: 'sl-progress', style: {width: todayPct + '%'}})));
    for (let m = new Date(from); m < to; m.setUTCMonth(m.getUTCMonth() + 1)) {
      line.append(h('span', {class: 'sl-month', style: {left: pos(m.getTime()) + '%'}}, h('span', {text: (m.getUTCMonth() + 1) + '月'})));
    }
    if (todayPct > 0 && todayPct < 100) line.append(h('span', {class: 'sl-today', style: {left: todayPct + '%'}, title: '今天 ' + md(today)}));
    for (const st of stations) {
      line.append(h('a', {class: cls('sl-node', st.n % 2 ? 'up' : 'down', 'is-' + phase(st.win), st === focus && 'is-focus', st.country === 'CHN' && 'is-home'),
        href: stationHref(st.id), style: {left: pos(Date.parse(st.date_start + 'T12:00:00Z')) + '%'},
        'aria-label': '第' + st.n + '站 ' + st.city + ' ' + st.date_start},
        h('span', {class: 'sl-dot num', text: st.n}),
        h('span', {class: 'sl-label'}, h('b', {text: st.city}), h('small', {class: 'num', text: md(st.date_start)}))));
    }
    const nextDays = focus && phase(focus.win) === 'upcoming' ? Math.ceil((focus.win.start - now()) / DAY) : null;
    return h('section', {class: 'panel season-line', 'aria-label': '赛季时间轴'},
      h('div', {class: 'panel-head'},
        h('h2', {text: '赛季时间轴'}),
        h('p', {}, h('i', {class: 'legend-today'}), '今天 ' + md(today) + ' ' + wk(today),
          nextDays != null ? ' · 距' + focus.city + '站还有 ' + nextDays + ' 天' : focus ? ' · ' + focus.city + '站进行中' : '')),
      line);
  }

  function stationGrid(stations, focus) {
    const grid = h('div', {class: 'st-grid'});
    for (const st of stations) {
      const ph = phase(st.win);
      const days = Math.ceil((st.win.start - now()) / DAY);
      const pill = ph === 'live' ? h('span', {class: 'pill pill-live'}, h('i', {class: 'pulse'}), '进行中')
        : ph === 'done' ? h('span', {class: 'pill', text: '已结束'})
        : h('span', {class: cls('pill', st === focus && 'pill-accent'), text: (st === focus ? '下一站 · ' : '') + days + ' 天后'});
      grid.append(h('a', {class: cls('st-card', 'is-' + ph, st === focus && 'is-focus', st.detail && 'has-detail'),
        href: stationHref(st.id), style: {'--d': (st.n * 50) + 'ms'}},
        h('span', {class: 'st-num num', 'aria-hidden': 'true', text: pad(st.n)}),
        h('div', {class: 'st-top'}, h('span', {class: 'stage', text: '第 ' + st.n + ' 站'}), pill),
        h('h3', {}, st.city, h('small', {text: st.city_en}),
          st.country === 'CHN' ? h('em', {class: 'home-tag'}, icon('star', 'ico ico-xs'), '中国站') : null),
        h('p', {class: 'st-date'}, h('span', {class: 'num', text: dot(st.date_start) + ' — ' + dot(st.date_end)}),
          h('small', {text: wk(st.date_start) + '至' + wk(st.date_end).slice(1)})),
        h('ul', {class: 'meta-list'},
          h('li', {}, icon('globe'), utcLabel(st.timezone, st.win.start) + ' · ' + bjDiff(st.timezone, st.win.start)),
          h('li', {}, icon('pin'), st.venue || '场馆待公布')),
        h('p', {class: 'st-foot'}, st.detail
          ? [h('span', {class: 'ok-text'}, icon('check'), '已录入 ' + st.detail.entries.length + ' 个轮次'), icon('arrow')]
          : h('span', {text: '逐项赛程待官方公布'}))));
    }
    return h('section', {'aria-label': '七站赛历'}, h('h2', {class: 'section-title', text: '全部分站'}), grid);
  }

  /* ---------- station page ---------- */
  function stationNav(cal, current) {
    const list = h('div', {class: 'st-nav-list'}, cal.stations.map((st, i) => h('a', {href: stationHref(st.id),
      'aria-current': st.id === current.id ? 'page' : null},
      h('small', {class: 'num', text: i + 1}), st.city)));
    // Keep the current stage visible in the horizontally scrolling list.
    requestAnimationFrame(() => {
      const a = list.querySelector('[aria-current]');
      if (a) list.scrollLeft += a.getBoundingClientRect().left - list.getBoundingClientRect().left - (list.clientWidth - a.offsetWidth) / 2;
    });
    return h('nav', {class: 'st-nav', 'aria-label': '分站切换'}, h('a', {class: 'back', href: './'}, icon('back'), '全部分站'), list);
  }

  function renderStation(cal, station, data) {
    const idx = cal.stations.indexOf(station) + 1;
    setClocks([['北京时间', BJ], [station.city, station.timezone]]);
    const win = stationWindow(station, data);
    const entries = data ? data.entries : [];
    const chinaCount = entries.filter(isChina).length;

    const copy = h('div', {class: 'hero-copy'},
      h('p', {class: 'eyebrow', text: '第 ' + idx + ' 站 · ' + cal.season + ' ISU 短道速滑世界巡回赛'}),
      h('h1', {}, station.city + '站', h('small', {text: station.city_en})),
      h('ul', {class: 'meta-list meta-inline'},
        h('li', {}, icon('calendar'), dot(station.date_start) + ' ' + wk(station.date_start) + ' — ' + dot(station.date_end) + ' ' + wk(station.date_end)),
        h('li', {}, icon('pin'), station.venue || '场馆待公布'),
        h('li', {}, icon('globe'), utcLabel(station.timezone, win.start) + ' · ' + bjDiff(station.timezone, win.start)),
        data && data.status === 'provisional' ? h('li', {class: 'pill', text: 'ISU 暂定赛程'}) : null));
    if (data) {
      copy.append(h('dl', {class: 'stats'},
        stat(Object.keys(data.day_counts).length, '比赛日'),
        stat(entries.length, '个轮次'),
        stat(entries.filter(isMedal).length, '场奖牌赛', 'stat-gold'),
        stat(chinaCount || '—', '中国队已确认', chinaCount ? 'stat-red' : 'stat-dim')));
      copy.append(syncLine(data));
    }
    root.replaceChildren(stationNav(cal, station),
      h('section', {class: 'station-hero'}, copy, data ? liveCard(data, station) : pendingCard(win)));

    if (!data) {
      root.append(h('section', {class: 'panel empty-state'},
        trackArt('empty-track', 2),
        h('h2', {text: '详细赛程尚未录入'}),
        h('p', {text: 'ISU 公布' + station.city + '站逐项赛程并完成核对后，这里会显示全部轮次与北京时间。'}),
        h('p', {}, external(cal.source_url, 'ISU 官方赛历'))));
      return;
    }
    scheduleView(data, station);
  }

  const stat = (v, label, className) => h('div', {class: cls('stat', className)}, h('dd', {class: 'num', text: v}), h('dt', {text: label}));

  function syncLine(data) {
    const at = data.sync && data.sync.last_successful_schedule_check_utc;
    if (!at) return h('p', {class: 'sync sync-bad'}, icon('alert'), '官方赛程核对尚未成功，当前显示上次可信快照');
    const t = Date.parse(at);
    const rel = h('span');
    const p = parts(BJ, t);
    tick(() => { rel.textContent = ago(t); });
    return h('p', {class: 'sync'}, h('i', {class: 'dot-ok'}), '已与 ISU 官方赛程核对 · ', rel,
      h('span', {class: 'faint', text: '（' + md(p.date) + ' ' + p.hm + '）'}));
  }

  function pendingCard(win) {
    const cd = countdown('cd-lg');
    const ph = phase(win);
    tick(() => cd.set(win.start - now()));
    const p = parts(BJ, win.start);
    return h('aside', {class: 'live-card'},
      h('p', {class: 'live-label', text: ph === 'upcoming' ? '距开幕还有' : ph === 'live' ? '本站正在进行' : '本站已结束'}),
      ph === 'upcoming' ? cd : null,
      h('p', {class: 'live-sub', text: '按当地 0 点计算 · 北京时间 ' + md(p.date) + ' ' + wk(p.date) + ' ' + dayPart(p.hm) + ' ' + p.hm}));
  }

  function liveCard(data, station) {
    const e = data.entries;
    const label = h('p', {class: 'live-label'});
    const cd = countdown('cd-lg');
    const title = h('p', {class: 'live-event'});
    const times = h('p', {class: 'live-times'});
    const jump = h('button', {type: 'button', class: 'btn btn-ghost', onclick: () => scrollToRow(e[liveIndex(e)])}, icon('down'), '定位到赛程');
    const card = h('aside', {class: 'live-card', 'aria-label': '下一项'}, label, cd, title, times, jump, chinaLine(e));
    let last = -1;
    tick(() => {
      const i = liveIndex(e);
      if (i >= e.length) {
        if (last !== i) {
          label.textContent = now() < e[e.length - 1].t + 45 * 60000 ? '最后一项已按计划开赛' : '本站赛程已全部完成';
          cd.hidden = true; jump.hidden = true;
          title.textContent = e.length + ' 个轮次 · 详见下方赛程';
          times.textContent = '';
        }
      } else {
        if (last !== i) {
          const r = e[i];
          label.textContent = i === 0 ? '距首项开赛还有' : '距下一项开赛还有';
          fill(title, h('b', {text: eventName(r)}), ' ' + roundName(r),
            isMedal(r) ? h('span', {class: 'pill pill-gold'}, icon('medal', 'ico ico-xs'), '奖牌赛') : null,
            isChina(r) ? h('span', {class: 'chn-tag'}, icon('star', 'ico ico-xs'), '中国队') : null);
          fill(times,
            h('span', {class: 'bj'}, '北京 ' + md(r.beijing_date) + ' ' + wk(r.beijing_date) + ' ' + dayPart(r.beijing_time) + ' ', h('b', {class: 'num', text: r.beijing_time})),
            h('span', {}, station.city + ' ' + md(r.local_date) + ' ' + wk(r.local_date) + ' ', h('span', {class: 'num', text: r.local_time})));
        }
        cd.set(e[i].t - now());
      }
      last = i;
    });
    return card;
  }

  function chinaLine(entries) {
    const box = h('div', {class: 'china-line'});
    tick(() => {
      const r = entries.find(x => isChina(x) && x.t > now());
      const key = r ? r.id : 'none';
      if (box.dataset.key === key) return;
      box.dataset.key = key;
      if (!r) {
        fill(box, icon('star', 'ico star-ico'), h('span', {}, h('b', {text: '中国队'}),
          entries.some(isChina) ? ' 已确认的场次均已开赛' : ' 官方分组公布后，这里和赛程中会自动标出'));
        return;
      }
      const hs = r.china.heats;
      fill(box, icon('star', 'ico star-ico'), h('span', {}, h('b', {text: '中国队下一场 '}),
        eventName(r) + ' ' + roundName(r) + ' 第' + hs.map(x => x.number).join('、') + '组 · 北京 ' + bjWhen(r),
        h('small', {}, ' · 预计出场 ' + hs[0].estimate.earliest_beijing.slice(11, 16) + ' 起', h('em', {class: 'est-tag', text: '估算'}))));
    });
    return box;
  }

  const view = {};
  function scrollToRow(r) {
    if (!r) return;
    let row = document.getElementById('r-' + r.id);
    if (!row && view.reset) { view.reset(); row = document.getElementById('r-' + r.id); }
    if (!row) return;
    row.scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth', block: 'center'});
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }

  function storedZone() {
    try { return localStorage.getItem('ssts.zone') === 'local' ? 'local' : 'beijing'; } catch (_) { return 'beijing'; }
  }

  function scheduleView(data, station) {
    const entries = data.entries;
    const days = raceDays(entries);
    const blank = {day: 'all', gender: 'all', stage: 'all', china: false};
    const state = {...blank, zone: storedZone()};
    if (days.some(d => d.local === params.get('day'))) state.day = params.get('day');
    const chinaCount = entries.filter(isChina).length;
    const genderOpts = [['all', '全部'], ['women', '女子'], ['men', '男子'], ['mixed', '混合'], ['relay', '接力']];
    const stageOpts = [['all', '全部'], ['qualifying', '资格赛'], ['repechage', '复活赛'], ['main', '决赛阶段'], ['final', 'A/B组决赛']];

    const overview = h('section', {class: 'overview'});
    const counter = h('div', {class: 'counter', 'aria-live': 'polite'});
    const container = h('div', {class: 'days'});
    const set = patch => { Object.assign(state, patch); redraw(); };
    view.reset = () => { Object.assign(state, blank); redraw(); };

    /* Sticky bar: day tabs, a filter button with a panel, and the time-zone switch. */
    const dayTabs = h('div', {class: 'fb-days', role: 'group', 'aria-label': '比赛日'});
    const zoneSeg = h('div', {class: 'fb-zone', role: 'group', 'aria-label': '时间显示'});
    const badge = h('span', {class: 'fb-badge num'});
    const panelId = 'filter-panel';
    const filterBtn = h('button', {type: 'button', class: 'fb-btn', 'aria-expanded': 'false', 'aria-controls': panelId,
      onclick: () => toggle(panel.hidden)}, icon('filter'), h('span', {class: 'fb-btn-text', text: '筛选'}), badge);
    const genderSeg = h('div', {class: 'chips-row', role: 'group', 'aria-label': '项目'});
    const stageSeg = h('div', {class: 'chips-row', role: 'group', 'aria-label': '轮次'});
    const chinaBtn = h('button', {type: 'button', class: 'toggle-chn', disabled: chinaCount ? null : true,
      onclick: () => set({china: !state.china})}, icon('star', 'ico ico-sm'), '只看中国队',
      h('small', {text: chinaCount ? chinaCount + ' 轮' : '分组公布后可用'}));
    const panel = h('div', {class: 'fpanel', id: panelId, role: 'dialog', 'aria-label': '筛选赛程', hidden: true},
      h('div', {class: 'fpanel-head'}, h('b', {text: '筛选赛程'}),
        h('button', {type: 'button', class: 'icon-btn', 'aria-label': '关闭', onclick: () => toggle(false)}, icon('close'))),
      h('p', {class: 'f-label', text: '项目'}), genderSeg,
      h('p', {class: 'f-label', text: '轮次'}), stageSeg,
      chinaBtn,
      h('div', {class: 'fpanel-foot'},
        h('button', {type: 'button', class: 'btn btn-ghost', onclick: () => set({gender: 'all', stage: 'all', china: false})}, '清除'),
        h('button', {type: 'button', class: 'btn', onclick: () => toggle(false)}, '完成')));
    const scrim = h('div', {class: 'fscrim', hidden: true, onclick: () => toggle(false)});
    // Scrim and panel live inside the sticky bar so they share its stacking context.
    const bar = h('div', {class: 'fbar'}, dayTabs, h('div', {class: 'fb-right'}, filterBtn, zoneSeg), scrim, panel);

    function toggle(open) {
      panel.hidden = !open;
      scrim.hidden = !open;
      filterBtn.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('sheet-open', open);
      if (open) panel.querySelector('button[aria-pressed="true"], button').focus({preventScroll: true});
    }
    addEventListener('keydown', ev => { if (ev.key === 'Escape' && !panel.hidden) { toggle(false); filterBtn.focus(); } });
    // composedPath() is captured at dispatch, so chips re-rendered by the click still count as inside.
    document.addEventListener('click', ev => {
      const path = ev.composedPath();
      if (!panel.hidden && !path.includes(panel) && !path.includes(filterBtn)) toggle(false);
    });

    function choices(box, key, options) {
      fill(box, options.map(([v, text]) => h('button', {type: 'button', class: 'chip', 'aria-pressed': String(state[key] === v),
        onclick: () => set({[key]: v})}, text)));
    }

    root.append(overview, bar, counter, container,
      h('p', {class: 'source-line'}, '来源：', external(data.source_url, 'ISU 逐项赛程原始页面'), ' · ',
        external('https://www.isu-skating.com/en/short-track/results/', 'ISU 成绩索引')));

    let lastLive = -1;
    tick(() => {
      const i = liveIndex(entries);
      if (i !== lastLive) { lastLive = i; redraw(); }
    });

    function redraw() {
      const bjFirst = state.zone === 'beijing';
      const nextI = liveIndex(entries);

      fill(dayTabs, [{local: 'all'}, ...days].map(d => {
        const date = d.local === 'all' ? null : bjFirst ? d.bj : d.local;
        return h('button', {type: 'button', class: 'fb-day', 'aria-pressed': String(state.day === d.local), onclick: () => set({day: d.local})},
          date ? [h('b', {text: wk(date)}), h('small', {class: 'num', text: md(date)})] : h('b', {text: '全部'}),
          d.medals ? h('i', {class: 'medal-dot', title: d.medals + ' 场奖牌赛'}) : null);
      }));
      fill(zoneSeg, [['beijing', '北京'], ['local', '当地']].map(([v, text]) => h('button', {type: 'button',
        'aria-pressed': String(state.zone === v), title: v === 'local' ? station.city + '当地时间' : '北京时间',
        onclick: () => {
          try { localStorage.setItem('ssts.zone', v); } catch (_) { /* private mode */ }
          set({zone: v});
        }}, text)));
      choices(genderSeg, 'gender', genderOpts);
      choices(stageSeg, 'stage', stageOpts);
      chinaBtn.setAttribute('aria-pressed', String(state.china));
      const active = (state.gender !== 'all') + (state.stage !== 'all') + state.china;
      badge.textContent = active || '';
      badge.hidden = !active;

      fill(overview, ribbon(entries, days, state, station, nextI), finalsBoard(entries.filter(isMedal), state));

      const rows = entries.filter(r =>
        (state.day === 'all' || r.local_date === state.day) &&
        (state.gender === 'all' || (state.gender === 'relay' ? r.format === 'relay' : r.gender === state.gender)) &&
        (state.stage === 'all' || (state.stage === 'final' ? r.round === 'final' : r.session === state.stage)) &&
        (!state.china || isChina(r)));
      const clear = (label, patch) => h('button', {type: 'button', class: 'chip chip-on', onclick: () => set(patch), 'aria-label': '移除筛选：' + label},
        label, icon('close', 'ico ico-xs'));
      fill(counter,
        h('span', {}, '共 ', h('b', {class: 'num', text: rows.length}), ' 个轮次', rows.length < entries.length ? h('span', {class: 'faint', text: ' / ' + entries.length}) : null),
        state.gender !== 'all' ? clear(genderOpts.find(o => o[0] === state.gender)[1], {gender: 'all'}) : null,
        state.stage !== 'all' ? clear(stageOpts.find(o => o[0] === state.stage)[1], {stage: 'all'}) : null,
        state.china ? clear('只看中国队', {china: false}) : null,
        h('span', {class: 'legend'}, h('span', {class: 'lg lg-gold', text: '奖牌赛'}), h('span', {class: 'lg lg-red', text: '中国队'})));

      container.replaceChildren();
      for (const d of days) {
        const items = rows.filter(r => r.local_date === d.local);
        if (!items.length) continue;
        container.append(daySection(d, items, bjFirst, nextI, station, entries));
      }
      if (!rows.length) {
        container.append(h('div', {class: 'panel empty-filter'}, h('p', {text: '当前筛选条件下没有比赛。'}),
          h('button', {type: 'button', class: 'btn', onclick: view.reset}, '查看全部赛程')));
      }
    }
  }

  function daySection(d, items, bjFirst, nextI, station, entries) {
    const main = bjFirst ? 'beijing' : 'local';
    const date = bjFirst ? d.bj : d.local;
    const t0 = items[0][main + '_time'], t1 = items[items.length - 1][main + '_time'];
    const medals = items.filter(isMedal).length;
    const head = h('header', {class: 'day-head'},
      h('span', {class: 'day-no', text: 'DAY ' + d.n}),
      h('h2', {}, wk(date) + ' ', h('span', {class: 'num', text: md(date)})),
      h('p', {}, (bjFirst ? '北京时间 ' : station.city + '时间 ') + dayPart(t0) + ' ', h('span', {class: 'num', text: t0}),
        ' – ' + dayPart(t1) + ' ', h('span', {class: 'num', text: t1}), ' · ' + items.length + ' 轮',
        h('span', {class: 'faint', text: bjFirst ? ' · 当地 ' + md(d.local) + ' ' + wk(d.local) : ' · 北京 ' + md(d.bj) + ' ' + wk(d.bj)})),
      medals ? h('span', {class: 'pill pill-gold'}, icon('medal', 'ico ico-xs'), medals + ' 场奖牌赛') : null);
    const labels = ['日期', bjFirst ? '北京时间' : station.city + '时间', bjFirst ? station.city + '时间' : '北京时间', '项目', '轮次', '组别', '备注'];
    const body = h('tbody');
    const refDates = bjFirst ? [d.bj, d.local] : [d.local, d.bj];
    let lastStage = '';
    for (const r of items) {
      if (lastStage !== r.session) {
        const n = items.filter(x => x.session === r.session).length;
        body.append(h('tr', {class: 'session-row s-' + r.session},
          h('td', {colspan: 7}, h('b', {text: session[r.session]}),
            h('small', {text: (sessionNote[r.session] ? sessionNote[r.session] + ' · ' : '') + n + ' 轮'}))));
        lastStage = r.session;
      }
      if (r.i === nextI && r.i > 0 && entries[r.i - 1].local_date === r.local_date) {
        const p = parts(bjFirst ? BJ : station.timezone, now());
        body.append(h('tr', {class: 'now-row'}, h('td', {colspan: 7},
          h('span', {}, h('i', {class: 'pulse'}), '现在 ' + p.hm))));
      }
      body.append(row(r, labels, bjFirst, nextI, refDates));
    }
    return h('section', {class: 'day', 'aria-label': labels[1] + ' ' + md(date)}, head,
      h('div', {class: 'scroll', tabindex: 0, role: 'region', 'aria-label': md(date) + ' 赛程'},
        h('table', {}, h('thead', {}, h('tr', {}, labels.map(l => h('th', {scope: 'col', text: l})))), body)));
  }

  // Keep cell order/classes stable: the tablet/phone card CSS and print table rely on them.
  function row(r, labels, bjFirst, nextI, refDates) {
    const china = isChina(r);
    const state = r.i < nextI - 1 ? 'is-past' : r.i === nextI - 1 ? (now() - r.t < 90 * 60000 ? 'is-started' : 'is-past') : r.i === nextI ? 'is-next' : '';
    const tr = h('tr', {id: 'r-' + r.id, class: cls('match-row', 's-' + r.session, china && 'china-row', r.group === 'A' && 'a-final',
      r.group === 'B' && 'b-final', r.group && 'has-group', state)});
    const cell = (label, className, ...kids) => tr.appendChild(h('td', {class: className, dataset: label ? {label} : null}, ...kids));
    const bj = [r.beijing_time, md(r.beijing_date) + ' ' + wk(r.beijing_date), r.beijing_date];
    const lo = [r.local_time, md(r.local_date) + ' ' + wk(r.local_date), r.local_date];
    const [a, b] = bjFirst ? [bj, lo] : [lo, bj];
    const dt = (x, ref) => h('span', {class: cls('dt', x[2] === ref && 'dt-same'), text: ' ' + x[1]});
    cell(labels[0], 'date-cell num', r.local_date);
    cell(labels[1], 'time primary-time', h('span', {class: 'tm num', text: a[0]}), h('span', {class: 'dp', text: ' ' + dayPart(a[0])}), dt(a, refDates[0]),
      state === 'is-next' ? h('em', {class: 'state state-next', text: '下一项'}) : state === 'is-started' ? h('em', {class: 'state state-started', text: '已开赛'}) : null);
    cell(labels[2], 'time secondary-time', h('span', {class: 'tm num', text: b[0]}), dt(b, refDates[1]))
      .dataset.short = bjFirst ? '当地' : '北京';
    cell(labels[3], 'event-cell',
      h('span', {class: 'g g-' + r.gender, text: gender[r.gender]}), ' ',
      h('b', {class: 'dist num', text: r.distance_m + 'm'}),
      r.format === 'relay' ? [' ', h('span', {class: 'relay', text: '接力'})] : null,
      china ? h('strong', {class: 'china-label'}, icon('star', 'ico ico-xs'), ' CHN 中国队') : null);
    cell(labels[4], 'round-cell', h('span', {class: 'round-name', text: roundName(r)}), ' ', stageMeter(r));
    cell(labels[5], 'group-cell' + (r.group ? '' : ' is-empty'),
      r.group ? h('span', {class: 'grp grp-' + r.group}, r.group === 'A' ? icon('medal', 'ico ico-xs') : null, r.group + ' 组',
        h('small', {text: r.group === 'A' ? '奖牌' : '排位'})) : '—');
    const note = cell(labels[6], 'notes-cell tiny' + (china ? '' : ' is-empty'));
    if (china) {
      for (const heat of r.china.heats) {
        const e = heat.estimate;
        const from = bjFirst ? e.earliest_beijing : e.earliest_local;
        const to = bjFirst ? e.latest_beijing : e.latest_local;
        note.append(h('p', {class: 'heat'},
          h('span', {class: 'heat-no', text: '第' + heat.number + '组'}), ' ',
          h('span', {class: 'athletes', text: heat.athletes.join('、')}), ' ',
          h('span', {class: 'est'}, '预计 ', h('span', {class: 'num', text: from.slice(11, 16) + '–' + to.slice(11, 16)}), h('em', {class: 'est-tag', text: '估算'}))));
      }
      note.append(external(r.china.source_url, '查看分组来源'));
    }
    return tr;
  }

  /* Race-day ribbon: every round start on a shared hour axis; medal races stand out. */
  function ribbon(entries, days, state, station, nextI) {
    const bjFirst = state.zone === 'beijing';
    const mins = r => Number(r.local_time.slice(0, 2)) * 60 + Number(r.local_time.slice(3, 5));
    const lo = Math.floor(Math.min(...entries.map(mins)) / 60) * 60;
    const hi = Math.ceil((Math.max(...entries.map(mins)) + 30) / 60) * 60;
    const pct = m => (m - lo) / (hi - lo);
    const x = m => (pct(m) * 100) + '%';
    const shift = tzOffset(BJ, entries[0].t) - tzOffset(station.timezone, entries[0].t);
    const axis = h('div', {class: 'rb-axis num', 'aria-hidden': 'true'});
    for (let m = lo; m <= hi; m += 120) {
      const shown = ((m + (bjFirst ? shift : 0)) % 1440 + 1440) % 1440;
      axis.append(h('span', {style: {left: x(m)}, text: pad(Math.floor(shown / 60)) + ':00'}));
    }
    const lanes = days.map(d => {
      const active = state.day === 'all' || state.day === d.local;
      const track = h('div', {class: 'rb-track'});
      // Session bands give the day its shape without extra colours.
      const bands = [];
      for (const r of d.items) {
        const b = bands[bands.length - 1];
        if (b && b.session === r.session) b.to = mins(r); else bands.push({session: r.session, from: mins(r), to: mins(r)});
      }
      for (const b of bands) {
        const from = Math.max(lo, b.from - 6);
        track.append(h('span', {class: 'rb-band', style: {left: x(from), width: ((b.to + 12 - from) / (hi - lo) * 100) + '%'}},
          h('small', {text: session[b.session]})));
      }
      for (const r of d.items) {
        const tip = (bjFirst ? r.beijing_time : r.local_time) + ' ' + eventName(r) + ' ' + roundName(r);
        track.append(h('button', {type: 'button', tabindex: -1, class: cls('rb-tick', isMedal(r) && 'is-a', r.group === 'B' && 'is-b',
          isChina(r) && 'is-chn', r.i < nextI && 'is-past', r.i === nextI && 'is-next',
          // Tooltips near either end open inward so the panel edge never clips them.
          pct(mins(r)) < .25 && 'tip-l', pct(mins(r)) > .75 && 'tip-r'),
        style: {left: x(mins(r))}, dataset: {tip}, onclick: () => scrollToRow(r)}));
      }
      const t = now();
      if (d.first.t - 30 * 60000 < t && t < d.last.t + 60 * 60000) {
        const p = parts(station.timezone, t);
        if (p.date === d.local) {
          const m = Number(p.hm.slice(0, 2)) * 60 + Number(p.hm.slice(3, 5));
          if (m >= lo && m <= hi) track.append(h('i', {class: 'rb-now', style: {left: x(m)}}));
        }
      }
      const date = bjFirst ? d.bj : d.local;
      return h('div', {class: cls('rb-lane', !active && 'is-dim')},
        h('div', {class: 'rb-day'}, h('b', {}, wk(date) + ' ', h('span', {class: 'num', text: md(date)})),
          h('small', {}, d.items.length + ' 轮', d.medals ? h('em', {class: 'gold-text', text: ' · ' + d.medals + ' 金'}) : null)),
        track);
    });
    return h('div', {class: 'panel ribbon'},
      h('div', {class: 'panel-head'}, h('h2', {text: '三天赛程一览'}),
        h('p', {text: (bjFirst ? '北京时间' : station.city + '时间') + ' · 点击刻度跳到对应比赛'})),
      h('div', {class: 'rb-body', 'aria-hidden': 'true'}, lanes, h('div', {class: 'rb-axis-row'}, h('span'), axis)),
      h('p', {class: 'rb-legend'}, h('span', {class: 'lg lg-gold', text: 'A 组决赛（产生奖牌）'}),
        h('span', {class: 'lg lg-plain', text: '其他轮次'}), h('span', {class: 'lg lg-red', text: '中国队 / 现在'})));
  }

  function finalsBoard(finals, state) {
    const bjFirst = state.zone === 'beijing';
    const t = now();
    return h('div', {class: 'panel finals'},
      h('div', {class: 'panel-head'}, h('h2', {}, icon('medal', 'ico gold-text'), '奖牌赛'),
        h('p', {text: 'A 组决赛 · ' + finals.length + ' 场'})),
      h('ol', {class: 'finals-list'}, finals.map(r => {
        const d = bjFirst ? r.beijing_date : r.local_date;
        const hm = bjFirst ? r.beijing_time : r.local_time;
        return h('li', {class: cls(r.t < t && 'is-past', isChina(r) && 'is-chn')},
          h('button', {type: 'button', title: eventName(r) + ' A组决赛 · ' + md(d) + ' ' + wk(d) + ' ' + hm, onclick: () => scrollToRow(r)},
            h('span', {class: 'f-ev'},
              h('span', {class: 'f-name'}, h('span', {class: 'g g-' + r.gender, text: gender[r.gender]}),
                h('b', {class: 'num', text: r.distance_m + 'm'})),
              h('small', {class: 'f-when', text: (r.format === 'relay' ? '接力 · ' : '') + wk(d) + ' ' + dayPart(hm)})),
            h('b', {class: 'f-time num', text: hm})));
      })));
  }

  /* ---------- boot ---------- */
  try {
    const calendar = await fetchData('calendar.json');
    const requested = params.get('station');
    const detailFor = st => st.detail_status === 'verified'
      ? fetchData(st.id + '.json').then(prepare).catch(() => null) : Promise.resolve(null);
    if (!requested) {
      const loaded = await Promise.all(calendar.stations.map(detailFor));
      const details = {};
      calendar.stations.forEach((st, i) => { if (loaded[i]) details[st.id] = loaded[i]; });
      renderSeason(calendar, details);
    } else {
      const station = calendar.stations.find(st => st.id === requested);
      if (!station) throw new Error('未知分站');
      document.title = station.city + '站赛程｜2026/27 短道速滑世界巡回赛';
      const details = station.detail_status === 'verified' ? prepare(await fetchData(station.id + '.json')) : null;
      renderStation(calendar, station, details);
    }
    // Back-to-top for long phone lists.
    const top = h('button', {type: 'button', class: 'to-top', 'aria-label': '回到顶部',
      onclick: () => scrollTo({top: 0, behavior: reduceMotion ? 'auto' : 'smooth'})}, icon('up'));
    document.body.append(top);
    addEventListener('scroll', () => top.classList.toggle('show', scrollY > innerHeight * 1.2), {passive: true});
  } catch (e) {
    root.replaceChildren(h('div', {class: 'panel error'}, icon('alert'),
      h('p', {text: '无法加载赛程：' + e.message + '。请检查静态站点部署目录和数据文件。'}),
      h('a', {class: 'btn', href: './'}, '返回首页')));
  } finally {
    root.removeAttribute('aria-busy');
  }
})();
