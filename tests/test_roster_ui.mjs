import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const file = (name) => readFile(new URL('../' + name, import.meta.url), 'utf8');
const html = await file('web/index.html');
const coreScripts = (
  await Promise.all(['ui', 'navigation', 'portal', 'app'].map((name) => file('web/' + name + '.js')))
).join('\n');
const rosterScript = await file('web/roster.js');

async function settle(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Roster UI did not settle');
}

async function loadPage(path, options = {}) {
  const dom = new JSDOM(html, {
    url: new URL(path, 'https://example.test/').href,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  dom.requests = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  if (options.unlocked !== false) {
    w.localStorage.setItem('ssts.analysis', '1');
  }

  // Stub lazy script injection so JSDOM executes local web/roster.js cleanly.
  const origAppend = w.HTMLHeadElement.prototype.append;
  w.HTMLHeadElement.prototype.append = function (...nodes) {
    for (const node of nodes) {
      if (node && node.tagName === 'SCRIPT' && node.getAttribute('src') === '/roster-page.js') {
        dom.requests.push('/roster-page.js');
        setTimeout(() => {
          w.eval(rosterScript);
          node.onload?.();
        }, 0);
        return;
      }
    }
    return origAppend.apply(this, nodes);
  };

  w.fetch = async (input, init) => {
    const url = new URL(input, w.location.href);
    dom.requests.push(url.pathname);
    if (options.fail && url.pathname === options.fail) {
      return new Response('unavailable', { status: 503 });
    }
    if (url.pathname === '/internal/analysis') {
      const payload = init?.body ? JSON.parse(init.body) : {};
      if (payload.action === 'login') {
        if (options.password && payload.password !== options.password) {
          return new Response('{}', { status: 401 });
        }
        return Response.json({});
      }
      if (payload.action === 'logout') {
        return Response.json({});
      }
      if (payload.action === 'roster') {
        if (options.unauthorizedRoster) {
          return new Response('{}', { status: 401 });
        }
        if (options.forecast) return Response.json(options.forecast);
        return new Response(await file('dist/data/quota_roster/chn_roster_forecast.json'));
      }
    }
    if (options.quotas && url.pathname === '/data/quota_roster/quotas_2026_27.json') {
      return Response.json(options.quotas);
    }
    if (options.forecast && url.pathname === '/data/quota_roster/chn_roster_forecast.json') {
      return Response.json(options.forecast);
    }
    return new Response(await file('dist' + url.pathname));
  };

  w.eval(coreScripts);
  for (let i = 0; i < 200; i++) {
    if (!w.document.querySelector('#app[aria-busy]')) return dom;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  dom.window.close();
  throw new Error('Page did not finish loading: ' + path);
}

test('/roster/ hides predictions by default, unlocks via 5-tap title password flow, and locks again on logout', async (t) => {
  const dom = await loadPage('/roster/', { unlocked: false, password: 'secret' });
  t.after(() => dom.window.close());
  const d = dom.window.document;

  // Locked state: public quota section renders, but zero prediction sections or /internal/analysis calls
  assert.ok(d.querySelector('[aria-label="名额与规则看板"]'));
  assert.ok(d.querySelector('.roster-penalty-bar'));
  assert.match(d.querySelector('.roster-penalty-bar').textContent, /张楚桐/);
  assert.equal(d.querySelector('[aria-label="主力阵容与淘汰边缘"]'), null);
  assert.equal(d.querySelector('[aria-label="替补梯队"]'), null);
  assert.equal(d.querySelector('.roster-top40-watch'), null);
  assert.ok(!dom.requests.includes('/internal/analysis'));
  assert.ok(!dom.requests.includes('/data/quota_roster/chn_roster_forecast.json'));

  // 5-tap on page title reveals password form
  const titleBtn = d.querySelector('.season-head h1 button');
  assert.ok(titleBtn);
  for (let i = 0; i < 5; i++) titleBtn.click();
  await settle(() => d.querySelector('.analysis-login input'));

  // Wrong password stays locked and shows error
  d.querySelector('.analysis-login input').value = 'wrong';
  d.querySelector('.analysis-login').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle(() => d.querySelector('.analysis-msg')?.textContent === '密码有误');
  assert.equal(d.querySelector('[aria-label="主力阵容与淘汰边缘"]'), null);

  // Correct password unlocks, sets localStorage.getItem('ssts.analysis') === '1', and renders predictions
  d.querySelector('.analysis-login input').value = 'secret';
  d.querySelector('.analysis-login').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle(() => d.querySelector('[aria-label="主力阵容与淘汰边缘"]'));
  assert.equal(dom.window.localStorage.getItem('ssts.analysis'), '1');
  assert.ok(d.querySelector('[aria-label="替补梯队"]'));
  assert.ok(d.querySelector('.roster-top40-watch'));

  // 5-tap again while unlocked shows 锁定预测 bar and locks back to public-only view
  for (let i = 0; i < 5; i++) titleBtn.click();
  await settle(() => d.querySelector('.analysis-lock-bar .is-danger'));
  d.querySelector('.analysis-lock-bar .is-danger').click();
  await settle(() => !d.querySelector('[aria-label="主力阵容与淘汰边缘"]'));
  assert.equal(dom.window.localStorage.getItem('ssts.analysis'), null);
  assert.equal(d.querySelector('[aria-label="替补梯队"]'), null);
  assert.ok(d.querySelector('[aria-label="名额与规则看板"]'));
});

test('/roster/ renders V2 simplified layout: quotas, penalty warnings, Core vs Bubble/Cut tiers, and reserves without V1 MC metrics', async (t) => {
  const dom = await loadPage('/roster/');
  t.after(() => dom.window.close());
  const d = dom.window.document;

  assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/roster/');
  assert.ok(dom.requests.includes('/roster-page.js'));
  assert.ok(dom.requests.includes('/data/quota_roster/quotas_2026_27.json'));
  assert.ok(dom.requests.includes('/internal/analysis'));
  assert.ok(!dom.requests.includes('/data/quota_roster/chn_roster_forecast.json'));
  assert.ok(!dom.requests.includes('/data/calendar.json'));

  const quotaSection = d.querySelector('[aria-label="名额与规则看板"]');
  assert.ok(quotaSection);
  assert.match(quotaSection.textContent, /6 人/);
  assert.match(quotaSection.textContent, /Top-40 4 人特例/);
  assert.match(quotaSection.textContent, /第 5 名/);

  const penaltyBar = d.querySelector('.roster-penalty-bar');
  assert.ok(penaltyBar);
  assert.match(penaltyBar.textContent, /张楚桐/);
  assert.match(penaltyBar.textContent, /公俐/);
  assert.match(penaltyBar.textContent, /2 次犯规预警 2 人/);

  // V1 Monte Carlo / MILP artifacts and redundant explanatory prose must be completely absent
  const pageText = d.querySelector('#app').textContent;
  assert.doesNotMatch(pageText, /μ ± σ/);
  assert.doesNotMatch(pageText, /状态动量/);
  assert.doesNotMatch(pageText, /边际替代损失/);
  assert.doesNotMatch(pageText, /正选边缘概率/);
  assert.doesNotMatch(pageText, /Top-3 最高频完整阵容方案/);
  assert.doesNotMatch(pageText, /位置与风险说明/);
  assert.doesNotMatch(pageText, /现役主力核心 · 出赛顺位稳固/);
  assert.doesNotMatch(pageText, /单项至少 3 人进 Top-40 解锁 4 席特例/);
  assert.equal(d.querySelectorAll('.roster-prob-matrix').length, 0);
  assert.equal(d.querySelectorAll('.roster-lineup-card').length, 0);

  // Main roster (WT Women = 6 starters across Core + Bubble blocks)
  assert.ok(d.querySelector('[aria-label="主力阵容与淘汰边缘"]'));
  assert.ok(d.querySelector('.roster-tier-block.is-core'));
  const mainCards = [...d.querySelectorAll('.roster-main-grid > .roster-skater-card.is-main')];
  assert.equal(mainCards.length, 6);
  assert.match(mainCards[0].textContent, /稳固主力/);
  assert.match(mainCards[0].textContent, /推荐报项/);
  assert.match(mainCards[0].textContent, /世界排名/);
  assert.match(mainCards[0].textContent, /本季WT/);

  // Expanding full candidate pool shows dual-eligible skaters
  const allCandidates = d.querySelector('.roster-all-candidates');
  assert.ok(allCandidates);
  allCandidates.open = true;
  assert.ok(allCandidates.querySelector('.roster-tag.is-dual'));

  // Reserve pool (respects dynamic reserve_cap: WT=2 or WC<=6)
  const forecastJson = JSON.parse(await file('dist/data/quota_roster/chn_roster_forecast.json'));
  const wtWomen = forecastJson.scenarios.world_tour_next_stop.women;
  const expectedCap = wtWomen.reserve_cap ?? wtWomen.reserves.length;
  const reservesSection = d.querySelector('[aria-label="替补梯队"]');
  assert.ok(reservesSection);
  assert.match(reservesSection.querySelector('h2').textContent, new RegExp(`${expectedCap} 人`));
  const reserves = [...d.querySelectorAll('.roster-reserve-card')];
  assert.equal(reserves.length, wtWomen.reserves.length);
  assert.ok(reserves.length >= 1 && reserves.length <= expectedCap);
  assert.deepEqual(
    reserves.map((el) => el.querySelector('.roster-reserve-rank').textContent),
    reserves.map((_, i) => '#' + (i + 1))
  );
  const reserveText = reserves.map((el) => el.textContent).join('\n');
  assert.match(reserveText, /短距离 \/ 接力|中长距离|综合机动/);
  assert.match(reserveText, /对位顶替/);
});

test('/roster/ renders Top-40 watch columns, Core vs Bubble/Cut tiers, world ranks, and WC 6-to-5 cut badges', async (t) => {
  const forecast = JSON.parse(await file('dist/data/quota_roster/chn_roster_forecast.json'));
  const wtWomen = forecast.scenarios.world_tour_next_stop.women;
  const wtIds = wtWomen.candidates.map((c) => c.athlete_id);
  wtWomen.roster_tiers = {
    core_ids: wtIds.slice(0, 4),
    bubble_ids: wtIds.slice(4, 6),
    cut_ids: wtIds.slice(6, 7)
  };
  wtWomen.candidates[0].world_ranks = {
    500: { rank: 16, points: 420, cutoff_points: 87, margin_vs_top40: 333, in_top40: true },
    1000: { rank: 22, points: 310, cutoff_points: 112, margin_vs_top40: 198, in_top40: true }
  };
  wtWomen.candidates[0].specialty_label = '短距离 / 接力';
  wtWomen.candidates[0].status_note = '稳固主力 · 本季WT核心';
  wtWomen.candidates[4].status_note = '轮换保席临界';
  wtWomen.candidates[6].world_ranks = {};
  wtWomen.candidates[6].recommended_entries = ['500', '1000'];
  wtWomen.candidates[6].status_note = '本季WT轮换竞争';

  const wcWomen = forecast.scenarios.world_championships_2027.women;
  const wcIds = wcWomen.candidates.map((c) => c.athlete_id);
  wcWomen.roster_tiers = {
    core_ids: wcIds.slice(0, 4),
    bubble_ids: wcIds.slice(4, 5),
    cut_ids: wcIds.slice(5, 7)
  };

  forecast.top40_watch = {
    women: {
      500: {
        distance_m: 500,
        slots: 4,
        cutoff_rank: 40,
        cutoff_points: 87,
        top40_total_chn: 4,
        top40_active_chn: 3,
        status: 'TIGHT',
        skaters: [
          { rank: 16, name_zh: '张楚桐', points: 420, margin_vs_top40: 333, zone: 'SAFE' },
          { rank: 32, name_zh: '王欣然', points: 110, margin_vs_top40: 23, zone: 'PROTECT' },
          { rank: 46, name_zh: '范可新', points: 58, margin_vs_top40: -29, zone: 'CHASE' },
          { rank: 19, name_zh: '老将甲', points: 360, margin_vs_top40: 273, zone: 'INACTIVE_TOP40' },
          { rank: 68, name_zh: '新人乙', points: 12, margin_vs_top40: -75, zone: 'OUT' }
        ]
      },
      1000: {
        distance_m: 1000,
        slots: 4,
        cutoff_rank: 40,
        cutoff_points: 112,
        top40_total_chn: 4,
        top40_active_chn: 4,
        status: 'SAFE',
        skaters: [
          { rank: 12, name_zh: '公俐', points: 510, margin_vs_top40: 398, zone: 'SAFE' }
        ]
      },
      1500: {
        distance_m: 1500,
        slots: 3,
        cutoff_rank: 40,
        cutoff_points: 105,
        top40_total_chn: 2,
        top40_active_chn: 2,
        status: 'BELOW',
        skaters: [
          { rank: 14, name_zh: '公俐', points: 440, margin_vs_top40: 335, zone: 'SAFE' }
        ]
      }
    },
    men: {}
  };

  const domWt = await loadPage('/roster/?event=wt&gender=women', { forecast });
  t.after(() => domWt.window.close());
  const dWt = domWt.window.document;

  const watch = dWt.querySelector('.roster-top40-watch');
  assert.ok(watch);
  assert.equal(watch.querySelectorAll('.roster-top40-col').length, 3);
  assert.match(watch.textContent, /4 席特例/);
  assert.match(watch.textContent, /3 席常规/);
  assert.match(watch.textContent, /现役前40: 3人/);
  assert.match(watch.textContent, /#40 门槛线: 87 分/);
  assert.match(watch.textContent, /\+333/);
  assert.match(watch.textContent, /-29/);
  assert.match(watch.textContent, /主力安全/);
  assert.match(watch.textContent, /保席临界/);
  assert.match(watch.textContent, /冲席边缘/);
  assert.match(watch.textContent, /未出战老积分/);
  assert.match(watch.textContent, /前40外/);

  // WT Women: 4 core + 2 bubble = 6 .is-main; 1 .is-cut without .is-main
  assert.equal(dWt.querySelectorAll('.roster-tier-block.is-core .roster-skater-card.is-main').length, 4);
  assert.equal(dWt.querySelectorAll('.roster-tier-block.is-bubble .roster-skater-card.is-main').length, 2);
  assert.equal(dWt.querySelectorAll('.roster-main-grid > .roster-skater-card.is-main').length, 6);
  const cutCard = dWt.querySelector('.roster-skater-card.is-cut');
  assert.ok(cutCard);
  assert.ok(!cutCard.classList.contains('is-main'));
  assert.match(cutCard.textContent, /本季WT轮换候补/);
  assert.match(dWt.querySelector('.roster-skater-card.is-core').textContent, /500m #16 · 1000m #22/);
  assert.match(dWt.querySelector('.roster-skater-card.is-bubble').textContent, /轮换 \/ 保席边缘/);

  // Switch to WC Women: 4 core + 1 bubble = 5 .is-main; 2 .is-cut with 6缩5 裁撤边缘
  dWt.querySelector('.roster-seg-btn[data-value="wc"]').click();
  assert.equal(dWt.querySelectorAll('.roster-main-grid > .roster-skater-card.is-main').length, 5);
  assert.equal(dWt.querySelectorAll('.roster-skater-card.is-cut').length, 2);
  assert.match(dWt.querySelector('.roster-skater-card.is-bubble').textContent, /第5人压线席位/);
  assert.match(dWt.querySelector('.roster-skater-card.is-cut').textContent, /6缩5 裁撤边缘/);
});

test('/roster/ renders dynamic reserve_cap (WT=2, WC<=6), qualification_path, and fallback Top40 badges', async (t) => {
  const forecast = JSON.parse(await file('dist/data/quota_roster/chn_roster_forecast.json'));
  const wtWomen = forecast.scenarios.world_tour_next_stop.women;
  const wtStarterId =
    wtWomen.roster_tiers?.core_ids?.[0] ||
    wtWomen.preferred_main_roster?.ordered_ids?.[0] ||
    wtWomen.preferred_main_roster?.athlete_ids?.[0] ||
    wtWomen.candidates[0].athlete_id;
  const wtStarter = wtWomen.candidates.find((c) => c.athlete_id === wtStarterId);
  wtWomen.reserve_cap = 2;
  wtWomen.reserves = wtWomen.reserves.slice(0, 2);
  wtStarter.qualification_path = 'WT_2026_27';
  wtStarter.world_ranks = {};
  wtStarter.world_ranking_top40_distances = [500, 1000, 1500];
  wtWomen.reserves[0].qualification_path = 'DOMESTIC_GOLD';
  wtWomen.reserves[0].world_ranks = {};
  wtWomen.reserves[0].world_ranking_top40_distances = [1500];

  const wcWomen = forecast.scenarios.world_championships_2027.women;
  const wcStarterId =
    wcWomen.roster_tiers?.core_ids?.[0] ||
    wcWomen.preferred_main_roster?.ordered_ids?.[0] ||
    wcWomen.preferred_main_roster?.athlete_ids?.[0] ||
    wcWomen.candidates[0].athlete_id;
  const wcStarter = wcWomen.candidates.find((c) => c.athlete_id === wcStarterId);
  wcWomen.reserve_cap = 6;
  wcWomen.reserves = wcWomen.reserves.slice(0, 4);
  wcStarter.qualification_path = 'JWC_2026_27';
  wcWomen.reserves[0].qualification_path = 'DOMESTIC_TOP3';

  const domWt = await loadPage('/roster/?event=wt&gender=women', { forecast });
  t.after(() => domWt.window.close());
  const dWt = domWt.window.document;
  assert.match(dWt.querySelector('[aria-label="替补梯队"] h2').textContent, /替补梯队（2 人）/);
  assert.equal(dWt.querySelectorAll('.roster-reserve-card').length, 2);
  const wtStarterCard = dWt.querySelector(`.roster-skater-card[data-athlete-id="${wtStarterId}"]`);
  assert.ok(wtStarterCard);
  assert.match(wtStarterCard.textContent, /本季WT/);
  assert.match(wtStarterCard.textContent, /Top40: 500·1000·1500m/);
  assert.match(dWt.querySelector('.roster-reserve-card').textContent, /七台河金牌/);

  const domWc = await loadPage('/roster/?event=wc&gender=women', { forecast });
  t.after(() => domWc.window.close());
  const dWc = domWc.window.document;
  assert.match(
    dWc.querySelector('[aria-label="替补梯队"] h2').textContent,
    /替补梯队（4 \/ 6 人）/
  );
  assert.equal(dWc.querySelectorAll('.roster-reserve-card').length, 4);
  const wcStarterCard = dWc.querySelector(`.roster-skater-card[data-athlete-id="${wcStarterId}"]`);
  assert.ok(wcStarterCard);
  assert.match(wcStarterCard.textContent, /青杯梯队/);
  assert.match(dWc.querySelector('.roster-reserve-card').textContent, /七台河前三/);
});

test('/roster/ supports URL-synced switching to 2027 WC, CHN Men, and country quota filtering', async (t) => {
  const dom = await loadPage('/roster/?event=wc&gender=men');
  t.after(() => dom.window.close());
  const d = dom.window.document;

  const wcBtn = d.querySelector('.roster-seg-btn[data-value="wc"]');
  const menBtn = d.querySelector('.roster-seg-btn[data-value="men"]');
  assert.equal(wcBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(menBtn.getAttribute('aria-pressed'), 'true');

  // CHN Men 2027 WC: 5 max, 3/2/2 individual slots, Men 5000m relay #3
  const quotaSection = d.querySelector('[aria-label="名额与规则看板"]');
  assert.match(quotaSection.textContent, /5 人/);
  assert.match(quotaSection.textContent, /男子 5000m 接力：第 3 名/);

  const mainCards = [...d.querySelectorAll('.roster-main-grid > .roster-skater-card.is-main')];
  assert.equal(mainCards.length, 5);

  // Country quota table filter
  const countriesPanel = d.querySelector('.roster-countries-panel');
  assert.ok(countriesPanel);
  countriesPanel.open = true;
  const filter = countriesPanel.querySelector('.roster-country-filter');
  filter.value = '韩国';
  filter.dispatchEvent(new dom.window.Event('input'));
  const countryRows = [...countriesPanel.querySelectorAll('tbody tr')];
  assert.equal(countryRows.length, 1);
  assert.match(countryRows[0].textContent, /KOR/);

  // Interactive segmented switch to Beijing WT stop and back to Shanghai WT + Women updates URL & DOM without re-fetching
  const reqCountBefore = dom.requests.length;
  const bjBtn = d.querySelector('.roster-seg-btn[data-value="wt_beijing"]');
  assert.ok(bjBtn);
  bjBtn.click();
  assert.equal(new URL(dom.window.location.href).searchParams.get('event'), 'wt_beijing');
  assert.match(d.querySelector('[aria-label="名额与规则看板"]').textContent, /目标分站：Beijing/);

  d.querySelector('.roster-seg-btn[data-value="wt"]').click();
  d.querySelector('.roster-seg-btn[data-value="women"]').click();
  assert.equal(dom.requests.length, reqCountBefore);
  const url = new URL(dom.window.location.href);
  assert.equal(url.searchParams.get('event'), 'wt');
  assert.equal(url.searchParams.get('gender'), 'women');
  assert.equal(
    d.querySelectorAll('.roster-main-grid > .roster-skater-card.is-main').length,
    6
  );
});

test('non-roster routes perform zero quota_roster or roster-page.js network fetches', async (t) => {
  for (const route of ['/?now=2026-10-27T04:00:00Z', '/events/', '/athletes/']) {
    const dom = await loadPage(route);
    t.after(() => dom.window.close());
    assert.ok(
      !dom.requests.some((p) => p.includes('quota_roster') || p.includes('roster-page.js')),
      route + ' must not fetch roster data or bundle'
    );
  }
});

test('/roster/ displays a clean retry UI when quota data fails to load', async (t) => {
  const dom = await loadPage('/roster/', { fail: '/data/quota_roster/quotas_2026_27.json' });
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.querySelector('#app').textContent, /阵容数据暂时无法读取/);
  assert.ok(d.querySelector('#app button'));
});
