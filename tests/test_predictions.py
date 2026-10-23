import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import competition_data as data
import predict_groups as model


def people(n, ranked=None):
    """n entrants in world-rank order; the first `ranked` have a world rank (all by default)."""
    ranked = n if ranked is None else ranked
    return [dict(athlete_id=f'test-{i}', name=f'TEST {i}', country='CHN' if i == 1 else f'A{chr(65+i//26)}{chr(65+i%26)}',
                 world_rank=i if i <= ranked else None, prequalified=False) for i in range(1, n + 1)]


def inputs(n=41, distance=500, ranked=None):
    participants = people(n, ranked)
    plan = model.first_round(distance, n)
    for p in participants[:plan['prequalified_count']]:
        p['prequalified'] = True
    return dict(schema_version=2, event_id='vancouver', checked_at='2026-10-23T01:00:00+00:00', lists=[dict(
        gender='women', distance_m=distance, missing=[], participants=participants,
        source_urls=['https://isu-skating.com/entries'], verified_at='2026-10-22T15:00:00-07:00')])


def project(inp, snapshot=None):
    return model.project('vancouver', build.read_schedule('vancouver'), snapshot or data.empty_snapshot('vancouver'), inp)


class PredictionTests(unittest.TestCase):
    def test_official_table_boundaries(self):
        for distance, count, stage, heats, pre in [(500,26,'heats',6,0), (1000,40,'heats',8,0),
                (500,41,'preliminaries',5,20), (1500,26,'quarterfinal',5,0),
                (1500,63,'quarterfinal',9,0), (1500,64,'heats',7,20), (1500,95,'heats',11,20)]:
            self.assertEqual(model.first_round(distance,count), dict(round=stage,heat_count=heats,prequalified_count=pre))
        self.assertIsNone(model.first_round(500,25))
        self.assertIsNone(model.first_round(500,96))

    def test_snake_order_and_sizes(self):
        groups, clashes = model.snake_groups(people(10), 3)
        self.assertEqual([[p['world_rank'] for p in g] for g in groups], [[1,6,7],[2,5,8],[3,4,9,10]])
        self.assertEqual(clashes, [])
        self.assertEqual(model.heat_sizes(10, 3), [3, 3, 4])
        self.assertEqual(model.heat_sizes(31, 7), [5, 5, 5, 4, 4, 4, 4])
        self.assertEqual(model.heat_sizes(9, 3), [3, 3, 3])

    def test_country_moves_stay_in_same_seeding_row(self):
        p = people(9)
        p[5]['country'] = p[0]['country']
        groups, clashes = model.snake_groups(p, 3)
        self.assertEqual(clashes, [])
        for g in groups:
            self.assertEqual([(x['world_rank'] - 1) // 3 for x in g], [0, 1, 2])
        self.assertEqual(sorted(x['athlete_id'] for g in groups for x in g), sorted(x['athlete_id'] for x in p))

    def test_quarterfinal_no_country_separation(self):
        p = people(6)
        p[5]['country'] = p[0]['country']
        groups, clashes = model.snake_groups(p, 3, separate_country=False)
        self.assertEqual([x['world_rank'] for x in groups[0]], [1, 6])
        self.assertEqual(clashes, [])

    def test_unavoidable_country_clash_is_explicit(self):
        p = people(8)
        for x in p:
            x['country'] = 'CHN'
        groups, clashes = model.snake_groups(p, 2)
        self.assertEqual(clashes, [1, 2])
        self.assertEqual(sum(len(g) for g in groups), 8)

    def test_only_known_seeds_are_placed_and_the_rest_are_counted(self):
        result = project(inputs(41, ranked=30))
        item = result['items'][0]
        self.assertEqual(item['status'], 'predicted')
        self.assertEqual(len(item['prequalified']), 20)
        self.assertEqual(len(item['groups']), 5)
        # 21 race; 10 have a world rank and get seeds 1–10, 11 are seeded by unpublished entry times.
        self.assertEqual([p['seed_rank'] for g in item['groups'] for p in g['participants']], [1, 10, 2, 9, 3, 8, 4, 7, 5, 6])
        self.assertEqual(len(item['unseeded']), 11)
        self.assertEqual(sum(g['size'] for g in item['groups']), 21)
        self.assertEqual(result['evidence'], 'model_prediction_not_official')
        self.assertEqual(result['checked_at'], '2026-10-23T01:00:00+00:00')
        self.assertEqual(data.china_evidence(data.empty_snapshot('vancouver'))[0], [])

    def test_without_distance_entries_nothing_is_predicted(self):
        result = project(None)
        self.assertTrue(all(p['status'] == 'waiting_for_data' and p['missing'] == ['distance_entries'] for p in result['items']))
        self.assertEqual(result['total'], 6)

    def test_official_group_supersedes_model(self):
        snapshot = data.empty_snapshot('vancouver')
        snapshot['rounds']['items'] = [dict(round_key=build.read_schedule('vancouver')[0]['round_key'],
            evidence='official_start_list', source_url='https://isu-skating.com/official')]
        item = project(inputs(), snapshot)['items'][0]
        self.assertEqual(item['status'], 'official_available')
        self.assertEqual(item['groups'], [])

    def test_undecided_byes_or_wrong_schedule_block_prediction(self):
        inp = inputs()
        inp['lists'][0]['missing'] = ['prequalification_tie']
        self.assertEqual(project(inp)['items'][0]['missing'], ['prequalification_tie'])
        self.assertEqual(project(inputs(n=40))['items'][0]['missing'], ['matching_schedule'])

    def test_athletes_get_their_entered_distances(self):
        inp = inputs()
        inp['lists'].append(dict(inp['lists'][0], distance_m=1000))
        from unittest.mock import patch
        with patch.object(model, 'load_inputs', lambda event_id: inp):
            self.assertEqual(model.entered_distances('vancouver')['test-1'], [500, 1000])


if __name__ == '__main__':
    unittest.main()
