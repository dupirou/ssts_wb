import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {readFile} from 'node:fs/promises';

const entry = {id:'ath-a', athlete_id:'ath-a', name:'Sample A', country:'CHN', gender:'women'};
const dataset = items => ({status:items.length ? 'available' : 'not_published', update_status:'ok',
  checked_at:new Date().toISOString(), updated_at:'2026-10-20T00:00:00Z', source_urls:[], items});
const heat = (id, evidence, people) => ({id, evidence, gender:'women', distance_m:500,
  round_key:'2026-10-23/qualifying/women/500/preliminaries/-', participants:people});
const person = (country, penalty = null) => ({athlete_id:country, name:country, country, rank:1, penalty});
const snapshot = {entries:dataset([entry]), rankings:dataset([]), rounds:dataset([
  heat('1','official_results',[person('CHN',{code:'PEN', infringement_code:null}), person('HKG')]),
  heat('2','official_start_list',[person('CHN')]),
])};
function envFor(obj = snapshot) {
  return {ASSETS:{async fetch(request) {
    const path = new URL(typeof request === 'string' ? request : request.url || request).pathname;
    if (path.endsWith('/index.json')) return Response.json({schema_version:1, events:[{id:'vancouver'}]});
    if (path === '/data/competitions/vancouver.json') return Response.json(obj);
    return new Response('site asset', {status:path === '/' ? 200 : 404});
  }}};
}
const request = (path, env = envFor(), method = 'GET') => worker.fetch(new Request('https://example.test' + path, {method}), env);

test('entries, country filter, empty rankings and unknown events', async () => {
  const result = await request('/api/v1/events/vancouver/entries?country=CHN');
  assert.equal(result.status,200);
  assert.equal((await result.json()).total,1);
  assert.equal((await (await request('/api/v1/events/vancouver/entries?country=HKG')).json()).total,0);
  assert.equal((await (await request('/api/v1/events/vancouver/rankings')).json()).status,'not_published');
  assert.equal((await request('/api/v1/events/unknown/entries')).status,404);
  assert.equal((await request('/api/v1/unknown')).status,404);
});
test('round filter selects matching heats and retains opponents', async () => {
  const result = await (await request('/api/v1/events/vancouver/rounds?country=HKG')).json();
  assert.equal(result.total,1);
  assert.equal(result.items[0].participants.length,2);
});
test('results exclude start lists; penalties exclude nonpenalized opponents', async () => {
  const result = await (await request('/api/v1/events/vancouver/results')).json();
  assert.equal(result.total,2);
  assert.equal(new Set(result.items.map(i=>i.id)).size,2);
  const penalties = await (await request('/api/v1/events/vancouver/penalties?country=CHN')).json();
  assert.equal(penalties.total,1);
  assert.equal(penalties.items[0].penalty.code,'PEN');
  assert.equal(penalties.items[0].penalty.infringement_code,null);
});
test('fresh start lists do not pretend results have been published', async () => {
  const obj = structuredClone(snapshot);
  obj.rounds.items = [snapshot.rounds.items[1]];
  assert.equal((await (await request('/api/v1/events/vancouver/results',envFor(obj))).json()).status,'not_published');
});
test('malformed/duplicate/unknown filters and write methods rejected', async () => {
  for (const query of ['country=cn','country=CHN&country=CAN','unknown=1','gender=unknown','distance_m=42']) {
    assert.equal((await request('/api/v1/events/vancouver/entries?'+query)).status,400);
  }
  assert.equal((await request('/api/v1/events/vancouver/entries',envFor(),'POST')).status,405);
  assert.equal((await request('/api/v1/events/vancouver/entries',envFor(),'HEAD')).status,200);
  assert.equal(await (await request('/api/v1/events/vancouver/entries',envFor(),'HEAD')).text(),'');
  assert.equal(await (await request('/')).text(),'site asset');
});
test('upstream failure serves previous snapshot with stale flag', async () => {
  const obj = structuredClone(snapshot); obj.entries.update_status='error';
  const result = await (await request('/api/v1/events/vancouver/entries',envFor(obj))).json();
  assert.equal(result.stale,true);
  assert.equal(result.total,1);
  const broken = {ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
  assert.equal((await request('/api/v1/events',broken)).status,503);
});
test('built real snapshot and unconfigured event empty states are served', async () => {
  const realEnv = {ASSETS:{async fetch(request) {
    const pathname = new URL(request).pathname;
    try {return new Response(await readFile(new URL('../dist'+pathname,import.meta.url)));}
    catch {return new Response('not found',{status:404});}
  }}};
  const result = await (await request('/api/v1/events/vancouver/entries?country=CHN',realEnv)).json();
  const source = JSON.parse(await readFile(new URL('../data/competitions/vancouver.json',import.meta.url),'utf8'));
  assert.equal(result.total,source.entries.items.filter(p=>p.country==='CHN').length);
  assert.equal(result.status,'available');
  assert.equal((await (await request('/api/v1/events/seoul/rounds',realEnv)).json()).status,'not_published');
});
