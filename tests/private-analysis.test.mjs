import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const origin = 'https://site.test';
const url = origin + '/internal/analysis';
const secret = 'fixture only';
const send = (body, cookie = '', source = origin) => new Request(url, {
  method: 'POST', headers: {Origin:source, Cookie:cookie, 'Content-Type':'application/json'}, body:JSON.stringify(body)
});
const login = password => ({action:'login', password});
const round = {action:'round', gender:'men', distance:1500, roundKey:'sample'};

test('disabled, cross-origin and unauthorized requests cannot read data', async () => {
  const env = {ANALYSIS_PASSWORD:secret, ASSETS:{fetch:assert.fail}};
  assert.equal((await worker.fetch(send(login(secret)), {})).status, 404);
  assert.equal((await worker.fetch(send(login(secret), '', 'https://elsewhere.test'), env)).status, 403);
  for (const request of [send(login('wrong')), send(round), send(round, '__Host-ssts_analysis=invalid')]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), {});
  }
});
test('a session unlocks the selected round, survives later requests, and can be cleared', async () => {
  const participants = ['First','Second'].map((name,i)=>({name,country:'CAN',athlete_id:'a'+i}));
  const base = {gender:'men',distance_m:1500,format:'individual',participants};
  const files = {
    '/data/calendar.json': {stations:[{id:'sample',date_start:'2000-01-01',date_end:'2099-01-01',detail_status:'verified'}]},
    '/data/sample.json': {entries:[{round_key:'sample',qualification:{code:'1Q'}}]},
    '/data/competitions/sample/rounds.json': {items:[
      {...base, id:'pending',round_key:'sample',evidence:'official_start_list'},
      {...base, id:'finished',round_key:'old',evidence:'official_results',result_status:'Official',participants:participants.map((p,i)=>({...p,rank:i+1}))}]}
  };
  const env = {ANALYSIS_PASSWORD:secret, ASSETS:{fetch:url=>Response.json(files[url.pathname])}};
  const auth = await worker.fetch(send(login(secret)), env);
  const header = auth.headers.get('set-cookie');
  for (const attribute of ['Secure','HttpOnly','SameSite=Strict','Max-Age=604800']) assert.ok(header.includes(attribute));
  const token = header.split(';')[0];
  const result = await worker.fetch(send(round,token), env);
  assert.equal(result.status,200);
  assert.match(result.headers.get('cache-control'), /no-store/);
  const groups = await result.json();
  assert.deepEqual(groups.map(g=>g.id), ['pending']);
  const winner = groups[0].people[0];
  assert.equal(winner.id,'a0');
  assert.equal(winner.wins,1);
  assert.ok(winner.first > 0.5);
  assert.equal(winner.first,winner.direct);
  const finished = await worker.fetch(send({...round,roundKey:'old'},token),env);
  assert.equal((await finished.json())[0].people[0].first,null);
  assert.equal((await worker.fetch(send(round,token),{...env,ANALYSIS_PASSWORD:'rotated'})).status,401);
  const cleared = await worker.fetch(send({action:'logout'},token),env);
  assert.match(cleared.headers.get('set-cookie'),/Max-Age=0/);
});

test('500 m learns lane and opening separately and ignores the upcoming split', async () => {
  const {sprintModel} = await import('../src/sprint-model.mjs');
  const id = p => p.name;
  const race = (swap) => ({participants:['Fast','Slow'].map((name,i) => ({
    name, rank:i+1, starting_position:swap ? 2-i : 1+i, opening_split_seconds:6.8+0.5*i
  }))});
  const model = sprintModel([race(false),race(true)], new Map(),id);
  const upcoming = {name:'Fast',starting_position:1};
  assert.ok(model(upcoming,1.5).adjustment > model({...upcoming,name:'Slow'},1.5).adjustment);
  assert.deepEqual(model(upcoming,1.5),model({...upcoming,opening_split_seconds:9},1.5));
  assert.equal(model({name:'Unseen'},1.5).adjustment,0);
  const byLane = sprintModel([race(false),race(false)],new Map(),id);
  assert.ok(byLane({name:'Unseen',starting_position:1},1.5).adjustment >
    byLane({name:'Unseen',starting_position:2},1.5).adjustment);
});

test('1500 m advancement uses prior official closing times from this stop only', async () => {
  const { report } = await import('../src/private-analysis.mjs');
  const station = {id:'test', date_start:'2000-01-01', date_end:'2099-01-01'};
  const raceDay = '2098-12-31';
  const key = raceDay + '/main/men/1500/semifinal/-';
  const participants = ['Alpha','Bravo','Charlie'].map((name, i) =>
    ({athlete_id:name, name, country:'CAN', starting_position:i+1}));
  const upcoming = {id:'next', round_key:key, round:'semifinal', round_label:'Semifinals', local_date:raceDay,
    source_start:raceDay+'T12:00:00Z', gender:'men', distance_m:1500, format:'individual',
    evidence:'official_start_list', participants};
  const previous = { ...upcoming, id:'previous', round_key:'previous', round:'heats', round_label:'Heats',
    evidence:'official_results', result_status:'Official', source_start:raceDay+'T10:00:00Z'};
  async function forecast(closing, extra = {}) {
    const file = {
      '/data/calendar.json':{stations:[station]},
      '/data/prediction_state.json':{},
      '/data/test.json':{entries:[{round_key:key,qualification:{code:'1Q+1q'}}]},
      '/data/competitions/test/rounds.json':{items:[{...previous,participants:participants.map((p,i)=>({
        ...p,rank:i+1,result:'2:20.00'+i,last_four_seconds:closing[i]})),...extra}, upcoming]},
    };
    return (await report({ASSETS:{fetch:url=>Response.json(file[url.pathname])}},'men',1500,key))[0].people;
  }
  const fast = await forecast([34,36,null]), slow = await forecast([36,34,null]);
  assert.ok(fast[0].totalAdvance > slow[0].totalAdvance);
  assert.ok(fast[0].direct > slow[0].direct);
  for (const p of fast) assert.ok(Math.abs(p.direct+p.smallQ-p.totalAdvance)<1e-10);
  const later = {source_start:raceDay+'T12:05:00Z'};
  assert.deepEqual(await forecast([34,36,null],later), await forecast([36,34,null],later));
});

test('relative form uses the last classified time and falls back to total time for missing 1500 splits', async () => {
  const {previousRoundForm} = await import('../src/prediction/advance-form.mjs');
  const row = (athlete_id,time_s,last_four_seconds) => ({
    athlete_id, time_s, last_four_seconds, round_key:'heats', status:'OK'
  });
  const heats = [[row('A',141,33),row('B',140,null)],[row('C',139,36),row('D',143,null)],
    [{...row('A',115,30),round_key:'repechage',status:'ADV'}]];
  const form = previousRoundForm(heats,1500);
  assert.equal(form.get('A'),0.5);
  assert.equal(form.get('B'),0.25);
  assert.equal(previousRoundForm(heats,1000).get('A'),-0.25);
});

test('prepared round requires a session and only serves the matching day and discipline', async () => {
  const { createWorker } = await import('../src/worker.mjs');
  const env = {ANALYSIS_PASSWORD:secret, ASSETS:{fetch:assert.fail}};
  const day = new Date().toISOString().slice(0, 10);
  const groups = [{id:'prepared'}];
  const rounds = {[JSON.stringify([round.gender, round.distance, round.roundKey])]:groups};
  const prepared = createWorker({day, rounds});
  assert.equal((await prepared.fetch(send(round), env)).status, 401);
  const auth = await prepared.fetch(send(login(secret)), env);
  const token = auth.headers.get('set-cookie').split(';')[0];
  const hit = await prepared.fetch(send(round, token), env);
  assert.equal(hit.status, 200);
  assert.deepEqual(await hit.json(), groups);
  assert.match(hit.headers.get('cache-control'), /no-store/);
  // Missing or expired entries must consult live assets (unavailable in this fixture).
  assert.equal((await prepared.fetch(send({...round,distance:500}, token), env)).status, 503);
  const expired = createWorker({day:'2000-01-01', rounds});
  assert.equal((await expired.fetch(send(round, token), env)).status, 503);
});
