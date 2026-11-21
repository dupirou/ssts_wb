#!/usr/bin/env python3
"""Read each cited C74 page independently; compare only directly identifiable rank fields."""
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
sources = json.loads((OUT / 'pdf_sources.json').read_text(encoding='utf-8'))
results = []
for source in sources:
    event = json.loads((ROOT / 'data/history/events' / (source['id'] + '.json')).read_text(encoding='utf-8'))
    file = Path(source.get('path', ''))
    usable = file.is_file() and file.read_bytes()[:5] == b'%PDF-' and source.get('sha256') == source.get('expected_sha256')
    reader = PdfReader(file) if usable else None
    pages = {}
    for row in event['results']:
        if row['format'] == 'individual' and row['distance_m'] not in (500, 1000, 1500): continue
        if row['format'] == 'relay' and row['distance_m'] not in (2000, 3000, 5000): continue
        record = {'event_id': source['id'], 'name': row['name'], 'gender': row['gender'],
                  'distance_m': row['distance_m'], 'format': row['format'], 'source_url': source['url'],
                  'source_page': row.get('source_page'), 'repository_rank': row.get('rank'),
                  'source_sha256': source.get('sha256'), 'outcome': 'unverified', 'reason': 'source_pdf_unavailable'}
        if reader and row.get('source_page') and row['source_page'] <= len(reader.pages):
            p = row['source_page']
            if p not in pages:
                pages[p] = reader.pages[p - 1].extract_text(extraction_mode='layout')
            text = pages[p]
            lines = text.splitlines()
            if row['format'] == 'individual':
                name = re.escape(row['name']).replace(r'\ ', r'\s+')
                patterns = [re.compile(r'^\s*(?:[A-Za-z. ]+?\s+)?(\d+)\s+\d+\s+' + name + r'\s+CHN(?:\s|$)', re.I)]
            else:
                patterns = [re.compile(r'^\s*(?:[A-Za-z. ]+?\s+)?(\d+)\s+CHN\s+-\s+', re.I)]
            matched = [(line, m) for line in lines for pattern in patterns if (m := pattern.search(line))]
            if len(matched) == 1:
                record['official_rank'] = int(matched[0][1][1])
                record['official_line'] = matched[0][0].strip()
                record['checked_fields'] = ['page_country_name_rank' if row['format'] == 'individual' else 'page_country_team_rank']
                record['outcome'] = 'same_rank' if record['official_rank'] == row.get('rank') else 'rank_difference'
                record['reason'] = 'rank_only_identity_status_rounds_not_fully_independently_verified'
            else:
                record['reason'] = 'source_page_not_unambiguously_parsed'
        results.append(record)
with (OUT / 'history_pdf_checks.jsonl').open('w', encoding='utf-8') as f:
    for row in results: f.write(json.dumps(row, ensure_ascii=False) + '\n')
print('PDF AUDIT',len(results),dict(Counter(r['outcome'] for r in results)),flush=True)
print('PDF UNVERIFIED',dict(Counter(r['reason'] for r in results if r['outcome']=='unverified')),flush=True)
