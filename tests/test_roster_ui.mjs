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

  w.fetch = async (input) => {
    const url = new URL(input, w.location.href);
    dom.requests.push(url.pathname);
    if (options.fail && url.pathname === options.fail) {
      return new Response('unavailable', { status: 503 });
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

test('/roster/ renders 2026/27 WT 4-skater quotas, penalty warnings, CHN Women main roster, Top-3 lineups, and 6 reserves', async (t) => {
  const dom = await loadPage('/roster/');
  t.after(() => dom.window.close());
  const d = dom.window.document;

  assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/roster/');
  assert.ok(dom.requests.includes('/roster-page.js'));
  assert.ok(dom.requests.includes('/data/quota_roster/quotas_2026_27.json'));
  assert.ok(dom.requests.includes('/data/quota_roster/chn_roster_forecast.json'));
  assert.ok(!dom.requests.includes('/data/calendar.json'));

  const quotaSection = d.querySelector('[aria-label="名额与规则看板"]');
  assert.ok(quotaSection);
  assert.match(quotaSection.textContent, /6 人/);
  assert.match(quotaSection.textContent, /WT Top-40 报 4 人特例/);
  assert.match(quotaSection.textContent, /第 5 名/);

  const penaltyBar = d.querySelector('.roster-penalty-bar');
  assert.ok(penaltyBar);
  assert.match(penaltyBar.textContent, /张楚桐/);
  assert.match(penaltyBar.textContent, /公俐/);
  assert.match(penaltyBar.textContent, /2 次犯规预警 2 人/);
  assert.match(penaltyBar.textContent, /PELLETIER Mathieu/);

  // Main roster (WT Women = 6 skaters)
  const mainCards = [...d.querySelectorAll('.roster-main-grid > .roster-skater-card.is-main')];
  assert.equal(mainCards.length, 6);
  assert.match(mainCards[0].textContent, /张楚桐/);
  assert.match(mainCards[0].textContent, /500m/);
  assert.match(mainCards[0].textContent, /1000m/);
  assert.match(mainCards[0].textContent, /1500m/);
  assert.match(mainCards[0].textContent, /接力/);
  assert.ok(mainCards[0].querySelectorAll('.roster-prob-row').length === 4);
  assert.ok(mainCards[0].querySelector('.roster-prob-row.is-preferred'));
  assert.ok(mainCards[0].querySelector('.roster-momentum.is-pos'));
  assert.match(mainCards[0].textContent, /成年/);
  assert.match(mainCards[0].textContent, /成年世巡/);
  assert.match(mainCards[0].textContent, /μ ± σ/);
  assert.match(mainCards[0].textContent, /\d+\.\d{2} ± \d+\.\d{2}/);

  // Expanding full candidate pool shows dual-eligible skaters; negative momentum renders with .is-neg
  const allCandidates = d.querySelector('.roster-all-candidates');
  assert.ok(allCandidates);
  allCandidates.open = true;
  assert.ok(allCandidates.querySelector('.roster-tag.is-dual'));
  assert.ok(d.querySelector('.roster-momentum.is-neg'));

  // Top-3 lineups
  const lineups = [...d.querySelectorAll('.roster-lineup-card')];
  assert.equal(lineups.length, 3);
  assert.match(lineups[0].textContent, /方案 #1/);
  assert.match(lineups[0].textContent, /出现频率/);

  // Reserve pool (respects dynamic reserve_cap: WT=2 or WC<=6)
  const forecastJson = JSON.parse(await file('dist/data/quota_roster/chn_roster_forecast.json'));
  const wtWomen = forecastJson.scenarios.world_tour_next_stop.women;
  const expectedCap = wtWomen.reserve_cap ?? wtWomen.reserves.length;
  const reservesSection = d.querySelector('[aria-label="替补梯队"]');
  assert.ok(reservesSection);
  assert.match(reservesSection.querySelector('h2').textContent, new RegExp(`限额 ${expectedCap} 人`));
  const reserves = [...d.querySelectorAll('.roster-reserve-card')];
  assert.equal(reserves.length, wtWomen.reserves.length);
  assert.ok(reserves.length >= 1 && reserves.length <= expectedCap);
  assert.deepEqual(
    reserves.map((el) => el.querySelector('.roster-reserve-rank').textContent),
    reserves.map((_, i) => '#' + (i + 1))
  );
  const reserveText = reserves.map((el) => el.textContent).join('\n');
  assert.match(reserveText, /短距离 \/ 接力|中长距离|综合 \/ 高潜力机动/);
  assert.match(reserveText, /双适龄 U-19|成年/);
  assert.match(reserveText, /首要顶替对象/);
  assert.match(reserveText, /边际替代损失/);
});

test('/roster/ renders dynamic reserve_cap (WT=2, WC<=6), qualification_path, and Top40 badges', async (t) => {
  const forecast = JSON.parse(await file('dist/data/quota_roster/chn_roster_forecast.json'));
  const wtWomen = forecast.scenarios.world_tour_next_stop.women;
  wtWomen.reserve_cap = 2;
  wtWomen.reserves = wtWomen.reserves.slice(0, 2);
  wtWomen.candidates[0].qualification_path = 'WT_2026_27';
  wtWomen.candidates[0].world_ranking_top40_distances = [500, 1000, 1500];
  wtWomen.reserves[0].qualification_path = 'DOMESTIC_GOLD';
  wtWomen.reserves[0].world_ranking_top40_distances = [1500];

  const wcWomen = forecast.scenarios.world_championships_2027.women;
  wcWomen.reserve_cap = 6;
  wcWomen.reserves = wcWomen.reserves.slice(0, 4);
  wcWomen.candidates[0].qualification_path = 'JWC_2026_27';
  wcWomen.reserves[0].qualification_path = 'DOMESTIC_TOP3';

  const domWt = await loadPage('/roster/?event=wt&gender=women', { forecast });
  t.after(() => domWt.window.close());
  const dWt = domWt.window.document;
  assert.match(dWt.querySelector('[aria-label="替补梯队"] h2').textContent, /替补梯队（限额 2 人）/);
  assert.equal(dWt.querySelectorAll('.roster-reserve-card').length, 2);
  assert.match(dWt.querySelector('.roster-skater-card').textContent, /本季WT/);
  assert.match(dWt.querySelector('.roster-skater-card').textContent, /Top40: 500·1000·1500m/);
  assert.match(dWt.querySelector('.roster-reserve-card').textContent, /七台河金牌/);
  assert.match(dWt.querySelector('.roster-reserve-card').textContent, /Top40: 1500m/);

  const domWc = await loadPage('/roster/?event=wc&gender=women', { forecast });
  t.after(() => domWc.window.close());
  const dWc = domWc.window.document;
  assert.match(
    dWc.querySelector('[aria-label="替补梯队"] h2').textContent,
    /替补梯队（最多 6 人，当前 4 人）/
  );
  assert.equal(dWc.querySelectorAll('.roster-reserve-card').length, 4);
  assert.match(dWc.querySelector('.roster-skater-card').textContent, /青杯梯队/);
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
  assert.match(quotaSection.textContent, /Comm\. 2805/);
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

  // Interactive segmented switch back to WT + Women updates URL & DOM without re-fetching
  const reqCountBefore = dom.requests.length;
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
  const dom = await loadPage('/roster/', { fail: '/data/quota_roster/chn_roster_forecast.json' });
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.querySelector('#app').textContent, /阵容数据暂时无法读取/);
  assert.ok(d.querySelector('#app button'));
});
