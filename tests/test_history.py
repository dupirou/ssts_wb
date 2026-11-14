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
        self.assertGreaterEqual(sum(len(e['results']) for e in archive['events']), 142)
        self.assertGreaterEqual(len(archive['events']), 7)
        self.assertFalse(any(e['season'] == '2025/26' for e in archive['pending']))
        worlds = next(e for e in archive['events'] if e['id'] == '2025-26-worlds-montreal')
        self.assertEqual(worlds['medals'], {'1': 0, '2': 1, '3': 1})
        self.assertTrue(all('results' not in e for e in archive['pending']))
        self.assertTrue(all(r['country'] == 'CHN' for e in archive['events'] for r in e['results']))

    def test_montreal_final_results_share_overall_rank_conventions(self):
        archive = history_data.load()
        calendar = json.loads((ROOT / 'dist/data/calendar.json').read_text())
        index = history_data.result_catalog(ROOT / 'dist', calendar, archive)
        montreal = next(e for e in index['events'] if e['id'] == '2026-27-worldtour-montreal-2')
        results = montreal['results']
        singles = [r for r in results if r['format'] == 'individual']
        self.assertGreaterEqual(len(singles), 9)
        wang = next(r for r in singles if r['athlete_id'] == 'skater-ye-wang' and r['distance_m'] == 500)
        self.assertEqual((wang['rank'], wang['rank_scope'], wang['final_group']), (5, 'overall', 'A'))
        jianing = next(r for r in singles if r['athlete_id'] == 'isu-8090' and r['distance_m'] == 1000)
        self.assertEqual((jianing['rank'], jianing['rank_scope'], jianing['group_rank']), (6, 'overall', 1))
        relay = next(r for r in results if r['format'] == 'relay' and r['gender'] == 'women')
        self.assertEqual(
            (relay['rank'], relay['rank_scope'], relay['final_group'], relay['group_rank']),
            (5, 'overall', 'B', 1),
        )
        self.assertIn(relay.get('rank_basis'), (None, 'verified_final_groups'))
        self.assertEqual(len([r for r in results if r['gender'] == 'women' and r['distance_m'] == 3000]), 1)
        self.assertEqual(
            len({(r['gender'], r['distance_m'], r.get('athlete_id', 'team')) for r in results}),
            len(results),
        )
        self.assertTrue(all(r['source_url'].startswith('https://') for r in results))

    def test_published_classification_replaces_derived_final_rank_without_duplicates(self):
        import tempfile

        archive = history_data.load()
        calendar = json.loads((ROOT / 'dist/data/calendar.json').read_text())
        live = json.loads((ROOT / 'dist/data/competitions/montreal.json').read_text())
        live['rankings']['items'] = [
            dict(
                country='CHN',
                gender='women',
                distance_m=3000,
                format='relay',
                ranking_type='event',
                name='CHN',
                rank=5,
                official_details='',
                source_url='https://www.isu-skating.com/official-classification',
            ),
            dict(
                country='CHN',
                gender='women',
                distance_m=1000,
                format='individual',
                ranking_type='event',
                athlete_id=next(
                    p['athlete_id']
                    for h in live['rounds']['items']
                    for p in h['participants']
                    if p.get('name_latin', p['name']) == 'Jianing ZHANG' and h['distance_m'] == 1000
                ),
                name='Jianing ZHANG',
                rank=6,
                official_details='',
                source_url='https://www.isu-skating.com/official-classification',
            ),
        ]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'data/competitions'
            folder.mkdir(parents=True)
            (folder / 'montreal.json').write_text(json.dumps(live), encoding='utf-8')
            index = history_data.result_catalog(Path(directory), calendar, archive)
        records = next(e for e in index['events'] if e['id'] == '2026-27-worldtour-montreal-2')['results']
        relay = next(r for r in records if r['format'] == 'relay' and r['gender'] == 'women')
        single = next(r for r in records if r['name'] == 'Jianing ZHANG' and r['distance_m'] == 1000)
        self.assertEqual((relay['rank'], single['rank']), (5, 6))
        self.assertNotIn('rank_basis', relay)
        self.assertNotIn('rank_basis', single)
        self.assertEqual(relay['group_rank'], 1)
        self.assertEqual(single['group_rank'], 1)
        self.assertEqual(len([r for r in records if r['name'] == 'Jianing ZHANG' and r['distance_m'] == 1000]), 1)

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

    def test_unified_index_keeps_final_heat_positions_distinct_from_overall_ranks(self):
        archive = history_data.load()
        original = copy.deepcopy(archive)
        calendar = json.loads((ROOT / 'dist/data/calendar.json').read_text())
        index = history_data.result_catalog(ROOT / 'dist', calendar, archive)
        # Each World Tour station becomes a separate event when Chinese final
        # classifications arrive. The current season is not limited to Vancouver.
        archived_ids = {event['id'] for event in archive['events']}
        indexed_ids = [event['id'] for event in index['events']]
        self.assertTrue(archived_ids.issubset(indexed_ids))
        self.assertEqual(len(indexed_ids), len(set(indexed_ids)))
        current_events = [event for event in index['events'] if event['season'] == calendar['season']]
        self.assertGreaterEqual(len(current_events), 1)
        self.assertLessEqual(len(current_events), len(calendar['stations']))
        self.assertTrue(all(event['results'] for event in current_events))
        alps = next(c for c in index['cycles'] if '2026/27' in c['seasons'])
        self.assertEqual((alps['id'], alps['label']), ('cycle-2030', '阿尔卑斯周期'))
        self.assertEqual(archive, original)
        current = next(e for e in current_events if e['id'] == '2026-27-worldtour-vancouver-1')
        self.assertTrue(all(r['country'] == 'CHN' for e in index['events'] for r in e['results']))
        relay = next(r for r in current['results'] if r['gender'] == 'women' and r['format'] == 'relay')
        self.assertEqual((relay['rank'], relay['rank_scope'], relay['final_group']), (5, 'overall', 'B'))
        mixed = next(r for r in current['results'] if r['gender'] == 'mixed' and r['format'] == 'relay')
        self.assertEqual((mixed['rank'], mixed['rank_scope'], mixed['source_page']), (11, 'overall', 105))
        individual = next(r for r in current['results'] if r['format'] == 'individual')
        self.assertEqual(individual['rank_scope'], 'overall')
        # The ISU classification API may supply "Kun LI" while a PDF used
        # "LI Kun"; verify the stable athlete identity, not source name order.
        kun = next(r for r in current['results'] if r.get('athlete_id') == 'skater-kun-li')
        self.assertEqual(kun['gender'], 'men')


if __name__ == '__main__':
    unittest.main()
