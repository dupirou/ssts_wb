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
  assert.equal(cfg.roster_model.calibration.sigma_junior_adapt, 0.55);
  assert.equal(cfg.roster_model.calibration.domestic_anchor_min_count, 3);
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

  const pool = buildFusedCandidatePool({ asOfDate: '2026-11-21' });

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
