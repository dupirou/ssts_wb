/**
 * Venue-adjusted pace, last-2-lap finishing kick (z_finish), and
 * cross-heat Small-q simulation time model (Layer 1 & Layer 3).
 *
 * Strictly causal/online: updates venue benchmarks, athlete profiles, and
 * time-gap regressions solely AFTER each heat finishes.
 *
 * Zero external dependencies.
 */

export const GLOBAL_DEFAULT_TIME = {
  'men:500': 41.2,
  'women:500': 43.3,
  'men:1000': 86.5,
  'women:1000': 91.2,
  'men:1500': 139.0,
  'women:1500': 149.0,
};

export const TIME_SCALE = {
  500: 1.2,
  1000: 2.8,
  1500: 5.5,
};

const MAX_VALID_TIME = {
  500: 65.0,
  1000: 130.0,
  1500: 210.0,
};

const DEFAULT_HEAT_SIGMA = {
  500: 0.72,
  1000: 2.35,
  1500: 6.2,
};

const DEFAULT_GAP_MEAN = {
  500: 0.45,
  1000: 0.48,
  1500: 0.65,
};

function tierBucket(round, sessionType) {
  if (round === 'final') return 'FINAL';
  if (round === 'semifinal' && sessionType === 'MAIN') return 'SF';
  if (round === 'quarterfinal' && sessionType === 'MAIN') return 'QF';
  if (sessionType === 'REPECHAGE') return 'REP';
  return 'PRELIM';
}

function addWeightedStat(map, key, val, decay = 0.995) {
  const prev = map.get(key) || { sum: 0, w: 0 };
  map.set(key, { sum: prev.sum * decay + val, w: prev.w * decay + 1 });
}

function solveLinearSmall(A, b) {
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
      const f = M[r][col] / diag;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
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

class OnlineRidge {
  constructor(priorMean, priorPrec) {
    this.d = priorMean.length;
    this.priorMean = [...priorMean];
    this.priorPrec = [...priorPrec];
    this.XtX = Array.from({ length: this.d }, (_, i) =>
      Array.from({ length: this.d }, (__, j) => (i === j ? priorPrec[i] : 0))
    );
    this.Xty = priorMean.map((m, i) => priorPrec[i] * m);
    this.ySq = 0;
    this.n = 0;
    this._beta = [...priorMean];
    this._dirty = false;
  }

  add(x, y) {
    for (let i = 0; i < this.d; i++) {
      this.Xty[i] += x[i] * y;
      for (let j = i; j < this.d; j++) {
        const add = x[i] * x[j];
        this.XtX[i][j] += add;
        if (i !== j) this.XtX[j][i] += add;
      }
    }
    this.ySq += y * y;
    this.n++;
    this._dirty = true;
  }

  beta() {
    if (this._dirty) {
      this._beta = solveLinearSmall(this.XtX, this.Xty);
      this._dirty = false;
    }
    return this._beta;
  }
}

export class PaceTracker {
  constructor({ tauFinish = 4.0, tauPace = 5.0, decay = 0.94 } = {}) {
    this.tauFinish = tauFinish;
    this.tauPace = tauPace;
    this.decay = decay;

    // Last-2-lap finishing kick profiles: Map<"gender:distance", Map<athleteId, { sum, n }>>
    this.finishProfiles = new Map();
    // Venue-adjusted net pace profiles: Map<"gender:distance", Map<athleteId, { sum, sq, n }>>
    this.paceProfiles = new Map();

    // Hierarchical venue baseline stats
    this.gdStats = new Map(); // "gender:distance" -> { sum, w }
    this.cityDeltaStats = new Map(); // "gender:distance:city" -> { sum, w }
    this.tierDeltaStats = new Map(); // "gender:distance:tier" -> { sum, w }

    // Online heat-winner & rank-gap regressions per distance_m
    // Heat winner delta (T_1st - T_venue) ~ [1, -leaderZ, meanSkill, spreadS]
    this.heatTimeModel = new Map([
      [500, { reg: new OnlineRidge([0, 0.35, -0.18, -0.05], [10, 20, 20, 20]), sqErr: 0, n: 0 }],
      [1000, { reg: new OnlineRidge([0, 0.75, -0.4, -0.1], [10, 20, 20, 20]), sqErr: 0, n: 0 }],
      [1500, { reg: new OnlineRidge([0, 1.4, -0.7, -0.15], [10, 20, 20, 20]), sqErr: 0, n: 0 }],
    ]);
    // Positive time gap (T_cand - T_1st) ~ [1, (place-1), max(0, s_1st - s_cand)]
    this.gapModel = new Map([
      [500, { reg: new OnlineRidge([0.1, 0.25, 0.14], [10, 20, 20]), sqErr: 0, n: 0 }],
      [1000, { reg: new OnlineRidge([0.1, 0.28, 0.16], [10, 20, 20]), sqErr: 0, n: 0 }],
      [1500, { reg: new OnlineRidge([0.15, 0.35, 0.2], [10, 20, 20]), sqErr: 0, n: 0 }],
    ]);
  }

  _discMap(store, gender, distanceM) {
    const key = `${gender}:${distanceM}`;
    let m = store.get(key);
    if (!m) {
      m = new Map();
      store.set(key, m);
    }
    return m;
  }

  /**
   * Expected benchmark finish time T_venue(gender, distance, city, round, session_type).
   */
  venueBaseline(gender, distanceM, city, round, sessionType) {
    const gdKey = `${gender}:${distanceM}`;
    const gd = this.gdStats.get(gdKey);
    const fallback = GLOBAL_DEFAULT_TIME[gdKey] ?? 60.0;
    const base = gd && gd.w > 0 ? (gd.sum + 4 * fallback) / (gd.w + 4) : fallback;

    const cStat = city ? this.cityDeltaStats.get(`${gdKey}:${city}`) : null;
    const cityDelta = cStat && cStat.w > 0 ? cStat.sum / (cStat.w + 8) : 0;

    const tb = tierBucket(round, sessionType);
    const tStat = this.tierDeltaStats.get(`${gdKey}:${tb}`);
    const tierDelta = tStat && tStat.w > 0 ? tStat.sum / (tStat.w + 10) : 0;

    return base + cityDelta + tierDelta;
  }

  /**
   * Dimensionless last-2-lap finishing kick advantage (positive = faster finisher).
   */
  peekZFinish(athleteId, gender, distanceM) {
    const m = this.finishProfiles.get(`${gender}:${distanceM}`);
    if (!m) return 0.0;
    const p = m.get(athleteId);
    if (!p || !(p.n > 0)) return 0.0;
    return Math.max(-2.0, Math.min(2.0, p.sum / (p.n + this.tauFinish)));
  }

  /**
   * Venue-adjusted net speed score z_pace_i (positive = faster than venue/tier norm).
   */
  peekZPace(athleteId, gender, distanceM) {
    const m = this.paceProfiles.get(`${gender}:${distanceM}`);
    if (!m) return 0.0;
    const p = m.get(athleteId);
    if (!p || !(p.n > 0)) return 0.0;
    return Math.max(-2.5, Math.min(2.5, p.sum / (p.n + this.tauPace)));
  }

  /**
   * Predict heat winner pace summary and simulation parameters for a pre-race heat.
   */
  predictHeatPace(activeRows, scores) {
    const r0 = activeRows[0];
    const d = r0.distance_m;
    const tVenue = this.venueBaseline(r0.gender, d, r0.city, r0.round, r0.session_type);

    const zPaces = activeRows.map((r) => this.peekZPace(r.athlete_id, r.gender, d));
    let leaderZ = -Infinity;
    for (const z of zPaces) if (z > leaderZ) leaderZ = z;
    if (!Number.isFinite(leaderZ)) leaderZ = 0;

    let meanS = 0;
    for (const s of scores) meanS += s;
    meanS /= Math.max(scores.length, 1);

    let varS = 0;
    for (const s of scores) varS += (s - meanS) * (s - meanS);
    const spreadS = scores.length > 1 ? Math.sqrt(varS / scores.length) : 0;

    const hm = this.heatTimeModel.get(d) || this.heatTimeModel.get(500);
    const bHeat = hm.reg.beta();
    const xHeat = [1.0, -leaderZ, meanS, spreadS];
    const paceDeltaS =
      bHeat[0] * xHeat[0] + bHeat[1] * xHeat[1] + bHeat[2] * xHeat[2] + bHeat[3] * xHeat[3];

    const sigmaHeat =
      hm.n >= 20 ? Math.max(0.25, Math.sqrt(hm.sqErr / hm.n)) : DEFAULT_HEAT_SIGMA[d] ?? 1.5;

    const gm = this.gapModel.get(d) || this.gapModel.get(500);
    const bGap = gm.reg.beta();
    const sigmaGap =
      gm.n >= 20 ? Math.max(0.12, Math.sqrt(gm.sqErr / gm.n)) : DEFAULT_GAP_MEAN[d] * 0.65;

    const zNorm = paceDeltaS / Math.max(sigmaHeat, 0.25);
    const paceLabel = zNorm <= -0.25 ? 'fast' : zNorm >= 0.25 ? 'slow' : 'medium';

    return {
      tVenue,
      paceDeltaS,
      expectedTimeS: tVenue + paceDeltaS,
      paceLabel,
      sigmaHeat,
      gapBeta: bGap,
      sigmaGap,
      zPaces,
      timeScale: TIME_SCALE[d] ?? 2.0,
    };
  }

  /**
   * Update finishing kick, venue baseline, net pace, and time/gap regressions strictly AFTER heat completion.
   * Optional preScores are the pre-race racing strength scores aligned with activeRows.
   */
  updateHeat(heatRows, preContext = null) {
    if (!Array.isArray(heatRows) || heatRows.length === 0) return false;
    const r0 = heatRows[0];
    const gender = r0.gender;
    const d = r0.distance_m;
    const maxT = MAX_VALID_TIME[d] ?? 220.0;
    const gdKey = `${gender}:${d}`;
    const tb = tierBucket(r0.round, r0.session_type);

    // 1. Update finishing kick z_finish from lap_times_s.slice(-2)
    const finValid = [];
    for (const r of heatRows) {
      if (r.status === 'OK' && Number.isInteger(r.rank) && r.rank > 0 && Array.isArray(r.lap_times_s) && r.lap_times_s.length >= 3) {
        const len = r.lap_times_s.length;
        const fin2 = r.lap_times_s[len - 2] + r.lap_times_s[len - 1];
        if (Number.isFinite(fin2) && fin2 >= 14.0 && fin2 <= 28.0) {
          finValid.push({ athleteId: r.athlete_id, fin2 });
        }
      }
    }
    if (finValid.length >= 2) {
      let avgFin = 0;
      for (const x of finValid) avgFin += x.fin2;
      avgFin /= finValid.length;
      const fm = this._discMap(this.finishProfiles, gender, d);
      for (const { athleteId, fin2 } of finValid) {
        const adv = Math.max(-2.5, Math.min(2.5, avgFin - fin2));
        const prev = fm.get(athleteId) || { sum: 0, n: 0 };
        fm.set(athleteId, { sum: this.decay * prev.sum + adv, n: this.decay * prev.n + 1 });
      }
    }

    // 2. Collect clean timed finishers
    const timed = heatRows
      .filter((r) => r.status === 'OK' && Number.isInteger(r.rank) && r.rank > 0 && typeof r.time_s === 'number' && r.time_s > 25 && r.time_s <= maxT)
      .sort((a, b) => a.rank - b.rank);
    if (timed.length === 0) return finValid.length >= 2;

    const winner = timed[0];
    // Pre-update venue baseline for causal residual calculation.
    const tVenuePre = this.venueBaseline(gender, d, r0.city, r0.round, r0.session_type);
    const scale = TIME_SCALE[d] ?? 2.0;

    // 3. Update online heat-winner & rank-gap models if pre-race context is provided.
    if (preContext && winner.rank === 1) {
      const { activeRows, scores, zPaces } = preContext;
      const hm = this.heatTimeModel.get(d);
      if (hm) {
        let leaderZ = -Infinity;
        for (const z of zPaces) if (z > leaderZ) leaderZ = z;
        if (!Number.isFinite(leaderZ)) leaderZ = 0;
        let meanS = 0;
        for (const s of scores) meanS += s;
        meanS /= Math.max(scores.length, 1);
        let varS = 0;
        for (const s of scores) varS += (s - meanS) * (s - meanS);
        const spreadS = scores.length > 1 ? Math.sqrt(varS / scores.length) : 0;

        const xHeat = [1.0, -leaderZ, meanS, spreadS];
        const yHeat = Math.max(-25.0, Math.min(25.0, winner.time_s - tVenuePre));
        const b = hm.reg.beta();
        const pred = b[0] * xHeat[0] + b[1] * xHeat[1] + b[2] * xHeat[2] + b[3] * xHeat[3];
        hm.sqErr = hm.sqErr * 0.996 + (yHeat - pred) * (yHeat - pred);
        hm.n = hm.n * 0.996 + 1;
        hm.reg.add(xHeat, yHeat);
      }

      const gm = this.gapModel.get(d);
      if (gm && timed.length >= 2) {
        const sByAth = new Map();
        for (let i = 0; i < activeRows.length; i++) sByAth.set(activeRows[i].athlete_id, scores[i]);
        const sWin = sByAth.get(winner.athlete_id) ?? 0;
        for (let idx = 1; idx < timed.length; idx++) {
          const cand = timed[idx];
          if (cand.rank > 4) continue;
          const gap = cand.time_s - winner.time_s;
          if (!(gap >= 0 && gap <= 8.0)) continue;
          const sCand = sByAth.get(cand.athlete_id) ?? 0;
          const xGap = [1.0, cand.rank - 1, Math.max(0, sWin - sCand)];
          const bg = gm.reg.beta();
          const predG = bg[0] * xGap[0] + bg[1] * xGap[1] + bg[2] * xGap[2];
          gm.sqErr = gm.sqErr * 0.996 + (gap - predG) * (gap - predG);
          gm.n = gm.n * 0.996 + 1;
          gm.reg.add(xGap, gap);
        }
      }
    }

    // 4. Update athlete net pace profile using pre-update tVenuePre.
    const pm = this._discMap(this.paceProfiles, gender, d);
    for (const r of timed) {
      const residZ = Math.max(-2.5, Math.min(2.5, (tVenuePre - r.time_s) / scale));
      const prev = pm.get(r.athlete_id) || { sum: 0, n: 0 };
      pm.set(r.athlete_id, { sum: this.decay * prev.sum + residZ, n: this.decay * prev.n + 1 });
    }

    // 5. Update rolling hierarchical venue benchmark from the heat winner's clean time.
    const tWin = winner.time_s;
    const gd = this.gdStats.get(gdKey);
    const gdMeanPre = gd && gd.w > 0 ? gd.sum / gd.w : tWin;
    addWeightedStat(this.gdStats, gdKey, tWin);
    if (r0.city) {
      addWeightedStat(this.cityDeltaStats, `${gdKey}:${r0.city}`, tWin - gdMeanPre);
    }
    addWeightedStat(this.tierDeltaStats, `${gdKey}:${tb}`, tWin - gdMeanPre);

    return true;
  }
}
