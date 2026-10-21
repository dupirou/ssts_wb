import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const file = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [html, script, calendar] = await Promise.all([
  file('web/index.html'), file('web/app.js'), file('dist/data/calendar.json').then(JSON.parse),
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
  for (const route of ['/', '/?station=seoul']) {
    await t.test(route, async t => {
      const dom = await render('https://example.test' + route);
      t.after(() => dom.window.close());
      const d = dom.window.document;
      const panel = d.querySelector('.ticket-panel');
      assert.match(panel.textContent, /首尔站/);
      assert.match(panel.textContent, /10\/23 13:00 北京时间开售/);
      assert.match(panel.textContent, /韩国时间 14:00/);
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
