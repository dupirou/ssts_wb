"""Unit & official-table back-calculation tests for tools/quota_engine.py."""

import json
import copy
import tempfile
import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
if (ROOT / '.cache/pylib').exists():
    sys.path.insert(0, str(ROOT / '.cache/pylib'))

import quota_engine as qe
from sync_junior_isu import merge_standings


class QuotaEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = qe.load_rules_config()

    def test_age_eligibility_exact_boundaries(self):
        self.assertEqual(qe.classify_age_group('2007-06-30', self.cfg), 'SENIOR_ONLY')
        self.assertEqual(qe.classify_age_group('2007-07-01', self.cfg), 'DUAL_ELIGIBLE')
        self.assertEqual(qe.classify_age_group('2008-06-19', self.cfg), 'DUAL_ELIGIBLE')
        self.assertEqual(qe.classify_age_group('2009-06-30', self.cfg), 'DUAL_ELIGIBLE')
        self.assertEqual(qe.classify_age_group('2009-07-01', self.cfg), 'JUNIOR_ONLY')
        self.assertEqual(qe.classify_age_group('2011-06-30', self.cfg), 'JUNIOR_ONLY')
        self.assertEqual(qe.classify_age_group('2011-07-01', self.cfg), 'INELIGIBLE_TOO_YOUNG')
        self.assertEqual(qe.classify_age_group(None, self.cfg), 'UNKNOWN')
        self.assertTrue(qe.is_senior_eligible('2009-06-30', self.cfg))
        self.assertFalse(qe.is_senior_eligible('2009-07-01', self.cfg))

    def test_jwc_prize_forfeit_red_zone(self):
        # Skating WT6/WT7 only (after JWC3) does NOT forfeit JWC prize money
        ok = qe.check_jwc_prize_forfeit(['JWC1', 'JWC2', 'JWC3', 'WJC', 'WT6', 'WT7'], self.cfg)
        self.assertFalse(ok['forfeits_jwc_prize_money'])
        self.assertFalse(ok['forfeits_points_or_eligibility'])

        # Skating any of WT1..WT5 forfeits JWC prize money but keeps points & eligibility
        hit = qe.check_jwc_prize_forfeit(['WT3', 'JWC3'], self.cfg)
        self.assertTrue(hit['forfeits_jwc_prize_money'])
        self.assertFalse(hit['forfeits_points_or_eligibility'])
        self.assertEqual(hit['triggered_events'], ['WT3'])

    def test_points_tables_and_team_globe_3x_scope(self):
        self.assertEqual(qe.points_for_rank(1, 'world_tour_standard_1x', self.cfg), 100)
        self.assertEqual(qe.points_for_rank(24, 'world_tour_standard_1x', self.cfg), 1)
        self.assertEqual(qe.points_for_rank(25, 'world_tour_standard_1x', self.cfg), 0)
        self.assertEqual(qe.points_for_rank(1, 'world_tour_team_globe_relay_3x', self.cfg), 300)
        self.assertEqual(qe.points_for_rank(12, 'world_tour_team_globe_relay_3x', self.cfg), 60)
        self.assertEqual(qe.points_for_rank(1, 'world_ranking_1x', self.cfg), 10000)
        self.assertEqual(qe.points_for_rank(75, 'world_ranking_1x', self.cfg), 1)
        self.assertEqual(qe.points_for_rank(1, 'world_championships_2027_ranking_2x', self.cfg), 20000)
        self.assertEqual(qe.points_for_rank(75, 'world_championships_2027_ranking_2x', self.cfg), 2)

        # Team Crystal Globe counts all stops, individual 1x + relay 3x
        team = qe.score_team_crystal_globe(
            [{'rank': 1, 'in_main_session': True}, {'rank': 25, 'in_main_session': False}],
            [{'rank': 2}, {'rank': 3}],
            self.cfg,
        )
        self.assertEqual(team['individual_points'], 100)
        self.assertEqual(team['relay_points_3x'], 240 + 210)
        self.assertEqual(team['total_points'], 550)

    def test_world_tour_best_5_of_7_and_tie_breakers(self):
        # Individual distance: Best 5 of 7; identical counts broken by most recent result
        skater_a = qe.score_world_tour_classification(
            [
                {'stop_index': 1, 'rank': 1},
                {'stop_index': 2, 'rank': 2},
                {'stop_index': 3, 'rank': 10},
                {'stop_index': 4, 'rank': 10},
                {'stop_index': 5, 'rank': 10},
                {'stop_index': 6, 'rank': 10},
                {'stop_index': 7, 'rank': 2},
            ],
            self.cfg,
        )
        skater_b = qe.score_world_tour_classification(
            [
                {'stop_index': 1, 'rank': 2},
                {'stop_index': 2, 'rank': 2},
                {'stop_index': 3, 'rank': 10},
                {'stop_index': 4, 'rank': 10},
                {'stop_index': 5, 'rank': 10},
                {'stop_index': 6, 'rank': 10},
                {'stop_index': 7, 'rank': 1},
            ],
            self.cfg,
        )
        self.assertEqual(skater_a['total_points'], 100 + 80 + 80 + 28 + 28)
        self.assertEqual(skater_a['total_points'], skater_b['total_points'])
        # B had rank 1 in stop 7 (more recent) so B wins individual distance tie-break
        self.assertGreater(skater_b['tie_key'], skater_a['tie_key'])

        # Crystal Globe: same 15-result counts -> NO further tie-break (joint winners)
        g_a = qe.score_crystal_globe([{'stop_index': 1, 'rank': 1}, {'stop_index': 7, 'rank': 2}], self.cfg)
        g_b = qe.score_crystal_globe([{'stop_index': 1, 'rank': 2}, {'stop_index': 7, 'rank': 1}], self.cfg)
        self.assertEqual(g_a['tie_key'], g_b['tie_key'])

    def test_wc_2027_max_roster_piecewise_rules(self):
        # Gender relay entered -> always 5
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 1, '1000m': 1, '1500m': 1}, True, False, self.cfg), 5)
        # Any distance 3 spots without gender relay -> 4
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 3, '1000m': 1, '1500m': 1}, False, False, self.cfg), 4)
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 3, '1000m': 2, '1500m': 2}, False, True, self.cfg), 4)
        # Mixed relay qualified or >=2 distances with 2 spots -> 3
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 1, '1000m': 1, '1500m': 1}, False, True, self.cfg), 3)
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 2, '1000m': 2, '1500m': 1}, False, False, self.cfg), 3)
        # Exactly one distance with 2 spots -> 2
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 2, '1000m': 1, '1500m': 1}, False, False, self.cfg), 2)
        # Default -> 1
        self.assertEqual(qe.compute_wc_2027_max_roster({'500m': 1, '1000m': 1, '1500m': 1}, False, False, self.cfg), 1)

    def test_wc_2027_relay_tie_breaker_and_host_replacement(self):
        # Build 13 teams where 12th and 13th tie on points (100), broken by best single-event rank then best time,
        # and host KOR is 14th so KOR replaces 12th.
        teams = []
        for i in range(1, 12):
            teams.append(
                {'country': f'T{i:02d}', 'stop_results': [{'stop_index': 1, 'rank': 1}, {'stop_index': 2, 'rank': 2}]}
            )
        # Tie at 100 pts: TIEA (ranks 5,5 = 50+50) vs TIEB (ranks 3,10 = 70+28? Wait: 4(60)+7(40)=100!)
        teams.append(
            {
                'country': 'TIEA',
                'stop_results': [
                    {'stop_index': 1, 'rank': 5, 'best_time_s': 240.0},
                    {'stop_index': 2, 'rank': 5, 'best_time_s': 241.0},
                ],
            }
        )
        teams.append(
            {
                'country': 'TIEB',
                'stop_results': [
                    {'stop_index': 1, 'rank': 4, 'best_time_s': 245.0},
                    {'stop_index': 2, 'rank': 7, 'best_time_s': 246.0},
                ],
            }
        )
        teams.append({'country': 'KOR', 'stop_results': [{'stop_index': 1, 'rank': 20}]})

        res = qe.compute_wc_2027_relay_quotas({'women_3000m': teams}, self.cfg)['women_3000m']
        # TIEB beats TIEA for standing rank 12 (best rank 4 < 5), then host KOR replaces 12th!
        rank_map = {r['country']: r['standing_rank'] for r in res['standings']}
        self.assertEqual(rank_map['TIEB'], 12)
        self.assertEqual(rank_map['TIEA'], 13)
        self.assertTrue(res['host_replaced_12th'])
        self.assertIn('KOR', res['qualified_countries'])
        self.assertNotIn('TIEB', res['qualified_countries'])
        self.assertEqual(len(res['qualified_countries']), 12)

    def test_wt_four_skater_rule_and_penalty_ban_toggle(self):
        wrd = {
            ('women', '500m'): [
                {'athlete_id': 'a1', 'country': 'CHN', 'rank': 8, 'points': 5000},
                {'athlete_id': 'a2', 'country': 'CHN', 'rank': 15, 'points': 3000},
                {'athlete_id': 'a3', 'country': 'CHN', 'rank': 38, 'points': 800},
            ],
            ('women', '1000m'): [
                {'athlete_id': 'a1', 'country': 'CHN', 'rank': 12, 'points': 4000},
                {'athlete_id': 'a2', 'country': 'CHN', 'rank': 41, 'points': 600},
            ],
            ('women', '1500m'): [
                {'athlete_id': 'a1', 'country': 'CHN', 'rank': 25, 'points': 2000},
            ],
        }
        pens = [
            {'athlete_id': 'a1', 'country': 'CHN', 'gender': 'women', 'name': 'Skater A1', 'total': 3},
            {'athlete_id': 'a2', 'country': 'CHN', 'gender': 'women', 'name': 'Skater A2', 'total': 5},
            {'athlete_id': 'a3', 'country': 'CHN', 'gender': 'women', 'name': 'Skater A3', 'total': 2},
        ]
        res_on = qe.compute_wt_2026_27_quotas(wrd, pens, self.cfg, enable_penalty_bans=True)
        chn_w = res_on['quotas']['women']['CHN']
        self.assertEqual(chn_w['max_roster_size'], 6)
        self.assertEqual(chn_w['slots_500m'], 4)  # 3 skaters in Top 40 -> 4-skater exception!
        self.assertEqual(chn_w['slots_1000m'], 3)  # only 1 in Top 40 -> default 3
        self.assertEqual(chn_w['slots_1500m'], 3)

        bans = {b['athlete_id']: b for b in res_on['next_stop_penalty_bans']}
        # a1 has 3 penalties -> highest ranked distance (500m, rank 8) blocked
        self.assertEqual(bans['a1']['blocked_distances'], ['500m'])
        # a2 has 5 penalties -> top 2 ranked distances (500m rank 15, 1000m rank 41) blocked
        self.assertEqual(bans['a2']['blocked_distances'], ['500m', '1000m'])
        # a3 has 2 penalties -> warning only, not banned
        self.assertEqual([w['athlete_id'] for w in res_on['one_away_from_ban_warnings']], ['a3'])

        # Toggle switch OFF -> zero bans
        res_off = qe.compute_wt_2026_27_quotas(wrd, pens, self.cfg, enable_penalty_bans=False)
        self.assertEqual(res_off['next_stop_penalty_bans'], [])

    def test_clean_build_preserves_verified_quotas_and_separates_rankings(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'quotas.json'
            result = qe.build_quotas_snapshot(out_path=out)
            teams = result['world_championships_2027']['individual_and_roster']
            self.assertEqual([len(teams[g]) for g in ('women', 'men')], [23, 36])
            self.assertEqual(result['wc_2027_verification']['checked_cells'], 177)
            with self.assertRaises(FileNotFoundError):
                qe.build_quotas_snapshot(live_standings_path=out.with_name('missing.json'), out_path=out)
            self.assertEqual(json.loads(out.read_text()), result)

    def test_partial_ranking_refresh_keeps_missing_tables_and_dates(self):
        previous = json.loads((ROOT / 'data/quota_roster/standings_2026_27.json').read_text())
        fresh = copy.deepcopy(previous)
        fresh['fetched_at'] = '2026-12-01T00:00:00Z'
        missing = fresh['world_rankings_individual'].pop()
        changed = fresh['world_rankings_individual'][0]
        changed['items'][0]['points'] += 100
        fresh['world_tour_relay_standings']['mixed_2000m'] = []
        saved = merge_standings(previous, fresh)
        tables = {t['list_id']: t for t in saved['world_rankings_individual']}
        self.assertEqual(tables[missing['list_id']]['items'], missing['items'])
        self.assertEqual(tables[missing['list_id']]['as_of'], missing.get('as_of', previous['fetched_at']))
        self.assertEqual(tables[changed['list_id']]['as_of'], fresh['fetched_at'])
        self.assertEqual(saved['world_tour_relay_standings'], previous['world_tour_relay_standings'])

    def test_penalty_crossing_uses_canonical_id_and_is_not_repeated(self):
        report = dict(athlete_id='ath-08caea4ad943373c94ab', country='CHN', gender='women', total=3)
        ranking = {('women', '1000m'): [dict(athlete_id='skr-8080', country='CHN', rank=1)]}
        bans = qe.compute_wt_2026_27_quotas(ranking, [dict(report, previous_total=2)])['next_stop_penalty_bans']
        self.assertEqual([(r['athlete_id'], r['blocked_distances']) for r in bans], [('skr-8080', ['1000m'])])
        self.assertFalse(
            qe.compute_wt_2026_27_quotas(ranking, [dict(report, previous_total=3)])['next_stop_penalty_bans']
        )

    def test_backcalc_2027_wc_matches_comm_2805_100_percent(self):
        worlds_pdf = ROOT / '.cache/isu/1_worlds.pdf'
        comm_pdf = ROOT / '.cache/isu_phase0/comm_2805.pdf'
        if not (worlds_pdf.exists() and comm_pdf.exists()):
            self.skipTest('Cached official 2026 Worlds / Comm. 2805 PDFs not present')
        ver = qe.verify_wc_2027_against_comm_2805(worlds_pdf, comm_pdf, self.cfg)
        self.assertEqual(ver['mismatch_count'], 0, f'Mismatches vs Comm. 2805: {ver["mismatches"]}')
        self.assertTrue(ver['exact_match'])
        # Explicitly check verified CHN quotas
        self.assertEqual(ver['computed_quotas']['women']['CHN']['slots_500m'], 3)
        self.assertEqual(ver['computed_quotas']['women']['CHN']['slots_1000m'], 3)
        self.assertEqual(ver['computed_quotas']['women']['CHN']['slots_1500m'], 2)
        self.assertEqual(ver['computed_quotas']['men']['CHN']['slots_500m'], 3)
        self.assertEqual(ver['computed_quotas']['men']['CHN']['slots_1000m'], 2)
        self.assertEqual(ver['computed_quotas']['men']['CHN']['slots_1500m'], 2)


if __name__ == '__main__':
    unittest.main()
