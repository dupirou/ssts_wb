import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [html, script, calendar] = await Promise.all([
  file('web/index.html'), Promise.all(['ui', 'navigation', 'results-model', 'results-store', 'results-compare', 'results', 'portal', 'app'].map(name => file('web/' + name + '.js'))).then(parts => parts.join('\n')), file('dist/data/calendar.json').then(JSON.parse),
]);
async function render(url) {
  const dom = new JSDOM(html, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.fetch = async input => {
    const pathname = new URL(input, w.location.href).pathname;
    if (pathname === '/data/calendar.json') return Response.json(calendar);
    if (pathname === '/data/updates.json') return Response.json({schema_version: 1, events: []});
    return new Response(await file('dist' + pathname));
  };
  w.eval(script);
  for (let i=0; i<100; i++) {
    if (w.document.querySelector('.ticket-panel')) return dom;
    await new Promise(r => setTimeout(r, 5));
  }
  dom.window.close();
  throw new Error('Ticket section did not render');
}
test('Seoul ticket links appear on season home and station details', async t => {
  for (const route of ['/events/?now=2026-10-21T09:00:00Z', '/?station=seoul&now=2026-10-21T09:00:00Z']) {
    await t.test(route, async t => {
      const dom = await render('https://example.test' + route);
      t.after(() => dom.window.close());
      const d = dom.window.document;
      const panel = d.querySelector('.ticket-panel');
      assert.match(panel.textContent, /首尔站/);
      assert.match(panel.textContent, /北京时间 10\/23 周五 下午 13:00 开售/);
      assert.match(panel.textContent, /首尔时间 14:00/);
      const links = [...panel.querySelectorAll('.ticket-actions a')];
      assert.equal(links.length, 2);
      assert.deepEqual(links.map(a => a.getAttribute('href')), [
        'https://isu-skating.com/zh-CN/short-track/news/short-track-world-tour-seoul-2026-tickets/',
        'https://m.ticketlink.co.kr/global/zh/product/66349?null',
      ]);
      assert.ok(links.every(a => a.target === '_blank' && a.rel.includes('noopener')));
      assert.equal(d.querySelectorAll('.ticket-panel').length, 1);
      if (route.includes('station=')) {
        assert.ok(d.querySelector('.section-tabs'), 'ticket notice must not remove station tabs');
        assert.ok(d.querySelector('.empty-state'), 'unpublished schedule stays unpublished');
      } else assert.equal(d.querySelectorAll('.st-card').length, 7);
    });
  }
});

test('ticket notice says on sale after opening and disappears once Seoul is over', async t => {
  await t.test('on sale', async t => {
    const dom = await render('https://example.test/?station=seoul&now=2026-10-23T06:00:00Z');
    t.after(() => dom.window.close());
    const panel = dom.window.document.querySelector('.ticket-panel');
    assert.match(panel.querySelector('h2').textContent, /门票已开售/);
    assert.match(panel.textContent, /已于北京时间 10\/23 周五 下午 13:00 开售/);
  });
  await t.test('after the stage', async t => {
    const dom = new JSDOM(html, {url: 'https://example.test/events/?now=2026-11-23T00:00:00Z', runScripts: 'outside-only', pretendToBeVisual: true});
    t.after(() => dom.window.close());
    const w = dom.window;
    w.matchMedia = () => ({matches: false, addEventListener() {}});
    w.fetch = async input => {
      const pathname = new URL(input, w.location.href).pathname;
      if (pathname === '/data/calendar.json') return Response.json(calendar);
      if (pathname === '/data/updates.json') return Response.json({schema_version: 1, events: []});
      return new Response(await file('dist' + pathname));
    };
    w.eval(script);
    for (let i = 0; i < 100 && !w.document.querySelector('.st-card'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(w.document.querySelectorAll('.st-card').length, 7);
    assert.equal(w.document.querySelector('.ticket-panel'), null);
  });
});
