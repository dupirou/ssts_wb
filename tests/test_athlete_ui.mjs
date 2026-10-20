import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [html, script, snapshot, schedule, predictions] = await Promise.all([
  file('web/index.html'), file('web/app.js'), file('data/competitions/vancouver.json').then(JSON.parse),
  file('dist/data/vancouver.json').then(JSON.parse),
  file('dist/data/predictions/vancouver.json').then(JSON.parse),
]);
async function settle(dom, predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('UI did not reach expected state: ' + dom.window.document.body.textContent.slice(-700));
}
async function page({data = snapshot, fails = () => false, view = 'athletes', delay = async () => {}, url = 'https://example.test/?station=vancouver'} = {}) {
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
    return new Response(await file('dist' + url.pathname));
  };
  w.HTMLDialogElement.prototype.showModal = function() {this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close = function() {this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
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

test('real roster defaults to CHN; country and gender filters compose', async t => {
  const dom = await page();t.after(()=>dom.window.close());
  const d = dom.window.document;
  const roster = d.querySelector('.athlete-panel');
  const china = snapshot.entries.items.filter(p=>p.country==='CHN');
  assert.ok(roster.querySelector('summary').textContent.includes(snapshot.entries.items.length+' 人'));
  assert.ok(roster.querySelector('summary').textContent.includes('CHN '+china.length+' 人'));
  assert.equal(roster.open,true);
  assert.equal(roster.querySelectorAll('.athlete-card').length,china.length);
  const country = roster.querySelector('select[aria-label="报名名单国家或地区"]');
  const sex = roster.querySelector('select[aria-label="报名名单性别"]');
  change(dom,country,'all');
  assert.equal(roster.querySelectorAll('.athlete-card').length,snapshot.entries.items.length);
  assert.match(roster.textContent,/替补/);
  change(dom,sex,'women');
  assert.equal(roster.querySelectorAll('.athlete-card').length,snapshot.entries.items.filter(p=>p.gender==='women').length);
  change(dom,country,'CHN');
  assert.equal(roster.querySelectorAll('.athlete-card').length,china.filter(p=>p.gender==='women').length);
  assert.equal(d.querySelectorAll('.match-row').length,62);
});
test('not-published data stays empty and never fabricates heat buttons', async t => {
  const data=structuredClone(snapshot);
  for (const kind of ['entries','rounds','rankings']) data[kind]={...data[kind],items:[],status:'not_published'};
  const dom=await page({data});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.match(d.querySelector('.athlete-panel').textContent,/待公布/);
  assert.equal(d.querySelectorAll('.athlete-card,.competition-open').length,0);
  assert.equal(d.querySelectorAll('.match-row').length,62);
});
test('source failure preserves schedule and successful roster, retry restores details', async t => {
  let fail=true;
  const dom=await page({fails:kind=>kind==='rounds'&&fail});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.equal(d.querySelectorAll('.match-row').length,62);
  assert.equal(d.querySelectorAll('.athlete-card').length,snapshot.entries.items.filter(p=>p.country==='CHN').length);
  assert.ok(d.querySelector('.athlete-load-error'));
  fail=false;
  d.querySelector('.athlete-load-error button').click();
  await settle(dom,()=>!d.querySelector('.athlete-load-error')&&!d.querySelector('[data-resource=rounds][aria-busy]'));
  assert.equal(d.querySelectorAll('.match-row').length,62);
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

test('prediction waits for distance seeds, exposes rules and leaves official highlights untouched', async t => {
  const data=structuredClone(snapshot);
  data.predictions=structuredClone(predictions);
  data.predictions.items.forEach(p=>Object.assign(p,{status:'waiting_for_data',missing:['distance_seeding_list'],
    source_urls:[],entry_count:0,seeded_count:0,observed_entries:[],groups:[],prequalified:[]}));
  const dom=await page({data,view:'predictions'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  const panel=d.querySelector('.prediction-panel');
  assert.ok(panel);
  assert.equal(panel.open,true);
  assert.match(panel.textContent,/非官方/);
  assert.match(panel.textContent,/单项报名、种子顺序与直通名单/);
  assert.equal(panel.querySelectorAll('a').length,3);
  assert.equal(panel.querySelectorAll('.prediction-group').length,0);
  const select=panel.querySelector('select');
  change(dom,select,'men-1500');
  assert.match(panel.textContent,/待单项报名、种子顺序与直通名单/);
  assert.equal(d.querySelectorAll('.match-row.is-chn').length,0);
});

test('partial official entries display evidence without publishing groups', async t => {
  const data=structuredClone(snapshot);
  data.predictions=structuredClone(predictions);
  Object.assign(data.predictions.items[0],{status:'waiting_for_data',
    missing:['awaiting_complete_entries','unranked_draw'], entry_count:17,seeded_count:1,
    observed_entries:[{seed_rank:1,world_rank:4,name:'TEST Person',country:'CHN'}],
    prequalified:[],groups:[],source_urls:[
      'https://isu-skating.com/en/short-track/events/example/?tab=entries',
      'https://isu-skating.com/en/short-track/world-standings/607/',
      'https://isu-skating.com/en/short-track/world-standings/615/']});
  const dom=await page({data,view:'predictions'});t.after(()=>dom.window.close());
  const panel=dom.window.document.querySelector('.prediction-panel');
  assert.match(panel.textContent,/官方单项报项核验中/);
  assert.match(panel.textContent,/17 人/);
  assert.match(panel.textContent,/无世界排名选手的顺序待官方确认/);
  assert.equal(panel.querySelectorAll('.prediction-group').length,0);
  assert.equal(panel.querySelectorAll('a').length,6);
});

test('projection renders seeds, filters CHN groups and yields to official groups', async t => {
  const data=structuredClone(snapshot);
  data.predictions=structuredClone(predictions);
  Object.assign(data.predictions.items[0],{status:'predicted',missing:[],prequalified:[{name:'TEST BYE',country:'CHN'}],
    groups:[{heat_number:1,has_china:true,participants:[{seed_rank:21,name:'TEST CHN',country:'CHN'}]},
      {heat_number:2,has_china:false,participants:[{seed_rank:22,name:'TEST KOR',country:'KOR'}]}]});
  data.predictions.items[1].status='official_available';
  const dom=await page({data,view:'predictions'});t.after(()=>dom.window.close());
  const d=dom.window.document,panel=d.querySelector('.prediction-panel');
  assert.equal(panel.querySelectorAll('.prediction-group').length,2);
  assert.match(panel.textContent,/直通下一轮/);
  panel.querySelector('button').click();
  assert.equal(panel.querySelectorAll('.prediction-group').length,1);
  assert.equal(panel.querySelectorAll('.prediction-group .athlete-china').length,1);
  assert.equal(d.querySelectorAll('.competition-open,.match-row.is-chn').length,0);
  change(dom,panel.querySelector('select'),'women-1000');
  assert.equal(panel.querySelectorAll('.prediction-group').length,0);
  assert.match(panel.textContent,/官方分组已公布/);
});

test('schedule first: one API, no roster/prediction or overview work until requested', async t => {
  const dom=await page({view:'schedule'});t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.deepEqual(dom.requests.filter(p=>p.startsWith('/api/')),['/api/v1/events/vancouver/rounds']);
  assert.equal(dom.requests.filter(p=>p.startsWith('/data/')).length,2);
  assert.equal(d.querySelectorAll('.athlete-card,.prediction-panel,.rb-body').length,0);
  assert.equal(d.querySelectorAll('.match-row').length,62);
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
  assert.equal(d.querySelectorAll('.match-row').length,14);
  const row=d.querySelector('.match-row');
  const bj=row.querySelector('.primary-time .tm').textContent;
  d.querySelectorAll('.fb-zone button')[1].click();
  assert.notEqual(d.querySelector('.primary-time .tm').textContent,bj);
  d.getElementById('tab-athletes').click();
  await settle(dom,()=>d.querySelector('.athlete-card'));
  d.getElementById('tab-schedule').click();
  assert.equal(d.querySelectorAll('.match-row').length,14);
  assert.equal(d.querySelectorAll('.fb-zone button')[1].getAttribute('aria-pressed'),'true');
  const overview=d.querySelector('.schedule-overview');
  overview.open=true;
  await settle(dom,()=>d.querySelector('.rb-body'));
  assert.equal(d.querySelectorAll('.finals-list button').length,9);
  d.querySelector('.finals-list button').click();
  assert.equal(d.querySelectorAll('.match-row').length,62,'jump clears a day filter hiding the target');
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
