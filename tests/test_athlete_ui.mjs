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
async function page({data = snapshot, fails = () => false} = {}) {
  const dom = new JSDOM(html, {url:'https://example.test/?station=vancouver', runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window;
  w.matchMedia = () => ({matches:false, addEventListener(){}});
  w.fetch = async input => {
    const url = new URL(input, w.location.href);
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
  await settle(dom, () => w.document.querySelector('.athlete-panel,.athlete-load-error'));
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
  assert.equal(roster.open,false);
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
  await settle(dom,()=>!d.querySelector('.athlete-load-error'));
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
  assert.ok([...d.querySelectorAll('.athlete-panel')].some(p=>p.textContent.includes('单站排名')));
  dialog.querySelector('[aria-label="关闭比赛详情"]').click();
  assert.equal(d.querySelector('dialog'),null);
});

test('prediction waits for distance seeds, exposes rules and leaves official highlights untouched', async t => {
  const dom=await page();t.after(()=>dom.window.close());
  const d=dom.window.document;
  const panel=d.querySelector('.prediction-panel');
  assert.ok(panel);
  assert.equal(panel.open,false);
  assert.match(panel.textContent,/非官方/);
  assert.match(panel.textContent,/单项报名、种子顺序与直通名单/);
  assert.equal(panel.querySelectorAll('a').length,3);
  assert.equal(panel.querySelectorAll('.prediction-group').length,0);
  const select=panel.querySelector('select');
  change(dom,select,'men-1500');
  assert.match(panel.textContent,/整站报名不等于单项参赛名单/);
  assert.equal(d.querySelectorAll('.match-row.is-chn').length,0);
});

test('projection renders seeds, filters CHN groups and yields to official groups', async t => {
  const data=structuredClone(snapshot);
  data.predictions=structuredClone(predictions);
  Object.assign(data.predictions.items[0],{status:'predicted',missing:[],prequalified:[{name:'TEST BYE',country:'CHN'}],
    groups:[{heat_number:1,has_china:true,participants:[{seed_rank:21,name:'TEST CHN',country:'CHN'}]},
      {heat_number:2,has_china:false,participants:[{seed_rank:22,name:'TEST KOR',country:'KOR'}]}]});
  data.predictions.items[1].status='official_available';
  const dom=await page({data});t.after(()=>dom.window.close());
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
