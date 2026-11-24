#!/usr/bin/env python3
"""Compare stored event rows and independently calculated totals with built projections."""
import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent


def included(row):
    return (row.get('format') == 'individual' and row.get('distance_m') in (500, 1000, 1500)) or (
        row.get('format') == 'relay' and row.get('distance_m') in (2000, 3000, 5000)
    )


def key(row):
    return (row['gender'], row['distance_m'], row['format'], row.get('race_number', 1),
            row.get('athlete_id') if row['format'] == 'individual' else 'CHN')


def independently_calculate(rows):
    rows = [r for r in rows if included(r) and r.get('medal_eligible') is not False]
    starts = [r for r in rows if r.get('status') != 'DNS' and r.get('started') is not False]
    medals = [0, 0, 0]
    for r in rows:
        rank = r.get('rank')
        if (r.get('status') == 'classified' and rank in (1, 2, 3)
                and r.get('medal_verified') is not False
                and (r.get('rank_scope', 'overall') != 'final' or r.get('final_group') == 'A')):
            medals[rank - 1] += 1
    top8 = sum(r.get('status') == 'classified' and isinstance(r.get('rank'), int) and 1 <= r['rank'] <= 8
               and (r.get('rank_scope', 'overall') != 'final' or r.get('final_group') == 'A') for r in rows)
    return {'events': 1, 'entries': len(rows), 'starts': len(starts), 'medals': medals,
            'a_finals': sum(r.get('final_group') == 'A' for r in starts), 'top8': top8}


catalog = json.loads((ROOT / 'data/history/catalog.json').read_text(encoding='utf-8'))
index = json.loads((ROOT / 'dist/data/results/index.json').read_text(encoding='utf-8'))
indexed = {e['id']: e for e in index['events']}
summaries = {}
for f in (ROOT / 'dist/data/results/seasons').glob('*.json'):
    for item in json.loads(f.read_text(encoding='utf-8'))['items']:
        summaries[item['id']] = item['summary']['totals']
matrix, discrepancies = [], []
for meta in catalog['events']:
    source = json.loads((ROOT / 'data/history/events' / (meta['id'] + '.json')).read_text(encoding='utf-8'))
    base = [r for r in source['results'] if included(r)]
    published = ROOT / 'dist/data/results/events' / (meta['id'] + '.json')
    entry = {'event_id': meta['id'], 'season': meta['season'], 'stored': len(base), 'projected': 0,
             'matched_rows': 0, 'differing_rows': 0, 'missing_rows': 0, 'extra_rows': 0,
             'summary_equal': False, 'catalog_equal': False}
    if published.exists() and meta['id'] in indexed and meta['id'] in summaries:
        detail = json.loads(published.read_text(encoding='utf-8'))
        left = {key(r): r for r in base}
        right = {key(r): r for r in detail['results']}
        entry['projected'] = len(detail['results'])
        entry['catalog_equal'] = indexed[meta['id']]['record_count'] == len(base)
        entry['missing_rows'] = len(left.keys() - right.keys())
        entry['extra_rows'] = len(right.keys() - left.keys())
        for k in left.keys() & right.keys():
            original, projected = left[k], right[k]
            fields = ('name', 'country', 'rank', 'final_group', 'status', 'best_time', 'source_page', 'members')
            differences = {f: [original.get(f), projected.get(f)] for f in fields if original.get(f) != projected.get(f)}
            if original.get('rank_scope', 'overall') != projected.get('rank_scope', 'overall'):
                differences['rank_scope'] = [original.get('rank_scope', 'overall'), projected.get('rank_scope', 'overall')]
            if differences:
                entry['differing_rows'] += 1
                discrepancies.append({'event_id': meta['id'], 'key': k, 'layer': 'stored_to_event_projection', 'fields': differences})
            else:
                entry['matched_rows'] += 1
        independent = independently_calculate(base)
        actual = summaries[meta['id']]
        entry['summary_equal'] = independent == actual
        if independent != actual:
            discrepancies.append({'event_id': meta['id'], 'layer': 'stored_to_summary', 'expected_from_stored_rows': independent, 'actual': actual})
    matrix.append(entry)
with (OUT / 'projection_event_matrix.csv').open('w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=list(matrix[0]))
    writer.writeheader()
    writer.writerows(matrix)
(OUT / 'projection_differences.json').write_text(json.dumps(discrepancies, ensure_ascii=False, indent=2), encoding='utf-8')
print('PROJECTION EVENTS', len(matrix), 'MATCHED ROWS', sum(x['matched_rows'] for x in matrix),
      'ROW DIFFERENCES', sum(x['differing_rows'] + x['missing_rows'] + x['extra_rows'] for x in matrix),
      'SUMMARY DIFFERENCES', sum(not x['summary_equal'] for x in matrix),
      'CATALOG DIFFERENCES', sum(not x['catalog_equal'] for x in matrix))
