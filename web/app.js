/* SSTS-WB presentation layer. Reads schedule JSON and read-only athlete APIs; never alters official times.
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
  // " · "-separated facts that wrap between facts, never inside one.
  const phrases = (...items) => items.filter(Boolean).flatMap((x, i) => [i ? '\u00a0· ' : null, h('span', {class: 'nowrap'}, x)]);

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
    moon: [['path', {d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'}]],
    bell: [['path', {d: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z'}], ['path', {d: 'M10 20.5a2.2 2.2 0 0 0 4 0'}]],
    chev: [['path', {d: 'M7 10l5 5 5-5'}]]
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
  const heartbeat = () => { if (!document.hidden) tickers.forEach(fn => fn()); };
  setInterval(heartbeat, 1000);
  document.addEventListener('visibilitychange', heartbeat);
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
      for (const [k, v] of cells) {
        const value = k === 'd' ? String(p.d) : pad(p[k]);
        if (v.textContent !== value) v.textContent = value;
      }
    };
    return el;
  }

  /* Light/dark switch. index.html picks the first-paint theme; by default it follows the OS setting. */
  function themeToggle() {
    const html = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    const mq = matchMedia('(prefers-color-scheme: light)');
    const system = () => mq.matches ? 'light' : 'dark';
    const store = (area, value) => { try { value ? area.setItem('ssts.theme', value) : area.removeItem('ssts.theme'); } catch (_) { /* private mode */ } };
    const override = () => { try { return sessionStorage.getItem('ssts.theme') || localStorage.getItem('ssts.theme'); } catch (_) { return null; } };
    const btn = h('button', {type: 'button', class: 'theme-btn', onclick: () => {
      const next = html.dataset.theme === 'light' ? 'dark' : 'light';
      // Choosing what the phone already uses means "follow the phone" again.
      store(sessionStorage, null);
      store(localStorage, next === system() ? null : next);
      apply(next);
    }}, icon('sun', 'ico ico-sun'), icon('moon', 'ico ico-moon'));
    function apply(theme) {
      html.dataset.theme = theme;
      if (meta) meta.content = theme === 'light' ? '#F3F8FC' : '#0B1F33';
      btn.setAttribute('aria-label', theme === 'light' ? '切换为深色主题' : '切换为浅色主题');
      btn.title = btn.getAttribute('aria-label');
    }
    mq.addEventListener('change', () => { if (!override()) apply(system()); });
    apply(html.dataset.theme === 'light' ? 'light' : 'dark');
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('./data/' + file, {cache: file === 'calendar.json' ? 'default' : 'no-cache', signal: controller.signal});
      if (!response.ok) throw new Error('数据请求失败: ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
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

  /* ---------- athlete entries and official competition details ---------- */
  const officialHeats = new Map();
  function competitionPanel(station) {
    const athletes = h('div', {class: 'athlete-data'});
    const predictions = h('div', {class: 'athlete-data'});
    const status = h('div', {class: 'competition-status', hidden: true});
    const slots = new Map(), pending = new Map(), loaded = new Map(), requested = new Set();
    const labels = {entries: '报名名单', rankings: '排名', predictions: '分组预测', rounds: '分组与成绩'};
    const containers = {entries: athletes, rankings: athletes, predictions, rounds: status};
    // Independent slots preserve successful data and filter choices when a sibling request fails.
    for (const resource of Object.keys(labels)) {
      const slot = h('div', {dataset: {resource}});
      containers[resource].append(slot);
      slots.set(resource, slot);
    }
    async function load(resource) {
      if (pending.has(resource)) return pending.get(resource);
      if (loaded.has(resource) && Date.now() - loaded.get(resource) < 60000) return;
      requested.add(resource);
      const slot = slots.get(resource);
      slot.setAttribute('aria-busy', 'true');
      if (!loaded.has(resource) && resource !== 'rounds') fill(slot,
        h('p', {class: 'athlete-loading', role: 'status', text: '正在读取' + labels[resource] + '…'}));
      slot.querySelector('.athlete-load-error')?.remove();
      const task = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch('/api/v1/events/' + encodeURIComponent(station.id) + '/' + resource,
            {signal: controller.signal});
          if (!response.ok) throw new Error('请求失败');
          const value = await response.json();
          if (value.schema_version !== 1 || value.event_id !== station.id || value.resource !== resource || !Array.isArray(value.items)) {
            throw new Error('数据格式异常');
          }
          if (resource === 'rounds') {
            officialHeats.clear();
            for (const heat of value.items) {
              if (!heat.round_key) continue;
              if (!officialHeats.has(heat.round_key)) officialHeats.set(heat.round_key, []);
              officialHeats.get(heat.round_key).push(heat);
            }
            fill(slot, value.stale ? h('p', {class: 'faint tiny', text: '分组与成绩待更新'}) : null);
            status.hidden = !value.stale;
            view.refreshHeats?.();
          } else {
            const previous = slot.querySelector('details');
            const panel = resource === 'predictions' ? predictionList(value) : athleteList(value, labels[resource], resource === 'rankings');
            panel.open = previous ? previous.open : resource !== 'rankings';
            for (const select of panel.querySelectorAll('select')) {
              const old = [...(previous?.querySelectorAll('select') || [])].find(el => el.getAttribute('aria-label') === select.getAttribute('aria-label'));
              if (old && [...select.options].some(option => option.value === old.value)) {
                select.value = old.value;
                select.dispatchEvent(new Event('change'));
              }
            }
            if (resource === 'predictions' && previous?.querySelector('button[aria-pressed="true"]')) panel.querySelector('button[aria-pressed]')?.click();
            fill(slot, panel);
          }
          loaded.set(resource, Date.now());
        } catch (_) {
          slot.querySelector('.athlete-loading')?.remove();
          slot.append(h('p', {class: 'athlete-load-error', role: 'status'}, labels[resource] + '暂时无法加载',
            h('button', {type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => load(resource)}, '重试')));
          if (resource === 'rounds') status.hidden = false;
        } finally {
          clearTimeout(timeout);
          pending.delete(resource);
          slot.removeAttribute('aria-busy');
        }
      })();
      pending.set(resource, task);
      return task;
    }
    return {athletes, predictions, status, load,
      startRounds: () => { if (!requested.has('rounds')) load('rounds'); },
      show: name => {
        if (name === 'athletes') { load('entries'); load('rankings'); }
        else if (name === 'predictions') load('predictions');
        else load('rounds');
      }};
  }

  function stationTabs(schedule, competition, championship = false) {
    const sections = championship
      ? {schedule, athletes: competition.athletes}
      : {schedule, athletes: competition.athletes, predictions: competition.predictions};
    const labels = {schedule: '赛程', athletes: '运动员', predictions: '分组预测'};
    const nav = h('div', {class: 'section-tabs', role: 'tablist', 'aria-label': '本站内容'});
    const buttons = new Map();
    let selected = 'schedule';
    let interacted = false;
    function activate(name, updateUrl = true) {
      if (!sections[name]) name = 'schedule';
      selected = name;
      view.closeFilters?.();
      for (const [key, section] of Object.entries(sections)) {
        const active = key === name;
        section.hidden = !active;
        buttons.get(key).setAttribute('aria-selected', String(active));
        buttons.get(key).tabIndex = active ? 0 : -1;
      }
      if (updateUrl) {
        interacted = true;
        const url = new URL(location.href);
        if (name === 'schedule') url.searchParams.delete('view');
        else url.searchParams.set('view', name);
        history.replaceState(null, '', url);
        competition.show(name);
      }
    }
    for (const [key, section] of Object.entries(sections)) {
      section.id = 'section-' + key;
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-labelledby', 'tab-' + key);
      section.tabIndex = 0;
      const btn = h('button', {type: 'button', id: 'tab-' + key, role: 'tab', 'aria-controls': section.id,
        onclick: () => activate(key)}, labels[key]);
      btn.addEventListener('keydown', ev => {
        const keys = Object.keys(sections), i = keys.indexOf(key);
        const next = {ArrowRight: keys[(i + 1) % keys.length], ArrowLeft: keys[(i + keys.length - 1) % keys.length], Home: keys[0], End: keys.at(-1)}[ev.key];
        if (next) { ev.preventDefault(); activate(next); buttons.get(next).focus(); }
      });
      buttons.set(key, btn);
      nav.append(btn);
    }
    view.showSchedule = () => activate('schedule');
    activate(params.get('view') || 'schedule', false);
    // Let the schedule paint before starting secondary API work.
    requestAnimationFrame(() => setTimeout(() => {
      if (!interacted) competition.show(selected);
      competition.startRounds();
    }, 0));
    return [nav, ...Object.values(sections)];
  }

  const sourceTime = iso => new Date(iso).toLocaleString('zh-CN', {timeZone: BJ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});

  function predictionList(dataset) {
    const ready = dataset.items.filter(p => p.status === 'predicted').length;
    const box = h('details', {class: 'panel athlete-panel prediction-panel'},
      h('summary', {class: 'athlete-summary'}, h('b', {text: '分组预测'}),
        h('span', {class: 'prediction-label', text: '非官方'}),
        h('span', {class: 'faint tiny', text: ready ? ready + ' 个项目可查看' : dataset.items.some(p => p.entry_count) ? '报项核验中' : '待单项报项'}),
        dataset.stale ? h('small', {class: 'pill', text: '待更新'}) : null));
    const select = h('select', {'aria-label': '预测项目'}, dataset.items.map(p =>
      h('option', {value: p.id, text: (gender[p.gender] || '') + ' ' + p.distance_m + 'm'})));
    const chinaOnly = h('button', {type: 'button', class: 'chip', 'aria-pressed': 'false', text: '只看含 CHN 的组'});
    const body = h('div', {class: 'prediction-body', 'aria-live': 'polite'});
    const reasons = {distance_seeding_list: '单项报名、种子和直通待公布', schedule: '待官方轮次赛程',
      qualifying_table: '晋级表待核实', matching_schedule: '名单与赛程待核对',
      prequalification_list: '直通名单待核实', awaiting_complete_entries: '报项更新中',
      ranking_tie: '排名并列待抽签', unranked_draw: '无排名选手顺序待定',
      prequalification_tie: '直通边界待核实'};
    let onlyChina = false;
    const draw = () => {
      const item = dataset.items.find(p => p.id === select.value);
      if (!item) return;
      fill(body);
      chinaOnly.hidden = item.status !== 'predicted';
      if (item.status === 'official_available') {
        body.append(h('p', {class: 'faint athlete-empty', text: '官方分组已公布，请在赛程中查看'}));
      } else if (item.status !== 'predicted') {
        body.append(h('p', {class: 'faint athlete-empty', text: [...new Set(item.missing.map(k => reasons[k] || '待数据核实'))].join(' · ')}));
        if (item.entry_count) {
          body.append(h('p', {class: 'faint tiny', text: '已报 ' + item.entry_count + ' 人 · ' + item.seeded_count + ' 人有排名'}));
          const ranked = item.observed_entries.filter(p => p.seed_rank != null);
          if (ranked.length) body.append(h('details', {class: 'prediction-byes'},
            h('summary', {text: '当前排名（暂定） · ' + ranked.length + ' 人'}),
            h('ul', {}, ranked.map(p => h('li', {class: cls(p.country === 'CHN' && 'athlete-china'),
              text: '#' + p.seed_rank + ' ' + p.name + ' · ' + p.country + (p.world_rank ? ' · 世界排名 ' + p.world_rank : '')})))));
          if (item.prequalified.length) body.append(h('details', {class: 'prediction-byes'},
            h('summary', {text: '按当前排名计算的直通名单 · ' + item.prequalified.length + ' 人'}),
            h('ul', {}, item.prequalified.map(p => h('li', {class: cls(p.country === 'CHN' && 'athlete-china'), text: p.name + ' · ' + p.country})))));
        }
      } else {
        body.append(h('p', {class: 'faint tiny prediction-note', text: '首轮预测 · 不含出发道次，以官方分组为准'}));
        if (item.country_conflicts.length) body.append(h('p', {class: 'faint tiny', text: '同国选手回避以官方调整为准'}));
        const groups = item.groups.filter(g => !onlyChina || g.has_china);
        const grid = h('div', {class: 'prediction-grid'});
        for (const group of groups) grid.append(h('section', {class: cls('prediction-group', group.has_china && 'has-china')},
          h('h3', {text: '预测第 ' + group.heat_number + ' 组'}),
          h('ul', {}, group.participants.map(p => h('li', {class: cls(p.country === 'CHN' && 'athlete-china')},
            h('span', {class: 'faint num', text: '#' + p.seed_rank, title: '种子序号，非出发道次'}),
            h('b', {text: p.name}), h('small', {text: p.country}))))));
        body.append(grid);
        if (!groups.length) body.append(h('p', {class: 'faint athlete-empty', text: '预测分组中暂无 CHN 选手'}));
        if (item.prequalified.length) body.append(h('details', {class: 'prediction-byes'},
          h('summary', {text: '直通下一轮 · ' + item.prequalified.length + ' 人'}),
          h('ul', {}, item.prequalified.map(p => h('li', {class: cls(p.country === 'CHN' && 'athlete-china'), text: p.name + ' · ' + p.country})))));
      }
      body.append(h('details', {class: 'source-disclosure'},
        h('summary', {}, '来源与规则', dataset.checked_at ? h('time', {datetime: dataset.checked_at,
          text: '核对于 ' + sourceTime(dataset.checked_at)}) : null),
        h('div', {class: 'source-links'},
          ...(item.source_urls || []).map((url, i) => external(url, ['单项报项', '世巡赛排名', '世界排名'][i] || 'ISU 来源')),
          ...(dataset.rules || []).map(r => external(r.url, r.label))),
        item.updated_at ? h('p', {class: 'faint tiny', text: '更新于 ' + sourceTime(item.updated_at)}) : null,
        dataset.stale ? h('p', {class: 'faint tiny', text: '显示上次核对的数据'}) : null));
    };
    chinaOnly.addEventListener('click', () => {onlyChina = !onlyChina; chinaOnly.setAttribute('aria-pressed', String(onlyChina)); draw();});
    select.addEventListener('change', draw);
    box.append(h('div', {class: 'athlete-tools'}, select, chinaOnly), body);
    draw();
    return box;
  }

  function athleteList(dataset, title, ranking = false) {
    const people = dataset.items;
    const china = people.filter(p => p.country === 'CHN').length;
    const summary = h('summary', {class: 'athlete-summary'},
      h('b', {text: title}), h('span', {class: 'faint num', text: people.length ? people.length + (ranking ? ' 条' : ' 人') : '待公布'}),
      china ? h('span', {class: 'athlete-china num', text: 'CHN ' + china + (ranking ? ' 条' : ' 人')}) : null,
      dataset.stale && people.length ? h('small', {class: 'pill', text: '待更新'}) : null);
    const box = h('details', {class: 'panel athlete-panel'}, summary);
    if (!people.length) {
      box.append(h('p', {class: 'faint athlete-empty', text: title + '待公布'}));
      return box;
    }
    const countries = [...new Set(people.map(p => p.country))].sort((a, b) => a === 'CHN' ? -1 : b === 'CHN' ? 1 : a.localeCompare(b));
    const country = h('select', {'aria-label': title + '国家或地区'},
      h('option', {value: 'all', text: '全部国家 / 地区'}),
      countries.map(c => h('option', {value: c, text: c})));
    country.value = china ? 'CHN' : 'all';
    const sex = h('select', {'aria-label': title + '性别'},
      [['all', '全部'], ['women', '女子'], ['men', '男子'], ...(ranking ? [['mixed', '混合']] : [])]
        .map(([value, text]) => h('option', {value, text})));
    const count = h('p', {class: 'faint tiny', role: 'status'});
    const list = h('ul', {class: 'athlete-grid', 'aria-label': title + '列表'});
    const update = () => {
      const selected = people.filter(p => (country.value === 'all' || p.country === country.value) && (sex.value === 'all' || p.gender === sex.value));
      if (ranking) selected.sort((a, b) => a.ranking_type.localeCompare(b.ranking_type) || a.distance_m - b.distance_m || a.rank - b.rank);
      count.textContent = '显示 ' + selected.length + (ranking ? ' 条' : ' 人');
      fill(list, selected.map(p => h('li', {class: cls('athlete-card', p.country === 'CHN' && 'is-china'), dataset: {country: p.country}},
        h('span', {class: 'athlete-nation', text: p.country}),
        h('b', {class: 'athlete-name', text: p.name}),
        h('span', {class: 'athlete-caption'}, ranking ?
          [({'event': '单站排名', world_tour: '世巡赛积分', world: '世界排名'})[p.ranking_type] || p.ranking_type,
            ' · ' + (gender[p.gender] || '') + ' ' + p.distance_m + 'm · 第 ' + p.rank + ' 名',
            p.points != null ? ' · ' + p.points + ' 分' : null] :
          [gender[p.gender] || '', p.participation === 'substitute' ? h('span', {class: 'pill', text: '替补'}) : null]))));
      if (!selected.length) list.append(h('li', {class: 'faint athlete-empty', text: '当前筛选下没有运动员'}));
    };
    country.addEventListener('change', update);
    sex.addEventListener('change', update);
    box.append(h('div', {class: 'athlete-tools'}, country, sex, count), list,
      h('div', {class: 'athlete-source source-line'},
        dataset.updated_at ? h('span', {text: '更新于 ' + sourceTime(dataset.updated_at)}) : null,
        dataset.checked_at ? h('span', {text: '核对于 ' + sourceTime(dataset.checked_at)}) : null,
        dataset.source_urls?.[0] ? external(dataset.source_urls[0], '官方来源') : null));
    if (ranking) box.addEventListener('toggle', () => { if (box.open && !list.childElementCount) update(); });
    else update();
    return box;
  }

  function showCompetition(r, heats) {
    const titleId = 'competition-title';
    const close = h('button', {type: 'button', class: 'icon-btn', 'aria-label': '关闭比赛详情'}, icon('close'));
    const dialog = h('dialog', {class: 'competition-dialog', 'aria-labelledby': titleId},
      h('header', {class: 'competition-head'}, h('h2', {id: titleId, text: eventName(r) + ' · ' + roundName(r)}), close));
    for (const heat of [...heats].sort((a, b) => (a.heat_number ?? 0) - (b.heat_number ?? 0))) {
      const results = heat.evidence === 'official_results';
      const status = !results ? '分组' : heat.result_status?.toLowerCase() === 'official' ? '正式成绩' : '暂定成绩';
      const heading = heat.group ? heat.group + ' 组决赛' : heat.heat_number ? '第 ' + heat.heat_number + ' 组' : heat.heat_label;
      const people = h('ol', {class: 'result-people'});
      for (const p of heat.participants) {
        const result = p.penalty ? p.penalty.code + ' 判罚' : p.result || '—';
        people.append(h('li', {class: cls('result-person', p.country === 'CHN' && 'is-china')},
          h('span', {class: 'result-rank num', text: results ? p.rank ?? '—' : p.starting_position ?? '—',
            title: results ? '名次' : '出发位'}),
          h('div', {class: 'result-identity'}, h('b', {text: p.name}),
            h('span', {class: 'faint tiny', text: p.country + (p.helmet_number != null ? ' · #' + p.helmet_number : '')})),
          results ? h('div', {class: cls('result-value num', p.penalty && 'penalty-value')},
            h('b', {text: result}), p.qualification ? h('small', {text: ({Q: '晋级', q: '按成绩晋级', ADV: '判进'})[p.qualification] || p.qualification}) : null) :
            h('span', {class: 'faint tiny', text: p.starting_position != null ? '出发位 ' + p.starting_position : '已列入分组'})));
      }
      dialog.append(h('section', {class: 'competition-heat'},
        h('div', {class: 'competition-heat-head'}, h('h3', {text: heading}), h('span', {class: 'pill', text: status})), people));
    }
    if (heats[0]?.source_url) dialog.append(h('p', {class: 'source-line'}, external(heats[0].source_url, '官方来源')));
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', e => {
      if (e.target !== dialog) return;
      const b = dialog.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close();
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  function ticketPanel(st) {
    if (!st.ticketing || phase(st.win || stationWindow(st, null)) === 'done') return null;
    const open = Date.parse(st.ticketing.sale_start);
    const bj = parts(BJ, open), kr = parts(st.timezone, open);
    const when = '北京时间 ' + md(bj.date) + ' ' + wk(bj.date) + ' ' + dayPart(bj.hm) + ' ' + bj.hm;
    const onSale = now() >= open;
    return h('section', {class: 'panel ticket-panel', 'aria-label': st.city + '站售票'},
      h('div', {class: 'ticket-copy'},
        h('p', {class: 'eyebrow', text: st.city + '站 · 门票'}),
        h('h2', {text: onSale ? '门票已开售' : '售票信息'}),
        h('p', {class: 'ticket-time'},
          onSale ? '已于' + when + ' 开售' : when + ' 开售',
          '\u00a0· ', h('small', {class: 'nowrap', text: '韩国时间 ' + kr.hm}))),
      h('div', {class: 'ticket-actions'},
        external(st.ticketing.isu_url, 'ISU 售票说明'),
        external(st.ticketing.booking_url, 'Ticketlink 订票')));
  }

  /* ---------- season page ---------- */
  function renderSeason(cal, details) {
    setClocks([['北京时间', BJ]]);
    const stations = cal.stations.map((st, i) => ({...st, n: i + 1, win: stationWindow(st, details[st.id]), detail: details[st.id]}));
    const focus = stations.find(st => phase(st.win) === 'live') || stations.find(st => phase(st.win) === 'upcoming');
    const first = stations[0], last = stations[stations.length - 1];
    const lastEvent = cal.championships?.at(-1) || last;

    const head = h('section', {class: 'season-head'},
      h('p', {class: 'eyebrow', text: 'ISU 短道速滑赛事'}),
      h('h1', {}, cal.season + ' 赛季赛程'),
      h('p', {class: 'lead'}, phrases(stations.length + ' 站世巡赛', (cal.championships?.length || 0) + ' 场世锦赛',
        first.date_start.slice(0, 7).replace('-', '.') + ' — ' + lastEvent.date_end.slice(0, 7).replace('-', '.'), '北京时间')));

    root.replaceChildren(head,
      focus ? nextCard(focus) : h('section', {class: 'next-card is-done'}, h('h2', {text: '本赛季全部分站已结束'})),
      ...stations.map(ticketPanel).filter(Boolean),
      seasonLine(stations, focus), stationGrid(stations, focus),
      championshipsCard(cal),
      h('p', {class: 'source-line'}, external(cal.source_url, 'ISU 官方赛历')));
  }

  function championshipsCard(cal) {
    if (!cal.championships?.length) return null;
    return h('section', {class: 'championship-section', 'aria-label': '世界锦标赛'},
      h('h2', {class: 'section-title', text: '世界锦标赛'}),
      cal.championships.map(st => h('article', {class: 'panel championship-card'},
        h('div', {class: 'championship-main'},
          h('p', {class: 'championship-kicker', text: '2027 · ISU WORLD CHAMPIONSHIPS'}),
          h('h3', {text: st.title}),
          h('p', {class: 'championship-meta'}, icon('calendar'),
            dot(st.date_start) + ' — ' + dot(st.date_end),
            h('span', {text: st.city + ' · ' + st.city_en}))),
        h('a', {class: 'btn', href: stationHref(st.id)}, '查看世锦赛', icon('arrow')))));
  }

  function renderChampionship(cal, event) {
    setClocks([['北京时间', BJ], [event.city, event.timezone]]);
    const win = stationWindow(event, null);
    const copy = h('div', {class: 'hero-copy'},
      h('p', {class: 'eyebrow', text: cal.season + ' · ISU 短道速滑世界锦标赛'}),
      h('h1', {}, event.title, h('small', {text: event.city_en})),
      h('ul', {class: 'meta-list meta-inline'},
        h('li', {}, icon('calendar'),
          dot(event.date_start) + ' ' + wk(event.date_start) + ' — ' +
          dot(event.date_end) + ' ' + wk(event.date_end)),
        h('li', {}, icon('pin'), event.city + ' · ' + (event.venue || '场馆待公布')),
        h('li', {}, icon('globe'),
          utcLabel(event.timezone, win.start) + ' · ' + bjDiff(event.timezone, win.start))));
    const official = () => external(event.source_url, 'ISU 官方赛历');
    const schedule = h('section', {class: 'schedule-content'},
      h('section', {class: 'panel empty-state'},
        trackArt('empty-track', 2),
        h('h2', {text: '逐项赛程待公布'}),
        official()));
    const athletes = h('section', {class: 'schedule-content'},
      h('section', {class: 'panel empty-state'},
        h('h2', {text: '报名名单待公布'}),
        official()));
    const competition = {athletes, show: () => {}, startRounds: () => {}};
    root.replaceChildren(stationNav(cal, event),
      h('section', {class: 'station-hero'}, copy, pendingCard(win)));
    root.append(...stationTabs(schedule, competition, true));
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
          fill(item, phrases(eventName(e[i]) + ' ' + roundName(e[i]), '北京时间 ' + bjWhen(e[i])));
        } else {
          label.textContent = '全部轮次已按计划开赛';
          item.textContent = '';
        }
      } else {
        label.textContent = '距开幕还有';
        item.textContent = '详细赛程待公布 · 按当地 0 点倒计时';
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
          st.venue ? h('li', {}, icon('pin'), st.venue) : null),
        h('p', {class: 'st-foot'}, st.detail
          ? [h('span', {class: 'ok-text'}, icon('check'), '已录入 ' + st.detail.entries.length + ' 个轮次'), icon('arrow')]
          : h('span', {text: '详细赛程待公布'}))));
    }
    return h('section', {'aria-label': '七站赛历'}, h('h2', {class: 'section-title', text: '全部分站'}), grid);
  }

  /* ---------- station page ---------- */
  function stationNav(cal, current) {
    const list = h('div', {class: 'st-nav-list'}, cal.stations.map((st, i) => h('a', {href: stationHref(st.id),
      'aria-current': st.id === current.id ? 'page' : null},
      h('small', {class: 'num', text: i + 1}), st.city)));
    for (const event of cal.championships || []) {
      list.append(h('a', {class: 'championship-nav', href: stationHref(event.id),
        'aria-current': event.id === current.id ? 'page' : null, title: event.title}, '世锦赛'));
    }
    // Keep the current stage visible in the horizontally scrolling list.
    requestAnimationFrame(() => {
      const a = list.querySelector('[aria-current]');
      if (a) list.scrollLeft += a.getBoundingClientRect().left - list.getBoundingClientRect().left - (list.clientWidth - a.offsetWidth) / 2;
    });
    return h('nav', {class: 'st-nav', 'aria-label': '赛事切换'}, h('a', {class: 'back', href: './'}, icon('back'), '全部赛事'), list);
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
        data && data.status === 'provisional' ? h('li', {class: 'meta-note'}, icon('alert'), 'ISU 暂定赛程') : null));
    if (data) {
      copy.append(h('dl', {class: 'stats'},
        stat(Object.keys(data.day_counts).length, '比赛日'),
        stat(entries.length, '个轮次'),
        stat(entries.filter(isMedal).length, '场奖牌赛', 'stat-gold'),
        stat(chinaCount || '—', 'CHN 已确认', chinaCount ? 'stat-red' : 'stat-dim')));
      copy.append(syncLine(data));
    }
    root.replaceChildren(stationNav(cal, station),
      h('section', {class: 'station-hero'}, copy, data ? liveCard(data, station) : pendingCard(win)),
      ...(station.ticketing ? [ticketPanel(station)] : []));
    const competition = competitionPanel(station);
    const schedule = h('section', {class: 'schedule-content'});

    if (!data) {
      schedule.append(competition.status, h('section', {class: 'panel empty-state'},
        trackArt('empty-track', 2),
        h('h2', {text: '详细赛程尚未录入'}),
        h('p', {}, external(cal.source_url, 'ISU 官方赛历'))));
    } else {
      scheduleView(data, station, schedule, competition.status);
    }
    root.append(...stationTabs(schedule, competition));
  }

  const stat = (v, label, className) => h('div', {class: cls('stat', className)}, h('dd', {class: 'num', text: v}), h('dt', {text: label}));

  function syncLine(data) {
    const at = data.sync && data.sync.last_successful_schedule_check_utc;
    if (!at) return h('p', {class: 'sync sync-bad'}, icon('alert'), '官方赛程核对尚未成功，当前显示上次可信快照');
    const t = Date.parse(at);
    const rel = h('span');
    const p = parts(BJ, t);
    tick(() => { rel.textContent = ago(t); });
    return h('p', {class: 'sync', title: '北京时间 ' + md(p.date) + ' ' + p.hm}, h('i', {class: 'dot-ok'}), '已与 ISU 官方赛程核对 · ', rel);
  }

  function pendingCard(win) {
    const cd = countdown('cd-lg');
    const ph = phase(win);
    tick(() => cd.set(win.start - now()));
    const p = parts(BJ, win.start);
    return h('aside', {class: 'live-card'},
      h('p', {class: 'live-label', text: ph === 'upcoming' ? '距开幕还有' : ph === 'live' ? '本站正在进行' : '本站已结束'}),
      ph === 'upcoming' ? cd : null,
      h('p', {class: 'live-sub'}, phrases('北京时间 ' + md(p.date) + ' ' + wk(p.date) + ' ' + dayPart(p.hm) + ' ' + p.hm + ' 开幕', '按当地 0 点')));
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
            isChina(r) ? h('span', {class: 'chn-tag'}, icon('star', 'ico ico-xs'), 'CHN') : null);
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
        fill(box, icon('star', 'ico star-ico'), h('span', {}, h('b', {text: 'CHN'}),
          entries.some(isChina) ? ' 已确认的场次均已开赛' : ' 官方分组公布后自动标出'));
        return;
      }
      const hs = r.china.heats;
      fill(box, icon('star', 'ico star-ico'), h('span', {}, h('b', {text: 'CHN 下一场 '}),
        eventName(r) + ' ' + roundName(r) + ' 第' + hs.map(x => x.number).join('、') + '组 · 北京 ' + bjWhen(r),
        h('small', {}, ' · 预计出场 ' + hs[0].estimate.earliest_beijing.slice(11, 16) + ' 起', h('em', {class: 'est-tag', text: '估算'}))));
    });
    return box;
  }

  const view = {};
  function scrollToRow(r) {
    if (!r) return;
    view.showSchedule?.();
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

  function scheduleView(data, station, host, competitionStatus) {
    const entries = data.entries;
    const days = raceDays(entries);
    const blank = {day: 'all', gender: 'all', stage: 'all', china: false};
    const state = {...blank, zone: storedZone()};
    if (days.some(d => d.local === params.get('day'))) state.day = params.get('day');
    const chinaCount = entries.filter(isChina).length;
    const genderOpts = [['all', '全部'], ['women', '女子'], ['men', '男子'], ['mixed', '混合'], ['relay', '接力']];
    const stageOpts = [['all', '全部'], ['qualifying', '资格赛'], ['repechage', '复活赛'], ['main', '决赛阶段'], ['final', 'A/B组决赛']];

    const overview = h('section', {class: 'overview'});
    const overviewBox = h('details', {class: 'schedule-overview'},
      h('summary', {}, '赛程概览', h('span', {class: 'faint tiny', text: '比赛时段 · 奖牌赛'})), overview);
    const drawOverview = () => {
      if (overviewBox.open) fill(overview, ribbon(entries, days, state, station, liveIndex(entries)), finalsBoard(entries.filter(isMedal), state));
    };
    overviewBox.addEventListener('toggle', drawOverview);
    const counter = h('div', {class: 'counter', 'aria-live': 'polite'});
    const container = h('div', {class: 'days'});
    const set = patch => { Object.assign(state, patch); redraw(); };
    view.reset = () => { Object.assign(state, blank); redraw(); };
    view.refreshHeats = () => {
      for (const r of entries) {
        const note = document.getElementById('r-' + r.id)?.querySelector('.notes-cell');
        if (note) updateHeatButton(note, r);
      }
    };

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
      onclick: () => set({china: !state.china})}, icon('star', 'ico ico-sm'), '只看 CHN',
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
    view.closeFilters = () => { if (!panel.hidden) toggle(false); };
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

    host.append(overviewBox, bar, counter, competitionStatus, container,
      h('p', {class: 'source-line'}, external(data.source_url, 'ISU 官方赛程')));

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

      drawOverview();

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
        state.china ? clear('只看 CHN', {china: false}) : null,
        h('span', {class: 'legend'}, h('span', {class: 'lg lg-gold', text: '奖牌赛'}), h('span', {class: 'lg lg-red', text: 'CHN'})));

      container.replaceChildren();
      for (const d of days) {
        const items = rows.filter(r => r.local_date === d.local);
        if (!items.length) continue;
        container.append(daySection(d, items, bjFirst, nextI, station, entries));
      }
      if (!rows.length) {
        container.append(h('div', {class: 'panel empty-filter'}, h('p', {text: '当前筛选条件下没有比赛'}),
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
      china ? h('strong', {class: 'china-label'}, icon('star', 'ico ico-xs'), ' CHN') : null);
    cell(labels[4], 'round-cell', h('span', {class: 'round-name', text: roundName(r)}), ' ', stageMeter(r));
    cell(labels[5], 'group-cell' + (r.group ? '' : ' is-empty'),
      r.group ? h('span', {class: 'grp grp-' + r.group}, r.group === 'A' ? icon('medal', 'ico ico-xs') : null, r.group + ' 组',
        h('small', {text: r.group === 'A' ? '奖牌' : '排位'})) : '—');
    const heats = officialHeats.get(r.round_key) || [];
    const note = cell(labels[6], 'notes-cell tiny' + (china || heats.length ? '' : ' is-empty'));
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
      note.append(external(r.china.source_url, '来源'));
    }
    updateHeatButton(note, r);
    return tr;
  }

  function updateHeatButton(note, r) {
    note.querySelector('.competition-open')?.remove();
    const heats = officialHeats.get(r.round_key) || [];
    note.classList.toggle('is-empty', !isChina(r) && !heats.length);
    if (heats.length) note.append(h('button', {type: 'button', class: 'competition-open',
      'aria-label': '查看' + eventName(r) + roundName(r) + '分组与成绩', onclick: () => showCompetition(r, heats)},
      heats.some(x => x.evidence === 'official_results') ? '查看成绩' : '查看分组', icon('arrow', 'ico ico-xs')));
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
      h('p', {class: 'rb-legend'}, h('span', {class: 'lg lg-gold', text: 'A 组决赛'}),
        h('span', {class: 'lg lg-plain', text: '其他轮次'}), h('span', {class: 'lg lg-red', text: 'CHN / 现在'})));
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

  /* ---------- what's new ---------- */
  // Official milestones since this viewer last closed the bar; a first visit sees the last 3 days.
  const SEEN_KEY = 'ssts.updates.seen';
  const MEDAL = {1: '金', 2: '银', 3: '铜'};
  function seenAt() {
    try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (_) { return 0; }
  }
  const roundOf = e => eventName(e) + ' ' + (e.repechage ? '复活赛' : '') + roundName(e);
  const roundIdent = e => [e.station, e.local_date, e.gender, e.distance_m, e.format, e.round, e.group, e.repechage].join('|');
  function notice(e) {
    const china = (e.china || []).length;
    const chinaNote = !china ? '' : e.format === 'relay' ? ' · 中国队在列' : ' · 中国队 ' + china + ' 人';
    switch (e.kind) {
      case 'schedule': return {text: '详细赛程已公布 · 共 ' + e.count + ' 轮'};
      case 'entries': return {text: (e.changed ? '报名名单已更新' : '报名名单已公布') + ' · 共 ' + e.count + ' 人'};
      case 'rankings': return {text: e.changed ? '分站排名已更新' : '分站最终排名已公布'};
      case 'groups': return {text: roundOf(e) + ' 分组已公布' + chinaNote, chn: china > 0,
        sub: china && e.format !== 'relay' ? h('span', {class: 'is-chn', text: '中国队：' + e.china.join('、')}) : null};
      case 'results': {
        const podium = e.podium || [];
        const champ = podium.find(p => p.rank === 1);
        return {text: roundOf(e) + ' 成绩已公布' + (champ ? ' · 冠军 ' + champ.name : chinaNote),
          gold: podium.length > 0, chn: podium.some(p => p.country === 'CHN') || (!podium.length && china > 0),
          sub: podium.map(p => h('span', {class: cls('upd-medal', p.country === 'CHN' && 'is-chn'), text: MEDAL[p.rank] + ' ' + p.name + ' ' + p.country}))};
      }
      case 'time_change': {
        const [pd, pt] = e.previous.split(' '), [cd, ct] = e.current.split(' ');
        return {text: roundOf(e) + ' 时间调整', alert: true,
          sub: '北京时间 ' + (pd === cd ? '' : md(pd) + ' ') + pt + ' → ' + md(cd) + ' ' + wk(cd) + ' ' + dayPart(ct) + ' ' + ct};
      }
      default: return null;
    }
  }
  function updatesBar(feed, stations, current) {
    const seen = seenAt();
    const since = Math.max(seen, now() - (seen ? 7 : 3) * DAY);
    const byId = new Map(stations.map(st => [st.id, st]));
    const fresh = (feed.events || []).filter(e => byId.has(e.station) && Date.parse(e.at) > since && Date.parse(e.at) <= now());
    // A round's results supersede its "groups published" line.
    const resulted = new Set(fresh.filter(e => e.kind === 'results').map(roundIdent));
    const items = fresh.filter(e => !(e.kind === 'groups' && resulted.has(roundIdent(e))))
      .map(e => ({e, n: notice(e)})).filter(x => x.n);
    if (!items.length) return null;
    const newest = Math.max(...fresh.map(e => Date.parse(e.at)));
    const listId = 'updates-list';
    // On a station's own page its name would only repeat the page title.
    const where = e => e.station === current ? '' : byId.get(e.station).city + '站';
    const toneOf = n => n.chn ? 'is-chn' : n.gold ? 'is-a' : n.alert ? 'is-alert' : '';
    const list = h('ol', {class: 'upd-list', id: listId, hidden: true}, items.map(({e, n}) =>
      h('li', {class: toneOf(n)},
        h('a', {href: stationHref(e.station, e.local_date)},
          h('span', {class: 'upd-text'}, where(e) ? h('b', {text: where(e) + ' '}) : null, n.text),
          n.sub && (!Array.isArray(n.sub) || n.sub.length) ? h('span', {class: 'upd-sub'}, n.sub) : null,
          h('time', {class: 'upd-when', datetime: e.at, text: ago(Date.parse(e.at))})))));
    const lead = items[0];
    const head = h('button', {type: 'button', class: 'upd-head', 'aria-expanded': 'false', 'aria-controls': listId},
      h('span', {class: cls('upd-dot', toneOf(lead.n)), 'aria-hidden': 'true'}),
      h('span', {class: 'upd-title'}, icon('bell', 'ico ico-sm'), '新动态',
        items.length > 1 ? h('span', {class: 'upd-count num', text: String(items.length)}) : null),
      h('span', {class: 'upd-latest', text: (where(lead.e) ? where(lead.e) + ' · ' : '') + lead.n.text}),
      h('span', {class: 'upd-when', text: ago(Date.parse(lead.e.at))}),
      icon('chev', 'ico ico-sm upd-chev'));
    const bar = h('section', {class: 'updates', 'aria-label': '最新动态'}, head,
      h('button', {type: 'button', class: 'upd-close', 'aria-label': '关闭，这些动态不再提醒',
        onclick: () => {
          try { localStorage.setItem(SEEN_KEY, String(newest)); } catch (_) { /* private mode */ }
          bar.remove();
        }}, icon('close', 'ico ico-sm')),
      list);
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', String(open));
      list.hidden = !open;
    });
    return bar;
  }

  /* ---------- boot ---------- */
  try {
    const updates = fetchData('updates.json').catch(() => null);
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
      const championship = (calendar.championships || []).find(st => st.id === requested);
      if (championship) {
        document.title = championship.title + '｜2027 短道速滑赛程';
        renderChampionship(calendar, championship);
      } else {
        const station = calendar.stations.find(st => st.id === requested);
        if (!station) throw new Error('未知赛事');
        document.title = station.city + '站赛程｜2026/27 短道速滑世界巡回赛';
        const details = station.detail_status === 'verified' ? prepare(await fetchData(station.id + '.json')) : null;
        renderStation(calendar, station, details);
      }
    }
    // Offline, the service worker serves the last saved copy; say so instead of looking live.
    const offline = h('p', {class: 'offline-note', role: 'status', hidden: navigator.onLine !== false},
      h('span', {class: 'upd-dot', 'aria-hidden': 'true'}), '当前离线，显示的是上次联网时保存的赛程');
    root.prepend(offline);
    addEventListener('online', () => { offline.hidden = true; });
    addEventListener('offline', () => { offline.hidden = false; });
    // Installable app with offline fallback; jsdom and plain-http previews skip it.
    if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
    updates.then(feed => { const bar = feed && updatesBar(feed, calendar.stations, requested); if (bar) offline.after(bar); });
    // Back-to-top for long phone lists.
    const top = h('button', {type: 'button', class: 'to-top', 'aria-label': '回到顶部',
      onclick: () => scrollTo({top: 0, behavior: reduceMotion ? 'auto' : 'smooth'})}, icon('up'));
    document.body.append(top);
    addEventListener('scroll', () => top.classList.toggle('show', scrollY > innerHeight * 1.2), {passive: true});
  } catch (e) {
    root.replaceChildren(h('div', {class: 'panel error'}, icon('alert'),
      h('p', {text: '赛程暂时无法加载，请重试。'}),
      h('button', {type: 'button', class: 'btn', onclick: () => location.reload()}, '重新加载'),
      h('a', {class: 'btn', href: './'}, '返回首页')));
  } finally {
    root.removeAttribute('aria-busy');
  }
})();
