#!/usr/bin/env node
/**
 * Build compact offline V2 model state snapshot (`data/heats/prediction_state.json`)
 * from all 27 historical events (2022/23-2025/26) for zero-latency Worker inference.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DynamicRatingEngine, V15_RATING_CONFIG } from '../src/prediction/rating.mjs';
import {
  OpeningSplitTracker,
  buildHeatFeatures,
  fitContextualParams,
  fitIncidentTemperature,
  makeTrainingSample,
  scoreHeatFeatures,
} from '../src/prediction/lane-model.mjs';
import { PaceTracker } from '../src/prediction/pace-model.mjs';
import { IncidentRiskModel } from '../src/prediction/incident-model.mjs';
import { recordCleanHeatH2H } from '../src/prediction/explainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEATS_DIR = path.join(ROOT, 'data/heats');
const OUT_PATH = path.join(HEATS_DIR, 'prediction_state.json');

const PARTIAL_EVENT_ID = '2025-26-worldtour-montreal-2';
const SESSION_ORDER = { PRELIM: 0, REPECHAGE: 1, MAIN: 2 };

export function normalizeLookupKey(name, country) {
  const plain = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/['’]/g, '');
  const tokens = plain.split(/[^A-Z]+/).filter(Boolean).sort().join('-');
  return `${country}:${tokens}`;
}

function isCompleteHeat(heat, active) {
  if (active.length < 2) return false;
  if (heat.event_id !== PARTIAL_EVENT_ID) return true;
  if (active.length < 3) return false;
  const ranks = active.map((r) => r.rank).filter((x) => Number.isInteger(x) && x > 0);
  const maxRank = ranks.length ? Math.max(...ranks) : 0;
  return maxRank <= active.length && (ranks.includes(1) || active.some((r) => r.is_incident));
}

export function buildPredictionState(heatsDir = HEATS_DIR) {
  const eventsIdx = JSON.parse(fs.readFileSync(path.join(heatsDir, 'events.json'), 'utf8'));
  const athletesDoc = JSON.parse(fs.readFileSync(path.join(heatsDir, 'athletes.json'), 'utf8'));
  const crosswalkDoc = JSON.parse(fs.readFileSync(path.join(heatsDir, 'athlete_crosswalk.json'), 'utf8'));

  const nameLookup = {};
  const athleteCountries = {};
  for (const a of athletesDoc.items) {
    const latestCountry = a.countries?.[a.countries.length - 1]?.country || '';
    athleteCountries[a.id] = latestCountry;
    for (const cSpell of a.countries || []) {
      nameLookup[normalizeLookupKey(a.name, cSpell.country)] = a.id;
      for (const alias of a.aliases || []) {
        nameLookup[normalizeLookupKey(alias, cSpell.country)] = a.id;
      }
    }
  }

  const crosswalk = {};
  for (const [athId, info] of Object.entries(crosswalkDoc.mappings || {})) {
    crosswalk[athId] = info.athlete_id;
  }

  // Flatten and sort all historical heats chronologically.
  const allHeats = [];
  for (const meta of eventsIdx.items) {
    const ev = JSON.parse(fs.readFileSync(path.join(heatsDir, meta.file), 'utf8'));
    for (const h of ev.heats) {
      const enriched = {
        ...h,
        event_id: ev.event_id,
        season: ev.season,
        city: ev.city,
        rows: h.participants.map((p) => ({
          ...p,
          event_id: ev.event_id,
          season: ev.season,
          city: ev.city,
          local_date: h.local_date,
          start_time_utc: h.start_time_utc,
          gender: h.gender,
          distance_m: h.distance_m,
          session_type: h.session_type,
          round: h.round,
          heat_size: h.heat_size,
        })),
      };
      allHeats.push(enriched);
    }
  }

  allHeats.sort((a, b) => {
    const ta = a.start_time_utc || '';
    const tb = b.start_time_utc || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (a.local_date !== b.local_date) return a.local_date < b.local_date ? -1 : 1;
    const sa = SESSION_ORDER[a.session_type] ?? 9;
    const sb = SESSION_ORDER[b.session_type] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.round_tier !== b.round_tier) return a.round_tier - b.round_tier;
    const hna = a.heat_number ?? 0;
    const hnb = b.heat_number ?? 0;
    if (hna !== hnb) return hna - hnb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const ratingEngine = new DynamicRatingEngine(V15_RATING_CONFIG);
  const openingTracker = new OpeningSplitTracker();
  const paceTracker = new PaceTracker();
  const incidentModel = new IncidentRiskModel();
  const h2hMap = new Map();

  const trainSamples = new Map([[500, []], [1000, []], [1500, []]]);
  const fittedByDist = new Map([
    [500, { theta: [1, 0, 0, 0, 0, 0, 0, 0, 0] }],
    [1000, { theta: [1, 0, 0, 0, 0, 0, 0, 0, 0] }],
    [1500, { theta: [1, 0, 0, 0, 0, 0, 0, 0, 0] }],
  ]);

  let curEv = null;
  let throughTs = '';
  let trainedHeats = 0;

  for (const h of allHeats) {
    if (h.event_id !== curEv) {
      if (curEv !== null) {
        for (const d of [500, 1000, 1500]) {
          fittedByDist.set(d, fitContextualParams(trainSamples.get(d)));
        }
      }
      curEv = h.event_id;
    }

    const active = h.rows.filter((r) => r.status !== 'DNS');
    if (!isCompleteHeat(h, active)) continue;

    if (h.start_time_utc && h.start_time_utc > throughTs) throughTs = h.start_time_utc;

    const features = buildHeatFeatures(active, ratingEngine, openingTracker, paceTracker, {
      extended: true,
      includeFinishKick: true,
      includePace: true,
    });
    const scores = scoreHeatFeatures(features, fittedByDist.get(h.distance_m).theta);
    const activeWithMu = active.map((r, i) => ({ ...r, mu_tilde: features[i][0] }));
    const incProbs = incidentModel.predictHeat(activeWithMu);
    const heatPace = paceTracker.predictHeatPace(active, scores);

    const sample = makeTrainingSample(active, features);
    if (sample) {
      sample.pInc = incProbs.map((p) => p.p_incident);
      trainSamples.get(h.distance_m).push(sample);
    }

    ratingEngine.updateHeat(h.rows);
    openingTracker.updateHeat(h.rows);
    paceTracker.updateHeat(h.rows, { activeRows: active, scores, zPaces: heatPace.zPaces });
    incidentModel.updateHeat(
      h.rows.map((r) => activeWithMu.find((a) => a.athlete_id === r.athlete_id) || r)
    );
    recordCleanHeatH2H(h2hMap, active);
    trainedHeats++;
  }

  // Final full-horizon contextual & temperature fits.
  const thetaByDistance = {};
  const tempByDistance = {};
  for (const d of [500, 1000, 1500]) {
    const fRes = fitContextualParams(trainSamples.get(d));
    thetaByDistance[d] = fRes.theta.map((x) => Math.round(x * 1e6) / 1e6);
    tempByDistance[d] = Math.round(fitIncidentTemperature(trainSamples.get(d), fRes.theta) * 1e6) / 1e6;
  }

  const h2hSorted = {};
  for (const k of [...h2hMap.keys()].sort()) {
    h2hSorted[k] = h2hMap.get(k);
  }

  const rating = ratingEngine.toJSON();
  // One preseason adjustment at the 2025/26 checkpoint. Live replay then updates
  // RUS independently. Give the seed one regularization unit of evidence.
  if (eventsIdx.items.map(event => event.season).sort().at(-1) === '2025/26') {
    const tau = V15_RATING_CONFIG.fedPriorTau;
    for (const gender of ['men', 'women']) {
      for (const distance of [500, 1000, 1500]) {
        const china = rating.fedStats[`CHN:${gender}:${distance}`];
        if (!china) continue;
        const mean = china[0] / (china[1] + tau);
        rating.fedStats[`RUS:${gender}:${distance}`] = [mean * (tau + tau), tau];
      }
    }
  }

  return {
    schema_version: 1,
    generated_from: '2022/23-2025/26',
    trained_events: eventsIdx.event_count,
    trained_heats: trainedHeats,
    through_timestamp_utc: throughTs,
    crosswalk,
    official_ids: Object.fromEntries(athletesDoc.items.flatMap(a => a.official_skater_ids.map(id => [id, a.id]))),
    name_lookup: nameLookup,
    athlete_countries: athleteCountries,
    theta_by_distance: thetaByDistance,
    temp_by_distance: tempByDistance,
    rating,
    opening: openingTracker.toJSON(),
    pace: paceTracker.toJSON(),
    incident: incidentModel.toJSON(),
    h2h: h2hSorted,
  };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const t0 = Date.now();
  const state = buildPredictionState(HEATS_DIR);
  const serialized = JSON.stringify(state) + '\n';
  fs.writeFileSync(OUT_PATH, serialized, 'utf8');
  console.log(
    `Built ${OUT_PATH} (${(Buffer.byteLength(serialized, 'utf8') / 1024).toFixed(1)} KB, ` +
      `${state.trained_events} events, ${state.trained_heats} heats, ` +
      `${Object.keys(state.h2h).length} H2H pairs, through ${state.through_timestamp_utc}) in ${Date.now() - t0} ms`
  );
}
