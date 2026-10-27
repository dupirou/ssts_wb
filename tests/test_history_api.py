"""Protect against observed ISU migration conflicts and current relay rosters."""

import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import import_history_api
import import_olympic_history


class HistoryApiTests(unittest.TestCase):
    def test_missing_classification_keeps_the_actual_group_rank_and_rejects_other_rounds(self):
        fixture = json.loads((ROOT / 'tests/fixtures/history-2024-relay-conflict.json').read_text())

        class Cache:
            wrong_round = False

            def api(self, endpoint, **form):
                if endpoint == 'get-event-result-fsksys-team':
                    rows = []
                elif endpoint == 'get-event-result-round':
                    rows = fixture['rounds']
                else:
                    rows = json.loads(json.dumps(fixture['heats']))
                    if self.wrong_round:
                        rows[0]['event_result_round_id'] = -1
                return rows, dict(url=import_history_api.API + endpoint, form=form, sha256='0' * 64)

        cache = Cache()
        result = import_history_api.collect_discipline(cache, fixture['meta'])
        row = result['results'][0]
        self.assertTrue(result['incomplete_classification'])
        self.assertEqual((row['rank'], row['rank_scope'], row['final_group']), (1, 'final', 'A'))
        self.assertTrue(row['classification_missing'])
        self.assertEqual(row['members'], [])
        cache.wrong_round = True
        with self.assertRaisesRegex(ValueError, 'heat identity mismatch'):
            import_history_api.collect_discipline(cache, fixture['meta'])

    def test_ioc_finals_follow_physical_columns_instead_of_rank_thresholds(self):
        # Synthetic bbox excerpt: a classified fifth place can be an A finalist.
        words = [
            ('STKW500M----------_74A', 20, 30),
            ('Rank', 20, 150),
            ('Name', 120, 150),
            ('H', 360, 150),
            ('QF', 400, 150),
            ('SF', 440, 150),
            ('FB', 480, 150),
            ('FA', 520, 150),
            ('5', 20, 180),
            ('101', 65, 180),
            ('SKATER', 120, 180),
            ('One', 190, 180),
            ('CHN', 300, 180),
            ('43.500', 520, 180),
            ('6', 20, 200),
            ('102', 65, 200),
            ('SKATER', 120, 200),
            ('Two', 190, 200),
            ('CHN', 300, 200),
            ('43.800', 480, 200),
            ('Legend:', 20, 250),
        ]
        xml = (
            '<doc><page height="800">'
            + ''.join(
                f'<word xMin="{x}" xMax="{x + 10}" yMin="{y}" yMax="{y + 8}">{text}</word>' for text, x, y in words
            )
            + '</page></doc>'
        )
        rows, _, _ = import_olympic_history.parse_bbox(xml, 1)
        self.assertEqual([(r['rank'], r['final_group']) for r in rows], [(5, 'A'), (6, 'B')])

    def test_current_official_classification_preserves_previous_final_without_inventing_lineup(self):
        fixture = json.loads((ROOT / 'tests/fixtures/history-2024-relay-conflict.json').read_text())

        class Cache:
            def api(self, endpoint, **form):
                key = {
                    'get-event-result-fsksys-team': 'total',
                    'get-event-result-round': 'rounds',
                    'get-event-result-round-heats-stk-team': 'heats',
                }[endpoint]
                rows = fixture[key]
                return rows, dict(
                    url=import_history_api.API + endpoint,
                    form=form,
                    sha256=hashlib.sha256(json.dumps(rows).encode()).hexdigest(),
                )

        result = import_history_api.collect_discipline(Cache(), fixture['meta'])['results'][0]
        self.assertEqual((result['rank'], result['rank_scope'], result['final_group']), (2, 'overall', 'A'))
        self.assertEqual(result['reported_overall_rank'], 2)
        self.assertTrue(result['classification_conflict'])
        self.assertEqual(result['members'], [])
        self.assertEqual(result['lineup_status'], 'unavailable')
        self.assertIn('get-event-result-fsksys-team', result['source_url'])
        self.assertEqual(result['classification_resolution'], 'current_official_classification')
        self.assertEqual(result['previous_final_result']['rank'], 1)
        self.assertEqual(result['previous_final_result']['rank_scope'], 'final')
        self.assertIn('round-heats-stk-team', result['previous_final_result']['source_url'])


if __name__ == '__main__':
    unittest.main()
