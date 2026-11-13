#!/usr/bin/env python3
"""Reverse-check official round and heat IDs against Vancouver's stored snapshot."""
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from official_reconcile import ROOT, OUTPUT, fetch, request_key

snapshot = json.loads((ROOT / 'data/competitions/vancouver.json').read_text(encoding='utf-8'))
stored, disciplines = {}, {}
for h in snapshot['rounds']['items']:
    q = parse_qs(urlsplit(h['source_url']).query)
    if not (q.get('type') and q.get('round')): continue
    result_id, round_id = q['type'][0], q['round'][0]
    disciplines[result_id] = {'gender':h['gender'],'distance_m':h['distance_m'],'format':h['format']}
    stored.setdefault((result_id,round_id),set()).add(h['id'])
jobs = [{'url':'https://front-api.isu.org/events/get-event-result-round',
         'form':{'event_result_id':rid}} for rid in disciplines]
responses, errors = {}, []
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(fetch, doc):doc for doc in jobs}
    for f in as_completed(futures):
        try: responses[futures[f]['form']['event_result_id']] = f.result()
        except Exception as ex: errors.append({'source':futures[f],'error':str(ex)})
unrepresented, all_rounds = [], []
for result_id, info in responses.items():
    for row in info['rows']:
        rid = str(row['event_result_round_id'])
        item = {'official_result_id':result_id,'official_round_id':rid,'name':row.get('name'),
                'stored_heats':len(stored.get((result_id,rid),[])), 'metadata_sha256':info['sha256']}
        all_rounds.append(item)
        if not item['stored_heats']:
            doc = {'url':'https://front-api.isu.org/events/get-event-result-round-heats-stk-' + ('team' if disciplines[result_id]['format']=='relay' else 'single'),
                   'form':{'event_result_id':result_id,'event_result_round_id':rid,'country_code':''}}
            unrepresented.append((item,doc))
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(fetch,doc):(item,doc) for item,doc in unrepresented}
    for f in as_completed(futures):
        item,doc = futures[f]
        try:
            response = f.result()
            item['official_heats'] = len(response['rows'])
            item['official_participants'] = sum(len(x.get('event_result_round_heats_competitors',x.get('event_result_round_heats_teams',[]))) for x in response['rows'])
            item['heat_sha256'] = response['sha256']
        except Exception as ex: item['fetch_error'] = str(ex)
report = {'disciplines':disciplines,'rounds':all_rounds,'metadata_errors':errors,
          'unrepresented_rounds':[item for item,doc in unrepresented]}
(OUTPUT / 'vancouver_round_coverage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('DISCIPLINES',len(disciplines),'OFFICIAL ROUNDS',len(all_rounds),'UNREPRESENTED',len(unrepresented),
      'UNREPRESENTED_WITH_PARTICIPANTS',sum(x.get('official_participants',0)>0 for x,d in unrepresented),'ERRORS',len(errors),flush=True)
