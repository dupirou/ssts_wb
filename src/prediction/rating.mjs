/**
 * Per-discipline dynamic Bayesian Plackett-Luce / OpenSkill skill rating engine.
 * Features:
 * - Independent (gender, distance_m) state: { mu, sigma, lastTimestampMs, lastSeason, nStarts, recentDelta }
 * - Off-season & inactivity variance inflation before prediction and updates
 * - Clean-race isolation: only status in {'OK', 'NO_TIME'} with rank > 0 update skill
 *   (PEN, YC, RC, DNF, DNS, ADV are excluded from competitive rank updates)
 * - Repechage down-weighting (w_rep in [0.35, 0.6])
 *
 * Zero external dependencies; identical execution in Node CLI and Cloudflare Worker.
 */

export const DEFAULT_RATING_CONFIG = {
  mu0: 0.0,
  sigma0: 1.5,
  minSigma: 0.28,
  maxSigma: 1.6,
  beta: 0.9,
  plScale: 1.0,
  eta: 0.45,
  kappa: 0.14,
  gammaDay: 0.0012,
  gammaSeason: 0.18,
  repWeight: 0.45,
  conservativeC: 0.25,
  recentDecay: 0.6,
};

export function disciplineKey(gender, distanceM) {
  return `${gender}:${distanceM}`;
}

export function parseTimestampMs(row) {
  const raw = row?.start_time_utc || (row?.local_date ? `${row.local_date}T00:00:00Z` : null);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function isCleanFinisher(row) {
  return (
    (row?.status === 'OK' || row?.status === 'NO_TIME') &&
    Number.isInteger(row?.rank) &&
    row.rank > 0
  );
}

/**
 * Compute inactivity and cross-season uncertainty inflation without mutating state.
 */
export function driftSigma(sigma, lastTimestampMs, lastSeason, currentTimestampMs, currentSeason, cfg) {
  let v = sigma * sigma;
  if (lastTimestampMs != null && currentTimestampMs != null && currentTimestampMs > lastTimestampMs) {
    const deltaDays = (currentTimestampMs - lastTimestampMs) / 86400000;
    v += cfg.gammaDay * deltaDays;
  }
  if (lastSeason && currentSeason && lastSeason !== currentSeason) {
    v += cfg.gammaSeason;
  }
  return Math.min(cfg.maxSigma, Math.sqrt(Math.max(cfg.minSigma * cfg.minSigma, v)));
}

export function conservativeSkill(mu, sigma, c = DEFAULT_RATING_CONFIG.conservativeC) {
  return mu / Math.sqrt(1 + c * sigma * sigma);
}

export class DynamicRatingEngine {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_RATING_CONFIG, ...config };
    // Map<"gender:distance_m", Map<athleteId, state>>
    this.disciplines = new Map();
  }

  _disciplineMap(gender, distanceM) {
    const key = disciplineKey(gender, distanceM);
    let m = this.disciplines.get(key);
    if (!m) {
      m = new Map();
      this.disciplines.set(key, m);
    }
    return m;
  }

  /**
   * Read-only pre-race snapshot of an athlete's drifted skill and uncertainty.
   * Safe against future leakage: only depends on prior state and current race timestamp/season.
   */
  peekAthlete(athleteId, gender, distanceM, timestampMs = null, season = null) {
    const m = this._disciplineMap(gender, distanceM);
    const st = m.get(athleteId);
    if (!st) {
      return {
        athleteId,
        mu: this.cfg.mu0,
        sigma: this.cfg.sigma0,
        muTilde: 0.0,
        recentDelta: 0.0,
        nStarts: 0,
        isKnown: false,
      };
    }
    const driftedSigma = driftSigma(
      st.sigma,
      st.lastTimestampMs,
      st.lastSeason,
      timestampMs,
      season,
      this.cfg
    );
    return {
      athleteId,
      mu: st.mu,
      sigma: driftedSigma,
      muTilde: conservativeSkill(st.mu, driftedSigma, this.cfg.conservativeC),
      recentDelta: st.recentDelta,
      nStarts: st.nStarts,
      isKnown: true,
    };
  }

  /**
   * Update ratings strictly AFTER a heat finishes using only clean finishers.
   * Excludes PEN / YC / RC / DNF / DNS / ADV from rank-based updates.
   * Down-weights REPECHAGE heats by cfg.repWeight.
   */
  updateHeat(heatRows) {
    if (!Array.isArray(heatRows) || heatRows.length === 0) {
      return { updated: false, reason: 'empty_heat' };
    }
    const clean = heatRows.filter(isCleanFinisher);
    if (clean.length < 2) {
      return { updated: false, reason: 'insufficient_clean_finishers', cleanCount: clean.length };
    }

    const ref = clean[0];
    const gender = ref.gender;
    const distanceM = ref.distance_m;
    const season = ref.season || null;
    const timestampMs = parseTimestampMs(ref);
    const wSession = ref.session_type === 'REPECHAGE' ? this.cfg.repWeight : 1.0;

    // Snapshot drifted pre-update states for all clean finishers.
    const snapshots = clean.map((row) => ({
      row,
      prior: this.peekAthlete(row.athlete_id, gender, distanceM, timestampMs, season),
    }));

    // Group by rank ascending to handle ties cleanly and symmetrically.
    const tierMap = new Map();
    for (let idx = 0; idx < snapshots.length; idx++) {
      const r = snapshots[idx].row.rank;
      let grp = tierMap.get(r);
      if (!grp) {
        grp = [];
        tierMap.set(r, grp);
      }
      grp.push(idx);
    }
    const ranks = [...tierMap.keys()].sort((a, b) => a - b);
    if (ranks.length < 2) {
      return { updated: false, reason: 'all_tied', cleanCount: clean.length };
    }

    const n = snapshots.length;
    let meanMu = 0;
    for (const s of snapshots) meanMu += s.prior.mu;
    meanMu /= n;

    const weights = snapshots.map((s) => {
      const z = Math.max(-30, Math.min(30, (s.prior.mu - meanMu) / this.cfg.plScale));
      return Math.exp(z);
    });

    // Build suffix weight totals across ordered rank groups.
    const grad = new Array(n).fill(0);
    const info = new Array(n).fill(0);

    for (let gIdx = 0; gIdx < ranks.length - 1; gIdx++) {
      const group = tierMap.get(ranks[gIdx]);
      // Remaining participants from gIdx through the last rank tier.
      let remWeight = 0;
      const remIndices = [];
      for (let t = gIdx; t < ranks.length; t++) {
        for (const j of tierMap.get(ranks[t])) {
          remIndices.push(j);
          remWeight += weights[j];
        }
      }
      if (!(remWeight > 0)) continue;

      const k = group.length;
      for (const i of group) {
        grad[i] += 1.0;
      }
      for (const j of remIndices) {
        const p = weights[j] / remWeight;
        grad[j] -= k * p;
        info[j] += k * p * (1 - p);
      }
    }

    const dMap = this._disciplineMap(gender, distanceM);
    const betaSq = this.cfg.beta * this.cfg.beta;
    const minVar = this.cfg.minSigma * this.cfg.minSigma;
    const deltas = [];

    for (let idx = 0; idx < n; idx++) {
      const { row, prior } = snapshots[idx];
      const varPrior = prior.sigma * prior.sigma;
      const alpha = varPrior / (varPrior + betaSq);
      const deltaMu = this.cfg.eta * wSession * alpha * grad[idx];
      const muNew = prior.mu + deltaMu;

      const shrink = Math.max(0.5, 1 - this.cfg.kappa * wSession * alpha * Math.min(info[idx], 2.0));
      const varNew = Math.max(minVar, varPrior * shrink);
      const sigmaNew = Math.sqrt(varNew);
      const recentDelta = this.cfg.recentDecay * prior.recentDelta + (1 - this.cfg.recentDecay) * deltaMu;

      dMap.set(row.athlete_id, {
        mu: muNew,
        sigma: sigmaNew,
        lastTimestampMs: timestampMs ?? prior.lastTimestampMs ?? null,
        lastSeason: season || null,
        nStarts: prior.nStarts + 1,
        recentDelta,
      });
      deltas.push({ athleteId: row.athlete_id, deltaMu, muNew, sigmaNew });
    }

    return { updated: true, cleanCount: n, wSession, deltas };
  }
}
