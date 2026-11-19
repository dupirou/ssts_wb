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
