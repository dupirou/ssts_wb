/**
 * Module 4: CHN roster optimizer (pure ESM, zero third-party deps).
 *
 * - 4D candidate value scoring: individual medal / A-Final EV V_{i,d} (exact Plackett-Luce
 *   benchmark against a calibrated "Standard Strong International Field"), relay contribution R_i,
 *   form momentum M_i and the 3-distance fatigue penalty.
 * - Exact 0-1 MILP solver via dynamic programming over the resource lattice
 *   (cnt_x, cnt_500, cnt_1000, cnt_1500, cnt_relay) with flat Float64Array values and per-layer
 *   Uint8Array backpointers. Globally optimal (verified against brute force in tests).
 * - 1,000-draw seeded Monte Carlo (Mulberry32 + Box-Muller) over mu ~ N(mu, sigma^2) and
 *   +/- perturbed lambda_relay / lambda_fatigue.
 * - 6-reserve marginal replacement selector.
 *
 * MILP (per gender):
 *   max  sum_{i,d} V_{i,d} y_{i,d} + l_relay * sum_i R_i r_i + l_form * sum_i M_i x_i - l_fat * sum_i z_i
 *   s.t. sum_i x_i <= N_max ; sum_i y_{i,d} <= K_d ; y_{i,d} <= x_i ; r_i <= x_i
 *        sum_i r_i == R_req (4 with gender relay, else 0) ; y_{i,d} = 0 for banned (i, d)
 *        sum_d y_{i,d} - 2 <= z_i ; x, y, r, z binary.
 */

import { scoresToWeights, topPlaces } from '../prediction/plackett-luce.mjs';

export const DISTANCES = Object.freeze([500, 1000, 1500]);
const DIST_BIT = { 500: 1, 1000: 2, 1500: 4 };
const RELAY_BIT = 8;
const NEG_INF = -Infinity;

/** Generic 7-deep elite field (log-strength scale of src/prediction/rating.mjs), test default. */
export const GENERIC_STRONG_FIELD = Object.freeze([3.6, 3.3, 3.1, 2.9, 2.7, 2.5, 2.3]);

export const DEFAULT_VALUE_MODEL = Object.freeze({
  plScale: 1.0,
  // Opponents in the benchmark race: 5 for 500/1000 (6-skater benchmark), 7 for 1500 (8-skater).
  fieldSize: { 500: 5, 1000: 5, 1500: 7 },
  medalWeights: [1.0, 0.75, 0.55],
  aFinalPlaces: { 500: 4, 1000: 4, 1500: 5 },
  aFinalWeight: 0.25,
  lutMin: -6,
  lutMax: 9,
  lutStep: 0.01
});

export const DEFAULT_RELAY_MODEL = Object.freeze({
  saturationStarts: 4,
  seniorParticipation: 0.45,
  seniorFinalA: 0.3,
  juniorParticipation: 0.06,
  juniorFinalA: 0.04,
  domesticMember: 0.06,
  historyWeight: 0.55,
  blendWeight: 0.45,
  blend500: 0.55,
  blend1000: 0.45
});

// ------------------------------------------------------------------------------------------------
// Deterministic PRNG
// ------------------------------------------------------------------------------------------------

/** Mulberry32 uniform stream + Box-Muller Gaussian (cached spare). */
export function createRng(seed = 202627) {
  let state = seed >>> 0;
  let hasSpare = false;
  let spare = 0;
  function nextUniform() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  }
  function nextNormal() {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    const mag = Math.sqrt(-2 * Math.log(nextUniform()));
    const ang = 2 * Math.PI * nextUniform();
    spare = mag * Math.sin(ang);
    hasSpare = true;
    return mag * Math.cos(ang);
  }
  return { nextUniform, nextNormal };
}

// ------------------------------------------------------------------------------------------------
// 1. Value scoring
// ------------------------------------------------------------------------------------------------

/**
 * Exact PL rank distribution of a target skater (index 0) against fixed opponents:
 * returns { pRank: [P(1), P(2), ...], pTop(k) }.
 */
export function benchmarkRankProbs(mu, fieldMus, model = DEFAULT_VALUE_MODEL, distance = 500) {
  const scale = model.plScale || 1;
  const scores = [mu / scale, ...fieldMus.map((m) => m / scale)];
  const weights = scoresToWeights(scores);
  const n = weights.length;
  const maxK = Math.max(model.medalWeights.length, model.aFinalPlaces[distance] || 0);
  const tops = [0];
  for (let k = 1; k <= Math.min(maxK, n); k++) tops.push(topPlaces(weights, k)[0]);
  const pRank = [];
  for (let k = 1; k < tops.length; k++) pRank.push(tops[k] - tops[k - 1]);
  const pTop = (k) => (k <= 0 ? 0 : k >= tops.length ? 1 : tops[k]);
  return { pRank, pTop };
}

/** Raw (non-LUT) medal + A-Final expected value of a skater with skill mu. */
export function medalValueExact(mu, fieldMus, distance, model = DEFAULT_VALUE_MODEL) {
  const { pRank, pTop } = benchmarkRankProbs(mu, fieldMus, model, distance);
  let v = 0;
  for (let k = 0; k < model.medalWeights.length && k < pRank.length; k++) {
    v += model.medalWeights[k] * pRank[k];
  }
  v += model.aFinalWeight * pTop(model.aFinalPlaces[distance] || 0);
  return v;
}

const VALUE_FN_CACHE = new Map();

/**
 * Builds a monotone nonlinear value function mu -> V(mu) for one distance, tabulated on a fine
 * grid (exact PL at grid nodes, linear interpolation in between, clamped at the ends).
 */
export function createValueFunction(fieldMus, distance, model = DEFAULT_VALUE_MODEL) {
  const size = model.fieldSize?.[distance] ?? fieldMus.length;
  const field = [...fieldMus].sort((a, b) => b - a).slice(0, size);
  const key = JSON.stringify([field, distance, model]);
  const cached = VALUE_FN_CACHE.get(key);
  if (cached) return cached;
  const { lutMin, lutMax, lutStep } = model;
  const nPts = Math.round((lutMax - lutMin) / lutStep) + 1;
  const lut = new Float64Array(nPts);
  for (let i = 0; i < nPts; i++) lut[i] = medalValueExact(lutMin + i * lutStep, field, distance, model);
  const inv = 1 / lutStep;
  const fn = (mu) => {
    if (!(mu > lutMin)) return lut[0];
    if (mu >= lutMax) return lut[nPts - 1];
    const t = (mu - lutMin) * inv;
    const i = t | 0;
    const f = t - i;
    return lut[i] + f * (lut[i + 1] - lut[i]);
  };
  fn.field = field;
  fn.distance = distance;
  VALUE_FN_CACHE.set(key, fn);
  return fn;
}

/** Value functions for the three distances from { 500: [...], 1000: [...], 1500: [...] }. */
export function createValueFunctions(fieldByDistance = {}, model = DEFAULT_VALUE_MODEL) {
  const out = {};
  for (const d of DISTANCES) {
    out[d] = createValueFunction(fieldByDistance[d] || GENERIC_STRONG_FIELD, d, model);
  }
  return out;
}

/**
 * Derives the Standard Strong International Field (top-N non-excluded active skaters by mu) from
 * a serialized DynamicRatingEngine state ({ disciplines: { 'women:500': { id: [mu, sigma, ts] } } }).
 */
export function buildStandardField(ratingState, athleteCountries, gender, distance, opts = {}) {
  const {
    excludeCountries = ['CHN'],
    activeSinceMs = null,
    size = DEFAULT_VALUE_MODEL.fieldSize[distance]
  } = opts;
  const obj = ratingState?.disciplines?.[`${gender}:${distance}`] || {};
  const mus = [];
  for (const [aid, arr] of Object.entries(obj)) {
    if (excludeCountries.includes(athleteCountries?.[aid])) continue;
    if (activeSinceMs != null && !(arr[2] >= activeSinceMs)) continue;
    mus.push(arr[0]);
  }
  mus.sort((a, b) => b - a);
  return mus.length ? mus.slice(0, size) : GENERIC_STRONG_FIELD.slice(0, size);
}

const MISSING_DISTANCE = Object.freeze({ mu: -2.0, sigma: 1.2 });

function distStat(cand, d) {
  const s = cand.distances?.[d] ?? cand.distances?.[String(d)];
  if (!s || !Number.isFinite(s.mu)) return MISSING_DISTANCE;
  return { mu: s.mu, sigma: Number.isFinite(s.sigma) && s.sigma > 0 ? s.sigma : 1.0 };
}

/** Historical relay participation component in [0, 1]. */
export function relayHistoryScore(relayStats = {}, model = DEFAULT_RELAY_MODEL) {
  const sat = (n) => 1 - Math.exp(-Math.max(0, n || 0) / model.saturationStarts);
  const rate = (fa, st) => (st > 0 ? Math.min(1, Math.max(0, (fa || 0) / st)) : 0);
  const s = relayStats || {};
  const seniorStarts = Number.isFinite(s.senior_weighted_starts)
    ? s.senior_weighted_starts
    : s.senior_starts;
  const seniorFinalA = Number.isFinite(s.senior_weighted_final_a)
    ? s.senior_weighted_final_a
    : s.senior_final_a;
  return (
    model.seniorParticipation * sat(seniorStarts) +
    model.seniorFinalA * rate(seniorFinalA, seniorStarts) +
    model.juniorParticipation * sat(s.junior_starts) +
    model.juniorFinalA * rate(s.junior_final_a, s.junior_starts) +
    model.domesticMember * (s.domestic_relay_member ? 1 : 0)
  );
}

function minMax(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 1e-9 ? { lo, span: hi - lo } : { lo: lo - 0.5, span: 1 };
}

function normClamp(x, n) {
  const v = (x - n.lo) / n.span;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toBlockedMap(blocked) {
  const m = new Map();
  if (!blocked) return m;
  const entries = blocked instanceof Map ? blocked.entries() : Object.entries(blocked);
  for (const [id, list] of entries) {
    let mask = 0;
    for (const d of list || []) mask |= DIST_BIT[parseInt(String(d), 10)] || 0;
    if (mask) m.set(id, mask);
  }
  return m;
}

/**
 * Scores candidates into a typed roster problem.
 * @returns {{ n, ids, V: Float64Array, R: Float64Array, M: Float64Array, blocked: Uint8Array,
 *   forced: Uint8Array, mu: Float64Array, sigma: Float64Array, relayHist: Float64Array,
 *   norms, valueFns, relayModel }}
 */
export function buildRosterProblem(candidates, opts = {}) {
  const {
    valueFns = createValueFunctions(opts.fieldByDistance, opts.valueModel),
    relayModel = DEFAULT_RELAY_MODEL,
    blockedDistancesByAthlete = null,
    forcedIds = []
  } = opts;
  const n = candidates.length;
  const ids = candidates.map((c) => c.athlete_id);
  const mu = new Float64Array(n * 3);
  const sigma = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const s = distStat(candidates[i], DISTANCES[k]);
      mu[i * 3 + k] = s.mu;
      sigma[i * 3 + k] = s.sigma;
    }
  }
  const norms = {
    500: minMax(Array.from({ length: n }, (_, i) => mu[i * 3])),
    1000: minMax(Array.from({ length: n }, (_, i) => mu[i * 3 + 1]))
  };
  const blockedMap = toBlockedMap(blockedDistancesByAthlete);
  const forcedSet = new Set(forcedIds);
  const riskAversion =
    opts.riskAversion ??
    opts.config?.roster_model?.objective_weights?.uncertainty_risk_aversion ??
    0.35;
  const top40ProtectWeight = Number(opts.top40ProtectWeight ?? 0) || 0;
  const top40Counts = [0, 0, 0];
  const top40Flags = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const list = candidates[i].world_ranking_top40_distances;
    if (!Array.isArray(list)) continue;
    for (const rawD of list) {
      const d = parseInt(String(rawD), 10);
      const k = DISTANCES.indexOf(d);
      if (k >= 0 && !top40Flags[i * 3 + k]) {
        top40Flags[i * 3 + k] = 1;
        top40Counts[k]++;
      }
    }
  }
  const top40Bonus = new Float64Array(n * 3);
  if (top40ProtectWeight !== 0) {
    for (let k = 0; k < 3; k++) {
      const cnt = opts.top40Counts?.[DISTANCES[k]] ?? top40Counts[k];
      const urgency = cnt <= 3 ? 1.6 : cnt === 4 ? 1.0 : 0.4;
      const bonus = top40ProtectWeight * urgency;
      for (let i = 0; i < n; i++) {
        if (top40Flags[i * 3 + k]) top40Bonus[i * 3 + k] = bonus;
      }
    }
  }
  const problem = {
    n,
    ids,
    candidates,
    V: new Float64Array(n * 3),
    top40Bonus,
    top40ProtectWeight,
    R: new Float64Array(n),
    M: new Float64Array(n),
    blocked: new Uint8Array(n),
    forced: new Uint8Array(n),
    mu,
    sigma,
    riskAversion,
    relayHist: new Float64Array(n),
    norms,
    valueFns,
    relayModel
  };
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    problem.relayHist[i] = relayHistoryScore(c.relay_stats, relayModel);
    const fm = Number(c.form_momentum);
    problem.M[i] = Number.isFinite(fm) ? Math.max(-1, Math.min(1, fm)) : 0;
    problem.blocked[i] = blockedMap.get(c.athlete_id) || 0;
    problem.forced[i] = forcedSet.has(c.athlete_id) ? 1 : 0;
  }
  scoreProblemInPlace(problem, mu);
  return problem;
}

/** Recomputes V and R from a (possibly sampled) mu vector with Bayesian risk aversion. */
export function scoreProblemInPlace(problem, muVec) {
  const { n, V, R, sigma, riskAversion = 0, valueFns, relayModel, relayHist, norms } = problem;
  const f500 = valueFns[500];
  const f1000 = valueFns[1000];
  const f1500 = valueFns[1500];
  for (let i = 0; i < n; i++) {
    const b = i * 3;
    const m0 = muVec[b] - riskAversion * sigma[b];
    const m1 = muVec[b + 1] - riskAversion * sigma[b + 1];
    const m2 = muVec[b + 2] - riskAversion * sigma[b + 2];
    V[b] = f500(m0);
    V[b + 1] = f1000(m1);
    V[b + 2] = f1500(m2);
    const blend =
      relayModel.blend500 * normClamp(m0, norms[500]) +
      relayModel.blend1000 * normClamp(m1, norms[1000]);
    R[i] = relayModel.historyWeight * relayHist[i] + relayModel.blendWeight * blend;
  }
  return problem;
}

// ------------------------------------------------------------------------------------------------
// 2. Exact 0-1 MILP via dynamic programming
// ------------------------------------------------------------------------------------------------

function normConstraints(c) {
  const k = Array.isArray(c.k) ? c.k : [c.k?.[500] ?? 3, c.k?.[1000] ?? 3, c.k?.[1500] ?? 3];
  return {
    nMax: c.nMax ?? 6,
    k500: k[0],
    k1000: k[1],
    k1500: k[2],
    relay: c.relayRequired ?? (c.hasGenderRelay === false ? 0 : 4)
  };
}

function popcount3(p) {
  return (p & 1) + ((p >> 1) & 1) + ((p >> 2) & 1);
}

/** Objective of pattern p (bits 500/1000/1500/relay) for candidate i. */
function patternValue(problem, i, p, lambdas) {
  const b = i * 3;
  const { V, top40Bonus } = problem;
  let v = lambdas.form * problem.M[i];
  if (p & 1) v += V[b] + (top40Bonus ? top40Bonus[b] : 0);
  if (p & 2) v += V[b + 1] + (top40Bonus ? top40Bonus[b + 1] : 0);
  if (p & 4) v += V[b + 2] + (top40Bonus ? top40Bonus[b + 2] : 0);
  if (p & RELAY_BIT) v += lambdas.relay * problem.R[i];
  if (popcount3(p) === 3) v -= lambdas.fatigue;
  return v;
}

/**
 * Exact candidate pruning (pattern-wise top-N_max filter using non-dominated patterns).
 */
function preparePatternsAndPrune(problem, active, nMax, rr, lambdas, isForced, doPrune) {
  const m = active.length;
  const pvAll = new Float64Array(m * 16);
  const domAll = new Uint8Array(m * 16);
  for (let ai = 0; ai < m; ai++) {
    const i = active[ai];
    const bl = problem.blocked[i];
    const forced = isForced(i);
    const base = ai * 16;
    for (let p = 0; p < 16; p++) {
      if ((p & bl) !== 0 || (rr === 0 && (p & RELAY_BIT) !== 0)) {
        pvAll[base + p] = NEG_INF;
        domAll[base + p] = 1;
      } else {
        pvAll[base + p] = patternValue(problem, i, p, lambdas);
      }
    }
    if (pvAll[base] <= 0 && !forced) domAll[base] = 1;
    for (let p = 1; p < 16; p++) {
      if (domAll[base + p]) continue;
      const rb = p & RELAY_BIT;
      const db = p & 7;
      const vp = pvAll[base + p];
      for (let q = 0; q < 16; q++) {
        if (q === p || (q & RELAY_BIT) !== rb || pvAll[base + q] === NEG_INF) continue;
        const qb = q & 7;
        if ((qb & db) === qb && qb !== db && pvAll[base + q] >= vp) {
          domAll[base + p] = 1;
          break;
        }
      }
    }
  }
  if (!doPrune || m <= nMax) {
    return { keptIdx: Array.from({ length: m }, (_, ai) => ai), pvAll, domAll };
  }
  const keep = new Uint8Array(m);
  const vals = new Float64Array(m);
  const order = new Int32Array(m);
  for (let ai = 0; ai < m; ai++) if (isForced(active[ai])) keep[ai] = 1;
  for (let p = 0; p < 16; p++) {
    if (rr === 0 && (p & RELAY_BIT) !== 0) continue;
    let any = false;
    for (let ai = 0; ai < m; ai++) {
      const v = domAll[ai * 16 + p] ? NEG_INF : pvAll[ai * 16 + p];
      vals[ai] = v;
      if (v !== NEG_INF) any = true;
      order[ai] = ai;
    }
    if (!any) continue;
    for (let t = 0; t < nMax; t++) {
      let bi = t;
      for (let u = t + 1; u < m; u++) {
        const cu = order[u];
        const cb = order[bi];
        if (vals[cu] > vals[cb] || (vals[cu] === vals[cb] && cu < cb)) bi = u;
      }
      const tmp = order[t];
      order[t] = order[bi];
      order[bi] = tmp;
      if (vals[order[t]] !== NEG_INF) keep[order[t]] = 1;
    }
  }
  const keptIdx = [];
  for (let ai = 0; ai < m; ai++) if (keep[ai]) keptIdx.push(ai);
  return { keptIdx, pvAll, domAll };
}

const LATTICE_CACHE = new Map();

/**
 * Guard-padded flat lattice over (cx, c500, c1000, c1500, cr): every coordinate is shifted by +1
 * so that coordinate 0 is a permanent -inf guard cell; s - off(p) is therefore always a valid
 * index and the inner loop needs no feasibility branch. Exact zero-start (no slack) allows
 * tightening a, b, c, r <= cx at every layer.
 */
function getLattice(nMax, k5, k10, k15, rr) {
  const key = `${nMax},${k5},${k10},${k15},${rr}`;
  let lat = LATTICE_CACHE.get(key);
  if (lat) return lat;
  const t4 = 1;
  const t3 = rr + 2;
  const t2 = (k15 + 2) * t3;
  const t1 = (k10 + 2) * t2;
  const t0 = (k5 + 2) * t1;
  const S = (nMax + 2) * t0;
  const init = new Float64Array(S).fill(NEG_INF);
  init[t0 + t1 + t2 + t3 + 1] = 0;
  const off = new Int32Array(16);
  for (let p = 0; p < 16; p++) {
    off[p] = t0 + (p & 1 ? t1 : 0) + (p & 2 ? t2 : 0) + (p & 4 ? t3 : 0) + (p & 8 ? t4 : 0);
  }
  lat = { S, t0, t1, t2, t3, init, off, dp: new Float64Array(S), choice: null, choiceLayers: 0 };
  LATTICE_CACHE.set(key, lat);
  return lat;
}

/**
 * Exact MILP solve (globally optimal; equivalent to a 0-1 MILP solver on this model).
 * @param {object} problem from buildRosterProblem (V/R/M/blocked/forced typed arrays)
 * @param {{ nMax, k: {500,1000,1500}|number[], relayRequired?, hasGenderRelay? }} constraints
 * @param {{ relay, form, fatigue }} lambdas
 * @param {{ subset?: number[], forced?: number[], prune?: boolean }} [options]
 * @returns {{ feasible, objective, selected: number[], patterns: number[],
 *   entries: {500,1000,1500,relay}, prunedPool }}
 */
export function solveRosterMilp(problem, constraints, lambdas, options = {}) {
  const c = normConstraints(constraints);
  const forcedExtra = options.forced ? new Set(options.forced) : null;
  const isForced = (i) => problem.forced[i] === 1 || (forcedExtra !== null && forcedExtra.has(i));
  const activeAll = options.subset ? [...options.subset] : Array.from({ length: problem.n }, (_, i) => i);
  const nMax = Math.min(c.nMax, activeAll.length);
  const rr = c.relay;
  if (rr > nMax) return infeasible();
  let forcedCount = 0;
  for (const i of activeAll) if (isForced(i)) forcedCount++;
  if (forcedCount > nMax) return infeasible();
  const cap = [0, 0, 0];
  for (const i of activeAll) for (let k = 0; k < 3; k++) if (!((problem.blocked[i] >> k) & 1)) cap[k]++;
  const k5 = Math.min(c.k500, cap[0], nMax);
  const k10 = Math.min(c.k1000, cap[1], nMax);
  const k15 = Math.min(c.k1500, cap[2], nMax);

  const { keptIdx, pvAll, domAll } = preparePatternsAndPrune(
    problem,
    activeAll,
    nMax,
    rr,
    lambdas,
    isForced,
    options.prune !== false
  );
  const L = keptIdx.length;

  const lat = getLattice(nMax, k5, k10, k15, rr);
  const { S, t0, t1, t2, t3, off, dp } = lat;
  dp.set(lat.init);
  if (lat.choiceLayers < L) {
    lat.choice = new Uint8Array(Math.max(L, 8) * S);
    lat.choiceLayers = Math.max(L, 8);
  }
  const choice = lat.choice;
  const pOff = new Int32Array(16);
  const pVal = new Float64Array(16);
  const pCode = new Uint8Array(16);

  let maxA = 0;
  let maxB = 0;
  let maxC = 0;

  for (let li = 0; li < L; li++) {
    const ai = keptIdx[li];
    const i = activeAll[ai];
    const pBase = ai * 16;
    const forced = isForced(i);
    let np0 = 0;
    let np = 0;
    let hasA = 0;
    let hasB = 0;
    let hasC = 0;
    for (let p = 0; p < 8; p++) {
      if (!domAll[pBase + p]) {
        pOff[np] = off[p];
        pVal[np] = pvAll[pBase + p];
        pCode[np++] = p + 1;
        if (p & 1) hasA = 1;
        if (p & 2) hasB = 1;
        if (p & 4) hasC = 1;
      }
    }
    np0 = np;
    for (let p = 8; p < 16; p++) {
      if (!domAll[pBase + p]) {
        pOff[np] = off[p];
        pVal[np] = pvAll[pBase + p];
        pCode[np++] = p + 1;
        if (p & 1) hasA = 1;
        if (p & 2) hasB = 1;
        if (p & 4) hasC = 1;
      }
    }
    if (hasA && maxA < k5) maxA++;
    if (hasB && maxB < k10) maxB++;
    if (hasC && maxC < k15) maxC++;

    const base = li * S;
    const rem = L - 1 - li;
    const rBot = Math.max(0, rr - rem);
    const rBotPos = Math.max(1, rBot);
    const cxBot = Math.max(1, rBot);
    const cxTop = Math.min(nMax, li + 1);

    if (!forced) {
      for (let cx = cxTop; cx >= cxBot; cx--) {
        const ix = (cx + 1) * t0;
        const aTop = Math.min(maxA, cx);
        const bTop = Math.min(maxB, cx);
        const cTop = Math.min(maxC, cx);
        const rTop = Math.min(rr, cx, li + 1);
        for (let a = aTop; a >= 0; a--) {
          const ia = ix + (a + 1) * t1;
          for (let b = bTop; b >= 0; b--) {
            const ib = ia + (b + 1) * t2;
            for (let cc = cTop; cc >= 0; cc--) {
              const ic = ib + (cc + 1) * t3 + 1;
              for (let r = rTop; r >= rBotPos; r--) {
                const s = ic + r;
                let best = dp[s];
                let bc = 0;
                for (let t = 0; t < np; t++) {
                  const v = dp[s - pOff[t]] + pVal[t];
                  if (v > best) {
                    best = v;
                    bc = pCode[t];
                  }
                }
                if (bc) {
                  dp[s] = best;
                  choice[base + s] = bc;
                } else {
                  choice[base + s] = 0;
                }
              }
              if (rBot === 0) {
                const s = ic;
                let best = dp[s];
                let bc = 0;
                for (let t = 0; t < np0; t++) {
                  const v = dp[s - pOff[t]] + pVal[t];
                  if (v > best) {
                    best = v;
                    bc = pCode[t];
                  }
                }
                if (bc) {
                  dp[s] = best;
                  choice[base + s] = bc;
                } else {
                  choice[base + s] = 0;
                }
              }
            }
          }
        }
      }
    } else {
      for (let cx = cxTop; cx >= cxBot; cx--) {
        const ix = (cx + 1) * t0;
        const aTop = Math.min(maxA, cx);
        const bTop = Math.min(maxB, cx);
        const cTop = Math.min(maxC, cx);
        const rTop = Math.min(rr, cx, li + 1);
        for (let a = aTop; a >= 0; a--) {
          const ia = ix + (a + 1) * t1;
          for (let b = bTop; b >= 0; b--) {
            const ib = ia + (b + 1) * t2;
            for (let cc = cTop; cc >= 0; cc--) {
              const ic = ib + (cc + 1) * t3 + 1;
              for (let r = rTop; r >= rBotPos; r--) {
                const s = ic + r;
                let best = NEG_INF;
                let bc = 0;
                for (let t = 0; t < np; t++) {
                  const v = dp[s - pOff[t]] + pVal[t];
                  if (v > best) {
                    best = v;
                    bc = pCode[t];
                  }
                }
                dp[s] = best;
                choice[base + s] = bc;
              }
              if (rBot === 0) {
                const s = ic;
                let best = NEG_INF;
                let bc = 0;
                for (let t = 0; t < np0; t++) {
                  const v = dp[s - pOff[t]] + pVal[t];
                  if (v > best) {
                    best = v;
                    bc = pCode[t];
                  }
                }
                dp[s] = best;
                choice[base + s] = bc;
              }
            }
          }
        }
      }
      // A forced candidate must be selected: zero-selection states become infeasible.
      for (let a = 0; a <= maxA; a++)
        for (let b = 0; b <= maxB; b++)
          for (let cc = 0; cc <= maxC; cc++) dp[t0 + (a + 1) * t1 + (b + 1) * t2 + (cc + 1) * t3 + 1] = NEG_INF;
    }
  }

  let bestCx = -1;
  let bestA = 0;
  let bestB = 0;
  let bestC = 0;
  let objective = NEG_INF;
  for (let cx = rr; cx <= nMax; cx++) {
    const ix = (cx + 1) * t0;
    for (let a = 0; a <= maxA; a++) {
      const ia = ix + (a + 1) * t1;
      for (let b = 0; b <= maxB; b++) {
        const ib = ia + (b + 1) * t2;
        for (let cc = 0; cc <= maxC; cc++) {
          const v = dp[ib + (cc + 1) * t3 + rr + 1];
          if (v > objective) {
            objective = v;
            bestCx = cx;
            bestA = a;
            bestB = b;
            bestC = cc;
          }
        }
      }
    }
  }
  if (objective === NEG_INF) return infeasible();
  const selected = [];
  const patterns = [];
  const entries = { 500: [], 1000: [], 1500: [], relay: [] };
  let s = (bestCx + 1) * t0 + (bestA + 1) * t1 + (bestB + 1) * t2 + (bestC + 1) * t3 + rr + 1;
  let cxLeft = bestCx;
  for (let li = L - 1; li >= 0 && cxLeft > 0; li--) {
    const ch = choice[li * S + s];
    if (ch === 0) continue;
    const p = ch - 1;
    const i = activeAll[keptIdx[li]];
    selected.push(i);
    patterns.push(p);
    if (p & 1) entries[500].push(i);
    if (p & 2) entries[1000].push(i);
    if (p & 4) entries[1500].push(i);
    if (p & RELAY_BIT) entries.relay.push(i);
    s -= off[p];
    cxLeft--;
  }
  return { feasible: true, objective, selected, patterns, entries, prunedPool: L };
}

function infeasible() {
  return {
    feasible: false,
    objective: NEG_INF,
    selected: [],
    patterns: [],
    entries: { 500: [], 1000: [], 1500: [], relay: [] },
    prunedPool: 0
  };
}

/** Objective of an explicit assignment (index -> pattern), used for verification. */
export function evaluateAssignment(problem, assignment, lambdas) {
  let v = 0;
  for (const [i, p] of assignment) v += patternValue(problem, i, p, lambdas);
  return v;
}

/**
 * Brute-force reference solver (enumerates every pattern per candidate). Exponential; only for
 * tiny pools in tests.
 */
export function bruteForceRosterMilp(problem, constraints, lambdas, subset = null) {
  const c = normConstraints(constraints);
  const idx = subset || Array.from({ length: problem.n }, (_, i) => i);
  let best = NEG_INF;
  let bestAssign = null;
  const cur = [];
  const rec = (pos, cx, a, b, cc, r, val) => {
    if (pos === idx.length) {
      if (r === c.relay && val > best) {
        best = val;
        bestAssign = [...cur];
      }
      return;
    }
    const i = idx[pos];
    if (!problem.forced[i]) rec(pos + 1, cx, a, b, cc, r, val);
    if (cx + 1 > c.nMax) return;
    for (let p = 0; p < 16; p++) {
      if (p & problem.blocked[i]) continue;
      const na = a + (p & 1);
      const nb = b + ((p >> 1) & 1);
      const nc = cc + ((p >> 2) & 1);
      const nr = r + ((p >> 3) & 1);
      if (na > c.k500 || nb > c.k1000 || nc > c.k1500 || nr > c.relay) continue;
      cur.push([i, p]);
      rec(pos + 1, cx + 1, na, nb, nc, nr, val + patternValue(problem, i, p, lambdas));
      cur.pop();
    }
  };
  rec(0, 0, 0, 0, 0, 0, 0);
  return { feasible: best > NEG_INF, objective: best, assignment: bestAssign };
}

// ------------------------------------------------------------------------------------------------
// 3. Monte Carlo engine
// ------------------------------------------------------------------------------------------------

export function lambdasFromConfig(config) {
  const w = config?.roster_model?.objective_weights || {};
  return {
    relay: w.lambda_relay ?? 0.14,
    form: w.lambda_form ?? 0.02,
    fatigue: w.lambda_fatigue ?? 0.045
  };
}

function lineupKey(problem, selected) {
  return selected
    .map((i) => problem.ids[i])
    .sort()
    .join('|');
}

function solutionToEntries(problem, sol) {
  const map = (arr) => arr.map((i) => problem.ids[i]).sort();
  return {
    500: map(sol.entries[500]),
    1000: map(sol.entries[1000]),
    1500: map(sol.entries[1500]),
    relay: map(sol.entries.relay)
  };
}

function round(x, digits = 4) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * 1,000-draw Monte Carlo roster engine.
 * @param {object[]} candidates fused candidates (fusion.mjs contract)
 * @param {object} opts { config, constraints, lambdas?, draws?, seed?, perturbationPct?,
 *   fieldByDistance?, valueFns?, blockedDistancesByAthlete?, unavailableIds? }
 */
export function runMonteCarloRoster(candidates, opts = {}) {
  const config = opts.config || {};
  const rm = config.roster_model || {};
  const unavailable = new Set([
    ...(rm.injured_or_unavailable_athlete_ids || []),
    ...(opts.unavailableIds || [])
  ]);
  const pool = candidates.filter((c) => !unavailable.has(c.athlete_id));
  const problem = buildRosterProblem(pool, opts);
  const constraints = opts.constraints || { nMax: 6, k: [3, 3, 3], relayRequired: 4 };
  const lambdas0 = opts.lambdas || lambdasFromConfig(config);
  const draws = opts.draws ?? rm.monte_carlo_draws ?? 1000;
  const seed = opts.seed ?? rm.random_seed ?? 202627;
  const pct = opts.perturbationPct ?? rm.weight_perturbation_pct ?? 0.15;
  const rng = createRng(seed);
  const n = problem.n;

  const deterministic = solveRosterMilp(problem, constraints, lambdas0);
  const muBase = Float64Array.from(problem.mu);
  const muDraw = new Float64Array(n * 3);
  const xCount = new Float64Array(n);
  const eCount = new Float64Array(n * 4);
  const lineups = new Map();
  let feasibleDraws = 0;
  let objSum = 0;
  const lam = { relay: 0, form: lambdas0.form, fatigue: 0 };

  for (let t = 0; t < draws; t++) {
    for (let j = 0; j < n * 3; j++) muDraw[j] = muBase[j] + problem.sigma[j] * rng.nextNormal();
    lam.relay = lambdas0.relay * (1 + pct * (2 * rng.nextUniform() - 1));
    lam.fatigue = lambdas0.fatigue * (1 + pct * (2 * rng.nextUniform() - 1));
    scoreProblemInPlace(problem, muDraw);
    const sol = solveRosterMilp(problem, constraints, lam);
    if (!sol.feasible) continue;
    feasibleDraws++;
    objSum += sol.objective;
    const key = lineupKey(problem, sol.selected);
    let lu = lineups.get(key);
    if (!lu) {
      lu = { count: 0, objSum: 0, members: sol.selected.slice(), entry: new Float64Array(n * 4) };
      lineups.set(key, lu);
    }
    lu.count++;
    lu.objSum += sol.objective;
    for (let s = 0; s < sol.selected.length; s++) {
      const i = sol.selected[s];
      const p = sol.patterns[s];
      xCount[i]++;
      for (let k = 0; k < 4; k++) {
        if (p & (1 << k)) {
          eCount[i * 4 + k]++;
          lu.entry[i * 4 + k]++;
        }
      }
    }
  }
  // Restore deterministic (mean) scores on the problem object for downstream users.
  scoreProblemInPlace(problem, muBase);

  const denom = Math.max(1, feasibleDraws);
  const perCandidate = pool.map((c, i) => ({
    athlete_id: c.athlete_id,
    name_en: c.name_en ?? null,
    name_zh: c.name_zh ?? null,
    age_group: c.age_group ?? null,
    is_dual_eligible: Boolean(c.is_dual_eligible),
    data_sources: c.data_sources || [],
    qualification_path: c.qualification_path ?? null,
    world_ranking_top40_distances: Array.isArray(c.world_ranking_top40_distances)
      ? c.world_ranking_top40_distances
      : [],
    form_momentum: round(problem.M[i]),
    recent_highlight: c.recent_highlight ?? null,
    skills: {
      500: { mu: round(problem.mu[i * 3]), sigma: round(problem.sigma[i * 3]) },
      1000: { mu: round(problem.mu[i * 3 + 1]), sigma: round(problem.sigma[i * 3 + 1]) },
      1500: { mu: round(problem.mu[i * 3 + 2]), sigma: round(problem.sigma[i * 3 + 2]) }
    },
    main_roster_prob: round(xCount[i] / denom),
    entry_prob_matrix: {
      500: round(eCount[i * 4] / denom),
      1000: round(eCount[i * 4 + 1] / denom),
      1500: round(eCount[i * 4 + 2] / denom),
      relay: round(eCount[i * 4 + 3] / denom)
    },
    value_scores: {
      500: round(problem.V[i * 3]),
      1000: round(problem.V[i * 3 + 1]),
      1500: round(problem.V[i * 3 + 2]),
      relay: round(problem.R[i]),
      form: round(problem.M[i])
    }
  }));
  perCandidate.sort(
    (a, b) => b.main_roster_prob - a.main_roster_prob || a.athlete_id.localeCompare(b.athlete_id)
  );

  const detKey = deterministic.feasible ? lineupKey(problem, deterministic.selected) : null;
  const ranked = [...lineups.entries()].sort(
    (a, b) =>
      b[1].count - a[1].count ||
      (a[0] === detKey ? -1 : b[0] === detKey ? 1 : 0) ||
      b[1].objSum / b[1].count - a[1].objSum / a[1].count
  );
  const top3 = ranked.slice(0, 3).map(([key, lu]) => ({
    athlete_ids: key.split('|'),
    frequency: round(lu.count / denom),
    avg_objective: round(lu.objSum / lu.count),
    modal_entries: modalEntries(problem, lu)
  }));

  // Preferred roster: use the most frequent MC lineup when it is a clear mode (>= 5% of draws);
  // otherwise use the deterministic MAP optimum so reserve marginal losses remain non-negative
  // and coherent on large candidate pools.
  let preferred = null;
  if (ranked.length || deterministic.feasible) {
    const topFreq = ranked.length ? ranked[0][1].count / denom : 0;
    const useMode = ranked.length > 0 && (topFreq >= 0.05 || !deterministic.feasible);
    const members = useMode ? ranked[0][1].members : deterministic.selected;
    const mKey = lineupKey(problem, members);
    const sol = useMode
      ? solveRosterMilp(problem, constraints, lambdas0, {
          subset: members,
          forced: members,
          prune: false
        })
      : deterministic;
    const use = sol.feasible ? sol : deterministic;
    const freqCount = lineups.get(mKey)?.count || 0;
    preferred = {
      athlete_ids: members.map((i) => problem.ids[i]).sort(),
      frequency: round(freqCount / denom),
      objective_at_mean: round(use.objective),
      entries: solutionToEntries(problem, use),
      matches_deterministic_map: detKey === mKey
    };
  }

  return {
    draws,
    feasible_draws: feasibleDraws,
    seed,
    lambdas: lambdas0,
    perturbation_pct: pct,
    constraints: normConstraints(constraints),
    mean_objective: round(objSum / denom),
    distinct_lineups: lineups.size,
    candidates: perCandidate,
    top_3_lineups: top3,
    preferred_main_roster: preferred,
    deterministic_map: deterministic.feasible
      ? {
          athlete_ids: deterministic.selected.map((i) => problem.ids[i]).sort(),
          objective: round(deterministic.objective),
          entries: solutionToEntries(problem, deterministic)
        }
      : null,
    _problem: problem
  };
}

function modalEntries(problem, lu) {
  const out = { 500: [], 1000: [], 1500: [], relay: [] };
  const keys = [500, 1000, 1500, 'relay'];
  for (const i of lu.members) {
    for (let k = 0; k < 4; k++) {
      if (lu.entry[i * 4 + k] / lu.count >= 0.5) out[keys[k]].push(problem.ids[i]);
    }
  }
  for (const k of keys) out[k].sort();
  return out;
}

// ------------------------------------------------------------------------------------------------
// 4. Six-reserve marginal replacement selector
// ------------------------------------------------------------------------------------------------

/**
 * @param {object} mc result of runMonteCarloRoster (uses its _problem and per-candidate probs)
 * @param {object} opts { constraints, lambdas, config, mainIds? }
 */
export function selectSixReserves(mc, opts = {}) {
  const problem = mc._problem;
  const config = opts.config || {};
  const rp = config.roster_model?.reserve_pool || {};
  const maxReserves = Math.max(0, Math.floor(opts.maxReserves ?? rp.total_size ?? 6));
  if (maxReserves === 0) return [];
  const defaultWtAlloc = rp.wt_allocation || { sprint_relay: 1, mid_long: 1, versatile_upside: 0 };
  const alloc =
    opts.reserveAllocation ||
    (maxReserves === (rp.wt_max_size ?? 2) && (opts.maxReserves != null || rp.wt_allocation)
      ? defaultWtAlloc
      : rp.allocation || { sprint_relay: 2, mid_long: 2, versatile_upside: 2 });
  const upK = rp.upside_sigma_multiplier ?? 1.0;
  const constraints = opts.constraints || mc.constraints;
  const lambdas = opts.lambdas || mc.lambdas;
  const idIndex = new Map(problem.ids.map((id, i) => [id, i]));
  const mainIds = opts.mainIds || mc.preferred_main_roster?.athlete_ids || [];
  const main = mainIds.map((id) => idIndex.get(id)).filter((i) => i !== undefined);
  const mainSet = new Set(main);
  const probById = new Map(mc.candidates.map((c) => [c.athlete_id, c.main_roster_prob]));

  const baseSol = solveRosterMilp(problem, constraints, lambdas, { subset: main, prune: false });
  const baseObj = baseSol.feasible ? baseSol.objective : 0;
  const roleOf = new Map();
  for (let s = 0; s < baseSol.selected.length; s++) roleOf.set(baseSol.selected[s], baseSol.patterns[s]);

  const rows = [];
  for (let j = 0; j < problem.n; j++) {
    if (mainSet.has(j)) continue;
    let best = { loss: Infinity, m: null };
    let sprint = { loss: Infinity, m: null };
    let mid = { loss: Infinity, m: null };
    for (const m of main) {
      const subset = main.filter((x) => x !== m);
      subset.push(j);
      const sol = solveRosterMilp(problem, constraints, lambdas, {
        subset,
        forced: [j],
        prune: false
      });
      const loss = sol.feasible ? baseObj - sol.objective : Infinity;
      const role = roleOf.get(m) || 0;
      if (loss < best.loss) best = { loss, m };
      if (role & (1 | RELAY_BIT) && loss < sprint.loss) sprint = { loss, m };
      if (role & (2 | 4) && loss < mid.loss) mid = { loss, m };
    }
    if (sprint.m === null) sprint = best;
    if (mid.m === null) mid = best;
    let upside = 0;
    for (let k = 0; k < 3; k++) {
      if ((problem.blocked[j] >> k) & 1) continue;
      const v = problem.valueFns[DISTANCES[k]](problem.mu[j * 3 + k] + upK * problem.sigma[j * 3 + k]);
      if (v > upside) upside = v;
    }
    const prob = probById.get(problem.ids[j]) ?? 0;
    rows.push({ j, best, sprint, mid, prob, upside, versatile: prob + upside });
  }

  const chosen = [];
  const taken = new Set();
  const pick = (tag, count, metric, cmp) => {
    const sorted = rows
      .filter((r) => !taken.has(r.j))
      .sort((a, b) => cmp(a, b) || problem.ids[a.j].localeCompare(problem.ids[b.j]));
    for (const r of sorted.slice(0, count)) {
      taken.add(r.j);
      chosen.push({ ...r, tag, metric: metric(r) });
    }
  };
  const byLoss = (key) => (a, b) => a[key].loss - b[key].loss || b.prob - a.prob;
  pick('sprint_relay', alloc.sprint_relay ?? 2, (r) => r.sprint, byLoss('sprint'));
  pick('mid_long', alloc.mid_long ?? 2, (r) => r.mid, byLoss('mid'));
  pick(
    'versatile_upside',
    alloc.versatile_upside ?? 2,
    (r) => r.best,
    (a, b) => b.versatile - a.versatile || a.best.loss - b.best.loss
  );

  const targetCap = Math.min(maxReserves, rows.length);
  if (chosen.length < targetCap) {
    const remaining = rows
      .filter((r) => !taken.has(r.j))
      .sort(
        (a, b) =>
          a.best.loss - b.best.loss || b.prob - a.prob || problem.ids[a.j].localeCompare(problem.ids[b.j])
      );
    for (const r of remaining.slice(0, targetCap - chosen.length)) {
      taken.add(r.j);
      chosen.push({ ...r, tag: 'versatile_upside', metric: r.best });
    }
  }

  const ordered = chosen
    .slice(0, targetCap)
    .sort((a, b) => a.metric.loss - b.metric.loss || b.prob - a.prob);
  return ordered.map((r, idx) => {
    const c = problem.candidates[r.j];
    const m = r.metric.m;
    return {
      reserve_rank: idx + 1,
      athlete_id: c.athlete_id,
      name_en: c.name_en ?? null,
      name_zh: c.name_zh ?? null,
      role_tag: r.tag,
      main_roster_prob: round(r.prob),
      primary_replacement_for: m === null ? null : problem.ids[m],
      marginal_loss: Number.isFinite(r.metric.loss) ? round(r.metric.loss) : null,
      is_dual_eligible: Boolean(c.is_dual_eligible),
      data_sources: c.data_sources || [],
      qualification_path: c.qualification_path ?? null,
      world_ranking_top40_distances: Array.isArray(c.world_ranking_top40_distances)
        ? c.world_ranking_top40_distances
        : [],
      recent_highlight: c.recent_highlight ?? null,
      upside_score: round(r.upside),
      versatility_score: round(r.versatile)
    };
  });
}

// ------------------------------------------------------------------------------------------------
// 5. Scenario helpers
// ------------------------------------------------------------------------------------------------

/**
 * World Tour constraints: N_max 6, K_d 3 (4 for four-skater-exception distances), relay 4.
 * @param {object} config parsed quota_rules YAML
 * @param {{ fourSkaterDistances?: (string|number)[], hasGenderRelay?: boolean }} opts
 */
export function worldTourConstraints(config, opts = {}) {
  const e = config?.world_tour?.entries || {};
  const def = e.max_skaters_per_distance_default ?? 3;
  const four = e.four_skater_exception?.max_skaters_per_distance ?? 4;
  const fs = new Set((opts.fourSkaterDistances || []).map((d) => parseInt(String(d), 10)));
  const relayMin = e.relays?.gender_relay?.min_skaters ?? 4;
  return {
    nMax: e.max_skaters_per_gender_total ?? 6,
    k: DISTANCES.map((d) => (fs.has(d) ? four : def)),
    relayRequired: opts.hasGenderRelay === false ? 0 : relayMin
  };
}

/** 2027 Worlds constraints for CHN from config (or explicit quotas / roster cap). */
export function worldChampionshipConstraints(config, gender, opts = {}) {
  const st = config?.world_championships_2027?.china_chn_verified_status || {};
  const q = opts.quotas || st.individual_quotas?.[gender] || { '500m': 3, '1000m': 3, '1500m': 3 };
  const hasRelay = opts.hasGenderRelay !== false;
  const capCfg = st.implied_roster_cap?.[gender];
  const cap =
    opts.maxRoster ?? (capCfg ? (hasRelay ? capCfg.with_gender_relay : capCfg.without_gender_relay) : 5);
  return {
    nMax: cap,
    k: DISTANCES.map((d) => q[`${d}m`] ?? q[d] ?? 1),
    relayRequired: hasRelay ? 4 : 0
  };
}

/** Full per-gender pipeline: MC + reserves + timing. */
export function forecastGender(candidates, opts = {}) {
  const t0 = performance.now();
  const mc = runMonteCarloRoster(candidates, opts);
  const t1 = performance.now();
  const reserves = selectSixReserves(mc, opts);
  const t2 = performance.now();
  const reserveCap = Math.max(
    0,
    Math.floor(opts.maxReserves ?? opts.config?.roster_model?.reserve_pool?.total_size ?? 6)
  );
  const { _problem, ...rest } = mc;
  return {
    ...rest,
    reserve_cap: reserveCap,
    reserves,
    timing_ms: { monte_carlo: round(t1 - t0, 1), reserves: round(t2 - t1, 1), total: round(t2 - t0, 1) }
  };
}
