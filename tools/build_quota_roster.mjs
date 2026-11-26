#!/usr/bin/env node
/**
 * Phase 4 CLI: Build CHN 2026-27 WT & 2027 Seoul Worlds roster forecast JSON +
 * run 2-season historical backtest & dual-eligible sensitivity analysis.
 *
 * Outputs:
 *   - data/quota_roster/chn_roster_forecast.json
 *   - docs/quota_roster_backtest.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DynamicRatingEngine, V15_RATING_CONFIG } from '../src/prediction/rating.mjs';
import {
  DEFAULT_PATHS,
  buildFusedCandidatePool,
  loadQuotaRulesConfig
} from '../src/quota-roster/fusion.mjs';
import {
  DISTANCES,
  buildStandardField,
  forecastGender,
  lambdasFromConfig,
  worldChampionshipConstraints,
  worldTourConstraints
} from '../src/quota-roster/optimizer.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_ORDER = { PRELIM: 0, REPECHAGE: 1, MAIN: 2 };

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function addDaysIso(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function parseDistNum(dk) {
  return parseInt(String(dk), 10);
}

function detectLatestOfficialDate(stationsDoc, competitionsDir) {
  let latest = '2026-11-21';
  for (const s of stationsDoc?.stations || []) {
    const compPath = path.join(competitionsDir, `${s.id}.json`);
    if (!fs.existsSync(compPath)) continue;
    const comp = readJson(compPath);
    for (const h of comp?.rounds?.items || []) {
      if (h.evidence !== 'official_results') continue;
      const d = h.local_date || (h.source_start ? String(h.source_start).slice(0, 10) : '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > latest) latest = d;
    }
  }
  return latest;
}

function detectNextWtStop(stationsDoc, competitionsDir) {
  for (const s of stationsDoc?.stations || []) {
    const compPath = path.join(competitionsDir, `${s.id}.json`);
    if (!fs.existsSync(compPath)) return s;
    const comp = readJson(compPath);
    const items = comp?.rounds?.items || [];
    const officialCount = items.filter((h) => h.evidence === 'official_results').length;
    if (officialCount === 0) return s;
  }
  return null;
}

function buildBlockedMapForGender(penaltyBans, gender) {
  const blocked = {};
  for (const b of penaltyBans || []) {
    if (b.gender !== gender || b.country !== 'CHN' || !b.athlete_id) continue;
    const dists = (b.blocked_distances || []).map(parseDistNum).filter((d) => DISTANCES.includes(d));
    if (dists.length) blocked[b.athlete_id] = dists;
  }
  return blocked;
}

function buildFieldMap(ratingState, athleteCountries, activeSinceMs) {
  const out = {};
  for (const gender of ['women', 'men']) {
    out[gender] = {};
    for (const d of DISTANCES) {
      out[gender][d] = buildStandardField(ratingState, athleteCountries, gender, d, {
        excludeCountries: ['CHN'],
        activeSinceMs
      });
    }
  }
  return out;
}

function computeForecast({ asOfDate, config, quotasDoc, predState, stationsDoc }) {
  const wtQuotas = quotasDoc.world_tour_2026_27.quotas;
  const fused = buildFusedCandidatePool({ asOfDate, config, wtQuotas, includeDebutRatings: true });
  const activeSinceMs = Date.parse('2025-07-01T00:00:00Z');
  const fields = buildFieldMap(predState.rating, predState.athlete_countries, activeSinceMs);
  const lambdas = lambdasFromConfig(config);

  const nextStop = detectNextWtStop(stationsDoc, DEFAULT_PATHS.competitionsDir);
  const bansFor = (stop) => stop && stop === quotasDoc.penalty_target_stop ? quotasDoc.world_tour_2026_27.next_stop_penalty_bans : [];
  const penaltyBans = bansFor(nextStop?.id);
  const penaltyWarnings = quotasDoc?.world_tour_2026_27?.one_away_from_ban_warnings || [];

  const rp = config.roster_model?.reserve_pool || {};
  const wtMaxReserves = rp.wt_max_size ?? 2;
  const wtReserveAlloc = rp.wt_allocation || { sprint_relay: 1, mid_long: 1, versatile_upside: 0 };
  const wcMaxReserves = rp.wc_max_size ?? rp.total_size ?? 6;
  const wcReserveAlloc = rp.allocation || { sprint_relay: 2, mid_long: 2, versatile_upside: 2 };
  const wtTop40Protect = config.roster_model?.objective_weights?.lambda_top40_protect ?? 0.04;

  const wtOut = {};
  for (const gender of ['women', 'men']) {
    const q = wtQuotas[gender]?.CHN || {};
    const cons = worldTourConstraints(config, {
      fourSkaterDistances: q.four_skater_distances || [],
      hasGenderRelay: true
    });
    const blocked = buildBlockedMapForGender(penaltyBans, gender);
    wtOut[gender] = forecastGender(fused[gender].eligible, {
      config,
      constraints: cons,
      lambdas,
      fieldByDistance: fields[gender],
      blockedDistancesByAthlete: blocked,
      maxReserves: wtMaxReserves,
      reserveAllocation: wtReserveAlloc,
      top40ProtectWeight: wtTop40Protect
    });
  }

  // Also compute WT5 Beijing scenario (evaluating with pre-Beijing domestic selection qualifiers at >= 2026-11-30)
  const beijingStop = (stationsDoc?.stations || []).find((s) => s.id === 'beijing') || {
    id: 'beijing',
    city: '北京',
    city_en: 'Beijing',
    country: 'CHN',
    date_start: '2026-12-04',
    date_end: '2026-12-06'
  };
  const beijingAsOf = asOfDate && asOfDate > '2026-11-30' ? asOfDate : '2026-11-30';
  const fusedBeijing =
    nextStop?.id === 'beijing' && asOfDate >= '2026-11-30'
      ? fused
      : buildFusedCandidatePool({ asOfDate: beijingAsOf, config, wtQuotas });
  const wtBeijingOut = {};
  for (const gender of ['women', 'men']) {
    const q = wtQuotas[gender]?.CHN || {};
    const cons = worldTourConstraints(config, {
      fourSkaterDistances: q.four_skater_distances || [],
      hasGenderRelay: true
    });
    const blocked =
      buildBlockedMapForGender(bansFor('beijing'), gender);
    wtBeijingOut[gender] = forecastGender(fusedBeijing[gender].eligible, {
      config,
      constraints: cons,
      lambdas,
      fieldByDistance: fields[gender],
      blockedDistancesByAthlete: blocked,
      maxReserves: wtMaxReserves,
      reserveAllocation: wtReserveAlloc,
      top40ProtectWeight: wtTop40Protect
    });
  }

  const wcQuotas = quotasDoc?.world_championships_2027?.individual_and_roster || {};
  const wcOut = {};
  for (const gender of ['women', 'men']) {
    const q = wcQuotas[gender]?.CHN;
    const cons = worldChampionshipConstraints(config, gender, {
      quotas: q
        ? { '500m': q.slots_500m, '1000m': q.slots_1000m, '1500m': q.slots_1500m }
        : undefined,
      hasGenderRelay: q ? q.has_gender_relay !== false : true,
      maxRoster: q?.max_roster_size
    });
    wcOut[gender] = forecastGender(fused[gender].eligible, {
      config,
      constraints: cons,
      lambdas,
      fieldByDistance: fields[gender],
      maxReserves: wcMaxReserves,
      reserveAllocation: wcReserveAlloc,
      top40ProtectWeight: 0
    });
  }

  return {
    fused,
    fields,
    lambdas,
    payload: {
      schema_version: 1,
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      as_of_date: asOfDate,
      config_version: config.schema_version,
      next_wt_stop: nextStop
        ? {
            id: nextStop.id,
            city_zh: nextStop.city,
            city: nextStop.city_en || nextStop.city,
            country: nextStop.country,
            date_start: nextStop.date_start,
            date_end: nextStop.date_end
          }
        : null,
      calibration_diagnostics: fused.calibrationDiagnostics,
      eligible_counts: {
        women: fused.women.eligible.length,
        men: fused.men.eligible.length
      },
      excluded_by_age: {
        women: fused.women.excludedByAge,
        men: fused.men.excludedByAge
      },
      excluded_by_qualification: {
        women: fused.women.excludedByQualification || [],
        men: fused.men.excludedByQualification || []
      },
      penalty_bans_applied: penaltyBans.filter((b) => b.country === 'CHN'),
      penalty_warnings_chn: penaltyWarnings.filter((w) => w.country === 'CHN'),
      penalty_bans_all_members: penaltyBans,
      top40_watch: {
        women: fused.women.top40Watch,
        men: fused.men.top40Watch
      },
      scenarios: {
        world_tour_next_stop: nextStop ? {
          label: '2026-27 World Tour Next Stop',
          stop_id: nextStop?.id ?? null,
          city: nextStop ? nextStop.city_en || nextStop.city : 'Shanghai',
          date_start: nextStop?.date_start || '2026-11-27',
          event_dates: nextStop ? `${nextStop.date_start}..${nextStop.date_end}` : null,
          women: wtOut.women,
          men: wtOut.men
        } : null,
        world_tour_beijing: {
          label: '2026-27 World Tour Stop 5 (Beijing)',
          stop_id: 'beijing',
          city: beijingStop.city_en || beijingStop.city || 'Beijing',
          date_start: beijingStop.date_start || '2026-12-04',
          event_dates: `${beijingStop.date_start || '2026-12-04'}..${beijingStop.date_end || '2026-12-06'}`,
          as_of_date: beijingAsOf,
          women: wtBeijingOut.women,
          men: wtBeijingOut.men
        },
        world_championships_2027: {
          label: '2027 ISU World Championships (Seoul)',
          location: config.world_championships_2027?.location || 'Seoul, KOR',
          event_dates: `${config.world_championships_2027?.dates?.start}..${config.world_championships_2027?.dates?.end}`,
          relay_status: 'provisional',
          women: wcOut.women,
          men: wcOut.men
        }
      }
    }
  };
}

function extractActualChnLineup(ev) {
  const out = {
    women: { athletes: new Set(), entries: { 500: new Set(), 1000: new Set(), 1500: new Set() }, names: new Map() },
    men: { athletes: new Set(), entries: { 500: new Set(), 1000: new Set(), 1500: new Set() }, names: new Map() }
  };
  for (const h of ev.heats || []) {
    const g = h.gender;
    const d = h.distance_m;
    if (!out[g] || !DISTANCES.includes(d)) continue;
    for (const p of h.participants || []) {
      if (p.country !== 'CHN' || p.status === 'DNS') continue;
      out[g].athletes.add(p.athlete_id);
      out[g].entries[d].add(p.athlete_id);
      out[g].names.set(p.athlete_id, p.name);
    }
  }
  return out;
}

function runHistoricalBacktest(config) {
  const eventsIdx = readJson(path.join(DEFAULT_PATHS.heatsDir, 'events.json'));
  const athletesDoc = readJson(path.join(DEFAULT_PATHS.heatsDir, 'athletes.json'));
  const athleteCountries = {};
  for (const a of athletesDoc.items || []) {
    athleteCountries[a.id] = a.countries?.[a.countries.length - 1]?.country || '';
  }

  const engine = new DynamicRatingEngine(V15_RATING_CONFIG);
  const events = eventsIdx.items.map((meta) => ({
    meta,
    ev: readJson(path.join(DEFAULT_PATHS.heatsDir, meta.file))
  }));

  const lambdasBase = lambdasFromConfig(config);
  const fatigueGrid = [0.0, 0.02, 0.045, 0.08, 0.12];
  const rows = [];
  const fatigueStats = new Map(
    fatigueGrid.map((lf) => [
      lf,
      { rosterHits: 0, rosterTotal: 0, slotHits: 0, slotTotal: 0, pred3Dist: 0, actual3Dist: 0 }
    ])
  );

  for (const { meta, ev } of events) {
    const isTarget = meta.season === '2024/25' || meta.season === '2025/26';
    if (isTarget) {
      const preDate = addDaysIso(ev.date_start, -1);
      const fused = buildFusedCandidatePool({ asOfDate: preDate, config });
      const activeSinceMs = Date.parse(`${addDaysIso(ev.date_start, -420)}T00:00:00Z`);
      const fields = buildFieldMap(engine.toJSON(), athleteCountries, activeSinceMs);
      const actual = extractActualChnLineup(ev);

      for (const gender of ['women', 'men']) {
        const act = actual[gender];
        if (act.athletes.size === 0) continue;
        const kArr = DISTANCES.map((d) => act.entries[d].size);
        const cons = {
          nMax: act.athletes.size,
          k: kArr,
          relayRequired: act.athletes.size >= 4 ? 4 : 0
        };

        const count3Actual = [...act.athletes].filter(
          (id) => DISTANCES.filter((d) => act.entries[d].has(id)).length === 3
        ).length;

        const eventRow = {
          event_id: ev.event_id,
          season: ev.season,
          coverage: ev.coverage,
          gender,
          actual_n: act.athletes.size,
          actual_k: kArr.join('/'),
          actual_3dist: count3Actual,
          by_fatigue: {}
        };

        for (const lf of fatigueGrid) {
          const fc = forecastGender(fused[gender].eligible, {
            config,
            constraints: cons,
            lambdas: { ...lambdasBase, fatigue: lf },
            fieldByDistance: fields[gender],
            draws: 300,
            top40ProtectWeight: 0
          });
          const predIds = new Set(fc.preferred_main_roster?.athlete_ids || []);
          const rosterHits = [...act.athletes].filter((id) => predIds.has(id)).length;
          let slotHits = 0;
          let slotTotal = 0;
          for (const d of DISTANCES) {
            const predSet = new Set(fc.preferred_main_roster?.entries?.[d] || []);
            slotTotal += act.entries[d].size;
            for (const id of act.entries[d]) if (predSet.has(id)) slotHits++;
          }
          const pred3Dist = [...predIds].filter(
            (id) => DISTANCES.filter((d) => fc.preferred_main_roster?.entries?.[d]?.includes(id)).length === 3
          ).length;

          eventRow.by_fatigue[lf] = {
            rosterHits,
            rosterTotal: act.athletes.size,
            slotHits,
            slotTotal,
            pred3Dist
          };
          if (ev.coverage === 'complete') {
            const st = fatigueStats.get(lf);
            st.rosterHits += rosterHits;
            st.rosterTotal += act.athletes.size;
            st.slotHits += slotHits;
            st.slotTotal += slotTotal;
            st.pred3Dist += pred3Dist;
            st.actual3Dist += count3Actual;
          }
        }
        rows.push(eventRow);
      }
    }

    // Advance international rating engine chronologically through this event
    const heats = (ev.heats || [])
      .map((h) => ({
        ...h,
        rows: (h.participants || []).map((p) => ({
          ...p,
          event_id: ev.event_id,
          season: ev.season,
          city: ev.city,
          local_date: h.local_date,
          start_time_utc: h.start_time_utc,
          gender: h.gender,
          distance_m: h.distance_m,
          session_type: h.session_type,
          round: h.round
        }))
      }))
      .sort((a, b) => {
        const ta = a.start_time_utc || '';
        const tb = b.start_time_utc || '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        const sa = SESSION_ORDER[a.session_type] ?? 9;
        const sb = SESSION_ORDER[b.session_type] ?? 9;
        if (sa !== sb) return sa - sb;
        return (a.round_tier ?? 0) - (b.round_tier ?? 0);
      });
    for (const h of heats) {
      if (h.rows.filter((r) => r.status !== 'DNS').length >= 2) {
        engine.updateHeat(h.rows);
      }
    }
  }

  return { rows, fatigueStats, fatigueGrid };
}

function runDualEligibleSensitivity({ asOfDate, config, quotasDoc, predState, fused, fields, baselineForecast }) {
  const results = [];
  for (const gender of ['women', 'men']) {
    const dualCands = fused[gender].eligible.filter((c) => c.is_dual_eligible);
    const baseFc = baselineForecast.scenarios.world_tour_next_stop?.[gender];
    if (!baseFc) continue;
    const baseMain = new Set(baseFc.preferred_main_roster.athlete_ids);
    const target =
      dualCands.find((c) => !baseMain.has(c.athlete_id)) || dualCands[dualCands.length - 1];
    if (!target) continue;

    const beforeCand = baseFc.candidates.find((c) => c.athlete_id === target.athlete_id);
    const beforeRank = baseFc.candidates.findIndex((c) => c.athlete_id === target.athlete_id) + 1;
    const beforeRes = baseFc.reserves.find((r) => r.athlete_id === target.athlete_id);

    // Inject two domestic 甲组 golds (cumulative) + JWC boost for this dual-eligible skater
    const domesticOverrideRecords = [];
    for (let rk = 1; rk <= 6; rk++) {
      domesticOverrideRecords.push({
        event_id: 'dom-sens-test-2026',
        event_name: '2026全国短道速滑精英联赛灵敏度注入站',
        event_date: asOfDate,
        division: '甲组',
        is_cumulative: true,
        gender,
        distance_m: 1000,
        rank: rk,
        name_zh:
          rk === 1
            ? target.name_zh || target.name_en
            : (fused[gender].eligible[rk - 1]?.name_zh || `对比选手${rk}`),
        athlete_id: rk === 1 ? target.athlete_id : fused[gender].eligible[rk - 1]?.athlete_id,
        team: '国家队',
        relay_member: rk === 1
      });
      domesticOverrideRecords.push({
        event_id: 'dom-sens-test-2026',
        event_name: '2026全国短道速滑精英联赛灵敏度注入站',
        event_date: asOfDate,
        division: '甲组',
        is_cumulative: true,
        gender,
        distance_m: 500,
        rank: rk,
        name_zh:
          rk === 1
            ? target.name_zh || target.name_en
            : (fused[gender].eligible[rk - 1]?.name_zh || `对比选手${rk}`),
        athlete_id: rk === 1 ? target.athlete_id : fused[gender].eligible[rk - 1]?.athlete_id,
        team: '国家队',
        relay_member: rk === 1
      });
    }

    const boostedFused = buildFusedCandidatePool({ asOfDate, config, domesticOverrideRecords });
    const boostedTarget = boostedFused[gender].eligible.find((c) => c.athlete_id === target.athlete_id);
    // Also simulate an accompanying JWC gold medal performance (+1.25 mu on 500/1000, form=+0.9)
    if (boostedTarget) {
      boostedTarget.distances[500].mu = Math.max(boostedTarget.distances[500].mu, 2.55);
      boostedTarget.distances[1000].mu = Math.max(boostedTarget.distances[1000].mu, 2.45);
      boostedTarget.form_momentum = 0.9;
      boostedTarget.recent_highlight = 'JWC/国内甲组 500m & 1000m #1 (灵敏度注入)';
    }

    const q = quotasDoc?.world_tour_2026_27?.quotas?.[gender]?.CHN || {};
    const cons = worldTourConstraints(config, {
      fourSkaterDistances: q.four_skater_distances || [],
      hasGenderRelay: true
    });
    const blocked = buildBlockedMapForGender(
      baselineForecast.penalty_bans_applied,
      gender
    );
    const afterFc = forecastGender(boostedFused[gender].eligible, {
      config,
      constraints: cons,
      lambdas: lambdasFromConfig(config),
      fieldByDistance: fields[gender],
      blockedDistancesByAthlete: blocked,
      maxReserves: config.roster_model?.reserve_pool?.wt_max_size ?? 2,
      reserveAllocation: config.roster_model?.reserve_pool?.wt_allocation,
      top40ProtectWeight: config.roster_model?.objective_weights?.lambda_top40_protect ?? 0.04
    });
    const afterCand = afterFc.candidates.find((c) => c.athlete_id === target.athlete_id);
    const afterRank = afterFc.candidates.findIndex((c) => c.athlete_id === target.athlete_id) + 1;
    const afterRes = afterFc.reserves.find((r) => r.athlete_id === target.athlete_id);

    results.push({
      gender,
      athlete_id: target.athlete_id,
      name: target.name_zh ? `${target.name_zh} (${target.name_en})` : target.name_en,
      before_rank: beforeRank,
      before_prob: beforeCand?.main_roster_prob ?? 0,
      before_reserve_rank: beforeRes?.reserve_rank ?? null,
      after_rank: afterRank,
      after_prob: afterCand?.main_roster_prob ?? 0,
      after_reserve_rank: afterRes?.reserve_rank ?? null
    });
  }
  return results;
}

function formatBacktestMarkdown({ config, forecast, backtest, sensitivity }) {
  const lines = [];
  lines.push('# 2026-27 名额与阵容优化模型 — 历史回测与灵敏度报告');
  lines.push('');
  lines.push(`- **生成时间**：${forecast.generated_at}`);
  lines.push(`- **预测基准日 (` + '`asOfDate`' + `)**：${forecast.as_of_date}`);
  lines.push(
    `- **下一站世巡赛**：${forecast.next_wt_stop?.city || 'Shanghai'} (${forecast.next_wt_stop?.date_start}..${forecast.next_wt_stop?.date_end})`
  );
  lines.push(
    `- **候选池规模**：女子 ${forecast.eligible_counts.women} 人（年龄拦截 ${forecast.excluded_by_age.women.length} 人），男子 ${forecast.eligible_counts.men} 人（年龄拦截 ${forecast.excluded_by_age.men.length} 人）`
  );
  lines.push('');

  lines.push('## 1. 2026-27 下一站 WT 与 2027 首尔世锦赛实时预测摘要（V2 分层看板）');
  lines.push('');
  if (forecast.top40_watch) {
    lines.push('### 世界排名 Top-40 护席监控');
    lines.push('');
    lines.push('| 性别 | 项目 | 席位 | 现役 Top-40 | 总 Top-40 | #40 门槛分 | 状态 |');
    lines.push('|---|---|---:|---:|---:|---:|---|');
    for (const gender of ['women', 'men']) {
      const watch = forecast.top40_watch[gender] || {};
      const gLabel = gender === 'women' ? '女队' : '男队';
      for (const d of DISTANCES) {
        const w = watch[d];
        if (!w) continue;
        lines.push(
          `| ${gLabel} | ${d}m | ${w.slots} 席 | ${w.top40_active_chn} 人 | ${w.top40_total_chn} 人 | ${w.cutoff_points} | ${w.status} |`
        );
      }
    }
    lines.push('');
  }
  for (const [scKey, title] of [
    ['world_tour_next_stop', '2026-27 世巡赛下一站'],
    ['world_championships_2027', '2027 首尔世锦赛 (5人上限 / 已核验单项名额)']
  ]) {
    const sc = forecast.scenarios[scKey];
    if (!sc) continue;
    lines.push(`### ${title}`);
    for (const gender of ['women', 'men']) {
      const g = sc[gender];
      const candById = new Map(g.candidates.map((c) => [c.athlete_id, c]));
      const fmtCand = (id) => {
        const c = candById.get(id);
        if (!c) return id;
        const name = c.name_zh || c.name_en || id;
        const spec = c.specialty_label ? `[${c.specialty_label}]` : '';
        const ent = (c.recommended_entries || []).map((e) => (e === 'relay' ? '接力' : `${e}m`)).join('/');
        return `${name}${spec}${ent ? `(${ent})` : ''}`;
      };
      const tiers = g.roster_tiers || { core_ids: g.preferred_main_roster.athlete_ids, bubble_ids: [], cut_ids: [] };
      const coreStr = tiers.core_ids.map(fmtCand).join('、') || '无';
      const bubbleItems = [
        ...tiers.bubble_ids.map((id) => {
          const c = candById.get(id);
          return `${c?.name_zh || c?.name_en || id}（${c?.status_note || '轮换边缘'}）`;
        }),
        ...tiers.cut_ids.map((id) => {
          const c = candById.get(id);
          return `${c?.name_zh || c?.name_en || id}（${c?.status_note || '裁撤边缘'}）`;
        })
      ];
      const bubbleStr = bubbleItems.join('；') || '无';
      const resStr = g.reserves.length
        ? g.reserves
            .map((r) => {
              const rep = candById.get(r.primary_replacement_for);
              const repName = rep ? rep.name_zh || rep.name_en : r.primary_replacement_for;
              return `#${r.reserve_rank} ${r.name_zh || r.name_en} [${r.specialty_label || r.role_tag}, 对位:${repName}]`;
            })
            .join('；')
        : '无';
      const capLabel = g.reserve_cap ?? g.reserves.length;
      lines.push(
        `- **${gender === 'women' ? '女队' : '男队'}**（约束 \`N=${g.constraints.nMax}, K=${g.constraints.k500}/${g.constraints.k1000}/${g.constraints.k1500}, R=${g.constraints.relay}\`）：`
      );
      lines.push(`  - 稳固主力（${tiers.core_ids.length}人）：${coreStr}`);
      lines.push(`  - 淘汰 / 轮换边缘：${bubbleStr}`);
      lines.push(`  - 替补梯队（最多 ${capLabel} 人，实际 ${g.reserves.length} 人）：${resStr}`);
    }
    lines.push('');
  }

  lines.push('## 2. 2024/25 & 2025/26 两赛季赛前名单回测（给定实际报名规模）');
  lines.push('');
  lines.push(
    '> 对 2024/25–2025/26 全部 12 站完整覆盖赛事（另有 1 站部分覆盖 `2025-26-worldtour-montreal-2` 单独标注），在赛前 1 日截断三池数据并重训国际对手池，以实际报名人数和各项报名数为约束，检验选人和分项分配命中率，以及 `lambda_fatigue` 对兼三项核心的调控效果。'
  );
  lines.push('');
  const defaultLf = config.roster_model?.objective_weights?.lambda_fatigue ?? 0.045;
  const defaultStats = backtest.fatigueStats.get(defaultLf);
  lines.push(
    `> 注：\`2024-25-worldtour-tilburg-5\` 与 2025 哈尔滨亚冬会撞期（中国队派二线阵容出战），\`2025-26-worlds-montreal\` 男队为冬奥后新生代练兵阵容（张柏浩/李坤/宋桂旭），因此两站非主力轮换拉低了全样本平均；其余 10 站一线参赛完整站体现正常竞争力映射。默认 \`lambda_fatigue = ${defaultLf}\` 预测兼三项 ${defaultStats?.pred3Dist ?? '-'} 人次（实际 ${defaultStats?.actual3Dist ?? '-'} 人次）。`
  );
  lines.push('');
  lines.push('| `lambda_fatigue` | 完整站正选人数命中率 | 完整站单项席位命中率 | 预测兼三项人次 | 实际兼三项人次 |');
  lines.push('|---:|---:|---:|---:|---:|');
  for (const lf of backtest.fatigueGrid) {
    const st = backtest.fatigueStats.get(lf);
    const rRate = ((100 * st.rosterHits) / Math.max(1, st.rosterTotal)).toFixed(1);
    const sRate = ((100 * st.slotHits) / Math.max(1, st.slotTotal)).toFixed(1);
    lines.push(
      `| ${lf.toFixed(3)} | ${st.rosterHits}/${st.rosterTotal} (${rRate}%) | ${st.slotHits}/${st.slotTotal} (${sRate}%) | ${st.pred3Dist} | ${st.actual3Dist} |`
    );
  }
  lines.push('');

  lines.push(`### 分站回测明细（默认 \`lambda_fatigue = ${defaultLf}\`）`);
  lines.push('');
  lines.push('| 赛事 | 覆盖度 | 性别 | 实际规模 (`N`, `K`) | 正选命中 | 分项命中 | 兼三项 (预测/实际) |');
  lines.push('|---|---|---|---:|---:|---:|---:|');
  for (const r of backtest.rows) {
    const m = r.by_fatigue[defaultLf] || r.by_fatigue[backtest.fatigueGrid[2]];
    lines.push(
      `| ${r.event_id} | ${r.coverage} | ${r.gender} | ${r.actual_n} (${r.actual_k}) | ${m.rosterHits}/${m.rosterTotal} | ${m.slotHits}/${m.slotTotal} | ${m.pred3Dist}/${r.actual_3dist} |`
    );
  }
  lines.push('');

  lines.push('## 3. 兼项可跨组（Dual-Eligible）选手灵敏度检验');
  lines.push('');
  lines.push(
    '> 对正选边缘的 `DUAL_ELIGIBLE` 选手注入「全国甲组精英赛 500m/1000m 双冠 + JWC 夺冠表现」，检验排名与入选概率跃迁。'
  );
  lines.push('');
  lines.push('| 性别 | 兼项测试选手 | 注入前排名 / 正选概率 / 替补位 | 注入后排名 / 正选概率 / 替补位 |');
  lines.push('|---|---|---:|---:|');
  for (const s of sensitivity) {
    const bRes = s.before_reserve_rank ? `替补#${s.before_reserve_rank}` : '替补池外';
    const aRes = s.after_reserve_rank
      ? `替补#${s.after_reserve_rank}`
      : s.after_prob >= 0.5
        ? '晋级正选'
        : '替补池外';
    lines.push(
      `| ${s.gender} | ${s.name} | 第${s.before_rank} / ${(s.before_prob * 100).toFixed(1)}% / ${bRes} | 第${s.after_rank} / ${(s.after_prob * 100).toFixed(1)}% / ${aRes} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { asOf: null, skipBacktest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as-of' && argv[i + 1]) out.asOf = argv[++i];
    else if (argv[i] === '--skip-backtest') out.skipBacktest = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadQuotaRulesConfig(DEFAULT_PATHS.rulesConfig);
  const quotasDoc = readJson(path.join(REPO_ROOT, 'data/quota_roster/quotas_2026_27.json'));
  const predState = readJson(DEFAULT_PATHS.predictionState);
  const stationsDoc = readJson(DEFAULT_PATHS.stations);
  const asOfDate = args.asOf || detectLatestOfficialDate(stationsDoc, DEFAULT_PATHS.competitionsDir);

  const fc = computeForecast({
    asOfDate,
    config,
    quotasDoc,
    predState,
    stationsDoc
  });

  const next = fc.payload.next_wt_stop;
  if (next && asOfDate < next.date_start) {
    const dir = path.join(REPO_ROOT, 'data/quota_roster/debut');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, next.id + '.json'), JSON.stringify({
      as_of_date: asOfDate, ratings: fc.fused.debutRatings
    }) + '\n');
  }

  const outJsonPath = path.join(REPO_ROOT, 'data/quota_roster/chn_roster_forecast.json');
  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  if (fs.existsSync(outJsonPath)) {
    try {
      const prev = readJson(outJsonPath);
      const prevCmp = { ...prev, generated_at: null };
      const nextCmp = { ...fc.payload, generated_at: null };
      if (JSON.stringify(prevCmp) === JSON.stringify(nextCmp) && prev.generated_at) {
        fc.payload.generated_at = prev.generated_at;
      }
    } catch {}
  }
  fs.writeFileSync(outJsonPath, JSON.stringify(fc.payload, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outJsonPath}`);

  if (!args.skipBacktest) {
    const backtest = runHistoricalBacktest(config);
    const sensitivity = runDualEligibleSensitivity({
      asOfDate,
      config,
      quotasDoc,
      predState,
      fused: fc.fused,
      fields: fc.fields,
      baselineForecast: fc.payload
    });
    const md = formatBacktestMarkdown({ config, forecast: fc.payload, backtest, sensitivity });
    const outMdPath = path.join(REPO_ROOT, 'docs/quota_roster_backtest.md');
    fs.writeFileSync(outMdPath, md, 'utf8');
    console.log(`Wrote ${outMdPath}`);
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
