#!/usr/bin/env node
/**
 * Strict chronological Walk-Forward backtest for Phase 2 V1 prediction stack
 * across 2022/23-2026/27 (29 events, 5,168 heats, 27,098 starts).
 *
 * Warm-up:   2022/23 (7 events)
 * Eval:      2023/24-2026/27 (22 events; clean 21 events + complete heats of partial event 960)
 * Models:    Baseline 0 (Uniform), Baseline 1 (Pure Skill mu), Legacy (within-season batch PL), V1 (Full Phase 2)
 * Output:    docs/backtest_v1_report.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { predictHeat } from '../src/prediction/plackett-luce.mjs';
import { DynamicRatingEngine } from '../src/prediction/rating.mjs';
import {
  DEFAULT_PRIOR_MEAN,
  OpeningSplitTracker,
  buildHeatFeatures,
  fitContextualParams,
  makeTrainingSample,
  scoreHeatFeatures,
} from '../src/prediction/lane-model.mjs';
import { ratings as legacyBatchRatings } from '../src/private-analysis.mjs';
import { sprintModel as legacySprintModel } from '../src/sprint-model.mjs';
import openingSplitsMap from '../src/opening-splits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAT_STARTS_JSONL = path.join(ROOT, 'build/heat_starts.jsonl');
const CROSSWALK_PATH = path.join(ROOT, 'data/heats/athlete_crosswalk.json');
const REPORT_PATH = path.join(ROOT, 'docs/backtest_v1_report.md');

const WARMUP_SEASONS = new Set(['2022/23']);
const PARTIAL_EVENT_ID = '2025-26-worldtour-montreal-2';
const DISCIPLINES = [
  ['men', 500],
  ['men', 1000],
  ['men', 1500],
  ['women', 500],
  ['women', 1000],
  ['women', 1500],
];

function loadDataset() {
  const raw = fs.readFileSync(HEAT_STARTS_JSONL, 'utf8');
  const crosswalk = JSON.parse(fs.readFileSync(CROSSWALK_PATH, 'utf8')).mappings;
  const reverseSplitByHeatAthlete = new Map();
  for (const [k, val] of Object.entries(openingSplitsMap)) {
    const slash = k.indexOf('/');
    if (slash < 0) continue;
    const heatId = k.slice(0, slash);
    const athId = k.slice(slash + 1);
    const mapped = crosswalk[athId]?.athlete_id;
    if (mapped) reverseSplitByHeatAthlete.set(`${heatId}/${mapped}`, val);
  }

  const heats = [];
  let curKey = null;
  let curRows = [];
  const roundMaxQ = new Map();

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.opening_split_s == null) {
      const splitVal = reverseSplitByHeatAthlete.get(`${r.heat_id}/${r.athlete_id}`);
      if (splitVal != null) r.opening_split_s = splitVal;
    }

    const hKey = `${r.event_id}::${r.heat_id}`;
    if (hKey !== curKey) {
      if (curRows.length) heats.push(curRows);
      curKey = hKey;
      curRows = [r];
    } else {
      curRows.push(r);
    }

    if (r.round !== 'final' && r.big_q == null) {
      const rk = `${r.event_id}::${r.gender}::${r.distance_m}::${r.session_type}::${r.round}`;
      // Track Q count per heat inside this round.
      let hm = roundMaxQ.get(rk);
      if (!hm) {
        hm = new Map();
        roundMaxQ.set(rk, hm);
      }
      hm.set(r.heat_id, (hm.get(r.heat_id) || 0) + (r.qual_type === 'Q' ? 1 : 0));
    }
  }
  if (curRows.length) heats.push(curRows);

  // Backfill static round big_q where 2026/27 lacked schedule big_q column.
  const roundBigQ = new Map();
  for (const [rk, hm] of roundMaxQ.entries()) {
    let mx = 0;
    for (const c of hm.values()) if (c > mx) mx = c;
    roundBigQ.set(rk, mx);
  }
  for (const rows of heats) {
    const r0 = rows[0];
    if (r0.round !== 'final' && r0.big_q == null) {
      const rk = `${r0.event_id}::${r0.gender}::${r0.distance_m}::${r0.session_type}::${r0.round}`;
      const bq = roundBigQ.get(rk) ?? 0;
      for (const r of rows) r.big_q = bq;
    }
  }

  return heats;
}

function isCompleteHeat(rows) {
  const r0 = rows[0];
  const active = rows.filter((r) => r.status !== 'DNS');
  if (active.length < 2) return false;
  if (r0.event_id !== PARTIAL_EVENT_ID) return true;
  if (active.length < 3) return false;
  const ranks = active.map((r) => r.rank).filter((x) => Number.isInteger(x) && x > 0);
  const maxRank = ranks.length ? Math.max(...ranks) : 0;
  const hasRank1 = ranks.includes(1);
  const hasInc = active.some((r) => r.is_incident);
  return maxRank <= active.length && (hasRank1 || hasInc);
}

function isCleanRanked(r) {
  return (r.status === 'OK' || r.status === 'NO_TIME') && Number.isInteger(r.rank) && r.rank > 0;
}

function spearmanCorr(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  function rankArray(arr) {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avgRank;
      i = j + 1;
    }
    return r;
  }
  const rx = rankArray(xs);
  const ry = rankArray(ys);
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += rx[i];
    meanY += ry[i];
  }
  meanX /= n;
  meanY /= n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den > 0 ? num / den : null;
}

function createMetricAccumulator() {
  return {
    firstHeats: 0,
    firstStarts: 0,
    firstLogLossSum: 0,
    firstBrierSum: 0,
    firstTop1Hits: 0,
    firstBins: Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, ySum: 0 })),

    bigQHeats: 0,
    bigQStarts: 0,
    bigQLogLossSum: 0,
    bigQBrierSum: 0,
    bigQBins: Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, ySum: 0 })),

    rankStarts: 0,
    rankAbsErrSum: 0,
    predRanks: [],
    actualRanks: [],

    chnRankStarts: 0,
    chnRankAbsErrSum: 0,
  };
}

function recordHeatMetrics(acc, activeRows, pred, bigQ) {
  const eps = 1e-12;
  const clamp = (p) => Math.max(eps, Math.min(1 - eps, p));

  // 1st-place categorical evaluation (requires unique clean winner rank===1).
  const winners = [];
  for (let i = 0; i < activeRows.length; i++) {
    if (activeRows[i].rank === 1) winners.push(i);
  }
  if (winners.length === 1) {
    const wIdx = winners[0];
    acc.firstHeats++;
    acc.firstLogLossSum += -Math.log(clamp(pred.pFirst[wIdx]));
    let maxP = -Infinity;
    let maxIndices = [];
    for (let i = 0; i < activeRows.length; i++) {
      const p = pred.pFirst[i];
      const y = i === wIdx ? 1 : 0;
      acc.firstStarts++;
      acc.firstBrierSum += (p - y) * (p - y);
      if (p > maxP + 1e-12) {
        maxP = p;
        maxIndices = [i];
      } else if (Math.abs(p - maxP) <= 1e-12) {
        maxIndices.push(i);
      }
      const binIdx = Math.min(9, Math.max(0, Math.floor(p * 10)));
      acc.firstBins[binIdx].n++;
      acc.firstBins[binIdx].pSum += p;
      acc.firstBins[binIdx].ySum += y;
    }
    if (maxIndices.includes(wIdx)) acc.firstTop1Hits += 1 / maxIndices.length;
  }

  // Big-Q binary evaluation on non-final rounds with bigQ > 0.
  if (activeRows[0].round !== 'final' && bigQ > 0) {
    acc.bigQHeats++;
    for (let i = 0; i < activeRows.length; i++) {
      const p = clamp(pred.pBigQ[i]);
      const y = activeRows[i].qual_type === 'Q' ? 1 : 0;
      acc.bigQStarts++;
      acc.bigQLogLossSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      acc.bigQBrierSum += (pred.pBigQ[i] - y) * (pred.pBigQ[i] - y);
      const binIdx = Math.min(9, Math.max(0, Math.floor(pred.pBigQ[i] * 10)));
      acc.bigQBins[binIdx].n++;
      acc.bigQBins[binIdx].pSum += pred.pBigQ[i];
      acc.bigQBins[binIdx].ySum += y;
    }
  }

  // Rank MAE & Spearman over clean finishers.
  for (let i = 0; i < activeRows.length; i++) {
    const r = activeRows[i];
    if (!isCleanRanked(r)) continue;
    const err = Math.abs(pred.expectedPlace[i] - r.rank);
    acc.rankStarts++;
    acc.rankAbsErrSum += err;
    acc.predRanks.push(pred.expectedPlace[i]);
    acc.actualRanks.push(r.rank);
    if (r.country === 'CHN') {
      acc.chnRankStarts++;
      acc.chnRankAbsErrSum += err;
    }
  }
}

function summarizeAccumulator(acc) {
  function computeECE(bins, total) {
    if (!total) return null;
    let ece = 0;
    const rows = bins.map((b, i) => {
      if (!b.n) return { bin: `[${(i / 10).toFixed(1)},${((i + 1) / 10).toFixed(1)})`, n: 0, pred: null, actual: null, gap: null };
      const pred = b.pSum / b.n;
      const actual = b.ySum / b.n;
      const gap = Math.abs(actual - pred);
      ece += (b.n / total) * gap;
      return {
        bin: `[${(i / 10).toFixed(1)},${((i + 1) / 10).toFixed(1)}${i === 9 ? ']' : ')'}`,
        n: b.n,
        pred,
        actual,
        gap,
      };
    });
    return { ece, rows };
  }
  const firstCal = computeECE(acc.firstBins, acc.firstStarts);
  const bigQCal = computeECE(acc.bigQBins, acc.bigQStarts);
  return {
    firstHeats: acc.firstHeats,
    firstStarts: acc.firstStarts,
    firstLogLoss: acc.firstHeats ? acc.firstLogLossSum / acc.firstHeats : null,
    firstBrier: acc.firstHeats ? acc.firstBrierSum / acc.firstHeats : null,
    firstTop1Acc: acc.firstHeats ? acc.firstTop1Hits / acc.firstHeats : null,
    firstECE: firstCal.ece,
    bigQHeats: acc.bigQHeats,
    bigQStarts: acc.bigQStarts,
    bigQLogLoss: acc.bigQStarts ? acc.bigQLogLossSum / acc.bigQStarts : null,
    bigQBrier: acc.bigQStarts ? acc.bigQBrierSum / acc.bigQStarts : null,
    bigQECE: bigQCal.ece,
    bigQReliability: bigQCal.rows,
    rankStarts: acc.rankStarts,
    rankMAE: acc.rankStarts ? acc.rankAbsErrSum / acc.rankStarts : null,
    spearman: spearmanCorr(acc.predRanks, acc.actualRanks),
    chnRankStarts: acc.chnRankStarts,
    chnRankMAE: acc.chnRankStarts ? acc.chnRankAbsErrSum / acc.chnRankStarts : null,
  };
}

function runBacktest() {
  const t0 = Date.now();
  const heats = loadDataset();
  const ratingEngine = new DynamicRatingEngine();
  const openingTracker = new OpeningSplitTracker();

  // Per-distance training sample buffer & fitted contextual theta (strictly past completed events).
  const trainSamplesByDist = new Map([
    [500, []],
    [1000, []],
    [1500, []],
  ]);
  const fittedByDist = new Map([
    [500, { theta: [...DEFAULT_PRIOR_MEAN], nRaces: 0 }],
    [1000, { theta: [...DEFAULT_PRIOR_MEAN], nRaces: 0 }],
    [1500, { theta: [...DEFAULT_PRIOR_MEAN], nRaces: 0 }],
  ]);

  // Legacy state: per-season-discipline finished races & heats, refit on round boundaries.
  const legacyRaces = new Map();
  const legacyHeats500 = new Map();
  const legacyCache = new Map(); // (season:gender:dist) -> { roundKey, scores, sprint }

  const MODEL_NAMES = ['Baseline 0', 'Baseline 1', 'Legacy', 'V1'];
  const makeBucket = () => Object.fromEntries(MODEL_NAMES.map((m) => [m, createMetricAccumulator()]));

  const cleanOverall = makeBucket();
  const with960Overall = makeBucket();
  const byDiscClean = new Map();
  const bySeasonClean = new Map();
  const slice2627 = makeBucket();

  for (const [g, d] of DISCIPLINES) byDiscClean.set(`${g}:${d}`, makeBucket());

  let currentEventId = null;
  let currentSeason = null;
  const thetaHistoryByEvent = [];

  function legacyPredictScores(activeRows, r0) {
    const key = `${r0.season}:${r0.gender}:${r0.distance_m}`;
    const roundTag = `${r0.event_id}::${r0.round_key}`;
    let cached = legacyCache.get(key);
    if (!cached || cached.roundTag !== roundTag) {
      const races = legacyRaces.get(key) || [];
      const scores = races.length ? legacyBatchRatings(races) : new Map();
      let sprint = null;
      if (r0.distance_m === 500) {
        const hs500 = legacyHeats500.get(key) || [];
        if (hs500.length) {
          sprint = legacySprintModel(hs500, scores, (p) => p.athlete_id);
        }
      }
      cached = { roundTag, scores, sprint };
      legacyCache.set(key, cached);
    }
    const lanes = activeRows.map((p) => p.starting_position).filter((n) => Number.isInteger(n) && n > 0);
    const center = lanes.length ? lanes.reduce((a, b) => a + b, 0) / lanes.length : 0;
    return activeRows.map((p) => {
      const base = cached.scores.get(p.athlete_id) || 0;
      const adj = cached.sprint ? cached.sprint(p, center).adjustment : 0;
      return base + adj;
    });
  }

  for (const heatRows of heats) {
    const r0 = heatRows[0];
    // Event boundary: refit V1 contextual lane parameters using ONLY strictly prior completed events.
    if (r0.event_id !== currentEventId) {
      if (currentEventId !== null) {
        for (const d of [500, 1000, 1500]) {
          const res = fitContextualParams(trainSamplesByDist.get(d));
          fittedByDist.set(d, res);
        }
        thetaHistoryByEvent.push({
          beforeEvent: r0.event_id,
          season: r0.season,
          paramsByDist: Object.fromEntries(
            [500, 1000, 1500].map((d) => [d, { ...fittedByDist.get(d).params, nRaces: fittedByDist.get(d).nRaces }])
          ),
        });
      }
      if (r0.season !== currentSeason) {
        currentSeason = r0.season;
      }
      currentEventId = r0.event_id;
    }

    const complete = isCompleteHeat(heatRows);
    const activeRows = heatRows.filter((r) => r.status !== 'DNS');
    if (!complete || activeRows.length < 2) continue;

    // 1. Pre-race snapshot & feature construction (ZERO future leakage).
    const tMs = r0.start_time_utc ? Date.parse(r0.start_time_utc) : null;
    const features = buildHeatFeatures(activeRows, ratingEngine, openingTracker);
    const theta = fittedByDist.get(r0.distance_m).theta;
    const bigQ = r0.round !== 'final' ? (r0.big_q || 0) : 0;

    // 2. Evaluate on post-warmup seasons (2023/24-2026/27).
    if (!WARMUP_SEASONS.has(r0.season)) {
      const sBase0 = activeRows.map(() => 0);
      const sBase1 = activeRows.map((r) =>
        ratingEngine.peekAthlete(r.athlete_id, r.gender, r.distance_m, tMs, r0.season).mu
      );
      const sLegacy = legacyPredictScores(activeRows, r0);
      const sV1 = scoreHeatFeatures(features, theta);

      const preds = {
        'Baseline 0': predictHeat(sBase0, bigQ),
        'Baseline 1': predictHeat(sBase1, bigQ),
        Legacy: predictHeat(sLegacy, bigQ),
        V1: predictHeat(sV1, bigQ),
      };

      const discKey = `${r0.gender}:${r0.distance_m}`;
      if (!bySeasonClean.has(r0.season)) bySeasonClean.set(r0.season, makeBucket());

      for (const mName of MODEL_NAMES) {
        recordHeatMetrics(with960Overall[mName], activeRows, preds[mName], bigQ);
        if (r0.event_id !== PARTIAL_EVENT_ID) {
          recordHeatMetrics(cleanOverall[mName], activeRows, preds[mName], bigQ);
          recordHeatMetrics(byDiscClean.get(discKey)[mName], activeRows, preds[mName], bigQ);
          recordHeatMetrics(bySeasonClean.get(r0.season)[mName], activeRows, preds[mName], bigQ);
          if (r0.season === '2026/27') {
            recordHeatMetrics(slice2627[mName], activeRows, preds[mName], bigQ);
          }
        }
      }
    }

    // 3. Post-race updates strictly AFTER predictions were recorded.
    const sample = makeTrainingSample(activeRows, features);
    if (sample) trainSamplesByDist.get(r0.distance_m).push(sample);

    ratingEngine.updateHeat(heatRows);
    openingTracker.updateHeat(heatRows);

    // Update Legacy within-season race buffer.
    const cleanOrdered = activeRows.filter(isCleanRanked).sort((a, b) => a.rank - b.rank);
    const legKey = `${r0.season}:${r0.gender}:${r0.distance_m}`;
    if (cleanOrdered.length >= 2) {
      let arr = legacyRaces.get(legKey);
      if (!arr) {
        arr = [];
        legacyRaces.set(legKey, arr);
      }
      arr.push(cleanOrdered.map((r) => r.athlete_id));
    }
    if (r0.distance_m === 500) {
      let hArr = legacyHeats500.get(legKey);
      if (!hArr) {
        hArr = [];
        legacyHeats500.set(legKey, hArr);
      }
      hArr.push({
        id: r0.heat_id,
        participants: activeRows.map((r) => ({
          athlete_id: r.athlete_id,
          starting_position: r.starting_position,
          rank: r.rank,
          penalty: r.is_incident && r.incident_type === 'PEN' ? r.status : null,
          result: r.status === 'DNF' ? 'DNF' : r.result,
          opening_split_seconds: r.opening_split_s,
        })),
      });
    }
  }

  // Final parameter fit after all 29 events (for reporting end-of-horizon structural weights).
  const finalFitted = {};
  for (const d of [500, 1000, 1500]) {
    finalFitted[d] = fitContextualParams(trainSamplesByDist.get(d));
  }

  return {
    elapsedMs: Date.now() - t0,
    cleanOverall: Object.fromEntries(MODEL_NAMES.map((m) => [m, summarizeAccumulator(cleanOverall[m])])),
    with960Overall: Object.fromEntries(MODEL_NAMES.map((m) => [m, summarizeAccumulator(with960Overall[m])])),
    byDiscClean: Object.fromEntries(
      [...byDiscClean.entries()].map(([k, b]) => [
        k,
        Object.fromEntries(MODEL_NAMES.map((m) => [m, summarizeAccumulator(b[m])])),
      ])
    ),
    bySeasonClean: Object.fromEntries(
      [...bySeasonClean.entries()].map(([k, b]) => [
        k,
        Object.fromEntries(MODEL_NAMES.map((m) => [m, summarizeAccumulator(b[m])])),
      ])
    ),
    slice2627: Object.fromEntries(MODEL_NAMES.map((m) => [m, summarizeAccumulator(slice2627[m])])),
    finalFitted,
    thetaHistoryByEvent,
  };
}

function fmt(x, digits = 4) {
  return x == null ? '—' : x.toFixed(digits);
}

function fmtPct(x, digits = 2) {
  return x == null ? '—' : `${(x * 100).toFixed(digits)}%`;
}

function buildMarkdownReport(res) {
  const lines = [];
  const MODEL_NAMES = ['Baseline 0', 'Baseline 1', 'Legacy', 'V1'];

  lines.push('# Phase 2 V1 Walk-Forward Backtest & Calibration Report');
  lines.push('');
  lines.push(`- **Dataset**: \`build/heat_starts.jsonl\` (29 events, 5,168 heats, 27,098 starts across \`2022/23–2026/27\`)`);
  lines.push('- **Walk-Forward Protocol**:');
  lines.push('  - **Warm-up**: `2022/23` (7 World Cup + Worlds events)');
  lines.push('  - **Evaluation Window**: `2023/24–2026/27` (21 complete events; `960` 2025/26 WT2 Montreal reported separately on its 69 complete heats)');
  lines.push('  - **Zero Future Leakage**: Skill `(mu, sigma)`, opening-split profile `z_opening`, and contextual lane parameters `theta` for heat `h` use only races strictly prior to heat `h` (and `theta` refits only at completed event boundaries).');
  lines.push(`- **Runtime**: ${res.elapsedMs} ms total across all 29 events`);
  lines.push('');

  function pushSummaryTable(title, bucket) {
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Model | 1st Heats | 1st Log-Loss | 1st Brier | Top-1 Acc | 1st ECE | Big-Q Starts | Big-Q Log-Loss | Big-Q Brier | Big-Q ECE | Rank MAE | CHN MAE | Spearman |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const m of MODEL_NAMES) {
      const s = bucket[m];
      lines.push(
        `| **${m}** | ${s.firstHeats} | ${fmt(s.firstLogLoss)} | ${fmt(s.firstBrier)} | ${fmtPct(s.firstTop1Acc)} | ${fmt(s.firstECE)} | ${s.bigQStarts} | ${fmt(s.bigQLogLoss)} | ${fmt(s.bigQBrier)} | ${fmt(s.bigQECE)} | ${fmt(s.rankMAE, 3)} | ${fmt(s.chnRankMAE, 3)} | ${fmt(s.spearman, 4)} |`
      );
    }
    lines.push('');
  }

  pushSummaryTable('1. Overall Evaluation (`2023/24–2026/27`, Clean 21 Events)', res.cleanOverall);
  pushSummaryTable('2. Overall Including Complete Heats of Partial Event `960` (22 Events)', res.with960Overall);
  pushSummaryTable('3. 2026/27 Season Slice (`Vancouver + Montreal`: 4-Year Base V1 vs Single-Season Legacy)', res.slice2627);

  lines.push('## 4. Per-Season Breakdown (Clean Events)');
  lines.push('');
  lines.push('| Season | Model | 1st Heats | 1st Log-Loss | Top-1 Acc | Big-Q Log-Loss | Big-Q Brier | Rank MAE | CHN MAE |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [season, bucket] of Object.entries(res.bySeasonClean)) {
    for (const m of MODEL_NAMES) {
      const s = bucket[m];
      lines.push(
        `| ${season} | ${m} | ${s.firstHeats} | ${fmt(s.firstLogLoss)} | ${fmtPct(s.firstTop1Acc)} | ${fmt(s.bigQLogLoss)} | ${fmt(s.bigQBrier)} | ${fmt(s.rankMAE, 3)} | ${fmt(s.chnRankMAE, 3)} |`
      );
    }
  }
  lines.push('');

  lines.push('## 5. Per-Discipline Breakdown (`2023/24–2026/27`, Clean 21 Events)');
  lines.push('');
  lines.push('| Discipline | Model | 1st Heats | 1st Log-Loss | 1st Brier | Top-1 Acc | Big-Q Log-Loss | Big-Q Brier | Rank MAE | CHN MAE |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [g, d] of DISCIPLINES) {
    const dk = `${g}:${d}`;
    const bucket = res.byDiscClean[dk];
    for (const m of MODEL_NAMES) {
      const s = bucket[m];
      lines.push(
        `| ${g} ${d}m | ${m} | ${s.firstHeats} | ${fmt(s.firstLogLoss)} | ${fmt(s.firstBrier)} | ${fmtPct(s.firstTop1Acc)} | ${fmt(s.bigQLogLoss)} | ${fmt(s.bigQBrier)} | ${fmt(s.rankMAE, 3)} | ${fmt(s.chnRankMAE, 3)} |`
      );
    }
  }
  lines.push('');

  lines.push('## 6. Endogeneity-Controlled Contextual Parameters (`lane-model.mjs`, End of Horizon)');
  lines.push('');
  lines.push('All parameters fitted jointly via penalized Plackett-Luce MLE controlling for pre-race conservative skill $\\tilde{\\mu}_i$ and `is_repechage_qualifier`. Positive `betaLane*` confirms physical inner-lane advantage after removing strong-skater seeding bias.');
  lines.push('');
  lines.push('| Distance | Races Fit | `alphaScale` ($\\tilde{\\mu}$) | `betaLanePrelim` | `betaLaneMain` | `betaRep` | `betaForm` | `betaSplit` |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const d of [500, 1000, 1500]) {
    const f = res.finalFitted[d];
    const p = f.params;
    lines.push(
      `| ${d}m | ${f.nRaces} | ${fmt(p.alphaScale, 4)} | ${fmt(p.betaLanePrelim, 4)} | ${fmt(p.betaLaneMain, 4)} | ${fmt(p.betaRep, 4)} | ${fmt(p.betaForm, 4)} | ${fmt(p.betaSplit, 4)} |`
    );
  }
  lines.push('');

  lines.push('## 7. V1 Big-Q 10-Bin Calibration Reliability Table (`2023/24–2026/27`, Clean 21 Events)');
  lines.push('');
  lines.push(`Overall Big-Q ECE: **${fmt(res.cleanOverall.V1.bigQECE, 4)}** (${res.cleanOverall.V1.bigQStarts} non-final starts)`);
  lines.push('');
  lines.push('| Probability Bin | Count | Mean Predicted $P(\\text{Big Q})$ | Observed `Q` Rate | Abs Gap |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const row of res.cleanOverall.V1.bigQReliability) {
    lines.push(
      `| \`${row.bin}\` | ${row.n} | ${fmtPct(row.pred, 2)} | ${fmtPct(row.actual, 2)} | ${fmtPct(row.gap, 2)} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

const res = runBacktest();
const md = buildMarkdownReport(res);
fs.writeFileSync(REPORT_PATH, md, 'utf8');

console.log(`Backtest completed in ${res.elapsedMs} ms -> ${REPORT_PATH}`);
for (const m of ['Baseline 0', 'Baseline 1', 'Legacy', 'V1']) {
  const s = res.cleanOverall[m];
  console.log(
    `[Clean 21] ${m.padEnd(10)} | 1st LL=${fmt(s.firstLogLoss)} Brier=${fmt(s.firstBrier)} Top1=${fmtPct(s.firstTop1Acc)} | BigQ LL=${fmt(s.bigQLogLoss)} Brier=${fmt(s.bigQBrier)} ECE=${fmt(s.bigQECE)} | MAE=${fmt(s.rankMAE, 3)} CHN=${fmt(s.chnRankMAE, 3)}`
  );
}
for (const m of ['Baseline 0', 'Baseline 1', 'Legacy', 'V1']) {
  const s = res.slice2627[m];
  console.log(
    `[2026/27]  ${m.padEnd(10)} | 1st LL=${fmt(s.firstLogLoss)} Brier=${fmt(s.firstBrier)} Top1=${fmtPct(s.firstTop1Acc)} | BigQ LL=${fmt(s.bigQLogLoss)} Brier=${fmt(s.bigQBrier)} | MAE=${fmt(s.rankMAE, 3)} CHN=${fmt(s.chnRankMAE, 3)}`
  );
}
for (const d of [500, 1000, 1500]) {
  console.log(`[Params ${d}m]`, res.finalFitted[d].params);
}
