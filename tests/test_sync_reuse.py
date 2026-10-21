"""Already-final official data must not be requested from ISU again."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import competition_data as data
import isu_results as api
import sync_competitions as sync
import sync_predictions as predictions

CONFIG = {'city': 'Vancouver', 'year': 2026,
          'documents_url': 'https://isu-skating.com/event?tab=documents',
          'results_url': 'https://isu-skating.com/event?tab=results'}
SOURCE = 'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/entries.pdf'
EVENT = dict(discipline_id=3, start_date='2026-10-23', event_result_id=11, event_id=5,
             name='Women 500 m', discipline_type='Singles')


def results_page(events):
    frame = [1, '1:["$",null,{"eventResultsData":' + json.dumps(events) + '}]']
    return ('<script>self.__next_f.push(' + json.dumps(frame) + ')</script>').encode()


def stored(rid, status='Official', evidence='official_results', round_='heats', group=None):
    return dict(id=f'isu-heat-{rid}', source_url=CONFIG['results_url'] + f'&type=11&round={rid}',
                evidence=evidence, result_status=status, round=round_, group=group)


class Recorder:
    def __init__(self, metas=()):
        self.calls, self.metas = [], list(metas)

    def __call__(self, endpoint, form):
        self.calls.append((endpoint, form.get('event_result_round_id')))
        rows = self.metas if endpoint.endswith('get-event-result-round') else []
        return json.dumps(dict(status=200, data=rows)).encode()


class ReuseTests(unittest.TestCase):
    def test_completed_discipline_is_not_requested(self):
        known = [stored(1), stored(2, round_='final', group='A')]
        fetch = Recorder()
        rounds = api.collect(results_page([EVENT]), CONFIG, fetch, known=known)
        self.assertEqual(fetch.calls, [])
        self.assertEqual({r['id'] for r in rounds}, {'isu-heat-1', 'isu-heat-2'})

    def test_only_unfinished_rounds_are_requested(self):
        meta = lambda rid: dict(event_result_id=11, event_id=5, event_result_round_id=rid, name='Heats')
        known = [stored(1), stored(2, status='Unofficial'), stored(3, evidence='official_start_list', status=None)]
        fetch = Recorder([meta(1), meta(2), meta(3), meta(4)])
        rounds = api.collect(results_page([EVENT]), CONFIG, fetch, known=known)
        self.assertEqual([c[1] for c in fetch.calls], [None, '2', '3', '4'])
        self.assertEqual([r['id'] for r in rounds], ['isu-heat-1'])

    def test_parsed_entry_pdf_is_not_downloaded_again(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot = data.empty_snapshot('vancouver')
            person = dict(id='ath-1', athlete_id='ath-1', name='SUN Long', country='CHN', gender='men', participation='active')
            snapshot['entries'].update(status='available', update_status='ok', items=[person],
                                       source_urls=[SOURCE], checked_at='2026-10-20T00:00:00+00:00')
            data.write_snapshot(snapshot, Path(temp))
            fetched = []

            def fetcher(url):
                fetched.append(url)
                if url == CONFIG['documents_url']:
                    return f'<h1>Vancouver 2026</h1><a href="{SOURCE}">Entries 15.10.2026</a>'.encode()
                raise OSError('offline')
            result, _ = sync.sync_event('vancouver', CONFIG, fetcher, '2026-10-21T00:00:00+00:00', Path(temp))
        self.assertNotIn(SOURCE, fetched)
        self.assertEqual(result['entries']['items'], [person])
        self.assertEqual(result['entries']['update_status'], 'ok')

    def test_frozen_historic_rankings_are_fetched_once(self):
        catalog = {}
        for n, key in enumerate([(('women', 500), 'WCD'), (('women', 500), 'WRD')], 600):
            catalog[key] = dict(world_standings_list_fsk_id=n, season_name='2025/2026', gender='Women',
                                discipline_distance='500', type=key[1], level_name='Senior')
        pages = []

        def sender(url, payload):
            rid = payload['world_standings_list_fsk_id']
            pages.append(rid)
            meta = next(m for m in catalog.values() if m['world_standings_list_fsk_id'] == rid)
            row = dict(world_standings_list_fsk_id=rid, skaters_id=7, skaters=dict(id=7), rank=1,
                       points=100, nf_for_country_code='CHN')
            return json.dumps(dict(status=200, current_page=1, total_page=1, total_items=1, is_next_page='N',
                                  detail=meta, data=[row])).encode()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'historic_rankings.json'
            first = predictions.cached_rankings(catalog, sender, '2025/2026', path)
            second = predictions.cached_rankings(catalog, sender, '2025/2026', path)
            self.assertEqual(sorted(pages), [600, 601])
            self.assertEqual(first, second)
            self.assertEqual(second[('women', 500), 'WCD'][7]['rank'], 1)
            predictions.cached_rankings(catalog, sender, '2026/2027', path)
            self.assertEqual(len(pages), 4)


if __name__ == '__main__':
    unittest.main()
