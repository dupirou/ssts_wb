import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import competition_data as data
import predict_groups as model


def people(n):
    return [dict(athlete_id=f'test-{i}', name=f'TEST {i}', country='CHN' if i == 1 else f'A{chr(65+i//26)}{chr(65+i%26)}',
                 seed_rank=i, prequalified=False) for i in range(1, n + 1)]


def input_for(n=41, distance=500):
    participants = people(n)
    plan = model.first_round(distance, n)
    for p in participants[:plan['prequalified_count']]:
        p['prequalified'] = True
    return dict(schema_version=1, event_id='vancouver', seed_lists=[dict(event_id='vancouver',
        complete=True, gender='women', distance_m=distance, participants=participants,
        source_urls=['https://isu-skating.com/official-seeding.pdf'], verified_at='2026-10-22T15:00:00-07:00')])


class PredictionTests(unittest.TestCase):
    def test_official_table_boundaries(self):
        for distance, count, stage, heats, pre in [(500,26,'heats',6,0), (1000,40,'heats',8,0),
                (500,41,'preliminaries',5,20), (1500,26,'quarterfinal',5,0),
                (1500,63,'quarterfinal',9,0), (1500,64,'heats',7,20), (1500,95,'heats',11,20)]:
            self.assertEqual(model.first_round(distance,count), dict(round=stage,heat_count=heats,prequalified_count=pre))
        self.assertIsNone(model.first_round(500,25))
        self.assertIsNone(model.first_round(500,96))

    def test_snake_order_and_no_lane_assignment(self):
        groups, changes, clashes = model.snake_groups(people(10),3)
        self.assertEqual([[p['seed_rank'] for p in g['participants']] for g in groups],[[1,6,7],[2,5,8],[3,4,9,10]])
        self.assertEqual(changes,0)
        self.assertEqual(clashes,[])
        self.assertNotIn('starting_position',groups[0]['participants'][0])

    def test_country_moves_stay_in_same_seeding_row(self):
        p=people(9)
        p[5]['country']=p[0]['country']
        groups, changes, clashes=model.snake_groups(p,3)
        self.assertGreater(changes,0)
        self.assertEqual(clashes,[])
        for g in groups:
            self.assertEqual([int((p['seed_rank']-1)/3) for p in g['participants']],[0,1,2])
        self.assertEqual(sorted(p['athlete_id'] for g in groups for p in g['participants']),sorted(x['athlete_id'] for x in p))

    def test_quarterfinal_no_country_separation(self):
        p=people(6);p[5]['country']=p[0]['country']
        groups, changes, clashes=model.snake_groups(p,3,separate_country=False)
        self.assertEqual([x['seed_rank'] for x in groups[0]['participants']],[1,6])
        self.assertEqual(changes,0)
        self.assertEqual(clashes,[])

    def test_unavoidable_country_clash_is_explicit(self):
        p=people(8)
        for x in p:x['country']='CHN'
        groups, _, clashes=model.snake_groups(p,2)
        self.assertEqual(clashes,[1,2])
        self.assertEqual(sum(len(g['participants']) for g in groups),8)

    def test_first_round_separates_prequalified_and_keeps_projection_unconfirmed(self):
        inputs = input_for()
        inputs['checked_at'] = '2026-10-23T01:00:00+00:00'
        result=model.project('vancouver',build.read_schedule(),data.empty_snapshot('vancouver'),inputs)
        item=result['items'][0]
        self.assertEqual(item['status'],'predicted')
        self.assertEqual(len(item['prequalified']),20)
        self.assertEqual(sum(len(g['participants']) for g in item['groups']),21)
        self.assertEqual(len(item['groups']),5)
        self.assertEqual(result['evidence'],'model_prediction_not_official')
        self.assertEqual(result['checked_at'], inputs['checked_at'])
        self.assertEqual(data.china_evidence(data.empty_snapshot('vancouver'))[0],[])

    def test_roster_alone_does_not_become_distance_entries(self):
        result=model.project('vancouver',build.read_schedule(),data.load_snapshot('vancouver'))
        self.assertTrue(all(p['status']=='waiting_for_data' and not p['groups'] for p in result['items']))
        self.assertEqual(result['total'],6)

    def test_official_group_supersedes_model(self):
        snapshot=data.empty_snapshot('vancouver')
        snapshot['rounds']['items']=[dict(round_key=build.read_schedule()[0]['round_key'],
            evidence='official_start_list',source_url='https://isu-skating.com/official')]
        item=model.project('vancouver',build.read_schedule(),snapshot,input_for())['items'][0]
        self.assertEqual(item['status'],'official_available')
        self.assertEqual(item['groups'],[])

    def test_incomplete_tied_unverified_or_wrong_event_inputs_are_rejected(self):
        original=input_for()
        for modify in [lambda s:s.update(complete=False), lambda s:s.update(event_id='montreal'),
                lambda s:s.update(source_urls=['https://example.com/ranking']),
                lambda s:s.update(verified_at='2026-10-22'),
                lambda s:s['participants'][0].update(prequalified=None),
                lambda s:s['participants'][1].update(seed_rank=1)]:
            candidate=copy.deepcopy(original);modify(candidate['seed_lists'][0])
            with self.assertRaises(ValueError):model.project('vancouver',build.read_schedule(),data.empty_snapshot('vancouver'),candidate)

    def test_wrong_schedule_and_unconfirmed_byes_block_prediction(self):
        inp=input_for();inp['seed_lists'][0]['participants'][0]['prequalified']=False
        item=model.project('vancouver',build.read_schedule(),data.empty_snapshot('vancouver'),inp)['items'][0]
        self.assertEqual(item['missing'],['prequalification_list'])
        inp=input_for(n=40)
        item=model.project('vancouver',build.read_schedule(),data.empty_snapshot('vancouver'),inp)['items'][0]
        self.assertEqual(item['missing'],['matching_schedule'])


if __name__ == '__main__':unittest.main()
