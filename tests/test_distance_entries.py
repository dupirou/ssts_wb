import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import competition_data
import sync_distance_entries as source

CONFIG = {
    'city': 'Vancouver',
    'year': 2026,
    'event_id': 16230,
    'entries_url': 'https://isu-skating.com/en/short-track/events/eventdetail/'
    'isu-short-track-world-tour-1/?tab=entries_16230',
}


def event_page(events):
    frame = [1, '1:["$",null,{"eventResults":' + json.dumps(events) + '}]']
    return ('<h1>Vancouver 2026</h1><script>self.__next_f.push(' + json.dumps(frame) + ')</script>').encode()


def distance_rows(event_id=16230):
    rows = []
    for n, (gender, distance) in enumerate(sorted(source.DISTANCES), 1):
        rows.append(
            dict(
                name=gender.title() + f' {distance} m',
                gender=gender.title(),
                discipline_distance=str(distance),
                discipline_type='Singles',
                event_id=event_id,
                discipline_id=3,
                event_result_id=n,
            )
        )
    return rows


def entry_row(gender, result_id, skater_id=1, name='Kun LI'):
    return dict(
        event_id=16230,
        event_result_id=result_id,
        skaters_id=skater_id,
        started_for_nf_code='CHN',
        skaters=dict(id=skater_id, full_name=name, gender='F' if gender == 'women' else 'M'),
    )


class EntrySourceTests(unittest.TestCase):
    def test_published_entries_replace_retained_drafts_without_id_or_order_assumptions(self):
        drafts = [dict(row, display_order=None) for row in distance_rows()]
        published = [dict(row, display_order=n) for n, row in enumerate(drafts, 1)]
        published = [dict(row, event_result_id=100 + n) for n, row in enumerate(published)]
        for rows in (drafts + published, list(reversed(published + drafts))):
            found = source.discover_events(event_page(rows), CONFIG)
            self.assertEqual(
                {item['event_result_id'] for item in found.values()}, {item['event_result_id'] for item in published}
            )
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

    def test_six_distance_events_are_required_and_checked_against_the_station(self):
        events = distance_rows()
        self.assertEqual(len(source.discover_events(event_page(events), CONFIG)), 6)
        invalid = copy.deepcopy(events)
        invalid[0]['event_id'] = 999
        with self.assertRaises(ValueError):
            source.discover_events(event_page(invalid), CONFIG)
        renamed = copy.deepcopy(events)
        renamed[0]['name'] = 'Men 3000 m'
        with self.assertRaises(ValueError):
            source.discover_events(event_page(renamed), CONFIG)

    def test_only_exact_distance_rows_enter_and_duplicates_fail(self):
        event = dict(event_id=16230, event_result_id=75)
        row = entry_row('men', 75, name='Long SUN')
        body = json.dumps(dict(status=200, data=[row])).encode()
        person = source.parse_entries(body, event, ('men', 500), CONFIG)[0]
        self.assertEqual(person['athlete_id'], competition_data.athlete_id('SUN Long', 'CHN', 'men'))
        with self.assertRaises(ValueError):
            source.parse_entries(json.dumps(dict(status=200, data=[row, row])).encode(), event, ('men', 500), CONFIG)
        row['event_result_id'] = 76
        with self.assertRaises(ValueError):
            source.parse_entries(json.dumps(dict(status=200, data=[row])).encode(), event, ('men', 500), CONFIG)

    def test_numbered_neutral_team_keeps_its_official_code(self):
        row = entry_row('men', 75, 491, 'Vladimir BALBEKOV')
        row['started_for_nf_code'] = 'AIN2'
        body = json.dumps(dict(status=200, data=[row])).encode()
        (person,) = source.parse_entries(body, {'event_result_id': 75}, ('men', 500), CONFIG)
        self.assertEqual(person['country'], 'AIN2')
        self.assertEqual(person['athlete_id'], competition_data.athlete_id('BALBEKOV Vladimir', 'AIN2', 'men'))

    def test_sync_failure_preserves_known_data(self):
        old = dict(
            schema_version=1,
            event_id='vancouver',
            lists=[dict(gender='women', distance_m=500, participants=[dict(name='TEST')])],
        )
        with tempfile.TemporaryDirectory() as tmp, patch.object(source, 'entries_settled', return_value=False):
            file = Path(tmp) / 'vancouver.json'
            file.write_text(json.dumps(old), encoding='utf-8')
            obj, errors = source.sync_event(
                'vancouver',
                CONFIG,
                directory=Path(tmp),
                get=lambda url: (_ for _ in ()).throw(TimeoutError('official timeout')),
            )
            self.assertTrue(errors)
            self.assertEqual(obj['lists'], old['lists'])
            self.assertEqual(obj['update_status'], 'error')
            self.assertEqual(json.loads(file.read_text(encoding='utf-8'))['update_status'], 'error')

    def test_synced_lists_publish_each_entrants_distances(self):
        page = event_page(distance_rows())
        bodies = {}
        for result_id, gender in zip(range(1, 7), ['men', 'men', 'men', 'women', 'women', 'women'], strict=True):
            bodies[result_id] = json.dumps(dict(status=200, data=[entry_row(gender, result_id)])).encode()
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(source, 'entries_settled', return_value=False):
                result, errors = source.sync_event(
                    'vancouver',
                    CONFIG,
                    directory=directory,
                    get=lambda url: page,
                    form=lambda url, payload: bodies[payload['event_result_id']],
                )
            self.assertEqual(errors, [])
            self.assertEqual(len(result['lists']), 6)
            distances = competition_data.entered_distances('vancouver', directory=directory)
            # Same spelling but a different gender is a different athlete identity.
            self.assertEqual(len(distances), 2)
            self.assertEqual(sorted(distances.values()), [[500, 1000, 1500], [500, 1000, 1500]])
            self.assertEqual(len(competition_data.distance_entrants('vancouver', directory=directory)), 6)

    def test_entries_settled_needs_every_distance_to_have_official_groups(self):
        snapshot = competition_data.empty_snapshot('vancouver')
        snapshot['rounds']['items'] = [
            dict(
                gender=gender,
                distance_m=distance,
                evidence='official_start_list',
                format='individual',
            )
            for gender, distance in sorted(source.DISTANCES)
        ]
        with patch.object(competition_data, 'load_snapshot', return_value=snapshot):
            self.assertTrue(source.entries_settled('vancouver'))
        with patch.object(competition_data, 'load_snapshot', return_value=competition_data.empty_snapshot('vancouver')):
            self.assertFalse(source.entries_settled('vancouver'))


if __name__ == '__main__':
    unittest.main()
