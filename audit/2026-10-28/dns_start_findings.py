#!/usr/bin/env python3
"""Find independently evidenced DNS-in-a-later-round cases excluded from starts."""
import json
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
pdf_rows = [json.loads(line) for line in (OUT / 'history_pdf_checks.jsonl').read_text(encoding='utf-8').splitlines()]
by_key = {(x['event_id'], x['name'], x['gender'], x['distance_m'], x['format']): x for x in pdf_rows}
issues = []
for path in (ROOT / 'data/history/events').glob('*.json'):
    event = json.loads(path.read_text(encoding='utf-8'))
    for r in event['results']:
        if r.get('status') != 'DNS' or not r.get('best_time'): continue
        evidence = by_key.get((path.stem, r['name'], r['gender'], r['distance_m'], r['format']))
        if not evidence or evidence.get('outcome') != 'same_rank': continue
        line = evidence.get('official_line', '')
        if r['best_time'] not in line or not __import__('re').search(r'\bDNS\b', line): continue
        issues.append({'code':'S01', 'event_id':path.stem, 'name':r['name'], 'gender':r['gender'],
                       'distance_m':r['distance_m'], 'official_pdf_page':r['source_page'],
                       'official_source':event['source']['url'], 'official_line':line,
                       'official_prior_race_time':r['best_time'], 'repository_status':'DNS',
                       'repository_event_start_contribution':0, 'actual_event_start_contribution':1,
                       'first_introduction':'web/results-model.js:105 and :181',
                       'confidence':'confirmed by row-specific official best time and final-round DNS'})
(OUT / 'dns_start_findings.json').write_text(json.dumps(issues, ensure_ascii=False, indent=2), encoding='utf-8')
print('CONFIRMED DNS LATER ROUND START UNDERCOUNTS', len(issues), 'BY SEASON', dict(Counter(i['event_id'][:7] for i in issues)))
