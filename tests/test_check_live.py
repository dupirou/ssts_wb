import sys
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import check_live_schedule as check

TZ = ZoneInfo('America/Vancouver')
ROWS = build.read_schedule('vancouver')
RELAY = dict(gender='men', distance_m=5000, format='relay')


def official(disc, stage, date, group=None, status='start list', heats=4, label='Quarterfinals'):
    return dict(disc=disc, stage=stage, label=label, group=group, heats=heats, date=date, status=status)


class LiveScheduleCheckTests(unittest.TestCase):
    def by_key(self, report):
        return {line.get('round_key'): line for line in report}

    def test_both_isu_date_forms_resolve_to_the_same_local_start(self):
        # Men's 5000 m relay quarter-final, stored 17:12 local: once written as true UTC, once local.
        for raw, reading in (('2026-10-24T00:12:00.000Z', 'utc'), ('2026-10-23T17:12:00.000Z', 'local')):
            line = self.by_key(check.compare(ROWS, [official(RELAY, ('quarterfinal', False), raw)], TZ))[
                '2026-10-23/qualifying/men/5000/quarterfinal/-'
            ]
            self.assertEqual((line['kind'], line['reading']), ('same', reading))

    def test_moved_missing_and_unpublished_rounds_are_reported(self):
        report = check.compare(
            ROWS,
            [
                official(RELAY, ('quarterfinal', False), '2026-10-23T17:30:00.000Z'),
                official(RELAY, ('final', False), None, label='Finals', heats=0),
            ],
            TZ,
        )
        lines = self.by_key(report)
        moved = lines['2026-10-23/qualifying/men/5000/quarterfinal/-']
        self.assertEqual((moved['kind'], moved['delta_min'], moved['official']), ('moved', 18, '10-23 17:30'))
        # Finals without heats cover Final A and B; every other stored round lacks an official one here.
        self.assertTrue(any(line['kind'] == 'no_heats' for line in report))
        self.assertNotIn('2026-10-25/main/men/5000/final/B', lines)
        self.assertEqual(lines['2026-10-24/main/men/5000/semifinal/-']['kind'], 'missing')


if __name__ == '__main__':
    unittest.main()
