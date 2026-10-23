import copy
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import competition_data
import sync_predictions as source

CONFIG = {
    'city': 'Vancouver', 'year': 2026,
    'prediction': {'event_id': 16230, 'historical_season': '2025/2026',
                   'standings_season_id': 1, 'entries_url':
                   'https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=entries_16230'}
}


def entrants(count):
    return [dict(athlete_id=f'a-{n}', official_skater_id=n,
                 name=f'TEST {n}', country='USA' if n > 26 else 'CHN')
            for n in range(1, count + 1)]


def event_page(events):
    frame = [1, '1:["$",null,{"eventResults":' + json.dumps(events) + '}]']
    return ('<h1>Vancouver 2026</h1><script>self.__next_f.push(' +
            json.dumps(frame) + ')</script>').encode()


class PredictionSourceTests(unittest.TestCase):
    def test_published_entries_replace_retained_drafts_without_id_or_order_assumptions(self):
        drafts = [dict(name=g.title() + f' {d} m', gender=g.title(),
                       discipline_distance=str(d), discipline_type='Singles',
                       event_id=16230, discipline_id=3, event_result_id=900 + n,
                       display_order=None)
                  for n, (g, d) in enumerate(sorted(source.DISTANCES))]
        published = [dict(row, event_result_id=100 + n, display_order=n + 1)
                     for n, row in enumerate(drafts)]
        for rows in (drafts + published, list(reversed(published + drafts))):
            found = source.discover_events(event_page(rows), CONFIG)
            self.assertEqual({item['event_result_id'] for item in found.values()},
                             {item['event_result_id'] for item in published})
        # A second published candidate, two drafts, a reused ID, or a wrong
        # event must not be resolved by picking the biggest ID/last row.
        bad_sets = [
            drafts + [dict(drafts[0], event_result_id=8000)],
            published + [dict(published[0], event_result_id=8000)],
            published + [copy.deepcopy(published[0])],
            drafts + [dict(published[0], event_id=999)],
            drafts + [dict(published[0], display_order=True)],
        ]
        for rows in bad_sets:
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    source.discover_events(event_page(rows), CONFIG)

    def test_distance_events_are_distinct_from_roster(self):
        events = []
        for n, (gender, distance) in enumerate(sorted(source.DISTANCES), 1):
            events.append(dict(name=gender.title() + f' {distance} m',
                gender=gender.title(), discipline_distance=str(distance),
                discipline_type='Singles', event_id=16230,
                discipline_id=3, event_result_id=n))
        frame = [1, '1:["$",null,{"eventResults":' + json.dumps(events) + '}]']
        body = ('<h1>Vancouver 2026</h1><script>self.__next_f.push(' +
                json.dumps(frame) + ')</script>').encode()
        self.assertEqual(len(source.discover_events(body, CONFIG)), 6)
        invalid = copy.deepcopy(events)
        invalid[0]['event_id'] = 999
        frame[1] = '1:["$",null,{"eventResults":' + json.dumps(invalid) + '}]'
        body = ('<h1>Vancouver 2026</h1><script>self.__next_f.push(' +
                json.dumps(frame) + ')</script>').encode()
        with self.assertRaises(ValueError):
            source.discover_events(body, CONFIG)

    def test_only_exact_distance_rows_enter_and_duplicates_fail(self):
        event = dict(event_id=16230, event_result_id=75)
        row = dict(event_id=16230, event_result_id=75, skaters_id=3,
                   started_for_nf_code='CHN', skaters=dict(
                       id=3, full_name='Long SUN', gender='M'))
        body = json.dumps(dict(status=200, data=[row])).encode()
        person = source.parse_entries(body, event, ('men', 500), CONFIG)[0]
        self.assertEqual(person['athlete_id'],
                         competition_data.athlete_id('SUN Long', 'CHN', 'men'))
        with self.assertRaises(ValueError):
            source.parse_entries(json.dumps(dict(status=200, data=[row, row])).encode(),
                                 event, ('men', 500), CONFIG)
        row['event_result_id'] = 76
        with self.assertRaises(ValueError):
            source.parse_entries(json.dumps(dict(status=200, data=[row])).encode(),
                                 event, ('men', 500), CONFIG)

    def test_rank_pagination_requires_all_pages_and_identity(self):
        meta = dict(world_standings_list_fsk_id=615, season_name='2025/2026',
                    gender='Women', discipline_distance='500', type='WRD',
                    level_name='Senior')
        calls = []
        def sender(url, payload):
            page = payload['page']
            calls.append(page)
            row = dict(world_standings_list_fsk_id=615, skaters_id=page,
                       skaters=dict(id=page), rank=page, points=100 - page,
                       nf_for_country_code='CHN')
            return json.dumps(dict(status=200, current_page=page, total_page=2,
                total_items=2, is_next_page='Y' if page == 1 else 'N',
                detail=meta, data=[row])).encode()
        rows = source.ranking_rows(meta, sender)
        self.assertEqual(calls, [1, 2])
        self.assertEqual(rows[2]['rank'], 2)
        def bad(url, payload):
            obj = json.loads(sender(url, payload))
            obj['detail']['type'] = 'WCD'
            return json.dumps(obj).encode()
        with self.assertRaises(ValueError):
            source.ranking_rows(meta, bad)

    def test_historic_classification_and_world_ranking_have_distinct_jobs(self):
        people = entrants(41)
        world = {n: dict(rank=n, points=1000 - n) for n in range(1, 42)}
        tour = {n: dict(rank=42 - n, points=100 + n) for n in range(1, 42)}
        byes, error = source.select_byes(people, tour, world, 20)
        self.assertIsNone(error)
        self.assertEqual(byes, set(range(22, 42)))
        entered = source.observe(('women', 500), people, world, tour)
        self.assertEqual(entered['missing'], [])
        self.assertEqual(sum(p['prequalified'] for p in entered['participants']), 20)
        self.assertEqual([p['world_rank'] for p in entered['participants']], list(range(1, 42)))

    def test_byes_top_up_from_world_ranking_and_leave_ties_to_isu(self):
        people = entrants(41)
        world = {n: dict(rank=n, points=100 - n) for n in range(1, 40)}
        tour = {n: dict(rank=n, points=10) for n in range(30, 40)}
        byes, error = source.select_byes(people, tour, world, 20)
        self.assertIsNone(error)
        self.assertEqual(byes, set(range(30, 40)) | set(range(1, 11)))
        tour[31]['rank'] = 30
        self.assertEqual(source.select_byes(people, tour, world, 1), (set(), 'prequalification_tie'))
        self.assertEqual(source.select_byes(entrants(15), {}, world, 20), (set(), 'prequalification_list'))
        self.assertEqual(source.select_byes(people, tour, world, 0), (set(), None))

    def test_unranked_entrants_follow_ranked_ones_without_a_seed(self):
        people = entrants(5)
        entered = source.observe(('women', 500), list(reversed(people)), {4: dict(rank=7, points=5), 2: dict(rank=9, points=1)}, {})
        self.assertEqual([p['official_skater_id'] for p in entered['participants']], [4, 2, 1, 3, 5])
        self.assertEqual([p['world_rank'] for p in entered['participants']], [7, 9, None, None, None])

    def test_sync_failure_preserves_known_data(self):
        old = dict(schema_version=2, event_id='vancouver', lists=[dict(gender='women', distance_m=500,
                   participants=[dict(name='TEST')])])
        with tempfile.TemporaryDirectory() as tmp, patch.object(source, 'predictions_settled', return_value=False):
            file = Path(tmp) / 'vancouver.json'
            file.write_text(json.dumps(old))
            obj, errors = source.sync_event('vancouver', CONFIG, directory=Path(tmp),
                get=lambda url: (_ for _ in ()).throw(TimeoutError('official timeout')))
            self.assertTrue(errors)
            self.assertEqual(obj['lists'], old['lists'])
            self.assertEqual(obj['update_status'], 'error')
            self.assertEqual(json.loads(file.read_text())['update_status'], 'error')

if __name__ == '__main__':
    unittest.main()
