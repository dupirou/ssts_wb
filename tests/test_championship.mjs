import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [html, script, cal] = await Promise.all([
  file('web/index.html'), Promise.all(['ui', 'navigation', 'results-model', 'results-store', 'results-compare', 'results', 'portal', 'app'].map(name => file('web/' + name + '.js'))).then(parts => parts.join('\n')), file('dist/data/calendar.json').then(JSON.parse),
]);
async function page(path) {
  const dom = new JSDOM(html, {url: new URL(path, 'https://example.test/').href,
    runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.fetch = async input => {
    const pathname = new URL(input, w.location.href).pathname;
    dom.requests.push(pathname);
    if (pathname === '/data/calendar.json') return Response.json(cal);
    if (pathname === '/data/updates.json') return Response.json({schema_version: 1, events: []});
    return new Response(await file('dist' + pathname));
  };
  dom.requests = [];
  w.eval(script);
  const selector = path.includes('worlds-2027') ? '.station-hero' : '.championship-card';
  for (let i=0; i<150; i++) {
    if (w.document.querySelector(selector)) return dom;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  dom.window.close();
  throw new Error('Championship UI not rendered');
}
test('events page keeps seven World Tour cards and offers a distinct World Championships page', async t => {
  const dom = await page('events/?now=2026-10-21T09:00:00Z');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelectorAll('.st-card').length, 7);
  const world = d.querySelector('.championship-card');
  assert.ok(world);
  assert.match(world.textContent, /短道速滑世锦赛/);
  assert.match(world.textContent, /03\.12 — 03\.14/);
  assert.match(world.textContent, /首尔/);
  assert.equal(world.querySelector('.btn').getAttribute('href'), '/events/2026-27/worlds-2027/');
  // Separators use a no-break space so they stay at line ends; compare words, not space kinds.
  assert.match(d.querySelector('.season-head .lead').textContent.replace(/\s+/g, ' '), /7 站世巡赛 · 1 场世锦赛/);
  assert.equal(d.querySelectorAll('.ticket-panel').length, 1);
});
test('Worlds detail uses schedule and roster waiting states without World Tour forecasts or API calls', async t => {
  const dom = await page('/events/2026-27/worlds-2027/');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.title, /世锦赛/);
  assert.match(d.querySelector('.hero-copy h1').textContent, /短道速滑世锦赛/);
  assert.match(d.querySelector('.hero-copy').textContent, /03\.12.*03\.14/);
  assert.match(d.querySelector('.hero-copy').textContent, /首尔/);
  // No entries exist yet, so no empty athletes tab: the page is one panel.
  assert.equal(d.querySelector('.section-tabs'), null);
  assert.equal(d.querySelector('#section-athletes'), null);
  assert.equal(d.querySelectorAll('.prediction-panel, .prediction-grid').length, 0);
  assert.match(d.querySelector('#section-schedule').textContent, /逐项赛程待公布/);
  assert.equal(d.querySelectorAll('.st-nav-list a').length, 8);
  assert.equal(d.querySelector('.championship-nav').getAttribute('aria-current'), 'page');
  assert.ok([...d.querySelectorAll('#section-schedule a')].some(a => a.href.includes('isu-skating.com')));
  assert.match(d.querySelector('#section-schedule').textContent, /报名名单/);
  assert.deepEqual(dom.requests.filter(p => p.startsWith('/api/')), []);
  assert.equal(dom.requests.filter(p => p.startsWith('/data/')).length, 2);
});
