import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const html = await file('web/index.html');
const resultData = JSON.parse(await file('dist/data/results.json'));
const currentEvents = resultData.events.filter(e=>e.season==='2026/27');
const currentCount = currentEvents.reduce((n,e)=>n+e.results.length,0);
const scripts = (await Promise.all(['ui', 'navigation', 'results-model', 'results-store', 'results-compare', 'results', 'portal', 'app'].map(name => file('web/' + name + '.js')))).join('\n');
async function settled(dom,predicate=()=>!dom.window.document.querySelector('.results-table[aria-busy]')) {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}
  throw new Error('UI did not settle');
}
async function page(path, fail = '', resultsIndex = null) {
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
    if (resultsIndex && url.pathname === '/data/results/index.json') return Response.json(resultsIndex);
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
  assert.equal(d.querySelector('.directory-helmet').textContent, '67');
  assert.doesNotMatch(d.querySelector('.directory-card').textContent, /头盔号|#/);
  assert.equal(d.querySelector('.directory-card a'), null);
  assert.doesNotMatch(d.querySelector('.directory-card').textContent, /报名/);
  assert.match(d.querySelector('.directory-rankings').textContent, /500m第 16 名/);
  assert.doesNotMatch(d.querySelector('.directory-rankings').textContent, /1000m|第 45 名/);
  assert.equal(new URL(dom.window.location.href).searchParams.get('q'), 'LI Kun');
  const restored = await page(dom.window.location.pathname + dom.window.location.search);
  t.after(() => restored.window.close());
  assert.equal(restored.window.document.querySelectorAll('.directory-card').length, 1);
  assert.equal(dom.requests.filter(p => p.includes('/api/')).length, 0);
});

test('athlete cards sort by numeric helmet number, then names, with one ranking heading', async t => {
  const dom = await page('/athletes/');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const cards = [...d.querySelectorAll('.directory-card')];
  const number = card => {
    const el = card.querySelector('.directory-helmet');
    return el ? Number(el.textContent) : null;
  };
  const known = cards.map(number).filter(value => value != null);
  assert.ok(known.length > 100, 'known official numbers must be displayed');
  assert.deepEqual(known, [...known].sort((a, b) => a - b));
  assert.ok(cards.slice(known.length).every(card => number(card) == null), 'unknown numbers sort last');
  assert.equal(d.querySelectorAll('.directory-ranking-context h2').length, 1);
  assert.equal(d.querySelector('.directory-ranking-context h2').textContent, '本赛季世巡赛排名');
  assert.equal(d.querySelectorAll('.directory-rankings h3').length, 0);
  assert.equal(d.querySelectorAll('.directory-rankings dl').length > 0, true);
  assert.equal((d.querySelector('#app').textContent.match(/本赛季世巡赛排名/g) || []).length, 1);
  const first = cards[0].querySelector('.directory-identity');
  assert.ok(first.firstElementChild.matches('.directory-helmet'));
  assert.ok(first.children[1].matches('.athlete-nation, .athlete-china'));
  assert.match(first.firstElementChild.textContent, /^\d+$/);
  const country = d.querySelector('select[name="country"]');
  country.value = 'CHN';
  country.dispatchEvent(new dom.window.Event('change'));
  const chinese = [...d.querySelectorAll('.directory-card')];
  assert.equal(chinese.length, 12);
  const chinaNumbers = chinese.map(number);
  assert.deepEqual(chinaNumbers, [...chinaNumbers].sort((a, b) => a - b));
  assert.equal(chinese[0].querySelector('.directory-helmet').textContent, '4');
  assert.equal(d.querySelectorAll('.directory-ranking-context h2').length, 1);
});

test('results overview links to separate season, cycle and comparison pages without dumping scores', async t => {
  const dom = await page('/results/');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelector('h1').textContent, '成绩');
  assert.equal(d.querySelector('#site-nav [aria-current]').getAttribute('href'), '/results/');
  assert.equal(d.querySelectorAll('.result-row, .cycle-card').length, 0);
  assert.ok(d.querySelector('a[href="/results/cycles/"]'));
  assert.ok(d.querySelector('a[href="/results/seasons/2026-27/"]'));
  assert.equal(d.querySelector('.results-index-columns'), null);
  assert.doesNotMatch(d.querySelector('.review-nav').textContent, /赛季回顾|周期回顾/);
  assert.ok(d.querySelector('.results-compare-entry'));
  assert.deepEqual(dom.requests, ['/data/results/index.json']);
});

test('event browser retains current and archived scores and legacy result links', async t => {
  for (const route of ['/results/events/', '/results/?view=history', '/history/', '/?view=history']) {
    const dom = await page(route);
    t.after(() => dom.window.close());
    const d = dom.window.document;
    assert.ok(!dom.requests.includes('/data/results.json'));
    assert.equal(d.querySelectorAll('.results-table tbody').length, currentEvents.length);
    assert.equal(d.querySelectorAll('.result-row').length, currentCount);
    const relay = [...d.querySelectorAll('tbody[data-event*="vancouver"] .result-row')].find(r => r.textContent.includes('女子 3000m'));
    assert.match(relay.querySelector('.result-place').textContent, /第 5 名/);
    assert.equal(relay.querySelector('.is-medal'), null);
  }
  const detail = await page('/results/events/2025-26-worlds-montreal/');
  t.after(() => detail.window.close());
  assert.equal(detail.window.document.querySelectorAll('.result-row').length, 16);
  assert.match(detail.window.document.querySelector('.results-breadcrumb').textContent, /米兰周期.*2025\/26.*蒙特利尔/);
  const absent = await page('/events/2022-23/vancouver/');
  t.after(() => absent.window.close());
  assert.match(absent.window.document.querySelector('#app').textContent, /页面尚未收录/);
});

test('unified filters share selected season, discipline, event and actual relay lineups', async t => {
  const dom = await page('/results/events/?season=2025%2F26&gender=women&distance=3000');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelectorAll('.result-row').length, resultData.events.filter(e=>e.season==='2025/26').slice(0,4).flatMap(e=>e.results).filter(r=>r.gender==='women'&&r.distance_m===3000&&r.format==='relay').length);
  const first = d.querySelector('.results-table tbody');
  assert.match(first.textContent, /世锦赛 · 蒙特利尔/);
  assert.match(first.querySelector('.result-place').textContent, /第 3 名/);
  const final = [...first.querySelectorAll('.result-lineup p')].find(p => p.textContent.startsWith('A 决赛'));
  assert.match(final.textContent, /Li GONG/);
  assert.doesNotMatch(final.textContent, /Jingru YANG/);
  const type = d.querySelector('select[name="kind"]'); type.value = 'worlds';
  type.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  await settled(dom);
  assert.equal(d.querySelectorAll('.result-row').length, 1);
  assert.equal(new URL(dom.window.location.href).searchParams.has('view'), false);
  const restored = await page(dom.window.location.pathname + dom.window.location.search);
  t.after(() => restored.window.close());
  assert.equal(restored.window.document.querySelectorAll('.result-row').length, 1);
  const cycle = d.querySelector('select[name="cycle"]'); cycle.value = 'cycle-2030';
  cycle.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  await settled(dom);
  assert.equal(d.querySelectorAll('.result-row').length, 0);
  assert.match(d.querySelector('.results-count').textContent, /没有匹配的赛事/);
  d.querySelector('.results-reset').click();
  await settled(dom);
  assert.equal(d.querySelectorAll('.result-row').length, currentCount);
  const season=d.querySelector('select[name="season"]');season.value='2024/25';season.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await settled(dom);
  const event = d.querySelector('select[name="event"]'); event.value = '2024-25-worlds-beijing';
  event.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  await settled(dom);
  assert.equal(d.querySelectorAll('.results-table tbody').length, 1);
  assert.equal(d.querySelectorAll('.result-row').length, 21);
});

test('a failed results feed preserves global navigation and provides a retry', async t => {
  const dom = await page('/results/', '/data/results/index.json');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.querySelector('.review-content').textContent, /暂时无法加载/);
  assert.equal(d.querySelectorAll('#site-nav a').length, 4);
  assert.ok(d.querySelector('.review-content button'));
});

test('after the World Tour, the homepage points to the upcoming championship', async t => {
  const dom = await page('/?now=2027-03-01T04:00:00Z');
  t.after(() => dom.window.close());
  assert.match(dom.window.document.querySelector('.next-city').textContent, /世锦赛/);
  assert.match(dom.window.document.querySelector('.next-card .btn').getAttribute('href'), /worlds-2027/);
});


test('comparison preserves official PEN places, expands contributing results and shares metric choices', async t => {
  const dom = await page('/results/compare/');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelectorAll('.compare-project').length, 9);
  const relay = d.querySelectorAll('.compare-project')[3];
  assert.match(relay.textContent, /第 8 名 · PEN/);
  assert.match(relay.textContent, /第 3 名/);
  assert.equal(relay.querySelectorAll('.is-medal').length, 1);
  relay.querySelector('button').click();
  await settled(dom,()=>!relay.nextElementSibling.textContent.includes('正在读取'));
  assert.equal(relay.nextElementSibling.hidden, false);
  assert.equal(relay.querySelector('button').getAttribute('aria-expanded'), 'true');
  assert.match(relay.nextElementSibling.textContent, /世锦赛 · 北京/);
  assert.ok(relay.nextElementSibling.querySelector('a[href*="2024-25-worlds-beijing"]'));
  const metric = d.querySelector('[name="metric"]'); metric.value = 'medals';
  metric.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  await settled(dom,()=>d.querySelectorAll('.compare-project')[3].textContent.includes(' 铜'));
  assert.match(d.querySelectorAll('.compare-project')[3].textContent, /0 金 · 0 银 · 1 铜/);
  const restored = await page(dom.window.location.pathname + dom.window.location.search);
  t.after(() => restored.window.close());
  assert.equal(restored.window.document.querySelector('[name="metric"]').value, 'medals');
  const left = d.querySelector('[name="left"]');
  assert.ok(left.closest('thead'));
  left.value = '2026/27'; left.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  await settled(dom,()=>d.querySelector('.compare-project td').textContent==='未收录');
  assert.equal(d.querySelector('.compare-project td').textContent, '未收录');
  const third = d.querySelector('[name="third"]');
  third.value = '2023/24'; third.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  await settled(dom,()=>d.querySelector('.compare-table').dataset.columns==='3');
  assert.equal(d.querySelector('.compare-table').dataset.columns, '3');
  assert.ok(third.closest('thead'));
  d.querySelector('.compare-more summary').click();
  await settled(dom,()=>d.querySelector('.compare-table').dataset.columns==='2');
  assert.equal(d.querySelector('.compare-table').dataset.columns, '2');
  assert.equal(new URL(dom.window.location.href).searchParams.has('third'), false);

});

test('cycle comparison distinguishes missing archives and never awards a B-final winner gold', async t => {
  const empty = await page('/results/compare/?mode=cycle&left=cycle-2030&right=milano-2026');
  t.after(() => empty.window.close());
  const d = empty.window.document;
  for (const row of d.querySelectorAll('.compare-project')) assert.equal(row.querySelector('td').textContent, '未收录');
  d.querySelector('.project-toggle').click();
  assert.deepEqual([...d.querySelectorAll('#project-detail-0 h4')].map(el=>el.textContent), ['2026/27','2022/23','2027/28','2023/24','2028/29','2024/25','2029/30','2025/26']);
  const current = await page('/results/compare/?left=2025%2F26&right=2026%2F27&kind=worldtour&metric=medals');
  t.after(() => current.window.close());
  const relay = current.window.document.querySelectorAll('.compare-project')[3];
  assert.equal(relay.querySelectorAll('td')[1].textContent, '0 金 · 0 银 · 0 铜1 条成绩');
  const review = await page('/results/seasons/2025-26/');
  t.after(() => review.window.close());
  assert.equal(review.window.document.querySelector('h1').textContent, '2025/26');
  assert.ok(review.window.document.querySelector('.results-breadcrumb a[href="/results/cycles/milano-2026/"]'));
  assert.equal(review.window.document.querySelectorAll('.compare-project').length, 9);
});


test('statistics count relay medals once and exclude DNS, B-final wins and superfinal medals', async t => {
  const dom = await page('/results/'); t.after(()=>dom.window.close());
  const row=(rank,extra={})=>({format:'individual',distance_m:500,rank,rank_scope:'overall',status:'classified',final_group:'A',...extra});
  const stats=dom.window.SSTS.resultsModel.statistics([{results:[row(1,{format:'relay',distance_m:5000,members:[{},{},{},{}]}),row(1,{rank_scope:'final',final_group:'B'}),row(2,{status:'PEN'}),row(null,{status:'DNS'}),row(3),row(1,{medal_eligible:false})]}]);
  assert.deepEqual(Array.from(stats.medals),[1,0,1]);
  assert.equal(stats.starts,4);
  assert.equal(stats.a_finals,3);
  assert.equal(stats.top8,2);
});


test('all-season pagination is bounded, shares the page and does not load unused details',async t=>{
  const dom=await page('/history/?season=all');t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.equal(d.querySelectorAll('.results-table tbody').length,4);
  assert.equal(dom.requests.filter(p=>p.startsWith('/data/results/events/')).length,4);
  d.querySelector('.results-pager button:last-child').click();await settled(dom);
  assert.equal(d.querySelectorAll('.results-table tbody').length,4);
  assert.equal(dom.requests.filter(p=>p.startsWith('/data/results/events/')).length,8);
  assert.equal(new URL(dom.window.location.href).searchParams.get('season'),'all');
  assert.equal(new URL(dom.window.location.href).searchParams.get('page'),'2');
  const restored=await page(dom.window.location.pathname+dom.window.location.search);t.after(()=>restored.window.close());
  assert.equal(restored.window.document.querySelector('.results-table tbody').dataset.event,d.querySelector('.results-table tbody').dataset.event);
});

test('review and compare use summaries, fetch raw evidence only on expansion',async t=>{
  const dom=await page('/results/compare/?mode=cycle&left=beijing-2022&right=milano-2026&kind=circuit');t.after(()=>dom.window.close());
  const d=dom.window.document;
  assert.equal(dom.requests.some(p=>p.startsWith('/data/results/events/')),false);
  assert.equal(d.querySelectorAll('.review-records li').length,0);
  assert.equal(d.querySelectorAll('.compare-detail td').length,0);
  assert.ok(!dom.requests.includes('/data/results.json'));
  d.querySelector('.project-toggle').click();
  await settled(dom,()=>!d.querySelector('#project-detail-0').textContent.includes('正在读取'));
  assert.ok(dom.requests.some(p=>p.startsWith('/data/results/events/')));
  assert.ok(d.querySelectorAll('.review-records li').length>0);
});

test('zero participation stays visible while backend coverage diagnostics stay out of the UI',async t=>{
  const empty=resultData.events.find(e=>e.participation==='none');
  assert.ok(empty);
  const dom=await page('/results/events/'+empty.id+'/');t.after(()=>dom.window.close());
  assert.match(dom.window.document.querySelector('.results-table').textContent,/无中国队记录（0）/);
  const partial=await page('/results/cycles/milano-2026/?kind=circuit');t.after(()=>partial.window.close());
  assert.ok(partial.window.document.querySelectorAll('.compare-project').length>0);
  assert.doesNotMatch(partial.window.document.querySelector('.review-content').textContent,/已收录部分|缺最终分类|最终分类缺失|待核验/);
  assert.ok(resultData.events.some(e=>e.coverage_detail?.missing_classifications>0),
    'coverage diagnostics are still retained in the generated data');
});

test('event comparison selects exact stations, reuses season summaries, and expands only selected events', async t => {
  const left = '2025-26-worldtour-montreal-1';
  const right = '2025-26-worldtour-montreal-2';
  const dom = await page('/results/compare/?mode=event&left=' + left + '&right=' + right);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelector('[name=left]').value, left);
  assert.equal(d.querySelector('[name=right]').value, right);
  assert.equal(d.querySelector('[name=left_season]').value, '2025/26');
  assert.equal(d.querySelector('.field-kind').hidden, true);
  assert.equal(d.querySelectorAll('.compare-project').length, 9);
  assert.equal(dom.requests.filter(path => path.startsWith('/data/results/seasons/')).length, 1);
  assert.equal(dom.requests.some(path => path.startsWith('/data/results/events/')), false);
  const events = resultData.events.filter(event => [left, right].includes(event.id));
  const model = dom.window.SSTS.resultsModel;
  const expected = [left, right].map(id => model.projectSummary(events.filter(event => event.id === id), ['women', 500]).best.rank);
  const cells = [...d.querySelector('.compare-project').querySelectorAll('td')];
  assert.deepEqual(cells.map(cell => Number(cell.querySelector('b').textContent.match(/\d+/)[0])), expected);
  d.querySelector('.project-toggle').click();
  await settled(dom, () => !d.querySelector('#project-detail-0').textContent.includes('正在读取'));
  assert.deepEqual(dom.requests.filter(path => path.startsWith('/data/results/events/')).sort(),
    [left, right].map(id => '/data/results/events/' + id + '.json').sort());
});

test('event comparison restores three cross-season objects and supports changing their season', async t => {
  const ids = ['2026-27-worldtour-vancouver-1', '2025-26-worldtour-montreal-1', '2024-25-worldtour-montreal-1'];
  const dom = await page('/results/compare/?mode=event&left=' + ids[0] + '&right=' + ids[1] + '&third=' + ids[2]);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelector('.compare-table').dataset.columns, '3');
  assert.deepEqual(['left', 'right', 'third'].map(name => d.querySelector('[name=' + name + ']').value), ids);
  const season = d.querySelector('[name=left_season]');
  season.value = '2023/24';
  season.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  await settled(dom, () => d.querySelector('[name=left]').value.startsWith('2023-24'));
  const url = new URL(dom.window.location.href);
  assert.ok(url.searchParams.get('left').startsWith('2023-24'));
  assert.equal(url.searchParams.has('kind'), false);
  const restored = await page(url.pathname + url.search);
  t.after(() => restored.window.close());
  assert.equal(restored.window.document.querySelector('[name=left]').value, url.searchParams.get('left'));
});

test('event detail links into comparison and duplicate event choices stay editable', async t => {
  const id = '2025-26-worldtour-montreal-1';
  const detail = await page('/results/events/' + id + '/');
  t.after(() => detail.window.close());
  assert.equal(detail.window.document.querySelector('.review-to-compare').getAttribute('href'),
    '/results/compare/?mode=event&left=' + id);
  const dom = await page('/results/compare/?mode=event&left=' + id + '&right=' + id);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.querySelector('.review-notice').textContent, /请选择不同/);
  assert.equal(d.querySelectorAll('.compare-project').length, 0);
  const right = d.querySelector('[name=right]');
  right.value = '2025-26-worldtour-montreal-2';
  right.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  await settled(dom, () => d.querySelectorAll('.compare-project').length === 9);
  assert.equal(d.querySelector('.review-notice'), null);
});

test('results pages do not depend on the live calendar', async t => {
  const dom = await page('/results/', '/data/calendar.json');
  t.after(() => dom.window.close());
  assert.ok(dom.window.document.querySelector('.results-recent-list'));
  assert.deepEqual(dom.requests, ['/data/results/index.json']);
});

test('comparison defaults follow recorded scopes and preserve explicit shared selections', async t => {
  const worlds = await page('/results/compare/');
  const circuit = await page('/results/compare/?kind=circuit');
  const explicit = await page('/results/compare/?left=2023%2F24&right=2026%2F27');
  for (const dom of [worlds, circuit, explicit]) t.after(() => dom.window.close());
  const selected = dom => ['left', 'right'].map(name => dom.window.document.querySelector(`[name="${name}"]`).value);
  assert.deepEqual(selected(worlds), ['2024/25', '2025/26']);
  assert.deepEqual(selected(circuit), ['2025/26', '2026/27']);
  assert.deepEqual(selected(explicit), ['2023/24', '2026/27']);
});

test('comparison defaults advance with new archived seasons instead of hardcoded years', async t => {
  const index = JSON.parse(await file('dist/data/results/index.json'));
  const archived = JSON.parse(await file('dist/data/results/seasons/2025-26.json'));
  const original = index.events.find(event => event.kind === 'worlds');
  const summary = archived.items.find(event => event.id === original.id).summary;
  index.current_season = '2032/33';
  index.cycles.push({id: 'future-cycle', label: '未来周期', seasons: ['2030/31', '2031/32', '2032/33']});
  index.events.unshift(...['2031/32', '2030/31'].map(season => ({...original, id: 'worlds-' + season, season, summary})));
  const dom = await page('/results/compare/?left=invalid', '', index);
  t.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelector('[name="left"]').value, '2030/31');
  assert.equal(dom.window.document.querySelector('[name="right"]').value, '2031/32');
});

test('current station and its archived result link to each other only when matched', async t => {
  const station = await page('/events/2026-27/vancouver/');
  const result = await page('/results/events/2026-27-worldtour-vancouver-1/');
  const unmatched = await page('/results/events/2025-26-worldtour-montreal-1/');
  for (const dom of [station, result, unmatched]) t.after(() => dom.window.close());
  assert.equal(station.window.document.querySelector('.station-hero a[href*="/results/events/"]').getAttribute('href'), '/results/events/2026-27-worldtour-vancouver-1/');
  assert.equal(result.window.document.querySelector('.review-to-schedule').getAttribute('href'), '/events/2026-27/vancouver/');
  assert.equal(unmatched.window.document.querySelector('.review-to-schedule').hidden, true);
  assert.equal(unmatched.window.document.querySelector('.review-to-previous').hidden, true);
});

test('previous station comparison stays in the same season and sources are grouped', async t => {
  const dom = await page('/results/events/2025-26-worldtour-montreal-2/');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const link = new URL(d.querySelector('.review-to-previous').href);
  assert.equal(link.searchParams.get('left'), '2025-26-worldtour-montreal-1');
  assert.equal(link.searchParams.get('right'), '2025-26-worldtour-montreal-2');
  assert.equal(d.querySelectorAll('.result-row a[target="_blank"]').length, 0);
  assert.ok(d.querySelector('.result-event .result-sources'));
  const compare = await page(link.pathname + link.search);
  t.after(() => compare.window.close());
  const row = compare.window.document.querySelector('.compare-project');
  row.querySelector('button').click();
  await settled(compare, () => row.nextElementSibling.querySelector('.raw-source-group'));
  assert.equal(row.nextElementSibling.querySelectorAll('.review-records li > a[target]').length, 0);
  assert.ok(row.nextElementSibling.querySelector('.raw-source-group a[target]'));
});

