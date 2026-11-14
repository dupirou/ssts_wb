"""Chinese display names are applied to published files only, and never to another team's skater."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import localize

TABLE = ('CHN', {'Kerui SONG': '宋柯睿', 'Yan ZHANG': '张延'})


class LocalizeTests(unittest.TestCase):
    def setUp(self):
        self.shown = localize.Localizer(*TABLE)

    def test_every_official_spelling_of_a_listed_skater_is_replaced(self):
        for spelling in ('Kerui SONG', 'SONG Kerui', 'SONG KERUI', 'KERUI SONG'):
            person = self.shown.walk(dict(name=spelling, country='CHN', athlete_id='ath-1'))
            self.assertEqual(
                (person['name'], person['name_latin'], person['athlete_id']), ('宋柯睿', spelling, 'ath-1')
            )
        self.assertEqual(self.shown.walk(['Kerui SONG', "Jens VAN 'T WOUT"]), ['宋柯睿', "Jens VAN 'T WOUT"])

    def test_registry_entries_keep_the_official_spelling_as_an_alias(self):
        person = self.shown.walk(dict(id='skater-yan-zhang', name='Yan ZHANG', aliases=['ZHANG Yan']))
        self.assertEqual(person, dict(id='skater-yan-zhang', name='张延', aliases=['ZHANG Yan', 'Yan ZHANG']))

    def test_sentences_replace_whole_names_only(self):
        self.assertEqual(self.shown.text('进B组决赛：Yan ZHANG、Kerui SONG'), '进B组决赛：张延、宋柯睿')
        self.assertEqual(self.shown.text('Jianyan ZHANG'), 'Jianyan ZHANG')

    def test_same_name_on_another_team_is_refused(self):
        with self.assertRaises(ValueError):
            self.shown.walk(dict(name='Yan ZHANG', country='HKG'))

    def test_relay_teams_use_the_chinese_country_name(self):
        heat = dict(
            format='relay',
            participants=[
                dict(name='Republic of Korea', country='KOR', members=[dict(name='Gyuho LEE', athlete_id='ath-2')]),
                dict(name='China', country='CHN', members=[dict(name='Kerui SONG', athlete_id='ath-1')]),
            ],
        )
        shown = self.shown.walk(heat)['participants']
        self.assertEqual([p['name'] for p in shown], ['韩国队', '中国队'])
        self.assertEqual(shown[0]['members'][0]['name'], 'Gyuho LEE')
        self.assertEqual(shown[1]['members'][0]['name'], '宋柯睿')
        # An individual skater is never mistaken for a team.
        self.assertEqual(
            self.shown.walk(dict(name='Gyuho LEE', country='KOR', athlete_id='ath-2'))['name'], 'Gyuho LEE'
        )

    def test_apply_rewrites_files_once_and_keeps_their_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'a.json'
            path.write_text(json.dumps(dict(items=[dict(name='Yan ZHANG', country='CHN')]), indent=2) + '\n')
            self.assertEqual(localize.apply([path], TABLE), 1)
            first = path.read_text(encoding='utf-8')
            self.assertTrue(first.startswith('{\n  ') and first.endswith('\n') and '张延' in first)
            self.assertEqual(localize.apply([path], TABLE), 0)

    def test_the_stored_table_lists_only_names_the_directory_knows(self):
        country, names = localize.load()
        self.assertEqual(country, 'CHN')
        self.assertEqual(len(set(names.values())), len(names))


if __name__ == '__main__':
    unittest.main()
