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
  async function results(ctx) {
    const {h, root, fetchData, external} = ctx;
    const panel = h('section', {class: 'results-browser', 'aria-label': '中国队成绩'},
      h('p', {class: 'faint', role: 'status', text: '正在读取成绩…'}));
    root.replaceChildren(h('div', {class: 'results-heading'}, h('h1', {text: '成绩'}), h('span', {class: 'faint tiny', text: '中国队'})), panel);
    try {
      const index = await fetchData('results.json');
      const params = new URLSearchParams(location.search);
      const people = Object.fromEntries(index.athletes.map(p => [p.id, p]));
      const choose = (name, label, values) => {
        const select = h('select', {name, 'aria-label': label}, values.map(([value, text]) => h('option', {value, text})));
        if (values.some(([value]) => value === params.get(name))) select.value = params.get(name);
        return select;
      };
      const cycle = choose('cycle', '周期', [['all', '全部周期'], ...[...index.cycles].reverse().map(c => [c.id, c.label])]);
      const season = choose('season', '赛季', [['all', '全部赛季']]);
      const event = choose('event', '赛事', [['all', '全部赛事']]);
      const kind = choose('kind', '赛事类型', [['all', '全部类型'], ['olympics', '冬奥会'], ['worlds', '世锦赛'], ['worldtour', '世巡赛'], ['worldcup', '世界杯']]);
      const gender = choose('gender', '性别', [['all', '全部性别'], ['women', '女子'], ['men', '男子'], ['mixed', '混合']]);
      const distance = choose('distance', '单项距离', [['all', '全部距离'], ...[500, 1000, 1500, 2000, 3000, 5000].map(d => [String(d), d + 'm'])]);
      const search = h('input', {type: 'search', name: 'athlete', 'aria-label': '成绩运动员', placeholder: '搜索运动员', value: params.get('athlete') || ''});
      const reset = h('button', {type: 'button', class: 'results-reset', text: '重置', onclick: () => {
        for (const el of [cycle, season, event, kind, gender, distance]) el.value = 'all';
        search.value = ''; fillSeasons(); fillEvents(); update();
      }});
      const more = h('details', {class: 'results-more'}, h('summary', {text: '单项筛选'}),
        h('div', {class: 'results-extra'}, kind, gender, distance));
      const form = h('form', {class: 'results-tools', role: 'search', 'aria-label': '成绩筛选'}, cycle, season, event, search, more, reset);
      const summary = h('p', {class: 'results-count faint', role: 'status'});
      const table = h('table', {class: 'results-table', 'aria-label': '中国队成绩列表'},
        h('caption', {class: 'sr-only', text: '中国队成绩，按赛事分组'}),
        h('thead', {}, h('tr', {}, ['单项', '运动员 / 队伍', '名次'].map(text => h('th', {scope: 'col', text})))));
      const missing = h('details', {class: 'results-coverage'});
      const name = r => r.format === 'relay' ? '中国队' : people[r.athlete_id]?.name || r.name;
      const label = r => ({women: '女子', men: '男子', mixed: '混合'})[r.gender] + ' ' + r.distance_m + 'm' + (r.format === 'relay' ? ' 接力' : '');
      const lineup = r => {
        if (!r.members?.length) return null;
        const codes = ['P', 'H', 'QF', 'SF', 'FB', 'FA'].filter(code => r.members.some(m => m.rounds.includes(code)));
        const labels = {P: '预赛', H: '预赛', QF: '1/4 决赛', SF: '半决赛', FB: 'B 决赛', FA: 'A 决赛'};
        return h('details', {class: 'result-lineup'}, h('summary', {text: '阵容'}), codes.map(code =>
          h('p', {}, h('b', {text: labels[code]}), ' · ', r.members.filter(m => m.rounds.includes(code)).map(m => people[m.athlete_id]?.name || m.name).join('、'))));
      };
      const cycleSeasons = () => cycle.value === 'all' ? index.cycles.flatMap(c => c.seasons) : index.cycles.find(c => c.id === cycle.value).seasons;
      const fillSeasons = (initial = false) => {
        const value = initial ? params.get('season') : season.value;
        const values = [...new Set(cycleSeasons())].filter(s => s <= index.events[0].season).sort().reverse();
        season.replaceChildren(h('option', {value: 'all', text: '全部赛季'}), ...values.map(s => h('option', {value: s, text: s})));
        if (values.includes(value)) season.value = value;
      };
      const matchEvent = e => cycleSeasons().includes(e.season) && (season.value === 'all' || e.season === season.value) && (kind.value === 'all' || e.kind === kind.value);
      const fillEvents = (initial = false) => {
        const value = initial ? params.get('event') : event.value;
        const options = index.events.filter(matchEvent);
        event.replaceChildren(h('option', {value: 'all', text: '全部赛事'}), ...options.map(e => h('option', {value: e.id, text: e.season + ' · ' + e.title})));
        if (options.some(e => e.id === value)) event.value = value;
      };
      const draw = () => {
        const query = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const rowMatch = r => (gender.value === 'all' || r.gender === gender.value) && (distance.value === 'all' || String(r.distance_m) === distance.value) &&
          query.every(token => [name(r), r.name, ...(people[r.athlete_id]?.aliases || []), ...(r.members || []).flatMap(m => [people[m.athlete_id]?.name || '', m.name])].join(' ').toLocaleLowerCase().includes(token));
        const events = index.events.filter(e => matchEvent(e) && (event.value === 'all' || e.id === event.value))
          .map(e => ({...e, results: e.results.filter(rowMatch)})).filter(e => e.results.length);
        summary.textContent = events.length ? events.length + ' 场 · ' + events.reduce((n, e) => n + e.results.length, 0) + ' 条成绩' : '暂无已收录成绩';
        for (const body of [...table.tBodies]) body.remove();
        table.hidden = !events.length;
        for (const e of events) {
          const page = Math.min(...e.results.map(r => r.source_page).filter(Boolean));
          const source = external(e.source.url + (Number.isFinite(page) ? '#page=' + page : ''), '成绩册');
          const body = h('tbody', {'data-event': e.id}, h('tr', {class: 'result-event'},
            h('th', {colspan: '3', scope: 'rowgroup'}, h('div', {}, h('span', {class: 'result-season num', text: e.season}),
              h('b', {text: e.title}), h('span', {class: 'faint num result-date', text: e.date_end}), source))));
          const sorted = [...e.results].sort((a, b) => ['women', 'men', 'mixed'].indexOf(a.gender) - ['women', 'men', 'mixed'].indexOf(b.gender) || a.distance_m - b.distance_m || (a.rank ?? 999) - (b.rank ?? 999));
          for (const r of sorted) {
            const finalRank = r.rank_scope === 'final';
            const rank = r.rank == null ? '—' : (finalRank ? r.final_group + '组第 ' : '第 ') + r.rank + ' 名';
            const tag = [!finalRank && r.final_group ? r.final_group + ' 决赛' : '', r.status === 'classified' ? '' : r.status].filter(Boolean).join(' · ');
            body.append(h('tr', {class: 'result-row'}, h('td', {text: label(r)}), h('td', {}, h('span', {class: 'result-name', text: name(r)}), lineup(r)),
              h('td', {class: 'result-place'}, h('b', {class: r.rank <= 3 && r.rank != null && r.status === 'classified' && (!finalRank || r.final_group === 'A') ? 'is-medal num' : 'num', text: rank}),
                tag ? h('small', {class: 'faint', text: tag}) : null)));
          }
          table.append(body);
        }
        const pending = index.pending.filter(e => matchEvent(e) && event.value === 'all');
        missing.hidden = !pending.length;
        missing.replaceChildren(h('summary', {text: '待收录 ' + pending.length + ' 场'}), h('ul', {}, pending.map(e => h('li', {text: e.season + ' · ' + e.title}))));
      };
      const update = () => {
        const url = new URL(location.href); url.pathname = '/results/'; url.searchParams.delete('view');
        for (const el of [cycle, season, event, kind, gender, distance, search]) {
          if (el.value && el.value !== 'all') url.searchParams.set(el.name, el.value); else url.searchParams.delete(el.name);
        }
        window.history.replaceState(null, '', url); draw();
      };
      form.addEventListener('submit', e => {e.preventDefault(); update();});
      form.addEventListener('change', e => {
        if (e.target === cycle) fillSeasons();
        if ([cycle, season, kind].includes(e.target)) fillEvents();
        update();
      });
      search.addEventListener('input', update);
      panel.replaceChildren(form, summary, table, missing);
      fillSeasons(true); fillEvents(true); draw();
    } catch (_) {
      panel.replaceChildren(h('p', {class: 'faint'}, '成绩暂时无法加载。', h('button', {class: 'btn', type: 'button', onclick: () => results(ctx)}, '重试')));
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
