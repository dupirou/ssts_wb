import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/worker.mjs';
import { lookupH2H } from '../src/prediction/explainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://site.test';
const ANALYSIS_URL = `${ORIGIN}/internal/analysis`;
const SECRET = 'phase4-integration-secret';

function req(body, cookie = '') {
  return new Request(ANALYSIS_URL, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('H2H store in prediction_state.json matches build/heat_starts.jsonl clean finishes', (t) => {
  const state = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/data/prediction_state.json'), 'utf8')
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssts-heat-starts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('python', ['tools/export_heat_starts.py', '--out-dir', dir], { cwd: ROOT });
  const raw = fs.readFileSync(path.join(dir, 'heat_starts.jsonl'), 'utf8');

  // Independently compute clean H2H across 2022/23-2025/26 heats (excluding incomplete 960 heats).
  const heats = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.season === '2026/27') continue;
    const hk = `${r.event_id}::${r.heat_id}`;
    let arr = heats.get(hk);
    if (!arr) {
      arr = [];
      heats.set(hk, arr);
    }
    arr.push(r);
  }

  const expectedH2H = new Map();
  for (const rows of heats.values()) {
    const r0 = rows[0];
    const active = rows.filter((r) => r.status !== 'DNS');
    if (active.length < 2) continue;
    if (r0.event_id === '2025-26-worldtour-montreal-2') {
      if (active.length < 3) continue;
      const ranks = active.map((r) => r.rank).filter((x) => Number.isInteger(x) && x > 0);
      const maxRank = ranks.length ? Math.max(...ranks) : 0;
      if (maxRank > active.length || (!ranks.includes(1) && !active.some((r) => r.is_incident))) continue;
    }
    const clean = active.filter(
      (r) => (r.status === 'OK' || r.status === 'NO_TIME') && Number.isInteger(r.rank) && r.rank > 0
    );
    for (let i = 0; i < clean.length; i++) {
      for (let j = i + 1; j < clean.length; j++) {
        const a = clean[i];
        const b = clean[j];
        if (a.athlete_id === b.athlete_id || a.rank === b.rank) continue;
        const firstId = a.athlete_id < b.athlete_id ? a.athlete_id : b.athlete_id;
        const key = firstId === a.athlete_id ? `${a.athlete_id}|${b.athlete_id}` : `${b.athlete_id}|${a.athlete_id}`;
        const rec = expectedH2H.get(key) || [0, 0];
        const aWon = a.rank < b.rank;
        const firstWon = firstId === a.athlete_id ? aWon : !aWon;
        if (firstWon) rec[0] += 1;
        else rec[1] += 1;
        expectedH2H.set(key, rec);
      }
    }
  }

  // Verify multiple known frequent pair keys and total pair count match identically.
  assert.equal(Object.keys(state.h2h).length, expectedH2H.size);
  const topPairs = [...expectedH2H.entries()]
    .sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]))
    .slice(0, 10);
  assert.ok(topPairs.length === 10 && topPairs[0][1][0] + topPairs[0][1][1] >= 10);
  for (const [k, [w0, w1]] of topPairs) {
    const [idA, idB] = k.split('|');
    assert.deepEqual(lookupH2H(state.h2h, idA, idB), {
      h2h_wins: w0,
      h2h_losses: w1,
      h2h_total: w0 + w1,
    });
  }
});

test('End-to-end /internal/analysis V2 + Layer 4 on real Montreal 2Q+2q round (pending & mid-round)', async () => {
  const predStateObj = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/data/prediction_state.json'), 'utf8')
  );
  const calendar = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/data/calendar.json'), 'utf8')
  );
  const vancouverObj = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/data/competitions/vancouver/rounds.json'), 'utf8')
  );
  const montrealSchedObj = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/data/montreal.json'), 'utf8')
  );
  const montrealRoundsOrig = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/data/competitions/montreal/rounds.json'), 'utf8')
  );

  const roundKey = '2026-10-31/main/men/500/quarterfinal/-';
  const makeFixtureRounds = (completedHeatCount) => {
    let seen = 0;
    return {
      ...montrealRoundsOrig,
      items: montrealRoundsOrig.items.map((h) => {
        if (h.round_key !== roundKey) return h;
        seen++;
        if (seen <= completedHeatCount) return h; // keep as official_results
        return {
          ...h,
          local_date: '2099-01-01',
          evidence: 'official_start_list',
          result_status: 'Start List',
          participants: h.participants.map((p) => ({
            ...p,
            rank: null,
            result: null,
            qualification: null,
            penalty: null,
          })),
        };
      }),
    };
  };

  // Clone calendar with montreal open into future so hasForecast enables forecasting.
  const openCalendarObj = {
    ...calendar,
    stations: calendar.stations
      .filter((s) => s.id === 'vancouver' || s.id === 'montreal')
      .map((s) => (s.id === 'montreal' ? { ...s, date_end: '2099-01-01', detail_status: 'verified' } : s)),
  };

  function makeEnv(completedHeatCount) {
    const files = {
      '/data/prediction_state.json': predStateObj,
      '/data/calendar.json': openCalendarObj,
      '/data/montreal.json': montrealSchedObj,
      '/data/competitions/vancouver/rounds.json': vancouverObj,
      '/data/competitions/montreal/rounds.json': makeFixtureRounds(completedHeatCount),
    };
    return {
      ANALYSIS_PASSWORD: SECRET,
      ASSETS: {
        fetch: async (url) => {
          const p = new URL(url).pathname;
          if (!(p in files)) return new Response('Not Found', { status: 404 });
          return { ok: true, json: async () => files[p] };
        },
      },
    };
  }

  // 1. All 4 heats pending (pre-round forecast)
  const envAllPending = makeEnv(0);
  const auth = await worker.fetch(req({ action: 'login', password: SECRET }), envAllPending);
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];

  const r1 = await worker.fetch(req({ action: 'round', gender: 'men', distance: 500, roundKey }, cookie), envAllPending);
  assert.equal(r1.status, 200);
  const groups1 = await r1.json();

  const r2 = await worker.fetch(req({ action: 'round', gender: 'men', distance: 500, roundKey }, cookie), envAllPending);
  const groups2 = await r2.json();

  const warmSamples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const rk = await worker.fetch(req({ action: 'round', gender: 'men', distance: 500, roundKey }, cookie), envAllPending);
    warmSamples.push(performance.now() - t0);
    assert.equal(rk.status, 200);
  }
  warmSamples.sort((a, b) => a - b);
  const elapsedMs = warmSamples[1];

  // Deterministic reproducibility and <200ms median warm response latency
  assert.deepEqual(groups1, groups2);
  assert.ok(elapsedMs < 200, `Worker /internal/analysis median warm latency ${elapsedMs.toFixed(1)}ms >= 200ms`);
  assert.equal(groups1.length, 4);

  let sumSmallQ = 0;
  for (const h of groups1) {
    assert.ok(['fast', 'medium', 'slow'].includes(h.heatPace.pace_label));
    assert.equal(h.qualificationRule.code, '2Q+2q');
    assert.equal(h.qualificationRule.big_q, 2);
    assert.equal(h.qualificationRule.small_q_actual, 2);

    const sumFirst = h.people.reduce((a, p) => a + p.first, 0);
    assert.ok(Math.abs(sumFirst - 1.0) < 1e-9, `first sum ${sumFirst} != 1`);

    for (const p of h.people) {
      sumSmallQ += p.smallQ;
      assert.ok(Math.abs(p.totalAdvance - (p.direct + p.smallQ)) < 1e-12);
      assert.ok(p.deepDive && p.deepDive.factor_attribution && p.deepDive.what_if_clean_race);

      // Exact factor attribution conservation: sum of 7 components === total_relative_strength
      const attr = p.deepDive.factor_attribution;
      const sumComponents =
        attr.base_skill +
        attr.lane +
        attr.opening_split +
        attr.finishing_kick +
        attr.venue_pace +
        attr.recent_form +
        attr.repechage_context;
      assert.ok(
        Math.abs(sumComponents - attr.total_relative_strength) < 1e-9,
        `Attribution sum ${sumComponents} != ${attr.total_relative_strength}`
      );
      assert.ok(p.deepDive.key_rivals.length >= 1 && p.deepDive.key_rivals.length <= 2);
      for (const rv of p.deepDive.key_rivals) {
        assert.equal(rv.h2h_total, rv.h2h_wins + rv.h2h_losses);
      }
    }
  }
  assert.ok(Math.abs(sumSmallQ - 2.0) < 1e-3, `round smallQ sum ${sumSmallQ} != 2.0`);

  // 2. Mid-round conditioning (Heat 1 & Heat 2 completed, Heat 3 & Heat 4 pending)
  const envMid = makeEnv(2);
  const rMid = await worker.fetch(req({ action: 'round', gender: 'men', distance: 500, roundKey }, cookie), envMid);
  assert.equal(rMid.status, 200);
  const groupsMid = await rMid.json();
  assert.equal(groupsMid.length, 4);
  assert.equal(groupsMid[0].people[0].first, null);
  assert.equal(groupsMid[0].people[0].deepDive, null);
  assert.equal(groupsMid[1].people[0].first, null);
  assert.ok(groupsMid[2].people[0].first > 0);
  assert.ok(groupsMid[2].people[0].deepDive !== null);
  assert.ok(groupsMid[3].people[0].deepDive !== null);

  // 3. ADV in completed Heat 1 reduces remaining Small-q slots (2 -> 1)
  const mrAdv = makeFixtureRounds(2);
  const qf1 = mrAdv.items.find((h) => h.round_key === roundKey);
  qf1.participants[qf1.participants.length - 1].qualification = 'ADV';
  const envAdv = {
    ANALYSIS_PASSWORD: SECRET,
    ASSETS: {
      fetch: async (url) => {
        const p = new URL(url).pathname;
        const map = {
          '/data/prediction_state.json': predStateObj,
          '/data/calendar.json': openCalendarObj,
          '/data/montreal.json': montrealSchedObj,
          '/data/competitions/vancouver/rounds.json': vancouverObj,
          '/data/competitions/montreal/rounds.json': mrAdv,
        };
        if (!(p in map)) return new Response('Not Found', { status: 404 });
        return { ok: true, json: async () => map[p] };
      },
    },
  };
  const rAdv = await worker.fetch(req({ action: 'round', gender: 'men', distance: 500, roundKey }, cookie), envAdv);
  assert.equal(rAdv.status, 200);
  const groupsAdv = await rAdv.json();
  assert.equal(groupsAdv[2].qualificationRule.n_adv, 1);
  assert.equal(groupsAdv[2].qualificationRule.small_q_actual, 1);
  console.log(`Worker /internal/analysis warm latency: ${elapsedMs.toFixed(1)} ms`);
});

test('pending A final awards individual medal probabilities and B final uses the actual A field', async () => {
  const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/data', name), 'utf8'));
  const calendar = read('calendar.json');
  const station = calendar.stations.find(s => s.id === 'montreal');
  const finals = read('competitions/montreal/rounds.json').items.filter(h =>
    h.gender === 'men' && h.distance_m === 500 && h.round === 'final'
  ).map(h => ({
    ...h, evidence: 'official_start_list', result_status: 'Start List', local_date: '2099-01-01',
    participants: h.participants.map(p => ({ ...p, result: null, rank: null, penalty: null, qualification: null }))
  }));
  const finalA = finals.find(h => h.group === 'A');
  const files = {
    '/data/calendar.json': { ...calendar, stations: [{ ...station, date_end: '2099-01-01' }] },
    '/data/prediction_state.json': read('prediction_state.json'),
    '/data/montreal.json': read('montreal.json'),
    '/data/competitions/montreal/rounds.json': { items: finals }
  };
  const env = { ANALYSIS_PASSWORD: SECRET, ASSETS: { fetch: async url => Response.json(files[new URL(url).pathname]) } };
  const login = await worker.fetch(req({ action: 'login', password: SECRET }), env);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const heat of finals) {
    const response = await worker.fetch(req({ action: 'round', gender: 'men', distance: 500, roundKey: heat.round_key }, cookie), env);
    assert.equal(response.status, 200);
    const [{ people }] = await response.json();
    if (heat.group === 'A') {
      assert.ok(people.every(p => p.medals.length === 3 && p.medals.every(x => x >= 0 && x <= 1)));
      for (let rank = 0; rank < 3; rank++) {
        const total = people.reduce((s, p) => s + p.medals[rank], 0);
        assert.ok(total > 0.9 && total <= 1 + 1e-9);
      }
    } else {
      assert.ok(people.every(p => p.medals === null && p.expectedFinalPlace === finalA.participants.length + p.expectedPlace));
    }
  }
});
