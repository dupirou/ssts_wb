"""Fail-closed fixtures for official World Tour season penalties and referee codes."""

import copy
import json
import tempfile
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import competition_data
import penalty_protocol


def fixture():
    header = 'ISU Short Track World Tour 2026/27 - Vancouver (CAN)\n'
    base = 'WORLD TOUR PENALTIES\nAfter 1 of 7 World Tour Events\n'
    women = header + base + 'Women\n' + '54  SONG Jiarui  CHN  1 - - - - - - 1\n'
    men = header + base + 'Men\n' + '67  LI Kun  CHN  1 - - - - - - 1\n'
    infra = header + (
        'INFRINGEMENT REPORT\n'
        '1  144 Women 1000 m       Semifinals         54  SONG Jiarui             CHN    PEN    S6\n'
        '2  145 Women 500 m        Heats              25  BLAIS Danae             CAN    PEN    OFF\n'
        '3  177 Men 1000 m         Rep. Quarterfinals  67  LI Kun                  CHN    PEN    S6\n'
        'Summary: PEN: 3\n'
        'This report does not include the following penalties: ST6, EQP, EMB, OFF, SR\n'
    )
    # The exclusion note belongs to C98P, not the infringement report.
    men += 'This report does not include the following penalties: ST6, EQP, EMB, OFF, SR\n'
    return [women, men, infra]


class PenaltyProtocolTests(unittest.TestCase):
    def report(self, pages=None):
        return penalty_protocol.parse_pages(
            pages or fixture(), {'city': 'Vancouver', 'year': 2026}, 'https://isu.example/protocol.pdf'
        )

    def test_s6_is_not_the_excluded_st6_and_off_does_not_count(self):
        value = self.report()
        self.assertEqual(value['completed_events'], 1)
        self.assertIn('ST6', value['excluded_codes'])
        self.assertEqual(len(value['infringements']), 3)
        self.assertEqual(sum(p['total'] for p in value['official']), 2)
        self.assertEqual({p['infringement_code'] for p in value['infringements']}, {'S6', 'OFF'})

    def test_multi_page_gender_table_is_supported(self):
        pages = fixture()
        extra = (
            'ISU Short Track World Tour 2026/27 - Vancouver (CAN)\n'
            'WORLD TOUR PENALTIES\nAfter 1 of 7 World Tour Events\nWomen\n'
            '19  GONG Li  CHN  1 - - - - - - 1\n'
        )
        pages.insert(1, extra)
        pages[3] = pages[3].replace(
            'Summary: PEN: 3\n',
            '4  213 Women 1500 m       Final B  19  GONG Li  CHN    PEN    C5\nSummary: PEN: 4\n',
        )
        result = self.report(pages)
        self.assertEqual(result['completed_events'], 1)
        self.assertEqual(len(result['official']), 3)
        self.assertEqual(sum(row['total'] for row in result['official']), 3)

    def test_missing_gender_table_is_rejected(self):
        pages = fixture()
        pages[1] = pages[1].replace('Men\n', 'Women\n')
        with self.assertRaisesRegex(ValueError, 'both genders'):
            self.report(pages)

    def test_export_restriction_only_on_first_threshold_crossing(self):
        stations = [{'id': name} for name in ('vancouver', 'montreal', 'seoul', 'shanghai')]
        cfg = {'season': '2026/27', 'stations': stations}

        def snapshot(after, total, counts):
            return {
                'schema_version': 1,
                'completed_events': after,
                'source_url': 'https://isu.example/report.pdf',
                'excluded_codes': ['ST6', 'OFF'],
                'official': [{
                    'athlete_id': 'ath-test', 'name': 'TEST Skater',
                    'country': 'CHN', 'gender': 'men', 'helmet_number': 22,
                    'total': total, 'station_counts': counts,
                }],
                'infringements': [{
                    'country': 'CHN', 'gender': 'men', 'helmet_number': 22,
                    'race_number': 1, 'distance_m': 1000, 'round_label': 'Final',
                    'format': 'individual', 'infringement_code': 'S6',
                }],
            }

        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'accepted'
            out = Path(temp) / 'output'
            source.mkdir()
            (source / 'vancouver.json').write_text(json.dumps(snapshot(1, 3, [3, 0, 0, 0])))
            result = penalty_protocol.export(out, cfg, source)
            self.assertEqual(result['items'][0]['next_restriction'],
                             {'event_id': 'montreal', 'blocked_individual_distances': 1})

            (source / 'montreal.json').write_text(json.dumps(snapshot(2, 3, [3, 0, 0, 0])))
            result = penalty_protocol.export(out, cfg, source)
            self.assertEqual(result['items'][0]['next_restriction'],
                             {'event_id': None, 'blocked_individual_distances': 0})
            self.assertEqual([d['event_id'] for d in result['items'][0]['details']],
                             ['vancouver', 'montreal'])

            (source / 'seoul.json').write_text(json.dumps(snapshot(3, 5, [3, 0, 2, 0])))
            result = penalty_protocol.export(out, cfg, source)
            self.assertEqual(result['items'][0]['next_restriction'],
                             {'event_id': 'shanghai', 'blocked_individual_distances': 2})

    def test_official_total_mismatch_rejected(self):
        pages = fixture()
        pages[0] = pages[0].replace('1 - - - - - - 1', '2 - - - - - - 2')
        with self.assertRaisesRegex(ValueError, 'disagree'):
            self.report(pages)

    def test_missing_report_or_wrong_city_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing'):
            self.report(fixture()[:2])
        pages = [page.replace('Vancouver', 'Montreal') for page in fixture()]
        with self.assertRaisesRegex(ValueError, 'city/year'):
            self.report(pages)

    def test_attach_code_to_verified_athlete_and_round(self):
        report = self.report()
        song = competition_data.athlete_id('SONG Jiarui', 'CHN', 'women')
        li = competition_data.athlete_id('LI Kun', 'CHN', 'men')
        blais = competition_data.athlete_id('BLAIS Danae', 'CAN', 'women')
        items = [
            ('women', 1000, 'Semifinals', song, 54, 'CHN'),
            ('women', 500, 'Heats', blais, 25, 'CAN'),
            ('men', 1000, 'Rep. Quarterfinals', li, 67, 'CHN'),
        ]
        snapshot = {
            'rounds': {
                'items': [
                    dict(
                        gender=gender,
                        distance_m=distance,
                        format='individual',
                        round_label=round_label,
                        evidence='official_results',
                        result_status='Official',
                        participants=[
                            dict(
                                athlete_id=aid,
                                country=country,
                                helmet_number=bib,
                                penalty=dict(code='PEN', infringement_code=None),
                            )
                        ],
                    )
                    for gender, distance, round_label, aid, bib, country in items
                ]
            }
        }
        original = copy.deepcopy(snapshot)
        out = penalty_protocol.attach_codes(snapshot, report)
        self.assertEqual(snapshot, original)
        self.assertEqual(
            [heat['participants'][0]['penalty']['infringement_code'] for heat in out['rounds']['items']],
            ['S6', 'OFF', 'S6'],
        )
        out['rounds']['items'][0]['participants'][0]['penalty']['code'] = 'YC'
        with self.assertRaisesRegex(ValueError, 'uniquely'):
            penalty_protocol.attach_codes(out, report)


if __name__ == '__main__':
    unittest.main()
