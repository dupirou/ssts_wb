import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scoresToWeights,
  firstPlaceProbs,
  topPlaces,
  expectedPlaces,
  predictHeat,
} from '../src/prediction/plackett-luce.mjs';
import { DynamicRatingEngine, driftSigma } from '../src/prediction/rating.mjs';
import {
  OpeningSplitTracker,
  buildHeatFeatures,
  fitContextualParams,
  makeTrainingSample,
  scoreHeatFeatures,
} from '../src/prediction/lane-model.mjs';

test('Plackett-Luce enforces strict probability and expected-rank conservation', () => {
  const testCases = [
    { scores: [0, 0], k: 1 },
    { scores: [1.8, 0.4, -0.3, -1.2], k: 2 },
    { scores: [3.5, 1.2, 0.0, -0.7, -2.4], k: 3 },
    { scores: [2.1, 1.5, 0.9, 0.2, -0.1, -0.8, -1.6], k: 2 },
    { scores: [2.5, 1.8, 1.1, 0.7, 0.3, -0.2, -0.6, -1.2, -2.0], k: 4 },
    { scores: [60, -60, 0], k: 1 }, // Extreme score differential stability
  ];

  for (const { scores, k } of testCases) {
    const n = scores.length;
    const pred = predictHeat(scores, k);
    const sumFirst = pred.pFirst.reduce((a, b) => a + b, 0);
    const sumBigQ = pred.pBigQ.reduce((a, b) => a + b, 0);
    const sumExpPlace = pred.expectedPlace.reduce((a, b) => a + b, 0);

    assert.ok(Math.abs(sumFirst - 1.0) < 1e-9, `pFirst sum ${sumFirst} != 1`);
    assert.ok(Math.abs(sumBigQ - k) < 1e-9, `pBigQ sum ${sumBigQ} != ${k}`);
    assert.ok(
      Math.abs(sumExpPlace - (n * (n + 1)) / 2) < 1e-9,
      `expectedPlace sum ${sumExpPlace} != ${(n * (n + 1)) / 2}`
    );

    for (let i = 0; i < n; i++) {
      assert.ok(pred.pFirst[i] >= 0 && pred.pFirst[i] <= 1);
      assert.ok(pred.pBigQ[i] >= pred.pFirst[i] - 1e-12);
      assert.ok(pred.expectedPlace[i] >= 1 && pred.expectedPlace[i] <= n);
    }

    // Strict monotonicity: higher score -> higher P(1st), higher P(Big Q), lower expected place.
    const w = scoresToWeights(scores);
    assert.deepEqual(firstPlaceProbs(w), pred.pFirst);
    assert.deepEqual(topPlaces(w, k), pred.pBigQ);
    assert.deepEqual(expectedPlaces(w), pred.expectedPlace);
  }
});

test('DynamicRatingEngine preserves monotonicity, shrinks sigma, and inflates across layoffs', () => {
  const engine = new DynamicRatingEngine();
  const base = {
    season: '2024/25',
    gender: 'men',
    distance_m: 1000,
    session_type: 'MAIN',
    start_time_utc: '2024-10-25T15:00:00Z',
  };
  const heat = [
    { ...base, athlete_id: 'skr-a', status: 'OK', rank: 1 },
    { ...base, athlete_id: 'skr-b', status: 'OK', rank: 2 },
    { ...base, athlete_id: 'skr-c', status: 'OK', rank: 3 },
    { ...base, athlete_id: 'skr-d', status: 'OK', rank: 4 },
  ];

  const preA = engine.peekAthlete('skr-a', 'men', 1000, Date.parse(base.start_time_utc), base.season);
  const res = engine.updateHeat(heat);
  assert.equal(res.updated, true);

  const postA = engine.peekAthlete('skr-a', 'men', 1000, Date.parse(base.start_time_utc), base.season);
  const postB = engine.peekAthlete('skr-b', 'men', 1000, Date.parse(base.start_time_utc), base.season);
  const postC = engine.peekAthlete('skr-c', 'men', 1000, Date.parse(base.start_time_utc), base.season);
  const postD = engine.peekAthlete('skr-d', 'men', 1000, Date.parse(base.start_time_utc), base.season);

  assert.ok(postA.mu > postB.mu && postB.mu > postC.mu && postC.mu > postD.mu);
  assert.ok(postA.mu > 0 && postD.mu < 0);
  assert.ok(postA.sigma < preA.sigma);

  // Off-season + inactivity variance inflation
  const drifted = engine.peekAthlete(
    'skr-a',
    'men',
    1000,
    Date.parse('2025-10-25T15:00:00Z'),
    '2025/26'
  );
  assert.ok(drifted.sigma > postA.sigma);
  assert.equal(drifted.mu, postA.mu);
  assert.ok(driftSigma(0.5, 0, '2024/25', 100 * 86400000, '2025/26', engine.cfg) > 0.5);
});

test('DynamicRatingEngine isolates PEN/YC/RC/DNF/ADV and down-weights REPECHAGE', () => {
  const eMain = new DynamicRatingEngine();
  const eRep = new DynamicRatingEngine();
  const rowBase = {
    season: '2024/25',
    gender: 'women',
    distance_m: 500,
    start_time_utc: '2024-11-01T14:00:00Z',
  };

  const raceMain = [
    { ...rowBase, session_type: 'MAIN', athlete_id: 'skr-1', status: 'OK', rank: 1 },
    { ...rowBase, session_type: 'MAIN', athlete_id: 'skr-2', status: 'NO_TIME', rank: 2 },
    { ...rowBase, session_type: 'MAIN', athlete_id: 'skr-adv', status: 'ADV', rank: 3 },
    { ...rowBase, session_type: 'MAIN', athlete_id: 'skr-pen', status: 'PEN', rank: null },
    { ...rowBase, session_type: 'MAIN', athlete_id: 'skr-dnf', status: 'DNF', rank: 4 },
    { ...rowBase, session_type: 'MAIN', athlete_id: 'skr-yc', status: 'YC', rank: null },
  ];
  const raceRep = raceMain.map((r) => ({ ...r, session_type: 'REPECHAGE' }));

  const outMain = eMain.updateHeat(raceMain);
  const outRep = eRep.updateHeat(raceRep);
  assert.equal(outMain.cleanCount, 2);
  assert.equal(outRep.wSession, eRep.cfg.repWeight);

  // PEN, DNF, YC, ADV must remain completely untouched at prior (mu0=0, isKnown=false).
  for (const id of ['skr-adv', 'skr-pen', 'skr-dnf', 'skr-yc']) {
    const st = eMain.peekAthlete(id, 'women', 500);
    assert.equal(st.isKnown, false);
    assert.equal(st.mu, 0);
  }

  // Repechage change must be strictly smaller than Main change.
  const muMain = eMain.peekAthlete('skr-1', 'women', 500).mu;
  const muRep = eRep.peekAthlete('skr-1', 'women', 500).mu;
  assert.ok(muRep > 0 && muRep < muMain);
});

test('Zero future leakage: pre-race features depend solely on completed history', () => {
  const e1 = new DynamicRatingEngine();
  const o1 = new OpeningSplitTracker();
  const pastHeat = [
    {
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'PRELIM',
      start_time_utc: '2024-10-25T14:00:00Z',
      athlete_id: 'skr-x',
      starting_position: 1,
      heat_size: 4,
      opening_split_s: 6.9,
      status: 'OK',
      rank: 1,
    },
    {
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'PRELIM',
      start_time_utc: '2024-10-25T14:00:00Z',
      athlete_id: 'skr-y',
      starting_position: 2,
      heat_size: 4,
      opening_split_s: 7.3,
      status: 'OK',
      rank: 2,
    },
  ];
  e1.updateHeat(pastHeat);
  o1.updateHeat(pastHeat);

  const upcomingA = [
    {
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'MAIN',
      start_time_utc: '2024-10-26T15:00:00Z',
      athlete_id: 'skr-x',
      starting_position: 2,
      heat_size: 4,
      opening_split_s: 9.9,
      status: 'OK',
      rank: 4,
    },
    {
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'MAIN',
      start_time_utc: '2024-10-26T15:00:00Z',
      athlete_id: 'skr-y',
      starting_position: 1,
      heat_size: 4,
      opening_split_s: 6.5,
      status: 'OK',
      rank: 1,
    },
  ];
  const upcomingDifferentFuture = upcomingA.map((r) => ({ ...r, opening_split_s: 7.0, rank: r.rank === 1 ? 2 : 1 }));

  const f1 = buildHeatFeatures(upcomingA, e1, o1);
  const f2 = buildHeatFeatures(upcomingDifferentFuture, e1, o1);
  assert.deepEqual(f1, f2);
});

test('Controlled lane model learns positive inner-lane effect independent of skill', () => {
  const engine = new DynamicRatingEngine();
  const tracker = new OpeningSplitTracker();
  const samples = [];

  // Repeatedly pit equal-skill unknown skaters where Lane 1 beats Lane 4 in PRELIM.
  for (let h = 0; h < 20; h++) {
    const active = [1, 2, 3, 4].map((lane) => ({
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'PRELIM',
      start_time_utc: '2024-10-25T14:00:00Z',
      athlete_id: `skr-anon-${h}-${lane}`,
      starting_position: lane,
      heat_size: 4,
      is_repechage_qualifier: false,
      status: 'OK',
      rank: lane,
    }));
    const features = buildHeatFeatures(active, engine, tracker);
    const s = makeTrainingSample(active, features);
    if (s) samples.push(s);
  }

  const fitted = fitContextualParams(samples);
  assert.ok(fitted.params.betaLanePrelim > 0.3, `Expected positive betaLanePrelim, got ${fitted.params.betaLanePrelim}`);

  const testHeat = [
    {
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'PRELIM',
      start_time_utc: '2024-10-26T14:00:00Z',
      athlete_id: 'skr-new-1',
      starting_position: 1,
      heat_size: 4,
      is_repechage_qualifier: false,
    },
    {
      season: '2024/25',
      gender: 'men',
      distance_m: 500,
      session_type: 'PRELIM',
      start_time_utc: '2024-10-26T14:00:00Z',
      athlete_id: 'skr-new-4',
      starting_position: 4,
      heat_size: 4,
      is_repechage_qualifier: false,
    },
  ];
  const scores = scoreHeatFeatures(buildHeatFeatures(testHeat, engine, tracker), fitted.theta);
  assert.ok(scores[0] > scores[1]);
});

test('AIN2 and verified Russian AIN skaters share the same distance-specific federation prior', () => {
  const engine = new DynamicRatingEngine({enableFederationPrior:true});
  const row = (athlete_id, country, rank) => ({
    athlete_id, country, rank, gender:'men', distance_m:1500, status:'OK'
  });
  engine.updateHeat([row('skr-20499', 'AIN', 1), row('peer', 'CAN', 2)]);
  const prior = (country, distance = 1500) => engine.peekAthlete('new', 'men', distance, null, null, country).mu;
  assert.ok(prior('AIN2') > 0);
  assert.equal(prior('AIN2'), prior('RUS'));
  assert.equal(prior('AIN'), 0);
  assert.equal(prior('AIN2', 500), 0);
  engine.updateHeat([row('entrant', 'AIN2', 1), row('peer', 'CAN', 2)]);
  assert.deepEqual([...engine.fedStats.keys()].sort(), ['CAN:men:1500', 'RUS:men:1500']);
});

test('a calibrated debut rating initializes only the first senior start at that distance', () => {
  const engine = new DynamicRatingEngine();
  engine.debutRatings = { 'men:500': { rookie: { mu: 1.2, sigma: 1.3 } } };
  const peek = (distance = 500) => engine.peekAthlete('rookie', 'men', distance);
  assert.equal(peek().mu, 1.2);
  assert.equal(peek().sigma, 1.3);
  assert.equal(peek().nStarts, 0);
  assert.equal(peek(1000).mu, 0);
  const rows = ['rookie', 'other'].map((athlete_id, i) => ({
    athlete_id, gender: 'men', distance_m: 500, rank: i + 1, status: 'OK',
  }));
  engine.updateHeat(rows);
  const after = peek();
  assert.equal(after.nStarts, 1);
  assert.ok(after.mu > 1.2);
  engine.debutRatings = null;
  assert.deepEqual(peek(), after);
});
