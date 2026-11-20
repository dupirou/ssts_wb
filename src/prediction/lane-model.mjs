/**
 * Endogeneity-controlled contextual racing strength model (Layer 2: V1 -> V1.5).
 *
 * V1 6-feature model:
 *   s_i = alpha_scale * muTilde_i
 *       + beta_lane_prelim * (meanRelLane - relLane_i) * I(PRELIM/REP)
 *       + beta_lane_main   * (meanRelLane - relLane_i) * I(MAIN)
 *       + beta_rep         * I(is_repechage_qualifier_i)
 *       + beta_form        * recentDelta_i
 *       + beta_split       * zOpening_i
 *
 * V1.5 extended 9-feature model appends:
 *       + beta_finish      * zFinish_i (last-2-lap closing kick from pace-model)
 *       + beta_pace        * zPace_i   (venue-adjusted net pace from pace-model)
 *       + beta_crowd       * laneDiff_i * (heatSize - stdSize)
 *
 * Fits parameters via exact penalized Plackett-Luce Newton-Raphson MLE
 * with full dxd covariance Hessian, jointly controlling for skill muTilde_i
 * and repechage status so inner-lane advantage reflects physics, not seeding.
 *
 * Zero external dependencies.
 */

export const FEATURE_NAMES = [
  'alphaScale',
  'betaLanePrelim',
  'betaLaneMain',
  'betaRep',
  'betaForm',
  'betaSplit',
];

export const V15_FEATURE_NAMES = [
  ...FEATURE_NAMES,
  'betaFinish',
  'betaPace',
  'betaCrowd',
];

export const DEFAULT_PRIOR_MEAN = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
export const DEFAULT_PRIOR_PREC = [6.0, 12.0, 12.0, 10.0, 15.0, 15.0];

export const V15_PRIOR_MEAN = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
export const V15_PRIOR_PREC = [6.0, 12.0, 12.0, 10.0, 15.0, 15.0, 20.0, 20.0, 30.0];

const MAX_VALID_OPENING_SPLIT = {
  500: 11.0,
  1000: 20.0,
  1500: 18.0,
};

export class OpeningSplitTracker {
  constructor({ tau = 4.0, decay = 0.96, clipAdv = 1.5 } = {}) {
    this.tau = tau;
    this.decay = decay;
    this.clipAdv = clipAdv;
    this.byDistance = new Map();
  }

  _bucket(distanceM) {
    let b = this.byDistance.get(distanceM);
    if (!b) {
      b = { laneSquares: 8.0, laneProduct: 0.0, profiles: new Map() };
      this.byDistance.set(distanceM, b);
    }
    return b;
  }

  peekZ(athleteId, distanceM) {
    const b = this.byDistance.get(distanceM);
    if (!b) return 0.0;
    const p = b.profiles.get(athleteId);
    if (!p || !(p.n > 0)) return 0.0;
    const z = p.sum / (p.n + this.tau);
    return Math.max(-this.clipAdv, Math.min(this.clipAdv, z));
  }

  updateHeat(heatRows) {
    if (!Array.isArray(heatRows) || heatRows.length === 0) return false;
    const d = heatRows[0].distance_m;
    const maxT = MAX_VALID_OPENING_SPLIT[d] ?? 18.0;
    const measured = [];
    for (const r of heatRows) {
      const lane = r.starting_position;
      const t = r.opening_split_s;
      if (
        r.status === 'OK' &&
        Number.isInteger(lane) &&
        lane > 0 &&
        typeof t === 'number' &&
        Number.isFinite(t) &&
        t > 4.0 &&
        t <= maxT
      ) {
        measured.push({ athleteId: r.athlete_id, lane, t });
      }
    }
    if (measured.length < 2) return false;

    const b = this._bucket(d);
    let avgT = 0;
    let avgLane = 0;
    for (const m of measured) {
      avgT += m.t;
      avgLane += m.lane;
    }
    avgT /= measured.length;
    avgLane /= measured.length;

    for (const m of measured) {
      const dx = m.lane - avgLane;
      const dy = m.t - avgT;
      b.laneSquares += dx * dx;
      b.laneProduct += dx * dy;
    }

    const trend = b.laneProduct / b.laneSquares;
    for (const m of measured) {
      const dx = m.lane - avgLane;
      const dy = m.t - avgT;
      const adv = Math.max(-this.clipAdv, Math.min(this.clipAdv, dx * trend - dy));
      const prev = b.profiles.get(m.athleteId) || { sum: 0.0, n: 0.0 };
      b.profiles.set(m.athleteId, {
        sum: this.decay * prev.sum + adv,
        n: this.decay * prev.n + 1.0,
      });
    }
    return true;
  }
}

export function computeHeatLaneDiffs(activeRows) {
  const rels = activeRows.map((r) => {
    if (typeof r.rel_lane === 'number' && Number.isFinite(r.rel_lane)) return r.rel_lane;
    const hs = r.heat_size || activeRows.length;
    if (Number.isInteger(r.starting_position) && r.starting_position > 0 && hs > 1) {
      return (r.starting_position - 1) / (hs - 1);
    }
    return null;
  });
  let sum = 0;
  let cnt = 0;
  for (const x of rels) {
    if (x != null) {
      sum += x;
      cnt++;
    }
  }
  const meanRel = cnt > 0 ? sum / cnt : 0.5;
  return rels.map((x) => (x == null ? 0.0 : meanRel - x));
}

/**
 * Build the 6-dim (V1) or 9-dim (V1.5) feature matrix strictly pre-race.
 */
export function buildHeatFeatures(
  activeRows,
  ratingEngine,
  openingTracker,
  paceTracker = null,
  options = {}
) {
  const {
    includeFinishKick = false,
    includePace = false,
    includeCrowd = false,
    extended = false,
  } = options;
  const emitExtended = extended || paceTracker != null || includeFinishKick || includePace || includeCrowd;
  const laneDiffs = computeHeatLaneDiffs(activeRows);
  return activeRows.map((r, i) => {
    const tMs = r.start_time_utc ? Date.parse(r.start_time_utc) : null;
    const snap = ratingEngine.peekAthlete(
      r.athlete_id,
      r.gender,
      r.distance_m,
      Number.isFinite(tMs) ? tMs : null,
      r.season || null,
      r.country || null
    );
    const isMain = r.session_type === 'MAIN';
    const laneDiff = laneDiffs[i];
    const zOpen =
      openingTracker && r.distance_m <= 1000
        ? openingTracker.peekZ(r.athlete_id, r.distance_m)
        : 0.0;
    const base = [
      snap.muTilde,
      isMain ? 0.0 : laneDiff,
      isMain ? laneDiff : 0.0,
      r.is_repechage_qualifier ? 1.0 : 0.0,
      snap.recentDelta,
      zOpen,
    ];
    if (!emitExtended) return base;

    const zFinish =
      paceTracker && includeFinishKick
        ? paceTracker.peekZFinish(r.athlete_id, r.gender, r.distance_m)
        : 0.0;
    const zPace =
      paceTracker && includePace
        ? paceTracker.peekZPace(r.athlete_id, r.gender, r.distance_m)
        : 0.0;
    const stdSize = r.distance_m === 1500 ? 7 : 5;
    const crowd = includeCrowd
      ? laneDiff * Math.max(-1, Math.min(2, (r.heat_size || activeRows.length) - stdSize))
      : 0.0;
    return [...base, zFinish, zPace, crowd];
  });
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const diag = M[col][col];
    if (Math.abs(diag) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / diag;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = Math.abs(M[r][r]) < 1e-12 ? 0 : s / M[r][r];
  }
  return x;
}

export function fitContextualParams(
  samples,
  {
    priorMean = null,
    priorPrec = null,
    maxIter = 12,
    tol = 1e-6,
  } = {}
) {
  const inferredDim = samples?.[0]?.features?.[0]?.length || 6;
  const pMean = priorMean || (inferredDim === 9 ? V15_PRIOR_MEAN : DEFAULT_PRIOR_MEAN);
  const pPrec = priorPrec || (inferredDim === 9 ? V15_PRIOR_PREC : DEFAULT_PRIOR_PREC);
  const d = pMean.length;
  const theta = [...pMean];
  if (!samples || samples.length === 0) {
    return {
      params: thetaToObject(theta),
      theta,
      nRaces: 0,
      logPosterior: 0,
    };
  }

  function evalObj(th, needHessian) {
    let logPost = 0;
    const grad = new Array(d).fill(0);
    const negHess = needHessian ? Array.from({ length: d }, () => new Array(d).fill(0)) : null;

    for (let k = 0; k < d; k++) {
      const diff = th[k] - pMean[k];
      logPost -= 0.5 * pPrec[k] * diff * diff;
      grad[k] -= pPrec[k] * diff;
      if (needHessian) negHess[k][k] += pPrec[k];
    }

    for (let sIdx = 0; sIdx < samples.length; sIdx++) {
      const { tiers, features } = samples[sIdx];
      const n = features.length;
      const lin = new Array(n);
      let maxS = -Infinity;
      for (let i = 0; i < n; i++) {
        let s = 0;
        const xi = features[i];
        for (let k = 0; k < d; k++) s += th[k] * xi[k];
        lin[i] = s;
        if (s > maxS) maxS = s;
      }
      const w = lin.map((s) => Math.exp(Math.max(-35, Math.min(35, s - maxS))));

      for (let q = 0; q < tiers.length - 1; q++) {
        const grp = tiers[q];
        let remW = 0;
        const remIdx = [];
        for (let r = q; r < tiers.length; r++) {
          for (const j of tiers[r]) {
            remIdx.push(j);
            remW += w[j];
          }
        }
        if (!(remW > 0)) continue;
        const logRemW = Math.log(remW);
        const kGrp = grp.length;
        for (const i of grp) {
          logPost += lin[i] - maxS - logRemW;
          const xi = features[i];
          for (let k = 0; k < d; k++) grad[k] += xi[k];
        }

        const xBar = new Array(d).fill(0);
        const probs = new Array(remIdx.length);
        for (let idx = 0; idx < remIdx.length; idx++) {
          const j = remIdx[idx];
          const p = w[j] / remW;
          probs[idx] = p;
          const xj = features[j];
          for (let k = 0; k < d; k++) xBar[k] += p * xj[k];
        }
        for (let k = 0; k < d; k++) grad[k] -= kGrp * xBar[k];

        if (needHessian) {
          for (let idx = 0; idx < remIdx.length; idx++) {
            const p = probs[idx];
            const kp = kGrp * p;
            const xj = features[remIdx[idx]];
            for (let a = 0; a < d; a++) {
              const da = xj[a] - xBar[a];
              for (let b = a; b < d; b++) {
                const add = kp * da * (xj[b] - xBar[b]);
                negHess[a][b] += add;
                if (a !== b) negHess[b][a] += add;
              }
            }
          }
        }
      }
    }

    return { logPost, grad, negHess };
  }

  let current = evalObj(theta, true);
  for (let iter = 0; iter < maxIter; iter++) {
    const step = solveLinear(current.negHess, current.grad);
    let maxStep = 0;
    for (let k = 0; k < d; k++) {
      if (Math.abs(step[k]) > maxStep) maxStep = Math.abs(step[k]);
    }
    if (maxStep < tol) break;

    let alpha = 1.0;
    let accepted = false;
    while (alpha >= 1e-3) {
      const cand = theta.map((v, k) => v + alpha * step[k]);
      const candEval = evalObj(cand, true);
      if (candEval.logPost >= current.logPost - 1e-9) {
        for (let k = 0; k < d; k++) theta[k] = cand[k];
        current = candEval;
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) break;
  }

  return {
    params: thetaToObject(theta),
    theta: [...theta],
    nRaces: samples.length,
    logPosterior: current.logPost,
  };
}

export function thetaToObject(theta) {
  const obj = {
    alphaScale: theta[0],
    betaLanePrelim: theta[1],
    betaLaneMain: theta[2],
    betaRep: theta[3],
    betaForm: theta[4],
    betaSplit: theta[5],
  };
  if (theta.length > 6) {
    obj.betaFinish = theta[6] ?? 0;
    obj.betaPace = theta[7] ?? 0;
    obj.betaCrowd = theta[8] ?? 0;
  }
  return obj;
}

export function scoreHeatFeatures(features, theta) {
  return features.map((x) => {
    let s = 0;
    for (let k = 0; k < Math.min(theta.length, x.length); k++) s += theta[k] * x[k];
    return s;
  });
}

export function makeTrainingSample(activeRows, features) {
  const tierMap = new Map();
  for (let i = 0; i < activeRows.length; i++) {
    const r = activeRows[i];
    if ((r.status === 'OK' || r.status === 'NO_TIME') && Number.isInteger(r.rank) && r.rank > 0) {
      let grp = tierMap.get(r.rank);
      if (!grp) {
        grp = [];
        tierMap.set(r.rank, grp);
      }
      grp.push(i);
    }
  }
  const ranks = [...tierMap.keys()].sort((a, b) => a - b);
  if (ranks.length < 2) return null;
  return {
    tiers: ranks.map((rk) => tierMap.get(rk)),
    features,
  };
}

/**
 * Causally fit 1D score temperature tau_d >= 0.8 for incident-decoupled simulation
 * using strictly past heats' pre-race features and survival probabilities (1 - p_inc).
 * Compensates for Plackett-Luce bottom-rank dilution and incident dropout variance.
 */
export function fitIncidentTemperature(
  samples,
  theta,
  { priorTemp = 1.05, priorPrec = 25.0, maxIter = 8 } = {}
) {
  if (!samples || samples.length < 20) return priorTemp;
  let tau = priorTemp;
  for (let iter = 0; iter < maxIter; iter++) {
    let grad = -priorPrec * (tau - priorTemp);
    let negHess = priorPrec;
    for (let sIdx = 0; sIdx < samples.length; sIdx++) {
      const samp = samples[sIdx];
      const { tiers, features, pInc } = samp;
      if (!tiers || tiers.length < 2 || tiers[0].length !== 1) continue;
      const wIdx = tiers[0][0];
      const n = features.length;
      const raw = new Array(n);
      let maxS = -Infinity;
      for (let i = 0; i < n; i++) {
        let v = 0;
        const xi = features[i];
        for (let k = 0; k < Math.min(theta.length, xi.length); k++) v += theta[k] * xi[k];
        raw[i] = v;
        if (tau * v > maxS) maxS = tau * v;
      }
      let wSum = 0;
      const w = new Array(n);
      for (let i = 0; i < n; i++) {
        const surv = pInc ? Math.max(0.5, 1.0 - pInc[i]) : 1.0;
        const wi = surv * Math.exp(Math.max(-35, Math.min(35, tau * raw[i] - maxS)));
        w[i] = wi;
        wSum += wi;
      }
      if (!(wSum > 0)) continue;
      let meanR = 0;
      for (let i = 0; i < n; i++) meanR += (w[i] / wSum) * raw[i];
      let varR = 0;
      for (let i = 0; i < n; i++) {
        const dr = raw[i] - meanR;
        varR += (w[i] / wSum) * dr * dr;
      }
      grad += raw[wIdx] - meanR;
      negHess += varR;
    }
    const step = grad / Math.max(negHess, 1e-6);
    tau = Math.max(0.85, Math.min(1.45, tau + step));
    if (Math.abs(step) < 1e-4) break;
  }
  return tau;
}
