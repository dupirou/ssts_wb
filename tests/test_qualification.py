import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import qualification
from unittest.mock import patch

# Every wording ISU's results API used for Vancouver 2026 (qualification_rule), with its short form.
PUBLISHED = {
    'The first and second placed skaters from each race and up to a maximum of six fastest third place skaters qualify for Heats.': '2Q+6q',
    'The first placed skater from each race and up to a maximum of ten fastest second place skaters qualify for Heats.': '1Q+10q',
    'The first and second placed skaters from each race and up to a maximum of two fastest third place skaters qualify for Quarterfinals.': '2Q+2q',
    'The first, second and third placed skaters from each race and up to a maximum of one fastest fourth place skater qualify for Quarterfinals.': '3Q+1q',
    'The first placed skater from each race and up to a maximum of three fastest second place skaters qualify for Rep Quarterfinals.': '1Q+3q',
    'The first placed skater from each race and up to a maximum of four fastest second place skaters qualify for Rep Semifinals.': '1Q+4q',
    'The first and second placed skaters from each race and up to a maximum of four fastest third place skaters qualify for Rep. Semifinals.': '2Q+4q',
    'The first placed skater from each race qualify for Quarterfinals.': '1Q',
    'The first placed skater from each race qualify for Semifinals.': '1Q',
    'The first and second placed skaters from each race and up to a maximum of five fastest third place skaters qualify for Semifinals.': '2Q+5q',
    'The first and second placed skaters from each race and up to a maximum of one fastest third place skater qualify for Final A. Remainder may qualify for Final B.': '2Q+1q',
    'The first and second placed teams from each race qualify for Semifinals.': '2Q',
    'The first and second placed teams from each race qualify for Final A, the third and fourth placed teams from each race qualify for Final B.': '2Q',
}
TEXTS = list(PUBLISHED)


class QualificationRuleTests(unittest.TestCase):
    def test_every_published_wording_has_a_short_form(self):
        for text, code in PUBLISHED.items():
            with self.subTest(text=text):
                self.assertEqual(qualification.describe(text)['code'], code)

    def test_chinese_wording_names_the_next_round_and_final_b(self):
        zh = lambda text: qualification.describe(text)['zh']
        self.assertEqual(zh(TEXTS[0]), '每组前 2 名及成绩最好的 6 名第 3 名晋级预赛')
        self.assertEqual(zh(TEXTS[4]), '每组第 1 名及成绩最好的 3 名第 2 名晋级复活赛1/4决赛')
        self.assertEqual(zh(TEXTS[10]), '每组前 2 名及成绩最好的 1 名第 3 名晋级A组决赛，其余可进B组决赛')
        self.assertEqual(zh(TEXTS[12]), '每组前 2 名晋级A组决赛，第 3、4 名进B组决赛')

    def test_unknown_wording_keeps_its_text_without_a_guess(self):
        self.assertIsNone(qualification.describe(''))
        self.assertIsNone(qualification.describe(None))
        odd = qualification.describe('The best eight skaters on time qualify for Semifinals.')
        self.assertEqual(
            (odd['code'], odd['zh'], odd['text']),
            (None, None, 'The best eight skaters on time qualify for Semifinals.'),
        )
        # A 'fastest' place that does not follow the direct places is not a pattern ISU uses.
        skip = 'The first placed skater from each race and up to a maximum of two fastest third place skaters qualify for Heats.'
        self.assertIsNone(qualification.describe(skip)['code'])

    def test_build_attaches_understood_rules_to_their_rounds(self):
        rows = build.read_schedule('vancouver')
        snapshot = build.competition_data.empty_snapshot('vancouver')
        snapshot['rounds']['rules'] = {rows[0]['round_key']: TEXTS[0], rows[1]['round_key']: 'Something new.'}
        with patch.object(build.competition_data, 'load_snapshot', return_value=snapshot):
            rows = build.attach_qualification(rows, 'vancouver')
        self.assertEqual(rows[0]['qualification']['code'], '2Q+6q')
        # A wording not understood, and a round without a rule, carry nothing.
        self.assertNotIn('qualification', rows[1])
        self.assertNotIn('qualification', rows[2])


if __name__ == '__main__':
    unittest.main()
