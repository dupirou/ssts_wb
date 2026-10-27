"""Historical rankings stay distinct from heat positions, rosters and complete cycles."""

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import history_data


class HistoryTests(unittest.TestCase):
    def test_classification_uses_final_rank_and_explicit_final_columns(self):
        pages = (ROOT / 'tests/fixtures/worlds-2026-classifications.txt').read_text().split('\f')
        rows = history_data.parse_classifications(pages)
        self.assertEqual(len(rows), 16)
        yang = next(r for r in rows if r['name'] == 'YANG Jingru' and r['distance_m'] == 1500)
        self.assertEqual((yang['rank'], yang['final_group']), (9, 'B'))
        gong = next(r for r in rows if r['name'] == 'GONG Li' and r['distance_m'] == 1500)
        self.assertEqual((gong['rank'], gong['final_group'], gong['status']), (21, None, 'PEN'))
        relay = next(r for r in rows if r['format'] == 'relay' and r['gender'] == 'women')
        self.assertEqual(relay['rank'], 3)
        self.assertEqual(len(relay['members']), 5)
        final_names = {m['name'] for m in relay['members'] if 'FA' in m['rounds']}
        self.assertEqual(final_names, {'GONG Li', 'ZHANG Chutong', 'WANG Ye', 'WANG Xinran'})

    def test_heat_or_world_tour_standings_are_not_final_classifications(self):
        with self.assertRaisesRegex(ValueError, 'nine senior disciplines'):
            history_data.parse_classifications(['WORLD TOUR CLASSIFICATION\nMen 500 m\n1 LI Kun CHN'])

    def test_relay_counts_once_and_uncollected_events_have_no_results(self):
        archive = history_data.load()
        self.assertEqual(sum(len(e['results']) for e in archive['events']), 79)
        self.assertEqual(len(archive['events']), 4)
        self.assertEqual(len(archive['pending']), 3)
        worlds = next(e for e in archive['events'] if e['id'] == '2025-26-worlds-montreal')
        self.assertEqual(worlds['medals'], {'1': 0, '2': 1, '3': 1})
        self.assertTrue(all('results' not in e for e in archive['pending']))
        self.assertFalse(any(e['season'] in archive['cycles'][1]['seasons'] for e in archive['events']))

    def test_source_and_identity_mismatches_reject_the_event(self):
        catalog = json.loads((history_data.DIRECTORY / 'catalog.json').read_text())
        meta = next(e for e in catalog['events'] if e['coverage'] == 'complete')
        event = json.loads((history_data.DIRECTORY / 'events' / (meta['id'] + '.json')).read_text())
        registry = json.loads((history_data.DIRECTORY / 'athletes.json').read_text())
        broken = copy.deepcopy(event)
        broken['results'][0]['athlete_id'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'Unknown historical athlete'):
            history_data.validate_event(broken, meta, registry)
        broken = copy.deepcopy(event)
        broken['source']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'does not match catalog'):
            history_data.validate_event(broken, meta, registry)

    def test_aliases_preserve_one_identity_across_name_order_and_seasons(self):
        registry = json.loads((history_data.DIRECTORY / 'athletes.json').read_text())
        records = [dict(format='individual', gender='men', name=name) for name in ['LIU Shaoang', 'Shaoang LIU']]
        history_data.attach_identities(records, registry)
        self.assertEqual(records[0]['athlete_id'], records[1]['athlete_id'])
        with self.assertRaisesRegex(ValueError, 'Unregistered athlete'):
            history_data.attach_identities([dict(format='individual', gender='men', name='Unknown Skater')], registry)


if __name__ == '__main__':
    unittest.main()
