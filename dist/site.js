/* Shared DOM, filter and table primitives; no business data. */
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const site = window.SSTS = window.SSTS || {};
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
  function select(h,name,label,values,value) {
    const el = h('select',{name,'aria-label':label},values.map(([value,text]) => h('option',{value,text})));
    if (values.some(([id]) => id === value)) el.value = value;
    return el;
  }
  function writeFilters(controls,path) {
    const url = new URL(location.href);
    if (path) url.pathname = path;
    url.searchParams.delete('view');
    for (const el of controls) {
      if (el.value && el.value !== 'all') url.searchParams.set(el.name,el.value);
      else url.searchParams.delete(el.name);
    }
    window.history.replaceState(null,'',url);
  }
  const tableScroll = (h,table,label,cls='stats-scroll') => h('div',{class:cls,tabindex:'0','aria-label':label},table);
  site.ui = {h,s,append,fill,select,writeFilters,tableScroll};
})();
;
/* Shared page addresses and global navigation. Event query links remain valid. */
(function () {
  'use strict';
  const site = window.SSTS = window.SSTS || {};
  const sections = [
    {id: 'home', label: '首页', href: '/', icon: 'home'},
    {id: 'events', label: '赛事', href: '/events/', icon: 'calendar'},
    {id: 'results', label: '成绩', href: '/results/', icon: 'history'},
    {id: 'athletes', label: '运动员', href: '/athletes/', icon: 'people'},
  ];
  function resolve(input) {
    const url = new URL(input.href || input, location.origin);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' && url.searchParams.has('station')) {
      return {page: 'event', section: 'events', event: url.searchParams.get('station'), legacy: true};
    }
    if(path==='/'&&url.searchParams.get('view')==='history')return {page:'results',section:'results',view:'event',legacy:true};
    if (path === '/') return {page: 'home', section: 'home'};
    if (path === '/history' || (path === '/results' && ['view', 'cycle', 'season', 'event', 'kind', 'gender', 'distance', 'athlete'].some(key => url.searchParams.has(key)))) return {page: 'results', section: 'results', view: 'event'};
    const results = path.match(/^\/results\/(events|seasons|cycles)(?:\/([a-z0-9-]+))?$/);
    if (results) return {page: 'results', section: 'results', view: {events: 'event', seasons: 'season', cycles: 'cycle'}[results[1]], id: results[2]};
    if (path === '/results/compare') return {page: 'results', section: 'results', view: 'compare'};
    const section = sections.find(s => s.href.replace(/\/$/, '') === path);
    if (section) return {page: section.id, section: section.id};
    const event = path.match(/^\/events\/(\d{4}-\d{2})\/([a-z0-9-]+)$/);
    if (event) return {page: 'event', section: 'events', season: event[1], event: event[2]};
    return {page: 'not-found', section: null};
  }
  function eventHref(id, season) {
    return '/events/' + encodeURIComponent(season.replace('/', '-')) + '/' + encodeURIComponent(id) + '/';
  }
  function render(h, icon, route) {
    const nav = document.getElementById('site-nav');
    nav.replaceChildren(...sections.map(s => h('a', {
      href: s.href, class: 'site-nav-item', 'aria-current': route.section === s.id ? 'page' : null,
    }, icon(s.icon), h('span', {text: s.label}))));
  }
  site.navigation = {sections, resolve, eventHref, render};
})();
;
/* Pure result contracts. Used by the build and browser; no DOM, fetch or clock. */
(function (host) {
  'use strict';
  const site = host.SSTS = host.SSTS || {};
  const projectKeys = [['women',500], ['women',1000], ['women',1500], ['women',3000],
    ['men',500], ['men',1000], ['men',1500], ['men',5000], ['mixed',2000]];
  const included = r => r.format === 'individual' ? [500,1000,1500].includes(r.distance_m) : r.format === 'relay' && [2000,3000,5000].includes(r.distance_m);
  const matchesProject = (r,key) => r.gender === key[0] && r.distance_m === key[1] && r.format === (key[1] >= 2000 ? 'relay' : 'individual');
  const projectId = key => key.join('-');
  const medalResult = r => r.medal_eligible !== false && r.medal_verified !== false && r.status === 'classified' && r.rank >= 1 && r.rank <= 3 && (r.rank_scope !== 'final' || r.final_group === 'A');
  const kindMatches = (value,kind) => kind === 'all' || value === kind || kind === 'circuit' && ['worldcup','worldtour'].includes(value);
  const normalizeKind = kind => ['worldcup','worldtour'].includes(kind) ? 'circuit' : kind;
  // Search projections and detail rows use this single predicate; no event-wide name bag.
  const normalizeSearch = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  function resultSearchRow(row,people) {
    const person = id => people?.get ? people.get(id) : people?.[id];
    const subjects = row.format === 'relay' ? [{name:row.name,aliases:['中国队']},...(row.members || [])] : [row];
    const names = subjects.map(subject => {
      const registered = person(subject.athlete_id);
      return [...new Set([subject.name,registered?.name,...(registered?.aliases || []),...(subject.aliases || [])].map(normalizeSearch).filter(Boolean))].join(' ');
    }).filter(Boolean);
    return {gender:row.gender,distance_m:row.distance_m,names:[...new Set(names)]};
  }
  function resultSearchRows(rows,people) {
    return [...new Map(rows.map(row => {const projection=resultSearchRow(row,people);return [JSON.stringify(projection),projection];})).values()];
  }
  function resultFilter({athlete='',gender='all',distance='all'} = {}) {
    return {tokens:normalizeSearch(athlete).split(' ').filter(Boolean),gender,distance:String(distance)};
  }
  const hasResultFilter = filter => filter.tokens.length > 0 || filter.gender !== 'all' || filter.distance !== 'all';
  const matchesResultSearch = (row,filter) => (filter.gender === 'all' || row.gender === filter.gender) &&
    (filter.distance === 'all' || String(row.distance_m) === filter.distance) &&
    (!filter.tokens.length || row.names.some(name => filter.tokens.every(token => name.includes(token))));
  const eventMatchesResults = (event,filter) => !hasResultFilter(filter) || event.search_rows.some(row => matchesResultSearch(row,filter));
  const empty = () => ({events:0, entries:0, starts:0, medals:[0,0,0], a_finals:0, top8:0});
  function rowStatistics(rows) {
    rows = rows.filter(r => included(r) && r.medal_eligible !== false);
    const starts = rows.filter(r => r.status !== 'DNS' && r.started !== false);
    return {events:0, entries:rows.length, starts:starts.length,
      medals:[1,2,3].map(rank => rows.filter(r => medalResult(r) && r.rank === rank).length),
      a_finals:starts.filter(r => r.final_group === 'A').length,
      top8:rows.filter(r => r.status === 'classified' && r.rank >= 1 && r.rank <= 8 && (r.rank_scope !== 'final' || r.final_group === 'A')).length};
  }
  function sumStats(values) {
    const total = empty();
    for (const s of values) {
      for (const key of ['events','entries','starts','a_finals','top8']) total[key] += s[key] || 0;
      s.medals.forEach((n,i) => total.medals[i] += n);
    }
    return total;
  }
  function statistics(events) {
    const stats = sumStats(events.map(e => e.summary?.totals || rowStatistics(e.results || [])));
    stats.events = events.length;
    return stats;
  }
  function bestResult(rows) {
    // Rank scopes are incomparable: prefer published overall classifications whenever available.
    const official = rows.filter(r => r.rank != null && r.rank_scope !== 'final' && !r.classification_missing);
    const group = rows.filter(r => r.rank != null && r.rank_scope === 'final' && ['A','B'].includes(r.final_group));
    const byRank = (a,b) => Number(a.status !== 'classified') - Number(b.status !== 'classified') || a.rank - b.rank;
    // If no overall result exists, show the supported A/B final place explicitly as a group place.
    return official.sort(byRank)[0] || group.sort((a,b) => Number(a.status !== 'classified') - Number(b.status !== 'classified') ||
      Number(a.final_group === 'B') - Number(b.final_group === 'B') || a.rank - b.rank)[0] || null;
  }
  function athleteStatistics(events) {
    const people = new Map();
    const person = (id,name) => {
      if (!people.has(id)) people.set(id,{id,name,starts:0,relay:0,medals:[0,0,0],finals:0,best:null});
      return people.get(id);
    };
    for (const event of events) {
      if (event.summary) {
        for (const p of event.summary.athletes) {
          const total = person(p.id,p.name);
          for (const key of ['starts','relay','finals']) total[key] += p[key];
          p.medals.forEach((n,i) => total.medals[i] += n);
          if (p.best != null && (total.best == null || p.best < total.best)) total.best = p.best;
        }
        continue;
      }
      for (const r of event.results || []) {
        if (!included(r) || r.medal_eligible === false) continue;
        if (r.format === 'relay') {
          for (const m of r.members || []) if (m.rounds?.length) person(m.athlete_id,m.name).relay++;
        } else {
          const p = person(r.athlete_id,r.name);
          if (r.status !== 'DNS' && r.started !== false) p.starts++;
          if (medalResult(r)) p.medals[r.rank - 1]++;
          if (r.final_group === 'A' && r.status !== 'DNS' && r.started !== false) p.finals++;
          if (r.rank_scope !== 'final' && r.rank && r.status === 'classified' && (p.best == null || r.rank < p.best)) p.best = r.rank;
        }
      }
    }
    return [...people.values()].sort((a,b) => b.medals[0]-a.medals[0] || b.medals[1]-a.medals[1] || b.medals[2]-a.medals[2] || b.finals-a.finals || a.name.localeCompare(b.name));
  }
  function summarize(event) {
    const rows = (event.results || []).filter(included);
    const projects = Object.fromEntries(projectKeys.map(key => {
      const selected = rows.filter(r => matchesProject(r,key));
      const offered = event.programme == null ? null : event.programme.some(r => matchesProject(r,key));
      const state = selected.length ? 'recorded' : offered === false ? 'not_offered' : event.coverage === 'complete' && (offered || event.participation === 'none') ? 'zero' : 'uncollected';
      // Best-result projections retain identity, status and medal eligibility, never provenance blobs or lineups.
      const best = bestResult(selected);
      const compact = best && Object.fromEntries(['rank','rank_scope','final_group','status','format','name','athlete_id','medal_eligible','medal_verified'].filter(k => k in best).map(k => [k,best[k]]));
      return [projectId(key), {state, totals:rowStatistics(selected), best:compact,
        group_only:selected.some(r => r.rank != null), missing_classifications:selected.some(r => r.classification_missing)}];
    }));
    return {totals:statistics([{results:rows}]), projects, athletes:athleteStatistics([{results:rows}])};
  }
  function scopeEvents(index,mode,id,kind = 'all') {
    const seasons = mode === 'cycle' ? index.cycles.find(c => c.id === id)?.seasons || [] : [id];
    return index.events.filter(e => seasons.includes(e.season) && kindMatches(e.kind,kind));
  }
  function scopeCoverage(index,mode,id,kind,events) {
    const seasons = mode === 'cycle' ? index.cycles.find(c => c.id === id)?.seasons || [] : [id];
    const inventories = (index.inventory || []).filter(s => seasons.includes(s.season) && kindMatches(s.kind,kind));
    const expectedIds = new Set(inventories.flatMap(s => s.official_event_ids).map(String));
    const availableIds = new Set(events.map(e => String(e.official_event_id)).filter(id => id !== 'undefined'));
    const missing = [...expectedIds].filter(id => !availableIds.has(id));
    const pending = (index.pending || []).filter(e => seasons.includes(e.season) && kindMatches(e.kind,kind));
    // Unknown and future seasons remain unknown; an empty inventory entry explicitly means no events.
    const known = seasons.every(s => inventories.some(scope => scope.season === s));
    const partial = !known || missing.length > 0 || pending.length > 0 || events.some(e => e.coverage !== 'complete');
    const expected = expectedIds.size;
    return {expected, available:events.length, partial, known, missing,
      state:!events.length ? known && expected === 0 && !pending.length ? 'not_offered' : 'uncollected' : partial ? 'partial' : 'complete'};
  }
  function projectSummary(events,key,scope) {
    const projects = events.map(e => e.summary?.projects[projectId(key)] || summarize(e).projects[projectId(key)]);
    const totals = sumStats(projects.map(p => p.totals));
    const best = bestResult(projects.map(p => p.best).filter(Boolean));
    const state = totals.entries ? 'recorded' : scope?.partial || !events.length ? scope?.state === 'not_offered' ? 'not_offered' : 'uncollected' : projects.every(p => p.state === 'not_offered') ? 'not_offered' : projects.every(p => ['zero','not_offered'].includes(p.state)) ? 'zero' : 'uncollected';
    return {state, totals, best, partial:!!scope?.partial, group_only:projects.some(p => p.group_only), missing_classifications:projects.some(p => p.missing_classifications)};
  }
  site.resultsModel = {normalizeSearch,resultSearchRow,resultSearchRows,resultFilter,hasResultFilter,matchesResultSearch,eventMatchesResults,projectKeys,projectId,included,matchesProject,medalResult,kindMatches,normalizeKind,statistics,summarize,athleteStatistics,scopeEvents,scopeCoverage,projectSummary};
})(typeof window === 'undefined' ? globalThis : window);
;
/* Results I/O boundary: immutable metadata, cached summaries, bounded detail requests. */
(function () {
  'use strict';
  const site = window.SSTS = window.SSTS || {};
  function create(fetchData) {
    const cache = new Map();
    let active = 0;
    const queue = [];
    const run = async (task) => {
      if (active >= 4) await new Promise(resolve => queue.push(resolve));
      active++;
      try {return await task();} finally {active--; queue.shift()?.();}
    };
    const read = (file,validate=()=>true) => {
      if (!cache.has(file)) {
        const promise = run(async()=>{const data=await fetchData(file);if(!validate(data))throw new Error('Invalid results data: '+file);return data;}).catch(error => {cache.delete(file); throw error;});
        cache.set(file,promise);
      }
      return cache.get(file);
    };
    const getIndex = () => read('results/index.json',data=>data.schema_version===2&&data.search_version===1&&data.search_file==='results/search.json'&&Array.isArray(data.events));
    async function ensureSearch(events) {
      const missing=events.filter(e=>!e.search_rows);
      if(!missing.length)return;
      const data=await read('results/search.json',data=>data.schema_version===2&&data.search_version===1&&Array.isArray(data.events)&&
        missing.every(e=>data.events.some(item=>item.id===e.id&&Array.isArray(item.search_rows))));
      const byId=new Map(data.events.map(e=>[e.id,e.search_rows]));
      for(const event of missing)event.search_rows=byId.get(event.id);
    }
    async function ensureStats(events) {
      const seasons = [...new Set(events.filter(e => !e.summary).map(e => e.season))];
      const files = await Promise.all(seasons.map(season => read('results/seasons/' + season.replace('/','-') + '.json',data=>data.schema_version===2&&Array.isArray(data.items)&&events.filter(e=>e.season===season).every(e=>data.items.some(item=>item.id===e.id&&item.summary?.totals)))));
      const byId = new Map(files.flatMap(file => file.items).map(item => [item.id,item.summary]));
      for (const event of events) if (byId.has(event.id)) event.summary = byId.get(event.id);
    }
    async function getEvent(meta) {
      const event = await read(meta.detail_file,data=>data.id===meta.id&&Array.isArray(data.results));
      return event;
    }
    return {getIndex,ensureSearch,ensureStats,getEvent, getEvents:events => Promise.all(events.map(getEvent))};
  }
  site.resultsStore = {create};
})();
;
/* Results views: query model/store, then render. */
(function () {
  'use strict';
  const site = window.SSTS;
  const {resultSearchRow,resultFilter,hasResultFilter,matchesResultSearch,eventMatchesResults,projectKeys,matchesProject,medalResult,normalizeKind,kindMatches,scopeEvents,scopeCoverage,statistics,athleteStatistics,projectSummary} = site.resultsModel;
  async function eventResults(ctx, calendar, route = {}) {
    const {h, root, fetchData, external} = ctx;
    const panel = h('section', {class: 'results-browser', 'aria-label': '中国队成绩'},
      h('p', {class: 'faint', role: 'status', text: '正在读取成绩…'}));
    root.replaceChildren(pageNav(h, 'event'), h('div', {class: 'results-heading'}, h('h1', {text: '赛事成绩'}), h('span', {class: 'faint tiny', text: '中国队'})), panel);
    try {
      const store = ctx.resultsStore ||= site.resultsStore.create(fetchData);
      const index = await store.getIndex();
      const params = new URLSearchParams(location.search);
      if (route.id) {
        if (!index.events.some(e => e.id === route.id)) {panel.replaceChildren(h('p',{text:'该赛事成绩尚未收录'}));return;}
        params.set('event', route.id);
      }
      const people = Object.fromEntries(index.athletes.map(p => [p.id, p]));
      const selected = index.events.find(e=>e.id===params.get('event'));
      if(selected){params.set('season',selected.season);const parent=index.cycles.find(c=>c.seasons.includes(selected.season));if(parent)params.set('cycle',parent.id);}
      if(!params.has('cycle')&&!params.has('season')&&!params.has('event'))params.set('season',index.current_season);
      const choose = (name,label,values) => site.ui.select(h,name,label,values,params.get(name));
      const cycle = choose('cycle', '周期', [['all', '全部周期'], ...[...index.cycles].reverse().map(c => [c.id, c.label])]);
      const season = choose('season', '赛季', [['all', '全部赛季']]);
      const event = choose('event', '赛事', [['all', '全部赛事']]);
      const kind = choose('kind', '赛事类型', [['all', '全部类型'], ['olympics', '冬奥会'], ['worlds', '世锦赛'], ['worldtour', '世巡赛'], ['worldcup', '世界杯'], ['fourcontinents', '四大洲']]);
      const gender = choose('gender', '性别', [['all', '全部性别'], ['women', '女子'], ['men', '男子'], ['mixed', '混合']]);
      const distance = choose('distance', '单项距离', [['all', '全部距离'], ...[500, 1000, 1500, 2000, 3000, 5000].map(d => [String(d), d + 'm'])]);
      const search = h('input', {type: 'search', name: 'athlete', 'aria-label': '成绩运动员', placeholder: '搜索运动员', value: params.get('athlete') || ''});
      const reset = h('button', {type: 'button', class: 'results-reset', text: '重置', onclick: () => {
        for (const el of [cycle, season, event, kind, gender, distance]) el.value = 'all';
        search.value = ''; fillSeasons(); season.value=index.current_season; fillEvents(); update();
      }});
      const more = h('details', {class: 'results-more'}, h('summary', {text: '单项筛选'}),
        h('div', {class: 'results-extra'}, kind, gender, distance));
      const form = h('form', {class: 'results-tools', role: 'search', 'aria-label': '成绩筛选'}, cycle, season, event, search, more, reset);
      const summary = h('p', {class: 'results-count faint', role: 'status'});
      const table = h('table', {class: 'results-table', 'aria-label': '中国队成绩列表'},
        h('caption', {class: 'sr-only', text: '中国队成绩，按赛事分组'}),
        h('thead', {}, h('tr', {}, ['单项', '运动员 / 队伍', '名次'].map(text => h('th', {scope: 'col', text})))));
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
        const values = [...new Set(cycleSeasons())].filter(s => s <= index.current_season).sort().reverse();
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
      let generation=0;
      let pageNumber=Math.max(1,Number.parseInt(params.get('page'),10)||1);
      const pager=h('nav',{class:'results-pager','aria-label':'成绩分页'});
      const draw = async () => {
        const request=++generation;
        root.querySelector('.results-breadcrumb')?.remove();
        const selected=index.events.find(e=>e.id===event.value);
        if(selected){
          const parent=index.cycles.find(c=>c.seasons.includes(selected.season));
          const items=[['成绩','/results/'],...(parent?[[parent.label,'/results/cycles/'+parent.id+'/']]:[]),[selected.season,'/results/seasons/'+seasonId(selected.season)+'/'],[selected.title,null]];
          root.insertBefore(breadcrumbs(h,items),root.querySelector('.results-heading'));
        }
        const filter = resultFilter({athlete:search.value,gender:gender.value,distance:distance.value});
        const rowMatch = row => matchesResultSearch(resultSearchRow(row,people),filter);
        const selectedEvent = event.value !== 'all';
        const inScope=index.events.filter(e=>matchEvent(e)&&(event.value==='all'||e.id===event.value));
        summary.textContent='正在读取成绩…';
        table.setAttribute('aria-busy','true');
        if(hasResultFilter(filter)){
          try {await store.ensureSearch(inScope);}
          catch(_){if(request===generation){table.removeAttribute('aria-busy');summary.replaceChildren('检索索引暂时无法加载。',h('button',{type:'button',text:'重试',onclick:draw}));}return;}
          if(request!==generation)return;
        }
        const candidates = inScope.filter(e=>selectedEvent||eventMatchesResults(e,filter));
        const pages=Math.max(1,Math.ceil(candidates.length/4));
        pageNumber=Math.min(pageNumber,pages);
        const currentPage=pageNumber;
        const begin=(currentPage-1)*4;
        summary.textContent='正在读取成绩…';
        table.setAttribute('aria-busy','true');
        let events;
        try {
          const pageEvents=candidates.slice(begin,begin+4);
          const details=await store.getEvents(pageEvents.filter(e=>eventMatchesResults(e,filter)));
          const byId=new Map(details.map(e=>[e.id,e]));
          events=pageEvents.map(e=>({...e,...byId.get(e.id),results:(byId.get(e.id)?.results || []).filter(rowMatch)}));
        }
        catch(_){if(request===generation){table.removeAttribute('aria-busy');summary.replaceChildren('成绩暂时无法加载。',h('button',{type:'button',text:'重试',onclick:draw}));}return;}
        if(request!==generation)return;
        table.removeAttribute('aria-busy');
        const emptySelection=selectedEvent&&events.length&&!events.some(e=>e.results.length)&&hasResultFilter(filter);
        summary.textContent = emptySelection ? '所选赛事没有符合条件的成绩' : candidates.length ? (begin+1)+'–'+Math.min(begin+4,candidates.length)+' / '+candidates.length+' 场 · 本页 '+events.reduce((n,e)=>n+e.results.length,0)+' 条成绩' : '没有匹配的赛事';
        const canonical=new URL(location.href);
        if(currentPage>1)canonical.searchParams.set('page',String(currentPage));else canonical.searchParams.delete('page');
        window.history.replaceState(null,'',canonical);
        const turn=delta=>{pageNumber=currentPage+delta;update(false);};
        pager.hidden=pages<=1;
        pager.replaceChildren(h('button',{type:'button',text:'上一页',disabled:pageNumber===1,onclick:()=>turn(-1)}),h('span',{class:'num',text:pageNumber+' / '+pages}),h('button',{type:'button',text:'下一页',disabled:pageNumber===pages,onclick:()=>turn(1)}));
        for (const body of [...table.tBodies]) body.remove();
        table.hidden = !events.length;
        for (const e of events) {
          const page = Math.min(...e.results.map(r => r.source_page).filter(Boolean));
          const source = external(e.source.url + (Number.isFinite(page) ? '#page=' + page : ''), e.source.kind==='isu_api'?'官方成绩':'成绩册');
          const body = h('tbody', {'data-event': e.id}, h('tr', {class: 'result-event'},
            h('th', {colspan: '3', scope: 'rowgroup'}, h('div', {}, h('span', {class: 'result-season num', text: e.season}),
              h('b', {text: e.title}), h('span', {class: 'faint num result-date', text: e.date_end}), source))));
          if(!e.results.length)body.append(h('tr',{},h('td',{colspan:'3',class:'faint',text:hasResultFilter(filter)?'所选赛事没有符合条件的成绩':e.participation==='none'?'无中国队记录（0）':'当前筛选无记录'})));
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

      };
      const update = (resetPage=true) => {
        if(resetPage)pageNumber=1;
        site.ui.writeFilters([cycle,season,event,kind,gender,distance,search],'/results/events/');
        const url=new URL(location.href);
        // 'all' differs from the default current season and must survive sharing/reload.
        if(season.value==='all')url.searchParams.set('season','all');
        if(pageNumber>1)url.searchParams.set('page',String(pageNumber));else url.searchParams.delete('page');
        window.history.replaceState(null,'',url);return draw();
      };
      form.addEventListener('submit', e => {e.preventDefault(); update();});
      form.addEventListener('change', e => {
        if (e.target === cycle) fillSeasons();
        if ([cycle, season, kind].includes(e.target)) fillEvents();
        update();
      });
      let searchTimer;
      search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(update,150);});
      panel.replaceChildren(form, summary, table, pager);
      fillSeasons(true); fillEvents(true);
      await draw();
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
  const projectLabel = ([gender, distance]) => ({women:'女子',men:'男子',mixed:'混合'})[gender] + ' ' + distance + ' 米' + (distance >= 2000 ? '接力' : '');
  const resultPlace = r => (r.rank == null ? '—' : (r.rank_scope === 'final' ? r.final_group + '组第 ' : '第 ') + r.rank + ' 名') + (r.status === 'classified' ? '' : ' · ' + r.status);
  const seasonId = value => value.replace('/', '-');
  const seasonValue = value => value.replace(/^(\d{4})-(\d{2})$/, '$1/$2');
  const eventLink = (e, query = '') => '/results/events/' + encodeURIComponent(e.id) + '/' + query;
  const reviewSelect = site.ui.select;
  function coverage(h, events, scope) {
    const ratio=scope?.known?events.length+' / '+scope.expected+' 场':events.length+' 场';
    const state=scope?.state;
    const text=state==='not_offered'?'未设赛事':!events.length?'未收录':ratio;
    return h('span',{class:'coverage-note'},h('span',{text}));
  }
  function eventRows(ctx,events,people,key,isActive) {
    const {h}=ctx;
    const records=h('div');
    const pager=h('div',{class:'raw-pager'});
    const lastPage=Math.max(0,Math.ceil(events.length/3)-1);
    const panel=h('div',{class:'raw-records'},records,lastPage?pager:null);
    let page=0,generation=0;
    const valid = request => request===generation&&panel.isConnected&&isActive();
    const changePage=delta=>{
      if(!isActive())return;
      const next=Math.max(0,Math.min(lastPage,page+delta));
      if(next!==page){page=next;draw();}
    };
    const draw=async()=>{
      if(!isActive()||!panel.isConnected)return;
      const request=++generation;
      const selectedPage=page;
      panel.setAttribute('aria-busy','true');
      records.replaceChildren(h('p',{class:'faint',role:'status',text:'正在读取原始成绩…'}));
      pager.hidden=lastPage===0;
      pager.replaceChildren(
        h('button',{type:'button',text:'上一组',disabled:page===0,onclick:()=>changePage(-1)}),
        h('span',{class:'faint tiny',text:(page+1)+' / '+(lastPage+1)}),
        h('button',{type:'button',text:'下一组',disabled:page===lastPage,onclick:()=>changePage(1)}));
      try {
        const details=await ctx.resultsStore.getEvents(events.slice(selectedPage*3,selectedPage*3+3));
        if(!valid(request))return;
        const rows=details.flatMap(e=>e.results.filter(r=>matchesProject(r,key)).map(r=>({e,r})));
        const source=({e,r})=>ctx.external((r.source_url||e.source.url)+(r.source_page?'#page='+r.source_page:''),'来源');
        records.replaceChildren(rows.length?h('ul',{class:'review-records'},rows.map(({e,r})=>h('li',{},
          h('a',{href:eventLink(e,'?gender='+r.gender+'&distance='+r.distance_m)},h('span',{class:'review-record-event',text:e.title}),
            h('span',{text:r.format==='relay'?'中国队':people[r.athlete_id]?.name||r.name}),
            h('b',{class:medalResult(r)?'num is-medal':'num',text:resultPlace(r)+(r.final_group&&r.rank_scope!=='final'?' · '+r.final_group+' 决赛':'')})),source({e,r})))):
          h('p',{class:'faint',text:events.length?'本页无该项目记录':'未收录'}));
      }catch(_){
        if(valid(request))records.replaceChildren(h('p',{role:'alert',text:'原始成绩暂时无法加载'}),h('button',{type:'button',text:'重试',onclick:draw}));
      }finally{if(valid(request))panel.removeAttribute('aria-busy');}
    };
    return {panel,resume:draw,suspend:()=>{generation++;panel.removeAttribute('aria-busy');}};
  }
  function summaryTable(ctx, sets, names, people, metric = 'best', periods = null, selectors = [], scopes = [], isCurrentView = () => true) {
    const {h}=ctx;
    const table = h('table', {class:'compare-table','aria-label':'项目成绩对照','data-columns':names.length}, h('thead', {}, h('tr', {},
      h('th', {scope:'col',text:'项目'}), names.map((text,i) => h('th', {scope:'col'},selectors[i] ? h('div',{class:'compare-object'},selectors[i]) : h('span',{text}),coverage(h,sets[i],scopes[i]))))));
    const body = h('tbody');
    let group = '';
    projectKeys.forEach((key, i) => {
      if (group !== key[0]) {
        group = key[0];
        body.append(h('tr', {class:'compare-group'}, h('th', {colspan:names.length + 1,scope:'rowgroup',text:({women:'女子',men:'男子',mixed:'混合接力'})[group]})));
      }
      const rawViews=[];
      const detail = h('tr', {class:'compare-detail',hidden:true,id:'project-detail-' + i});
      const button = h('button', {type:'button',class:'project-toggle','aria-expanded':'false','aria-controls':detail.id,
        onclick:() => {
          if(detail.hidden){
            detail.hidden=false;
            if(!detail.hasChildNodes())populateDetail();
            rawViews.forEach(view=>view.resume());
          }else{detail.hidden=true;rawViews.forEach(view=>view.suspend());}
          button.setAttribute('aria-expanded',String(!detail.hidden));
        }},
        h('span', {class:'project-chevron','aria-hidden':'true',text:'›'}), key[1] + ' 米' + (key[1] >= 2000 ? '接力' : ''));
      body.append(h('tr', {class:'compare-project'}, h('th', {scope:'row'},button), sets.map((events,column) => {
        const project=projectSummary(events,key,scopes[column]);
        const {totals:stats,best}=project;
        if(project.state!=='recorded')return h('td',{},h('span',{class:'faint',text:({not_offered:'未设项',zero:'无中国队记录（0）',uncollected:'未收录'})[project.state]}));
        const cell = h('td', {class:'compare-value'});
        if (metric === 'medals') {
          cell.append(h('b',{class:'num',text:stats.medals.map((n,i) => n + [' 金',' 银',' 铜'][i]).join(' · ')}));
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
          cell.append(h('b',{text:'—'}));
        }
        cell.append(h('small',{class:'faint',text:stats.entries + ' 条成绩'}));

        return cell;
      })));
      const renderRecords=events=>{
        const view=eventRows(ctx,events,people,key,()=>!detail.hidden&&isCurrentView());
        rawViews.push(view);return view.panel;
      };
      const populateDetail=()=>{
      const detailGroups = periods ? [0,1,2,3].map(offset => h('section', {class:'compare-period'},
        h('h3', {text:'第 ' + (offset + 1) + ' 赛季'}),
        h('div', {class:'compare-detail-grid',style:{gridTemplateColumns:'repeat(' + names.length + ', minmax(0, 1fr))'}}, sets.map((events,j) =>
          h('section', {},h('h4',{text:periods[j]?.[offset] || names[j]}),renderRecords(events.filter(e=>e.season===periods[j]?.[offset]))))))) :
        h('div', {class:'compare-detail-grid',style:{gridTemplateColumns:'repeat(' + names.length + ', minmax(0, 1fr))'}}, sets.map((events,j) =>
          h('section', {'aria-label':names[j] + ' ' + projectLabel(key)},h('h3',{text:names[j]}),renderRecords(events))));
      detail.append(h('td', {colspan:names.length + 1},detailGroups));
      };
      body.append(detail);
    });
    table.append(body);
    return site.ui.tableScroll(h,table,'可横向滚动的成绩对照表','compare-scroll');
  }
  async function results(ctx, calendar, route = {}) {
    ctx.root.classList.add('results-page');
    if (route.view === 'event' || !route.view && new URLSearchParams(location.search).has('event')) return eventResults(ctx,calendar,route);
    const {h,root,fetchData} = ctx;
    const active = route.view || 'index';
    const panel = h('section',{class:'review-content'},h('p',{class:'faint',role:'status',text:'正在读取成绩…'}));
    root.replaceChildren(pageNav(h,active),panel);
    try {
      const store = ctx.resultsStore ||= site.resultsStore.create(fetchData);
      const index = await store.getIndex();
      if (active === 'index') resultsIndex(ctx,index,panel);
      else if (active === 'compare') await comparison(ctx,index,panel);
      else if (route.id) await review(ctx,index,panel,active,route.id);
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
    const current=index.current_season;
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
  function statsRibbon(h,events,scope) {
    const s=statistics(events);
    return h('dl',{class:'stats-ribbon','aria-label':'当前范围统计'},[['赛事',s.events],['金',s.medals[0]],['银',s.medals[1]],['铜',s.medals[2]],['A 决赛',s.a_finals],['前 8 名',s.top8]].map(([text,value])=>
      h('div',{},h('dt',{text}),h('dd',{class:'num',text:events.length?value:'—'}))));
  }
  function statsTable(h,title,groups,cycle) {
    const table=h('table',{class:'review-stats-table','aria-label':title},h('thead',{},h('tr',{},[cycle?'赛季':'赛事',...(cycle?['场']:[]),'金','银','铜','A 决赛','前 8'].map(text=>h('th',{scope:'col',text})))));
    table.append(h('tbody',{},groups.map(({text,href,events,scope})=>{
      const s=statistics(events);
      return h('tr',{},h('th',{scope:'row'},h('a',{href,text}),),[...(cycle?[s.events]:[]),...s.medals,s.a_finals,s.top8].map(value=>h('td',{class:'num',text:events.length?value:'—'})));
    })));
    return h('section',{class:'review-breakdown'},h('div',{class:'portal-section-head'},h('h2',{text:title})),site.ui.tableScroll(h,table,title));
  }
  function contributions(h,events,people) {
    const rows=athleteStatistics(events).map(p=>({...p,name:people[p.id]?.name||p.name}));
    if(!rows.length)return null;
    const table=h('table',{class:'review-stats-table contribution-table','aria-label':'运动员成绩统计'},h('thead',{},h('tr',{},['运动员','单项出赛','金','银','铜','A 决赛','接力项次'].map(text=>h('th',{scope:'col',text})))),
      h('tbody',{},rows.map(p=>h('tr',{},h('th',{scope:'row',text:p.name}),[p.starts,...p.medals,p.finals,p.relay].map(text=>h('td',{class:'num',text}))))));
    return h('details',{class:'athlete-contributions'},h('summary',{text:'运动员 · '+rows.length+' 人'}),site.ui.tableScroll(h,table,'运动员成绩统计'));
  }
  async function review(ctx,index,panel,mode,pathId) {
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
    let generation=0;
    const draw=async()=>{
      const request=++generation;
      compareLink.href='/results/compare/?mode='+mode+'&left='+encodeURIComponent(id)+'&kind='+kind.value;
      const events=scopeEvents(index,mode,id,kind.value);
      try {await ctx.resultsStore.ensureStats(events);} catch (_) {if(request===generation)body.replaceChildren(h('p',{role:'alert',text:'统计暂时无法加载'}),h('button',{type:'button',text:'重试',onclick:draw}));return;}
      if(request!==generation)return;
      const groups=cycle?cycle.seasons.filter(s=>s<=index.current_season).map(season=>({text:season,href:'/results/seasons/'+seasonId(season)+'/?kind='+kind.value,events:scopeEvents(index,'season',season,kind.value)})):
        events.map(e=>({text:e.title,href:eventLink(e),events:[e]}));
      for(const group of groups)group.scope=cycle?scopeCoverage(index,'season',group.text,kind.value,group.events):{partial:group.events.some(e=>e.coverage!=='complete')};
      body.replaceChildren(...[coverage(h,events,scopeCoverage(index,mode,id,kind.value,events)),statsRibbon(h,events,scopeCoverage(index,mode,id,kind.value,events)),
        statsTable(h,cycle?'赛季成绩':'各站成绩',groups,!!cycle),
        h('div',{class:'portal-section-head'},h('h2',{text:'项目成绩'})),summaryTable(ctx,[events],[title],people,'best',cycle?[cycle.seasons]:null,[],[scopeCoverage(index,mode,id,kind.value,events)],()=>request===generation),
        contributions(h,events,people)].filter(Boolean));
    };
    kind.addEventListener('change',()=>{site.ui.writeFilters([kind]);draw();});
    panel.replaceChildren(breadcrumbs(h,[['成绩','/results/'],['成绩档案','/results/cycles/'],...(parentCycle?[[parentCycle.label,'/results/cycles/'+parentCycle.id+'/']]:[]),[title,null]]),h('div',{class:'results-heading'},h('h1',{text:title}),h('span',{class:'country-label',text:'CHN'}),
      compareLink),
      h('div',{class:'review-tools'},h('label',{},h('span',{text:'赛事范围'}),kind)),body);await draw();
  }
  async function comparison(ctx,index,panel) {
    const {h} = ctx, params=new URLSearchParams(location.search);
    const people=Object.fromEntries(index.athletes.map(p=>[p.id,p]));
    const seasons=[...new Set(index.cycles.flatMap(c=>c.seasons))].filter(s=>s<=index.current_season).sort().reverse();
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
    let generation=0;
    const draw=async()=>{
      const request=++generation;
      more.querySelector('.compare-more-icon').textContent=third.value?'−':'＋';
      more.querySelector('summary').setAttribute('aria-label',third.value?'移除第三个对比对象':'添加第三个对比对象');
      if(!third.value) thirdField.append(third);
      const ids=[left.value,right.value,...(third.value?[third.value]:[])];
      const sets=ids.map(id=>scopeEvents(index,mode.value,id,kind.value));
      try {await ctx.resultsStore.ensureStats(sets.flat());} catch (_) {if(request===generation)body.replaceChildren(h('p',{role:'alert',text:'统计暂时无法加载'}),h('button',{type:'button',text:'重试',onclick:draw}));return;}
      if(request!==generation)return;
      const names=ids.map(id=>options().find(([value])=>value===id)?.[1] || id);
      const table=summaryTable(ctx,sets,names,people,metric.value,mode.value==='cycle'?ids.map(id=>index.cycles.find(c=>c.id===id)?.seasons):null,[left,right,...(third.value?[third]:[])],ids.map((id,i)=>scopeCoverage(index,mode.value,id,kind.value,sets[i])),()=>request===generation);
      if(new Set(ids).size!==ids.length){table.querySelector('tbody').replaceChildren();body.replaceChildren(h('p',{class:'review-notice',role:'status',text:'请选择不同的对比对象'}),table);return;}
      body.replaceChildren(table);
    };
    const update=()=>{
      site.ui.writeFilters([mode,left,right,third,kind,metric]);draw();
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
    panel.replaceChildren(h('div',{class:'results-heading'},h('h1',{text:'成绩对比'}),h('span',{class:'country-label',text:'CHN'})),form,body);await draw();
  }
  site.results = {render:results};
})();
;
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
  site.portal = {home, athletes};
})();
;
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
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- DOM helpers ---------- */
  const {h,s,append,fill} = window.SSTS.ui;
  const external = (href, ...kids) => h('a', {href, target: '_blank', rel: 'noopener noreferrer'}, ...kids, icon('external', 'ico ico-xs'));
  const cls = (...names) => names.filter(Boolean).join(' ');
  // " · "-separated facts that wrap between facts, never inside one.
  const phrases = (...items) => items.filter(Boolean).flatMap((x, i) => [i ? '\u00a0· ' : null, h('span', {class: 'nowrap'}, x)]);

  const ICONS = {
    home: [['path', {d: 'M3 11l9-8 9 8M5 10v11h5v-7h4v7h5V10'}]],
    history: [['path', {d: 'M4 10a8 8 0 1 1 1 8M4 4v6h6M12 7v5l3 2'}]],
    people: [['circle', {cx: 9, cy: 8, r: 3}], ['path', {d: 'M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5'}]],
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
      el.classList.toggle('long-days', p.d >= 100);
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
      if (meta) meta.content = theme === 'light' ? '#F3F8FC' : '#070B12';
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

  // One dot per round this event actually races (1500m has no preliminaries, women's 1500m may start at the quarter-finals).
  function stageMeter(r) {
    const rounds = r.stages || ROUND_ORDER, at = rounds.indexOf(r.round);
    return h('span', {class: 'meter', 'aria-hidden': 'true'},
      rounds.map((_, i) => h('i', {class: i < at ? 'done' : i === at ? 'on' : ''})));
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
      const response = await fetch('/data/' + file, {cache: file === 'calendar.json' ? 'default' : 'no-cache', signal: controller.signal});
      if (!response.ok) throw new Error('数据请求失败: ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  };
  function prepare(data) {
    const stages = new Map();
    for (const r of data.entries) {
      const key = r.gender + '|' + r.distance_m + '|' + r.format;
      if (!stages.has(key)) stages.set(key, new Set());
      stages.get(key).add(r.round);
    }
    data.entries.forEach((r, i) => {
      r.t = Date.parse(r.utc_start); r.i = i;
      r.stages = ROUND_ORDER.filter(x => stages.get(r.gender + '|' + r.distance_m + '|' + r.format).has(x));
    });
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
  let calendarSeason;
  const stationHref = (id, day) => window.SSTS.navigation.eventHref(id, calendarSeason) + (day ? '?day=' + encodeURIComponent(day) : '');

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
    return {athletes, predictions: station.predictions ? predictions : null, status, load,
      startRounds: () => { if (!requested.has('rounds')) load('rounds'); },
      show: name => {
        if (name === 'athletes') { load('entries'); load('rankings'); }
        else if (name === 'predictions') load('predictions');
        else load('rounds');
      }};
  }

  function stationTabs(schedule, competition) {
    const sections = {schedule, athletes: competition.athletes};
    if (competition.predictions) sections.predictions = competition.predictions;
    const labels = {schedule: '赛程', athletes: '报名名单', predictions: '分组预测'};
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
    const box = h('details', {class: 'panel athlete-panel prediction-panel'},
      h('summary', {class: 'athlete-summary'}, h('b', {text: '分组预测'}),
        h('span', {class: 'prediction-label', text: '非官方'}),
        dataset.stale ? h('small', {class: 'pill', text: '待更新'}) : null));
    const select = h('select', {'aria-label': '预测项目'}, dataset.items.map(p =>
      h('option', {value: p.id, text: (gender[p.gender] || '') + ' ' + p.distance_m + 'm'})));
    const chinaOnly = h('button', {type: 'button', class: 'chip', 'aria-pressed': 'false', text: '只看 CHN'});
    const body = h('div', {class: 'prediction-body', 'aria-live': 'polite'});
    const reasons = {schedule: '轮次赛程待公布', distance_entries: '单项报名待公布',
      prequalification_tie: '直通名额出现并列，待官方名单', prequalification_list: '直通名单待官方公布'};
    const person = p => h('li', {class: cls(p.country === 'CHN' && 'athlete-china'), text: p.name + ' · ' + p.country});
    let onlyChina = false;
    const draw = () => {
      const item = dataset.items.find(p => p.id === select.value);
      if (!item) return;
      fill(body);
      chinaOnly.hidden = item.status !== 'predicted';
      if (item.status === 'official_available') {
        body.append(h('p', {class: 'faint athlete-empty', text: '官方分组已公布，请在赛程中查看'}));
      } else if (item.status !== 'predicted') {
        body.append(h('p', {class: 'faint athlete-empty', text: reasons[item.missing[0]] || '暂无法预测'}));
      } else {
        const groups = item.groups.filter(g => !onlyChina || g.has_china);
        const grid = h('div', {class: 'prediction-grid'});
        for (const group of groups) grid.append(h('section', {class: cls('prediction-group', group.has_china && 'has-china')},
          h('h3', {}, '第 ' + group.heat_number + ' 组', h('span', {class: 'faint num', text: group.size + ' 人'})),
          h('ul', {}, group.participants.map(p => h('li', {class: cls(p.country === 'CHN' && 'athlete-china')},
            h('span', {class: 'faint num', text: '#' + p.seed_rank}), h('b', {text: p.name}), h('small', {text: p.country})))),
          group.size > group.participants.length
            ? h('p', {class: 'faint tiny', text: '另 ' + (group.size - group.participants.length) + ' 人待定'}) : null));
        body.append(grid);
        if (!groups.length) body.append(h('p', {class: 'faint athlete-empty', text: '已知种子中没有 CHN 选手'}));
        const unseeded = item.unseeded.filter(p => !onlyChina || p.country === 'CHN');
        if (item.unseeded.length) body.append(h('details', {class: 'prediction-byes', open: onlyChina && unseeded.length > 0},
          h('summary', {}, phrases('其余 ' + item.unseeded.length + ' 人待定',
            item.unseeded.some(p => p.country === 'CHN') && 'CHN ' + item.unseeded.filter(p => p.country === 'CHN').length + ' 人')),
          h('p', {class: 'faint tiny', text: '无世界排名，按未公开的报名成绩分入各组'}),
          h('ul', {}, unseeded.map(person))));
        if (item.prequalified.length) body.append(h('details', {class: 'prediction-byes'},
          h('summary', {text: '直通下一轮 · ' + item.prequalified.length + ' 人'}),
          h('ul', {}, item.prequalified.map(person))));
      }
      body.append(h('details', {class: 'source-disclosure'},
        h('summary', {}, '来源与规则'),
        h('div', {class: 'source-links'},
          ...(item.source_urls || []).map((url, i) => external(url, ['单项报项', '世巡赛排名', '世界排名'][i] || 'ISU 来源')),
          ...(dataset.rules || []).map(r => external(r.url, r.label)))));
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
    country.value = countries.includes(params.get('country')) ? params.get('country') : china ? 'CHN' : 'all';
    const sex = h('select', {'aria-label': title + '性别'},
      [['all', '全部'], ['women', '女子'], ['men', '男子'], ...(ranking ? [['mixed', '混合']] : [])]
        .map(([value, text]) => h('option', {value, text})));
    const count = h('p', {class: 'faint tiny', role: 'status'});
    const list = h('ul', {class: 'athlete-grid', 'aria-label': title + '列表'});
    const update = () => {
      const selected = people.filter(p => (country.value === 'all' || p.country === country.value) && (sex.value === 'all' || p.gender === sex.value));
      if (ranking) selected.sort((a, b) => a.ranking_type.localeCompare(b.ranking_type) || a.distance_m - b.distance_m || a.rank - b.rank);
      count.textContent = '显示 ' + selected.length + (ranking ? ' 条' : ' 人');
      fill(list, selected.map(p => h('li', {class: cls('athlete-card', p.country === 'CHN' && 'is-china'), id: ranking ? null : 'athlete-' + p.athlete_id, dataset: {country: p.country}},
        h('span', {class: 'athlete-nation', text: p.country}),
        ranking ? [h('b', {class: 'athlete-name', text: p.name}),
          h('span', {class: 'athlete-caption'}, ({'event': '单站排名', world_tour: '世巡赛积分', world: '世界排名'})[p.ranking_type] || p.ranking_type,
            ' · ' + (gender[p.gender] || '') + ' ' + p.distance_m + 'm · 第 ' + p.rank + ' 名',
            p.points != null ? ' · ' + p.points + ' 分' : null)] :
          h('b', {class: 'athlete-name'}, p.name,
            h('small', {class: 'athlete-events', text: [gender[p.gender], p.distances && p.distances.join('/') + 'm'].filter(Boolean).join(' · ')}),
            p.participation === 'substitute' ? h('span', {class: 'pill', text: '替补'}) : null))));
      if (!selected.length) list.append(h('li', {class: 'faint athlete-empty', text: '当前筛选下没有运动员'}));
    };
    country.addEventListener('change', update);
    sex.addEventListener('change', update);
    box.append(h('div', {class: 'athlete-tools'}, country, sex, count), list,
      h('div', {class: 'athlete-source source-line'},
        dataset.updated_at ? h('span', {text: '更新于 ' + sourceTime(dataset.updated_at)}) : null,
        dataset.source_urls?.[0] ? external(dataset.source_urls[0], '官方来源') : null));
    if (ranking) box.addEventListener('toggle', () => { if (box.open && !list.childElementCount) update(); });
    else {
      update();
      if (location.hash.startsWith('#athlete-')) requestAnimationFrame(() => {
        const selected = document.getElementById(location.hash.slice(1));
        selected?.scrollIntoView({block: 'center'});
      });
    }
    return box;
  }

  function showCompetition(r, heats) {
    const titleId = 'competition-title';
    const close = h('button', {type: 'button', class: 'icon-btn', 'aria-label': '关闭比赛详情'}, icon('close'));
    const dialog = h('dialog', {class: 'competition-dialog', 'aria-labelledby': titleId},
      h('header', {class: 'competition-head'}, h('h2', {id: titleId, text: eventName(r) + ' · ' + roundName(r)}), close),
      r.qualification ? h('p', {class: 'qual-rule'}, h('b', {class: 'num', text: r.qualification.code}), r.qualification.zh) : null);
    for (const heat of [...heats].sort((a, b) => (a.heat_number ?? 0) - (b.heat_number ?? 0))) {
      const results = heat.evidence === 'official_results';
      const status = !results ? null : heat.result_status?.toLowerCase() === 'official' ? '正式成绩' : '暂定成绩';
      const heading = heat.group ? heat.group + ' 组决赛' : heat.heat_number ? '第 ' + heat.heat_number + ' 组' : heat.heat_label;
      const people = h('ol', {class: 'result-people'});
      for (const p of heat.participants) {
        const result = p.penalty ? p.penalty.code + ' 判罚' : p.result || '—';
        people.append(h('li', {class: cls('result-person', p.country === 'CHN' && 'is-china')},
          h('span', {class: 'result-rank num', text: results ? p.rank ?? '—' : p.starting_position ?? '—',
            title: results ? '名次' : '出发位'}),
          h('div', {class: 'result-identity'}, h('b', {text: p.name}),
            h('span', {class: 'faint tiny', text: p.country + (p.helmet_number != null ? ' · #' + p.helmet_number : '')}),
            p.members?.length ? h('span', {class: 'result-members tiny'}, phrases(...p.members.map(m => m.name))) : null),
          results ? h('div', {class: cls('result-value num', p.penalty && 'penalty-value')},
            h('b', {text: result}), p.qualification ? h('small', {text: ({Q: '晋级', q: '按成绩晋级', ADV: '判进'})[p.qualification] || p.qualification}) : null) : null));
      }
      // Column names, since the leading number means a start position before results and a rank after.
      const cols = h('div', {class: 'result-cols', 'aria-hidden': 'true'},
        h('span', {text: results ? '名次' : '出发位'}), h('span', {text: '选手 · 国家 · 头盔号'}), results ? h('span', {text: '成绩'}) : null);
      dialog.append(h('section', {class: 'competition-heat'},
        h('div', {class: 'competition-heat-head'}, h('h3', {text: heading}), status ? h('span', {class: 'pill', text: status}) : null), cols, people));
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
    const bj = parts(BJ, open), local = parts(st.timezone, open);
    const when = md(bj.date) + ' ' + wk(bj.date) + ' ' + dayPart(bj.hm) + ' ' + bj.hm;
    const onSale = now() >= open;
    return h('section', {class: 'panel ticket-panel', 'aria-label': st.city + '站售票'},
      h('div', {class: 'ticket-copy'},
        h('p', {class: 'eyebrow', text: st.city + '站 · 门票'}),
        h('h2', {text: onSale ? '门票已开售' : '售票信息'}),
        h('p', {class: 'ticket-time'},
          onSale ? '已于北京时间 ' : '北京时间 ', h('span', {class: 'nowrap', text: when + ' 开售'}),
          st.timezone === BJ ? null : ['\u00a0· ', h('small', {class: 'nowrap', text: st.city + '时间 ' + local.hm})])),
      h('div', {class: 'ticket-actions'},
        external(st.ticketing.isu_url, 'ISU 售票说明'),
        external(st.ticketing.booking_url, st.ticketing.booking_name + ' 订票')));
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
      ...stations.map(ticketPanel).filter(Boolean),
      seasonLine(stations, focus, cal.championships || []), stationGrid(stations, focus),
      championshipsCard(cal),
      h('p', {class: 'source-line'}, external(cal.source_url, 'ISU 官方赛历')));
  }

  // A station's own ISU page when known, else the season calendar.
  const officialPage = (cal, st) => st.source_url && st.source_url !== cal.source_url
    ? external(st.source_url, 'ISU 赛事页') : external(cal.source_url, 'ISU 官方赛历');

  function championshipsCard(cal) {
    if (!cal.championships?.length) return null;
    return h('section', {class: 'championship-section', 'aria-label': '世界锦标赛'},
      h('h2', {class: 'section-title', text: '世界锦标赛'}),
      cal.championships.map(st => h('article', {class: 'panel championship-card'},
        h('div', {class: 'championship-main'},
          h('p', {class: 'championship-kicker', text: st.date_start.slice(0, 4) + ' · ISU WORLD CHAMPIONSHIPS'}),
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
    const official = () => officialPage(cal, event);
    // Nothing is published for a championship yet, so there is one panel and no tabs to switch.
    const schedule = h('section', {class: 'schedule-content', id: 'section-schedule'},
      h('section', {class: 'panel empty-state'},
        trackArt('empty-track', 2),
        h('h2', {text: '逐项赛程待公布'}),
        h('p', {class: 'faint', text: '报名名单与分组也将在 ISU 公布后显示'}),
        official()));
    root.replaceChildren(stationNav(cal, event),
      h('section', {class: 'station-hero'}, copy, pendingCard(win)), schedule);
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
        h('span', {text: st.isChampionship ? '世锦赛' : '第 ' + st.n + ' 站'})),
      h('h2', {class: 'next-city'}, st.isChampionship ? st.title : st.city + '站', h('small', {text: st.city_en})),
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

  function seasonLine(stations, focus, championships) {
    // Championships close the season, so the axis runs to the last of them.
    const worlds = championships.map(c => ({...c, win: stationWindow(c, null)}));
    const from = Date.parse(stations[0].date_start.slice(0, 8) + '01T00:00:00Z');
    const endD = new Date([...stations, ...worlds].map(e => e.date_end).sort().at(-1) + 'T00:00:00Z');
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
    worlds.forEach((c, i) => line.append(h('a', {class: cls('sl-node is-worlds', (stations.length + i) % 2 ? 'down' : 'up', 'is-' + phase(c.win)),
      href: stationHref(c.id), style: {left: pos(Date.parse(c.date_start + 'T12:00:00Z')) + '%'}, 'aria-label': c.title + ' ' + c.date_start},
      h('span', {class: 'sl-dot'}, icon('medal', 'ico ico-xs')),
      h('span', {class: 'sl-label'}, h('b', {text: '世锦赛'}), h('small', {class: 'num', text: md(c.date_start)})))));
    // Phones scroll the axis sideways; start with today in view.
    const scroller = h('div', {class: 'sl-scroll'}, line);
    requestAnimationFrame(() => { scroller.scrollLeft = line.offsetWidth * todayPct / 100 - scroller.clientWidth / 4; });
    const nextDays = focus && phase(focus.win) === 'upcoming' ? Math.ceil((focus.win.start - now()) / DAY) : null;
    return h('section', {class: 'panel season-line', 'aria-label': '赛季时间轴'},
      h('div', {class: 'panel-head'},
        h('h2', {text: '赛季时间轴'}),
        h('p', {}, h('i', {class: 'legend-today'}), '今天 ' + md(today) + ' ' + wk(today),
          nextDays != null ? ' · 距' + focus.city + '站还有 ' + nextDays + ' 天' : focus ? ' · ' + focus.city + '站进行中' : '')),
      scroller);
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
    return h('section', {'aria-label': stations.length + ' 站赛历'}, h('h2', {class: 'section-title', text: '全部分站'}), grid);
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
    return h('nav', {class: 'st-nav', 'aria-label': '赛事切换'}, h('a', {class: 'back', href: '/events/'}, icon('back'), '全部赛事'), list);
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
        h('p', {}, officialPage(cal, station))));
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
      box.hidden = !entries.some(isChina);
      if (!r) {
        fill(box, icon('star', 'ico star-ico'), h('span', {}, h('b', {text: 'CHN'}), ' 已确认的场次均已开赛'));
        return;
      }
      const hs = r.china.heats;
      // The card above already names the next round; repeat it only when CHN races later.
      const sameRound = r === entries.find(x => x.t > now());
      const firstEstimate = hs[0]?.estimate?.earliest_beijing;
      fill(box, icon('star', 'ico star-ico'), h('span', {}, h('b', {text: sameRound ? 'CHN ' : 'CHN 下一场 '}),
        phrases(sameRound ? null : eventName(r) + ' ' + roundName(r), '第 ' + hs.map(x => x.number).join('、') + ' 组',
          firstEstimate ? '约 ' + firstEstimate.slice(11, 16) + ' 出场' : null)));
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
      h('p', {}, (bjFirst ? '北京时间 ' : station.city + '时间 '),
        h('span', {class: 'nowrap'}, dayPart(t0) + ' ', h('span', {class: 'num', text: t0}), ' – ' + dayPart(t1) + ' ', h('span', {class: 'num', text: t1})),
        '\u00a0· ', h('span', {class: 'nowrap', text: items.length + ' 轮'}),
        h('span', {class: 'faint'}, '\u00a0· ', h('span', {class: 'nowrap', text: bjFirst ? '当地 ' + md(d.local) + ' ' + wk(d.local) : '北京 ' + md(d.bj) + ' ' + wk(d.bj)}))),
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
    cell(labels[4], 'round-cell', h('span', {class: 'round-name', text: roundName(r)}), ' ', stageMeter(r),
      r.qualification ? h('abbr', {class: 'qual num', title: r.qualification.zh, text: r.qualification.code}) : null);
    cell(labels[5], 'group-cell' + (r.group ? '' : ' is-empty'),
      r.group ? h('span', {class: 'grp grp-' + r.group}, r.group === 'A' ? icon('medal', 'ico ico-xs') : null, r.group + ' 组',
        h('small', {text: r.group === 'A' ? '奖牌' : '排位'})) : '—');
    const heats = officialHeats.get(r.round_key) || [];
    const note = cell(labels[6], 'notes-cell tiny' + (china || heats.length ? '' : ' is-empty'));
    if (china) {
      for (const heat of r.china.heats) {
        const e = heat.estimate;
        const from = e ? (bjFirst ? e.earliest_beijing : e.earliest_local).slice(11, 16) : null;
        const to = e ? (bjFirst ? e.latest_beijing : e.latest_local).slice(11, 16) : null;
        // "约" marks the model estimate; official start times carry no prefix.
        note.append(h('p', {class: 'heat'},
          h('span', {class: 'heat-no', text: '第 ' + heat.number + ' 组'}),
          // A relay lists its skaters only once raced; before that the team name says nothing new.
          h('span', {class: 'athletes'}, r.format === 'relay' && heat.athletes.length < 2 ? null
            : heat.athletes.flatMap((a, i) => [i ? '、' : null, h('span', {class: 'nowrap', text: a})])),
          e ? h('span', {class: 'est num', title: '按组号估算的出场时间，非官方', text: '约 ' + (from === to ? from : from + '–' + to)}) : null));
      }
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
      // A finished round folds to one line on small screens, where the verb is dropped.
      h('span', {}, h('span', {class: 'co-verb', text: '查看'}), heats.some(x => x.evidence === 'official_results') ? '成绩' : '分组'),
      icon('arrow', 'ico ico-xs')));
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
    let nowShown = false;
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
          if (m >= lo && m <= hi) { track.append(h('i', {class: 'rb-now', style: {left: x(m)}})); nowShown = true; }
        }
      }
      const date = bjFirst ? d.bj : d.local;
      return h('div', {class: cls('rb-lane', !active && 'is-dim')},
        h('div', {class: 'rb-day'}, h('b', {}, wk(date) + ' ', h('span', {class: 'num', text: md(date)})),
          h('small', {}, d.items.length + ' 轮', d.medals ? h('em', {class: 'gold-text', text: ' · ' + d.medals + ' 金'}) : null)),
        track);
    });
    return h('div', {class: 'panel ribbon'},
      h('div', {class: 'panel-head'}, h('h2', {text: (['一', '两', '三', '四', '五', '六', '七'][days.length - 1] || days.length) + '天赛程一览'}),
        h('p', {text: (bjFirst ? '北京时间' : station.city + '时间') + ' · 点击刻度跳到对应比赛'})),
      h('div', {class: 'rb-body', 'aria-hidden': 'true'}, lanes, h('div', {class: 'rb-axis-row'}, h('span'), axis)),
      h('p', {class: 'rb-legend'}, h('span', {class: 'lg lg-gold', text: 'A 组决赛'}),
        h('span', {class: 'lg lg-plain', text: '其他轮次'}), h('span', {class: 'lg lg-red', text: 'CHN'}),
        nowShown ? h('span', {class: 'lg lg-now', text: '现在'}) : null));
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
  // What a published result meant for a Chinese skater or team: a final's place or medal, else where the round led.
  const STEPS = ['advanced', 'final_b', 'repechage', 'out'];
  const STEP = {advanced: '晋级', final_b: '进B组决赛', repechage: '进复活赛', out: '未晋级'};
  const PENALTY = {PEN: '犯规', YC: '黄牌', DNF: '未完赛', DNS: '未出发', DQ: '取消成绩'};
  function outcome(e, s) {
    const pen = s.penalty ? PENALTY[s.penalty] || s.penalty : '';
    if (e.round !== 'final') return (STEP[s.status] || '') + (s.status === 'out' && pen ? '（' + pen + '）' : '');
    if (s.rank == null) return pen || '无名次';
    if (e.group === 'A' && s.rank <= 3) return MEDAL[s.rank] + '牌';
    return (e.group && e.group !== 'A' ? e.group + '组' : '') + '第 ' + s.rank + ' 名';
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
        const sub = podium.map(p => h('span', {class: cls('upd-medal', p.country === 'CHN' && 'is-chn'), text: MEDAL[p.rank] + ' ' + p.name + ' ' + p.country}));
        const ours = e.china_results;
        if (!ours) {  // announced before outcomes were recorded
          return {text: roundOf(e) + ' 成绩已公布' + (champ ? ' · 冠军 ' + champ.name : chinaNote),
            gold: podium.length > 0, chn: podium.some(p => p.country === 'CHN') || (!podium.length && china > 0), sub};
        }
        let note = champ ? ' · 冠军 ' + champ.name : '';
        if (ours.length && (e.round === 'final' || ours.length === 1)) {
          note = ' · ' + (e.format === 'relay' ? '中国队' + outcome(e, ours[0])
            : ours.map(s => s.name + ' ' + outcome(e, s)).join('、'));
        } else if (ours.length) {
          const by = STEPS.map(k => [k, ours.filter(s => s.status === k)]).filter(([, v]) => v.length);
          note = ' · 中国队 ' + by.map(([k, v]) => v.length + ' 人' + STEP[k]).join('，');
          sub.push(h('span', {class: 'is-chn', text: by.map(([k, v]) => STEP[k] + '：' + v.map(s => s.name).join('、')).join(' · ')}));
        }
        return {text: roundOf(e) + ' 成绩已公布' + note, gold: podium.length > 0,
          chn: ours.length > 0 || podium.some(p => p.country === 'CHN'), sub};
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
    const route = window.SSTS.navigation.resolve(location);
    window.SSTS.navigation.render(h, icon, route);
    document.body.dataset.page = route.page;
    const updates = ['events', 'event'].includes(route.page)
      ? fetchData('updates.json').catch(() => null) : Promise.resolve(null);
    const calendar = await fetchData('calendar.json');
    calendarSeason = calendar.season;
    const requested = route.page === 'event' ? route.event : null;
    const detailFor = st => st.detail_status === 'verified'
      ? fetchData(st.id + '.json').then(prepare).catch(() => null) : Promise.resolve(null);
    const context = {h, icon, external, root, fetchData, now, stationHref, nextCard, ticketPanel, stationWindow, phase};
    const unavailable = () => root.replaceChildren(h('section', {class: 'panel empty-state'},
      h('h1', {text: '页面尚未收录'}), h('p', {class: 'faint', text: '可以从赛事页查看已收录的比赛。'}),
      h('a', {class: 'btn', href: '/events/'}, '查看赛事')));
    setClocks([['北京时间', BJ]]);
    if (route.page === 'home') {
      document.title = '短道速滑';
      const focus = calendar.stations.find(st => phase(stationWindow(st, null)) === 'live') ||
        calendar.stations.find(st => phase(stationWindow(st, null)) === 'upcoming');
      const detail = focus ? await detailFor(focus) : null;
      await window.SSTS.portal.home(context, calendar, focus && detail ? {[focus.id]: detail} : {});
    } else if (route.page === 'events') {
      document.title = calendar.season + ' 赛事｜短道速滑';
      const loaded = await Promise.all(calendar.stations.map(detailFor));
      const details = {};
      calendar.stations.forEach((st, i) => { if (loaded[i]) details[st.id] = loaded[i]; });
      renderSeason(calendar, details);
    } else if (route.page === 'results') {
      document.title = '成绩｜短道速滑';
      await window.SSTS.results.render(context, calendar, route);
    } else if (route.page === 'athletes') {
      document.title = '运动员｜短道速滑';
      await window.SSTS.portal.athletes(context, calendar);
    } else if (route.page === 'event' && (!route.season || route.season === calendar.season.replace('/', '-'))) {
      const championship = (calendar.championships || []).find(st => st.id === requested);
      const station = calendar.stations.find(st => st.id === requested);
      if (championship) {
        document.title = championship.title + '｜' + championship.date_start.slice(0, 4) + ' 短道速滑赛程';
        renderChampionship(calendar, championship);
      } else if (station) {
        document.title = station.city + '站赛程｜' + calendar.season + ' 短道速滑世界巡回赛';
        const details = station.detail_status === 'verified' ? prepare(await fetchData(station.id + '.json')) : null;
        renderStation(calendar, station, details);
      } else unavailable();
    } else unavailable();
    // Offline, the service worker serves the last saved copy; say so instead of looking live.
    const offline = h('p', {class: 'offline-note', role: 'status', hidden: navigator.onLine !== false},
      h('span', {class: 'upd-dot', 'aria-hidden': 'true'}), '当前离线，显示的是上次联网时保存的赛程');
    root.prepend(offline);
    addEventListener('online', () => { offline.hidden = true; });
    addEventListener('offline', () => { offline.hidden = false; });
    // Installable app with offline fallback; jsdom and plain-http previews skip it.
    if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js', {scope: '/'}).catch(() => {});
    updates.then(feed => { const bar = feed && updatesBar(feed, calendar.stations, requested); if (bar) offline.after(bar); });
    // Back-to-top for long phone lists.
    const top = h('button', {type: 'button', class: 'to-top', 'aria-label': '回到顶部',
      onclick: () => scrollTo({top: 0, behavior: reduceMotion ? 'auto' : 'smooth'})}, icon('up'));
    document.body.append(top);
    addEventListener('scroll', () => top.classList.toggle('show', scrollY > innerHeight * 1.2), {passive: true});
  } catch (e) {
    root.replaceChildren(h('div', {class: 'panel error'}, icon('alert'),
      h('p', {text: '页面暂时无法加载，请重试。'}),
      h('button', {type: 'button', class: 'btn', onclick: () => location.reload()}, '重新加载'),
      h('a', {class: 'btn', href: '/'}, '返回首页')));
  } finally {
    root.removeAttribute('aria-busy');
    // Let the launch lap show for a moment, then fade it and restore the theme's status bar colour.
    if (document.documentElement.classList.contains('launching')) setTimeout(() => {
      document.documentElement.classList.add('launched');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = document.documentElement.dataset.theme === 'light' ? '#F3F8FC' : '#070B12';
    }, Math.max(0, 700 - performance.now()));
  }
})();
