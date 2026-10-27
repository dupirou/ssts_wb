import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const html = await file('web/index.html');
const scripts = (await Promise.all(['navigation', 'portal', 'app'].map(name => file('web/' + name + '.js')))).join('\n');
async function page(path, fail = '') {
  const dom = new JSDOM(html, {url: new URL(path, 'https://example.test/').href, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  dom.requests = [];
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {this.setAttribute('open', '');};
  w.HTMLDialogElement.prototype.close = function () {this.removeAttribute('open');};
  w.fetch = async input => {
    const url = new URL(input, w.location.href);
    dom.requests.push(url.pathname);
    if (url.pathname === fail) return new Response('unavailable', {status: 503});
    const api = url.pathname.match(/^\/api\/v1\/events\/([^/]+)\/(entries|rounds|rankings)$/);
    if (api) {
      const snapshot = JSON.parse(await file('dist/data/competitions/' + api[1] + '.json'));
      return Response.json({schema_version: 1, event_id: api[1], resource: api[2], ...snapshot[api[2]]});
    }
    return new Response(await file('dist' + url.pathname));
  };
  w.eval(scripts);
  for (let i = 0; i < 200; i++) {
    const detail = w.document.querySelector('.section-tabs');
    const settled = !detail || (dom.requests.some(p => p.endsWith('/rounds')) && !w.document.querySelector('[data-resource][aria-busy]'));
    if (!w.document.querySelector('#app[aria-busy]') && settled) return dom;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  dom.window.close();
  throw new Error('Page did not finish loading');
}

test('home shows the next event without results or explanatory copy', async t => {
  const dom = await page('/?now=2026-10-27T04:00:00Z');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.deepEqual([...d.querySelectorAll('#site-nav a')].map(a => a.textContent), ['首页', '赛事', '成绩', '运动员']);
  assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/');
  assert.match(d.querySelector('.next-city').textContent, /蒙特利尔/);
  assert.equal(d.querySelectorAll('.st-card').length, 0);
  assert.equal(d.querySelector('.recent-card'), null);
  assert.equal(d.querySelector('.results-history'), null);
  assert.equal(d.querySelector('a[href="/history/"]'), null);
  assert.doesNotMatch(d.querySelector('#app').textContent, /看当下|更长的赛场|按奥运周期|最新动态/);
  assert.ok(!dom.requests.includes('/data/portal.json'));
  assert.ok(!dom.requests.includes('/data/updates.json'));
  assert.ok(!dom.requests.some(p => /\/api\/|athletes\.json|competitions\//.test(p)));
  assert.ok(!dom.requests.includes('/data/vancouver.json'));
});

test('events page owns the full calendar and produces shareable nested event URLs', async t => {
  const dom = await page('/events/');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelectorAll('.st-card').length, 7);
  assert.equal(d.querySelectorAll('.championship-card').length, 1);
  assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/events/');
  assert.match(d.querySelector('.st-card').getAttribute('href'), /^\/events\/2026-27\//);
  assert.equal(d.querySelector('.next-card'), null);
});

test('legacy and nested event links preserve view and country selection and use root data addresses', async t => {
  for (const route of ['/?station=vancouver&view=athletes&country=KOR', '/events/2026-27/vancouver/?view=athletes&country=KOR']) {
    const dom = await page(route);
    t.after(() => dom.window.close());
    const d = dom.window.document;
    for (let i = 0; i < 100 && !d.querySelector('.athlete-grid .athlete-card'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(d.querySelector('#tab-athletes').getAttribute('aria-selected'), 'true');
    assert.equal(d.querySelector('#tab-athletes').textContent, '报名名单');
    assert.equal(d.querySelector('select[aria-label="报名名单国家或地区"]').value, 'KOR');
    assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/events/');
    assert.equal(d.querySelector('.st-nav .back').getAttribute('href'), '/events/');
    assert.ok(dom.requests.includes('/data/vancouver.json'));
    assert.ok(!dom.requests.some(p => p.includes('/vancouver/data/')));
  }
});

test('the athlete directory filters real roster data, tolerates name order, and shares its search', async t => {
  const dom = await page('/athletes/');
  t.after(() => dom.window.close());
  const d = dom.window.document, q = d.querySelector('input[type="search"]');
  q.value = 'LI Kun';
  q.dispatchEvent(new dom.window.Event('input'));
  assert.equal(d.querySelectorAll('.directory-card').length, 1);
  assert.match(d.querySelector('.directory-card').textContent, /Kun LI/);
  assert.equal(d.querySelector('.directory-card a'), null);
  assert.doesNotMatch(d.querySelector('.directory-card').textContent, /报名/);
  assert.match(d.querySelector('.directory-rankings').textContent, /本赛季世巡赛排名500m第 16 名/);
  assert.doesNotMatch(d.querySelector('.directory-rankings').textContent, /1000m|第 45 名/);
  assert.equal(new URL(dom.window.location.href).searchParams.get('q'), 'LI Kun');
  const restored = await page(dom.window.location.pathname + dom.window.location.search);
  t.after(() => restored.window.close());
  assert.equal(restored.window.document.querySelectorAll('.directory-card').length, 1);
  assert.equal(dom.requests.filter(p => p.includes('/api/')).length, 0);
});

test('one compact results table includes current and archived Chinese scores at every entry point', async t => {
  for (const route of ['/results/', '/results/?view=history', '/history/']) {
    const dom = await page(route);
    t.after(() => dom.window.close());
    const d = dom.window.document;
    assert.equal(d.querySelector('h1').textContent, '成绩');
    assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/results/');
    assert.equal(d.querySelectorAll('.results-table tbody').length, 5);
    assert.equal(d.querySelectorAll('.result-row').length, 105);
    assert.equal(d.querySelectorAll('.results-nav, .cycle-card, .history-event, .recent-card').length, 0);
    assert.doesNotMatch(d.querySelector('#app').textContent, /本赛季|最近赛果|历史成绩/);
    assert.match(d.querySelector('.results-count').textContent, /5 场 · 105 条成绩/);
    assert.match(d.querySelector('.results-coverage').textContent, /待收录 3 场/);
    assert.deepEqual(dom.requests, ['/data/calendar.json', '/data/results.json']);
    const relay = [...d.querySelectorAll('tbody[data-event*="vancouver"] .result-row')].find(r => r.textContent.includes('女子 3000m'));
    assert.match(relay.querySelector('.result-place').textContent, /B组第 1 名/);
    assert.equal(relay.querySelector('.is-medal'), null);
  }
  const absent = await page('/events/2022-23/vancouver/');
  t.after(() => absent.window.close());
  assert.match(absent.window.document.querySelector('#app').textContent, /页面尚未收录/);
});

test('unified filters share selected season, discipline, event and actual relay lineups', async t => {
  const dom = await page('/results/?season=2025%2F26&gender=women&distance=3000');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelectorAll('.result-row').length, 3);
  const first = d.querySelector('.results-table tbody');
  assert.match(first.textContent, /世锦赛 · 蒙特利尔/);
  assert.match(first.querySelector('.result-place').textContent, /第 3 名/);
  const final = [...first.querySelectorAll('.result-lineup p')].find(p => p.textContent.startsWith('A 决赛'));
  assert.match(final.textContent, /Li GONG/);
  assert.doesNotMatch(final.textContent, /Jingru YANG/);
  const type = d.querySelector('select[name="kind"]'); type.value = 'worlds';
  type.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  assert.equal(d.querySelectorAll('.result-row').length, 1);
  assert.equal(new URL(dom.window.location.href).searchParams.has('view'), false);
  const restored = await page(dom.window.location.pathname + dom.window.location.search);
  t.after(() => restored.window.close());
  assert.equal(restored.window.document.querySelectorAll('.result-row').length, 1);
  const cycle = d.querySelector('select[name="cycle"]'); cycle.value = 'beijing-2022';
  cycle.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  assert.equal(d.querySelectorAll('.result-row').length, 0);
  assert.match(d.querySelector('.results-count').textContent, /暂无已收录/);
  d.querySelector('.results-reset').click();
  assert.equal(d.querySelectorAll('.result-row').length, 105);
  const event = d.querySelector('select[name="event"]'); event.value = '2024-25-worlds-beijing';
  event.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  assert.equal(d.querySelectorAll('.results-table tbody').length, 1);
  assert.equal(d.querySelectorAll('.result-row').length, 21);
});

test('a failed results feed preserves global navigation and provides a retry', async t => {
  const dom = await page('/results/', '/data/results.json');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.querySelector('.results-browser').textContent, /暂时无法加载/);
  assert.equal(d.querySelectorAll('#site-nav a').length, 4);
  assert.ok(d.querySelector('.results-browser button'));
});

test('after the World Tour, the homepage points to the upcoming championship', async t => {
  const dom = await page('/?now=2027-03-01T04:00:00Z');
  t.after(() => dom.window.close());
  assert.match(dom.window.document.querySelector('.next-city').textContent, /世锦赛/);
  assert.match(dom.window.document.querySelector('.next-card .btn').getAttribute('href'), /worlds-2027/);
});
