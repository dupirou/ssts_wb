#!/usr/bin/env python3
"""Read-only independent audit of stored history against public ISU responses.

Stores each exact response compressed outside the checkout and records its digest.
Only fields actually compared count as checked; matching a rank is not a complete
verification of a record. This script does not import the production parser.
"""
import csv
import gzip
import hashlib
import json
import os
import re
import ssl
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
import time

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(__file__).resolve().parent
EVIDENCE = ROOT.parent / 'ssts-audit-evidence-20261028' / 'api'
EVIDENCE.mkdir(parents=True, exist_ok=True)
NOW = datetime.now(timezone.utc).isoformat()
STATUS = {'PEN', 'DNS', 'DNF', 'DSQ', 'YC', 'RC'}


def included(row):
    return (row.get('format') == 'individual' and row.get('distance_m') in (500, 1000, 1500)) or (
        row.get('format') == 'relay' and row.get('distance_m') in (2000, 3000, 5000)
    )


def request_key(document):
    return hashlib.sha256(json.dumps([document['url'], document['form']], sort_keys=True).encode()).hexdigest()


def fetch(document):
    url, form = document['url'], document['form']
    if urlsplit(url).hostname != 'front-api.isu.org':
        raise ValueError('Not an ISU API host')
    key = request_key(document)
    path = EVIDENCE / (key + '.json.gz')
    if path.exists() and os.environ.get('SSTS_AUDIT_USE_CACHE') == '1':
        body = gzip.decompress(path.read_bytes())
    else:
        request = Request(url, data=urlencode(form).encode(), headers={'User-Agent': 'SSTS-WB-Audit/1.0'})
        for attempt in range(3):
            try:
                with urlopen(request, timeout=30, context=ssl.create_default_context()) as response:
                    body = response.read(20000001)
                if len(body) > 20000000:
                    raise ValueError('Response exceeded 20 MB')
                break
            except (HTTPError, URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(2**attempt)
        path.write_bytes(gzip.compress(body))
    data = json.loads(body)
    if data.get('status') != 200 or not isinstance(data.get('data'), list):
        raise ValueError('Unsupported ISU response')
    return {'rows': data['data'], 'sha256': hashlib.sha256(body).hexdigest(), 'evidence': str(path),
            'url': url, 'form': form,
            'retrieved_at': datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            'pagination': {key: data.get(key) for key in ('total_page', 'current_page', 'is_next_page', 'total_items')}}


def main():
    catalog = json.loads((ROOT / 'data/history/catalog.json').read_text(encoding='utf-8'))
    inventory = json.loads((ROOT / 'data/history/inventory.json').read_text(encoding='utf-8'))
    jobs = {}
    data = []
    for meta in catalog['events']:
        event = json.loads((ROOT / 'data/history/events' / (meta['id'] + '.json')).read_text(encoding='utf-8'))
        data.append((meta, event))
        if event['source'].get('kind') != 'isu_api':
            continue
        target_ids = {p.get('official_result_id') for p in event.get('programme', []) if included(p)}
        for doc in event['source']['documents']:
            if doc['form'].get('event_result_id') in target_ids and (
                'get-event-result-fsk-single' in doc['url'] or 'get-event-result-fsksys-team' in doc['url']
            ):
                jobs[request_key(doc)] = doc
        for row in event['results']:
            if included(row) and row.get('rank_scope') == 'final':
                for doc in event['source']['documents']:
                    if doc['sha256'] == row.get('source_ref') and 'round-heats' in doc['url']:
                        jobs[request_key(doc)] = doc
    print('OFFICIAL API REQUESTS', len(jobs), flush=True)
    results, errors = {}, {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(fetch, doc): key for key, doc in jobs.items()}
        for i, future in enumerate(as_completed(futures), 1):
            key = futures[future]
            try:
                results[key] = future.result()
            except Exception as exc:
                errors[key] = str(exc)
            if i % 50 == 0 or i == len(futures):
                print('OFFICIAL RESPONSES', i, '/', len(futures), 'errors', len(errors), flush=True)
    evidence_manifest = [{k: v for k, v in x.items() if k != 'rows'} for x in results.values()]
    (OUTPUT / 'official_api_manifest.json').write_text(json.dumps(evidence_manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (OUTPUT / 'official_api_errors.json').write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding='utf-8')
    matrix, checks, reverse_candidates = [], [], []
    scopes = {(s['season'], s['kind']): s for s in inventory['scopes']}
    for meta, event in data:
        source = event['source']
        docs = source.get('documents', [])
        event_checks = []
        rows = [r for r in event['results'] if included(r)]
        for row in rows:
            result = {'event_id': meta['id'], 'season': meta['season'], 'gender': row['gender'],
                      'distance_m': row['distance_m'], 'format': row['format'], 'name': row['name'],
                      'official_skater_id': row.get('official_skater_id'), 'rank_scope': row.get('rank_scope', 'overall'),
                      'repository_rank': row.get('rank'), 'repository_status': row.get('status'),
                      'source_kind': source.get('kind', 'pdf'), 'checked_fields': [], 'differences': [],
                      'outcome': 'unverified', 'reason': 'official_source_not_compared'}
            if source.get('kind') == 'isu_api' and row.get('official_result_id'):
                doc = next((d for d in docs if d['form'].get('event_result_id') == row['official_result_id'] and (
                    'get-event-result-fsk-single' in d['url'] or 'get-event-result-fsksys-team' in d['url'])), None)
                if doc and request_key(doc) in results:
                    response = results[request_key(doc)]
                    result.update(official_url=doc['url'], official_form=doc['form'], response_sha256=response['sha256'])
                    key = 'skaters_id' if row['format'] == 'individual' else 'skaters_team_id'
                    ids = set(row.get('team_source_ids', [row.get('official_skater_id')]))
                    matches = [r for r in response['rows'] if r.get('started_for_nf_code') == 'CHN' and r.get(key) in ids]
                    if len(matches) == 1:
                        off = matches[0]
                        result['checked_fields'] += ['country', 'official_identity']
                        for field in ('event_id', 'event_result_id'):
                            result['checked_fields'].append('official_' + field)
                            if str(off.get(field)) != str(doc['form'].get(field)):
                                result['differences'].append({'field': field, 'official': off.get(field), 'repository': doc['form'].get(field)})
                        official_rank = off.get('final_rank')
                        result['official_rank'] = official_rank
                        result['official_status'] = off.get('final_result')
                        if row.get('rank_scope', 'overall') == 'overall' and official_rank is not None:
                            result['checked_fields'].append('overall_rank')
                            if int(official_rank) != row.get('rank'):
                                result['differences'].append({'field': 'overall_rank', 'official': official_rank, 'repository': row.get('rank')})
                        if off.get('final_result') in STATUS:
                            result['checked_fields'].append('status')
                            if off['final_result'] != row.get('status'):
                                result['differences'].append({'field': 'status', 'official': off['final_result'], 'repository': row.get('status')})
                        result['outcome'] = 'difference' if result['differences'] else 'partially_checked'
                        result['reason'] = 'other_fields_not_independently_compared'
                    else:
                        result['reason'] = 'missing_or_ambiguous_official_identity'
                elif doc:
                    result['reason'] = 'official_request_failed'
                else:
                    result['reason'] = 'classification_source_not_recorded'
            event_checks.append(result)
            checks.append(result)
        if source.get('kind') == 'isu_api':
            for programme in event.get('programme', []):
                if not included(programme):
                    continue
                pid = programme.get('official_result_id')
                doc = next((d for d in docs if d['form'].get('event_result_id') == pid and (
                    'get-event-result-fsk-single' in d['url'] or 'get-event-result-fsksys-team' in d['url'])), None)
                if not doc or request_key(doc) not in results:
                    continue
                response = results[request_key(doc)]
                id_key = 'skaters_team_id' if programme['format'] == 'relay' else 'skaters_id'
                stored_ids = set()
                for row in rows:
                    if row.get('official_result_id') == pid:
                        stored_ids.update(row.get('team_source_ids', [row.get('official_skater_id')]))
                for off in response['rows']:
                    if off.get('started_for_nf_code') == 'CHN' and off.get(id_key) not in stored_ids:
                        reverse_candidates.append({'event_id': meta['id'], 'official_result_id': pid,
                            'format': programme['format'], 'gender': programme['gender'], 'distance_m': programme['distance_m'],
                            'official_id': off.get(id_key), 'official_rank': off.get('final_rank'),
                            'response_sha256': response['sha256'], 'source_url': doc['url'],
                            'source_form': doc['form'], 'status': 'candidate_requires_identity_and_scope_review'})
        counter = Counter(x['outcome'] for x in event_checks)
        scope = scopes.get((meta['season'], meta['kind']))
        matrix.append({'event_id': meta['id'], 'season': meta['season'], 'kind': meta['kind'],
                       'title': meta['title'], 'date_start': meta['date_start'], 'date_end': meta['date_end'],
                       'official_event_id': meta.get('official_event_id'), 'coverage': meta['coverage'],
                       'participation': event.get('participation'), 'source_kind': source.get('kind', 'pdf'),
                       'source_url': source['url'], 'source_sha256': source['sha256'], 'source_pages': source.get('pages'),
                       'programme_json': json.dumps(event.get('programme'), ensure_ascii=False),
                       'rank_scopes': json.dumps(dict(Counter(r.get('rank_scope', 'overall') for r in rows))),
                       'stored_rows': len(rows), 'individual_rows': sum(r['format'] == 'individual' for r in rows),
                       'relay_rows': sum(r['format'] == 'relay' for r in rows),
                       'athletes': len({r.get('athlete_id') for r in rows if r.get('athlete_id')}),
                       'partial_field_checks': counter['partially_checked'], 'differences': counter['difference'],
                       'unverified': counter['unverified'], 'fully_verified': 0,
                       'directory_evidence': scope['source']['url'] if scope else '',
                       'known_missing_disciplines': json.dumps(event.get('missing_disciplines', []))})
    with (OUTPUT / 'history_event_matrix.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(matrix[0]))
        writer.writeheader()
        writer.writerows(matrix)
    with (OUTPUT / 'history_record_checks.jsonl').open('w', encoding='utf-8') as f:
        for row in checks:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    (OUTPUT / 'history_reverse_candidates.json').write_text(json.dumps(reverse_candidates, ensure_ascii=False, indent=2), encoding='utf-8')
    print('HISTORY OUTCOMES', dict(Counter(r['outcome'] for r in checks)), flush=True)
    print('OFFICIAL CHN REVERSE CANDIDATES', len(reverse_candidates), flush=True)


if __name__ == '__main__':
    main()
