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
  const projected=await (await request('/api/v1/events/vancouver/predictions?gender=women&distance_m=500',realEnv)).json();
  assert.equal(projected.evidence,'model_prediction_not_official');
  assert.equal(projected.total,1);
  assert.equal(projected.items[0].status,'waiting_for_data');
  assert.deepEqual(projected.items[0].groups,[]);
  assert.equal((await request('/api/v1/events/vancouver/predictions?country=CHN',realEnv)).status,400);
  assert.equal(await (await request('/api/v1/events/vancouver/predictions',realEnv,'HEAD')).text(),'');
  const seoul=await (await request('/api/v1/events/seoul/predictions',realEnv)).json();
  assert.ok(seoul.items.every(p=>p.missing.includes('schedule')));
});

test('race-window cron: 10-min syncs around sessions, hourly between them, none outside windows', async () => {
  const {inRaceWindow, syncDecision} = await import('../src/worker.mjs');
  const stations = [{id:'vancouver', date_start:'2026-10-23', date_end:'2026-10-25'}, {id:'seoul', date_start:'2026-11-20', date_end:'2026-11-22'}];
  assert.equal(inRaceWindow(stations, Date.parse('2026-10-20T12:00:00Z')).length, 0);
  assert.equal(inRaceWindow(stations, Date.parse('2026-10-21T00:00:00Z'))[0].id, 'vancouver');
  assert.equal(inRaceWindow(stations, Date.parse('2026-10-28T00:00:00Z')).length, 0);

  const schedule = JSON.parse(await readFile(new URL('../dist/data/vancouver.json', import.meta.url), 'utf-8'));
  const assets = {fetch:async req => {
    const path = new URL(req.url).pathname;
    if (path === '/data/calendar.json') return Response.json({stations});
    if (path === '/data/vancouver.json') return Response.json(schedule);
    return new Response('missing', {status:404});
  }};
  const decide = time => syncDecision({ASSETS:assets}, Date.parse(time));
  // Day 1 first round 16:00Z, last 01:42Z next day (Vancouver 09:00–18:42 local).
  assert.equal(await decide('2026-10-23T14:10:00Z'), 'session');   // 1h50 before first round
  assert.equal(await decide('2026-10-24T03:40:00Z'), 'session');   // 1h58 after last round
  assert.equal(await decide('2026-10-23T12:00:00Z'), 'hourly');
  assert.equal(await decide('2026-10-23T12:10:00Z'), 'skip');
  assert.equal(await decide('2026-10-21T09:00:00Z'), 'hourly');    // pre-event day, no sessions
  assert.equal(await decide('2026-11-19T00:10:00Z'), 'skip');       // Seoul window, no detailed schedule yet
  assert.equal(await decide('2026-11-19T01:00:00Z'), 'hourly');
  assert.equal(await decide('2026-11-05T00:00:00Z'), 'outside_window');

  // Count Vancouver-window dispatches per UTC day to keep ISU load visible in tests.
  let total = 0;
  for (let t = Date.parse('2026-10-21T00:00:00Z'); t < Date.parse('2026-10-28T00:00:00Z'); t += 600_000) {
    if (['session', 'hourly'].includes(await decide(new Date(t).toISOString()))) total++;
  }
  assert.ok(total < 400, 'dispatches in the Vancouver window: ' + total);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({url, init}); return new Response(null, {status:204}); };
  const run = async (token, time) => {
    const pending = [];
    await worker.scheduled({scheduledTime:Date.parse(time)}, {GITHUB_DISPATCH_TOKEN:token, ASSETS:assets}, {waitUntil:p => pending.push(p)});
    await Promise.all(pending);
  };
  try {
    await run('t0k', '2026-10-24T18:00:00Z');
    await run('t0k', '2026-10-24T13:10:00Z');
    await run('t0k', '2026-11-10T18:00:00Z');
    await run(undefined, '2026-10-24T18:00:00Z');
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/dupirou/ssts_wb/actions/workflows/sync.yml/dispatches');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t0k');
  assert.deepEqual(JSON.parse(calls[0].init.body), {ref:'main'});
});
