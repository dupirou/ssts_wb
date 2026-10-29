#!/usr/bin/env python3
"""Compare recorded prior finals and current official heat evidence for adopted conflicts."""
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from official_reconcile import ROOT, OUTPUT, fetch, request_key, included

catalog = json.loads((ROOT / 'data/history/catalog.json').read_text(encoding='utf-8'))
targets, jobs = [], {}
for meta in catalog['events']:
    event = json.loads((ROOT / 'data/history/events' / (meta['id'] + '.json')).read_text(encoding='utf-8'))
    for row in event['results']:
        previous = row.get('previous_final_result') or {}
        if not included(row) or row.get('classification_resolution') != 'current_official_classification': continue
        doc = next((d for d in event['source']['documents'] if d['sha256'] == previous.get('source_ref')
                    and 'round-heats' in d['url']), None)
        targets.append((meta, row, doc))
        if doc: jobs[request_key(doc)] = doc

responses, errors = {}, {}
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(fetch, doc): key for key, doc in jobs.items()}
    for i, future in enumerate(as_completed(futures), 1):
        try: responses[futures[future]] = future.result()
        except Exception as exc: errors[futures[future]] = str(exc)
        if i % 25 == 0 or i == len(futures): print('FINAL HEAT RESPONSES',i,'/',len(futures),flush=True)

records = []
for meta, row, doc in targets:
    r = {'event_id':meta['id'],'season':meta['season'],'gender':row['gender'],'distance_m':row['distance_m'],
         'format':row['format'],'name':row['name'],'official_id':row.get('official_skater_id'),
         'adopted_overall_rank':row['rank'],'previous_final_result':row['previous_final_result'],
         'outcome':'unverified','reason':'no_retrievable_heat_source'}
    info = responses.get(request_key(doc)) if doc else None
    if info:
        candidates = []
        identity = 'skaters_team_id' if row['format'] == 'relay' else 'skaters_id'
        for heat in info['rows']:
            people = heat.get('event_result_round_heats_competitors',heat.get('event_result_round_heats_teams',[]))
            for p in people:
                if p.get(identity) == row.get('official_skater_id') and p.get('started_for_nf_code') == 'CHN':
                    candidates.append((heat,p))
        if len(candidates) == 1:
            heat, person = candidates[0]
            r.update(outcome='heat_observed',reason='official_revision_order_not_proven',
                     current_heat_name=heat.get('name'), current_heat_rank=person.get('final_rank'),
                     current_heat_status=person.get('final_result'), heat_source=doc['url'],heat_form=doc['form'],
                     heat_sha256=info['sha256'],
                     matches_previous_final_rank=str(person.get('final_rank')) == str(row['previous_final_result'].get('rank')))
    records.append(r)
(OUTPUT / 'classification_conflict_checks.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
(OUTPUT / 'classification_conflict_errors.json').write_text(json.dumps(errors,ensure_ascii=False,indent=2),encoding='utf-8')
print('ADOPTED CONFLICTS',len(records),'HEAT SOURCE REQUESTS',len(jobs),
      'OUTCOMES',dict(Counter(r['outcome'] for r in records)),
      'CURRENT HEAT MATCHES PRIOR',sum(r.get('matches_previous_final_rank',False) for r in records),flush=True)
