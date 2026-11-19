"""Structural, schema, conservation, and rule-consistency tests for data/heats/."""

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))

import build_rules
import check_heats
import export_heat_starts
import heats_schema as hs


class HeatsSchemaUnitTests(unittest.TestCase):
    def test_name_normalization_handles_confusables_and_order(self):
        self.assertEqual(hs.normalize_name_key('KHOKHELKО Tymofii'), hs.normalize_name_key('Tymofii KHOKHELKO'))
        self.assertEqual(hs.normalize_name_key('KAZHGALI Nurtilеk'), hs.normalize_name_key('Nurtilek KAZHGALI'))
        self.assertEqual(hs.normalize_name_key('BASTIER Étienne'), hs.normalize_name_key('Etienne BASTIER'))

    def test_local_wallclock_to_utc_converts_pseudo_z(self):
        # Montreal Oct 28, 2022 is EDT (UTC-4): 09:30:11 local -> 13:30:11 UTC
        self.assertEqual(hs.local_wallclock_to_utc('2022-10-28T09:30:11.000Z', 'Montréal'), '2022-10-28T13:30:11Z')
        # Milano Feb 10, 2026 is CET (UTC+1): 10:33:07 local -> 09:33:07 UTC
        self.assertEqual(hs.local_wallclock_to_utc('2026-02-10T10:33:07.000Z', 'Milano Cortina'), '2026-02-10T09:33:07Z')

    def test_case_sensitive_qualification_mapping(self):
        self.assertEqual(hs.normalize_qualification('Q', 'PRELIM', 'heats'), ('Q', 'Q', 'NEXT', True))
        self.assertEqual(hs.normalize_qualification('q', 'PRELIM', 'heats'), ('q', 'q', 'NEXT', True))
        # Rep. Semifinals advances to NEXT main round, not FA
        self.assertEqual(hs.normalize_qualification('Q', 'REPECHAGE', 'semifinal'), ('Q', 'Q', 'NEXT', True))
        # MAIN Semifinals
        self.assertEqual(hs.normalize_qualification('QA', 'MAIN', 'semifinal'), ('QA', 'Q', 'FA', True))
        self.assertEqual(hs.normalize_qualification('qA', 'MAIN', 'semifinal'), ('qA', 'q', 'FA', True))
        self.assertEqual(hs.normalize_qualification('QB', 'MAIN', 'semifinal'), ('QB', 'QB', 'FB', False))
        self.assertEqual(hs.normalize_qualification('qB', 'MAIN', 'semifinal'), ('qB', 'qB', 'FB', False))
        self.assertEqual(hs.normalize_qualification('ADVa', 'MAIN', 'semifinal'), ('ADVA', 'ADV', 'FA', True))
        self.assertEqual(hs.normalize_qualification('ADVB', 'MAIN', 'semifinal'), ('ADVB', 'ADV', 'FB', False))
        self.assertEqual(hs.normalize_qualification(None, 'MAIN', 'semifinal'), (None, 'OUT', None, False))
        self.assertEqual(hs.normalize_qualification(None, 'MAIN', 'final'), (None, None, None, None))
        with self.assertRaises(ValueError):
            hs.normalize_qualification('X', 'PRELIM', 'heats')

    def test_status_normalization_and_fail_closed(self):
        self.assertEqual(hs.normalize_status('41.234', 'Official', 'Q'), ('OK', 41.234, None, False, None))
        self.assertEqual(hs.normalize_status('no time', '', None), ('NO_TIME', None, None, False, None))
        self.assertEqual(hs.normalize_status('44.500', '', 'ADVA'), ('ADV', 44.5, None, False, None))
        self.assertEqual(hs.normalize_status('no time', '', 'ADV'), ('ADV', None, None, False, None))
        self.assertEqual(hs.normalize_status('PEN', 'Penalty', None), ('PEN', None, 'PEN', True, 'PEN'))
        self.assertEqual(hs.normalize_status('DQ', 'DisQualified', None), ('PEN', None, 'PEN', True, 'PEN'))
        self.assertEqual(hs.normalize_status('YC', 'Yellow Card', None), ('YC', None, 'YC', True, 'PEN'))
        self.assertEqual(hs.normalize_status('DNF', 'Did Not Finish', None), ('DNF', None, None, True, 'DNF'))
        self.assertEqual(hs.normalize_status('DNS', 'Did Not Start', None), ('DNS', None, None, False, None))
        with self.assertRaises(ValueError):
            hs.normalize_status('WEIRD', '', None)

    def test_round_and_heat_parsers(self):
        self.assertEqual(hs.parse_round_name('Rep. Quarterfinals'), ('REPECHAGE', 'quarterfinal', 2))
        self.assertEqual(hs.parse_round_name('Rep. Semifinals'), ('REPECHAGE', 'semifinal', 3))
        self.assertEqual(hs.parse_round_name('Quarterfinals'), ('MAIN', 'quarterfinal', 2))
        self.assertEqual(hs.parse_heat_label('Quarterfinal 4', 'quarterfinal'), (4, None))
        self.assertEqual(hs.parse_heat_label('Semifinal 2', 'semifinal'), (2, None))
        self.assertEqual(hs.parse_heat_label('Final B', 'final'), (None, 'B'))

    def test_rule_text_parser_isu_and_ioc(self):
        self.assertEqual(
            build_rules.parse_rule_text(
                'The first and second placed skaters from each race and up to a maximum of four fastest third place skaters qualify for Quarterfinals.'
            ),
            (2, 4, 3),
        )
        self.assertEqual(
            build_rules.parse_rule_text(
                'The 2 best athletes in each Semifinal (Q) and the fastest 3rd placed athlete (q) qualify for Final A. The next 5 athletes qualify for Final B.'
            ),
            (2, 1, 3),
        )


class HeatsDatasetTests(unittest.TestCase):
    def test_dataset_invariants_and_coverage(self):
        heats_dir = ROOT / 'data/heats'
        self.assertTrue((heats_dir / 'events.json').exists(), 'Run import_heats.py first')
        summary = check_heats.validate_all(heats_dir, require_rules=True)
        self.assertEqual(summary['errors'], [], f"Validation errors: {summary['errors'][:5]}")
        self.assertEqual(summary['event_count'], 27)

        # Verify season_config.json lane_mode per D0 empirical findings.
        cfg = json.loads((heats_dir / 'rules/season_config.json').read_text(encoding='utf-8'))['seasons']
        for season in ('2022/23', '2023/24', '2024/25', '2025/26'):
            self.assertEqual(cfg[season]['lane_mode'], 'time_first')
        self.assertEqual(cfg['2026/27']['lane_mode'], 'rank_then_time')

        # Verify no tmp- fallback IDs were created in athletes.json.
        athletes = json.loads((heats_dir / 'athletes.json').read_text(encoding='utf-8'))['items']
        self.assertTrue(all(a['id'].startswith('skr-') for a in athletes))


class HeatsExportTests(unittest.TestCase):
    def test_wide_export_merges_five_seasons_with_schema_and_codes(self):
        rows = export_heat_starts.build_wide_rows(ROOT / 'data/heats')
        self.assertEqual(len({r['event_id'] for r in rows}), 29)
        self.assertEqual({r['season'] for r in rows}, {'2022/23', '2023/24', '2024/25', '2025/26', '2026/27'})
        self.assertEqual(list(rows[0].keys()), export_heat_starts.CSV_COLUMNS)
        # C89I2 subcodes must be populated on 2025/26 Worlds (id 1) and 2026/27 World Tour.
        self.assertTrue(any(r['event_id'] == '2025-26-worlds-montreal' and r['penalty_code'] for r in rows))
        self.assertTrue(any(r['season'] == '2026/27' and r['penalty_code'] for r in rows))


if __name__ == '__main__':
    unittest.main()
