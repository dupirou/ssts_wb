import copy
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import competition_data as data
import build
import predict_groups
from compare_reviewed_groups import compare


class ReviewedGroupsTests(unittest.TestCase):
    def test_three_pages_and_known_prediction_match(self):
        reviewed = json.loads((ROOT / 'data/reviewed_groups/vancouver.json').read_text())
        baseline = json.loads((ROOT / 'data/reviewed_groups/vancouver_prediction_baseline.json').read_text())
        result = compare(reviewed, baseline)
        self.assertEqual([r['visible_people'] for r in result['items']], [44, 45, 42])
        self.assertEqual([r['ranked_people'] for r in result['items']], [24, 21, 19])
        for r in result['items']:
            self.assertEqual(r['ranked_people'], r['world_rank_matches'])
            self.assertEqual(r['ranked_people'], r['ranked_group_matches'])
            self.assertTrue(all(p['present_in_previous_entries'] for p in r['rows']))
            self.assertTrue(all(p['previous_heat_number'] is None for p in r['rows'] if p['world_rank'] is None))

    def test_published_overlay_does_not_pollute_sync_source_or_results(self):
        raw = data.empty_snapshot('vancouver')
        with patch.object(data, 'load_snapshot', return_value=copy.deepcopy(raw)):
            published = data.published_snapshot('vancouver')
        self.assertEqual(raw['rounds']['items'], [])
        groups = [h for h in published['rounds']['items'] if h['evidence'] == 'reviewed_seeding_image']
        self.assertEqual(len(groups), 24)
        self.assertEqual(sum(len(h['participants']) for h in groups), 131)
        self.assertTrue(all(h['partial_round'] and h['source_page'] == 1 and h['source_page_count'] == 2 for h in groups))
        self.assertTrue(all(p['starting_position'] is None and p['rank'] is None and p['result'] is None for h in groups for p in h['participants']))
        self.assertEqual(sum(h['has_china'] for h in groups), 7)
        self.assertTrue(all(build.valid_evidence(h['source_url']) for h in groups))
        predictions = predict_groups.project('vancouver', build.read_schedule(), published, predict_groups.load_inputs('vancouver'))
        self.assertTrue(all(i['status'] == 'official_available' and i['partial_round'] for i in predictions['items'] if i['gender'] == 'men'))

    def test_live_round_replaces_all_screenshot_groups_for_that_round(self):
        with patch.object(data, 'load_snapshot', return_value=data.empty_snapshot('vancouver')):
            published = data.published_snapshot('vancouver')
        live = copy.deepcopy(published['rounds']['items'][0])
        live.update(id='live-new', evidence='official_start_list', source_url='https://isu-skating.com/actual', partial_round=False)
        raw = data.empty_snapshot('vancouver')
        raw['rounds']['items'] = [live]
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            data.write_snapshot(raw, directory)
            result = data.published_snapshot('vancouver', directory)
        same_round = [h for h in result['rounds']['items'] if h['round_key'] == live['round_key']]
        self.assertEqual(same_round, [live])
        self.assertEqual(len(result['rounds']['items']), 16)


if __name__ == '__main__':
    unittest.main()
