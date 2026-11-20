/**
 * Season-relative Empirical-Bayes Incident Risk Model (PEN/YC/RC & DNF).
 *
 * Estimates p_pen_i and p_dnf_i separately with:
 * - Contemporaneous (season, distance_m) rolling baseline with cross-season shrinkage
 * - Per-athlete relative risk ratio (count / expected_baseline_sum) immune to rule-era drift
 * - Regularized contextual log-odds adjustment (heat_size, round_tier, lane position)
 *
 * Strictly causal: updates only after heat completion; excludes DNS.
 */

export const PEN_STATUSES = new Set(['PEN', 'YC', 'RC']);
export const DNF_STATUSES = new Set(['DNF']);

const PEN_PRIOR_RATE = { 500: 0.032, 1000: 0.043, 1500: 0.045 };
const DNF_PRIOR_RATE = { 500: 0.0025, 1000: 0.0032, 1500: 0.0032 };
const STD_HEAT_SIZE = { 500: 5, 1000: 5, 1500: 7 };

function logit(p) {
  const c = Math.max(1e-5, Math.min(1 - 1e-5, p));
  return Math.log(c / (1 - c));
}

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

class OnlineLogitCalibrator {
  constructor(dim = 4, priorPrec = 60.0) {
    this.d = dim;
    this.w = new Array(dim).fill(0);
    this.hess = new Array(dim).fill(priorPrec);
  }

  predict(offset, x) {
    let z = offset;
    for (let k = 0; k < this.d; k++) z += this.w[k] * x[k];
    return sigmoid(z);
  }

  update(offset, x, y) {
    const p = this.predict(offset, x);
    const err = y - p;
    const varP = Math.max(1e-4, p * (1 - p));
    for (let k = 0; k < this.d; k++) {
      this.hess[k] += varP * x[k] * x[k];
      // Diagonal Newton / AdaGrad-like stabilized online step
      this.w[k] += (err * x[k]) / this.hess[k];
    }
  }
}

export class IncidentRiskModel {
  constructor({ decay = 0.96, priorPenPseudo = 2.2, priorDnfPseudo = 1.5 } = {}) {
    this.decay = decay;
    this.priorPenPseudo = priorPenPseudo;
    this.priorDnfPseudo = priorDnfPseudo;

    this.distPen = new Map();
    this.distDnf = new Map();
    this.seasonDistPen = new Map();
    this.seasonDistDnf = new Map();

    // Per-athlete overall and per-distance relative risk accumulators
    this.athOverall = new Map(); // athleteId -> { obsPen, expPen, obsDnf, expDnf }
    this.athDist = new Map(); // "athleteId:distance" -> { obsPen, expPen, obsDnf, expDnf }

    this.penCal = new Map([
      [500, new OnlineLogitCalibrator(5, 60)],
      [1000, new OnlineLogitCalibrator(5, 60)],
      [1500, new OnlineLogitCalibrator(5, 60)],
    ]);
    this.dnfCal = new Map([
      [500, new OnlineLogitCalibrator(5, 120)],
      [1000, new OnlineLogitCalibrator(5, 120)],
      [1500, new OnlineLogitCalibrator(5, 120)],
    ]);
  }

  baselineRates(season, distanceM) {
    const priorP = PEN_PRIOR_RATE[distanceM] ?? 0.04;
    const priorD = DNF_PRIOR_RATE[distanceM] ?? 0.003;

    const dp = this.distPen.get(distanceM);
    const distPenRate = dp && dp.w > 0 ? (dp.sum + 200 * priorP) / (dp.w + 200) : priorP;
    const dd = this.distDnf.get(distanceM);
    const distDnfRate = dd && dd.w > 0 ? (dd.sum + 200 * priorD) / (dd.w + 200) : priorD;

    const sdKey = `${season}:${distanceM}`;
    const sp = this.seasonDistPen.get(sdKey);
    const basePen = sp && sp.w > 0 ? (sp.sum + 120 * distPenRate) / (sp.w + 120) : distPenRate;
    const sd = this.seasonDistDnf.get(sdKey);
    const baseDnf = sd && sd.w > 0 ? (sd.sum + 120 * distDnfRate) / (sd.w + 120) : distDnfRate;

    return { basePen, baseDnf };
  }

  _contextFeatures(row, activeCount) {
    const stdSize = STD_HEAT_SIZE[row.distance_m] ?? 5;
    const size = row.heat_size || activeCount || stdSize;
    const sizeDiff = Math.max(-2, Math.min(3, size - stdSize));
    const isHighStakes = row.session_type === 'MAIN' && (row.round === 'semifinal' || row.round === 'final') ? 1.0 : 0.0;
    const relLane =
      typeof row.rel_lane === 'number' && Number.isFinite(row.rel_lane)
        ? row.rel_lane
        : Number.isInteger(row.starting_position) && size > 1
        ? (row.starting_position - 1) / (size - 1)
        : 0.5;
    // Middle lanes experience tighter squeeze entering turn 1 than extreme lane 1 or outside.
    const isMiddle = relLane > 0.15 && relLane < 0.85 ? 1.0 : 0.0;
    const muTilde = typeof row.mu_tilde === 'number' && Number.isFinite(row.mu_tilde) ? row.mu_tilde : 0.0;
    return [1.0, sizeDiff, isHighStakes, isMiddle, muTilde];
  }

  _athleteMultipliers(athleteId, distanceM) {
    const ov = this.athOverall.get(athleteId);
    const ds = this.athDist.get(`${athleteId}:${distanceM}`);

    const ovPenRel = ov ? (ov.obsPen + 1.8) / (ov.expPen + 1.8) : 1.0;
    const penRel = ds
      ? (ds.obsPen + 0.7 * ovPenRel + this.priorPenPseudo) / (ds.expPen + 0.7 + this.priorPenPseudo)
      : (0.4 * ovPenRel + 0.6);

    const ovDnfRel = ov ? (ov.obsDnf + 1.2) / (ov.expDnf + 1.2) : 1.0;
    const dnfRel = ds
      ? (ds.obsDnf + 0.5 * ovDnfRel + this.priorDnfPseudo) / (ds.expDnf + 0.5 + this.priorDnfPseudo)
      : (0.3 * ovDnfRel + 0.7);

    return {
      penRel: Math.max(0.45, Math.min(2.6, penRel)),
      dnfRel: Math.max(0.5, Math.min(2.5, dnfRel)),
    };
  }

  /**
   * Predict { p_pen, p_dnf, p_incident } for one active starter strictly pre-race.
   */
  predictStarter(row, activeCount = 5) {
    const d = row.distance_m;
    const { basePen, baseDnf } = this.baselineRates(row.season || 'unknown', d);
    const { penRel, dnfRel } = this._athleteMultipliers(row.athlete_id, d);
    const x = this._contextFeatures(row, activeCount);

    const penCal = this.penCal.get(d) || this.penCal.get(500);
    const dnfCal = this.dnfCal.get(d) || this.dnfCal.get(500);

    const pPen = penCal.predict(logit(basePen * penRel), x);
    const pDnf = dnfCal.predict(logit(baseDnf * dnfRel), x);
    const total = Math.min(0.4, pPen + pDnf);
    const scale = pPen + pDnf > 0 ? total / (pPen + pDnf) : 1;
    return {
      p_pen: pPen * scale,
      p_dnf: pDnf * scale,
      p_incident: total,
    };
  }

  predictHeat(activeRows) {
    const n = activeRows.length;
    return activeRows.map((r) => this.predictStarter(r, n));
  }

  /**
   * Update baseline rates, athlete relative ratios, and contextual calibrators strictly AFTER completion.
   */
  updateHeat(heatRows) {
    if (!Array.isArray(heatRows) || heatRows.length === 0) return false;
    const active = heatRows.filter((r) => r.status !== 'DNS');
    if (active.length === 0) return false;

    const r0 = active[0];
    const d = r0.distance_m;
    const season = r0.season || 'unknown';
    const { basePen, baseDnf } = this.baselineRates(season, d);
    const penCal = this.penCal.get(d) || this.penCal.get(500);
    const dnfCal = this.dnfCal.get(d) || this.dnfCal.get(500);

    for (const r of active) {
      const yPen = PEN_STATUSES.has(r.status) ? 1 : 0;
      const yDnf = DNF_STATUSES.has(r.status) ? 1 : 0;
      const { penRel, dnfRel } = this._athleteMultipliers(r.athlete_id, d);
      const x = this._contextFeatures(r, active.length);

      penCal.update(logit(basePen * penRel), x, yPen);
      dnfCal.update(logit(baseDnf * dnfRel), x, yDnf);

      const ov = this.athOverall.get(r.athlete_id) || { obsPen: 0, expPen: 0, obsDnf: 0, expDnf: 0 };
      this.athOverall.set(r.athlete_id, {
        obsPen: ov.obsPen * this.decay + yPen,
        expPen: ov.expPen * this.decay + basePen,
        obsDnf: ov.obsDnf * this.decay + yDnf,
        expDnf: ov.expDnf * this.decay + baseDnf,
      });

      const dk = `${r.athlete_id}:${d}`;
      const ds = this.athDist.get(dk) || { obsPen: 0, expPen: 0, obsDnf: 0, expDnf: 0 };
      this.athDist.set(dk, {
        obsPen: ds.obsPen * this.decay + yPen,
        expPen: ds.expPen * this.decay + basePen,
        obsDnf: ds.obsDnf * this.decay + yDnf,
        expDnf: ds.expDnf * this.decay + baseDnf,
      });

      const dp = this.distPen.get(d) || { sum: 0, w: 0 };
      this.distPen.set(d, { sum: dp.sum * 0.999 + yPen, w: dp.w * 0.999 + 1 });
      const dd = this.distDnf.get(d) || { sum: 0, w: 0 };
      this.distDnf.set(d, { sum: dd.sum * 0.999 + yDnf, w: dd.w * 0.999 + 1 });

      const sdKey = `${season}:${d}`;
      const sp = this.seasonDistPen.get(sdKey) || { sum: 0, w: 0 };
      this.seasonDistPen.set(sdKey, { sum: sp.sum + yPen, w: sp.w + 1 });
      const sd = this.seasonDistDnf.get(sdKey) || { sum: 0, w: 0 };
      this.seasonDistDnf.set(sdKey, { sum: sd.sum + yDnf, w: sd.w + 1 });
    }
    return true;
  }

  toJSON() {
    const r6 = (x) => Math.round(x * 1e6) / 1e6;
    const serSum = (m) => {
      const out = {};
      for (const [k, v] of m.entries()) out[k] = [r6(v.sum), r6(v.w)];
      return out;
    };
    const serAth = (m) => {
      const out = {};
      for (const [k, v] of m.entries()) {
        out[k] = [r6(v.obsPen), r6(v.expPen), r6(v.obsDnf), r6(v.expDnf)];
      }
      return out;
    };
    const serCal = (m) => {
      const out = {};
      for (const [d, c] of m.entries()) out[d] = { w: c.w.map(r6), hess: c.hess.map(r6) };
      return out;
    };
    return {
      distPen: serSum(this.distPen),
      distDnf: serSum(this.distDnf),
      seasonDistPen: serSum(this.seasonDistPen),
      seasonDistDnf: serSum(this.seasonDistDnf),
      athOverall: serAth(this.athOverall),
      athDist: serAth(this.athDist),
      penCal: serCal(this.penCal),
      dnfCal: serCal(this.dnfCal),
    };
  }

  static fromJSON(data, options = {}, filter = null) {
    const ir = new IncidentRiskModel(options);
    if (!data) return ir;
    const dSuffix = filter?.distance ? `:${filter.distance}` : null;
    const loadSum = (m, obj) => {
      for (const [k, arr] of Object.entries(obj || {})) {
        if (dSuffix && (k.includes(':') ? !k.endsWith(dSuffix) : Number(k) !== filter.distance)) continue;
        m.set(k.includes(':') ? k : Number(k), { sum: arr[0], w: arr[1] });
      }
    };
    const loadAth = (m, obj, suffixFilter = null) => {
      for (const [k, arr] of Object.entries(obj || {})) {
        if (suffixFilter && !k.endsWith(suffixFilter)) continue;
        m.set(k, { obsPen: arr[0], expPen: arr[1], obsDnf: arr[2], expDnf: arr[3] });
      }
    };
    const loadCal = (m, obj) => {
      for (const [dStr, st] of Object.entries(obj || {})) {
        if (filter?.distance && Number(dStr) !== filter.distance) continue;
        const cal = m.get(Number(dStr));
        if (!cal) continue;
        cal.w = [...st.w];
        cal.hess = [...st.hess];
      }
    };
    loadSum(ir.distPen, data.distPen);
    loadSum(ir.distDnf, data.distDnf);
    loadSum(ir.seasonDistPen, data.seasonDistPen);
    loadSum(ir.seasonDistDnf, data.seasonDistDnf);
    loadAth(ir.athOverall, data.athOverall);
    loadAth(ir.athDist, data.athDist, dSuffix);
    loadCal(ir.penCal, data.penCal);
    loadCal(ir.dnfCal, data.dnfCal);
    return ir;
  }
}
