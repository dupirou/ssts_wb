import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [html, script, snapshot, schedule, predictions, calendar] = await Promise.all([
  file('web/index.html'), file('web/app.js'), file('data/competitions/vancouver.json').then(JSON.parse),
  file('dist/data/vancouver.json').then(JSON.parse),
  file('dist/data/predictions/vancouver.json').then(JSON.parse),
  file('dist/data/calendar.json').then(JSON.parse),
]);
// The prediction tab exists while a station still has first rounds without official groups.
const withPredictions = {...calendar, stations: calendar.stations.map(s => ({...s, predictions: s.id === 'vancouver'}))};
async function settle(dom, predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('UI did not reach expected state: ' + dom.window.document.body.textContent.slice(-700));
}
async function page({data = snapshot, fails = () => false, view = 'athletes', delay = async () => {}, url = 'https://example.test/?station=vancouver', files = {'/data/calendar.json': withPredictions}, before = () => {}} = {}) {
  const dom = new JSDOM(html, {url, runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window;
  w.matchMedia = () => ({matches:false, addEventListener(){}});
  dom.requests = [];
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.fetch = async input => {
    const url = new URL(input, w.location.href);
    dom.requests.push(url.pathname);
    await delay(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      const resource = url.pathname.split('/').at(-1);
      if (fails(resource)) return new Response('unavailable',{status:503});
      if (resource === 'predictions') return Response.json(data.predictions || predictions);
      return Response.json({schema_version:1,event_id:'vancouver',resource,total:data[resource].items.length,...data[resource]});
    }
    if (files[url.pathname]) return Response.json(files[url.pathname]);
    return new Response(await file('dist' + url.pathname));
  };
  w.HTMLDialogElement.prototype.showModal = function() {this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close = function() {this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  before(w);
  w.eval(script);
  await settle(dom, () => w.document.querySelector('#tab-schedule'));
  if (view !== 'schedule') {
    w.document.getElementById('tab-' + view).click();
    await settle(dom, () => w.document.querySelector('#section-' + view + ' .athlete-panel,#section-' + view + ' .athlete-load-error'));
  }
  await settle(dom, () => dom.requests.some(p=>p.endsWith('/rounds')) && !w.document.querySelector('[data-resource=rounds][aria-busy]'));
  return dom;
}
const change = (dom, el, value) => {el.value=value;el.dispatchEvent(new dom.window.Event('change'));};

test('CHN rows list each heat once with an approximate time and open the official groups', async t => {
  const dom = await page({view:'schedule'});t.after(()=>dom.window.close());
  const d = dom.window.document;
  const row = d.querySelector('.match-row.china-row');
  assert.ok(row);
  const heat = row.querySelector('.notes-cell .heat');
  assert.match(heat.querySelector('.heat-no').textContent, /^第 \d+ 组$/);
  assert.match(heat.querySelector('.est').textContent, /^约 \d\d:\d\d/);
  assert.equal(row.querySelectorAll('.notes-cell a').length, 0);
  await settle(dom, () => row.querySelector('.competition-open'));
  row.querySelector('.competition-open').click();
  const dialog = d.querySelector('dialog[open]');
  assert.doesNotMatch(dialog.textContent, /出发位 \d|已列入分组/);
  // Groups carry no '分组' tag; once racing starts a heat may show its result status, and only that.
  for (const pill of dialog.querySelectorAll('.competition-heat-head .pill')) assert.match(pill.textContent, /^(暂定|正式)成绩$/);
  assert.equal(dialog.querySelectorAll('.source-line a').length, 1);
});

test('round meter has one dot per round the event actually races', async t => {
  const dom = await page({view:'schedule'});t.after(()=>dom.window.close());
  const d = dom.window.document;
  const meter = id => [...d.getElementById('r-' + id).querySelectorAll('.meter i')].map(i => i.className || '-').join(' ');
  const rows = [...d.querySelectorAll('.match-row')];
  const find = (text, round) => rows.find(r => r.querySelector('.event-cell').textContent.includes(text) && r.querySelector('.round-name').textContent === round).id.slice(2);
  // Women's 1500m starts at the quarter-finals: three dots, the first one lit.
  assert.equal(meter(find('女子 1500m', '1/4决赛')), 'on - -');
  // Men's 1500m has no preliminaries: heats are the first of four.
  assert.equal(meter(find('男子 1500m', '预赛')), 'on - - -');
  assert.equal(meter(find('男子 500m', '初赛')), 'on - - - -');
});

test('real roster defaults to CHN; country and gender filters compose', async t => {
  const dom = await page();t.after(()=>dom.window.close());
  const d = dom.window.document;
  const roster = d.querySelector('.athlete-panel');
  const china = snapshot.entries.items.filter(p=>p.country==='CHN');
  assert.ok(roster.querySelector('summary').textContent.includes(snapshot.entries.items.length+' 人'));
  assert.ok(roster.querySelector('summary').textContent.includes('CHN '+china.length+' 人'));
  assert.equal(roster.open,true);
  assert.equal(roster.querySelectorAll('.athlete-card').length,china.length);
  assert.doesNotMatch(roster.querySelector('.athlete-source').textContent,/核对于/);
  assert.match(roster.querySelector('.athlete-source').textContent,/更新于/);
  const country = roster.querySelector('select[aria-label="报名名单国家或地区"]');
  const sex = roster.querySelector('select[aria-label="报名名单性别"]');
  change(dom,country,'all');
  assert.equal(roster.querySelectorAll('.athlete-card').length,snapshot.entries.items.length);
  assert.match(roster.textContent,/替补/);
  change(dom,sex,'women');
  assert.equal(roster.querySelectorAll('.athlete-card').length,snapshot.entries.items.filter(p=>p.gender==='women').length);
  change(dom,country,'CHN');
  assert.equal(roster.querySelectorAll('.athlete-card').length,china.filter(p=>p.gender==='women').length);
  assert.equal(d.querySelectorAll('.match-row').length,61);
});
test('roster cards list the distances each athlete entered', async t => {
  const data=structuredClone(snapshot);
  const chn=data.entries.items.find(p=>p.country==='CHN');
  chn.distances=[500,1000];
  const dom=await page({data});t.after(()=>dom.window.close());
  const card=[...dom.window.document.querySelectorAll('.athlete-card')].find(c=>c.textContent.includes(chn.name));
  assert.equal(card.querySelector('.athlete-name .athlete-events').textContent,(chn.gender==='men'?'男子':'女子')+' · 500/1000m');
});

test('not-published data stays empty and never fabricates heat buttons', async t => {
  const data=structuredClone(snapshot);
  for (const kind of ['entries','rounds','rankings']) data[kind]={...data[kind],items:[],status:'not_published'};
  const dom=await page({data});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.match(d.querySelector('.athlete-panel').textContent,/待公布/);
  assert.equal(d.querySelectorAll('.athlete-card,.competition-open').length,0);
  assert.equal(d.querySelectorAll('.match-row').length,61);
});
test('source failure preserves schedule and successful roster, retry restores details', async t => {
  let fail=true;
  const dom=await page({fails:kind=>kind==='rounds'&&fail});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.equal(d.querySelectorAll('.match-row').length,61);
  assert.equal(d.querySelectorAll('.athlete-card').length,snapshot.entries.items.filter(p=>p.country==='CHN').length);
  assert.ok(d.querySelector('.athlete-load-error'));
  fail=false;
  d.querySelector('.athlete-load-error button').click();
  await settle(dom,()=>!d.querySelector('.athlete-load-error')&&!d.querySelector('[data-resource=rounds][aria-busy]'));
  assert.equal(d.querySelectorAll('.match-row').length,61);
});
test('official heat opens participant results and penalties without HTML injection', async t => {
  const data=structuredClone(snapshot);
  data.rounds.items=[{id:'TEST-HEAT',round_key:schedule.entries[0].round_key,heat_number:1,
    evidence:'official_results',result_status:'Official',source_url:'https://isu-skating.com/official',
    participants:[{name:'TEST CHN',country:'CHN',rank:1,result:'43.001',qualification:'Q',penalty:null},
      {name:'<img src=x onerror=alert(1)>',country:'HKG',rank:null,result:'PEN',penalty:{code:'PEN',infringement_code:null}}]}];
  data.rankings.items=[{id:'TEST-RANK',name:'TEST CHN',country:'CHN',gender:'women',distance_m:500,rank:1,ranking_type:'event',points:100}];
  const dom=await page({data});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.equal(d.querySelectorAll('.competition-open').length,1);
  d.querySelector('.competition-open').click();
  const dialog=d.querySelector('dialog[open]');
  assert.ok(dialog);
  assert.equal(dialog.querySelectorAll('.result-person').length,2);
  assert.equal(dialog.querySelectorAll('.result-person.is-china').length,1);
  assert.match(dialog.textContent,/PEN 判罚/);
  assert.match(dialog.textContent,/晋级/);
  assert.equal(dialog.querySelector('img'),null);
  d.querySelector('[data-resource=rankings] details').open=true;
  await settle(dom,()=>d.querySelector('[data-resource=rankings] .athlete-card'));
  assert.ok([...d.querySelectorAll('.athlete-panel')].some(p=>p.textContent.includes('单站排名')));
  dialog.querySelector('[aria-label="关闭比赛详情"]').click();
  assert.equal(d.querySelector('dialog'),null);
});

test('prediction waits for distance entries, exposes rules and leaves official highlights untouched', async t => {
  const data=structuredClone(snapshot);
  data.predictions=structuredClone(predictions);
  data.predictions.items.forEach(p=>Object.assign(p,{status:'waiting_for_data',missing:['distance_entries'],
    source_urls:[],groups:[],unseeded:[],prequalified:[]}));
  const dom=await page({data,view:'predictions'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  const panel=d.querySelector('.prediction-panel');
  assert.ok(panel);
  assert.equal(panel.open,true);
  assert.match(panel.textContent,/非官方/);
  assert.match(panel.textContent,/单项报名待公布/);
  assert.equal(panel.querySelector('button[aria-pressed]').hidden,true);
  assert.equal(panel.querySelectorAll('a').length,3);
  assert.equal(panel.querySelector('.source-disclosure').open,false);
  assert.match(panel.querySelector('.source-disclosure summary').textContent,/来源与规则/);
  assert.equal(panel.querySelectorAll('.prediction-group').length,0);
  change(dom,panel.querySelector('select'),'men-1500');
  assert.match(panel.textContent,/单项报名待公布/);
  assert.equal(d.querySelectorAll('.match-row.is-chn').length,0);
});

test('stations without distance entries have no prediction tab', async t => {
  const dom=await page({url:'https://example.test/?station=montreal&view=predictions',view:'schedule'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.deepEqual([...d.querySelectorAll('[role="tab"]')].map(b=>b.textContent),['赛程','运动员']);
  assert.equal(d.querySelector('#tab-schedule').getAttribute('aria-selected'),'true');
});

test('projection places known seeds, counts the rest, filters CHN and yields to official groups', async t => {
  const data=structuredClone(snapshot);
  data.predictions=structuredClone(predictions);
  Object.assign(data.predictions.items[0],{status:'predicted',missing:[],prequalified:[{name:'TEST BYE',country:'CHN'}],
    groups:[{heat_number:1,size:3,has_china:true,participants:[{seed_rank:1,name:'TEST CHN',country:'CHN'}]},
      {heat_number:2,size:2,has_china:false,participants:[{seed_rank:2,name:'TEST KOR',country:'KOR'},{seed_rank:3,name:'TEST NED',country:'NED'}]}],
    unseeded:[{name:'NEW CHN',country:'CHN'},{name:'NEW USA',country:'USA'}]});
  data.predictions.items[1].status='official_available';
  const dom=await page({data,view:'predictions'});t.after(()=>dom.window.close());
  const d=dom.window.document,panel=d.querySelector('.prediction-panel');
  const groups=panel.querySelectorAll('.prediction-group');
  assert.equal(groups.length,2);
  assert.match(groups[0].querySelector('h3').textContent,/第 1 组3 人/);
  assert.match(groups[0].textContent,/另 2 人待定/);
  assert.doesNotMatch(groups[1].textContent,/待定/);
  const rest=panel.querySelector('.prediction-byes');
  assert.match(rest.querySelector('summary').textContent,/其余 2 人待定\u00a0· CHN 1 人/);
  assert.equal(rest.open,false);
  assert.doesNotMatch(panel.textContent,/暂估|模拟抽签|首轮预测|个项目可查看/);
  assert.match(panel.textContent,/直通下一轮/);
  panel.querySelector('button').click();
  assert.equal(panel.querySelectorAll('.prediction-group').length,1);
  assert.equal(panel.querySelectorAll('.prediction-group .athlete-china').length,1);
  const filtered=panel.querySelector('.prediction-byes');
  assert.equal(filtered.open,true);
  assert.equal(filtered.querySelectorAll('li').length,1);
  const officialKeys = new Set(data.rounds.items.map(h => h.round_key));
  assert.equal(d.querySelectorAll('.competition-open').length, schedule.entries.filter(r => officialKeys.has(r.round_key)).length);
  change(dom,panel.querySelector('select'),'women-1000');
  assert.equal(panel.querySelectorAll('.prediction-group').length,0);
  assert.match(panel.textContent,/官方分组已公布/);
});

test('schedule first: one API, no roster/prediction or overview work until requested', async t => {
  const dom=await page({view:'schedule'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.deepEqual(dom.requests.filter(p=>p.startsWith('/api/')),['/api/v1/events/vancouver/rounds']);
  assert.deepEqual(dom.requests.filter(p=>p.startsWith('/data/')).sort(),['/data/calendar.json','/data/updates.json','/data/vancouver.json']);
  assert.equal(d.querySelectorAll('.athlete-card,.prediction-panel,.rb-body').length,0);
  assert.equal(d.querySelectorAll('.match-row').length,61);
  const first=d.querySelector('.match-row');
  d.getElementById('tab-athletes').click();
  await settle(dom,()=>d.querySelector('.athlete-card'));
  const country=d.querySelector('select[aria-label="报名名单国家或地区"]');
  change(dom,country,'HKG');
  d.getElementById('tab-schedule').click();
  d.getElementById('tab-athletes').click();
  assert.equal(d.querySelector('select[aria-label="报名名单国家或地区"]'),country);
  assert.equal(country.value,'HKG');
  assert.equal(d.querySelector('.match-row'),first,'API responses must not rebuild schedule rows');
  assert.equal(dom.requests.filter(p=>p.endsWith('/entries')).length,1);
  assert.equal(dom.requests.filter(p=>p.endsWith('/rankings')).length,1);
  assert.equal(dom.requests.filter(p=>p.endsWith('/predictions')).length,0);
  d.getElementById('tab-predictions').click();
  await settle(dom,()=>d.querySelector('.prediction-panel'));
  assert.equal(dom.requests.filter(p=>p.endsWith('/predictions')).length,1);
  assert.equal(d.getElementById('section-schedule').hidden,true);
  assert.equal(d.getElementById('section-predictions').hidden,false);
});

test('slow rankings do not block entries; rapid tab changes deduplicate in-flight requests', async t => {
  let release;
  const hold=new Promise(resolve=>{release=resolve;});
  const dom=await page({view:'schedule',delay:path=>path.endsWith('/rankings')?hold:undefined});
  t.after(()=>dom.window.close());
  const d=dom.window.document;
  d.getElementById('tab-athletes').click();
  d.getElementById('tab-schedule').click();
  d.getElementById('tab-athletes').click();
  await settle(dom,()=>d.querySelector('.athlete-card'));
  assert.equal(d.querySelector('[data-resource=rankings]').getAttribute('aria-busy'),'true');
  assert.equal(dom.requests.filter(p=>p.endsWith('/rankings')).length,1);
  assert.equal(dom.requests.filter(p=>p.endsWith('/entries')).length,1);
  release();
  await settle(dom,()=>!d.querySelector('[data-resource=rankings][aria-busy]'));
});

test('retry only fetches failed resource and keeps successful roster filters', async t => {
  let fail=true;
  const dom=await page({fails:kind=>kind==='rankings'&&fail});t.after(()=>dom.window.close());
  const d=dom.window.document;
  await settle(dom,()=>d.querySelector('[data-resource=rankings] .athlete-load-error'));
  const country=d.querySelector('select[aria-label="报名名单国家或地区"]');
  change(dom,country,'HKG');
  fail=false;
  d.querySelector('[data-resource=rankings] button').click();
  await settle(dom,()=>!d.querySelector('[data-resource=rankings][aria-busy]'));
  assert.equal(country.value,'HKG');
  assert.equal(dom.requests.filter(p=>p.endsWith('/entries')).length,1);
  assert.equal(dom.requests.filter(p=>p.endsWith('/rankings')).length,2);
});

test('day, timezone and overview work after navigating between content tabs', async t => {
  const dom=await page({view:'schedule'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  d.querySelectorAll('.fb-day')[1].click();
  assert.equal(d.querySelectorAll('.match-row').length,13);
  const row=d.querySelector('.match-row');
  const bj=row.querySelector('.primary-time .tm').textContent;
  d.querySelectorAll('.fb-zone button')[1].click();
  assert.notEqual(d.querySelector('.primary-time .tm').textContent,bj);
  d.getElementById('tab-athletes').click();
  await settle(dom,()=>d.querySelector('.athlete-card'));
  d.getElementById('tab-schedule').click();
  assert.equal(d.querySelectorAll('.match-row').length,13);
  assert.equal(d.querySelectorAll('.fb-zone button')[1].getAttribute('aria-pressed'),'true');
  const overview=d.querySelector('.schedule-overview');
  overview.open=true;
  await settle(dom,()=>d.querySelector('.rb-body'));
  assert.equal(d.querySelectorAll('.finals-list button').length,9);
  d.querySelector('.finals-list button').click();
  assert.equal(d.querySelectorAll('.match-row').length,61,'jump clears a day filter hiding the target');
});

test('tab keyboard navigation and prediction URL survive reload', async t => {
  const dom=await page({view:'schedule',url:'https://example.test/?station=vancouver&view=predictions'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  await settle(dom,()=>d.querySelector('.prediction-panel'));
  const tab=d.getElementById('tab-predictions');
  assert.equal(tab.getAttribute('aria-selected'),'true');
  tab.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
  assert.equal(d.activeElement.id,'tab-schedule');
  assert.equal(d.getElementById('section-schedule').hidden,false);
  assert.equal(new URL(dom.window.location.href).searchParams.has('view'),false);
});

test('expired data refreshes while retaining country and gender selections', async t => {
  const data=structuredClone(snapshot);
  const dom=await page({data});t.after(()=>dom.window.close());
  const d=dom.window.document;
  change(dom,d.querySelector('[aria-label="报名名单国家或地区"]'),'HKG');
  change(dom,d.querySelector('[aria-label="报名名单性别"]'),'women');
  d.getElementById('tab-schedule').click();
  data.entries.items.push({athlete_id:'TEST-FRESH',name:'UPDATED ATHLETE',country:'HKG',gender:'women'});
  const realNow=dom.window.Date.now.bind(dom.window.Date);
  dom.window.Date.now=()=>realNow()+61000;
  d.getElementById('tab-athletes').click();
  await settle(dom,()=>!d.querySelector('[data-resource=entries][aria-busy]'));
  assert.equal(dom.requests.filter(p=>p.endsWith('/entries')).length,2);
  assert.equal(d.querySelector('[aria-label="报名名单国家或地区"]').value,'HKG');
  assert.equal(d.querySelector('[aria-label="报名名单性别"]').value,'women');
  assert.match(d.querySelector('[data-resource=entries]').textContent,/UPDATED ATHLETE/);
});

test('what\'s new bar: newest first, results supersede groups, closing remembers the newest notice', async t => {
  const base = {station:'vancouver', local_date:'2026-10-24', repechage:false, gender:'women', distance_m:500, format:'individual'};
  const events = [
    {...base, id:'r', kind:'results', at:'2026-10-24T17:40:00+00:00', round:'final', group:'A', china:['<img src=x onerror=alert(1)>'],
     podium:[{rank:1, name:'<img src=x onerror=alert(1)>', country:'CHN'}, {rank:2, name:'Kim BOUTIN', country:'CAN'}]},
    {...base, id:'g', kind:'groups', at:'2026-10-24T14:00:00+00:00', round:'final', group:'A', heats:1, china:[]},
    {...base, id:'t', kind:'time_change', at:'2026-10-24T12:00:00+00:00', round:'semifinal', group:null,
     previous:'2026-10-25 01:40', current:'2026-10-25 02:05'},
    {id:'e', station:'vancouver', kind:'entries', at:'2026-10-10T00:00:00+00:00', count:189},
    {id:'future', station:'vancouver', kind:'rankings', at:'2026-10-26T00:00:00+00:00'},
  ];
  const dom = await page({view:'schedule', url:'https://example.test/?station=vancouver&now=2026-10-24T18:00:00Z',
    files:{'/data/updates.json':{schema_version:1, events}}});
  t.after(()=>dom.window.close());
  const d = dom.window.document;
  await settle(dom, () => d.querySelector('.updates'));
  const items = [...d.querySelectorAll('.upd-list li')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /女子 500m A组决赛 成绩已公布 · 冠军 <img/);
  assert.ok(items[0].classList.contains('is-chn'));
  assert.equal(d.querySelector('.upd-list img'), null);
  assert.match(items[1].textContent, /半决赛 时间调整北京时间 01:40 → 10\/25 周日 凌晨 02:05/);
  assert.equal(items[0].querySelector('a').getAttribute('href'), '?station=vancouver&day=2026-10-24');
  assert.ok(!d.querySelector('.upd-text b'), 'station name is not repeated on its own page');
  const head = d.querySelector('.upd-head');
  assert.equal(d.querySelector('.upd-list').hidden, true);
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(d.querySelector('.upd-list').hidden, false);
  d.querySelector('.upd-close').click();
  assert.equal(d.querySelector('.updates'), null);
  assert.equal(Number(dom.window.localStorage.getItem('ssts.updates.seen')), Date.parse(events[0].at));
});

test('what\'s new bar stays hidden when everything was already seen', async t => {
  const dom = await page({view:'schedule', url:'https://example.test/?station=vancouver&now=2026-10-24T18:00:00Z',
    before: w => w.localStorage.setItem('ssts.updates.seen', String(Date.parse('2026-10-24T17:00:00Z'))),
    files:{'/data/updates.json':{schema_version:1, events:[{id:'a', station:'vancouver', kind:'rankings', at:'2026-10-24T16:00:00+00:00'}]}}});
  t.after(()=>dom.window.close());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(dom.window.document.querySelector('.updates'), null);
});

test('what\'s new bar announces another station\'s newly published programme with a link to its first day', async t => {
  const dom = await page({view:'schedule', url:'https://example.test/?station=vancouver&now=2026-10-24T18:00:00Z',
    files:{'/data/updates.json':{schema_version:1, events:[
      {id:'s', station:'montreal', kind:'schedule', at:'2026-10-24T17:00:00+00:00', local_date:'2026-10-30', count:62}]}}});
  t.after(()=>dom.window.close());
  const d = dom.window.document;
  await settle(dom, () => d.querySelector('.updates'));
  const item = d.querySelector('.upd-list li');
  assert.match(item.textContent, /^蒙特利尔站 详细赛程已公布 · 共 62 轮/);
  assert.equal(item.querySelector('a').getAttribute('href'), '?station=montreal&day=2026-10-30');
});
