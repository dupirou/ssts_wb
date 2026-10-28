import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('official cumulative penalties render seven checkpoint cells and preserve restrictions', async () => {
  const dom = new JSDOM('<!doctype html><main id="root"></main>', {
    url: 'https://example.test/athletes/',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.eval(readFileSync('web/ui.js', 'utf8'));
  window.eval(readFileSync('web/portal.js', 'utf8'));

  const athlete = (name, country = 'CHN') => ({
    name,
    country,
    gender: 'women',
    season_rankings: []
  });
  const penalty = (name, total, blocked = 0) => ({
    name,
    country: 'CHN',
    total,
    details: [{ event_id: 'vancouver', distance_m: 500, round_label: 'Heats', infringement_code: 'C1', counted: true }],
    next_restriction: { event_id: blocked ? 'montreal' : null, blocked_individual_distances: blocked, distances_m: blocked ? [1000] : [] }
  });
  const index = {
    completed_events: 1,
    source_url: 'https://example.test/protocol.pdf',
    items: [penalty('First', 2), penalty('Second', 3, 1), penalty('Third', 8)]
  };

  await window.SSTS.portal.athletes(
    {
      h: window.SSTS.ui.h,
      root: window.document.querySelector('#root'),
      fetchData: async (path) =>
        path === 'athletes.json'
          ? { items: [athlete('First'), athlete('Second'), athlete('Third')] }
          : index
    },
    { season: '2026/27', stations: [{ id: 'vancouver', city: '温哥华' }] }
  );

  const panel = window.document.querySelector('.penalty-panel');
  assert.ok(panel);
  assert.equal(panel.open, false);

  const rows = [...panel.querySelectorAll('.penalty-person')];
  assert.equal(rows.length, 3);
  for (const [i, total] of [8, 3, 2].entries()) {
    const bar = rows[i].querySelector('[role="progressbar"]');
    assert.equal(bar.getAttribute('aria-valuemin'), '0');
    assert.equal(bar.getAttribute('aria-valuemax'), '7');
    assert.equal(bar.getAttribute('aria-valuenow'), String(Math.min(7, total)));
    assert.equal(bar.getAttribute('aria-valuetext'), total + ' 次有效判罚');
    assert.equal(bar.querySelectorAll('.penalty-segment').length, 7);
    assert.equal(bar.querySelectorAll('.penalty-segment.is-filled').length, Math.min(7, total));
    assert.deepEqual(
      [...rows[i].querySelectorAll('.penalty-threshold')].map((el) => el.textContent),
      ['3', '5', '7']
    );
  }

  assert.equal(rows[0].querySelector('.penalty-restriction'), null);
  assert.match(rows[1].querySelector('.penalty-restriction').textContent, /下站禁报 1000m/);
  assert.equal(rows[2].querySelector('.penalty-restriction'), null);
  assert.match(rows[0].querySelector('.penalty-details').textContent, /温哥华.*500m Heats.*C1/s);
  dom.window.close();
});
