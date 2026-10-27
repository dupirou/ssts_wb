/* Site-level pages. Current event details keep their own schedule and roster views. */
(function () {
  'use strict';
  const site = window.SSTS = window.SSTS || {};
  const cycles = [
    {label: '平昌周期', years: '2014 — 2018', seasons: '2014/15 — 2017/18'},
    {label: '北京周期', years: '2018 — 2022', seasons: '2018/19 — 2021/22'},
    {label: '米兰周期', years: '2022 — 2026', seasons: '2022/23 — 2025/26'},
  ];
  function header(h, eyebrow, title, description) {
    return h('section', {class: 'season-head'}, h('p', {class: 'eyebrow', text: eyebrow}),
      h('h1', {text: title}), h('p', {class: 'lead', text: description}));
  }
  async function home(ctx, calendar, details) {
    const {h, icon, root, nextCard, stationWindow, phase, fetchData, stationHref, ticketPanel, now} = ctx;
    const stations = calendar.stations.map((st, i) => ({...st, n: i + 1,
      detail: details[st.id], win: stationWindow(st, details[st.id])}));
    const events = [...stations, ...(calendar.championships || []).map(st => ({...st, isChampionship: true, win: stationWindow(st, null)}))];
    const focus = events.find(s => phase(s.win) === 'live') || events.find(s => phase(s.win) === 'upcoming');
    const recent = h('section', {class: 'home-recent', 'aria-label': '最近赛果'},
      h('div', {class: 'portal-section-head'}, h('h2', {class: 'section-title', text: '最近赛果'}),
        h('a', {class: 'text-link', href: '/events/'}, '全部赛事', icon('arrow'))));
    root.replaceChildren(header(h, 'SHORT TRACK', '短道速滑', '看当下的比赛，也看更长的赛场。'),
      focus ? nextCard(focus) : h('section', {class: 'panel empty-state'},
        h('h2', {text: '本赛季比赛已结束'}), h('a', {class: 'btn', href: '/events/'}, '回看本赛季')),
      ...stations.map(ticketPanel).filter(Boolean), recent,
      h('section', {class: 'portal-entry-grid', 'aria-label': '探索短道'},
        h('a', {class: 'panel portal-entry', href: '/history/'}, icon('history'),
          h('h2', {text: '历史回顾'}), h('p', {text: '按奥运周期，回看项目与队伍的变化'}), icon('arrow')),
        h('a', {class: 'panel portal-entry', href: '/athletes/'}, icon('people'),
          h('h2', {text: '运动员'}), h('p', {text: '查找已公布名单和运动员报项'}), icon('arrow'))));
    // A missing summary must not block the next-event card or the rest of the homepage.
    try {
      const summary = await fetchData('portal.json');
      const finals = (summary.finals || []).filter(f => Date.parse(f.utc_start) <= now()).slice(0, 6);
      if (!finals.length) {
        recent.append(h('p', {class: 'panel faint', text: '正式决赛成绩公布后，在这里回看。'}));
        return;
      }
      recent.append(h('div', {class: 'recent-grid'}, finals.map(f => h('a', {
        class: 'panel recent-card', href: stationHref(f.event_id, f.local_date) + '#r-' + f.schedule_id,
      }, h('span', {class: 'eyebrow', text: f.city + ' · ' + f.local_date.slice(5).replace('-', '/')}),
      h('h3', {text: f.label}), h('ol', {class: 'recent-podium'}, f.podium.map(p => h('li', {},
        h('span', {class: 'num podium-place', text: p.rank}), h('b', {text: p.name}),
        h('span', {class: p.country === 'CHN' ? 'athlete-china' : 'faint', text: p.country}))))))));
    } catch (_) {
      recent.append(h('p', {class: 'panel faint'}, '最近赛果暂时无法加载。',
        h('a', {class: 'text-link', href: '/events/'}, '前往赛事页')));
    }
  }
  function history(ctx) {
    const {h, icon, root} = ctx;
    root.replaceChildren(header(h, 'OLYMPIC CYCLES', '历史回顾', '以四年为一段，观察赛季、项目与队伍。'),
      h('section', {class: 'panel history-intro'}, icon('history'),
        h('h2', {text: '历史成绩正在整理'}), h('p', {class: 'faint', text: '收录后可按周期、国家和单项查看，并展开到每场比赛。'}),
        h('a', {class: 'text-link', href: '/events/'}, '先回看本赛季赛事', icon('arrow'))),
      h('section', {class: 'cycle-grid', 'aria-label': '奥运周期'}, cycles.map(c => h('article', {class: 'panel cycle-card'},
        h('p', {class: 'eyebrow num', text: c.years}), h('h2', {text: c.label}), h('p', {class: 'faint', text: c.seasons})))));
  }
  async function athletes(ctx, calendar) {
    const {h, root, fetchData, stationHref} = ctx;
    root.replaceChildren(header(h, 'ATHLETES', '运动员', calendar.season + ' 赛季 · 已公布报名名单'),
      h('p', {class: 'athlete-loading', role: 'status', text: '正在读取运动员名单…'}));
    try {
      const index = await fetchData('athletes.json');
      const form = h('form', {class: 'directory-tools', role: 'search', 'aria-label': '查找运动员'});
      const q = h('input', {type: 'search', name: 'q', placeholder: '姓名或国家代码', 'aria-label': '搜索运动员', autocomplete: 'off'});
      const country = h('select', {name: 'country', 'aria-label': '运动员国家或地区'},
        h('option', {value: 'all', text: '全部国家 / 地区'}),
        [...new Set(index.items.map(p => p.country))].sort().map(c => h('option', {value: c, text: c})));
      const sex = h('select', {name: 'gender', 'aria-label': '运动员性别'},
        [['all', '全部'], ['women', '女子'], ['men', '男子']].map(([value, text]) => h('option', {value, text})));
      const params = new URLSearchParams(location.search);
      q.value = params.get('q') || '';
      if ([...country.options].some(o => o.value === params.get('country'))) country.value = params.get('country');
      if (['women', 'men'].includes(params.get('gender'))) sex.value = params.get('gender');
      const count = h('p', {class: 'directory-count faint', role: 'status'});
      const list = h('ul', {class: 'directory-grid'});
      const draw = () => {
        const query = q.value.trim().toLocaleLowerCase();
        const people = index.items.filter(p => (country.value === 'all' || p.country === country.value) &&
          (sex.value === 'all' || p.gender === sex.value) &&
          (!query || query.split(/\s+/).every(token => (p.name + ' ' + p.country + ' ' + (p.aliases || []).join(' ')).toLocaleLowerCase().includes(token))));
        count.textContent = '显示 ' + people.length + ' 人 · 共 ' + index.items.length + ' 人';
        list.replaceChildren(...people.map(p => h('li', {class: 'panel directory-card'},
          h('div', {class: 'directory-identity'}, h('span', {class: p.country === 'CHN' ? 'athlete-china' : 'athlete-nation', text: p.country}),
            h('h2', {text: p.name}), h('small', {class: 'faint', text: p.gender === 'women' ? '女子' : '男子'})),
          h('p', {class: 'faint tiny', text: '已报名 ' + p.events.length + ' 场赛事'}),
          h('div', {class: 'directory-event-links'}, p.events.map(e => h('a', {
            href: stationHref(e.event_id) + '?view=athletes&country=' + p.country + '#athlete-' + p.id,
          }, e.city + '报名'))))));
        if (!people.length) list.append(h('li', {class: 'panel empty-state', text: '没有符合条件的运动员'}));
      };
      const update = () => {
        const url = new URL(location.href);
        for (const [name, value] of [['q', q.value], ['country', country.value], ['gender', sex.value]]) {
          if (value && value !== 'all') url.searchParams.set(name, value); else url.searchParams.delete(name);
        }
        window.history.replaceState(null, '', url);
        draw();
      };
      form.addEventListener('submit', e => {e.preventDefault(); update();});
      q.addEventListener('input', update);
      country.addEventListener('change', update);
      sex.addEventListener('change', update);
      form.append(h('label', {class: 'directory-search'}, h('span', {class: 'sr-only', text: '姓名或国家代码'}), q), country, sex);
      root.replaceChildren(header(h, 'ATHLETES', '运动员', calendar.season + ' 赛季 · 已公布报名名单'), form, count, list);
      draw();
    } catch (_) {
      root.replaceChildren(header(h, 'ATHLETES', '运动员', '已公布报名名单'),
        h('section', {class: 'panel empty-state'}, h('h2', {text: '名单暂时无法加载'}),
          h('button', {class: 'btn', type: 'button', onclick: () => athletes(ctx, calendar)}, '重试')));
    }
  }
  site.portal = {home, history, athletes};
})();
