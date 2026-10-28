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
    def test_directory_deduplicates_rosters_and_results_use_only_official_medal_finals(self):
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

    def test_season_ranks_use_latest_world_tour_table_per_distance(self):
        calendar = dict(
            season='2026/27',
            stations=[
                dict(id='new', city='乙', date_end='2026-11-01'),
                dict(id='old', city='甲', date_end='2026-10-25'),
            ],
        )
        people = [dict(athlete_id=aid, name=aid, country='CHN', gender='men') for aid in ['a', 'b']]

        def ranking(aid, distance, rank, kind='world_tour', format='individual'):
            return dict(athlete_id=aid, gender='men', distance_m=distance, rank=rank, ranking_type=kind, format=format)

        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            directory = out / 'data/competitions'
            directory.mkdir(parents=True)
            for event, ranks in {
                'old': [ranking('a', 500, 1), ranking('b', 500, 2), ranking('a', 1000, 4)],
                'new': [
                    ranking('a', 500, 3),
                    ranking('a', 1000, 1, 'event'),
                    ranking('a', 1500, 1, 'world'),
                    ranking('a', 5000, 1, format='relay'),
                    ranking('b', 500, None),
                ],
            }.items():
                snapshot = dict(entries=dict(items=people), rounds=dict(items=[]), rankings=dict(items=ranks))
                (directory / (event + '.json')).write_text(json.dumps(snapshot))
            site_catalog.export(out, calendar, {})
            index = json.loads((out / 'data/athletes.json').read_text())
            by_id = {p['id']: p for p in index['items']}
            self.assertEqual(
                by_id['a']['season_rankings'], [dict(distance_m=500, rank=3), dict(distance_m=1000, rank=4)]
            )
            self.assertNotIn('season_rankings', by_id['b'])
            self.assertEqual({r['event_id'] for r in index['ranking_as_of']}, {'old', 'new'})

    def test_all_generated_deep_pages_use_root_assets_and_include_global_navigation(self):
        for route in (
            'events',
            'results',
            'history',
            'athletes',
            'events/2026-27/vancouver',
            'events/2026-27/worlds-2027',
        ):
            with self.subTest(route=route):
                page = (ROOT / 'dist' / route / 'index.html').read_text()
                self.assertIn('id="site-nav"', page)
                for asset in ('site.css', 'navigation.js', 'portal.js', 'app.js'):
                    self.assertRegex(page, '(?:href|src)="/' + asset + '"')
                    self.assertTrue((ROOT / 'dist' / asset).is_file())
                self.assertNotIn('{{SEASON}}', page)


if __name__ == '__main__':
    unittest.main()
