"""Verify current-season ISU World Tour rankings are never confused with event ranks."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import sync_world_tour as world


class WorldTourTests(unittest.TestCase):
    def test_catalog_requires_exactly_six_current_lists(self):
        rows = [
            dict(gender=g.title(), discipline_distance=str(d),
                 type='WCD', season_name='2026/2027', season_id=47, discipline_id=3,
                 level_name='Senior', team_type='Singles', world_standings_list_fsk_id=i)
            for i, (g, d) in enumerate(sorted(world.DISTANCES), 100)
        ]

        def payload(items):
            return json.dumps(dict(
                status=200, current_page=1, total_page=1,
                total_items=len(items), data=items,
            )).encode()

        self.assertEqual(len(world.catalog(payload(rows), '2026/2027', 47)), 6)
        with self.assertRaisesRegex(ValueError, 'Six senior'):
            world.catalog(payload(rows[:-1]), '2026/2027', 47)
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            world.catalog(payload(rows + [rows[0]]), '2026/2027', 47)

    def test_official_ids_and_failed_sync_preserve_previous(self):
        metas = [
            dict(gender=g.title(), discipline_distance=str(d),
                 type='WCD', season_name='2026/2027', season_id=47, discipline_id=3,
                 level_name='Senior', team_type='Singles', world_standings_list_fsk_id=i)
            for i, (g, d) in enumerate(sorted(world.DISTANCES), 100)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / 'competitions'
            directory.mkdir()
            (directory / 'montreal.json').write_text(json.dumps(dict(rounds=dict(items=[
                dict(gender=g, format='individual', evidence='official_results',
                     participants=[dict(official_skater_id=sid, athlete_id=aid, country='CHN')])
                for g, sid, aid in [('men', 4, 'sun'), ('women', 8, 'wang')]
            ]))))
            def sender(url, form):
                if url.endswith('get-world-standings-list'):
                    return json.dumps(dict(status=200, current_page=1, total_page=1,
                                           total_items=6, data=metas)).encode()
                meta = next(row for row in metas if row['world_standings_list_fsk_id'] == form['world_standings_list_fsk_id'])
                return json.dumps(dict(
                    status=200, current_page=1, total_page=1, total_items=1, detail=meta,
                    data=[dict(skaters_id=4 if meta['gender'] == 'Men' else 8, rank=11, points=50)],
                )).encode()
            calendar = dict(season='2026/27', world_tour_standings_season_id=47,
                            stations=[dict(id='montreal')])
            target = root / 'current.json'
            result, changed = world.sync(calendar, sender, directory, target, '2026-11-02T02:00:00+00:00')
            self.assertTrue(changed)
            self.assertEqual(len(result['tables']), 6)
            self.assertEqual(result['tables'][3]['items'][0]['athlete_id'], 'wang')
            retained, changed = world.sync(calendar, lambda url, form: b'{}',
                                           directory, target, '2026-11-02T02:01:00+00:00')
            self.assertFalse(changed)
            self.assertEqual(retained, result)


if __name__ == '__main__':
    unittest.main()
