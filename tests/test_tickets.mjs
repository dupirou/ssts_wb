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
  w.HTMLDialogElement.prototype.showModal = function () {this.setAttribute('open', '');};
  w.HTMLDialogElement.prototype.close = function () {this.removeAttribute('open');};
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
test('home shows Shanghai ticketing and omits Seoul ticketing', async t => {
  const dom = await render('https://example.test/?now=2026-11-19T09:00:00Z');
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.equal(d.querySelector('.ticket-panel[aria-label="首尔站售票"]'), null);
  assert.ok(d.querySelector('.ticket-panel[aria-label="上海站售票"]'));
});
