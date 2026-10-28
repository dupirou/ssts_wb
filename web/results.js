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
