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

  const ICONS = {
    calendar: [['rect', {x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5}], ['path', {d: 'M3.5 10h17M8 3v4M16 3v4'}]],
    pin: [['path', {d: 'M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z'}], ['circle', {cx: 12, cy: 10, r: 2.4}]],
    globe: [['circle', {cx: 12, cy: 12, r: 8.5}], ['path', {d: 'M3.5 12h17M12 3.5c2.8 3 2.8 14 0 17M12 3.5c-2.8 3-2.8 14 0 17'}]],
    clock: [['circle', {cx: 12, cy: 12, r: 8.5}], ['path', {d: 'M12 7.5V12l3 2'}]],
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
    reset: [['path', {d: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4'}]],
    flag: [['path', {d: 'M5 21V4M5 4h11l-2 4 2 4H5'}]]
  };
  function icon(name, cls) {
    return s('svg', {viewBox: '0 0 24 24', class: cls || 'ico', 'aria-hidden': 'true', focusable: 'false'},
      ICONS[name].map(([tag, attrs]) => s(tag, attrs)));
  }

  /* ---------- time helpers ---------- */
  const WEEK = '日一二三四五六';
  const pad = n => String(n).padStart(2, '0');
  const md = iso => Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
  const dot = iso => iso.slice(5, 7) + '.' + iso.slice(8, 10);
  const wk = iso => '周' + WEEK[new Date(iso.slice(0, 10) + 'T12:00:00Z').getUTCDay()];
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

  /* One shared 1s heartbeat drives clocks, countdowns and the live row state. */
  const tickers = new Set();
  setInterval(() => tickers.forEach(fn => fn()), 1000);
  function tick(fn) { tickers.add(fn); fn(); }

  function setClocks(zones) {
    clocks.replaceChildren();
    const items = zones.map(([label, tz]) => {
      const t = h('b', {class: 'mono'});
      clocks.append(h('span', {class: 'clock'}, h('small', {text: label}), t));
      return [t, tz];
    });
    tick(() => {
      const t = now();
      for (const [el, tz] of items) {
        const p = parts(tz, t);
        el.textContent = p.hm + ':' + p.sec;
      }
    });
  }

  function countdown(cls) {
    const el = h('div', {class: 'countdown mono ' + (cls || ''), role: 'timer'});
    const cells = ['d', 'h', 'm', 's'].map(k => {
      const v = h('b');
      const unit = {d: '天', h: '时', m: '分', s: '秒'}[k];
      el.append(h('span', {class: 'cd-' + k}, v, h('small', {text: unit})));
      return [k, v];
    });
    el.set = ms => {
      const p = split(ms);
      el.classList.toggle('no-days', p.d === 0);
      for (const [k, v] of cells) v.textContent = k === 'd' ? String(p.d) : pad(p[k]);
    };
    return el;
  }

  /* ---------- naming ---------- */
  const gender = {women: '女子', men: '男子', mixed: '混合'};
  const roundNames = {preliminaries: '初赛', heats: '预赛', quarterfinal: '1/4决赛', semifinal: '半决赛', final: '决赛'};
  const ROUND_ORDER = ['preliminaries', 'heats', 'quarterfinal', 'semifinal', 'final'];
  const ROUND_TICK = ['初', '预', '1/4', '半', '决'];
  const session = {qualifying: '资格赛', repechage: '复活赛', main: '决赛阶段'};
  const sessionEn = {qualifying: 'Qualifying', repechage: 'Repechage', main: 'Main · 含淘汰赛'};
  const eventName = r => gender[r.gender] + ' ' + r.distance_m + 'm' + (r.format === 'relay' ? ' 接力' : '');
  const roundName = r => r.round === 'final' ? r.group + '组决赛' : roundNames[r.round];
  const isChina = r => r.china && r.china.status === 'confirmed';

  function stageMeter(r) {
    const at = ROUND_ORDER.indexOf(r.round);
    return h('span', {class: 'meter', 'aria-hidden': 'true'},
      ROUND_ORDER.map((_, i) => h('i', {class: i < at ? 'done' : i === at ? 'on' : '', title: ROUND_TICK[i]})));
  }

  /* ---------- decorative track ---------- */
  let uid = 0;
  function trackArt(cls, skaters = 4) {
    const id = 'trk' + (++uid);
    // Counter-clockwise lap, as raced. Straights x 130→270, curve radius 55.
    const lap = 'M270 45H130A55 55 0 0 0 130 155H270A55 55 0 0 0 270 45Z';
    const svg = s('svg', {viewBox: '0 0 400 200', class: 'track-art ' + (cls || ''), 'aria-hidden': 'true'},
      s('defs', {},
        s('linearGradient', {id: id + 'ice', x1: 0, y1: 0, x2: 1, y2: 1},
          s('stop', {offset: '0', 'stop-color': '#1B4466'}), s('stop', {offset: '1', 'stop-color': '#0E2B45'})),
        s('radialGradient', {id: id + 'glow'},
          s('stop', {offset: '0', 'stop-color': '#55D6FF', 'stop-opacity': '.9'}), s('stop', {offset: '1', 'stop-color': '#55D6FF', 'stop-opacity': '0'})),
        s('path', {id: id + 'lap', d: lap})),
      s('rect', {x: 18, y: 8, width: 364, height: 184, rx: 92, fill: 'url(#' + id + 'ice)', stroke: 'rgba(191,232,245,.35)', 'stroke-width': 1.5}),
      s('rect', {x: 30, y: 20, width: 340, height: 160, rx: 80, fill: 'none', stroke: 'rgba(191,232,245,.08)', 'stroke-width': 1}),
      s('path', {d: 'M200 8V192', stroke: 'rgba(230,57,70,.35)', 'stroke-width': 1.2}),
      s('circle', {cx: 200, cy: 100, r: 20, fill: 'none', stroke: 'rgba(230,57,70,.35)', 'stroke-width': 1.2}),
      [62, 72].map(r => s('path', {d: `M270 ${100 - r}H130A${r} ${r} 0 0 0 130 ${100 + r}H270A${r} ${r} 0 0 0 270 ${100 - r}Z`,
        fill: 'none', stroke: 'rgba(191,232,245,.12)', 'stroke-width': 1, 'stroke-dasharray': '3 5'})),
      s('use', {href: '#' + id + 'lap', fill: 'none', stroke: 'rgba(85,214,255,.45)', 'stroke-width': 1.6}),
      // Seven blocks on each curve, as on a real short track rink.
      [-90, -60, -30, 0, 30, 60, 90].flatMap(a => {
        const rad = a * Math.PI / 180;
        return [s('circle', {cx: 130 - 55 * Math.cos(rad), cy: 100 + 55 * Math.sin(rad), r: 2.4, class: 'block'}),
          s('circle', {cx: 270 + 55 * Math.cos(rad), cy: 100 + 55 * Math.sin(rad), r: 2.4, class: 'block'})];
      }),
      s('path', {d: 'M236 36V54', stroke: '#F7FBFF', 'stroke-width': 2, opacity: .7}),
      Array.from({length: skaters}, (_, i) => {
        const begin = (-i * 0.55 - 0.2).toFixed(2) + 's';
        const dur = '7.5s';
        return s('g', {class: 'skater'},
          s('use', {href: '#' + id + 'lap', fill: 'none', stroke: i ? '#BFE8F5' : '#55D6FF', 'stroke-width': 3, 'stroke-linecap': 'round',
            pathLength: 100, 'stroke-dasharray': '7 93', opacity: .5},
            s('animate', {attributeName: 'stroke-dashoffset', from: 7, to: -93, dur, begin, repeatCount: 'indefinite'})),
          s('circle', {r: 9, fill: 'url(#' + id + 'glow)'},
            s('animateMotion', {dur, begin, repeatCount: 'indefinite'}, s('mpath', {href: '#' + id + 'lap'}))),
          s('circle', {r: 3.4, fill: i ? '#F7FBFF' : '#55D6FF'},
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
    const t = now();
    let next = entries.findIndex(r => r.t > t);
    if (next < 0) next = entries.length;
    return next;
  }

  /* ---------- season calendar ---------- */
  function renderSeason(cal, details) {
    setClocks([['北京', BJ]]);
    const stations = cal.stations.map((st, i) => ({...st, n: i + 1, win: stationWindow(st, details[st.id]), detail: details[st.id]}));
    const focus = stations.find(st => phase(st.win) === 'live') || stations.find(st => phase(st.win) === 'upcoming');
    const first = stations[0], last = stations[stations.length - 1];

    const hero = h('section', {class: 'hero season-hero'},
      h('div', {class: 'hero-copy'},
        h('p', {class: 'eyebrow', text: 'ISU SHORT TRACK WORLD TOUR · ' + cal.season}),
        h('h1', {}, h('span', {text: cal.season + ' 赛季'}), h('span', {class: 'grad', text: '短道速滑世界巡回赛'})),
        h('p', {class: 'lead'},
          h('b', {text: stations.length}), ' 站 · ',
          h('span', {class: 'mono', text: first.date_start.slice(0, 7).replace('-', '.') + ' — ' + last.date_end.slice(0, 7).replace('-', '.')}),
          ' · 所有比赛时间均换算为北京时间'),
        focus ? focusCard(focus) : h('div', {class: 'focus-card done'}, h('p', {text: '本赛季全部分站已结束'}))),
      h('div', {class: 'hero-art'}, trackArt('hero-track')));

    root.replaceChildren(hero, seasonLine(stations, focus), stationGrid(stations, focus),
      h('p', {class: 'source-line'}, '赛历来源：', external(cal.source_url, 'ISU 官方赛历')));
  }

  function focusCard(st) {
    const live = phase(st.win) === 'live';
    const cd = countdown('cd-lg');
    const nextLine = h('p', {class: 'focus-next'});
    const card = h('a', {class: 'focus-card' + (live ? ' is-live' : ''), href: '?station=' + encodeURIComponent(st.id)},
      h('div', {class: 'focus-head'},
        h('span', {class: 'pill ' + (live ? 'pill-live' : 'pill-accent')}, live ? h('i', {class: 'pulse'}) : null, live ? '正在进行' : '下一站'),
        h('span', {class: 'mono muted', text: 'STAGE ' + pad(st.n)})),
      h('div', {class: 'focus-city'}, h('b', {text: st.city}), h('span', {text: st.city_en})),
      h('p', {class: 'focus-label', text: st.win.exact ? (live ? '下一项开赛还有' : '距首项开赛') : '距开幕（当地时间）'}),
      cd, nextLine,
      h('span', {class: 'focus-go'}, st.detail ? '查看逐项赛程' : '查看分站信息', icon('arrow')));
    tick(() => {
      let target = st.win.start;
      if (st.detail) {
        const e = st.detail.entries, i = liveIndex(e);
        if (i < e.length) {
          target = e[i].t;
          nextLine.textContent = eventName(e[i]) + ' ' + roundName(e[i]) + ' · 北京时间 ' + md(e[i].beijing_date) + ' ' + wk(e[i].beijing_date) + ' ' + e[i].beijing_time;
        } else nextLine.textContent = '全部轮次已按计划开赛';
      } else nextLine.textContent = dot(st.date_start) + ' ' + wk(st.date_start) + ' — ' + dot(st.date_end) + ' ' + wk(st.date_end) + ' · ' + bjDiff(st.timezone, st.win.start);
      cd.set(target - now());
    });
    return card;
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
      const ph = phase(st.win);
      line.append(h('a', {class: 'sl-node ' + (st.n % 2 ? 'up' : 'down') + ' is-' + ph + (st === focus ? ' is-focus' : ''),
        href: '?station=' + encodeURIComponent(st.id), style: {left: pos(Date.parse(st.date_start + 'T12:00:00Z')) + '%'},
        'aria-label': st.city + '站 ' + st.date_start},
        h('span', {class: 'sl-dot mono', text: st.n}),
        h('span', {class: 'sl-label'}, h('b', {text: st.city}), h('small', {class: 'mono', text: md(st.date_start)}))));
    }
    const nextDays = focus && phase(focus.win) === 'upcoming' ? Math.ceil((focus.win.start - now()) / DAY) : null;
    return h('section', {class: 'panel season-line', 'aria-label': '赛季时间轴'},
      h('div', {class: 'panel-head'},
        h('h2', {text: '赛季时间轴'}),
        h('p', {class: 'muted'}, h('i', {class: 'legend-today'}), '今天 ' + md(today) + ' ' + wk(today),
          nextDays != null ? ' · 距' + focus.city + '站 ' + nextDays + ' 天' : focus ? ' · ' + focus.city + '站进行中' : '')),
      line);
  }

  function stationGrid(stations, focus) {
    const grid = h('div', {class: 'st-grid'});
    for (const st of stations) {
      const ph = phase(st.win);
      const days = Math.ceil((st.win.start - now()) / DAY);
      const pill = ph === 'live' ? h('span', {class: 'pill pill-live'}, h('i', {class: 'pulse'}), '进行中')
        : ph === 'done' ? h('span', {class: 'pill', text: '已结束'})
        : h('span', {class: 'pill' + (st === focus ? ' pill-accent' : ''), text: (st === focus ? '下一站 · ' : '') + days + ' 天后'});
      grid.append(h('a', {class: 'st-card is-' + ph + (st === focus ? ' is-focus' : '') + (st.detail ? ' has-detail' : ''),
        href: '?station=' + encodeURIComponent(st.id), style: {'--d': (st.n * 60) + 'ms'}},
        cornerArc(),
        h('div', {class: 'st-top'}, h('span', {class: 'mono stage', text: 'STAGE ' + pad(st.n)}), pill),
        h('h3', {}, h('span', {text: st.city}), h('small', {text: st.city_en + (st.country ? ' · ' + st.country : '')}),
          st.country === 'CHN' ? h('em', {class: 'home-tag'}, icon('star', 'ico ico-xs'), '中国站') : null),
        h('p', {class: 'st-date mono'}, dot(st.date_start) + ' — ' + dot(st.date_end), h('small', {text: wk(st.date_start) + '至' + wk(st.date_end).slice(1)})),
        h('ul', {class: 'st-meta'},
          h('li', {}, icon('globe'), utcLabel(st.timezone, st.win.start) + ' · ' + bjDiff(st.timezone, st.win.start)),
          h('li', {}, icon('pin'), st.venue || '场馆待公布')),
        h('p', {class: 'st-foot'}, st.detail
          ? [h('span', {}, icon('check'), st.detail.entries.length + ' 个轮次已录入'), icon('arrow')]
          : h('span', {class: 'muted', text: '逐项赛程待官方公布'}))));
    }
    return h('section', {'aria-label': '七站赛历'}, h('h2', {class: 'section-title', text: '分站赛历'}), grid);
  }
  const cornerArc = () => s('svg', {class: 'st-arc', viewBox: '0 0 120 80', 'aria-hidden': 'true'},
    s('path', {d: 'M120 6H70A34 34 0 0 0 70 74H120', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4}),
    s('path', {d: 'M120 18H70A22 22 0 0 0 70 62H120', fill: 'none', stroke: 'currentColor', 'stroke-width': 1, 'stroke-dasharray': '2 4'}));

  /* ---------- station page ---------- */
  function stationNav(cal, current) {
    const list = h('div', {class: 'st-nav-list'}, cal.stations.map((st, i) => h('a', {href: '?station=' + encodeURIComponent(st.id),
      'aria-current': st.id === current.id ? 'page' : null},
      h('small', {class: 'mono', text: pad(i + 1)}), st.city)));
    // Keep the current stage visible in the horizontally scrolling pill list.
    requestAnimationFrame(() => {
      const a = list.querySelector('[aria-current]');
      if (a) list.scrollLeft += a.getBoundingClientRect().left - list.getBoundingClientRect().left - (list.clientWidth - a.offsetWidth) / 2;
    });
    return h('nav', {class: 'st-nav', 'aria-label': '分站切换'}, h('a', {class: 'back', href: './'}, icon('back'), '赛季总览'), list);
  }

  function renderStation(cal, station, data) {
    const idx = cal.stations.indexOf(station) + 1;
    const local = station.city + '时间';
    setClocks([['北京', BJ], [station.city, station.timezone]]);
    const win = stationWindow(station, data);
    const entries = data ? data.entries : [];
    const finalsA = entries.filter(r => r.round === 'final' && r.group === 'A');
    const chinaCount = entries.filter(isChina).length;

    const meta = h('ul', {class: 'chips'},
      h('li', {}, icon('calendar'), dot(station.date_start) + ' ' + wk(station.date_start) + ' — ' + dot(station.date_end) + ' ' + wk(station.date_end)),
      h('li', {}, icon('pin'), station.venue || '场馆待公布'),
      h('li', {}, icon('globe'), utcLabel(station.timezone, win.start) + ' · ' + bjDiff(station.timezone, win.start)),
      data && data.status === 'provisional' ? h('li', {class: 'chip-warn'}, icon('flag'), 'ISU 暂定赛程') : null);

    const copy = h('div', {class: 'hero-copy'},
      h('p', {class: 'eyebrow', text: 'STAGE ' + pad(idx) + ' · ISU 短道速滑世界巡回赛 ' + cal.season}),
      h('h1', {}, h('span', {text: station.city + '站'}), h('span', {class: 'grad en', text: station.city_en})),
      meta);
    if (data) {
      copy.append(h('dl', {class: 'kpis'},
        kpi(Object.keys(data.day_counts).length, '比赛日'),
        kpi(entries.length, '轮次'),
        kpi(finalsA.length, '奖牌赛'),
        kpi(chinaCount || '—', '中国队已确认', chinaCount ? 'kpi-china' : 'kpi-dim')));
      copy.append(syncLine(data));
    }
    const hero = h('section', {class: 'hero station-hero'}, copy, data ? liveCard(data, station) : pendingCard(station, win));
    root.replaceChildren(stationNav(cal, station), hero);

    if (!data) {
      root.append(h('section', {class: 'panel empty-state'},
        trackArt('empty-track', 2),
        h('h2', {text: '详细赛程尚未录入'}),
        h('p', {class: 'muted', text: 'ISU 公布' + station.city + '站逐项赛程并完成核对后，这里会显示全部轮次与北京时间。'}),
        h('p', {}, external(cal.source_url, 'ISU 官方赛历'))));
      return;
    }
    scheduleView(data, station, local, finalsA);
  }

  const kpi = (v, label, cls) => h('div', {class: 'kpi ' + (cls || '')}, h('dd', {class: 'mono', text: v}), h('dt', {text: label}));

  function syncLine(data) {
    const at = data.sync && data.sync.last_successful_schedule_check_utc;
    if (!at) return h('p', {class: 'sync sync-bad'}, icon('alert'), '官方赛程核对尚未成功，当前显示上次可信快照');
    const t = Date.parse(at);
    const rel = h('span');
    const p = parts(BJ, t);
    tick(() => { rel.textContent = ago(t); });
    return h('p', {class: 'sync'}, h('i', {class: 'pulse ok'}),
      '官方赛程核对 ', rel, h('span', {class: 'muted mono', text: ' · ' + md(p.date) + ' ' + p.hm + ' 北京'}));
  }

  function pendingCard(station, win) {
    const cd = countdown('cd-lg');
    const ph = phase(win);
    tick(() => cd.set(win.start - now()));
    return h('aside', {class: 'live-card'},
      h('p', {class: 'live-label', text: ph === 'upcoming' ? '距开幕（当地时间 0 点）' : ph === 'live' ? '本站正在进行' : '本站已结束'}),
      ph === 'upcoming' ? cd : null,
      h('p', {class: 'live-sub muted', text: '开幕日北京时间 ' + (() => { const p = parts(BJ, win.start); return md(p.date) + ' ' + wk(p.date) + ' ' + p.hm; })()}));
  }

  function liveCard(data, station) {
    const e = data.entries;
    const label = h('p', {class: 'live-label'});
    const cd = countdown('cd-lg');
    const title = h('p', {class: 'live-event'});
    const times = h('p', {class: 'live-times mono'});
    const jump = h('button', {type: 'button', class: 'btn btn-ghost', onclick: () => scrollToRow(e[liveIndex(e)])}, icon('down'), '定位到赛程');
    const china = chinaLine(e);
    const card = h('aside', {class: 'live-card', 'aria-label': '下一项'}, label, cd, title, times, jump, china);
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
          label.textContent = i === 0 ? '距首项开赛' : '下一项开赛还有';
          fill(title, h('b', {text: eventName(r)}), ' ', roundName(r), isChina(r) ? h('span', {class: 'chn-tag'}, icon('star', 'ico ico-xs'), 'CHN') : null);
          times.replaceChildren(h('span', {}, h('small', {text: '北京 '}), md(r.beijing_date) + ' ' + wk(r.beijing_date) + ' ' + r.beijing_time),
            h('span', {class: 'muted'}, h('small', {text: station.city + ' '}), md(r.local_date) + ' ' + wk(r.local_date) + ' ' + r.local_time));
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
        box.replaceChildren(icon('star', 'ico star-ico'), h('span', {}, h('b', {text: '中国队'}),
          entries.some(isChina) ? ' 已确认场次均已开赛' : ' 官方分组公布后自动标记'));
        return;
      }
      const hs = r.china.heats;
      box.replaceChildren(icon('star', 'ico star-ico'), h('span', {}, h('b', {text: '中国队下一场 '}),
        eventName(r) + ' ' + roundName(r) + ' 第' + hs.map(x => x.number).join('、') + '组 · 轮次开始 北京 ' + md(r.beijing_date) + ' ' + r.beijing_time,
        h('small', {class: 'muted'}, ' · 估算出场 ' + hs[0].estimate.earliest_beijing.slice(11, 16) + ' 起', h('em', {class: 'est-tag', text: '估算'}))));
    });
    return box;
  }

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
  const view = {};

  function storedZone() {
    try { return localStorage.getItem('ssts.zone') === 'local' ? 'local' : 'beijing'; } catch (_) { return 'beijing'; }
  }

  function scheduleView(data, station, local, finalsA) {
    const entries = data.entries;
    const days = Object.keys(data.day_counts);
    const blank = {day: 'all', gender: 'all', stage: 'all', china: false};
    const state = {...blank, zone: storedZone()};
    const chinaCount = entries.filter(isChina).length;

    const overview = h('section', {class: 'overview'});
    const filters = h('section', {class: 'filters', 'aria-label': '筛选'});
    const counter = h('p', {class: 'counter', 'aria-live': 'polite'});
    const container = h('div', {class: 'days'});
    root.append(overview, filters, counter, container,
      h('p', {class: 'source-line'}, '来源：', external(data.source_url, 'ISU 逐项赛程原始页面'), ' · ',
        external('https://www.isu-skating.com/en/short-track/results/', 'ISU 成绩索引')));

    const set = patch => { Object.assign(state, patch); redraw(); };
    view.reset = () => { Object.assign(state, blank); redraw(); };

    // Filter groups: same semantics as the original wireframe selects.
    const groups = [
      seg('日期', 'day', () => [['all', '全部', null], ...days.map(d => {
        const bj = entries.find(r => r.local_date === d).beijing_date;
        return state.zone === 'beijing'
          ? [d, md(bj) + ' ' + wk(bj), '当地 ' + md(d)]
          : [d, md(d) + ' ' + wk(d), '北京 ' + md(bj)];
      })]),
      seg('项目', 'gender', () => [['all', '全部'], ['women', '女子'], ['men', '男子'], ['mixed', '混合'], ['relay', '接力']]),
      seg('轮次', 'stage', () => [['all', '全部'], ['qualifying', '资格赛'], ['repechage', '复活赛'], ['main', '决赛阶段'], ['final', 'A/B组决赛']]),
      seg('时间', 'zone', () => [['beijing', '北京'], ['local', station.city]])
    ];
    const chinaBtn = h('button', {type: 'button', class: 'toggle-chn', disabled: chinaCount ? null : true,
      title: chinaCount ? '只看已确认中国队分组的轮次' : '官方分组公布后可用',
      onclick: () => set({china: !state.china})}, icon('star', 'ico ico-sm'), '仅中国队', h('small', {class: 'mono', text: chinaCount}));
    const reset = h('button', {type: 'button', class: 'btn btn-ghost reset', onclick: view.reset}, icon('reset', 'ico ico-sm'), '重置');
    filters.append(
      h('div', {class: 'f-row'}, groups[0].el, groups[3].el),
      h('div', {class: 'f-row'}, groups[1].el, groups[2].el, h('div', {class: 'f-extra'}, chinaBtn, reset)));

    function seg(label, key, options) {
      const box = h('div', {class: 'seg', role: 'group', 'aria-label': label});
      const el = h('div', {class: 'f-group f-' + key}, h('span', {class: 'f-label', text: label}), box);
      return {el, sync() {
        box.replaceChildren(...options().map(([v, text, sub]) => h('button', {type: 'button',
          'aria-pressed': String(state[key] === v),
          onclick: () => {
            if (key === 'zone') { try { localStorage.setItem('ssts.zone', v); } catch (_) { /* private mode */ } }
            set({[key]: v});
          }}, h('span', {text}), sub ? h('small', {text: sub}) : null)));
      }};
    }

    let lastLive = -1;
    tick(() => {
      const i = liveIndex(entries);
      if (i !== lastLive) { lastLive = i; redraw(); }
    });

    function redraw() {
      groups.forEach(g => g.sync());
      chinaBtn.setAttribute('aria-pressed', String(state.china));
      reset.hidden = Object.keys(blank).every(k => state[k] === blank[k]);
      const bjFirst = state.zone === 'beijing';
      const zoneName = bjFirst ? '北京时间' : local;
      const otherName = bjFirst ? local : '北京时间';
      const nextI = liveIndex(entries);
      overview.replaceChildren(ribbon(entries, days, state, station, nextI), finalsBoard(finalsA, state, station));

      const rows = entries.filter(r =>
        (state.day === 'all' || r.local_date === state.day) &&
        (state.gender === 'all' || (state.gender === 'relay' ? r.format === 'relay' : r.gender === state.gender)) &&
        (state.stage === 'all' || (state.stage === 'final' ? r.round === 'final' : r.session === state.stage)) &&
        (!state.china || isChina(r)));
      counter.replaceChildren(
        h('span', {}, '显示 ', h('b', {class: 'mono', text: rows.length}), ' / ' + entries.length + ' 个官方轮次开始时间'),
        h('span', {class: 'legend'},
          Object.keys(session).map(k => h('span', {class: 'lg lg-' + k, text: session[k]})),
          h('span', {class: 'lg lg-a', text: 'A组决赛'})));

      const grouped = {};
      for (const r of rows) (grouped[r.local_date] ??= []).push(r);
      container.replaceChildren();
      for (const [day, items] of Object.entries(grouped)) {
        const bjDays = [...new Set(items.map(r => r.beijing_date))];
        const head = bjFirst
          ? [md(bjDays[0]) + ' ' + wk(bjDays[0]) + (bjDays.length > 1 ? ' – ' + md(bjDays[bjDays.length - 1]) : ''), '北京', station.city + ' ' + md(day) + ' ' + wk(day)]
          : [md(day) + ' ' + wk(day), station.city, '北京 ' + bjDays.map(d => md(d) + ' ' + wk(d)).join(' – ')];
        const first = items[0], lastR = items[items.length - 1];
        const span = bjFirst ? first.beijing_time + ' – ' + lastR.beijing_time : first.local_time + ' – ' + lastR.local_time;
        const sectionEl = h('section', {class: 'day', 'aria-label': head[0]},
          h('header', {class: 'day-head'},
            h('h2', {}, h('span', {class: 'mono', text: head[0]}), h('small', {text: head[1]})),
            h('p', {class: 'muted'}, head[2], h('span', {class: 'mono', text: ' · ' + span}), ' · ' + items.length + ' 项')));
        const scroller = h('div', {class: 'scroll', tabindex: 0, role: 'region', 'aria-label': head[0] + '赛程'});
        const labels = ['日期', zoneName, otherName, '项目', '轮次', '组别', '备注'];
        const body = h('tbody');
        scroller.append(h('table', {}, h('thead', {}, h('tr', {}, labels.map(l => h('th', {scope: 'col', text: l})))), body));
        sectionEl.append(scroller);
        container.append(sectionEl);

        let lastStage = '';
        for (const r of items) {
          if (lastStage !== r.session) {
            const n = items.filter(x => x.session === r.session).length;
            body.append(h('tr', {class: 'session-row s-' + r.session},
              h('td', {colspan: 7}, h('i', {class: 'sdot'}), h('b', {text: session[r.session]}),
                h('small', {text: sessionEn[r.session] + ' · ' + n + ' 项'}))));
            lastStage = r.session;
          }
          if (r.i === nextI && r.i > 0 && entries[r.i - 1].local_date === r.local_date) {
            const p = parts(bjFirst ? BJ : station.timezone, now());
            body.append(h('tr', {class: 'now-row'}, h('td', {colspan: 7},
              h('span', {}, h('i', {class: 'pulse'}), '现在 · ' + (bjFirst ? '北京 ' : station.city + ' ') + p.hm))));
          }
          body.append(row(r, labels, bjFirst, nextI));
        }
      }
      if (!rows.length) {
        container.append(h('div', {class: 'panel empty-filter'}, h('p', {text: '当前筛选条件下没有比赛。'}),
          h('button', {type: 'button', class: 'btn', onclick: view.reset}, icon('reset', 'ico ico-sm'), '重置筛选')));
      }
    }
    // Back-to-top for long phone lists.
    const top = h('button', {type: 'button', class: 'to-top', 'aria-label': '回到顶部',
      onclick: () => scrollTo({top: 0, behavior: reduceMotion ? 'auto' : 'smooth'})}, icon('up'));
    document.body.append(top);
    const onScroll = () => top.classList.toggle('show', scrollY > innerHeight * 1.2);
    addEventListener('scroll', onScroll, {passive: true});
  }

  // Keep cell order/classes stable: the tablet/phone card CSS and print table rely on them.
  function row(r, labels, bjFirst, nextI) {
    const china = isChina(r);
    const state = r.i < nextI - 1 ? 'is-past' : r.i === nextI - 1 ? (now() - r.t < 90 * 60000 ? 'is-started' : 'is-past') : r.i === nextI ? 'is-next' : '';
    const tr = h('tr', {id: 'r-' + r.id, class: ['match-row', 's-' + r.session, china && 'china-row', r.group === 'A' && 'a-final',
      r.group === 'B' && 'b-final', r.group && 'has-group', state].filter(Boolean).join(' ')});
    const cell = (label, cls, ...kids) => tr.appendChild(h('td', {class: cls, dataset: label ? {label} : null}, ...kids));
    const bj = [r.beijing_time, md(r.beijing_date) + ' ' + wk(r.beijing_date)];
    const lo = [r.local_time, md(r.local_date) + ' ' + wk(r.local_date)];
    const [a, b] = bjFirst ? [bj, lo] : [lo, bj];
    cell(labels[0], 'date-cell mono', r.local_date);
    cell(labels[1], 'time primary-time', h('span', {class: 'tm', text: a[0]}), h('span', {class: 'dt', text: ' ' + a[1]}),
      state === 'is-next' ? h('em', {class: 'state state-next', text: '下一项'}) : state === 'is-started' ? h('em', {class: 'state state-started', text: '已开赛'}) : null);
    cell(labels[2], 'time secondary-time', h('span', {class: 'tm', text: b[0]}), h('span', {class: 'dt', text: ' ' + b[1]}));
    cell(labels[3], 'event-cell',
      h('span', {class: 'g g-' + r.gender, text: gender[r.gender]}), ' ',
      h('b', {class: 'dist mono', text: r.distance_m + 'm'}),
      r.format === 'relay' ? [' ', h('span', {class: 'relay'}, icon('relay', 'ico ico-xs'), '接力')] : null,
      china ? h('strong', {class: 'china-label'}, icon('star', 'ico ico-xs'), ' CHN 中国队') : null);
    cell(labels[4], 'round-cell', h('span', {class: 'round-name', text: roundName(r)}), ' ', stageMeter(r));
    cell(labels[5], 'group-cell' + (r.group ? '' : ' is-empty'),
      r.group ? h('span', {class: 'grp grp-' + r.group}, r.group === 'A' ? icon('medal', 'ico ico-sm') : null, r.group, h('small', {text: r.group === 'A' ? ' 奖牌' : ' 排位'})) : '—');
    const note = cell(labels[6], 'notes-cell tiny' + (china ? '' : ' is-empty'));
    if (china) {
      for (const heat of r.china.heats) {
        const e = heat.estimate;
        const from = bjFirst ? e.earliest_beijing : e.earliest_local;
        const to = bjFirst ? e.latest_beijing : e.latest_local;
        note.append(h('p', {class: 'heat'},
          h('span', {class: 'heat-no mono', text: '第' + heat.number + '组'}), ' ',
          h('span', {class: 'athletes', text: heat.athletes.join('、')}), ' ',
          h('span', {class: 'est mono'}, '预计 ' + from.slice(11, 16) + '–' + to.slice(11, 16), h('em', {class: 'est-tag', text: '估算'}))));
      }
      note.append(external(r.china.source_url, '查看分组来源'));
    }
    return tr;
  }

  /* Rundown ribbon: every round start per local day on a shared hour axis. */
  function ribbon(entries, days, state, station, nextI) {
    const bjFirst = state.zone === 'beijing';
    const mins = r => Number(r.local_time.slice(0, 2)) * 60 + Number(r.local_time.slice(3, 5));
    const lo = Math.floor(Math.min(...entries.map(mins)) / 60) * 60;
    const hi = Math.ceil((Math.max(...entries.map(mins)) + 30) / 60) * 60;
    const x = m => ((m - lo) / (hi - lo) * 100) + '%';
    const shift = (tzOffset(BJ, entries[0].t) - tzOffset(station.timezone, entries[0].t));
    const axis = h('div', {class: 'rb-axis mono', 'aria-hidden': 'true'});
    for (let m = lo; m <= hi; m += 120) {
      const shown = ((m + (bjFirst ? shift : 0)) % 1440 + 1440) % 1440;
      axis.append(h('span', {style: {left: x(m)}, text: pad(Math.floor(shown / 60)) + ':00'}));
    }
    const lanes = days.map(day => {
      const items = entries.filter(r => r.local_date === day);
      const bjd = items[0].beijing_date;
      const active = state.day === 'all' || state.day === day;
      const track = h('div', {class: 'rb-track'});
      for (let m = lo + 60; m < hi; m += 60) track.append(h('i', {class: 'rb-hour', style: {left: x(m)}}));
      for (const r of items) {
        const tip = (bjFirst ? r.beijing_time : r.local_time) + ' ' + eventName(r) + ' ' + roundName(r);
        track.append(h('button', {type: 'button', tabindex: -1, class: ['rb-tick', 's-' + r.session, r.group === 'A' && 'is-a',
          isChina(r) && 'is-chn', r.i < nextI && 'is-past', r.i === nextI && 'is-next'].filter(Boolean).join(' '),
        style: {left: x(mins(r))}, dataset: {tip}, onclick: () => scrollToRow(r)}));
      }
      const t = now();
      if (items[0].t - 30 * 60000 < t && t < items[items.length - 1].t + 60 * 60000) {
        const p = parts(station.timezone, t);
        if (p.date === day) {
          const m = Number(p.hm.slice(0, 2)) * 60 + Number(p.hm.slice(3, 5));
          if (m >= lo && m <= hi) track.append(h('i', {class: 'rb-now', style: {left: x(m)}}));
        }
      }
      return h('div', {class: 'rb-lane' + (active ? '' : ' is-dim')},
        h('div', {class: 'rb-day'},
          h('b', {}, h('span', {class: 'mono', text: md(bjFirst ? bjd : day)}), ' ' + wk(bjFirst ? bjd : day)),
          h('small', {}, h('span', {class: 'rb-alt', text: (bjFirst ? '当地 ' + md(day) : '北京 ' + md(bjd)) + ' · '}), items.length + ' 项')),
        track);
    });
    return h('div', {class: 'panel ribbon'},
      h('div', {class: 'panel-head'}, h('h2', {text: '赛程总览'}),
        h('p', {class: 'muted', text: (bjFirst ? '北京时间' : station.city + '时间') + ' · 点击刻度定位'})),
      h('div', {class: 'rb-body', 'aria-hidden': 'true'}, lanes, h('div', {class: 'rb-axis-row'}, h('span'), axis)));
  }

  function finalsBoard(finals, state, station) {
    const bjFirst = state.zone === 'beijing';
    const t = now();
    return h('div', {class: 'panel finals'},
      h('div', {class: 'panel-head'}, h('h2', {}, icon('medal', 'ico gold'), '奖牌赛'),
        h('p', {class: 'muted', text: 'A 组决赛 · ' + finals.length + ' 场'})),
      h('ol', {class: 'finals-list'}, finals.map(r => {
        const d = bjFirst ? r.beijing_date : r.local_date;
        return h('li', {class: (r.t < t ? 'is-past' : '') + (isChina(r) ? ' is-chn' : '')},
          h('button', {type: 'button', onclick: () => scrollToRow(r)},
            h('span', {class: 'f-ev'}, h('span', {class: 'g g-' + r.gender, text: gender[r.gender]}),
              h('b', {class: 'mono', text: r.distance_m + 'm'}), r.format === 'relay' ? h('small', {text: '接力'}) : null),
            h('span', {class: 'f-time mono'}, h('small', {text: md(d) + ' ' + wk(d)}), bjFirst ? r.beijing_time : r.local_time)));
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
  } catch (e) {
    root.replaceChildren(h('div', {class: 'panel error'}, icon('alert'),
      h('p', {text: '无法加载赛程：' + e.message + '。请检查静态站点部署目录和数据文件。'}),
      h('a', {class: 'btn', href: './'}, '返回首页')));
  } finally {
    root.removeAttribute('aria-busy');
  }
})();
