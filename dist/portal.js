/* Site-level pages. Current event details keep their own schedule and roster views. */
(function () {
  'use strict';
  const site = window.SSTS = window.SSTS || {};
  function header(h, title, description) {
    return h('section', {class: 'season-head'}, h('h1', {text: title}),
      description ? h('p', {class: 'lead', text: description}) : null);
  }
  function home(ctx, calendar, details) {
    const {h, root, nextCard, stationWindow, phase, ticketPanel} = ctx;
    const stations = calendar.stations.map((st, i) => ({...st, n: i + 1,
      detail: details[st.id], win: stationWindow(st, details[st.id])}));
    const events = [...stations, ...(calendar.championships || []).map(st => ({...st, isChampionship: true, win: stationWindow(st, null)}))];
    const focus = events.find(s => phase(s.win) === 'live') || events.find(s => phase(s.win) === 'upcoming');
    root.replaceChildren(header(h, '短道速滑', calendar.season),
      focus ? nextCard(focus) : h('section', {class: 'panel empty-state'},
        h('h2', {text: '本赛季比赛已结束'}), h('a', {class: 'btn', href: '/events/'}, '查看赛事')),
      ...stations.map(ticketPanel).filter(Boolean));
  }
  async function results(ctx, calendar) {
    const {h, root, fetchData, stationHref, now} = ctx;
    const past = location.pathname.replace(/\/+$/, '') === '/history' || new URLSearchParams(location.search).get('view') === 'history';
    const nav = h('nav', {class: 'results-nav', 'aria-label': '成绩范围'},
      [['current', '本赛季', '/results/'], ['history', '历史', '/results/?view=history']].map(([id, text, href]) =>
        h('a', {href, text, 'aria-current': (past ? id === 'history' : id === 'current') ? 'page' : null})));
    const recent = h('section', {class: past ? 'results-history' : 'results-recent', 'aria-label': past ? '历史成绩' : '最近赛果'},
      h('div', {class: 'portal-section-head'}, h('h2', {class: 'section-title', text: past ? '中国队' : calendar.season + ' · 最近赛果'})),
      h('p', {class: 'results-loading faint', role: 'status', text: '正在读取成绩…'}));
    root.replaceChildren(header(h, '成绩'), nav, recent);
    if (past) { await historical(ctx, recent); return; }
    try {
      const summary = await fetchData('portal.json');
      recent.querySelector('.results-loading').remove();
      const finals = (summary.finals || []).filter(f => Date.parse(f.utc_start) <= now());
      if (!finals.length) {
        recent.append(h('p', {class: 'panel faint', text: '成绩待公布'}));
        return;
      }
      recent.append(h('div', {class: 'recent-grid'}, finals.map(f => h('a', {
        class: 'panel recent-card', href: stationHref(f.event_id, f.local_date) + '#r-' + f.schedule_id,
      }, h('span', {class: 'eyebrow', text: f.city + ' · ' + f.local_date.slice(5).replace('-', '/')}),
      h('h3', {text: f.label}), h('ol', {class: 'recent-podium'}, f.podium.map(p => h('li', {},
        h('span', {class: 'num podium-place', text: p.rank}), h('b', {text: p.name}),
        h('span', {class: p.country === 'CHN' ? 'athlete-china' : 'faint', text: p.country}))))))));
    } catch (_) {
      recent.querySelector('.results-loading')?.remove();
      recent.append(h('p', {class: 'panel faint'}, '成绩暂时无法加载。',
        h('button', {class: 'btn', type: 'button', onclick: () => results(ctx, calendar)}, '重试')));
    }
  }
  async function historical(ctx, panel) {
    const {h, fetchData, external} = ctx;
    try {
      const index = await fetchData('history/index.json');
      const params = new URLSearchParams(location.search);
      const people = Object.fromEntries(index.athletes.map(p => [p.id, p]));
      let cycleId = index.cycles.some(c => c.id === params.get('cycle')) ? params.get('cycle') : index.cycles.at(-1).id;
      const choose = (name, label, values) => {
        const select = h('select', {name, 'aria-label': label}, values.map(([value, text]) => h('option', {value, text})));
        if (values.some(([value]) => value === params.get(name))) select.value = params.get(name);
        return select;
      };
      const season = choose('season', '历史赛季', [['all', '全部赛季']]);
      const kind = choose('kind', '历史赛事类型', [['all', '全部赛事'], ['olympics', '冬奥会'], ['worlds', '世锦赛'], ['worldtour', '世巡赛'], ['worldcup', '世界杯']]);
      const gender = choose('gender', '历史性别', [['all', '全部'], ['women', '女子'], ['men', '男子'], ['mixed', '混合']]);
      const distance = choose('distance', '历史距离', [['all', '全部单项'], ...[500, 1000, 1500, 2000, 3000, 5000].map(d => [String(d), d + 'm'])]);
      const search = h('input', {type: 'search', name: 'athlete', 'aria-label': '历史运动员', placeholder: '运动员', value: params.get('athlete') || ''});
      const form = h('form', {class: 'history-tools', role: 'search', 'aria-label': '历史成绩筛选'}, season, kind, gender, distance, search);
      const summary = h('p', {class: 'history-count faint', role: 'status'});
      const list = h('div', {class: 'history-events'});
      const pending = h('details', {class: 'panel history-coverage'});
      const cycles = h('div', {class: 'cycle-grid', 'aria-label': '奥运周期'}, index.cycles.map(c => h('button', {
        type: 'button', class: 'panel cycle-card', 'data-cycle': c.id,
        onclick: () => {cycleId = c.id; fillSeasons(); update();},
      }, h('b', {text: c.label}), h('span', {class: 'faint tiny', text: c.seasons[0] + ' — ' + c.seasons.at(-1)}),
      h('span', {class: 'tiny', text: index.events.some(e => c.seasons.includes(e.season)) ? '已收录 ' + index.events.filter(e => c.seasons.includes(e.season)).length + ' 场' : '尚未收录'}))));
      const label = r => ({women: '女子', men: '男子', mixed: '混合'})[r.gender] + ' ' + r.distance_m + 'm' + (r.format === 'relay' ? ' 接力' : '');
      const name = r => r.format === 'relay' ? '中国队' : people[r.athlete_id]?.name || r.name;
      const lineup = r => {
        if (!r.members?.length) return null;
        const rounds = [...new Set(r.members.flatMap(m => m.rounds))];
        const labels = {P: '预赛', H: '预赛', QF: '1/4 决赛', SF: '半决赛', FB: 'B 决赛', FA: 'A 决赛'};
        return h('details', {class: 'history-lineup'}, h('summary', {text: '出场阵容'}),
          rounds.map(code => h('p', {}, h('b', {text: labels[code] || code}), ' · ',
            r.members.filter(m => m.rounds.includes(code)).map(m => people[m.athlete_id]?.name || m.name).join('、'))));
      };
      const draw = () => {
        const cycle = index.cycles.find(c => c.id === cycleId);
        for (const button of cycles.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.cycle === cycleId));
        const eventMatch = e => cycle.seasons.includes(e.season) && (season.value === 'all' || e.season === season.value) && (kind.value === 'all' || e.kind === kind.value);
        const query = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const rowMatch = r => (gender.value === 'all' || r.gender === gender.value) && (distance.value === 'all' || String(r.distance_m) === distance.value) &&
          query.every(token => [name(r), r.name, ...(r.members || []).flatMap(m => [people[m.athlete_id]?.name || '', m.name])].join(' ').toLocaleLowerCase().includes(token));
        const events = index.events.filter(eventMatch).map(e => ({...e, results: e.results.filter(rowMatch)})).filter(e => e.results.length);
        const rows = events.flatMap(e => e.results);
        summary.textContent = events.length ? '当前筛选 ' + events.length + ' 场 · ' + rows.length + ' 条成绩' : '暂无已收录成绩';
        list.replaceChildren(...events.map((e, i) => h('details', {class: 'panel history-event', open: i === 0},
          h('summary', {}, h('span', {}, h('b', {text: e.title}), h('small', {class: 'faint', text: e.season + ' · ' + e.date_start + ' — ' + e.date_end})),
            h('span', {class: 'history-medals num', text: [1, 2, 3].map((rank, n) => { const count = e.results.filter(r => r.rank === rank).length; return count ? count + [' 金', ' 银', ' 铜'][n] : ''; }).filter(Boolean).join(' · ')})),
          h('ol', {class: 'history-result-list'}, e.results.map(r => h('li', {class: 'history-result'},
            h('span', {class: 'faint tiny', text: label(r)}), h('b', {text: name(r)}),
            h('span', {class: 'history-place num', text: r.rank === null ? r.status : '第 ' + r.rank + ' 名'}),
            h('small', {class: 'faint', text: [r.final_group ? r.final_group + ' 决赛' : '', r.status === 'classified' ? '' : r.status].filter(Boolean).join(' · ')}), lineup(r)))),
          external(e.source.url + '#page=' + Math.min(...e.results.map(r => r.source_page)), '官方成绩册'))));
        if (!events.length) list.append(h('p', {class: 'panel empty-state', text: '暂无已收录成绩'}));
        const missing = index.pending.filter(eventMatch);
        pending.hidden = !missing.length;
        pending.replaceChildren(h('summary', {text: '待收录 ' + missing.length + ' 场'}),
          h('ul', {}, missing.map(e => h('li', {text: e.title + ' · ' + e.season}))));
      };
      const fillSeasons = (initial = false) => {
        const values = index.cycles.find(c => c.id === cycleId).seasons;
        season.replaceChildren(h('option', {value: 'all', text: '全部赛季'}), ...values.map(s => h('option', {value: s, text: s})));
        if (initial && values.includes(params.get('season'))) season.value = params.get('season');
      };
      const update = () => {
        const url = new URL(location.href);
        url.pathname = '/results/';
        url.searchParams.set('view', 'history'); url.searchParams.set('cycle', cycleId);
        for (const el of [season, kind, gender, distance, search]) {
          if (el.value && el.value !== 'all') url.searchParams.set(el.name, el.value); else url.searchParams.delete(el.name);
        }
        window.history.replaceState(null, '', url); draw();
      };
      form.addEventListener('submit', e => {e.preventDefault(); update();});
      form.addEventListener('change', update); search.addEventListener('input', update);
      panel.replaceChildren(h('div', {class: 'portal-section-head'}, h('h2', {class: 'section-title', text: '中国队'})), cycles, form, summary, list, pending);
      fillSeasons(true); draw();
    } catch (_) {
      panel.replaceChildren(h('p', {class: 'panel faint'}, '历史成绩暂时无法加载。',
        h('button', {class: 'btn', type: 'button', onclick: () => historical(ctx, panel)}, '重试')));
    }
  }
  async function athletes(ctx, calendar) {
    const {h, root, fetchData} = ctx;
    root.replaceChildren(header(h, '运动员', calendar.season),
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
          p.season_rankings?.length ? h('section', {class: 'directory-rankings', 'aria-label': '本赛季世巡赛排名'},
            h('h3', {class: 'faint tiny', text: '本赛季世巡赛排名'}),
            h('dl', {}, p.season_rankings.map(r => h('div', {},
              h('dt', {text: r.distance_m + 'm'}), h('dd', {class: 'num', text: '第 ' + r.rank + ' 名'}))))) : null)));
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
      root.replaceChildren(header(h, '运动员', calendar.season), form,
        index.ranking_as_of?.length ? h('p', {class: 'ranking-as-of faint tiny', text: '排名截至' + index.ranking_as_of.map(e => e.city + '站').join('、')}) : null, count, list);
      draw();
    } catch (_) {
      root.replaceChildren(header(h, '运动员', calendar.season),
        h('section', {class: 'panel empty-state'}, h('h2', {text: '名单暂时无法加载'}),
          h('button', {class: 'btn', type: 'button', onclick: () => athletes(ctx, calendar)}, '重试')));
    }
  }
  site.portal = {home, results, athletes};
})();
