#!/usr/bin/env python3
"""Compare each recorded inventory scope with all pages of the current ISU event list."""
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from official_reconcile import ROOT, OUTPUT, fetch, request_key

inventory = json.loads((ROOT / 'data/history/inventory.json').read_text(encoding='utf-8'))
catalog = json.loads((ROOT / 'data/history/catalog.json').read_text(encoding='utf-8'))
jobs = {}
for scope in inventory['scopes']:
    source = scope['source']
    jobs[request_key(source)] = source


def read_all_pages(source):
    pages = [fetch(source)]
    total = int(pages[0]['pagination'].get('total_page') or 1)
    if total > 100: raise ValueError('Unexpectedly large pagination')
    for page in range(2, total + 1):
        doc = {'url': source['url'], 'form': dict(source['form'], page=page)}
        pages.append(fetch(doc))
    return pages


def classify(item):
    name = (item.get('name') or '').lower()
    subtype = (item.get('event_sub_type_name') or '').lower()
    text = name + ' ' + subtype
    if 'junior' in text or 'youth' in text: return None
    if 'olympic' in text: return 'olympics'
    if 'four continents' in text: return 'fourcontinents'
    if 'world tour' in text: return 'worldtour'
    if 'world cup' in text: return 'worldcup'
    if 'world' in text and 'championship' in text: return 'worlds'
    return None


answers, errors = {}, {}
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(read_all_pages, source): key for key, source in jobs.items()}
    for future in as_completed(futures):
        try: answers[futures[future]] = future.result()
        except Exception as ex: errors[futures[future]] = str(ex)
rows = []
for scope in inventory['scopes']:
    pages = answers.get(request_key(scope['source']))
    item = {'season': scope['season'], 'kind': scope['kind'], 'old_official_ids': scope['official_event_ids'],
            'repository_ids': [str(e.get('official_event_id')) for e in catalog['events']
                               if e['season'] == scope['season'] and e['kind'] == scope['kind']],
            'official_request': scope['source'], 'status': 'unverified'}
    if pages:
        available = [x for p in pages for x in p['rows'] if classify(x) == scope['kind']]
        ids = {str(x['event_id']) for x in available}
        item.update(status='compared', official_ids=sorted(ids), total_pages=len(pages),
                    response_sha256=[p['sha256'] for p in pages],
                    current_directory_not_in_repository=sorted(ids - set(item['repository_ids'])),
                    repository_not_in_current_directory=sorted(set(item['repository_ids']) - ids),
                    current_directory_not_in_previous_inventory=sorted(ids - set(item['old_official_ids'])))
    rows.append(item)
(OUTPUT / 'official_directory_scopes.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
(OUTPUT / 'official_directory_errors.json').write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding='utf-8')
print('SCOPES',len(rows),'UNVERIFIED',len(errors), 'IDS_MISSING',sum(len(r.get('current_directory_not_in_repository',[])) for r in rows),
      'IDS_NOT_CURRENT',sum(len(r.get('repository_not_in_current_directory',[])) for r in rows),flush=True)
