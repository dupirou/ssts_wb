import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PATHS,
  buildFusedCandidatePool,
  classifyAgeGroup,
  computeRankNormalScores,
  fitRidgeLinear1D,
  fusePoolsIVW,
  loadChnNameMapping,
  loadQuotaRulesConfig,
} from '../src/quota-roster/fusion.mjs';
import { DynamicRatingEngine, V15_RATING_CONFIG } from '../src/prediction/rating.mjs';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ssts-fusion-test-'));
}

test('loadQuotaRulesConfig & loadChnNameMapping parse YAML cleanly without third-party deps', () => {
  const cfg = loadQuotaRulesConfig();
  assert.equal(cfg.schema_version, '2026.27.1');
  assert.equal(cfg.effective_cutoff_date, '2026-07-01');
  assert.equal(cfg.age_eligibility.dual_eligible.dob_min, '2007-07-01');
  assert.equal(cfg.age_eligibility.dual_eligible.dob_max, '2009-06-30');
  assert.equal(cfg.roster_model.domestic_half_life_days, 180);
  assert.equal(cfg.roster_model.calibration.junior_pace_weight_by_distance['500'], 0.45);
  assert.equal(cfg.roster_model.calibration.sigma_junior_adapt, 1.15);
  assert.equal(cfg.roster_model.calibration.domestic_anchor_min_count, 3);
  assert.equal(cfg.roster_model.calibration.domestic_anchor_min_r, 0.25);
  assert.equal(cfg.roster_model.calibration.sigma_domestic_adapt, 1.55);
  assert.equal(cfg.roster_model.calibration.sigma_domestic_fallback, 1.75);
  assert.equal(cfg.roster_model.calibration.senior_inactivity_grace_days, 150);
  assert.equal(cfg.roster_model.calibration.senior_inactivity_mu_decay_days, 480);
  assert.equal(cfg.world_championships_2027.china_chn_verified_status.individual_quotas.women['500m'], 3);
  assert.equal(cfg.world_championships_2027.china_chn_verified_status.individual_quotas.men['1000m'], 2);

  const mapping = loadChnNameMapping();
  assert.ok(Array.isArray(mapping.athletes));
  assert.ok(mapping.athletes.length >= 50);
  const bohao = mapping.athletes.find((a) => a.athlete_id === 'skr-8078');
  assert.ok(bohao);
  assert.equal(bohao.name_zh, '张柏浩');
  assert.deepEqual(bohao.pools, ['senior', 'junior']);
});

test('classifyAgeGroup enforces CER 2026 Art. 9.2 / Comm. 2807 boundaries strictly', () => {
  const cfg = loadQuotaRulesConfig();
  assert.equal(classifyAgeGroup('2007-06-30', cfg), 'SENIOR_ONLY');
  assert.equal(classifyAgeGroup('2007-07-01', cfg), 'DUAL_ELIGIBLE');
  assert.equal(classifyAgeGroup('2008-06-19', cfg), 'DUAL_ELIGIBLE');
  assert.equal(classifyAgeGroup('2009-06-30', cfg), 'DUAL_ELIGIBLE');
  assert.equal(classifyAgeGroup('2009-07-01', cfg), 'JUNIOR_ONLY');
  assert.equal(classifyAgeGroup('2011-06-30', cfg), 'JUNIOR_ONLY');
  assert.equal(classifyAgeGroup('2011-07-01', cfg), 'INELIGIBLE_TOO_YOUNG');
  assert.equal(classifyAgeGroup(null, cfg), 'UNKNOWN');
});

test('computeRankNormalScores handles tied ranks symmetrically and fusePoolsIVW computes exact precision weights', () => {
  const scored = computeRankNormalScores([
    { athlete_id: 'a1', gender: 'women', distance_m: 500, rank: 1, source_file: 'doc1.pdf' },
    { athlete_id: 'a2', gender: 'women', distance_m: 500, rank: 2, source_file: 'doc1.pdf' },
    { athlete_id: 'a3', gender: 'women', distance_m: 500, rank: 2, source_file: 'doc1.pdf' },
    { athlete_id: 'a4', gender: 'women', distance_m: 500, rank: 4, source_file: 'doc1.pdf' },
  ]);
  assert.equal(scored.length, 4);
  assert.equal(scored[1].avg_rank, 2.5);
  assert.equal(scored[2].avg_rank, 2.5);
  assert.equal(scored[1].z_score, scored[2].z_score);
  assert.ok(scored[0].z_score > scored[1].z_score);
  assert.ok(scored[1].z_score > scored[3].z_score);
  assert.ok(Math.abs(scored[0].z_score + scored[3].z_score) < 1e-9);

  const fused = fusePoolsIVW([
    { mu: 2.0, sigma: 0.5 }, // invVar = 4
    { mu: 0.5, sigma: 1.0 }, // invVar = 1
  ]);
  assert.ok(Math.abs(fused.mu - (2.0 * 4 + 0.5 * 1) / 5) < 1e-12);
  assert.ok(Math.abs(fused.sigma - Math.sqrt(1 / 5)) < 1e-12);
});

test('Real data pipeline: zero writes to data/heats/, positive cross-tier correlation, JUNIOR_ONLY intercepted, valid contract', () => {
  const predStatePath = DEFAULT_PATHS.predictionState;
  const eventsIdxPath = path.join(DEFAULT_PATHS.heatsDir, 'events.json');
  const predHashBefore = sha256File(predStatePath);
  const idxHashBefore = sha256File(eventsIdxPath);
  const predMtimeBefore = fs.statSync(predStatePath).mtimeMs;
  const heatsFilesBefore = fs.readdirSync(DEFAULT_PATHS.heatsDir).sort();

  const {world_tour_2026_27: {quotas: wtQuotas}} = JSON.parse(fs.readFileSync(new URL('../data/quota_roster/quotas_2026_27.json', import.meta.url)));
  const pool = buildFusedCandidatePool({ asOfDate: '2026-11-21', wtQuotas });

  // (d) Zero writes to data/heats/
  assert.equal(sha256File(predStatePath), predHashBefore);
  assert.equal(sha256File(eventsIdxPath), idxHashBefore);
  assert.equal(fs.statSync(predStatePath).mtimeMs, predMtimeBefore);
  assert.deepEqual(fs.readdirSync(DEFAULT_PATHS.heatsDir).sort(), heatsFilesBefore);

  // (a) Positive cross-tier anchor correlation in Junior calibration
  const junDiag = pool.calibrationDiagnostics.junior.byDiscipline;
  for (const dk of ['women:500', 'women:1000', 'women:1500', 'men:500', 'men:1000', 'men:1500']) {
    const d = junDiag[dk];
    assert.ok(d.crossTierPairs >= 4, `${dk} expected >=4 cross-tier pairs, got ${d.crossTierPairs}`);
    assert.equal(d.usedFallback, false, `${dk} should not use fallback`);
    assert.ok(d.correlationR > 0.2, `${dk} expected positive correlation, got ${d.correlationR}`);
    assert.ok(d.alpha > 0, `${dk} expected alpha > 0, got ${d.alpha}`);
  }

  // (b) JUNIOR_ONLY strictly excluded from eligible and recorded in excludedByAge
  const allEligibleIds = new Set([
    ...pool.women.eligible.map((c) => c.athlete_id),
    ...pool.men.eligible.map((c) => c.athlete_id),
  ]);
  const allExcluded = [...pool.women.excludedByAge, ...pool.men.excludedByAge];
  assert.ok(allExcluded.length >= 2, 'Expected JUNIOR_ONLY CHN skaters to be intercepted');
  for (const ex of allExcluded) {
    assert.ok(!allEligibleIds.has(ex.athlete_id), `${ex.athlete_id} must not be in eligible`);
    assert.ok(
      ex.age_group === 'JUNIOR_ONLY' || ex.age_group === 'INELIGIBLE_TOO_YOUNG' || ex.age_group === 'UNKNOWN',
      `Unexpected excluded age_group ${ex.age_group}`
    );
  }

  // (b2) Retired/unavailable, non-Hengshui, and non-selected mid-pack domestic athletes are strictly excluded
  for (const excludedId of ['skr-4247', 'skr-5859', 'skr-1876', 'skr-8039', 'skr-4312', 'skr-4314', 'skr-5753', 'skr-6615', 'skr-18243', 'skr-4176']) {
    assert.ok(!allEligibleIds.has(excludedId), `${excludedId} must be excluded from eligible`);
  }
  const allQualExclIds = new Set([
    ...pool.women.excludedByQualification.map((c) => c.athlete_id),
    ...pool.men.excludedByQualification.map((c) => c.athlete_id),
  ]);
  for (const excludedId of ['skr-4247', 'skr-5859', 'skr-1876', 'skr-8039', 'skr-4312', 'skr-4314', 'skr-6615', 'skr-18243', 'skr-4176']) {
    assert.ok(allQualExclIds.has(excludedId), `${excludedId} should be audited in excludedByQualification`);
  }
  const excl18243 = pool.women.excludedByQualification.find((c) => c.athlete_id === 'skr-18243');
  assert.equal(excl18243.reason, 'not_in_national_team_selection_pool');

  // Hengshui+WT, JWC_2026_27, and Qitaihe Gold/Top3 (incl. Hengshui-exempt skr-8107 张添翼) remain eligible
  assert.equal(pool.calibrationDiagnostics.selectionGateActive, true);
  for (const eligibleId of ['skr-6784', 'skr-8078', 'skr-8080', 'skr-2262', 'skr-7613', 'skr-20586', 'skr-22312', 'skr-8107', 'skr-8145']) {
    assert.ok(allEligibleIds.has(eligibleId), `${eligibleId} should remain eligible`);
  }
  const zhangTianyi = pool.men.eligible.find((c) => c.athlete_id === 'skr-8107');
  assert.equal(zhangTianyi.name_zh, '张添翼');
  assert.equal(zhangTianyi.qualification_path, 'DOMESTIC_GOLD');
  assert.equal(pool.women.eligible.find((c) => c.athlete_id === 'skr-22880')?.name_zh, '宗艾迪');
  assert.equal(pool.men.eligible.find((c) => c.athlete_id === 'skr-22630')?.name_zh, '孙志博');

  const eligibleZhNames = new Set([
    ...pool.women.eligible.map((c) => c.name_zh),
    ...pool.men.eligible.map((c) => c.name_zh),
  ]);
  for (const zh of ['南佳延', '李晶', '郭骏达', '于翰琦', '朱昱璋', '高君镇', '钟宇晨', '张添翼']) {
    assert.ok(eligibleZhNames.has(zh), `${zh} must be in eligible national team selection pool`);
  }

  // Verify 2026/27 Top-40 world ranking injection, world_ranks, wt_2026_27, and top40Watch
  assert.deepEqual(pool.men.top40Counts, { 500: 4, 1000: 4, 1500: 3 });
  const sunLong = pool.men.eligible.find((c) => c.athlete_id === 'skr-6784');
  assert.deepEqual(sunLong?.world_ranking_top40_distances, [500, 1000, 1500]);
  assert.equal(sunLong?.world_ranks?.[1500]?.rank, 6);
  assert.equal(sunLong?.world_ranks?.[1500]?.in_top40, true);
  assert.ok(sunLong?.wt_2026_27 && sunLong.wt_2026_27.stops_count >= 3);
  assert.deepEqual(pool.men.eligible.find((c) => c.athlete_id === 'skr-8157')?.world_ranking_top40_distances, [1500]);
  assert.deepEqual(pool.men.eligible.find((c) => c.athlete_id === 'skr-18320')?.world_ranking_top40_distances, [1000]);

  for (const gender of ['women', 'men']) {
    const watch = pool[gender].top40Watch;
    assert.ok(watch && typeof watch === 'object');
    for (const d of [500, 1000, 1500]) {
      const w = watch[d];
      assert.equal(w.distance_m, d);
      assert.equal(w.cutoff_rank, 40);
      assert.equal(w.slots, wtQuotas[gender].CHN['slots_' + d + 'm']);
      assert.ok(typeof w.cutoff_points === 'number' && w.cutoff_points > 0);
      assert.ok(typeof w.top40_total_chn === 'number');
      assert.ok(typeof w.top40_active_chn === 'number');
      assert.equal(w.buffer_active, w.top40_active_chn - 3);
      assert.ok(['SAFE', 'TIGHT', 'BELOW'].includes(w.status));
      assert.ok(Array.isArray(w.skaters) && w.skaters.length > 0);
    }
  }
  assert.equal(pool.men.top40Watch[1500].status, 'TIGHT');
  assert.equal(pool.women.top40Watch[500].status, 'SAFE');

  // Verify milp-eng candidate contract on every eligible candidate
  for (const group of [pool.women.eligible, pool.men.eligible]) {
    assert.ok(group.length >= 10);
    for (const c of group) {
      assert.equal(typeof c.athlete_id, 'string');
      assert.ok('official_skater_id' in c);
      assert.equal(typeof c.name_en, 'string');
      assert.ok('name_zh' in c);
      assert.ok(c.gender === 'women' || c.gender === 'men');
      assert.ok(Array.isArray(c.data_sources) && c.data_sources.length >= 1);
      assert.equal(typeof c.is_dual_eligible, 'boolean');
      assert.ok(c.form_momentum >= -1 && c.form_momentum <= 1);
      for (const dist of [500, 1000, 1500]) {
        const dObj = c.distances[dist];
        assert.ok(Number.isFinite(dObj.mu), `${c.athlete_id} ${dist} mu finite`);
        assert.ok(Number.isFinite(dObj.sigma) && dObj.sigma > 0, `${c.athlete_id} ${dist} sigma > 0`);
        assert.equal(typeof dObj.pools, 'object');
      }
      assert.equal(typeof c.relay_stats.senior_starts, 'number');
      assert.equal(typeof c.relay_stats.senior_final_a, 'number');
      assert.equal(typeof c.relay_stats.senior_weighted_starts, 'number');
      assert.equal(typeof c.relay_stats.senior_weighted_final_a, 'number');
      assert.ok(c.relay_stats.senior_weighted_starts <= c.relay_stats.senior_starts + 1e-9);
      assert.ok(c.relay_stats.senior_weighted_final_a <= c.relay_stats.senior_final_a + 1e-9);
      assert.equal(typeof c.relay_stats.junior_starts, 'number');
      assert.equal(typeof c.relay_stats.junior_final_a, 'number');
      assert.equal(typeof c.relay_stats.domestic_relay_member, 'boolean');
    }
  }
});

test('Pool 3 Domestic anchor-athlete bridge proves positive anchor correlation, fallback, decay, and cumulative bonus', () => {
  const cfg = loadQuotaRulesConfig();
  const realPool = buildFusedCandidatePool({ asOfDate: '2026-11-21' });

  // Pick 4 real eligible CHN women anchors with known Senior 500m ratings, sorted by mu descending
  const anchors = realPool.women.eligible
    .filter((c) => c.distances[500].pools.sen)
    .sort((a, b) => b.distances[500].pools.sen.mu - a.distances[500].pools.sen.mu)
    .slice(0, 4);
  assert.equal(anchors.length, 4);

  // Assign domestic ranks in strict agreement with Senior strength + 1 domestic newcomer + 1 JUNIOR_ONLY skater
  const domesticRecords = [
    ...anchors.map((a, idx) => ({
      athlete_id: a.athlete_id,
      name_zh: a.name_zh || a.name_en,
      name_en: a.name_en,
      birth_date: a.birth_date,
      gender: 'women',
      distance_m: 500,
      division: '甲组',
      venue: '七台河体育中心',
      report_date: '2026-11-10',
      source_file: '2026_national_championship_w500.pdf',
      is_cumulative: true,
      rank: idx + 1,
      is_relay_member: idx === 0,
    })),
    {
      athlete_id: 'dom-tmp-newcomer1',
      name_zh: '新秀甲',
      name_en: 'Jia XINXIU',
      birth_date: '2008-05-01', // DUAL_ELIGIBLE
      gender: 'women',
      distance_m: 500,
      division: '甲组',
      venue: '七台河体育中心',
      report_date: '2026-11-10',
      source_file: '2026_national_championship_w500.pdf',
      is_cumulative: true,
      rank: 5,
      is_relay_member: true,
    },
    {
      athlete_id: 'dom-tmp-u17only',
      name_zh: '小将乙',
      name_en: 'Yi XIAOJIANG',
      birth_date: '2010-03-15', // JUNIOR_ONLY -> must be intercepted!
      gender: 'women',
      distance_m: 500,
      division: '甲组',
      venue: '七台河体育中心',
      report_date: '2026-11-10',
      source_file: '2026_national_championship_w500.pdf',
      is_cumulative: false,
      rank: 6,
      is_relay_member: false,
    },
  ];

  const withDom = buildFusedCandidatePool({
    asOfDate: '2026-11-21',
    config: cfg,
    domesticOverrideRecords: domesticRecords,
  });

  const diag500 = withDom.calibrationDiagnostics.domestic.byDiscipline['women:500'];
  assert.equal(diag500.anchorCount, 4);
  assert.equal(diag500.usedFallback, false);
  assert.ok(diag500.correlationR > 0.7, `Expected strong positive anchor correlation, got ${diag500.correlationR}`);
  assert.ok(diag500.alpha > 0);

  const newcomer = withDom.women.eligible.find((c) => c.athlete_id === 'dom-tmp-newcomer1');
  assert.ok(newcomer, 'Dual-eligible domestic newcomer should appear in eligible');
  assert.equal(newcomer.is_dual_eligible, true);
  assert.deepEqual(newcomer.data_sources, ['Domestic']);
  assert.equal(newcomer.relay_stats.domestic_relay_member, true);
  assert.ok(newcomer.distances[500].pools.dom);

  // Verify JUNIOR_ONLY domestic skater is intercepted into excludedByAge
  assert.ok(!withDom.women.eligible.some((c) => c.athlete_id === 'dom-tmp-u17only'));
  const ex = withDom.women.excludedByAge.find((c) => c.athlete_id === 'dom-tmp-u17only');
  assert.ok(ex && ex.age_group === 'JUNIOR_ONLY');

  // Verify fallback (< 3 anchors) + is_cumulative slight stability bonus + time decay
  const twoOnlyCum = [
    { ...domesticRecords[0], is_cumulative: true, report_date: '2026-11-10' },
    { ...domesticRecords[1], is_cumulative: true, report_date: '2026-11-10' },
  ];
  const twoOnlySingle = [
    { ...domesticRecords[0], is_cumulative: false, report_date: '2026-11-10' },
    { ...domesticRecords[1], is_cumulative: false, report_date: '2026-11-10' },
  ];
  const fbCum = buildFusedCandidatePool({ asOfDate: '2026-11-21', config: cfg, domesticOverrideRecords: twoOnlyCum });
  const fbSingle = buildFusedCandidatePool({ asOfDate: '2026-11-21', config: cfg, domesticOverrideRecords: twoOnlySingle });
  assert.equal(fbCum.calibrationDiagnostics.domestic.byDiscipline['women:500'].usedFallback, true);

  const cCum = fbCum.women.eligible.find((c) => c.athlete_id === domesticRecords[0].athlete_id);
  const cSingle = fbSingle.women.eligible.find((c) => c.athlete_id === domesticRecords[0].athlete_id);
  assert.ok(
    cCum.distances[500].pools.dom.sigma < cSingle.distances[500].pools.dom.sigma,
    'Cumulative domestic results should carry lower variance (stability bonus) than single-stop'
  );
});

test('Schedule-aware activity protection prevents DUAL_ELIGIBLE inactivity sigma inflation', () => {
  const tmpDir = makeTempDir();
  try {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    // Create two identical DUAL_ELIGIBLE CHN skaters last seen in Senior on 2026-03-15
    const eng = new DynamicRatingEngine(V15_RATING_CONFIG);
    const tsOld = '2026-03-15T12:00:00Z';
    const baseParticipants = [
      { athlete_id: 'skr-dual-idle', gender: 'women', distance_m: 500, season: '2025/26', local_date: '2026-03-15', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'CHN', rank: 1, status: 'OK', time_s: 43.1 },
      { athlete_id: 'skr-dual-active', gender: 'women', distance_m: 500, season: '2025/26', local_date: '2026-03-15', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'CHN', rank: 1, status: 'OK', time_s: 43.1 },
      { athlete_id: 'skr-opp-1', gender: 'women', distance_m: 500, season: '2025/26', local_date: '2026-03-15', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'KOR', rank: 2, status: 'OK', time_s: 43.4 },
      { athlete_id: 'skr-opp-2', gender: 'women', distance_m: 500, season: '2025/26', local_date: '2026-03-15', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'NED', rank: 3, status: 'OK', time_s: 43.8 },
    ];
    // Run identical heats separately so both dual skaters have exact bit-identical Senior ratings
    eng.updateHeat([baseParticipants[0], baseParticipants[2], baseParticipants[3]]);
    const eng2 = new DynamicRatingEngine(V15_RATING_CONFIG);
    eng2.updateHeat([baseParticipants[1], baseParticipants[2], baseParticipants[3]]);
    const d1 = eng.disciplines.get('women:500').get('skr-dual-idle');
    const d2 = eng2.disciplines.get('women:500').get('skr-dual-active');
    eng.disciplines.get('women:500').set('skr-dual-active', d2);
    assert.equal(d1.sigma, d2.sigma);

    const seniorStateOverride = {
      through_timestamp_utc: '2026-03-15T20:00:00Z',
      crosswalk: {},
      official_ids: {},
      name_lookup: {},
      athlete_countries: {
        'skr-dual-idle': 'CHN',
        'skr-dual-active': 'CHN',
        'skr-opp-1': 'KOR',
        'skr-opp-2': 'NED',
      },
      rating: eng.toJSON(),
    };

    const chnProfilesPath = path.join(tmpDir, 'chn_profiles.json');
    fs.writeFileSync(
      chnProfilesPath,
      JSON.stringify({
        items: [
          { athlete_id: 'skr-dual-idle', official_skater_id: 9001, name_en: 'Idle DUAL', gender: 'women', birth_date: '2008-05-01' },
          { athlete_id: 'skr-dual-active', official_skater_id: 9002, name_en: 'Active DUAL', gender: 'women', birth_date: '2008-05-01' },
          { athlete_id: 'skr-u17-ban', official_skater_id: 9003, name_en: 'Young JUNIOR', gender: 'women', birth_date: '2010-01-10' },
        ],
      })
    );

    // Only skr-dual-active and skr-u17-ban raced JWC on 2026-11-14!
    const juniorEventsOverride = [
      {
        event_id: '2026-27-jwc-bormio-2',
        season: '2026/27',
        kind: 'junior_worldcup',
        stop_number: 2,
        city: 'Bormio',
        date_start: '2026-11-12',
        date_end: '2026-11-14',
        heats: [
          {
            id: 'j-h1',
            season: '2026/27',
            city: 'Bormio',
            local_date: '2026-11-14',
            start_time_utc: '2026-11-14T14:00:00Z',
            gender: 'women',
            distance_m: 500,
            session_type: 'MAIN',
            round: 'final',
            round_tier: 5,
            participants: [
              { athlete_id: 'skr-dual-active', official_skater_id: 9002, name: 'Active DUAL', country: 'CHN', rank: 1, finish_time_s: 43.2, status: 'OK' },
              { athlete_id: 'skr-u17-ban', official_skater_id: 9003, name: 'Young JUNIOR', country: 'CHN', rank: 2, finish_time_s: 43.5, status: 'OK' },
              { athlete_id: 'skr-j-opp', official_skater_id: 9004, name: 'J Opp', country: 'KOR', rank: 3, finish_time_s: 43.9, status: 'OK' },
            ],
          },
        ],
        classifications: [],
        relays: [],
      },
    ];

    const pool = buildFusedCandidatePool({
      asOfDate: '2026-11-21',
      paths: {
        chnNameMapping: path.join(emptyDir, 'missing.yaml'),
        heatsDir: emptyDir,
        competitionsDir: emptyDir,
        historyDir: emptyDir,
        juniorDir: emptyDir,
        standings: path.join(emptyDir, 'missing.json'),
        chnProfiles: chnProfilesPath,
        domesticResults: path.join(emptyDir, 'missing_dom.json'),
      },
      seniorStateOverride,
      juniorEventsOverride,
      domesticOverrideRecords: [],
    });

    const idle = pool.women.eligible.find((c) => c.athlete_id === 'skr-dual-idle');
    const active = pool.women.eligible.find((c) => c.athlete_id === 'skr-dual-active');
    assert.ok(idle && active);
    assert.equal(idle.last_active_date, '2026-03-15');
    assert.equal(active.last_active_date, '2026-11-14');
    assert.equal(idle.distances[500].pools.sen.activity_protected, false);
    assert.equal(active.distances[500].pools.sen.activity_protected, true);
    assert.ok(
      active.distances[500].pools.sen.sigma < idle.distances[500].pools.sen.sigma,
      `Expected JWC activity-protected sigma (${active.distances[500].pools.sen.sigma}) < idle sigma (${idle.distances[500].pools.sen.sigma})`
    );
    assert.ok(!pool.women.eligible.some((c) => c.athlete_id === 'skr-u17-ban'));
    assert.ok(pool.women.excludedByAge.some((c) => c.athlete_id === 'skr-u17-ban' && c.age_group === 'JUNIOR_ONLY'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Gracefully handles missing Junior & Domestic data directories', () => {
  const tmpDir = makeTempDir();
  try {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const pool = buildFusedCandidatePool({
      asOfDate: '2026-11-21',
      paths: {
        juniorDir: path.join(emptyDir, 'no_junior'),
        domesticResults: path.join(emptyDir, 'no_domestic.json'),
      },
    });
    assert.equal(pool.calibrationDiagnostics.junior.eventsLoaded, 0);
    assert.equal(pool.calibrationDiagnostics.domestic.recordsLoaded, 0);
    assert.ok(pool.women.eligible.length > 0);
    assert.ok(pool.men.eligible.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Blank rank / 0 points do not grant Hengshui qualification & low-R domestic anchors fall back cleanly', () => {
  const cfg = loadQuotaRulesConfig();
  const realPool = buildFusedCandidatePool({ asOfDate: '2026-11-21' });

  const anchors = realPool.women.eligible
    .filter((c) => c.distances[1500].pools.sen)
    .sort((a, b) => b.distances[1500].pools.sen.mu - a.distances[1500].pools.sen.mu)
    .slice(0, 4);
  assert.equal(anchors.length, 4);

  // Deliberately scramble ranks relative to Senior mu so real correlation r < 0.25 -> must trigger fallback
  const scrambled = [anchors[2], anchors[0], anchors[3], anchors[1]];
  const records = [
    ...scrambled.map((a, idx) => ({
      athlete_id: a.athlete_id,
      name_zh: a.name_zh || a.name_en,
      name_en: a.name_en,
      birth_date: a.birth_date,
      gender: 'women',
      distance_m: 1500,
      division: '甲组',
      venue: '衡水',
      report_date: '2026-10-18',
      source_file: 'hengshui_w1500.pdf',
      is_cumulative: false,
      rank: idx + 1,
      points: 10000 - idx * 1500,
      is_relay_member: false,
    })),
    // Blank rank + 0 points at Hengshui for a SENIOR_ONLY athlete -> must NOT grant Hengshui eligibility
    {
      athlete_id: 'skr-6615',
      name_zh: '宋嘉华',
      name_en: 'Jiahua SONG',
      birth_date: '2003-04-04',
      gender: 'men',
      distance_m: 1500,
      division: '甲组',
      venue: '衡水',
      report_date: '2026-10-18',
      source_file: 'hengshui_m1500.pdf',
      is_cumulative: false,
      rank: null,
      points: 0,
      is_relay_member: false,
    },
    // Valid rank at Hengshui for a men anchor
    {
      athlete_id: 'skr-6784',
      name_zh: '孙龙',
      name_en: 'Long SUN',
      birth_date: '2000-08-28',
      gender: 'men',
      distance_m: 1500,
      division: '甲组',
      venue: '衡水',
      report_date: '2026-10-18',
      source_file: 'hengshui_m1500.pdf',
      is_cumulative: false,
      rank: 1,
      points: 10000,
      is_relay_member: false,
    },
  ];

  const pool = buildFusedCandidatePool({
    asOfDate: '2026-11-21',
    config: cfg,
    domesticOverrideRecords: records,
  });

  // Low-R domestic regression must fall back
  const diagW1500 = pool.calibrationDiagnostics.domestic.byDiscipline['women:1500'];
  assert.ok(diagW1500);
  assert.equal(diagW1500.usedFallback, true);
  const firstScram = pool.women.eligible.find((c) => c.athlete_id === scrambled[0].athlete_id);
  assert.ok(Math.abs(firstScram.distances[1500].pools.dom.sigma - 1.75) < 1e-9);

  // Blank rank / 0 points at Hengshui must NOT qualify skr-6615
  assert.ok(!pool.men.eligible.some((c) => c.athlete_id === 'skr-6615'));
  assert.ok(
    pool.men.excludedByQualification.some(
      (c) => c.athlete_id === 'skr-6615' && c.reason === 'missing_required_domestic_venue'
    )
  );
  // Valid rank at Hengshui keeps skr-6784 eligible
  assert.ok(pool.men.eligible.some((c) => c.athlete_id === 'skr-6784'));
});

test('Cross-cycle Senior mu decay, relay season decay, and old Junior isolation work as specified', () => {
  const tmpDir = makeTempDir();
  try {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const historyDir = path.join(tmpDir, 'history');
    const historyEventsDir = path.join(historyDir, 'events');
    fs.mkdirSync(historyEventsDir, { recursive: true });

    const eng = new DynamicRatingEngine(V15_RATING_CONFIG);
    // 1) Old SENIOR_ONLY skater: last raced 2025-02-28 (631 days before 2026-11-21 -> well over 150d grace)
    const tsOld = '2025-02-28T12:00:00Z';
    eng.updateHeat([
      { athlete_id: 'skr-old-vet', gender: 'men', distance_m: 500, season: '2024/25', local_date: '2025-02-28', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'CHN', rank: 1, status: 'OK', time_s: 40.8 },
      { athlete_id: 'skr-opp-a', gender: 'men', distance_m: 500, season: '2024/25', local_date: '2025-02-28', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'KOR', rank: 2, status: 'OK', time_s: 41.2 },
      { athlete_id: 'skr-opp-b', gender: 'men', distance_m: 500, season: '2024/25', local_date: '2025-02-28', start_time_utc: tsOld, session_type: 'MAIN', round: 'final', country: 'NED', rank: 3, status: 'OK', time_s: 41.6 },
    ]);

    // 2) Active current-season Senior skater (2 starts in 2026/27) who also has old 2024/25 Junior data
    const tsCur1 = '2026-10-25T12:00:00Z';
    const tsCur2 = '2026-11-01T12:00:00Z';
    eng.updateHeat([
      { athlete_id: 'skr-cur-sen', gender: 'men', distance_m: 500, season: '2026/27', local_date: '2026-10-25', start_time_utc: tsCur1, session_type: 'MAIN', round: 'final', country: 'CHN', rank: 1, status: 'OK', time_s: 40.7 },
      { athlete_id: 'skr-opp-a', gender: 'men', distance_m: 500, season: '2026/27', local_date: '2026-10-25', start_time_utc: tsCur1, session_type: 'MAIN', round: 'final', country: 'KOR', rank: 2, status: 'OK', time_s: 41.1 },
    ]);
    eng.updateHeat([
      { athlete_id: 'skr-cur-sen', gender: 'men', distance_m: 500, season: '2026/27', local_date: '2026-11-01', start_time_utc: tsCur2, session_type: 'MAIN', round: 'final', country: 'CHN', rank: 1, status: 'OK', time_s: 40.6 },
      { athlete_id: 'skr-opp-b', gender: 'men', distance_m: 500, season: '2026/27', local_date: '2026-11-01', start_time_utc: tsCur2, session_type: 'MAIN', round: 'final', country: 'NED', rank: 2, status: 'OK', time_s: 41.0 },
    ]);

    // Historical relay appearances across seasons (2024/25 -> gap=2 -> weight 0.20; 2025/26 -> gap=1 -> weight 0.50)
    fs.writeFileSync(
      path.join(historyDir, 'catalog.json'),
      JSON.stringify({
        events: [
          { id: 'ev-2425', season: '2024/25', date_start: '2025-02-14', date_end: '2025-02-16' },
          { id: 'ev-2526', season: '2025/26', date_start: '2026-03-13', date_end: '2026-03-15' },
        ],
      })
    );
    fs.writeFileSync(
      path.join(historyEventsDir, 'ev-2425.json'),
      JSON.stringify({
        results: [
          {
            format: 'relay',
            country: 'CHN',
            gender: 'men',
            final_group: 'A',
            members: [{ name: 'Old Vet', official_skater_id: 9101, rounds: ['QF', 'SF', 'FA'] }],
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(historyEventsDir, 'ev-2526.json'),
      JSON.stringify({
        results: [
          {
            format: 'relay',
            country: 'CHN',
            gender: 'men',
            final_group: 'A',
            members: [{ name: 'Cur Sen', official_skater_id: 9102, rounds: ['QF', 'FA'] }],
          },
        ],
      })
    );

    const seniorStateOverride = {
      through_timestamp_utc: '2026-11-15T20:00:00Z',
      crosswalk: {},
      official_ids: { 9101: 'skr-old-vet', 9102: 'skr-cur-sen' },
      name_lookup: {},
      athlete_countries: { 'skr-old-vet': 'CHN', 'skr-cur-sen': 'CHN', 'skr-opp-a': 'KOR', 'skr-opp-b': 'NED' },
      rating: eng.toJSON(),
    };

    const chnProfilesPath = path.join(tmpDir, 'chn_profiles.json');
    fs.writeFileSync(
      chnProfilesPath,
      JSON.stringify({
        items: [
          { athlete_id: 'skr-old-vet', official_skater_id: 9101, name_en: 'Old Vet', gender: 'men', birth_date: '2001-01-01' },
          { athlete_id: 'skr-cur-sen', official_skater_id: 9102, name_en: 'Cur Sen', gender: 'men', birth_date: '2006-05-01' },
        ],
      })
    );

    // Old 2024/25 Junior event where skr-cur-sen lost badly
    const juniorEventsOverride = [
      {
        event_id: '2024-25-wjc-calgary',
        season: '2024/25',
        kind: 'junior_worlds',
        city: 'Calgary',
        date_start: '2025-02-27',
        date_end: '2025-03-02',
        heats: [
          {
            id: 'j-old-h1',
            season: '2024/25',
            city: 'Calgary',
            local_date: '2025-02-28',
            start_time_utc: '2025-02-28T12:00:00Z',
            gender: 'men',
            distance_m: 500,
            session_type: 'MAIN',
            round: 'heats',
            round_tier: 1,
            participants: [
              { athlete_id: 'skr-j-win', official_skater_id: 9103, name: 'J Win', country: 'KOR', rank: 1, finish_time_s: 41.5, status: 'OK' },
              { athlete_id: 'skr-cur-sen', official_skater_id: 9102, name: 'Cur Sen', country: 'CHN', rank: 3, finish_time_s: 43.2, status: 'OK' },
            ],
          },
        ],
        classifications: [],
        relays: [],
      },
    ];

    const pool = buildFusedCandidatePool({
      asOfDate: '2026-11-21',
      paths: {
        chnNameMapping: path.join(emptyDir, 'missing.yaml'),
        heatsDir: emptyDir,
        competitionsDir: emptyDir,
        historyDir,
        juniorDir: emptyDir,
        standings: path.join(emptyDir, 'missing.json'),
        chnProfiles: chnProfilesPath,
        domesticResults: path.join(emptyDir, 'missing_dom.json'),
      },
      seniorStateOverride,
      juniorEventsOverride,
      domesticOverrideRecords: [],
    });

    const oldVet = pool.men.eligible.find((c) => c.athlete_id === 'skr-old-vet');
    const curSen = pool.men.eligible.find((c) => c.athlete_id === 'skr-cur-sen');
    assert.ok(oldVet && curSen);

    // 1. Old veteran mu decayed toward 0 after >150d inactivity
    assert.ok(oldVet.distances[500].pools.sen.mu < oldVet.distances[500].pools.sen.mu_raw * 0.5);
    // 2. Old 2024/25 Junior ignored for active 2026/27 Senior skater
    assert.equal(curSen.distances[500].pools.jun, undefined);
    assert.ok(curSen.distances[500].pools.jun_ignored);
    assert.equal(curSen.distances[500].mu, curSen.distances[500].pools.sen.mu);
    // 3. Relay season decay weights: 2024/25 (3 starts, 1 FA * 0.20 = 0.60, 0.20), 2025/26 (2 starts, 1 FA * 0.50 = 1.0, 0.50)
    assert.equal(oldVet.relay_stats.senior_starts, 3);
    assert.ok(Math.abs(oldVet.relay_stats.senior_weighted_starts - 0.6) < 1e-4);
    assert.ok(Math.abs(oldVet.relay_stats.senior_weighted_final_a - 0.2) < 1e-4);
    assert.equal(curSen.relay_stats.senior_starts, 2);
    assert.ok(Math.abs(curSen.relay_stats.senior_weighted_starts - 1.0) < 1e-4);
    assert.ok(Math.abs(curSen.relay_stats.senior_weighted_final_a - 0.5) < 1e-4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Historical backtest asOfDate (2025/26) disables 2026/27 selection gate and Top-40 future data', () => {
  const histPool = buildFusedCandidatePool({ asOfDate: '2025-11-15' });
  assert.equal(histPool.calibrationDiagnostics.selectionGateActive, false);
  assert.deepEqual(histPool.women.top40Counts, { 500: 0, 1000: 0, 1500: 0 });
  assert.deepEqual(histPool.men.top40Counts, { 500: 0, 1000: 0, 1500: 0 });
  for (const c of [...histPool.women.eligible, ...histPool.men.eligible]) {
    assert.deepEqual(c.world_ranking_top40_distances, []);
  }
});
