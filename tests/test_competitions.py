import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import competition_data as data
import isu_results as api
import sync_competitions as sync

CONFIG = {'city': 'Vancouver', 'year': 2026,
          'documents_url': 'https://isu-skating.com/event?tab=documents',
          'results_url': 'https://isu-skating.com/event?tab=results'}
SOURCE = 'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/entries.pdf'
ROSTER = '''Entries ISU Short Track World Tour 1
23-25 October 2026, Vancouver CAN
ISU Member Last Name First Name Gender Participation
CHN SUN Long M Active
HKG LOU Zhanshuo M Active
TPE HUANG Chien Hua F Active
CAN PAGE Kiera F Substitute
'''


class CompetitionTests(unittest.TestCase):
    def test_roster_country_and_substitute_are_distinct(self):
        with patch.object(sync, 'pdf_pages', return_value=[ROSTER]):
            people = sync.parse_entries(b'%PDF', CONFIG)
        self.assertEqual(len(people), 4)
        self.assertEqual(sum(p['country'] == 'CHN' for p in people), 1)
        self.assertEqual(people[0]['participation'], 'substitute')
        self.assertNotIn('distance_m', people[0])
        self.assertEqual(data.athlete_id('SUN Long', 'CHN', 'men'),
                         data.athlete_id('Long SUN', 'CHN', 'men'))

    def test_wrong_year_and_unrecognized_row_rejected(self):
        for text in [ROSTER.replace('2026', '2025'), ROSTER + 'USA SAMPLE Person M Unknown']:
            with patch.object(sync, 'pdf_pages', return_value=[text]):
                with self.assertRaises(ValueError):
                    sync.parse_entries(b'%PDF', CONFIG)

    def test_official_document_discovery(self):
        body = f'<h1>Vancouver 2026</h1><a href="{SOURCE}">Entries 15.10.2026</a>'
        body += '<a href="https://evil.example/list.pdf">Entries 18.10.2026</a>'
        docs = sync.discover_documents(body, CONFIG['documents_url'], CONFIG)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]['published_at'], '2026-10-15')
        for url in ['http://isu-skating.com/a', 'https://isu-skating.com.evil.example/',
                    'https://user:pass@isu-skating.com/', 'https://isu-skating.com:8443/']:
            self.assertFalse(sync.allowed(url))

    def test_snapshot_no_churn_and_source_failure_retains_data(self):
        def fetch(url):
            if url == SOURCE:
                return b'%PDF'
            return f'<h1>Vancouver 2026</h1><a href="{SOURCE}">Entries 15.10.2026</a>'.encode()
        with tempfile.TemporaryDirectory() as temp, patch.object(sync, 'pdf_pages', return_value=[ROSTER]):
            directory = Path(temp)
            obj, errors = sync.sync_event('vancouver', CONFIG, fetcher=fetch,
                now='2026-10-20T08:00:00+00:00', directory=directory)
            self.assertFalse(errors)
            first = (directory / 'vancouver.json').read_bytes()
            obj, errors = sync.sync_event('vancouver', CONFIG, fetcher=fetch,
                now='2026-10-20T09:00:00+00:00', directory=directory)
            self.assertEqual(first, (directory / 'vancouver.json').read_bytes())
            def failure(url):
                raise TimeoutError('source timeout')
            failed, errors = sync.sync_event('vancouver', CONFIG, fetcher=failure,
                now='2026-10-20T10:00:00+00:00', directory=directory)
            self.assertTrue(errors)
            self.assertEqual(failed['entries']['items'], obj['entries']['items'])
            self.assertEqual(failed['entries']['updated_at'], obj['entries']['updated_at'])
            self.assertEqual(failed['entries']['update_status'], 'error')
            corrected = ROSTER.replace('HKG LOU Zhanshuo M Active\n', '')
            with patch.object(sync, 'pdf_pages', return_value=[corrected]):
                fixed, errors = sync.sync_event('vancouver', CONFIG, fetcher=fetch,
                    now='2026-10-20T11:00:00+00:00', directory=directory)
            self.assertEqual(len(fixed['entries']['items']), 3)
            self.assertEqual(fixed['entries']['update_status'], 'ok')

    def test_current_site_transport_decoding_does_not_execute_scripts(self):
        events = [{'event_result_id': 200, 'name': 'Women 1000 m'}]
        frame = [1, '1:["$",null,{"eventResultsData":' + json.dumps(events) + '}]']
        html = '<script>self.__next_f.push(' + json.dumps(frame) + ')</script>'
        self.assertEqual(api.embedded_results(html), events)
        self.assertEqual(api.embedded_results('<script>dangerous()</script>'), [])

    def test_real_official_single_and_relay_response_shapes(self):
        fixtures = ROOT / 'tests/fixtures'
        for file, eid, rid, label in [('gdansk-2025-heats-sample.json', 200, 543, 'Women 1000 m'),
                                      ('gdansk-2025-relay-sample.json', 203, 561, 'Women 3000 m Relay')]:
            heats = api.api_data((fixtures / file).read_bytes())
            event = {'event_result_id': eid, 'name': label}
            meta = {'event_result_round_id': rid, 'name': 'Finals'}
            parsed = api.heat_items(heats, event, meta, 'https://isu-skating.com/event')
            self.assertEqual([p['group'] for p in parsed], ['A', 'B'])
            self.assertTrue(all(p['evidence'] == 'official_results' for p in parsed))
            self.assertEqual(sum(p['penalty'] is not None for h in parsed for p in h['participants']), 1 if eid == 200 else 0)
            corrupted = copy.deepcopy(heats)
            corrupted[0]['event_result_id'] = 999
            with self.assertRaises(ValueError):
                api.heat_items(corrupted, event, meta, 'https://isu-skating.com/event')

    def test_exact_round_mapping_and_provisional_start_list(self):
        heat = {'event_result_round_heats_id': 1, 'event_result_round_id': 2,
                'event_result_id': 3, 'name': 'Heat 2', 'status': 'Scheduled', 'result_status': '',
                'event_result_round_heats_competitors': [
                    {'started_for_nf_code': 'CHN', 'skaters': {'full_name': 'TEST Competitor'},
                     'bib_number': 1, 'final_rank': None, 'final_result': None}]}
        parsed = api.heat_items([heat], {'event_result_id': 3, 'name': 'Women 500 m'},
            {'event_result_round_id': 2, 'name': 'Preliminaries'}, SOURCE, build.read_schedule('vancouver'))
        self.assertEqual(parsed[0]['round_key'], build.read_schedule('vancouver')[0]['round_key'])
        self.assertEqual(parsed[0]['evidence'], 'official_start_list')
        self.assertTrue(parsed[0]['has_china'])
        self.assertEqual(parsed[0]['heat_number'], 2)
        self.assertIsNone(sync.penalty('DNF'))
        self.assertIsNone(sync.penalty('ADV'))
        self.assertEqual(sync.penalty('YC-2')['code'], 'YC-2')

    def test_ranking_pdf_distance_first_and_tied_ranks(self):
        text = ('Gdansk 2025\nWORLD RANKING\n1000 m Women\n'
                'Rank  Name                     ISU    Total\n'
                '1     SAMPLE Alpha             CHN    1000\n'
                '1     SAMPLE Beta              HKG    1000\n')
        with patch.object(sync,'pdf_pages',return_value=[text]):
            rounds, rankings = sync.parse_reports(b'%PDF',{'city':'Gdansk','year':2025},SOURCE)
        self.assertEqual(rounds,[])
        self.assertEqual(len(rankings),2)
        self.assertEqual({r['ranking_type'] for r in rankings},{'world'})
        self.assertEqual({r['points'] for r in rankings},{1000})
        self.assertEqual({r['rank'] for r in rankings},{1})

    def test_new_heat_feed_supplies_existing_highlights_and_corrections(self):
        obj = data.empty_snapshot('vancouver')
        obj['rounds']['updated_at'] = '2026-10-23T10:00:00+00:00'
        obj['rounds']['items'] = [dict(id='one', round_key=build.read_schedule('vancouver')[0]['round_key'],
            evidence='official_start_list', heat_number=2, source_url=SOURCE,
            participants=[dict(name='TEST Person',country='CHN')])]
        records, covered = data.china_evidence(obj)
        self.assertEqual(records[0]['heats'][0]['number'],2)
        self.assertEqual(len(covered),1)
        obj['rounds']['items'][0]['participants'][0]['country'] = 'HKG'
        records, corrected = data.china_evidence(obj)
        self.assertEqual(records,[])
        self.assertEqual(covered,corrected)

    def test_display_names_put_the_surname_last_everywhere(self):
        person = lambda name: dict(athlete_id=data.athlete_id(name, 'CHN', 'men'), name=name)
        obj = data.empty_snapshot('vancouver')
        obj['entries']['items'] = [person('LI Kun'), person('SONG KERUI'), person('VAN  \'T WOUT Jens')]
        obj['rounds']['items'] = [dict(participants=[person('Kun Li'), person('Kerui SONG')])]
        names = data.display_names(obj)
        # The entry PDF's capitals mark the surname; an all-capitals entry falls back to the feed.
        self.assertEqual(names[person('LI Kun')['athlete_id']], 'Kun LI')
        self.assertEqual(names[person('SONG KERUI')['athlete_id']], 'Kerui SONG')
        self.assertEqual(names[person('Jens VAN \'T WOUT')['athlete_id']], "Jens VAN 'T WOUT")
        self.assertIsNone(data.surname_last('Margherita Betti'))
        self.assertTrue(data.given_first('Ching Shun Nicole LAW'))
        self.assertFalse(data.given_first('SONG KERUI'))


if __name__ == '__main__':
    unittest.main()
