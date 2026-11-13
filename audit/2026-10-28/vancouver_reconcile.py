#!/usr/bin/env python3
"""Compare Vancouver official heat rows with the baseline without importing production parsers."""
import json
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from official_reconcile import ROOT, OUTPUT, fetch, request_key

source = json.loads((ROOT / 'data/competitions/vancouver.json').read_text(encoding='utf-8'))
heats = [h for h in source['rounds']['items'] if h.get('evidence') == 'official_results']
jobs, metadata = {}, {}
for h in heats:
    q = parse_qs(urlsplit(h['source_url']).query)
    if not (q.get('type') and q.get('round')):
        continue
    endpoint = 'team' if h['format'] == 'relay' else 'single'
    doc = {'url': 'https://front-api.isu.org/events/get-event-result-round-heats-stk-' + endpoint,
           'form': {'event_result_id': q['type'][0], 'event_result_round_id': q['round'][0], 'country_code': ''}}
    key = request_key(doc)
    jobs[key] = doc
    metadata[h['id']] = key

print('VANCOUVER HEATS', len(heats), 'OFFICIAL ROUND REQUESTS', len(jobs), flush=True)
responses, errors = {}, {}
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(fetch, doc): key for key, doc in jobs.items()}
    for i, future in enumerate(as_completed(futures), 1):
        try:
            responses[futures[future]] = future.result()
        except Exception as exc:
            errors[futures[future]] = str(exc)
        if i % 20 == 0 or i == len(futures):
            print('VANCOUVER RESPONSES', i, '/', len(futures), flush=True)

outcomes, reverse = [], []
missing_heats = []
for key, info in responses.items():
    stored_ids = {h['id'] for h in heats if metadata.get(h['id']) == key}
    for official_heat in info['rows']:
        hid = 'isu-heat-' + str(official_heat['event_result_round_heats_id'])
        if hid not in stored_ids:
            missing_heats.append({'heat_id':hid, 'name':official_heat.get('name'),
                                  'result_status':official_heat.get('result_status'), 'source':jobs[key],
                                  'official_sha256':info['sha256']})
for heat in heats:
    key = metadata.get(heat['id'])
    info = responses.get(key)
    official = [] if not info else [r for r in info['rows'] if 'isu-heat-' + str(r['event_result_round_heats_id']) == heat['id']]
    entries = [] if len(official) != 1 else official[0].get('event_result_round_heats_competitors',
                                                            official[0].get('event_result_round_heats_teams', []))
    identity_key = 'skaters_team_id' if heat['format'] == 'relay' else 'skaters_id'
    for person in heat['participants']:
        record = {'event': '2026-27-worldtour-vancouver-1', 'discipline': [heat['gender'], heat['distance_m'], heat['format']],
                  'round': heat['round_label'], 'group': heat.get('group'), 'heat': heat['heat_label'],
                  'heat_id': heat['id'], 'name': person['name'], 'country': person['country'],
                  'official_id': person.get('official_skater_id'), 'official_source': jobs.get(key),
                  'official_sha256': info['sha256'] if info else None, 'checked_fields': [], 'differences': [],
                  'outcome': 'unverified', 'reason': 'official_heat_or_identity_missing'}
        candidates = [p for p in entries if p.get(identity_key) == person.get('official_skater_id')
                      and p.get('started_for_nf_code') == person.get('country')]
        fields = ('starting_position', 'final_rank', 'final_result', 'qualification_code', 'bib_number', 'started_for_nf_code')
        signatures = {tuple(str(p.get(f) or '') for f in fields) for p in candidates}
        if len(signatures) == 1:
            item = candidates[0]
            mapping = {'starting_position': 'starting_position', 'final_rank': 'rank', 'final_result': 'result',
                       'qualification_code': 'qualification', 'bib_number': 'helmet_number', 'started_for_nf_code': 'country'}
            for official_field, repo_field in mapping.items():
                left = item.get(official_field)
                right = person.get(repo_field)
                if left in ('', None): left = None
                if right in ('', None): right = None
                if official_field in ('starting_position', 'final_rank', 'bib_number'):
                    if left is not None: left = int(left)
                    if right is not None: right = int(right)
                record['checked_fields'].append(repo_field)
                if left != right:
                    record['differences'].append({'field': repo_field, 'official': left, 'repository': right})
            record['outcome'] = 'difference' if record['differences'] else 'matched_checked_fields'
            record['reason'] = 'selected_fields_only; no independent name, qualification rule or referee-code audit'
        outcomes.append(record)
    existing = {(p.get('official_skater_id'), p.get('country')) for p in heat['participants']}
    for p in entries:
        pair = (p.get(identity_key), p.get('started_for_nf_code'))
        if pair not in existing:
            reverse.append({'heat_id': heat['id'], 'official_id': pair[0], 'country': pair[1],
                            'rank': p.get('final_rank'), 'result': p.get('final_result'), 'sha256': info['sha256']})

with (OUTPUT / 'vancouver_heat_checks.jsonl').open('w', encoding='utf-8') as f:
    for record in outcomes:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')
(OUTPUT / 'vancouver_missing_candidates.json').write_text(json.dumps(reverse, ensure_ascii=False, indent=2), encoding='utf-8')
(OUTPUT / 'vancouver_missing_heats.json').write_text(json.dumps(missing_heats, ensure_ascii=False, indent=2), encoding='utf-8')
(OUTPUT / 'vancouver_request_errors.json').write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding='utf-8')
print('VANCOUVER OUTCOMES', dict(Counter(r['outcome'] for r in outcomes)), 'REVERSE CANDIDATES', len(reverse),
      'MISSING HEATS',len(missing_heats),flush=True)
