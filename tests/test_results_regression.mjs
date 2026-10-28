import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import '../web/results-model.js';
const m=globalThis.SSTS.resultsModel;
const file=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
const scripts=(await Promise.all(['ui','results-model','results-store','results'].map(name=>file('web/'+name+'.js')))).join('\n');
const data=JSON.parse(await file('dist/data/results.json'));
const index=JSON.parse(await file('dist/data/results/index.json'));
const searchIndex=JSON.parse(await file('dist/data/results/search.json'));
for(const event of index.events)event.search_rows=searchIndex.events.find(e=>e.id===event.id).search_rows;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const people={alice:{id:'alice',name:'Alice LI',aliases:['LI Alice','李甲']},bob:{id:'bob',name:'Bob WU',aliases:['WU Bob','吴乙']}};
const row=(id='alice',extra={})=>({athlete_id:id,name:people[id].name,format:'individual',gender:'women',distance_m:500,rank:1,rank_scope:'overall',status:'classified',final_group:'A',...extra});
const event=(id,rows,season='2024/25')=>({id,title:id,season,kind:'worlds',date_end:'2025-03-10',coverage:'complete',source:{url:'https://isu.org/'},results:rows});
function catalog(events){
  return {schema_version:2,search_version:1,current_season:'2025/26',athletes:Object.values(people),pending:[],inventory:[],
    cycles:[{id:'milano-2026',label:'米兰周期',seasons:['2022/23','2023/24','2024/25','2025/26']}],
    events:events.map(({results,...e})=>({...e,detail_file:e.id,record_count:results.length,search_rows:m.resultSearchRows(results,people),summary:m.summarize({...e,results})}))};
}
async function fixture(path,events,view='compare'){
  const dom=new JSDOM('<main id="app"></main>',{url:'https://example.test'+path,runScripts:'outside-only'});
  const w=dom.window;w.eval(scripts);
  const byId=new Map(events.map(e=>[e.id,e]));
  const requests=[];
  const store={getIndex:async()=>catalog(events),ensureStats:async()=>{},ensureSearch:async()=>{},getEvents:items=>{
    const request={ids:items.map(e=>e.id)};requests.push(request);
    if(!store.deferred)return Promise.resolve(items.map(e=>byId.get(e.id)));
    return new Promise((resolve,reject)=>{request.resolve=()=>resolve(items.map(e=>byId.get(e.id)));request.reject=reject;});
  }};
  const h=w.SSTS.ui.h;
  const ctx={h,root:w.document.querySelector('#app'),resultsStore:store,external:(href,text)=>h('a',{href,text})};
  await w.SSTS.results.render(ctx,{season:'2025/26'},{view});
  return {dom,w,d:w.document,store,requests};
}
const raceEvents=()=>[...Array.from({length:10},(_,i)=>event('left-'+i,[row()])),event('right-0',[row('bob')],'2025/26')];
const open=f=>f.d.querySelector('.project-toggle').click();
const leftRequests=f=>f.requests.filter(r=>r.ids[0]?.startsWith('left-'));
const rightRequests=f=>f.requests.filter(r=>r.ids[0]?.startsWith('right-'));

test('Chinese/English aliases and name order use one identity, relay search uses actual members',()=>{
  const projection=m.resultSearchRow(row(),people);
  for(const athlete of ['alice li','LI Alice','ＡＬＩＣＥ　ＬＩ','李甲','李 甲'])assert.ok(m.matchesResultSearch(projection,m.resultFilter({athlete})),athlete);
  const relay=m.resultSearchRow(row('alice',{format:'relay',distance_m:3000,name:'China',members:[{athlete_id:'alice',name:'Alice LI'},{athlete_id:'bob',name:'Bob WU'}]}),people);
  for(const athlete of ['LI Alice','吴乙','WU Bob','中国队'])assert.ok(m.matchesResultSearch(relay,m.resultFilter({athlete})),athlete);
  assert.equal(m.matchesResultSearch(relay,m.resultFilter({athlete:'Alice WU'})),false,'different members must not compose a fictitious name');
  assert.equal(m.matchesResultSearch(projection,m.resultFilter({athlete:'李甲',gender:'men',distance:500})),false);
  assert.equal(m.matchesResultSearch(relay,m.resultFilter({athlete:'李甲',distance:500})),false);
});

test('every real index projection agrees with detail matching for combined filters',()=>{
  const registry=Object.fromEntries(data.athletes.map(p=>[p.id,p]));
  const originals=new Map(data.events.map(e=>[e.id,e]));
  assert.equal(index.search_version,1);
  assert.ok(index.events.every(e=>e.search_text===undefined));
  for(const e of index.events)assert.deepEqual(e.search_rows,m.resultSearchRows(originals.get(e.id).results,registry));
  for(const athlete of ['','LI Kun','Kun LI','Shaoang LIU','Li GONG','中国队','not a skater'])for(const gender of ['all','women','men','mixed'])for(const distance of ['all','500','3000','5000']){
    const filter=m.resultFilter({athlete,gender,distance});
    const expected=data.events.filter(e=>!m.hasResultFilter(filter)||e.results.some(r=>m.matchesResultSearch(m.resultSearchRow(r,registry),filter))).map(e=>e.id);
    assert.deepEqual(index.events.filter(e=>m.eventMatchesResults(e,filter)).map(e=>e.id),expected,JSON.stringify(filter));
  }
});

test('only full row matches occupy event pages; combined aliases, gender, distance, kind and page restore',async t=>{
  const events=[...Array.from({length:4},(_,i)=>event('false-'+i,[row('alice',{gender:'men'}),row('bob')])),
    ...Array.from({length:5},(_,i)=>event('match-'+i,[row()])),event('wrong-kind',[row()])];
  events.at(-1).kind='worldcup';
  const path='/history/?season=2024%2F25&kind=worlds&athlete=李甲&gender=women&distance=500';
  const f=await fixture(path,events,'event');t.after(()=>f.dom.window.close());
  assert.deepEqual([...f.d.querySelectorAll('.results-table tbody')].map(e=>e.dataset.event),['match-0','match-1','match-2','match-3']);
  assert.match(f.d.querySelector('.results-count').textContent,/1–4 \/ 5 场/);
  assert.deepEqual(f.requests.flatMap(r=>r.ids),['match-0','match-1','match-2','match-3']);
  f.d.querySelector('.results-pager button:last-child').click();await flush();
  assert.match(f.d.querySelector('.results-count').textContent,/5–5 \/ 5 场/);
  assert.deepEqual([...f.d.querySelectorAll('.results-table tbody')].map(e=>e.dataset.event),['match-4']);
  const restored=await fixture(f.w.location.pathname+f.w.location.search,events,'event');t.after(()=>restored.dom.window.close());
  assert.equal(restored.d.querySelector('.results-table tbody').dataset.event,'match-4');
  const clamped=await fixture(path+'&page=999',events,'event');t.after(()=>clamped.dom.window.close());
  assert.equal(new URL(clamped.w.location).searchParams.get('page'),'2');
});

test('no matching event differs from a selected event without matching rows, neither fetches false detail',async t=>{
  const events=[event('selected',[row('bob')])];
  const all=await fixture('/results/events/?season=all&athlete=李甲',events,'event');t.after(()=>all.dom.window.close());
  assert.match(all.d.querySelector('.results-count').textContent,/没有匹配的赛事/);
  assert.equal(all.requests.flatMap(r=>r.ids).length,0);
  const selected=await fixture('/results/events/?event=selected&athlete=李甲',events,'event');t.after(()=>selected.dom.window.close());
  assert.match(selected.d.querySelector('.results-count').textContent,/所选赛事没有符合条件的成绩/);
  assert.equal(selected.d.querySelector('.results-table tbody').dataset.event,'selected');
  assert.equal(selected.requests.flatMap(r=>r.ids).length,0);
});

test('raw groups retain controls while loading and ignore out-of-order successes and errors',async t=>{
  const f=await fixture('/results/compare/',raceEvents());t.after(()=>f.dom.window.close());f.store.deferred=true;
  open(f);leftRequests(f)[0].resolve();rightRequests(f)[0].resolve();await flush();
  const left=f.d.querySelector('.raw-records');
  left.querySelector('.raw-pager button:last-child').click();
  left.querySelector('.raw-pager button:last-child').click();
  const slow=leftRequests(f)[1],fast=leftRequests(f)[2];
  fast.resolve();await flush();
  assert.match(left.textContent,/left-6/);assert.doesNotMatch(left.textContent,/left-3/);
  slow.resolve();await flush();assert.match(left.textContent,/left-6/);assert.doesNotMatch(left.textContent,/left-3/);
  left.querySelector('.raw-pager button:first-child').click();
  left.querySelector('.raw-pager button:last-child').click();
  const old=leftRequests(f).at(-2),latest=leftRequests(f).at(-1);
  latest.resolve();await flush();old.reject(new Error('late failure'));await flush();
  assert.match(left.textContent,/left-6/);assert.equal(left.querySelector('[role="alert"]'),null);
  // Repeated next clicks stop at the last group and never create empty/negative pages.
  left.querySelector('.raw-pager button:last-child').click();
  const count=leftRequests(f).length;
  left.querySelector('.raw-pager button:last-child').click();assert.equal(leftRequests(f).length,count);
  leftRequests(f).at(-1).resolve();await flush();assert.match(left.querySelector('.raw-pager').textContent,/4 \/ 4/);
});

test('close/reopen invalidates old work; current failures retry successfully',async t=>{
  const f=await fixture('/results/compare/',raceEvents());t.after(()=>f.dom.window.close());f.store.deferred=true;
  open(f);const old=leftRequests(f)[0];const left=f.d.querySelector('.raw-records');
  open(f);const hiddenText=left.textContent;old.reject(new Error('closed failure'));await flush();assert.equal(left.textContent,hiddenText);
  open(f);const reopened=leftRequests(f).at(-1);reopened.reject(new Error('current failure'));await flush();
  assert.ok(left.querySelector('[role="alert"]'));
  [...left.querySelectorAll('button')].find(b=>b.textContent==='重试').click();leftRequests(f).at(-1).resolve();await flush();
  assert.match(left.textContent,/left-0/);assert.equal(left.querySelector('[role="alert"]'),null);
  // Resolve the first right column only after it has also been closed and reopened.
  rightRequests(f)[0].resolve();await flush();assert.match(f.d.querySelectorAll('.raw-records')[1].textContent,/正在读取/);
  rightRequests(f).at(-1).resolve();await flush();assert.match(f.d.querySelectorAll('.raw-records')[1].textContent,/right-0/);
});

test('changing comparison objects invalidates old work before the new summary resolves',async t=>{
  const f=await fixture('/results/compare/',raceEvents());t.after(()=>f.dom.window.close());f.store.deferred=true;open(f);
  const old=f.d.querySelector('.raw-records'),text=old.textContent;
  let release;f.store.ensureStats=()=>new Promise(resolve=>release=resolve);
  const select=f.d.querySelector('[name="left"]');select.value='2023/24';select.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  leftRequests(f)[0].reject(new Error('obsolete object'));await flush();assert.equal(old.textContent,text);
  release();await flush();assert.equal(old.isConnected,false);
  rightRequests(f)[0].resolve();await flush();assert.equal(old.textContent,text);
  assert.equal(f.d.querySelector('.comparison-body [role="alert"]'),null);
});
