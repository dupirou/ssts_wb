import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import isu_rankings


class RankingContractTests(unittest.TestCase):
    def test_error_envelope_is_not_accepted(self):
        for body in (dict(status=500, data=[]), dict(status=200, data={}), dict(status=200)):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    isu_rankings.response(json.dumps(body).encode(), 'endpoint')
        self.assertEqual(isu_rankings.response(json.dumps(dict(status=200, data=[])).encode(), 'x')['data'], [])

    def test_rank_pagination_requires_all_pages_and_identity(self):
        meta = dict(
            world_standings_list_fsk_id=615,
            season_name='2025/2026',
            gender='Women',
            discipline_distance='500',
            type='WRD',
            level_name='Senior',
        )
        calls = []

        def sender(url, payload):
            page = payload['page']
            calls.append(page)
            row = dict(
                world_standings_list_fsk_id=615,
                skaters_id=page,
                skaters=dict(id=page),
                rank=page,
                points=100 - page,
                nf_for_country_code='CHN',
            )
            return json.dumps(
                dict(
                    status=200,
                    current_page=page,
                    total_page=2,
                    total_items=2,
                    is_next_page='Y' if page == 1 else 'N',
                    detail=meta,
                    data=[row],
                )
            ).encode()

        rows = isu_rankings.ranking_rows(meta, sender)
        self.assertEqual(calls, [1, 2])
        self.assertEqual(rows[2]['rank'], 2)

        def bad(url, payload):
            obj = json.loads(sender(url, payload))
            obj['detail']['type'] = 'WCD'
            return json.dumps(obj).encode()

        with self.assertRaises(ValueError):
            isu_rankings.ranking_rows(meta, bad)


if __name__ == '__main__':
    unittest.main()
