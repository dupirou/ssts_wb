import test from 'node:test';
import assert from 'node:assert/strict';

import { PaceTracker } from '../src/prediction/pace-model.mjs';
import { IncidentRiskModel } from '../src/prediction/incident-model.mjs';
import { simulateRound } from '../src/prediction/monte-carlo.mjs';

function makeRound(bigQ = 2, smallQPlanned = 2, pInc = 0.04) {
  const heats = [];
  for (let h = 1; h <= 4; h++) {
    const participants = [];
    for (let i = 0; i < 5; i++) {
      participants.push({
        athlete_id: `skr-${h}-${i}`,
        starting_position: i + 1,
        s_score: 1.2 - 0.6 * i,
        p_pen: pInc * 0.9,
        p_dnf: pInc * 0.1,
        z_pace: 0.4 - 0.2 * i,
      });
    }
    heats.push({
      id: `heat-${h}`,
      big_q: bigQ,
      small_q_planned: smallQPlanned,
      small_q_from_place: bigQ + 1,
      heat_pace: {
        expectedTimeS: 41.8,
        paceDeltaS: -0.2,
        paceLabel: 'medium',
        sigmaHeat: 0.6,
        gapBeta: [0.1, 0.25, 0.14],
        sigmaGap: 0.3,
        timeScale: 1.2,
      },
      participants,
    });
  }
  return {
    heats,
    bigQ,
    smallQPlanned,
    smallQFromPlace: bigQ + 1,
  };
}

test('Monte Carlo enforces strict conservation, seeded reproducibility, and <200ms latency', () => {
  // 8 heats x 5 skaters = 40 skaters at N=10,000
  const base = makeRound(2, 2, 0.04);
  const eightHeats = [
    ...base.heats,
    ...base.heats.map((h, idx) => ({
      ...h,
      id: `heat-${idx + 5}`,
      participants: h.participants.map((p) => ({ ...p, athlete_id: `${p.athlete_id}-x` })),
    })),
  ];
  const roundInput = { heats: eightHeats, bigQ: 2, smallQPlanned: 2, smallQFromPlace: 3 };

  const t0 = performance.now();
  const out1 = simulateRound(roundInput, { iterations: 10000, seed: 12345 });
  const elapsedMs = performance.now() - t0;
  const out2 = simulateRound(roundInput, { iterations: 10000, seed: 12345 });

  assert.deepEqual(out1, out2);
  assert.ok(elapsedMs < 200, `Expected <200ms for 8x5 round @10k iters, took ${elapsedMs.toFixed(1)}ms`);

  let totalSmallQ = 0;
  for (const h of out1.heats) {
    const sumFirst = h.people.reduce((a, p) => a + p.p_first, 0);
    assert.ok(Math.abs(sumFirst - 1.0) < 1e-9, `p_first sum ${sumFirst} != 1`);
    for (const p of h.people) {
      totalSmallQ += p.p_small_q;
      assert.ok(Math.abs(p.p_total_advance - (p.p_big_q + p.p_small_q)) < 1e-12);
      assert.ok(Math.abs(p.p_incident - (p.p_pen + p.p_dnf)) < 1e-12);
    }
  }
  assert.ok(Math.abs(totalSmallQ - 2.0) < 1e-4, `Small-q sum ${totalSmallQ} != 2.0`);
});

test('ADV in completedHeats reduces q_actual and mid-round times shift Small-q monotonically', () => {
  const roundFast = makeRound(2, 2, 0.02);
  const roundSlow = makeRound(2, 2, 0.02);

  const completedFast = [
    {
      id: 'heat-1',
      participants: [
        { athlete_id: 'skr-1-0', status: 'OK', rank: 1, qual_type: 'Q', time_s: 40.4 },
        { athlete_id: 'skr-1-1', status: 'OK', rank: 2, qual_type: 'Q', time_s: 40.5 },
        { athlete_id: 'skr-1-2', status: 'OK', rank: 3, qual_type: 'OUT', time_s: 40.6 },
      ],
    },
    {
      id: 'heat-2',
      participants: [
        { athlete_id: 'skr-2-0', status: 'OK', rank: 1, qual_type: 'Q', time_s: 40.5 },
        { athlete_id: 'skr-2-1', status: 'OK', rank: 2, qual_type: 'Q', time_s: 40.6 },
        { athlete_id: 'skr-2-2', status: 'OK', rank: 3, qual_type: 'OUT', time_s: 40.7 },
      ],
    },
  ];
  const completedSlow = completedFast.map((h) => ({
    ...h,
    participants: h.participants.map((p, idx) =>
      idx === 2 ? { ...p, time_s: p.time_s + 3.0 } : p
    ),
  }));

  const outFast = simulateRound(
    { ...roundFast, completedHeats: completedFast },
    { iterations: 5000, seed: 77 }
  );
  const outSlow = simulateRound(
    { ...roundSlow, completedHeats: completedSlow },
    { iterations: 5000, seed: 77 }
  );

  // Pending heats 3 & 4 must get strictly more Small-q when finished heats 1 & 2 ran slowly.
  const pendingSmallQFast = outFast.heats
    .slice(2)
    .flatMap((h) => h.people)
    .reduce((a, p) => a + p.p_small_q, 0);
  const pendingSmallQSlow = outSlow.heats
    .slice(2)
    .flatMap((h) => h.people)
    .reduce((a, p) => a + p.p_small_q, 0);
  assert.ok(
    pendingSmallQSlow > pendingSmallQFast + 0.5,
    `Expected slow completed heats (${pendingSmallQSlow}) > fast (${pendingSmallQFast})`
  );

  // ADV reduces available Small-q slots strictly: 1 ADV -> q_actual=1, 2 ADV -> q_actual=0
  const completedWithAdv = [
    {
      ...completedSlow[0],
      participants: [
        ...completedSlow[0].participants,
        { athlete_id: 'skr-1-4', status: 'ADV', rank: 4, qual_type: 'ADV', qual_target: 'NEXT' },
      ],
    },
    completedSlow[1],
  ];
  const outAdv = simulateRound(
    { ...roundSlow, completedHeats: completedWithAdv },
    { iterations: 3000, seed: 77 }
  );
  assert.equal(outAdv.n_adv_completed, 1);
  assert.equal(outAdv.q_actual, 1);
  const totalAdvSmallQ = outAdv.heats.flatMap((h) => h.people).reduce((a, p) => a + p.p_small_q, 0);
  assert.ok(Math.abs(totalAdvSmallQ - 1.0) < 1e-4);
});

test('Incident decoupling lowers top favorite P(Big Q) and lifts #3 contender vs what_if_clean', () => {
  const round = makeRound(2, 0, 0.12);
  // Make clear separation: #0 and #1 clear favorites, #2 third-best
  round.heats = [round.heats[0]];
  round.heats[0].participants = [
    { athlete_id: 'fav1', starting_position: 1, s_score: 2.5, p_pen: 0.10, p_dnf: 0.02, z_pace: 0 },
    { athlete_id: 'fav2', starting_position: 2, s_score: 2.2, p_pen: 0.10, p_dnf: 0.02, z_pace: 0 },
    { athlete_id: 'third', starting_position: 3, s_score: 0.5, p_pen: 0.01, p_dnf: 0.0, z_pace: 0 },
    { athlete_id: 'back', starting_position: 4, s_score: -1.5, p_pen: 0.01, p_dnf: 0.0, z_pace: 0 },
  ];
  const res = simulateRound(round, { iterations: 10000, seed: 99 });
  const fav1 = res.heats[0].people[0];
  const third = res.heats[0].people[2];

  assert.ok(fav1.p_big_q < fav1.what_if_clean.p_big_q - 0.05);
  assert.ok(third.p_big_q > third.what_if_clean.p_big_q + 0.05);
});

test('PaceTracker and IncidentRiskModel learn causally without future leakage', () => {
  const pace = new PaceTracker();
  const baseRow = {
    gender: 'men',
    distance_m: 1500,
    city: 'Salt Lake City',
    round: 'semifinal',
    session_type: 'MAIN',
  };
  pace.updateHeat([
    { ...baseRow, athlete_id: 'kicker', status: 'OK', rank: 1, time_s: 136.5, lap_times_s: [18.0, 9.5, 9.5, 9.5, 8.2, 8.1] },
    { ...baseRow, athlete_id: 'fader', status: 'OK', rank: 2, time_s: 137.8, lap_times_s: [17.8, 9.4, 9.4, 9.5, 9.1, 9.3] },
  ]);
  assert.ok(pace.peekZFinish('kicker', 'men', 1500) > pace.peekZFinish('fader', 'men', 1500));
  assert.ok(pace.peekZPace('kicker', 'men', 1500) > pace.peekZPace('fader', 'men', 1500));

  const inc = new IncidentRiskModel();
  for (let i = 0; i < 8; i++) {
    inc.updateHeat([
      { season: '2025/26', distance_m: 1000, athlete_id: 'risky', status: i < 3 ? 'PEN' : 'OK', heat_size: 5, round: 'heats', session_type: 'PRELIM', starting_position: 3 },
      { season: '2025/26', distance_m: 1000, athlete_id: 'clean', status: 'OK', heat_size: 5, round: 'heats', session_type: 'PRELIM', starting_position: 1 },
      { season: '2025/26', distance_m: 1000, athlete_id: 'dns', status: 'DNS', heat_size: 5, round: 'heats', session_type: 'PRELIM', starting_position: 2 },
    ]);
  }
  const pRisky = inc.predictStarter({ season: '2025/26', distance_m: 1000, athlete_id: 'risky', heat_size: 5, round: 'heats', session_type: 'PRELIM', starting_position: 3 });
  const pClean = inc.predictStarter({ season: '2025/26', distance_m: 1000, athlete_id: 'clean', heat_size: 5, round: 'heats', session_type: 'PRELIM', starting_position: 1 });
  assert.ok(pRisky.p_pen > pClean.p_pen);
  assert.ok(pRisky.p_incident > 0 && pRisky.p_incident < 0.4);
});
