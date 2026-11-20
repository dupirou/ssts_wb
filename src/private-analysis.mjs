import historical from './historical-heats.mjs';
import women1000 from './historical-women-1000.mjs';
import chinaHistory from './china-history.mjs';
import { sprintModel } from './sprint-model.mjs';
import openingSplitsMap from './opening-splits.mjs';
import { DynamicRatingEngine, V15_RATING_CONFIG } from './prediction/rating.mjs';
import {
  OpeningSplitTracker,
  buildHeatFeatures,
  scoreHeatFeatures,
} from './prediction/lane-model.mjs';
import { PaceTracker } from './prediction/pace-model.mjs';
import { IncidentRiskModel } from './prediction/incident-model.mjs';
import { previousRoundForm, withinHeatForm, advanceFormWeight } from './prediction/advance-form.mjs';
import { simulateRound } from './prediction/monte-carlo.mjs';
import {
  explainHeat,
  recordCleanHeatH2H,
} from './prediction/explainer.mjs';

export const key = (name, country) =>
  country +
  ':' +
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/['’]/g, '')
    .split(/[^A-Z]+/)
    .filter(Boolean)
    .sort()
    .join('-');

const athlete = (p) => key(p.name_latin || p.name, p.country);

// Regularized Plackett–Luce scores over ordered finishers. An unseen skater starts at zero.
export function ratings(races, standings = []) {
  const weightsByRace = new Map(standings.map((race) => [race, 0.25]));
  races = races.concat(standings);
  const scores = new Map(races.flat().map((id) => [id, 0]));
  const counts = new Map();
  for (const race of races)
    for (const id of race) counts.set(id, (weightsByRace.get(race) ?? 1) + (counts.get(id) || 0));
  for (let step = 0; step < 80; step++) {
    const gradient = new Map([...scores].map(([id, value]) => [id, -value]));
    for (const race of races) {
      const influence = weightsByRace.get(race) ?? 1;
      let total = 0;
      const weights = race.map((id) => Math.exp(scores.get(id)));
      for (let i = race.length - 1; i >= 0; i--) {
        total += weights[i];
        if (i === race.length - 1) continue;
        gradient.set(race[i], gradient.get(race[i]) + influence);
        for (let j = i; j < race.length; j++)
          gradient.set(race[j], gradient.get(race[j]) - (influence * weights[j]) / total);
      }
    }
    for (const [id, g] of gradient) scores.set(id, scores.get(id) + (0.55 * g) / (1 + counts.get(id)));
  }
  return scores;
}

function topPlaces(weights, places) {
  const probabilities = weights.map(() => 0);
  function visit(remaining, slots, probability) {
    if (!slots) return;
    const total = remaining.reduce((sum, i) => sum + weights[i], 0);
    for (const i of remaining) {
      const next = (probability * weights[i]) / total;
      probabilities[i] += next;
      visit(
        remaining.filter((j) => j !== i),
        slots - 1,
        next
      );
    }
  }
  if (places >= weights.length) return weights.map(() => 1);
  visit(
    weights.map((_, i) => i),
    places,
    1
  );
  return probabilities;
}

async function asset(env, path) {
  const response = await env.ASSETS.fetch(new URL(path, 'https://assets.local'));
  if (!response.ok) throw new Error('Missing race data');
  return response.json();
}

async function optionalAsset(env, path) {
  try {
    const response = await env.ASSETS.fetch(new URL(path, 'https://assets.local'));
    if (!response || !response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export function chinaResults(gender, distance) {
  const china = new Map(),
    standings = [];
  for (const [g, d, entries] of chinaHistory) {
    if (g !== gender || d !== distance) continue;
    for (const [name, rank] of entries) {
      const id = key(name, 'CHN'),
        row = china.get(id) || { count: 0, best: Infinity, podiums: 0 };
      row.count++;
      row.best = Math.min(row.best, rank);
      row.podiums += Number(rank <= 3);
      china.set(id, row);
    }
    if (entries.length > 1 && new Set(entries.map((e) => e[1])).size === entries.length)
      standings.push(entries.map(([name]) => key(name, 'CHN')));
  }
  return { china, standings };
}

function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 20261119;
}

function parseTimeSeconds(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || /^(no\s*time|pen|yc|rc|dnf|dns|dq)/i.test(s)) return null;
  if (s.includes(':')) {
    const parts = s.split(':');
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    return Number.isFinite(mins) && Number.isFinite(secs) ? mins * 60 + secs : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseLiveRoundContext(roundLabel, roundEnum) {
  const lbl = String(roundLabel || '');
  const isRep = /^rep\./i.test(lbl) || lbl.toLowerCase().includes('repechage');
  const lower = lbl.toLowerCase();
  let rnd = roundEnum || 'heats';
  let tier = 1;
  if (lower.includes('final') && !lower.includes('quarter') && !lower.includes('semi')) {
    rnd = 'final';
    tier = 5;
  } else if (lower.includes('semifinal')) {
    rnd = 'semifinal';
    tier = 3;
  } else if (lower.includes('quarterfinal')) {
    rnd = 'quarterfinal';
    tier = 2;
  } else if (lower.includes('prelim')) {
    rnd = 'preliminaries';
    tier = 0;
  }
  const session_type = isRep ? 'REPECHAGE' : rnd === 'preliminaries' || rnd === 'heats' ? 'PRELIM' : 'MAIN';
  return { session_type, round: rnd, round_tier: tier };
}

function normalizeLiveQualification(qualRaw, sessionType, round) {
  if (!qualRaw) return { qual_type: round === 'final' ? null : 'OUT', qual_target: null };
  const q = String(qualRaw).trim();
  if (q === 'p') return { qual_type: 'p', qual_target: null };
  if (q === 'Q' || q === 'QA') return { qual_type: 'Q', qual_target: round === 'semifinal' && sessionType === 'MAIN' ? 'FA' : 'NEXT' };
  if (q === 'q' || q === 'qA') return { qual_type: 'q', qual_target: round === 'semifinal' && sessionType === 'MAIN' ? 'FA' : 'NEXT' };
  if (q === 'QB' || q === 'qB') return { qual_type: q, qual_target: 'FB' };
  if (q.toUpperCase().startsWith('ADV')) {
    const u = q.toUpperCase();
    return { qual_type: 'ADV', qual_target: u === 'ADVB' ? 'FB' : u === 'ADVA' ? 'FA' : 'NEXT' };
  }
  return { qual_type: 'OUT', qual_target: null };
}

function liveAthleteId(p, state) {
  const oid = p.official_skater_id;
  return state.crosswalk?.[p.athlete_id] ||
    (Number.isInteger(oid) && oid > 0 ? state.official_ids?.[oid] || `skr-${oid}` : null) ||
    state.name_lookup?.[athlete(p)] || p.athlete_id;
}

function normalizeLiveHeatRows(heat, station, state, season) {
  const { session_type, round, round_tier } = parseLiveRoundContext(heat.round_label, heat.round);
  const activeCount = (heat.participants || []).filter((p) => p.result !== 'DNS').length;
  const startUtc = heat.source_start || (heat.local_date ? `${heat.local_date}T00:00:00Z` : null);
  const city = station.city_en || station.city || station.id;

  const rows = (heat.participants || []).map((p) => {
    const cid = liveAthleteId(p, state);
    const time_s = parseTimeSeconds(p.result);
    const { qual_type, qual_target } = normalizeLiveQualification(p.qualification, session_type, round);
    let status = 'NO_TIME';
    if (p.result === 'DNS') status = 'DNS';
    else if (p.penalty?.code === 'YC') status = 'YC';
    else if (p.penalty?.code === 'RC') status = 'RC';
    else if (p.penalty || p.result === 'PEN' || p.result === 'DQ') status = 'PEN';
    else if (p.result === 'DNF') status = 'DNF';
    else if (qual_type === 'ADV') status = 'ADV';
    else if (time_s != null) status = 'OK';

    const openingSplit =
      typeof p.opening_split_seconds === 'number'
        ? p.opening_split_seconds
        : openingSplitsMap[`${heat.id}/${p.athlete_id}`] ?? null;

    return {
      athlete_id: cid,
      raw_athlete_id: p.athlete_id,
      name: p.name_latin || p.name,
      country: p.country,
      starting_position: Number.isInteger(p.starting_position) && p.starting_position > 0 ? p.starting_position : null,
      heat_size: activeCount || (heat.participants || []).length,
      rank: Number.isInteger(p.rank) && p.rank > 0 ? p.rank : null,
      time_s,
      status,
      is_incident: status === 'PEN' || status === 'YC' || status === 'RC' || status === 'DNF',
      incident_type: status === 'DNF' ? 'DNF' : status === 'PEN' || status === 'YC' || status === 'RC' ? 'PEN' : null,
      qual_type,
      qual_target,
      is_repechage_qualifier: false,
      opening_split_s: openingSplit,
      lap_times_s: null,
      last_four_seconds: p.last_four_seconds ?? null,
      season,
      city,
      gender: heat.gender,
      distance_m: heat.distance_m,
      session_type,
      round,
      round_tier,
      round_key: heat.round_key,
      local_date: heat.local_date || (startUtc ? startUtc.slice(0, 10) : ''),
      start_time_utc: startUtc,
      heat_id: heat.id,
      heat_number: heat.heat_number ?? 0,
    };
  });

  return { rows, session_type, round, round_tier, startUtc, city };
}

function parseQualificationRule(codeStr) {
  const m = /^(\d+)Q(?:\+(\d+)q)?/.exec(String(codeStr || '').trim());
  if (!m) return { code: codeStr || null, big_q: 0, small_q_planned: 0, small_q_from_place: 0 };
  const big_q = Number(m[1]);
  const small_q_planned = m[2] ? Number(m[2]) : 0;
  return {
    code: m[0],
    big_q,
    small_q_planned,
    small_q_from_place: small_q_planned > 0 ? big_q + 1 : 0,
  };
}

function finalAFieldSize(sets, roundKey) {
  if (!roundKey.endsWith('/final/B')) return null;
  const key = roundKey.slice(0, -1) + 'A';
  for (const set of sets) {
    const final = set.items.find(h => h.round_key === key);
    if (final) return final.participants.filter(p => p.result !== 'DNS').length || null;
  }
  return null;
}

async function reportV2({ env, calendar, stations, sets, gender, distance, roundKey, selected, hasForecast, stats, china, state }) {
  const season = calendar.season || '2026/27';
  const pendingItems = selected.filter(hasForecast);
  const completedInRound = selected.filter(
    (item) =>
      !hasForecast(item) &&
      item.heat.evidence === 'official_results' &&
      item.heat.result_status?.toLowerCase() === 'official'
  );

  // Rehydrate V1.5/V2 stateful models from pre-trained snapshot.
  const filter = { gender, distance };
  const ratingEngine = DynamicRatingEngine.fromJSON(state.rating, V15_RATING_CONFIG, filter);
  const openingTracker = OpeningSplitTracker.fromJSON(state.opening, {}, filter);
  const paceTracker = PaceTracker.fromJSON(state.pace, {}, filter);
  const incidentModel = IncidentRiskModel.fromJSON(state.incident, {}, filter);
  const incH2HMap = new Map();

  const theta = state.theta_by_distance?.[String(distance)] || [1, 0, 0, 0, 0, 0, 0, 0, 0];
  const tauV2 = state.temp_by_distance?.[String(distance)] ?? 1.0;
  const scaledTheta = Array.from({ length: 9 }, (_, i) => (theta[i] ?? 0) * tauV2);

  // Determine strict time boundary so incremental replay never leaks later rounds.
  const minPendingStart = pendingItems
    .map((x) => x.heat.source_start || (x.heat.local_date ? `${x.heat.local_date}T23:59:59Z` : ''))
    .filter(Boolean)
    .sort()[0] || null;
  const throughTs = state.through_timestamp_utc || '';

  const incrementalHeats = [];
  for (const [i, set] of sets.entries()) {
    const station = stations[i];
    for (const heat of set.items || []) {
      if (heat.format !== 'individual' || heat.gender !== gender) continue;
      if (heat.evidence !== 'official_results' || heat.result_status?.toLowerCase() !== 'official') continue;
      if (heat.round_key === roundKey) continue;
      const ts = heat.source_start || (heat.local_date ? `${heat.local_date}T00:00:00Z` : '');
      if (throughTs && ts && ts <= throughTs) continue;
      if (minPendingStart && ts && ts >= minPendingStart) continue;
      incrementalHeats.push({ heat, station, ts });
    }
  }
  incrementalHeats.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.heat.heat_number ?? 0) - (b.heat.heat_number ?? 0)));

  const firstStation = (pendingItems[0] || selected[0])?.station;
  const useForm = /\/main\/.*\/(?:quarterfinal|semifinal)\//.test(roundKey) && [500, 1000, 1500].includes(distance);
  const stationHeats = [];
  const roundStart = selected.map(({ heat }) => heat.source_start || heat.local_date).filter(Boolean).sort()[0];
  for (const { heat, station } of incrementalHeats) {
    const { rows } = normalizeLiveHeatRows(heat, station, state, season);
    const active = rows.filter((r) => r.status !== 'DNS');
    if (active.length < 2) continue;

    // With date-only entries, the order within the same day is unknown.
    const beforeRound = heat.source_start && roundStart?.includes('T')
      ? Date.parse(heat.source_start) < Date.parse(roundStart)
      : heat.local_date && heat.local_date < roundStart?.slice(0, 10);
    if (useForm && station.id === firstStation?.id && heat.distance_m === distance && beforeRound) {
      stationHeats.push(rows);
    }
    ratingEngine.updateHeat(rows);
    if (heat.distance_m === distance) {
      for (const r of rows) {
        if (r.status !== 'DNS') {
          r.mu_tilde = ratingEngine.peekAthlete(r.athlete_id, gender, distance, null, season, r.country).muTilde;
        }
      }
      openingTracker.updateHeat(rows);
      paceTracker.updateHeat(rows);
      incidentModel.updateHeat(rows);
      recordCleanHeatH2H(incH2HMap, active);
    }
  }

  // Parse qualification rule from verified station schedule if available.
  const form = previousRoundForm(stationHeats, distance);
  if (form.size) scaledTheta.push(advanceFormWeight[distance]);
  let qRule = { code: null, big_q: 0, small_q_planned: 0, small_q_from_place: 0 };
  if (firstStation) {
    const schedule = await optionalAsset(env, '/data/' + firstStation.id + '.json');
    const ruleCode = schedule?.entries?.find((e) => e.round_key === roundKey)?.qualification?.code;
    if (ruleCode) qRule = parseQualificationRule(ruleCode);
  }

  // Fallback if there are no pending heats: return non-forecasted results cleanly.
  if (pendingItems.length === 0) {
    return selected.map(({ heat }) => {
      const people = (heat.participants || []).filter((p) => p.result !== 'DNS');
      return {
        id: heat.id,
        heatPace: null,
        qualificationRule: { ...qRule, small_q_actual: qRule.small_q_planned, n_adv: 0 },
        people: people.map((p) => {
          const row = stats.get(athlete(p));
          return {
            id: p.athlete_id,
            china: china.get(athlete(p)),
            expectedPlace: null,
            lane: null,
            opening: null,
            openingSamples: 0,
            starts: row?.starts || 0,
            wins: row?.wins || 0,
            first: null,
            direct: null,
            smallQ: null,
            totalAdvance: null,
            incident: null,
            pen: null,
            dnf: null,
            deepDive: null,
          };
        }),
      };
    });
  }

  // Track Repechage qualifiers from earlier Rep. Semifinal rounds of the SAME event/discipline if visible in sets.
  const repQualIds = new Set();
  for (const [i, set] of sets.entries()) {
    if (stations[i].id !== firstStation?.id) continue;
    for (const h of set.items || []) {
      if (h.gender !== gender || h.distance_m !== distance || h.format !== 'individual') continue;
      if (/^rep\.\s*semi/i.test(String(h.round_label || ''))) {
        for (const p of h.participants || []) {
          if (p.qualification === 'Q' || p.qualification === 'q' || String(p.qualification || '').startsWith('ADV')) {
            const cid = liveAthleteId(p, state);
            repQualIds.add(cid);
          }
        }
      }
    }
  }

  // Build completedHeats & pending heat feature bundles for simulateRound.
  const completedSet = new Set(completedInRound.map((x) => x.heat.id));
  const completedHeatsInput = [];
  const mcHeatsInput = [];
  const pendingMeta = new Map();

  for (const item of selected) {
    const { heat, station } = item;
    const { rows } = normalizeLiveHeatRows(heat, station, state, season);
    const active = rows.filter((r) => r.status !== 'DNS');
    for (const r of active) {
      if (r.session_type === 'MAIN' && repQualIds.has(r.athlete_id)) r.is_repechage_qualifier = true;
    }

    if (completedSet.has(heat.id)) {
      completedHeatsInput.push({ id: heat.id, participants: active });
      mcHeatsInput.push({ id: heat.id, completed: true, participants: active });
      continue;
    }

    if (!hasForecast(item) || active.length === 0) continue;

    const features = buildHeatFeatures(active, ratingEngine, openingTracker, paceTracker, {
      extended: true,
      includeFinishKick: true,
      includePace: true,
    });
    if (form.size) {
      withinHeatForm(active, form).forEach((value, i) => features[i].push(value));
    }
    const scores = scoreHeatFeatures(features, scaledTheta);
    const activeWithMu = active.map((r, idx) => ({ ...r, mu_tilde: features[idx][0] }));
    const incProbs = incidentModel.predictHeat(activeWithMu);
    const heatPace = paceTracker.predictHeatPace(active, scores);

    pendingMeta.set(heat.id, { active, features, scores, heatPace });
    mcHeatsInput.push({
      id: heat.id,
      big_q: qRule.big_q,
      small_q_planned: qRule.small_q_planned,
      small_q_from_place: qRule.small_q_from_place,
      heat_pace: heatPace,
      participants: active.map((r, i) => ({
        athlete_id: r.raw_athlete_id,
        canonical_id: r.athlete_id,
        name: r.name,
        country: r.country,
        starting_position: r.starting_position,
        s_score: scores[i],
        p_pen: incProbs[i].p_pen,
        p_dnf: incProbs[i].p_dnf,
        z_pace: heatPace.zPaces[i],
      })),
    });
  }

  const mcRes = simulateRound(
    {
      heats: mcHeatsInput,
      completedHeats: completedHeatsInput,
      bigQ: qRule.big_q,
      smallQPlanned: qRule.small_q_planned,
      smallQFromPlace: qRule.small_q_from_place,
    },
    {
      iterations: 4000,
      seed: hashSeed(`${roundKey}:${gender}:${distance}`),
      includeWhatIfClean: true,
    }
  );
  const finalOffset = finalAFieldSize(sets, roundKey);
  const mcByHeatId = new Map(mcRes.heats.map((h) => [h.id, h]));

  return selected.map((item) => {
    const { heat } = item;
    const rawPeople = (heat.participants || []).filter((p) => p.result !== 'DNS');
    const meta = pendingMeta.get(heat.id);
    const mcH = mcByHeatId.get(heat.id);

    if (!meta || !mcH) {
      return {
        id: heat.id,
        heatPace: null,
        qualificationRule: {
          ...qRule,
          small_q_actual: mcRes.q_actual,
          n_adv: mcRes.n_adv_completed,
        },
        people: rawPeople.map((p) => {
          const row = stats.get(athlete(p));
          return {
            id: p.athlete_id,
            china: china.get(athlete(p)),
            expectedPlace: null,
            lane: null,
            opening: null,
            openingSamples: 0,
            starts: row?.starts || 0,
            wins: row?.wins || 0,
            first: null,
            direct: null,
            smallQ: null,
            totalAdvance: null,
            incident: null,
            pen: null,
            dnf: null,
            deepDive: null,
          };
        }),
      };
    }

    const deepDives = explainHeat({
      participants: meta.active.map((r) => ({
        athlete_id: r.raw_athlete_id,
        canonical_id: r.athlete_id,
        name: r.name,
        country: r.country,
      })),
      features: meta.features,
      scores: meta.scores,
      scaledTheta,
      mcHeat: mcH,
      h2hStore: state.h2h,
      h2hOverlay: incH2HMap,
    });

    return {
      id: heat.id,
      heatPace: mcH.heat_pace,
      qualificationRule: {
        ...qRule,
        small_q_actual: mcRes.q_actual,
        n_adv: mcRes.n_adv_completed,
      },
      people: rawPeople.map((p, i) => {
        const mcP = mcH.people[i];
        const act = meta.active[i];
        const row = stats.get(athlete(p));
        const openRaw = openingTracker.peekRaw(act.athlete_id, distance);
        return {
          id: p.athlete_id,
          china: china.get(athlete(p)),
          expectedPlace: mcP.expected_place,
          lane: act.starting_position,
          opening: openRaw.opening,
          openingSamples: openRaw.samples,
          starts: row?.starts || 0,
          wins: row?.wins || 0,
          first: mcP.p_first,
          medals: heat.round === 'final' && heat.group === 'A' ? mcP.podium : null,
          expectedFinalPlace: finalOffset == null ? null : finalOffset + mcP.expected_place,
          direct: qRule.big_q > 0 ? mcP.p_big_q : null,
          smallQ: qRule.small_q_planned > 0 ? mcP.p_small_q : null,
          totalAdvance: qRule.big_q > 0 || qRule.small_q_planned > 0 ? mcP.p_total_advance : null,
          incident: mcP.p_incident,
          pen: mcP.p_pen,
          dnf: mcP.p_dnf,
          deepDive: deepDives[i],
        };
      }),
    };
  });
}

export async function report(env, gender, distance, roundKey) {
  const [calendar, state] = await Promise.all([
    asset(env, '/data/calendar.json'),
    optionalAsset(env, '/data/prediction_state.json'),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const next = calendar.stations.find((s) => s.date_end >= today);
  const stations = calendar.stations.filter((s) => s.date_start <= today || s.id === next?.id);
  const sets = await Promise.all(
    stations.map((s) => asset(env, '/data/competitions/' + s.id + '/rounds.json'))
  );
  const { china, standings } = chinaResults(gender, distance);
  const stats = new Map(),
    selected = [],
    finished = [];
  for (const [i, set] of sets.entries()) {
    const station = stations[i];
    for (const heat of set.items) {
      if (heat.gender !== gender || heat.distance_m !== distance || heat.format !== 'individual')
        continue;
      if (heat.round_key === roundKey) selected.push({ station, heat });
      if (heat.evidence !== 'official_results' || heat.result_status?.toLowerCase() !== 'official')
        continue;
      finished.push(heat);
      for (const p of heat.participants.filter((p) => p.result !== 'DNS')) {
        const id = athlete(p);
        const row = stats.get(id) || { name: p.name, country: p.country, starts: 0, wins: 0 };
        row.starts++;
        if (p.rank === 1 && !p.penalty) row.wins++;
        stats.set(id, row);
      }
    }
  }
  const hasForecast = ({ station, heat }) =>
    heat.evidence === 'official_start_list' &&
    station.date_end >= today &&
    (!heat.local_date || heat.local_date >= today);

  if (state) {
    return reportV2({
      env,
      calendar,
      stations,
      sets,
      gender,
      distance,
      roundKey,
      selected,
      hasForecast,
      stats,
      china,
      state,
    });
  }

  // Legacy lightweight fallback when /data/prediction_state.json is unavailable.
  const history =
    gender === 'men' && distance === 1500
      ? historical
      : gender === 'women' && distance === 1000
        ? women1000
        : [];
  const races = history.map((h) => h.map(([name, country]) => key(name, country)));
  for (const heat of finished) {
    const ordered = heat.participants
      .filter((p) => p.rank > 0 && !p.penalty && !['DNS', 'DNF'].includes(p.result))
      .sort((a, b) => a.rank - b.rank);
    if (ordered.length >= 2) races.push(ordered.map(athlete));
  }
  const pending = selected.filter(hasForecast);
  const score = pending.length ? ratings(races, standings) : new Map();
  const sprint = distance === 500 && pending.length ? sprintModel(finished, score, athlete) : null;
  let slots = 0;
  if (pending.length && pending[0].station.detail_status === 'verified') {
    const schedule = await asset(env, '/data/' + pending[0].station.id + '.json');
    const rule = schedule.entries.find((e) => e.round_key === roundKey)?.qualification?.code;
    slots = Number(/^(\d+)Q/.exec(rule || '')?.[1] || 0);
  }
  const finalOffset = finalAFieldSize(sets, roundKey);
  return selected.map(({ heat, station }) => {
    const people = heat.participants.filter((p) => p.result !== 'DNS');
    const forecast = hasForecast({ heat, station });
    const lanes = people
      .map((p) => p.starting_position)
      .filter((n) => Number.isInteger(n) && n > 0);
    const center = lanes.length ? lanes.reduce((a, b) => a + b, 0) / lanes.length : 0;
    const starts = people.map((p) => (forecast && sprint ? sprint(p, center) : null));
    const weights = people.map((p, i) =>
      Math.exp((score.get(athlete(p)) || 0) + (starts[i]?.adjustment || 0))
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const podium = forecast && heat.round === 'final' && heat.group === 'A'
      ? [1, 2, 3].map(rank => topPlaces(weights, rank)) : null;
    const direct = forecast && slots ? topPlaces(weights, slots) : null;
    return {
      id: heat.id,
      people: people.map((p, i) => {
        const row = stats.get(athlete(p));
        const expectedPlace =
          forecast && (p.country === 'CHN' || heat.group === 'B')
            ? weights.reduce((place, w, j) => place + (i === j ? 0 : w / (w + weights[i])), 1)
            : null;
        return {
          id: p.athlete_id,
          china: china.get(athlete(p)),
          expectedPlace,
          lane: starts[i]?.lane,
          opening: starts[i]?.opening,
          openingSamples: starts[i]?.samples,
          starts: row?.starts || 0,
          wins: row?.wins || 0,
          medals: podium?.map((cum, rank) => cum[i] - (rank ? podium[rank - 1][i] : 0)) ?? null,
          expectedFinalPlace: finalOffset == null || expectedPlace == null ? null : finalOffset + expectedPlace,
          first: forecast ? weights[i] / total : null,
          direct: direct?.[i] ?? null,
        };
      }),
    };
  });
}

const lifetime = 7 * 86400;
const encoder = new TextEncoder();
const cookieName = '__Host-ssts_analysis';
const reply = (status, data, cookie) =>
  Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  });
const cookie = (value, age) =>
  cookieName +
  '=' +
  value +
  '; Max-Age=' +
  age +
  '; Secure; HttpOnly; SameSite=Strict; Path=/';

async function signingKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function privateAnalysis(request, env) {
  const secret = env.ANALYSIS_PASSWORD;
  if (!secret || request.method !== 'POST') return reply(404, {});
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply(403, {});
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply(415, {});
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object') return reply(400, {});
  const now = Math.floor(Date.now() / 1000);
  if (data.action === 'logout') return reply(200, {}, cookie('', 0));
  if (data.action === 'login') {
    if (typeof data.password !== 'string') return reply(401, {});
    const digest = (s) => crypto.subtle.digest('SHA-256', encoder.encode(s));
    const [a, b] = await Promise.all([digest(data.password), digest(secret)]);
    const left = new Uint8Array(a),
      right = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    if (diff) return reply(401, {});
    const exp = String(now + lifetime);
    const sig = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(exp));
    const hex = Array.from(new Uint8Array(sig), (n) => n.toString(16).padStart(2, '0')).join('');
    return reply(200, {}, cookie(exp + '.' + hex, lifetime));
  }
  const token = (request.headers.get('Cookie') || '')
    .split(/;\s*/)
    .find((x) => x.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  const parts = /^(\d{10})\.([0-9a-f]{64})$/.exec(token || '');
  if (!parts || Number(parts[1]) <= now) return reply(401, {});
  const sig = Uint8Array.from(parts[2].match(/../g), (s) => parseInt(s, 16));
  if (!(await crypto.subtle.verify('HMAC', await signingKey(secret), sig, encoder.encode(parts[1]))))
    return reply(401, {});
  if (
    data.action !== 'round' ||
    !['men', 'women'].includes(data.gender) ||
    ![500, 1000, 1500].includes(data.distance) ||
    typeof data.roundKey !== 'string' ||
    !data.roundKey ||
    data.roundKey.length > 180
  )
    return reply(400, {});
  try {
    return reply(200, await report(env, data.gender, data.distance, data.roundKey));
  } catch {
    return reply(503, {});
  }
}
