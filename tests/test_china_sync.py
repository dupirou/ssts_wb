import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import sync_china as china
import competition_data

VANCOUVER = build.stations.get('vancouver')

BASE = 'https://www.isu-skating.com/en/short-track/results/isu-short-track-world-tour-1/'
EVENT = BASE + '8765432/'
MEN = BASE + '8765433/'
PRELIM = MEN + '?round=111'


class ChinaSyncTests(unittest.TestCase):
    def test_named_chinese_competitor_and_hkg_exclusion(self):
        markup = """<main><h1>ISU World Tour Vancouver 2026</h1>
          <h2>Heat 1</h2><div>First heat</div>
          <a>ZHANG Bohao CHN</a><div>CHN</div><a>LOU Zhanshuo HKG</a>
          <h2>Heat 2</h2><a>LI Kun CHN</a><span>CHN</span>
          <h2>Heat 3</h2><a>Steven DUBOIS CAN</a></main>"""
        parsed = china.heats_from_page(china.BeautifulSoup(markup, 'html.parser'))
        self.assertEqual([(h['number'], h['athletes']) for h in parsed], [(1, ['ZHANG Bohao']), (2, ['LI Kun'])])

    def test_sources_not_yet_published(self):
        index = china.BeautifulSoup(
            '<a href="/en/short-track/results/2025-other/12/">World Tour Montreal 2025</a>', 'html.parser'
        )
        self.assertIsNone(china.discover_event(index, VANCOUVER))

    def test_discovery_requires_year_and_host(self):
        source = f'<article><p>23 Oct 2026 Vancouver</p><a href="{EVENT}">World Tour 1</a></article>'
        self.assertEqual(china.discover_event(china.BeautifulSoup(source, 'html.parser'), VANCOUVER), EVENT)
        bad = '<article>Vancouver 2026<a href="https://evil.example/short-track/results/xx/123/">Results</a></article>'
        self.assertIsNone(china.discover_event(china.BeautifulSoup(bad, 'html.parser'), VANCOUVER))

    def test_round_link_mapping_requires_exact_match(self):
        category = china.BeautifulSoup(
            '<a href="?round=111">Preliminaries</a><a href="?round=112">Rep. Heats</a>', 'html.parser'
        )
        found = china.round_links(category, MEN)
        self.assertEqual(found[('preliminaries', False)], PRELIM)
        self.assertEqual(len(found), 2)
        matches = china.round_matches(
            build.read_schedule('vancouver'), ('men', 500, 'individual'), ('preliminaries', False)
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['round_key'], '2026-10-23/qualifying/men/500/preliminaries/-')

    def test_full_discovery_flow_and_persistent_cache(self):
        index = china.BeautifulSoup(
            f'<article>Vancouver 23 Oct 2026<a href="{EVENT}">Results</a></article>', 'html.parser'
        )
        landing = china.BeautifulSoup(
            f'<main>ISU World Tour Vancouver 2026<a href="{MEN}">Men 500 m</a></main>', 'html.parser'
        )
        category = china.BeautifulSoup(
            '<main>World Tour Vancouver 2026<a href="?round=111">Preliminaries</a></main>', 'html.parser'
        )
        heats = china.BeautifulSoup(
            '<main>World Tour Vancouver 2026<h2>Heat 1</h2><a>ZHANG Bohao CHN</a><span>CHN</span><h2>Heat 2</h2><a>James TEST USA</a></main>',
            'html.parser',
        )
        pages = {china.INDEX: index, EVENT: landing, MEN: category, PRELIM: heats}
        orig_auto, orig_config = china.AUTO, china.CONFIG
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(competition_data, 'load_snapshot', return_value=competition_data.empty_snapshot('vancouver')),
        ):
            china.AUTO = Path(directory) / 'auto.json'
            china.CONFIG = Path(directory) / 'sources.json'
            # Another station's confirmed round shares the file and must survive this station's sync.
            other = {
                'round_key': '2026-10-30/main/women/500/final/A',
                'country': 'CHN',
                'evidence': 'official_round_results',
                'source_url': 'https://www.isu-skating.com/en/short-track/results/x/1/',
                'verified_at': '2026-10-31T00:00:00+00:00',
                'heats': [{'number': 1, 'athletes': ['TEST']}],
            }
            china.AUTO.write_text(json.dumps({'schema_version': 1, 'heats': [other]}), encoding='utf-8')
            china.CONFIG.write_text('{"schema_version":2,"event_results_urls":{}}', encoding='utf-8')
            try:
                result = china.sync('vancouver', fetcher=lambda url: pages[url], now='2026-10-21T00:00:00+00:00')
                self.assertEqual(result, 1)
                loaded = json.loads(china.AUTO.read_text(encoding='utf-8'))
                mine = [x for x in loaded['heats'] if x['round_key'].startswith('2026-10-23')]
                self.assertEqual(mine[0]['heats'][0]['athletes'], ['ZHANG Bohao'])
                self.assertEqual(mine[0]['evidence'], 'official_round_results')
                self.assertIn(other, loaded['heats'])
                self.assertEqual(china.sync('vancouver', fetcher=lambda url: pages[url]), 0)
            finally:
                china.AUTO, china.CONFIG = orig_auto, orig_config

    def test_station_identity_ignores_accents_but_not_city_or_year(self):
        montreal = china.stations.get('montreal')
        self.assertTrue(china.is_station('World Tour Montréal 2026', montreal))
        self.assertFalse(china.is_station('World Tour Montréal 2025', montreal))
        self.assertFalse(china.is_station('World Tour Vancouver 2026', montreal))
        index = china.BeautifulSoup(
            f'<article>Vancouver 23 Oct 2026<a href="{EVENT}">Results</a></article>', 'html.parser'
        )
        self.assertIsNone(china.discover_event(index, station=montreal))

    def test_final_round_requires_group_evidence(self):
        doc = china.BeautifulSoup('<main>Vancouver 2026<h2>Heat 1</h2><a>LI Kun CHN</a></main>', 'html.parser')
        final = china.collect_one(
            doc,
            PRELIM,
            ('men', 500, 'individual'),
            ('final', False),
            build.read_schedule('vancouver'),
            '2026-10-21T00:00:00+00:00',
            VANCOUVER,
        )
        self.assertEqual(final, [])
        doc = china.BeautifulSoup(
            '<main>Vancouver 2026<h2>Heat 1 - Final A</h2><a>LI Kun CHN</a></main>', 'html.parser'
        )
        final = china.collect_one(
            doc,
            PRELIM,
            ('men', 500, 'individual'),
            ('final', False),
            build.read_schedule('vancouver'),
            '2026-10-21T00:00:00+00:00',
            VANCOUVER,
        )
        self.assertEqual(len(final), 1)
        self.assertTrue(final[0]['round_key'].endswith('/A'))


if __name__ == '__main__':
    unittest.main()
