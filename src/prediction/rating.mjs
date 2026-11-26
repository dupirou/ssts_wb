/**
 * Per-discipline dynamic Bayesian Plackett-Luce / OpenSkill skill rating engine (V1 -> V1.5).
 *
 * V1 core:
 * - Independent (gender, distance_m) state: { mu, sigma, lastTimestampMs, lastSeason, nStarts, recentDelta }
 * - Off-season & inactivity variance inflation before prediction and updates
 * - Clean-race isolation: only status in {'OK', 'NO_TIME'} with rank > 0 update skill
 * - Repechage down-weighting
 *
 * V1.5 upgrades (ablation-gated):
 * - Cross-distance skill transfer & federation (country) EB cold-start prior
 * - Coast-to-qualify softening (merges co-Q finishers within 0.10s in non-final rounds)
 * - Round-tier information weighting (prelim vs QF vs SF/Final)
 * - Per-distance hyperparameter overrides (500m / 1000m / 1500m)
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

  // V1.5 options (default off unless enabled by V1.5 preset/config so V1 callers stay bit-exact)
  enableCrossDistTransfer: false,
  crossDistWeight: 0.5,
  enableFederationPrior: false,
  fedWeight: 0.45,
  fedPriorTau: 16.0,
  enableCoastSoftening: false,
  coastMarginSec: 0.10,
  enableRoundWeights: false,
  prelimWeight: 0.85,
  qfWeight: 1.0,
  highTierWeight: 1.2,
  distConfigs: null,
};

export const V15_RATING_CONFIG = {
  ...DEFAULT_RATING_CONFIG,
  enableCrossDistTransfer: true,
  crossDistWeight: 0.55,
  enableFederationPrior: true,
  fedWeight: 0.45,
  fedPriorTau: 16.0,
  enableCoastSoftening: false,
  coastMarginSec: 0.10,
  enableRoundWeights: false,
  prelimWeight: 0.85,
  qfWeight: 1.0,
  highTierWeight: 1.2,
  distConfigs: {
    500: { eta: 0.48, beta: 0.85, gammaSeason: 0.16, repWeight: 0.40 },
    1000: { eta: 0.45, beta: 0.90, gammaSeason: 0.18, repWeight: 0.45 },
    1500: { eta: 0.42, beta: 0.95, gammaSeason: 0.20, repWeight: 0.45 },
  },
};

const CROSS_DIST_AFFINITY = {
  500: { 1000: 0.75, 1500: 0.25 },
  1000: { 500: 0.55, 1500: 0.55 },
  1500: { 1000: 0.75, 500: 0.25 },
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

// ISU Communication 2708 identifies these historical AIN skaters as RUS.
// An unqualified AIN code alone does not identify a federation.
const russianNeutralIds = new Set(['skr-4639', 'skr-20498', 'skr-20499', 'skr-20500', 'skr-20501']);

function federationKey(country, athleteId, gender, distanceM) {
  const russian = country === 'AIN2' || (country === 'AIN' && russianNeutralIds.has(athleteId));
  return `${russian ? 'RUS' : country}:${gender}:${distanceM}`;
}

export class DynamicRatingEngine {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_RATING_CONFIG, ...config };
    this.disciplines = new Map();
    // Map<"country:gender:distance", { sumMu, w }>
    this.fedStats = new Map();
    this.debutRatings = null;
  }

  _cfgFor(distanceM) {
    const ov = this.cfg.distConfigs && this.cfg.distConfigs[distanceM];
    return ov ? { ...this.cfg, ...ov } : this.cfg;
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

  _coldStartPrior(athleteId, gender, distanceM, country, cfg) {
    const observed = this.debutRatings?.[disciplineKey(gender, distanceM)]?.[athleteId];
    if (observed && Number.isFinite(observed.mu) && Number.isFinite(observed.sigma) && observed.sigma > 0) {
      return { muPrior: observed.mu, sigmaInit: observed.sigma };
    }
    let crossSum = 0;
    let crossW = 0;
    if (cfg.enableCrossDistTransfer) {
      const aff = CROSS_DIST_AFFINITY[distanceM] || {};
      for (const [odStr, wAff] of Object.entries(aff)) {
        const od = Number(odStr);
        const mOther = this.disciplines.get(disciplineKey(gender, od));
        const stOther = mOther?.get(athleteId);
        if (stOther && stOther.nStarts > 0) {
          const rel = stOther.nStarts / (stOther.nStarts + 4);
          const w = wAff * rel;
          crossSum += w * stOther.mu;
          crossW += w;
        }
      }
    }
    const crossMu = crossW > 0 ? (crossSum / crossW) * (crossW / (crossW + 0.5)) : 0;

    let fedMu = 0;
    if (cfg.enableFederationPrior && country) {
      const f = this.fedStats.get(federationKey(country, athleteId, gender, distanceM));
      if (f && f.w > 0) {
        fedMu = f.sumMu / (f.w + cfg.fedPriorTau);
      }
    }

    const raw =
      (cfg.enableCrossDistTransfer ? cfg.crossDistWeight * crossMu : 0) +
      (cfg.enableFederationPrior ? cfg.fedWeight * fedMu : 0);
    const muPrior = Math.max(-1.6, Math.min(1.6, raw));
    const sigmaInit =
      cfg.enableCrossDistTransfer && crossW > 0.3
        ? Math.max(1.15, cfg.sigma0 - 0.2 * Math.min(1, crossW))
        : cfg.sigma0;

    return { muPrior, sigmaInit };
  }

  /**
   * Read-only pre-race snapshot of an athlete's drifted skill and uncertainty.
   * Optional country enables federation prior for unseen athletes.
   */
  peekAthlete(athleteId, gender, distanceM, timestampMs = null, season = null, country = null) {
    const cfg = this._cfgFor(distanceM);
    const m = this._disciplineMap(gender, distanceM);
    const st = m.get(athleteId);
    if (!st) {
      const { muPrior, sigmaInit } = this._coldStartPrior(athleteId, gender, distanceM, country, cfg);
      return {
        athleteId,
        mu: cfg.mu0 + muPrior,
        sigma: sigmaInit,
        muTilde: conservativeSkill(cfg.mu0 + muPrior, sigmaInit, cfg.conservativeC),
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
      cfg
    );
    return {
      athleteId,
      mu: st.mu,
      sigma: driftedSigma,
      muTilde: conservativeSkill(st.mu, driftedSigma, cfg.conservativeC),
      recentDelta: st.recentDelta,
      nStarts: st.nStarts,
      isKnown: true,
    };
  }

  _sessionWeight(ref, cfg) {
    if (ref.session_type === 'REPECHAGE') return cfg.repWeight;
    if (!cfg.enableRoundWeights) return 1.0;
    if (ref.session_type === 'PRELIM') return cfg.prelimWeight;
    if (ref.round === 'semifinal' || ref.round === 'final') return cfg.highTierWeight;
    return cfg.qfWeight;
  }

  /**
   * Build ordered rank tiers, optionally merging co-Q finishers within coastMarginSec
   * in non-final rounds so teammate/coasting photo-finishes don't corrupt skill mu.
   */
  _buildTiers(snapshots, ref, cfg) {
    const byRank = [...snapshots.map((s, idx) => ({ idx, row: s.row }))].sort(
      (a, b) => a.row.rank - b.row.rank
    );
    const tiers = [];
    for (const item of byRank) {
      const prevTier = tiers[tiers.length - 1];
      if (!prevTier) {
        tiers.push([item.idx]);
        continue;
      }
      const rep = snapshots[prevTier[prevTier.length - 1]].row;
      const sameRank = item.row.rank === rep.rank;
      const coastMerge =
        cfg.enableCoastSoftening &&
        ref.round !== 'final' &&
        rep.qual_type === 'Q' &&
        item.row.qual_type === 'Q' &&
        typeof rep.time_s === 'number' &&
        typeof item.row.time_s === 'number' &&
        Math.abs(item.row.time_s - rep.time_s) <= cfg.coastMarginSec;
      if (sameRank || coastMerge) {
        prevTier.push(item.idx);
      } else {
        tiers.push([item.idx]);
      }
    }
    return tiers;
  }

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
    const cfg = this._cfgFor(distanceM);
    const season = ref.season || null;
    const timestampMs = parseTimestampMs(ref);
    const wSession = this._sessionWeight(ref, cfg);

    const snapshots = clean.map((row) => ({
      row,
      prior: this.peekAthlete(row.athlete_id, gender, distanceM, timestampMs, season, row.country || null),
    }));

    const tiers = this._buildTiers(snapshots, ref, cfg);
    if (tiers.length < 2) {
      return { updated: false, reason: 'all_tied', cleanCount: clean.length };
    }

    const n = snapshots.length;
    let meanMu = 0;
    for (const s of snapshots) meanMu += s.prior.mu;
    meanMu /= n;

    const weights = snapshots.map((s) => {
      const z = Math.max(-30, Math.min(30, (s.prior.mu - meanMu) / cfg.plScale));
      return Math.exp(z);
    });

    const grad = new Array(n).fill(0);
    const info = new Array(n).fill(0);

    for (let gIdx = 0; gIdx < tiers.length - 1; gIdx++) {
      const group = tiers[gIdx];
      let remWeight = 0;
      const remIndices = [];
      for (let t = gIdx; t < tiers.length; t++) {
        for (const j of tiers[t]) {
          remIndices.push(j);
          remWeight += weights[j];
        }
      }
      if (!(remWeight > 0)) continue;

      const k = group.length;
      for (const i of group) grad[i] += 1.0;
      for (const j of remIndices) {
        const p = weights[j] / remWeight;
        grad[j] -= k * p;
        info[j] += k * p * (1 - p);
      }
    }

    const dMap = this._disciplineMap(gender, distanceM);
    const betaSq = cfg.beta * cfg.beta;
    const minVar = cfg.minSigma * cfg.minSigma;
    const deltas = [];

    for (let idx = 0; idx < n; idx++) {
      const { row, prior } = snapshots[idx];
      const varPrior = prior.sigma * prior.sigma;
      const alpha = varPrior / (varPrior + betaSq);
      const deltaMu = cfg.eta * wSession * alpha * grad[idx];
      const muNew = prior.mu + deltaMu;

      const shrink = Math.max(0.5, 1 - cfg.kappa * wSession * alpha * Math.min(info[idx], 2.0));
      const varNew = Math.max(minVar, varPrior * shrink);
      const sigmaNew = Math.sqrt(varNew);
      const recentDelta = cfg.recentDecay * prior.recentDelta + (1 - cfg.recentDecay) * deltaMu;

      dMap.set(row.athlete_id, {
        mu: muNew,
        sigma: sigmaNew,
        lastTimestampMs: timestampMs ?? prior.lastTimestampMs ?? null,
        lastSeason: season || null,
        nStarts: prior.nStarts + 1,
        recentDelta,
      });

      if (cfg.enableFederationPrior && row.country) {
        const fKey = federationKey(row.country, row.athlete_id, gender, distanceM);
        const prevF = this.fedStats.get(fKey) || { sumMu: 0, w: 0 };
        const obsW = 1 / (1 + varNew);
        this.fedStats.set(fKey, {
          sumMu: prevF.sumMu * 0.996 + obsW * muNew,
          w: prevF.w * 0.996 + obsW,
        });
      }

      deltas.push({ athleteId: row.athlete_id, deltaMu, muNew, sigmaNew });
    }

    return { updated: true, cleanCount: n, wSession, deltas };
  }

  toJSON() {
    const round = (x) => Math.round(x * 1e6) / 1e6;
    const disciplines = {};
    for (const [dk, m] of this.disciplines.entries()) {
      const obj = {};
      for (const [aid, st] of m.entries()) {
        obj[aid] = [
          round(st.mu),
          round(st.sigma),
          st.lastTimestampMs,
          st.lastSeason,
          st.nStarts,
          round(st.recentDelta),
        ];
      }
      disciplines[dk] = obj;
    }
    const fedStats = {};
    for (const [fk, f] of this.fedStats.entries()) {
      fedStats[fk] = [round(f.sumMu), round(f.w)];
    }
    return { disciplines, fedStats };
  }

  static fromJSON(data, config = V15_RATING_CONFIG, filter = null) {
    const eng = new DynamicRatingEngine(config);
    if (!data) return eng;
    const prefix = filter?.gender ? `${filter.gender}:` : null;
    for (const [dk, obj] of Object.entries(data.disciplines || {})) {
      if (prefix && !dk.startsWith(prefix)) continue;
      const m = new Map();
      for (const [aid, arr] of Object.entries(obj)) {
        m.set(aid, {
          mu: arr[0],
          sigma: arr[1],
          lastTimestampMs: arr[2],
          lastSeason: arr[3],
          nStarts: arr[4],
          recentDelta: arr[5],
        });
      }
      eng.disciplines.set(dk, m);
    }
    const fedSuffix = filter?.gender && filter?.distance ? `:${filter.gender}:${filter.distance}` : null;
    for (const [fk, arr] of Object.entries(data.fedStats || {})) {
      if (fedSuffix && !fk.endsWith(fedSuffix)) continue;
      eng.fedStats.set(fk, { sumMu: arr[0], w: arr[1] });
    }
    return eng;
  }
}
