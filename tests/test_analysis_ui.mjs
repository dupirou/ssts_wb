import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const file = async (name) => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [html, script, css, snapshot, schedule, calendar] = await Promise.all([
  file('web/index.html'),
  Promise.all(
    ['ui', 'navigation', 'results-model', 'results-store', 'results-compare', 'results', 'portal', 'app'].map((name) =>
      file('web/' + name + '.js')
    )
  ).then((parts) => parts.join('\n')),
  file('web/site.css'),
  file('data/competitions/vancouver.json').then(JSON.parse),
  file('dist/data/vancouver.json').then(JSON.parse),
  file('dist/data/calendar.json').then(JSON.parse)
]);

async function settle(dom, predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('UI did not settle');
}

async function openDialogWithAnalysis(roundEntry, participants, analysisPayload) {
  const data = structuredClone(snapshot);
  data.rounds = {
    ...data.rounds,
    items: [
      {
        id: 'test-heat-1',
        round_key: roundEntry.round_key,
        evidence: 'official_start_list',
        heat_number: 1,
        group: roundEntry.group || null,
        source_url: 'https://isu-skating.com/x',
        participants
      }
    ]
  };
  const dom = new JSDOM(html, {
    url: 'https://example.test/?station=vancouver',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  w.localStorage.setItem('ssts.analysis', '1');
  let analysisCalls = 0;
  w.fetch = async (input, init) => {
    const url = new URL(input, w.location.href);
    if (url.pathname === '/internal/analysis') {
      const payload = init?.body ? JSON.parse(init.body) : {};
      if (payload.action === 'logout' || payload.action === 'login') {
        return Response.json({ ok: true });
      }
      analysisCalls += 1;
      return Response.json(analysisPayload);
    }
    if (url.pathname.startsWith('/api/')) {
      const resource = url.pathname.split('/').at(-1);
      return Response.json({
        schema_version: 1,
        event_id: 'vancouver',
        resource,
        total: data[resource].items.length,
        ...data[resource]
      });
    }
    if (url.pathname === '/data/calendar.json') return Response.json(calendar);
    return new Response(await file('dist' + url.pathname));
  };
  w.eval(script);
  await settle(dom, () => w.document.querySelector('#r-' + roundEntry.id + ' .competition-open'));
  w.document.querySelector('#r-' + roundEntry.id + ' .competition-open').click();
  await settle(dom, () => w.document.querySelector('dialog[open] .analysis-chip'));
  dom.getAnalysisCalls = () => analysisCalls;
  return dom;
}

test('non-final rounds place advance + expected chips inline on name row and detail breakdown inside 数据分析', async (t) => {
  const heatsRound = schedule.entries.find((e) => e.id === '2026-10-23-qualifying-men-500-heats--');
  const dom = await openDialogWithAnalysis(
    heatsRound,
    [
      { athlete_id: 'ath-1', name: 'SUN Long', country: 'CHN', helmet_number: 12, starting_position: 1 },
      { athlete_id: 'ath-2', name: 'DUBOIS Steven', country: 'CAN', helmet_number: 7, starting_position: 2 },
      { athlete_id: 'ath-3', name: 'HWANG Daeheon', country: 'KOR', helmet_number: 3, starting_position: 3 }
    ],
    [
      {
        id: 'test-heat-1',
        qualificationRule: { big_q: 2, small_q_planned: 2, small_q_actual: 2, n_adv: 0, code: '2Q+2q' },
        people: [
          {
            id: 'ath-1',
            expectedPlace: 1.8,
            first: 0.45,
            direct: 0.64,
            smallQ: 0.08,
            totalAdvance: 0.72,
            incident: 0.08,
            pen: 0.05,
            dnf: 0.03,
            starts: 10,
            wins: 6,
            deepDive: {
              factor_attribution: { base_skill: 0.42, lane: -0.15 },
              path_breakdown: { p_total_advance: 0.72 },
              what_if_clean_race: { p_total_advance: 0.78 },
              key_rivals: [{ name: 'DUBOIS Steven', country: 'CAN', h2h_wins: 2, h2h_losses: 1, h2h_total: 3 }]
            }
          },
          {
            id: 'ath-2',
            expectedPlace: 2.3,
            first: 0.35,
            direct: 0.52,
            smallQ: 0.0,
            totalAdvance: 0.52,
            incident: 0.04,
            pen: 0.02,
            dnf: 0.02,
            deepDive: {
              factor_attribution: { base_skill: 0.2 },
              path_breakdown: { p_total_advance: 0.52 },
              what_if_clean_race: { p_total_advance: 0.5 },
              key_rivals: []
            }
          },
          {
            id: 'ath-3',
            expectedPlace: 3.9,
            first: 0.05,
            direct: 0.12,
            smallQ: 0.06,
            totalAdvance: 0.18,
            incident: 0.12,
            pen: 0.09,
            dnf: 0.03
          }
        ]
      }
    ]
  );
  t.after(() => dom.window.close());

  const rows = [...dom.window.document.querySelectorAll('dialog[open] .result-person')];
  assert.equal(rows.length, 3);

  // Row 1: inline name row chips (high tier >= 0.70) + collapsed 数据分析 inside meta row
  const nameRow1 = rows[0].querySelector('.result-name-row');
  assert.ok(nameRow1);
  assert.equal(nameRow1.querySelector('b').textContent, 'SUN Long');
  const chips1 = [...nameRow1.querySelectorAll('.analysis-metrics .analysis-chip')];
  assert.deepEqual(
    chips1.map((el) => el.textContent),
    ['晋级 72%', '预估第 1.8']
  );
  assert.ok(chips1[0].classList.contains('is-tier-high'));

  // Row 2 & Row 3 tier classes (mid 0.30..0.70, low < 0.30)
  assert.ok(rows[1].querySelector('.analysis-chip').classList.contains('is-tier-mid'));
  assert.ok(rows[2].querySelector('.analysis-chip').classList.contains('is-tier-low'));

  const metaRow1 = rows[0].querySelector('.result-meta-row');
  assert.ok(metaRow1);
  assert.equal(metaRow1.firstElementChild.textContent, 'CHN · #12');
  const dive1 = metaRow1.querySelector('details.analysis-dive');
  assert.ok(dive1);
  assert.equal(dive1.open, false);
  assert.equal(dive1.querySelector('summary').textContent, '数据分析');

  const pairs1 = [...dive1.querySelectorAll('.analysis-dive-label')].map((lbl) => [
    lbl.textContent,
    lbl.nextElementSibling.textContent
  ]);
  assert.deepEqual(
    pairs1.map(([k]) => k),
    ['晋级路径', '意外概率', '战力拆解', '关键对手', '无意外假设', '历史参考']
  );
  assert.equal(pairs1[0][1], '小组第一 45% · 大Q 64% · 小q 8%');
  assert.equal(pairs1[1][1], '8%（犯规 5% · 未完赛 3%）');
  assert.ok(dive1.querySelector('.analysis-factor-pill.factor-pos').textContent.includes('基础实力 +0.42'));
  assert.ok(dive1.querySelector('.analysis-factor-pill.factor-neg').textContent.includes('起跑道次 -0.15'));
  assert.equal(dive1.querySelector('.analysis-delta.delta-pos').textContent, '(+6%)');

  // Row 2: negative what-if delta gets .delta-neg
  const dive2 = rows[1].querySelector('.result-meta-row details.analysis-dive');
  assert.equal(dive2.querySelector('.analysis-delta.delta-neg').textContent, '(-2%)');

  // Cache hit: closing and re-opening the same round within 60s uses in-memory cache without another fetch
  assert.equal(dom.getAnalysisCalls(), 1);
  dom.window.document.querySelector('dialog[open] .icon-btn').click();
  dom.window.document.querySelector('#r-' + heatsRound.id + ' .competition-open').click();
  await settle(dom, () => dom.window.document.querySelector('dialog[open] .analysis-chip'));
  assert.equal(dom.getAnalysisCalls(), 1);

  // Logout via 5-tap clears cache so unlocking re-fetches
  const titleBtn = dom.window.document.querySelector('#competition-title button');
  for (let i = 0; i < 5; i++) titleBtn.click();
  await settle(dom, () => dom.window.document.querySelector('.analysis-lock-bar .is-danger'));
  dom.window.document.querySelector('.analysis-lock-bar .is-danger').click();
  await settle(dom, () => !dom.window.document.querySelector('.analysis-lock-bar'));
  assert.equal(dom.window.localStorage.getItem('ssts.analysis'), null);

  for (let i = 0; i < 5; i++) titleBtn.click();
  await settle(dom, () => dom.window.document.querySelector('.analysis-login input'));
  dom.window.document.querySelector('.analysis-login input').value = 'secret';
  dom.window.document.querySelector('.analysis-login').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle(dom, () => dom.window.document.querySelector('dialog[open] .analysis-chip'));
  assert.equal(dom.getAnalysisCalls(), 2);
});

test('Final A keeps medal chips and Final B keeps expected final place inline on name row', async (t) => {
  const finalA = schedule.entries.find((e) => e.id === '2026-10-24-main-men-500-final-A');
  const domA = await openDialogWithAnalysis(
    finalA,
    [{ athlete_id: 'ath-1', name: 'SUN Long', country: 'CHN', helmet_number: 12, starting_position: 1 }],
    [
      {
        id: 'test-heat-1',
        people: [{ id: 'ath-1', expectedPlace: 1.5, first: 0.48, medals: [0.48, 0.27, 0.14], incident: 0.05 }]
      }
    ]
  );
  t.after(() => domA.window.close());
  assert.deepEqual(
    [...domA.window.document.querySelectorAll('.result-name-row .analysis-chip')].map((el) => el.textContent),
    ['金牌 48%', '银牌 27%', '铜牌 14%']
  );

  const finalB = schedule.entries.find((e) => e.id === '2026-10-24-main-men-500-final-B');
  const domB = await openDialogWithAnalysis(
    finalB,
    [{ athlete_id: 'ath-2', name: 'LIN Xiaojun', country: 'CHN', helmet_number: 8, starting_position: 1 }],
    [
      {
        id: 'test-heat-1',
        people: [{ id: 'ath-2', expectedPlace: 2.2, expectedFinalPlace: 6.2, first: 0.31, incident: 0.04 }]
      }
    ]
  );
  t.after(() => domB.window.close());
  assert.deepEqual(
    [...domB.window.document.querySelectorAll('.result-name-row .analysis-chip')].map((el) => el.textContent),
    ['预计最终第 6.2']
  );
});

test('site.css defines --ok-rgb, red/green factors, fixed header with scrollable body, tier pills, and content-visibility', () => {
  assert.match(css, /:root\s*\{[\s\S]*--ok-rgb:\s*111 227 190;/);
  assert.match(css, /:root\[data-theme='light'\]\s*\{[\s\S]*--ok-rgb:\s*18 134 91;/);
  assert.match(css, /\.analysis-factor-pill\.factor-pos\s*\{[^}]*--red-rgb[^}]*color:\s*var\(--red-text\)/);
  assert.match(css, /\.analysis-factor-pill\.factor-neg\s*\{[^}]*--ok-rgb[^}]*color:\s*var\(--ok\)/);
  assert.match(css, /\.competition-head\s*\{[^}]*flex:\s*none;/);
  assert.match(css, /\.competition-body\s*\{[^}]*overflow:\s*auto;/);
  assert.match(css, /\.athlete-card\s*\{[^}]*content-visibility:\s*auto;/);
  assert.match(css, /\.competition-heat\s*\{[^}]*content-visibility:\s*auto;/);
  assert.match(css, /\.analysis-chip\.is-tier-high\b/);
  assert.match(css, /\.analysis-chip\.is-tier-mid\b/);
  assert.match(css, /\.analysis-chip\.is-tier-low\b/);
});
