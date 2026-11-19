import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const url = 'https://site.test/internal/analysis';
const submit = password => new Request(url, {method:'POST', body:new URLSearchParams({password, gender:'men', distance:'1500'})});
test('disabled and unauthorized requests cannot read data', async () => {
  assert.equal((await worker.fetch(submit('x'), {})).status, 404);
  const env = {ANALYSIS_PASSWORD:'example', ASSETS:{fetch:assert.fail}};
  for (const request of [new Request(url), submit('wrong')]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.doesNotMatch(await response.text(), /待赛分组/);
  }
});
test('authorized report renders predictions and escapes names', async () => {
  const participants = ['First <Runner>', 'Second'].map(name=>({name,country:'CAN'}));
  const base = {gender:'men',distance_m:1500,format:'individual',round_key:'sample',participants};
  const files = {
    '/data/calendar.json': {stations:[{id:'sample',city:'本站',date_start:'2000-01-01',date_end:'2099-01-01',detail_status:'verified'}]},
    '/data/sample.json': {entries:[{round_key:'sample',qualification:{code:'1Q'}}]},
    '/data/competitions/sample/rounds.json': {items:[{...base,evidence:'official_start_list'},
      {...base,evidence:'official_results',result_status:'Official',participants:participants.map((p,i)=>({...p,rank:i+1}))}]},
  };
  const response = await worker.fetch(submit('example'), {ANALYSIS_PASSWORD:'example', ASSETS:{fetch:url=>Response.json(files[url.pathname])}});
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(html,/按名次晋级/);
  assert.match(html,/First &lt;Runner&gt;/);
  assert.match(html,/1 \/ 1/);
  assert.doesNotMatch(html,/example|<Runner>/);
});
