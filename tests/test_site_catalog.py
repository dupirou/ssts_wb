"""The site indexes stay small, derived, and distinct from career statistics."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import site_catalog


class SiteCatalogTests(unittest.TestCase):
    def test_directory_deduplicates_rosters_and_home_uses_only_official_medal_finals(self):
        calendar = dict(season='2026/27', stations=[dict(id='one', city='甲'), dict(id='two', city='乙')])
        person = dict(athlete_id='a-1', name='Kun LI', country='CHN', gender='men')
        heat = dict(
            round='final',
            group='A',
            evidence='official_results',
            result_status='Official',
            round_key='final-a',
            participants=[dict(person, rank=1, penalty=None)],
        )
        row = dict(
            id='row-a',
            gender='men',
            distance_m=500,
            format='individual',
            local_date='2026-10-23',
            utc_start='2026-10-23T16:00:00Z',
            round_key='final-a',
        )
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            directory = out / 'data/competitions'
            directory.mkdir(parents=True)
            snapshot = dict(
                entries=dict(items=[person]),
                rounds=dict(items=[heat, dict(heat, group='B'), dict(heat, result_status='Unofficial')]),
            )
            for event in calendar['stations']:
                (directory / (event['id'] + '.json')).write_text(json.dumps(snapshot))
            original = (directory / 'one.json').read_bytes()
            site_catalog.export(out, calendar, {'one': [row]})
            people = json.loads((out / 'data/athletes.json').read_text())['items']
            self.assertEqual(len(people), 1)
            self.assertEqual([e['event_id'] for e in people[0]['events']], ['one', 'two'])
            self.assertNotIn('medals', people[0])
            finals = json.loads((out / 'data/portal.json').read_text())['finals']
            self.assertEqual(len(finals), 1)
            self.assertEqual(finals[0]['podium'][0]['name'], 'Kun LI')
            self.assertEqual(finals[0]['schedule_id'], 'row-a')
            self.assertEqual((directory / 'one.json').read_bytes(), original)

    def test_all_generated_deep_pages_use_root_assets_and_include_global_navigation(self):
        for route in ('events', 'history', 'athletes', 'events/2026-27/vancouver', 'events/2026-27/worlds-2027'):
            with self.subTest(route=route):
                page = (ROOT / 'dist' / route / 'index.html').read_text()
                self.assertIn('id="site-nav"', page)
                for asset in ('site.css', 'navigation.js', 'portal.js', 'app.js'):
                    self.assertRegex(page, '(?:href|src)="/' + asset + '"')
                    self.assertTrue((ROOT / 'dist' / asset).is_file())
                self.assertNotIn('{{SEASON}}', page)


if __name__ == '__main__':
    unittest.main()
