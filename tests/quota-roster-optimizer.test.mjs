import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERIC_STRONG_FIELD,
  benchmarkRankProbs,
  buildRosterProblem,
  bruteForceRosterMilp,
  createRng,
  createValueFunctions,
  evaluateAssignment,
  forecastGender,
  lambdasFromConfig,
  medalValueExact,
  relayHistoryScore,
  runMonteCarloRoster,
  selectSixReserves,
  solveRosterMilp,
  worldChampionshipConstraints,
  worldTourConstraints
} from '../src/quota-roster/optimizer.mjs';
import { loadQuotaRulesConfig } from '../src/quota-roster/fusion.mjs';

function makeSyntheticPool(n, seed = 101) {
  const rng = createRng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const tier = i < 6 ? 2.4 - 0.15 * i : i < 12 ? 1.4 - 0.1 * (i - 6) : 0.2 - 0.12 * (i - 12);
    const isDual = i >= 10 && i <= 14;
    out.push({
      athlete_id: `skr-syn-${String(i + 1).padStart(2, '0')}`,
      official_skater_id: 9000 + i,
      name_en: `Skater ${i + 1}`,
      name_zh: `选手${i + 1}`,
      gender: 'women',
      birth_date: isDual ? '2008-05-10' : '2002-03-15',
      age_group: isDual ? 'DUAL_ELIGIBLE' : 'SENIOR_ONLY',
      is_dual_eligible: isDual,
      data_sources: isDual ? ['JWC', 'Domestic'] : ['Senior'],
      last_active_date: '2026-11-10',
      recent_highlight: isDual ? 'JWC1 Bormio 1000m #4' : 'WT2 Montreal 500m #6',
      distances: {
        500: { mu: tier + rng.nextNormal() * 0.45, sigma: 0.55 + rng.nextUniform() * 0.55 },
        1000: { mu: tier + rng.nextNormal() * 0.45, sigma: 0.55 + rng.nextUniform() * 0.55 },
        1500: { mu: tier + rng.nextNormal() * 0.45, sigma: 0.55 + rng.nextUniform() * 0.55 }
      },
      form_momentum: Math.max(-1, Math.min(1, rng.nextUniform() * 1.4 - 0.4)),
      relay_stats: {
        senior_starts: i < 10 ? Math.max(0, 8 - i) : 0,
        senior_final_a: i < 8 ? Math.max(0, 4 - Math.floor(i / 2)) : 0,
        junior_starts: isDual ? 5 : 0,
        junior_final_a: isDual ? 3 : 0,
        domestic_relay_member: i >= 8 && i < 16
      }
    });
  }
  return out;
}

test('4D value scoring: nonlinear PL medal EV rewards elite contenders over mediocre all-rounders', () => {
  const vElite = medalValueExact(3.6, GENERIC_STRONG_FIELD.slice(0, 5), 500);
  const vBubble = medalValueExact(2.2, GENERIC_STRONG_FIELD.slice(0, 5), 500);
  const vMediocre = medalValueExact(1.2, GENERIC_STRONG_FIELD.slice(0, 5), 500);
  const vTail = medalValueExact(0.2, GENERIC_STRONG_FIELD.slice(0, 5), 500);
  assert.ok(vElite > 2 * vBubble, `expected elite (${vElite}) > 2 * bubble (${vBubble})`);
  assert.ok(vElite > 5 * vMediocre, `expected elite (${vElite}) > 5 * mediocre (${vMediocre})`);
  assert.ok(vMediocre > 2 * vTail, `expected mediocre (${vMediocre}) > 2 * tail (${vTail})`);
  // Convexity: 1 elite single-distance contender outweighs 3 mediocre all-rounder entries
  assert.ok(vElite + 2 * vTail > 3 * vMediocre);

  // Marginal gain near the elite frontier exceeds marginal gain in the tail
  const dElite =
    medalValueExact(3.5, GENERIC_STRONG_FIELD.slice(0, 5), 500) -
    medalValueExact(3.0, GENERIC_STRONG_FIELD.slice(0, 5), 500);
  const dTail =
    medalValueExact(0.5, GENERIC_STRONG_FIELD.slice(0, 5), 500) -
    medalValueExact(0.0, GENERIC_STRONG_FIELD.slice(0, 5), 500);
  assert.ok(dElite > 5 * dTail);

  // Rank probabilities sum cleanly and stay in [0, 1]
  const { pRank, pTop } = benchmarkRankProbs(2.8, GENERIC_STRONG_FIELD.slice(0, 5), undefined, 500);
  const sumMedals = pRank.slice(0, 3).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumMedals - pTop(3)) < 1e-12);
  assert.ok(pTop(4) >= pTop(3) && pTop(3) >= 0 && pTop(4) <= 1);

  // Relay history score saturates monotonically in [0, 1]
  const r0 = relayHistoryScore({ senior_starts: 0 });
  const r2 = relayHistoryScore({ senior_starts: 2, senior_final_a: 1 });
  const r8 = relayHistoryScore({ senior_starts: 8, senior_final_a: 6, domestic_relay_member: true });
  assert.equal(r0, 0);
  assert.ok(r2 > r0 && r8 > r2 && r8 <= 1.0);
});

test('Exact 0-1 MILP DP matches brute-force enumeration across 60 diverse random & edge cases', () => {
  const rng = createRng(202627);
  for (let trial = 0; trial < 60; trial++) {
    const pool = Array.from({ length: 6 }, (_, i) => ({
      athlete_id: `bf-${i}`,
      distances: {
        500: { mu: rng.nextNormal() * 2.0 + 0.5, sigma: 0.7 },
        1000: { mu: rng.nextNormal() * 2.0 + 0.5, sigma: 0.7 },
        1500: { mu: rng.nextNormal() * 2.0 + 0.5, sigma: 0.7 }
      },
      form_momentum: rng.nextUniform() * 2 - 1,
      relay_stats: { senior_starts: trial % 5, senior_final_a: trial % 3 }
    }));

    const blocked =
      trial % 3 === 0 ? { 'bf-0': [500], 'bf-2': [1000, 1500] } : trial % 7 === 0 ? { 'bf-1': [500, 1000, 1500] } : null;
    const forcedIds = trial % 4 === 0 ? ['bf-1'] : trial % 4 === 1 ? ['bf-1', 'bf-4'] : [];

    const problem = buildRosterProblem(pool, { blockedDistancesByAthlete: blocked, forcedIds });
    const constraints = {
      nMax: 3 + (trial % 2),
      k: [2 + (trial % 2), 2, 1 + (trial % 2)],
      relayRequired: trial % 2 === 0 ? 3 : 0
    };
    const lambdas = {
      relay: 0.42,
      form: trial % 5 === 0 ? 0.6 : 0.14,
      fatigue: trial % 3 === 0 ? 0.75 : 0.22
    };

    const dpSol = solveRosterMilp(problem, constraints, lambdas);
    const bfSol = bruteForceRosterMilp(problem, constraints, lambdas);

    assert.equal(dpSol.feasible, bfSol.feasible, `trial ${trial} feasibility mismatch`);
    if (dpSol.feasible) {
      assert.ok(
        Math.abs(dpSol.objective - bfSol.objective) < 1e-9,
        `trial ${trial} obj DP=${dpSol.objective} vs BF=${bfSol.objective}`
      );
      const reconObj = evaluateAssignment(
        problem,
        dpSol.selected.map((idx, k) => [idx, dpSol.patterns[k]]),
        lambdas
      );
      assert.ok(Math.abs(reconObj - dpSol.objective) < 1e-9);
      // Verify all constraints hold on reconstructed solution
      assert.ok(dpSol.selected.length <= constraints.nMax);
      assert.equal(dpSol.entries.relay.length, constraints.relayRequired);
      assert.ok(dpSol.entries[500].length <= constraints.k[0]);
      assert.ok(dpSol.entries[1000].length <= constraints.k[1]);
      assert.ok(dpSol.entries[1500].length <= constraints.k[2]);
      for (const id of forcedIds) {
        const idx = problem.ids.indexOf(id);
        assert.ok(dpSol.selected.includes(idx), `forced ${id} missing`);
      }
    }
  }
});

test('Cumulative penalty ban mask strictly excludes blocked (athlete, distance) pairs in MILP & MC', () => {
  const pool = makeSyntheticPool(12, 77);
  const starId = pool[0].athlete_id;
  // Boost starId so without ban they would be 100% locked for 500m & 1000m
  pool[0].distances[500] = { mu: 4.2, sigma: 0.15 };
  pool[0].distances[1000] = { mu: 4.0, sigma: 0.15 };
  pool[0].distances[1500] = { mu: 3.5, sigma: 0.15 };

  const cons = { nMax: 6, k: [3, 3, 3], relayRequired: 4 };
  const unbanned = runMonteCarloRoster(pool, { constraints: cons, draws: 100, seed: 202627 });
  const starUnbanned = unbanned.candidates.find((c) => c.athlete_id === starId);
  assert.ok(starUnbanned.entry_prob_matrix[500] > 0.95);
  assert.ok(starUnbanned.entry_prob_matrix[1000] > 0.95);

  // Ban starId from 500m and 1000m
  const banned = runMonteCarloRoster(pool, {
    constraints: cons,
    draws: 100,
    seed: 202627,
    blockedDistancesByAthlete: { [starId]: [500, 1000] }
  });
  const starBanned = banned.candidates.find((c) => c.athlete_id === starId);
  assert.equal(starBanned.entry_prob_matrix[500], 0);
  assert.equal(starBanned.entry_prob_matrix[1000], 0);
  assert.ok(starBanned.entry_prob_matrix[1500] > 0.95);
  assert.ok(!banned.preferred_main_roster.entries[500].includes(starId));
  assert.ok(!banned.preferred_main_roster.entries[1000].includes(starId));
});

test('lambda_fatigue trade-off reduces 3-distance entries monotonically as penalty rises', () => {
  const pool = makeSyntheticPool(12, 55);
  // Make candidates 0..3 strong across all 3 distances
  for (let i = 0; i < 4; i++) {
    pool[i].distances[500].mu = 3.0 - 0.1 * i;
    pool[i].distances[1000].mu = 3.0 - 0.1 * i;
    pool[i].distances[1500].mu = 3.0 - 0.1 * i;
  }
  const problem = buildRosterProblem(pool);
  const cons = { nMax: 6, k: [3, 3, 3], relayRequired: 4 };

  const count3Dist = (sol) =>
    sol.patterns.filter((p) => (p & 1) + ((p >> 1) & 1) + ((p >> 2) & 1) === 3).length;

  const sLow = solveRosterMilp(problem, cons, { relay: 0.42, form: 0.14, fatigue: 0.0 });
  const sMid = solveRosterMilp(problem, cons, { relay: 0.42, form: 0.14, fatigue: 0.22 });
  const sHigh = solveRosterMilp(problem, cons, { relay: 0.42, form: 0.14, fatigue: 0.85 });

  assert.ok(count3Dist(sLow) >= count3Dist(sMid));
  assert.ok(count3Dist(sMid) >= count3Dist(sHigh));
  assert.ok(count3Dist(sLow) > count3Dist(sHigh), `expected 3-dist drop: ${count3Dist(sLow)} -> ${count3Dist(sHigh)}`);
  assert.equal(count3Dist(sHigh), 0);
});

test('Dual-eligible sensitivity: JWC/domestic gold medal boost jumps rank & reserve/main probability', () => {
  const cfg = loadQuotaRulesConfig();
  const basePool = makeSyntheticPool(18, 303);
  // Pick dual-eligible candidate skr-syn-13 (index 12, initially outside main 6)
  const targetId = 'skr-syn-13';
  const cons = worldTourConstraints(cfg);

  const before = forecastGender(basePool, { config: cfg, constraints: cons, draws: 300, seed: 202627 });
  const beforeCand = before.candidates.find((c) => c.athlete_id === targetId);
  const beforeRes = before.reserves.find((r) => r.athlete_id === targetId);

  const boostedPool = structuredClone(basePool);
  const target = boostedPool.find((c) => c.athlete_id === targetId);
  target.distances[500] = { mu: 2.95, sigma: 0.5 };
  target.distances[1000] = { mu: 2.85, sigma: 0.5 };
  target.form_momentum = 0.85;
  target.recent_highlight = 'JWC1 Bormio 500m #1';
  target.relay_stats.junior_final_a += 2;

  const after = forecastGender(boostedPool, { config: cfg, constraints: cons, draws: 300, seed: 202627 });
  const afterCand = after.candidates.find((c) => c.athlete_id === targetId);
  const afterRes = after.reserves.find((r) => r.athlete_id === targetId);

  assert.ok(
    afterCand.main_roster_prob > beforeCand.main_roster_prob + 0.25,
    `expected significant main_roster_prob jump: ${beforeCand.main_roster_prob} -> ${afterCand.main_roster_prob}`
  );
  if (afterRes && beforeRes) {
    assert.ok(afterRes.reserve_rank <= beforeRes.reserve_rank);
  }
});

test('6-reserve selector obeys allocation contract, zero overlap with main roster, and deterministic seeding', () => {
  const cfg = loadQuotaRulesConfig();
  const pool = makeSyntheticPool(25, 2026);
  const cons = worldChampionshipConstraints(cfg, 'women');

  const resA = forecastGender(pool, { config: cfg, constraints: cons });
  const resB = forecastGender(pool, { config: cfg, constraints: cons });
  assert.deepEqual(resA.preferred_main_roster, resB.preferred_main_roster);
  assert.deepEqual(resA.reserves, resB.reserves);

  assert.equal(resA.draws, 1000);
  assert.equal(resA.feasible_draws, 1000);
  assert.ok(resA.top_3_lineups.length >= 1 && resA.top_3_lineups.length <= 3);

  const mainSet = new Set(resA.preferred_main_roster.athlete_ids);
  assert.equal(resA.reserves.length, 6);
  const tagCounts = { sprint_relay: 0, mid_long: 0, versatile_upside: 0 };
  for (let i = 0; i < resA.reserves.length; i++) {
    const r = resA.reserves[i];
    assert.equal(r.reserve_rank, i + 1);
    assert.ok(!mainSet.has(r.athlete_id));
    assert.ok(r.role_tag in tagCounts);
    tagCounts[r.role_tag]++;
    assert.ok(mainSet.has(r.primary_replacement_for));
    assert.equal(typeof r.marginal_loss, 'number');
    assert.equal(typeof r.is_dual_eligible, 'boolean');
    assert.ok(Array.isArray(r.data_sources));
    assert.ok('recent_highlight' in r);
    assert.ok('name_en' in r && 'name_zh' in r);
  }
  assert.deepEqual(tagCounts, { sprint_relay: 2, mid_long: 2, versatile_upside: 2 });
});

test('Performance: 1,000 MC MILP draws + 6 reserves completes in < 2.0 s per gender', () => {
  const cfg = loadQuotaRulesConfig();
  // Pre-warm LUT once (shared across genders in production)
  createValueFunctions();

  for (const [label, seed, cons] of [
    ['WT_3_3_3', 11, worldTourConstraints(cfg)],
    ['WC_women_3_3_2', 22, worldChampionshipConstraints(cfg, 'women')],
    ['WC_men_3_2_2', 33, worldChampionshipConstraints(cfg, 'men')]
  ]) {
    const pool = makeSyntheticPool(25, seed);
    const t0 = performance.now();
    const out = forecastGender(pool, { config: cfg, constraints: cons, lambdas: lambdasFromConfig(cfg) });
    const elapsedMs = performance.now() - t0;
    assert.equal(out.reserves.length, 6);
    assert.ok(
      elapsedMs < 2000,
      `${label} took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`
    );
  }
});
