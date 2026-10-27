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
  async function eventResults(ctx, calendar, route = {}) {
    const {h, root, fetchData, external} = ctx;
    const panel = h('section', {class: 'results-browser', 'aria-label': '中国队成绩'},
      h('p', {class: 'faint', role: 'status', text: '正在读取成绩…'}));
    root.replaceChildren(pageNav(h, 'event'), h('div', {class: 'results-heading'}, h('h1', {text: '赛事成绩'}), h('span', {class: 'faint tiny', text: '中国队'})), panel);
    try {
      const index = await fetchData('results.json');
      const params = new URLSearchParams(location.search);
      if (route.id) {
        if (!index.events.some(e => e.id === route.id)) {panel.replaceChildren(h('p',{text:'该赛事成绩尚未收录'}));return;}
        params.set('event', route.id);
      }
      const people = Object.fromEntries(index.athletes.map(p => [p.id, p]));
      const choose = (name, label, values) => {
        const select = h('select', {name, 'aria-label': label}, values.map(([value, text]) => h('option', {value, text})));
        if (values.some(([value]) => value === params.get(name))) select.value = params.get(name);
        return select;
      };
      const cycle = choose('cycle', '周期', [['all', '全部周期'], ...[...index.cycles].reverse().map(c => [c.id, c.label])]);
      const season = choose('season', '赛季', [['all', '全部赛季']]);
      const event = choose('event', '赛事', [['all', '全部赛事']]);
      const kind = choose('kind', '赛事类型', [['all', '全部类型'], ['olympics', '冬奥会'], ['worlds', '世锦赛'], ['worldtour', '世巡赛'], ['worldcup', '世界杯'], ['fourcontinents', '四大洲']]);
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
      const label = r => ({women: '女子', men: '男子', mixed: '混合'})[r.gender] + ' ' + r.distance_m + 'm' + (r.format === 'relay' ? ' 接力' : r.medal_eligible === false ? ' 超级决赛' : '') + (r.race_number ? ' (' + r.race_number + ')' : '');
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
        root.querySelector('.results-breadcrumb')?.remove();
        const selected=index.events.find(e=>e.id===event.value);
        if(selected){
          const parent=index.cycles.find(c=>c.seasons.includes(selected.season));
          const items=[['成绩','/results/'],...(parent?[[parent.label,'/results/cycles/'+parent.id+'/']]:[]),[selected.season,'/results/seasons/'+seasonId(selected.season)+'/'],[selected.title,null]];
          root.insertBefore(breadcrumbs(h,items),root.querySelector('.results-heading'));
        }
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
          const source = external(e.source.url + (Number.isFinite(page) ? '#page=' + page : ''), e.source.kind==='isu_api'?'官方成绩':'成绩册');
          const body = h('tbody', {'data-event': e.id}, h('tr', {class: 'result-event'},
            h('th', {colspan: '3', scope: 'rowgroup'}, h('div', {}, h('span', {class: 'result-season num', text: e.season}),
              h('b', {text: e.title}), h('span', {class: 'faint num result-date', text: e.date_end}), source))));
          const sorted = [...e.results].sort((a, b) => ['women', 'men', 'mixed'].indexOf(a.gender) - ['women', 'men', 'mixed'].indexOf(b.gender) || a.distance_m - b.distance_m || (a.race_number || 1) - (b.race_number || 1) || (a.rank ?? 999) - (b.rank ?? 999));
          for (const r of sorted) {
            const finalRank = r.rank_scope === 'final';
            const rank = r.rank == null ? '—' : (finalRank ? r.final_group + '组第 ' : '第 ') + r.rank + ' 名';
            const tag = [!finalRank && r.final_group ? r.final_group + ' 决赛' : '', r.status === 'classified' ? '' : r.status].filter(Boolean).join(' · ');
            body.append(h('tr', {class: 'result-row'}, h('td', {text: label(r)}), h('td', {}, h('span', {class: 'result-name', text: name(r)}), lineup(r)),
              h('td', {class: 'result-place'}, h('b', {class: medalResult(r) ? 'is-medal num' : 'num', text: rank}),
                tag ? h('small', {class: 'faint', text: tag}) : null)));
          }
          table.append(body);
        }
        const pending = index.pending.filter(e => matchEvent(e) && event.value === 'all');
        missing.hidden = !pending.length;
        missing.replaceChildren(h('summary', {text: '待收录 ' + pending.length + ' 场'}), h('ul', {}, pending.map(e => h('li', {text: e.season + ' · ' + e.title}))));
      };
      const update = () => {
        const url = new URL(location.href); url.pathname = '/results/events/'; url.searchParams.delete('view');
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
      fillSeasons(true); fillEvents(true);
      draw();
    } catch (_) {
      panel.replaceChildren(h('p', {class: 'faint'}, '成绩暂时无法加载。', h('button', {class: 'btn', type: 'button', onclick: () => results(ctx, calendar, route)}, '重试')));
    }
  }
  function pageNav(h, active) {
    const pages = [['index', '总览', '/results/'], ['event', '赛事成绩', '/results/events/'],
      ['archive', '成绩档案', '/results/cycles/'], ['compare', '对比', '/results/compare/']];
    return h('nav', {class: 'review-nav', 'aria-label': '成绩栏目'}, pages.map(([id, text, href]) =>
      h('a', {text, href, 'aria-current': id === (['season','cycle'].includes(active)?'archive':active) ? 'page' : null})));
  }
  const projectKeys = [['women',500], ['women',1000], ['women',1500], ['women',3000],
    ['men',500], ['men',1000], ['men',1500], ['men',5000], ['mixed',2000]];
  const matchesProject = (r,key) => r.gender===key[0] && r.distance_m===key[1] && r.format===(key[1]>=2000?'relay':'individual');
  const projectLabel = ([gender, distance]) => ({women:'女子',men:'男子',mixed:'混合'})[gender] + ' ' + distance + ' 米' + (distance >= 2000 ? '接力' : '');
  const medalResult = r => r.medal_eligible !== false && r.medal_verified !== false && r.status === 'classified' && r.rank != null && r.rank >= 1 && r.rank <= 3 && (r.rank_scope !== 'final' || r.final_group === 'A');
  const resultPlace = r => (r.rank == null ? '—' : (r.rank_scope === 'final' ? r.final_group + '组第 ' : '第 ') + r.rank + ' 名') + (r.status === 'classified' ? '' : ' · ' + r.status);
  const seasonId = value => value.replace('/', '-');
  const seasonValue = value => value.replace(/^(\d{4})-(\d{2})$/, '$1/$2');
  const eventLink = (e, query = '') => '/results/events/' + encodeURIComponent(e.id) + '/' + query;
  function reviewSelect(h, name, label, values, value) {
    const select = h('select', {name, 'aria-label': label}, values.map(([value,text]) => h('option', {value,text})));
    if (values.some(([id]) => id === value)) select.value = value;
    return select;
  }
  const normalizeKind = kind => ['worldcup','worldtour'].includes(kind)?'circuit':kind;
  const kindMatches = (value,kind) => kind==='all' || value===kind || kind==='circuit'&&['worldcup','worldtour'].includes(value);
  function scopeEvents(index, mode, id, kind = 'all') {
    const seasons = mode === 'cycle' ? index.cycles.find(c => c.id === id)?.seasons || [] : [id];
    return index.events.filter(e => seasons.includes(e.season) && kindMatches(e.kind,kind));
  }
  function scopeCoverage(index,mode,id,kind,events) {
    const seasons=mode==='cycle'?index.cycles.find(c=>c.id===id)?.seasons||[]:[id];
    const scopes=(index.inventory||[]).filter(s=>seasons.includes(s.season)&&kindMatches(s.kind,kind));
    const expected=new Set(scopes.flatMap(s=>s.official_event_ids));
    const partial=events.some(e=>e.coverage!=='complete');
    return {expected:expected.size,available:events.length,partial};
  }
  function coverage(h, events, scope) {
    const ratio=scope?.expected?events.length+' / '+scope.expected+' 场':events.length+' 场';
    const tail=scope?.expected&&!scope.partial&&events.length===scope.expected?'': ' · 未齐';
    return h('span', {class: 'coverage-note'}, h('span', {class:'coverage-long',text:events.length ? '已收录 '+ratio+tail : '未收录'}), h('span', {class:'coverage-short',text:events.length ? ratio+tail : '未收录'}));
  }
  function eventRows(h, events, people, key) {
    const rows = events.flatMap(e => e.results.filter(r => !key || matchesProject(r,key)).map(r => ({e,r})));
    if (!rows.length) return h('p', {class:'faint',text:'未收录'});
    return h('ul', {class:'review-records'}, rows.map(({e,r}) => h('li', {},
      h('a', {href:eventLink(e, '?gender=' + r.gender + '&distance=' + r.distance_m)},
        h('span', {class:'review-record-event',text:e.title}),
        h('span', {text:r.format === 'relay' ? '中国队' : people[r.athlete_id]?.name || r.name}),
        h('b', {class:medalResult(r) ? 'num is-medal' : 'num',text:resultPlace(r) + (r.final_group && r.rank_scope !== 'final' ? ' · ' + r.final_group + ' 决赛' : '')})))));
  }
  function summaryTable(h, sets, names, people, metric = 'best', periods = null, selectors = [], scopes = []) {
    const table = h('table', {class:'compare-table','aria-label':'项目成绩对照','data-columns':names.length}, h('thead', {}, h('tr', {},
      h('th', {scope:'col',text:'项目'}), names.map((text,i) => h('th', {scope:'col'},selectors[i] ? h('div',{class:'compare-object'},selectors[i]) : h('span',{text}),coverage(h,sets[i],scopes[i]))))));
    const body = h('tbody');
    let group = '';
    projectKeys.forEach((key, i) => {
      if (group !== key[0]) {
        group = key[0];
        body.append(h('tr', {class:'compare-group'}, h('th', {colspan:names.length + 1,scope:'rowgroup',text:({women:'女子',men:'男子',mixed:'混合接力'})[group]})));
      }
      const detail = h('tr', {class:'compare-detail',hidden:true,id:'project-detail-' + i});
      const button = h('button', {type:'button',class:'project-toggle','aria-expanded':'false','aria-controls':detail.id,
        onclick:() => {detail.hidden = !detail.hidden; button.setAttribute('aria-expanded',String(!detail.hidden));}},
        h('span', {class:'project-chevron','aria-hidden':'true',text:'›'}), key[1] + ' 米' + (key[1] >= 2000 ? '接力' : ''));
      body.append(h('tr', {class:'compare-project'}, h('th', {scope:'row'},button), sets.map(events => {
        const rows = events.flatMap(e => e.results.filter(r => matchesProject(r,key)));
        if (!rows.length) {
          const notOffered=events.length&&events.every(e=>e.programme&&!e.programme.some(d=>matchesProject(d,key)));
          const noChina=events.length&&events.every(e=>e.coverage==='complete'&&e.programme?.some(d=>matchesProject(d,key)));
          return h('td', {},h('span',{class:'faint',text:notOffered?'未设项':noChina?'无中国队记录':'未收录'}));
        }
        const best = rows.filter(r => r.rank != null && (r.rank_scope !== 'final' || r.final_group==='A')).sort((a,b) => Number(a.status!=='classified')-Number(b.status!=='classified') || a.rank - b.rank)[0];
        const stats = statistics([{results:rows}]);
        const cell = h('td', {class:'compare-value'});
        if (metric === 'medals') {
          cell.append(h('b',{class:'num',text:[1,2,3].map((rank,i) => rows.filter(r=>medalResult(r)&&r.rank===rank).length + [' 金',' 银',' 铜'][i]).join(' · ')}));
        } else if (metric === 'finals') {
          cell.append(h('b',{class:'num',text:stats.a_finals + ' 人／队次'}));
        } else if (metric === 'rate') {
          cell.append(h('b',{class:'num',text:stats.starts?Math.round(stats.a_finals/stats.starts*100)+'%':'—'}),h('span',{class:'compare-person',text:stats.a_finals+' / '+stats.starts}));
        } else if (metric === 'top8') {
          cell.append(h('b',{class:'num',text:stats.top8+' 人／队次'}));
        } else if (best) {
          cell.append(h('b',{class:medalResult(best)?'num is-medal':'num',text:resultPlace(best)}),
            h('span',{class:'compare-person',text:best.format === 'relay' ? '中国队' : people[best.athlete_id]?.name || best.name}));
        } else {
          cell.append(h('b',{text:rows.some(r=>r.rank!=null)?'仅组内成绩':'名次待核'}));
        }
        cell.append(h('small',{class:'faint',text:rows.length + ' 条成绩'}));
        return cell;
      })));
      const detailGroups = periods ? [0,1,2,3].map(offset => h('section', {class:'compare-period'},
        h('h3', {text:'第 ' + (offset + 1) + ' 赛季'}),
        h('div', {class:'compare-detail-grid',style:{gridTemplateColumns:'repeat(' + names.length + ', minmax(0, 1fr))'}}, sets.map((events,j) =>
          h('section', {},h('h4',{text:periods[j]?.[offset] || names[j]}),eventRows(h,events.filter(e=>e.season===periods[j]?.[offset]),people,key)))))) :
        h('div', {class:'compare-detail-grid',style:{gridTemplateColumns:'repeat(' + names.length + ', minmax(0, 1fr))'}}, sets.map((events,j) =>
          h('section', {'aria-label':names[j] + ' ' + projectLabel(key)},h('h3',{text:names[j]}),eventRows(h,events,people,key))));
      detail.append(h('td', {colspan:names.length + 1},detailGroups));
      body.append(detail);
    });
    table.append(body);
    return h('div', {class:'compare-scroll',tabindex:'0','aria-label':'可横向滚动的成绩对照表'},table);
  }
  async function results(ctx, calendar, route = {}) {
    ctx.root.classList.add('results-page');
    if (route.view === 'event' || !route.view && new URLSearchParams(location.search).has('event')) return eventResults(ctx,calendar,route);
    const {h,root,fetchData} = ctx;
    const active = route.view || 'index';
    const panel = h('section',{class:'review-content'},h('p',{class:'faint',role:'status',text:'正在读取成绩…'}));
    root.replaceChildren(pageNav(h,active),panel);
    try {
      const index = await fetchData('results.json');
      if (active === 'index') resultsIndex(ctx,index,panel);
      else if (active === 'compare') comparison(ctx,index,panel);
      else if (route.id) review(ctx,index,panel,active,route.id);
      else reviewIndex(ctx,index,panel,active);
    } catch (_) {
      panel.replaceChildren(h('p',{class:'faint',text:'成绩暂时无法加载。'}),h('button',{class:'btn',type:'button',onclick:()=>results(ctx,calendar,route),text:'重试'}));
    }
  }
  function resultsIndex(ctx,index,panel) {
    const {h} = ctx;
    panel.replaceChildren(h('div',{class:'results-heading'},h('h1',{text:'成绩'}),h('span',{class:'country-label',text:'CHN'})),
      h('section',{class:'results-latest'},h('div',{class:'portal-section-head'},h('h2',{text:'最近赛果'}),h('a',{class:'text-link',href:'/results/events/',text:'全部赛事 →'})),
        h('ul',{class:'results-index-list results-recent-list'},index.events.slice(0,3).map(e=>h('li',{},h('a',{href:eventLink(e)},h('time',{datetime:e.date_end},h('b',{class:'num',text:e.date_end.slice(5).replace('-','.')}),h('small',{text:e.date_end.slice(0,4)})),h('span',{class:'recent-event-title'},h('b',{text:e.title}),h('small',{class:'faint',text:e.season})),h('span',{'aria-hidden':'true',text:'↗'})))))),
      h('section',{class:'results-archive-index'},h('div',{class:'portal-section-head'},h('h2',{text:'奥运周期'})),cycleTree(h,index)),
      h('a',{class:'results-compare-entry',href:'/results/compare/'},h('b',{text:'成绩对比'}),h('span',{class:'faint',text:'赛季 / 奥运周期'}),h('span',{'aria-hidden':'true',text:'→'})));
  }
  function cycleTree(h,index) {
    const current=index.events[0]?.season;
    const filled=[...index.cycles].reverse().filter(c=>scopeEvents(index,'cycle',c.id).length);
    const open=new Set(filled.slice(0,2).map(c=>c.id));
    return h('div',{class:'cycle-tree'},[...index.cycles].reverse().map(c=> {
      const events=scopeEvents(index,'cycle',c.id);
      return h('details',{class:'cycle-branch',open:open.has(c.id),'data-cycle':c.id},
        h('summary',{},h('strong',{text:c.label}),h('small',{class:'faint',text:c.seasons[0]+'—'+c.seasons.at(-1)}),h('span',{class:'faint',text:events.length?events.length+' 场':'未收录'})),
        h('div',{class:'cycle-seasons'},
          h('a',{class:'cycle-overview',href:'/results/cycles/'+c.id+'/',text:'周期总览 →'}),
          h('ul',{},c.seasons.filter(s=>s<=current).map(s=>h('li',{},h('a',{href:'/results/seasons/'+seasonId(s)+'/'},h('b',{text:s}),coverage(h,scopeEvents(index,'season',s),scopeCoverage(index,'season',s,'all',scopeEvents(index,'season',s)))))))));
    }));
  }
  function breadcrumbs(h,items) {
    return h('nav',{class:'results-breadcrumb','aria-label':'成绩层级'},items.map(([text,href],i)=>[
      i?h('span',{'aria-hidden':'true',text:'›'}):null,href?h('a',{href,text}):h('span',{'aria-current':'page',text})]));
  }
  function reviewIndex(ctx,index,panel) {
    const {h}=ctx;
    panel.replaceChildren(h('div',{class:'results-heading'},h('h1',{text:'成绩档案'})),cycleTree(h,index));
  }
  function statistics(events) {
    const rows=events.flatMap(e=>e.results).filter(r=>r.medal_eligible!==false);
    const starts=rows.filter(r=>r.status!=='DNS'&&r.started!==false);
    return {events:events.length,entries:rows.length,starts:starts.length,
      medals:[1,2,3].map(rank=>rows.filter(r=>medalResult(r)&&r.rank===rank).length),
      a_finals:starts.filter(r=>r.final_group==='A').length,
      top8:rows.filter(r=>r.status==='classified'&&r.rank>=1&&r.rank<=8&&(r.rank_scope!=='final'||r.final_group==='A')).length};
  }
  function statsRibbon(h,events) {
    const s=statistics(events);
    return h('dl',{class:'stats-ribbon','aria-label':'当前范围统计'},[['赛事',s.events],['金',s.medals[0]],['银',s.medals[1]],['铜',s.medals[2]],['A 决赛',s.a_finals],['前 8 名',s.top8]].map(([text,value])=>
      h('div',{},h('dt',{text}),h('dd',{class:'num',text:events.length?value:'—'}))));
  }
  function statsTable(h,title,groups,cycle) {
    const table=h('table',{class:'review-stats-table','aria-label':title},h('thead',{},h('tr',{},[cycle?'赛季':'赛事',...(cycle?['场']:[]),'金','银','铜','A 决赛','前 8'].map(text=>h('th',{scope:'col',text})))));
    table.append(h('tbody',{},groups.map(({text,href,events})=>{
      const s=statistics(events);
      return h('tr',{},h('th',{scope:'row'},h('a',{href,text})),[...(cycle?[s.events]:[]),...s.medals,s.a_finals,s.top8].map(value=>h('td',{class:'num',text:events.length?value:'—'})));
    })));
    return h('section',{class:'review-breakdown'},h('div',{class:'portal-section-head'},h('h2',{text:title})),h('div',{class:'stats-scroll'},table));
  }
  function contributions(h,events,people) {
    const athletes=new Map();
    const person=(id,name)=>{
      if(!athletes.has(id))athletes.set(id,{id,name:people[id]?.name||name,starts:0,relay:0,medals:[0,0,0],finals:0,best:null});
      return athletes.get(id);
    };
    for(const event of events)for(const r of event.results){
      if(r.medal_eligible===false)continue;
      if(r.format==='relay'){
        for(const m of r.members||[])if(m.rounds?.length)person(m.athlete_id,m.name).relay++;
      }else{
        const p=person(r.athlete_id,r.name);
        if(r.status!=='DNS'&&r.started!==false)p.starts++;
        if(medalResult(r))p.medals[r.rank-1]++;
        if(r.final_group==='A'&&r.status!=='DNS'&&r.started!==false)p.finals++;
        if(r.rank_scope!=='final'&&r.rank&&r.status==='classified'&&(p.best===null||r.rank<p.best))p.best=r.rank;
      }
    }
    const rows=[...athletes.values()].sort((a,b)=>b.medals[0]-a.medals[0]||b.medals[1]-a.medals[1]||b.medals[2]-a.medals[2]||b.finals-a.finals||a.name.localeCompare(b.name));
    if(!rows.length)return null;
    const table=h('table',{class:'review-stats-table contribution-table','aria-label':'运动员成绩统计'},h('thead',{},h('tr',{},['运动员','单项出赛','金','银','铜','A 决赛','接力项次'].map(text=>h('th',{scope:'col',text})))),
      h('tbody',{},rows.map(p=>h('tr',{},h('th',{scope:'row',text:p.name}),[p.starts,...p.medals,p.finals,p.relay].map(text=>h('td',{class:'num',text}))))));
    return h('details',{class:'athlete-contributions'},h('summary',{text:'运动员 · '+rows.length+' 人'}),h('div',{class:'stats-scroll'},table));
  }
  function review(ctx,index,panel,mode,pathId) {
    const {h} = ctx, id = mode === 'season' ? seasonValue(pathId) : pathId;
    const cycle = index.cycles.find(c=>c.id===id);
    const parentCycle = mode==='season'?index.cycles.find(c=>c.seasons.includes(id)):null;
    if (mode === 'cycle' && !cycle || mode === 'season' && !index.cycles.some(c=>c.seasons.includes(id))) {
      panel.replaceChildren(h('h1',{text:'未找到回顾'}),h('a',{href:'/results/',text:'返回成绩'})); return;
    }
    const title = cycle?.label || id;
    const people = Object.fromEntries(index.athletes.map(p=>[p.id,p]));
    const kind = reviewSelect(h,'kind','赛事范围',[['worlds','世锦赛'],['circuit','世界杯 / 世巡赛'],['fourcontinents','四大洲'],['olympics','冬奥会']],normalizeKind(new URLSearchParams(location.search).get('kind') || (scopeEvents(index,mode,id).some(e=>e.kind==='worlds')?'worlds':scopeEvents(index,mode,id)[0]?.kind || 'worlds')));
    const body=h('div');
    const compareLink=h('a',{class:'text-link review-to-compare',text:'加入对比 →'});
    const draw=()=>{
      compareLink.href='/results/compare/?mode='+mode+'&left='+encodeURIComponent(id)+'&kind='+kind.value;
      const events=scopeEvents(index,mode,id,kind.value);
      const groups=cycle?cycle.seasons.filter(s=>s<=index.events[0].season).map(season=>({text:season,href:'/results/seasons/'+seasonId(season)+'/?kind='+kind.value,events:scopeEvents(index,'season',season,kind.value)})):
        events.map(e=>({text:e.title,href:eventLink(e),events:[e]}));
      const seasons=cycle?cycle.seasons:[id];
      const pending=index.pending.filter(e=>seasons.includes(e.season)&&kindMatches(e.kind,kind.value));
      body.replaceChildren(...[coverage(h,events,scopeCoverage(index,mode,id,kind.value,events)),statsRibbon(h,events),
        statsTable(h,cycle?'赛季成绩':'各站成绩',groups,!!cycle),
        h('div',{class:'portal-section-head'},h('h2',{text:'项目成绩'})),summaryTable(h,[events],[title],people,'best',cycle?[cycle.seasons]:null,[],[scopeCoverage(index,mode,id,kind.value,events)]),
        contributions(h,events,people),pending.length?h('details',{class:'results-coverage'},h('summary',{text:'待核验 '+pending.length+' 场'}),h('ul',{},pending.map(e=>h('li',{},ctx.external(e.source_url,e.title))))):null,h('p',{class:'stat-definition faint tiny',text:'接力按队计成绩；运动员奖牌列仅统计个人项目'})].filter(Boolean));
    };
    kind.addEventListener('change',()=>{const url=new URL(location.href);url.searchParams.set('kind',kind.value);window.history.replaceState(null,'',url);draw();});
    panel.replaceChildren(breadcrumbs(h,[['成绩','/results/'],['成绩档案','/results/cycles/'],...(parentCycle?[[parentCycle.label,'/results/cycles/'+parentCycle.id+'/']]:[]),[title,null]]),h('div',{class:'results-heading'},h('h1',{text:title}),h('span',{class:'country-label',text:'CHN'}),
      compareLink),
      h('div',{class:'review-tools'},h('label',{},h('span',{text:'赛事范围'}),kind)),body);draw();
  }
  function comparison(ctx,index,panel) {
    const {h} = ctx, params=new URLSearchParams(location.search);
    const people=Object.fromEntries(index.athletes.map(p=>[p.id,p]));
    const seasons=[...new Set(index.cycles.flatMap(c=>c.seasons))].filter(s=>s<=index.events[0].season).sort().reverse();
    const mode=reviewSelect(h,'mode','对比类型',[['season','赛季'],['cycle','奥运周期']],params.get('mode'));
    const options=()=>mode.value==='season'?seasons.map(s=>[s,s]):[...index.cycles].reverse().map(c=>[c.id,c.label]);
    const values=options();
    const left=reviewSelect(h,'left','对比对象一',values,params.get('left') || (mode.value==='season'?'2024/25':'beijing-2022'));
    const right=reviewSelect(h,'right','对比对象二',values,params.get('right') || (mode.value==='season'?(left.value==='2025/26'?'2024/25':'2025/26'):(left.value==='milano-2026'?'beijing-2022':'milano-2026')));
    const third=reviewSelect(h,'third','对比对象三',[['','不添加'],...values],params.get('third'));
    const kind=reviewSelect(h,'kind','赛事范围',[['worlds','世锦赛'],['olympics','冬奥会'],['circuit','世界杯 / 世巡赛'],['fourcontinents','四大洲']],normalizeKind(params.get('kind')));
    const metric=reviewSelect(h,'metric','对比指标',[['best','最佳名次'],['medals','奖牌'],['finals','A 组决赛人／队次'],['rate','A 决赛率'],['top8','前 8 名人／队次']],params.get('metric'));
    const field=(text,control)=>h('label',{class:'field-'+control.name},h('span',{text}),control);
    const thirdField=field('对象三',third);
    const more=h('details',{class:'compare-more'},h('summary',{'aria-label':'第三个对比对象'},h('span',{class:'compare-more-icon',text:'＋'}),h('span',{class:'compare-more-label',text:'第三项'})),h('div',{class:'compare-more-panel'},thirdField));
    const form=h('form',{class:'review-tools compare-tools',role:'search','aria-label':'成绩对比条件'},field('对比',mode),field('赛事',kind),field('指标',metric),more);
    const body=h('div',{class:'comparison-body'});
    const draw=()=>{
      more.querySelector('.compare-more-icon').textContent=third.value?'−':'＋';
      more.querySelector('summary').setAttribute('aria-label',third.value?'移除第三个对比对象':'添加第三个对比对象');
      if(!third.value) thirdField.append(third);
      const ids=[left.value,right.value,...(third.value?[third.value]:[])];
      const sets=ids.map(id=>scopeEvents(index,mode.value,id,kind.value));
      const names=ids.map(id=>options().find(([value])=>value===id)?.[1] || id);
      const table=summaryTable(h,sets,names,people,metric.value,mode.value==='cycle'?ids.map(id=>index.cycles.find(c=>c.id===id)?.seasons):null,[left,right,...(third.value?[third]:[])],ids.map((id,i)=>scopeCoverage(index,mode.value,id,kind.value,sets[i])));
      if(new Set(ids).size!==ids.length){table.querySelector('tbody').replaceChildren();body.replaceChildren(h('p',{class:'review-notice',role:'status',text:'请选择不同的对比对象'}),table);return;}
      body.replaceChildren(table,
        h('details',{class:'results-coverage'},h('summary',{text:'收录范围'}),sets.map((events,i)=>h('p',{},h('b',{text:names[i]+' · '}),events.length?events.map(e=>e.title).join('、'):'未收录'))));
    };
    const update=()=>{
      const url=new URL(location.href);for(const el of [mode,left,right,third,kind,metric]){if(el.value)url.searchParams.set(el.name,el.value);else url.searchParams.delete(el.name);}window.history.replaceState(null,'',url);draw();
    };
    more.querySelector('summary').addEventListener('click',e=>{if(third.value){e.preventDefault();third.value='';more.open=false;update();}});
    form.addEventListener('submit',e=>e.preventDefault());
    panel.addEventListener('change',e=>{
      if(e.target===third) more.open=false;
      if(e.target===mode){
        const items=options();
        [left,right,third].forEach((select,i)=>{select.replaceChildren(...(i===2?[h('option',{value:'',text:'不添加'})]:[]),...items.map(([value,text])=>h('option',{value,text})));});
        left.value=mode.value==='season'?'2024/25':'beijing-2022';right.value=mode.value==='season'?'2025/26':'milano-2026';third.value='';
      }
      update();
    });
    panel.replaceChildren(h('div',{class:'results-heading'},h('h1',{text:'成绩对比'}),h('span',{class:'country-label',text:'CHN'})),form,body);draw();
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
  site.portal = {home, results, athletes, statistics};
})();
