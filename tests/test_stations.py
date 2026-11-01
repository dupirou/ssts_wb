"""Every station follows the same path: find its ISU page, record its programme, keep it current."""

import csv
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import stations
import sync_schedule
import updates

MONTREAL = stations.get('montreal')
# Vancouver's three racing days, replayed on Montreal's dates (across a month end and the
# night Toronto leaves daylight saving time).
DAYS = {'2026-10-23': '30.10.2026', '2026-10-24': '31.10.2026', '2026-10-25': '01.11.2026'}
SESSIONS = {'Q': 'Qualifying', 'R': 'Repechage', 'F': 'Main'}
GENDERS = {'W': 'Women', 'M': 'Men', 'X': 'Mixed Team'}
ROUNDS = {'P': 'Preliminaries', 'H': 'Heats', 'Q': 'Quarter Finals', 'S': 'Semi Final', 'F': 'Final'}


def programme_page(header='Montreal / CAN', span='30.10-01.11, 2026', cut=None):
    with build.stations.schedule_path('vancouver').open(encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))[:cut]
    lines = ['ISU Short Track World Tour #2', header, span, 'Practice', '29.10.2026', '10:00 Official practice']
    day = session = None
    for r in rows:
        if r['date'] != day:
            day, session = r['date'], None
            lines.append(DAYS[day])
        if r['session'] != session:
            session = r['session']
            lines.append('Day - ' + SESSIONS[session] + ' Session')
        label = (
            GENDERS[r['gender']]
            + ' '
            + r['distance']
            + (' m Relay ' if r['kind'] == 'R' else ' meter ')
            + ROUNDS[r['round']]
        )
        if r['group'] == 'B':
            label += ' B'
        lines.append(r['time'] + ' ' + label)
    body = ''.join(f'<p>{line}</p>' for line in lines)
    return f'<html><body><a href="?tab=schedule_16272">Schedule</a>{body}</body></html>'


class ScheduleSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.before = datetime(2026, 10, 21, tzinfo=timezone.utc)

    def tearDown(self):
        self.temp.cleanup()

    def test_new_programme_is_recorded_then_only_rechecked(self):
        meta = {}
        page = programme_page()
        action, _ = sync_schedule.sync_station(MONTREAL, lambda url: page, self.before, self.dir, meta)
        self.assertEqual(action, 'created')
        self.assertEqual(meta['montreal']['source_url'], stations.page_url(MONTREAL, 'schedule'))
        rows = build.read_schedule('montreal', self.dir)
        self.assertEqual(len(rows), 61)
        self.assertEqual({r['local_date'] for r in rows}, {'2026-10-30', '2026-10-31', '2026-11-01'})
        # 09:00 is EDT (UTC-4) on Saturday and EST (UTC-5) after the clocks go back on Sunday.
        saturday = next(r for r in rows if r['local_date'] == '2026-10-31')
        sunday = next(r for r in rows if r['local_date'] == '2026-11-01')
        self.assertEqual(saturday['local_start'][-6:], '-04:00')
        self.assertEqual(sunday['local_start'][-6:], '-05:00')
        stamp = meta['montreal']['last_successful_schedule_check_utc']
        later = self.before.replace(hour=12)
        self.assertEqual(
            sync_schedule.sync_station(MONTREAL, lambda url: page, later, self.dir, meta), ('unchanged', [])
        )
        self.assertEqual(meta['montreal']['last_successful_schedule_check_utc'], stamp)

    def test_unpublished_partial_or_foreign_pages_are_refused(self):
        overview = '<p>Montreal / CAN</p><p>30.10-01.11, 2026</p><a href="?tab=overview_16272">Overview</a>'
        self.assertEqual(
            sync_schedule.sync_station(MONTREAL, lambda url: overview, self.before, self.dir, {}), ('not_published', [])
        )
        loading = overview + '<a href="?tab=schedule_16272">Schedule</a><p>loading_schedule</p>'
        with self.assertRaisesRegex(ValueError, 'no programme rows'):
            sync_schedule.sync_station(MONTREAL, lambda url: loading, self.before, self.dir, {})
        # During racing the tab only loads in the browser: a stored programme stands, unchanged.
        sync_schedule.write(
            sync_schedule.read(build.stations.schedule_path('vancouver')), stations.schedule_path('montreal', self.dir)
        )
        stored = stations.schedule_path('montreal', self.dir).read_text(encoding='utf-8')
        self.assertEqual(
            sync_schedule.sync_station(MONTREAL, lambda url: loading, self.before, self.dir, {}), ('live', [])
        )
        self.assertEqual(stations.schedule_path('montreal', self.dir).read_text(encoding='utf-8'), stored)
        stations.schedule_path('montreal', self.dir).unlink()
        with self.assertRaisesRegex(ValueError, 'Partial'):
            sync_schedule.sync_station(MONTREAL, lambda url: programme_page(cut=-30), self.before, self.dir, {})
        with self.assertRaisesRegex(ValueError, 'not labelled'):
            sync_schedule.sync_station(
                MONTREAL, lambda url: programme_page('Vancouver / CAN', '23.10-25.10, 2026'), self.before, self.dir, {}
            )
        self.assertFalse(stations.schedule_path('montreal', self.dir).exists())

    def test_real_isu_page_text_parses_to_the_pre_race_programme(self):
        # Text of ISU's Vancouver schedule tab as served on 2026-10-21, and the programme it gave.
        # The stored programme has since taken race-day corrections (docs/log.md, 2026-10-23).
        text = (ROOT / 'tests/fixtures/vancouver-2026-schedule.txt').read_text(encoding='utf-8')
        vancouver = stations.get('vancouver')
        self.assertTrue(sync_schedule.identity(text, vancouver))
        self.assertFalse(sync_schedule.identity(text, MONTREAL))
        found = sync_schedule.validate(sync_schedule.parse_text(text, vancouver), vancouver)
        self.assertEqual(found, sync_schedule.read(ROOT / 'tests/fixtures/vancouver-2026-schedule.csv'))

    def test_montreal_repechage_mislabels_only_at_reviewed_times(self):
        wrong = {
            'date': '2026-10-31',
            'session': 'R',
            'gender': 'M',
            'distance': '1500',
            'kind': 'I',
            'round': 'S',
            'group': '-',
        }
        rows = [{**wrong, 'time': t} for t in ('10:53', '11:33', '12:03', '12:20')]
        fixed = sync_schedule.correct_montreal_programme(rows, MONTREAL)
        self.assertEqual(
            [(r['time'], r['gender'], r['distance'], r['kind'], r['round']) for r in fixed],
            [
                ('10:53', 'M', '1500', 'I', 'Q'),
                ('11:33', 'M', '1500', 'I', 'S'),
                ('12:03', 'X', '2000', 'R', 'S'),
                ('12:20', 'M', '1500', 'I', 'S'),
            ],
        )
        self.assertEqual(sync_schedule.correct_montreal_programme(fixed, MONTREAL), fixed)
        # A partly corrected source must still allow the other reviewed corrections.
        partly_fixed = [{**wrong, 'time': t} for t in ('10:53', '11:33', '12:03')]
        partly_fixed[0]['round'] = 'Q'
        self.assertEqual(sync_schedule.correct_montreal_programme(partly_fixed, MONTREAL), fixed[:3])
        self.assertEqual(
            sync_schedule.correct_montreal_programme([{**wrong, 'time': '12:03'}], stations.get('vancouver')),
            [{**wrong, 'time': '12:03'}],
        )

    def test_montreal_repechage_matches_official_isu_news_programme(self):
        # https://www.isu-skating.com/en/short-track/news/isu-short-track-world-tour-montreal-schedule/
        rows = sync_schedule.read(stations.schedule_path('montreal'))
        by_time = {r['time']: r for r in rows if r['date'] == '2026-10-31' and r['session'] == 'R'}
        expected = {
            '10:53': ('M', '1500', 'I', 'Q'),
            '11:33': ('M', '1500', 'I', 'S'),
            '12:03': ('X', '2000', 'R', 'S'),
        }
        for time, labels in expected.items():
            with self.subTest(time=time):
                self.assertEqual(tuple(by_time[time][key] for key in ('gender', 'distance', 'kind', 'round')), labels)
        schedule = build.read_schedule('montreal')
        self.assertTrue(any(r['round_key'] == '2026-10-31/repechage/mixed/2000/semifinal/-' for r in schedule))

    def test_montreal_official_first_heat_times_override_provisional_times(self):
        # ISU results start lists on 1 November 2026 (local clock, EST UTC-5).
        expected = {
            ('R', 'M', '1000', 'I', 'H', '-'): ('10:06', '10:15', '2026-11-01', '23:15'),
            ('R', 'W', '500', 'I', 'Q', '-'): ('10:26', '10:35', '2026-11-01', '23:35'),
            ('R', 'W', '1500', 'I', 'Q', '-'): ('11:29', '11:38', '2026-11-02', '00:38'),
            ('F', 'X', '2000', 'R', 'F', 'A'): ('13:41', '13:40', '2026-11-02', '02:40'),
            ('F', 'M', '5000', 'R', 'F', 'A'): ('17:00', '16:57', '2026-11-02', '05:57'),
        }
        rows = [
            dict(
                date='2026-11-01',
                time=original,
                session=identity[0],
                gender=identity[1],
                distance=identity[2],
                kind=identity[3],
                round=identity[4],
                group=identity[5],
            )
            for identity, (original, _, _, _) in expected.items()
        ]
        corrected = sync_schedule.correct_montreal_programme(rows, MONTREAL)
        for row in corrected:
            identity = tuple(row[k] for k in ('session', 'gender', 'distance', 'kind', 'round', 'group'))
            self.assertEqual(row['time'], expected[identity][1])
        self.assertEqual(sync_schedule.correct_montreal_programme(corrected, MONTREAL), corrected)
        # The revised CSV feeds the build and converts correctly across the DST change.
        stored = sync_schedule.read(stations.schedule_path('montreal'))
        built = build.read_schedule('montreal')
        for identity, (_, confirmed, date, time) in expected.items():
            with self.subTest(identity=identity):
                row = next(
                    r
                    for r in stored
                    if r['date'] == '2026-11-01'
                    and tuple(r[k] for k in ('session', 'gender', 'distance', 'kind', 'round', 'group')) == identity
                )
                self.assertEqual(row['time'], confirmed)
                stage = {'R': 'repechage', 'F': 'main'}[identity[0]]
                gender = {'M': 'men', 'W': 'women', 'X': 'mixed'}[identity[1]]
                round_name = {'H': 'heats', 'Q': 'quarterfinal', 'F': 'final'}[identity[4]]
                key = f'2026-11-01/{stage}/{gender}/{identity[2]}/{round_name}/{identity[5]}'
                compiled = next(r for r in built if r['round_key'] == key)
                self.assertEqual((compiled['beijing_date'], compiled['beijing_time']), (date, time))
                self.assertTrue(compiled['local_start'].endswith('-05:00'))
        unrelated = [
            dict(
                date='2026-11-01',
                time='10:06',
                session='F',
                gender='M',
                distance='1000',
                kind='I',
                round='H',
                group='-',
            )
        ]
        self.assertEqual(sync_schedule.correct_montreal_programme(unrelated, MONTREAL), unrelated)

    def test_schedule_parser_accepts_single_digit_hours(self):
        text = (
            '30.10.2026\nDay - Qualifying Session\n'
            '8:45 Women 500 meter Preliminaries\n9:18 Men 500 meter Preliminaries\n'
        )
        parsed = sync_schedule.parse_text(text, MONTREAL)
        self.assertEqual([r['time'] for r in parsed], ['08:45', '09:18'])

    def test_discovery_matches_dates_city_and_country(self):
        pages = {
            sync_schedule.EVENTS: '<a href="/en/short-track/events/eventdetail/isu-short-track-world-tour-1/">1</a>'
            '<a href="/en/short-track/events/eventdetail/isu-short-track-world-tour-5/">old</a>'
            '<a href="/en/short-track/events/eventdetail/isu-short-track-world-tour-2-montreal/">2</a>',
            stations.EVENT_PAGE
            + 'isu-short-track-world-tour-5/': '<p>Montréal / CAN</p><p>01.11-03.11, 2024</p><a href="?tab=results_1923">R</a>',
            stations.EVENT_PAGE
            + 'isu-short-track-world-tour-2-montreal/': '<p>Montreal / CAN</p><p>30.10-01.11, 2026</p><a href="?tab=documents_16272">D</a><a href="?tab=tickets_2">T</a>',
        }
        found = sync_schedule.discover(MONTREAL, {'isu-short-track-world-tour-1'}, pages.__getitem__)
        self.assertEqual(found, {'slug': 'isu-short-track-world-tour-2-montreal', 'event_id': 16272})


class FailureIsolationTests(unittest.TestCase):
    def test_one_station_raising_does_not_stop_the_others(self):
        import sync_competitions
        import sync_predictions
        from unittest.mock import patch

        seen = []

        def flaky(event_id, config, *args, **kwargs):
            seen.append(event_id)
            if event_id == 'vancouver':
                raise ValueError('Too many official report documents')
            return build.competition_data.empty_snapshot(event_id), []

        racing = datetime(2026, 10, 31, tzinfo=timezone.utc)
        with (
            patch.object(sync_competitions, 'sync_event', flaky),
            patch.object(sync_competitions.stations, 'utc_now', lambda: racing),
            patch.object(sys, 'argv', ['sync_competitions.py']),
        ):
            self.assertEqual(sync_competitions.main(), 0)
        self.assertEqual(seen, ['vancouver', 'montreal'])

        def raising(event_id, config, *args, **kwargs):
            raise ValueError('Prediction snapshot identity mismatch')

        with patch.object(sync_predictions, 'sync_event', raising), patch.object(sys, 'argv', ['sync_predictions.py']):
            self.assertEqual(sync_predictions.main(), 0)


class StationConfigTests(unittest.TestCase):
    def test_every_station_has_a_valid_isu_reference_and_window(self):
        config = stations.load()
        self.assertEqual(
            [s['id'] for s in config['stations']],
            ['vancouver', 'montreal', 'seoul', 'shanghai', 'beijing', 'gdansk', 'tilburg'],
        )
        slugs = [s['isu']['slug'] for s in config['stations'] + config['championships']]
        self.assertEqual(len(slugs), len(set(slugs)))
        self.assertEqual(
            stations.page_url(MONTREAL, 'results'),
            'https://www.isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-2-montreal/?tab=results_16272',
        )
        self.assertTrue(stations.within(MONTREAL, datetime(2026, 10, 17, tzinfo=timezone.utc), 14, 3))
        self.assertFalse(stations.within(MONTREAL, datetime(2026, 11, 6, tzinfo=timezone.utc), 14, 3))
        self.assertTrue(stations.within(MONTREAL, datetime(2027, 1, 6, tzinfo=timezone.utc), 14))
        self.assertFalse(stations.within(MONTREAL, datetime(2026, 10, 15, tzinfo=timezone.utc), 14))

    def test_sources_follow_the_station_and_keep_overrides(self):
        vancouver = stations.sources(stations.get('vancouver'))
        self.assertEqual(vancouver['prediction']['event_id'], 16230)
        montreal = stations.sources(MONTREAL)
        self.assertEqual((montreal['city'], montreal['year']), ('Montreal', 2026))
        self.assertEqual(montreal['prediction']['event_id'], 16272)
        self.assertTrue(montreal['prediction']['entries_url'].endswith('?tab=entries_16272'))
        self.assertTrue(montreal['documents_url'].endswith('?tab=documents_16272'))

    def test_new_station_programme_is_announced_once(self):
        with tempfile.TemporaryDirectory() as temp:
            sync_schedule.sync_station(
                MONTREAL, lambda url: programme_page(), datetime(2026, 10, 21, tzinfo=timezone.utc), Path(temp), {}
            )
            montreal = build.read_schedule('montreal', Path(temp))
        venues = [('vancouver',), ('montreal',)]
        load = lambda event_id: build.competition_data.empty_snapshot(event_id)
        log = updates.update(
            {},
            updates.collect(venues, {'vancouver': build.read_schedule('vancouver')}, '2026-10-21T00:00:00+00:00', load),
        )
        log = updates.update(
            log,
            updates.collect(
                venues,
                {'vancouver': build.read_schedule('vancouver'), 'montreal': montreal},
                {'vancouver': '2026-10-21T00:00:00+00:00', 'montreal': '2026-10-22T00:10:00+00:00'},
                load,
            ),
        )
        self.assertEqual(
            [(e['station'], e['kind'], e['count'], e['local_date']) for e in log['events']],
            [('montreal', 'schedule', 61, '2026-10-30')],
        )


if __name__ == '__main__':
    unittest.main()


class SyncOutcomeTests(unittest.TestCase):
    def test_unexpected_competition_failure_is_nonzero(self):
        import sync_competitions
        from unittest.mock import patch

        def unreachable(*args, **kwargs):
            raise OSError('network unavailable')

        with (
            patch.object(sync_competitions, 'sync_event', unreachable),
            patch.object(sync_competitions.stations, 'utc_now', lambda: datetime(2026, 10, 31, tzinfo=timezone.utc)),
            patch.object(sys, 'argv', ['sync_competitions.py']),
        ):
            self.assertEqual(sync_competitions.main(), 1)

    def test_unexpected_prediction_failure_is_nonzero(self):
        import sync_predictions
        from unittest.mock import patch

        with (
            patch.object(sync_predictions, 'sync_event', side_effect=OSError('network unavailable')),
            patch.object(sys, 'argv', ['sync_predictions.py']),
        ):
            self.assertEqual(sync_predictions.main(), 1)
