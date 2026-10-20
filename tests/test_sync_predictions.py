import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import competition_data
import predict_groups
import sync_predictions as source

CONFIG = {
    'city': 'Vancouver', 'year': 2026,
    'prediction': {'event_id': 16230, 'historical_season': '2025/2026',
                   'standings_season_id': 1, 'entries_url':
                   'https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=entries_16230'}
}


def entrants(count):
    return [dict(athlete_id=f'a-{n}', official_skater_id=n,
                 name=f'TEST {n}', country=f'A{n // 26:02d}' if n > 26 else 'CHN')
            for n in range(1, count + 1)]


class PredictionSourceTests(unittest.TestCase):
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
        first = source.make_observation(('women', 500), people, world, tour,
            None, '2026-10-20T10:00:00+00:00', build.read_schedule())
        self.assertIn('awaiting_complete_entries', first['missing'])
        self.assertTrue(all(p['prequalified'] is None for p in first['participants']))
        second = source.make_observation(('women', 500), people, world, tour,
            first, '2026-10-20T10:30:00+00:00', build.read_schedule())
        self.assertTrue(second['complete'], second['missing'])
        self.assertEqual(sum(p['prequalified'] for p in second['participants']), 20)
        result = predict_groups.project('vancouver', build.read_schedule(),
            competition_data.empty_snapshot('vancouver'),
            dict(schema_version=1, event_id='vancouver',
                 seed_lists=[dict(second, source_urls=[
                     'https://isu-skating.com/en/short-track/world-standings/615/'])]))
        self.assertEqual(result['items'][0]['status'], 'predicted')
        self.assertEqual(len(result['items'][0]['prequalified']), 20)
        self.assertEqual(sum(len(x['participants']) for x in result['items'][0]['groups']), 21)

    def test_tied_bye_and_unranked_draw_do_not_produce_groups(self):
        people = entrants(41)
        world = {n: dict(rank=n, points=100 - n) for n in range(1, 40)}
        tour = {n: dict(rank=n, points=100 - n) for n in range(1, 42)}
        tour[21]['rank'] = 20
        self.assertEqual(source.select_byes(people, tour, world, 20)[1], 'prequalification_tie')
        tour[21]['rank'] = 21
        obs = source.make_observation(('women', 500), people, world, tour,
            None, '2026-10-20T10:00:00+00:00', build.read_schedule(),
            feed_consistent=False)
        self.assertIn('unranked_draw', obs['missing'])
        self.assertIn('awaiting_complete_entries', obs['missing'])
        self.assertFalse(obs['complete'])

    def test_sync_failure_preserves_known_data(self):
        old = dict(schema_version=1, event_id='vancouver', seed_lists=[],
                   observed_lists=[dict(gender='women', distance_m=500,
                       participants=[dict(name='TEST')])])
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'vancouver.json'
            file.write_text(json.dumps(old))
            obj, errors = source.sync_event('vancouver', CONFIG, directory=Path(tmp),
                get=lambda url: (_ for _ in ()).throw(TimeoutError('official timeout')))
            self.assertTrue(errors)
            self.assertEqual(obj['observed_lists'], old['observed_lists'])
            self.assertEqual(obj['update_status'], 'error')


if __name__ == '__main__':
    unittest.main()
