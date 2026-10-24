"""The what's-new feed announces each official milestone once, timed by the data itself."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import competition_data as data
import updates

VENUES = [('vancouver',)]
CHECKED = '2026-10-21T00:07:35+00:00'


def person(name, country, rank=None):
    return dict(athlete_id=name, name=name, country=country, rank=rank)


def heat(hid, round_key, round_, evidence, people, group=None, status='Official'):
    return dict(
        id=hid,
        gender='women',
        distance_m=500,
        format='individual',
        round_key=round_key,
        local_date=round_key[:10],
        round=round_,
        round_label='Final' if round_ == 'final' else 'Heats',
        group=group,
        evidence=evidence,
        result_status=status,
        participants=people,
    )


class Snapshots:
    def __init__(self):
        self.snapshot = data.empty_snapshot('vancouver')
        entries = self.snapshot['entries']
        entries.update(status='available', updated_at='2026-10-20T08:52:40+00:00', items=[dict(id='a'), dict(id='b')])

    def __call__(self, event_id):
        return self.snapshot if event_id == 'vancouver' else data.empty_snapshot(event_id)

    def rounds(self, at, *heats):
        self.snapshot['rounds'].update(status='available', updated_at=at, items=list(heats))


class UpdateFeedTests(unittest.TestCase):
    def setUp(self):
        self.schedule = {'vancouver': build.read_schedule('vancouver')}
        self.load = Snapshots()

    def run_once(self, log, checked=CHECKED):
        return updates.update(log, updates.collect(VENUES, self.schedule, checked, self.load))

    def test_first_run_announces_published_data_but_not_the_timetable(self):
        log = self.run_once({})
        self.assertEqual(
            [(e['kind'], e['at'], e['count']) for e in log['events']], [('entries', '2026-10-20T08:52:40+00:00', 2)]
        )
        self.assertEqual(sum(k.startswith('vancouver/time/') for k in log['facts']), 61)
        self.assertEqual(self.run_once(log), log)

    def test_groups_then_results_each_announced_once(self):
        final = '2026-10-24/main/women/500/final/A'
        log = self.run_once({})
        self.load.rounds(
            '2026-10-25T01:00:00+00:00',
            heat(
                'h1',
                final,
                'final',
                'official_start_list',
                [person('FAN Kexin', 'CHN'), person('Kim BOUTIN', 'CAN')],
                'A',
                None,
            ),
        )
        log = self.run_once(log)
        groups = log['events'][-1]
        self.assertEqual((groups['kind'], groups['china'], groups['group']), ('groups', ['FAN Kexin'], 'A'))
        self.load.rounds(
            '2026-10-25T01:20:00+00:00',
            heat(
                'h1',
                final,
                'final',
                'official_results',
                [person('FAN Kexin', 'CHN', 1), person('Kim BOUTIN', 'CAN', 2), person('X Y', 'NED', 4)],
                'A',
            ),
        )
        log = self.run_once(log)
        self.assertEqual([e['kind'] for e in log['events']], ['entries', 'groups', 'results'])
        self.assertEqual(
            log['events'][-1]['podium'],
            [dict(rank=1, name='FAN Kexin', country='CHN'), dict(rank=2, name='Kim BOUTIN', country='CAN')],
        )
        self.assertEqual(self.run_once(log)['events'], log['events'])

    def test_results_say_where_each_chinese_skater_went(self):
        heats, rep = '2026-10-23/qualifying/women/500/heats/-', '2026-10-24/repechage/women/500/heats/-'
        q, out, back = person('A Q', 'CHN', 1), person('B OUT', 'CHN', 4), person('C REP', 'CHN', 3)
        q['qualification'] = 'Q'
        out['penalty'] = dict(code='PEN')
        results = heat('h1', heats, 'heats', 'official_results', [q, out, back, person('D', 'KOR', 2)])
        log = self.run_once({})
        self.load.rounds('2026-10-24T01:00:00+00:00', results)
        log = self.run_once(log)
        announced = next(e for e in log['events'] if e['kind'] == 'results')
        self.assertEqual(
            [(s['name'], s['status']) for s in announced['china_results']],
            [('A Q', 'advanced'), ('B OUT', 'out'), ('C REP', 'out')],
        )
        self.assertEqual(announced['china_results'][1]['penalty'], 'PEN')
        # The repechage start list comes later; the same announcement, at the same time, follows it.
        later = heat('h2', rep, 'heats', 'official_start_list', [person('C REP', 'CHN')])
        later['round_label'] = 'Rep. Heats'
        self.load.rounds('2026-10-24T02:00:00+00:00', results, later)
        log = self.run_once(log)
        same = [e for e in log['events'] if e['id'] == announced['id']]
        self.assertEqual(len(same), 1)
        self.assertEqual(same[0]['at'], announced['at'])
        self.assertEqual(same[0]['china_results'][2]['status'], 'repechage')
        self.assertTrue(
            next(e for e in log['events'] if e['kind'] == 'groups' and e['round'] == 'heats' and e['repechage'])
        )

    def test_a_main_round_in_the_repechage_session_is_not_called_a_repechage(self):
        semi = heat('h1', '2026-10-24/repechage/mixed/2000/semifinal/-', 'semifinal', 'official_start_list', [])
        semi.update(round_label='Semifinals', gender='mixed', distance_m=2000, format='relay')
        self.load.rounds('2026-10-24T01:00:00+00:00', semi)
        self.assertFalse(self.run_once({})['events'][-1]['repechage'])

    def test_final_results_keep_each_chinese_place(self):
        final = heat(
            'h1',
            '2026-10-24/main/women/500/final/B',
            'final',
            'official_results',
            [person('A', 'CHN', 2), person('B', 'KOR', 1)],
            'B',
        )
        self.load.rounds('2026-10-25T01:00:00+00:00', final)
        results = next(e for e in self.run_once({})['events'] if e['kind'] == 'results')
        self.assertEqual(results['china_results'], [dict(name='A', rank=2)])

    def test_provisional_results_are_not_announced_as_results(self):
        self.load.rounds(
            '2026-10-24T01:00:00+00:00',
            heat(
                'h1',
                '2026-10-23/qualifying/women/500/heats/-',
                'heats',
                'official_results',
                [person('A', 'KOR', 1)],
                status='Unofficial',
            ),
        )
        self.assertEqual([e['kind'] for e in self.run_once({})['events']], ['entries', 'groups'])

    def test_moved_start_time_and_changed_entries(self):
        log = self.run_once({})
        moved = [dict(e) for e in self.schedule['vancouver']]
        moved[0].update(beijing_time='00:30')
        self.schedule = {'vancouver': moved}
        self.load.snapshot['entries'].update(
            updated_at='2026-10-22T03:00:00+00:00', items=[dict(id='a'), dict(id='b'), dict(id='c')]
        )
        log = self.run_once(log, '2026-10-22T04:00:00+00:00')
        change = log['events'][-1]
        self.assertEqual(
            (change['kind'], change['previous'], change['current'], change['at']),
            ('time_change', '2026-10-24 00:00', '2026-10-24 00:30', '2026-10-22T04:00:00+00:00'),
        )
        self.assertEqual(
            (log['events'][-2]['kind'], log['events'][-2]['changed'], log['events'][-2]['count']), ('entries', True, 3)
        )

    def test_old_announcements_expire(self):
        log = dict(
            schema_version=1,
            facts={},
            events=[dict(id='old', station='vancouver', kind='rankings', at='2026-09-01T00:00:00+00:00')],
        )
        self.assertEqual([e['kind'] for e in self.run_once(log)['events']], ['entries'])


if __name__ == '__main__':
    unittest.main()
