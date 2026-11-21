"""Unit tests for tools/parse_domestic_pdf.py (header regex, 0.85 geometric check, tied ranks, homonym guard)."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
if (ROOT / '.cache/pylib').exists():
    sys.path.insert(0, str(ROOT / '.cache/pylib'))

import parse_domestic_pdf as pdp


class _FakePage:
    """Simulates a pypdf Page with exact (x, y) positioned text spans for visitor_text."""

    def __init__(self, tokens):
        # tokens: list of (x, y, text)
        self._tokens = tokens

    def extract_text(self, visitor_text=None, **_kwargs):
        if visitor_text is not None:
            for x, y, text in self._tokens:
                visitor_text(text, [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, x, y], None, 10)
            return ''
        return '\n'.join(t for _, _, t in self._tokens)


class _FakeReader:
    def __init__(self, pages):
        self.pages = pages


class DomesticPdfParserTest(unittest.TestCase):
    def _sample_single_stop_page(self):
        return _FakePage(
            [
                (180, 780, '2026-2027赛季全国短道速滑精英联赛（七台河站）'),
                (60, 760, '比赛地点：七台河体育中心'),
                (260, 760, '甲组 女子组 500米 积分排名表'),
                (420, 760, '打印时间：2026-10-18 17:32'),
                # Column header row (dynamic x-coordinates, never hardcoded)
                (50, 720, '名次'),
                (110, 720, '号码'),
                (180, 720, '姓名'),
                (270, 720, '代表单位'),
                (400, 720, '积分'),
                (480, 720, '备注'),
                # Single-stop geometric points: 10000, 8500, 7225, 6141
                (52, 695, '1'),
                (112, 695, '101'),
                (182, 695, '王欣然'),
                (272, 695, '黑龙江省'),
                (402, 695, '10000'),
                (52, 675, '2'),
                (112, 675, '102'),
                (182, 675, '张楚桐'),
                (272, 675, '吉林省'),
                (402, 675, '8500'),
                (52, 655, '3'),
                (112, 655, '103'),
                (182, 655, '李明'),
                (272, 655, '北京市'),
                (402, 655, '7225'),
                (52, 635, '4'),
                (112, 635, '104'),
                (182, 635, '李明'),
                (272, 635, '辽宁省'),
                (402, 635, '6141'),
                # Tied 35th place must be preserved strictly (never renumbered to 35, 36!)
                (52, 615, '35'),
                (112, 615, '211'),
                (182, 615, '新星甲'),
                (272, 615, '黑龙江省'),
                (402, 615, '94'),
                (52, 595, '35'),
                (112, 595, '212'),
                (182, 595, '新星乙'),
                (272, 595, '山东省'),
                (402, 595, '94'),
            ]
        )

    def _sample_cumulative_page(self):
        return _FakePage(
            [
                (180, 780, '2026-2027赛季全国短道速滑精英联赛总积分榜'),
                (60, 760, '七台河体育中心'),
                (260, 760, '甲组 男子组 1000m 总积分'),
                (420, 760, '打印时间: 2026/10/25 18:00'),
                (50, 720, '名次'),
                (110, 720, '号码'),
                (180, 720, '姓名'),
                (270, 720, '代表单位'),
                (400, 720, '总积分'),
                (52, 695, '1'),
                (112, 695, '10'),
                (182, 695, '孙龙'),
                (272, 695, '吉林省'),
                (402, 695, '18500'),
                (52, 675, '2'),
                (112, 675, '11'),
                (182, 675, '张柏浩'),
                (272, 675, '黑龙江省'),
                (402, 675, '15725'),
                (52, 655, '3'),
                (112, 655, '12'),
                (182, 655, '李坤'),
                (272, 655, '辽宁省'),
                (402, 655, '13366'),
                (52, 635, '4'),
                (112, 635, '13'),
                (182, 635, '朱祎玎'),
                (272, 635, '吉林省'),
                (402, 635, '11200'),
            ]
        )

    def test_single_stop_header_tied_ranks_and_homonym_disambiguation(self):
        fake = _FakeReader([self._sample_single_stop_page()])
        with patch.object(pdp, 'PdfReader', return_value=fake):
            doc = pdp.parse_domestic_pdf(Path('qitaihe_w500.pdf'), allowed_divisions={'甲组'})

        self.assertTrue(doc['included_by_division_filter'])
        self.assertFalse(doc['is_cumulative'])  # 10000, 8500, 7225, 6141 -> single stop!
        self.assertEqual(doc['metadata']['venue'], '七台河体育中心')
        self.assertEqual(doc['metadata']['division'], '甲组')
        self.assertEqual(doc['metadata']['gender'], 'women')
        self.assertEqual(doc['metadata']['distance_m'], 500)
        self.assertEqual(doc['metadata']['report_date'], '2026-10-18')
        # Strict tied-rank preservation
        ranks = [r['rank'] for r in doc['rows']]
        self.assertEqual(ranks, [1, 2, 3, 4, 35, 35])

        mapping = {
            'athletes': [
                {
                    'athlete_id': 'skr-7609',
                    'name_zh': '王欣然',
                    'name_en': 'Xinran WANG',
                    'gender': 'women',
                    'teams': ['黑龙江省'],
                },
                {
                    'athlete_id': 'skr-8080',
                    'name_zh': '张楚桐',
                    'name_en': 'Chutong ZHANG',
                    'gender': 'women',
                    'teams': ['吉林省'],
                },
                # Same Chinese name 李明 in two different provinces -> composite key disambiguates!
                {
                    'athlete_id': 'dom-liming-bj',
                    'name_zh': '李明',
                    'name_en': 'Ming LI (BJ)',
                    'gender': 'women',
                    'teams': ['北京市'],
                },
                {
                    'athlete_id': 'dom-liming-ln',
                    'name_zh': '李明',
                    'name_en': 'Ming LI (LN)',
                    'gender': 'women',
                    'teams': ['辽宁省'],
                },
            ]
        }
        resolved, warnings = pdp.disambiguate_domestic_rows(doc, mapping)
        self.assertEqual(len(resolved), 6)  # Zero silent drops!
        ids = [r['athlete_id'] for r in resolved]
        self.assertEqual(ids[:4], ['skr-7609', 'skr-8080', 'dom-liming-bj', 'dom-liming-ln'])
        # Unmapped 新星甲 & 新星乙 get deterministic dom-tmp-* IDs AND explicit warnings
        self.assertTrue(ids[4].startswith('dom-tmp-'))
        self.assertTrue(ids[5].startswith('dom-tmp-'))
        self.assertNotEqual(ids[4], ids[5])
        self.assertEqual(len(warnings), 2)
        self.assertEqual({w['name_zh'] for w in warnings}, {'新星甲', '新星乙'})

    def test_cumulative_detection_division_filter_and_csv_override(self):
        fake = _FakeReader([self._sample_cumulative_page()])
        with patch.object(pdp, 'PdfReader', return_value=fake):
            doc = pdp.parse_domestic_pdf(Path('cum_m1000.pdf'), allowed_divisions={'甲组'})
            doc_excluded = pdp.parse_domestic_pdf(Path('cum_m1000.pdf'), allowed_divisions={'乙组'})

        self.assertTrue(doc['is_cumulative'])
        self.assertFalse(doc_excluded['included_by_division_filter'])
        self.assertEqual(doc['metadata']['gender'], 'men')
        self.assertEqual(doc['metadata']['distance_m'], 1000)
        self.assertEqual(doc['metadata']['report_date'], '2026-10-25')

        mapping = {
            'athletes': [
                {
                    'athlete_id': 'skr-6784',
                    'name_zh': '孙龙',
                    'name_en': 'Long SUN',
                    'gender': 'men',
                    'teams': ['吉林省'],
                },
            ]
        }
        resolved, warnings = pdp.disambiguate_domestic_rows(doc, mapping)
        self.assertEqual(resolved[0]['athlete_id'], 'skr-6784')
        self.assertEqual(len(warnings), 3)

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / 'overrides.csv'
            csv_path.write_text(
                'name_zh,team,distance_m,best_time_s,is_relay_member\n孙龙,吉林省,1000,83.42,true\n',
                encoding='utf-8',
            )
            n = pdp.apply_csv_overrides(resolved, csv_path)
            self.assertEqual(n, 1)
            self.assertAlmostEqual(resolved[0]['best_time_s'], 83.42)
            self.assertTrue(resolved[0]['is_relay_member'])

    def test_team_mismatch_homonym_guard_prevents_silent_merge(self):
        doc = {
            'source_file': 'test.pdf',
            'metadata': {
                'gender': 'men',
                'distance_m': 500,
                'division': '甲组',
                'venue': '七台河体育中心',
                'report_date': '2026-10-18',
            },
            'is_cumulative': False,
            'rows': [{'rank': 12, 'bib': '88', 'name_zh': '李坤', 'team': '四川省', 'points': 1673, 'notes': ''}],
        }
        mapping = {
            'athletes': [
                {
                    'athlete_id': 'skr-4167',
                    'name_zh': '李坤',
                    'name_en': 'Kun LI',
                    'gender': 'men',
                    'teams': ['辽宁省'],
                },
            ]
        }
        resolved, warnings = pdp.disambiguate_domestic_rows(doc, mapping)
        self.assertTrue(resolved[0]['athlete_id'].startswith('dom-tmp-'))
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]['kind'], 'team_mismatch_possible_homonym')

    def test_markdown_multi_section_ingestion_and_blank_ranks(self):
        md_text = (
            '# 衡水｜甲组男女单项积分排名\n\n'
            '## 女子组 500米\n\n'
            '来源页码：29；原表打印时间：2026-9-14 22:13:28\n\n'
            '| 名次 | 号码 | 姓名 | 代表单位 | 积分 | 备注 |\n'
            '| --- | --- | --- | --- | --- | --- |\n'
            '| 1 | 173 | 王晔 | 北京市冬季运动管理中心 | 10000 |  |\n'
            '| 2 | 070 | 林敬宜 | 黑龙江省冰上训练中心 | 8500 |  |\n'
            '| 3 | 066 | 王欣然 | 黑龙江省冰上训练中心 | 7225 |  |\n'
            '| 4 | 095 | 张楚桐 | 吉林省体育局冰上运动管理中心 | 6141 |  |\n'
            '|  | 176 | 宋嘉华 | 四川省体育局 | 0 |  |\n'
        )
        with tempfile.TemporaryDirectory() as tmp:
            md_path = Path(tmp) / 'hengshui.md'
            md_path.write_text(md_text, encoding='utf-8')
            docs = pdp.parse_domestic_markdown(md_path, allowed_divisions={'甲组'})
        self.assertEqual(len(docs), 1)
        doc = docs[0]
        self.assertEqual(doc['metadata']['venue'], '衡水')
        self.assertEqual(doc['metadata']['gender'], 'women')
        self.assertEqual(doc['metadata']['distance_m'], 500)
        self.assertEqual(doc['metadata']['report_date'], '2026-09-14')
        self.assertFalse(doc['is_cumulative'])
        self.assertEqual([r['rank'] for r in doc['rows']], [1, 2, 3, 4, None])
        self.assertEqual(doc['rows'][1]['bib'], '070')


if __name__ == '__main__':
    unittest.main()
