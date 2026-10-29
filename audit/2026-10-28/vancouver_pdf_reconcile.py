#!/usr/bin/env python3
"""Independently read Chinese C74 classification rows from the official Vancouver PDF."""
import hashlib
import json
import re
from pathlib import Path
from collections import Counter
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
pdf = ROOT.parent / 'ssts-audit-evidence-20261028/vancouver-protocol.pdf'
reader = PdfReader(pdf)
snapshot = json.loads((ROOT / 'data/competitions/vancouver.json').read_text(encoding='utf-8'))
archive = json.loads((ROOT / 'dist/data/results/events/2026-27-worldtour-vancouver-1.json').read_text(encoding='utf-8'))
helmets = {}
names_by_helmet = {}
def norm_name(value):
    return tuple(sorted(re.findall(r'[a-z]+', value.lower())))

for heat in snapshot['rounds']['items']:
    if heat['format'] != 'individual':
        continue
    for p in heat['participants']:
        if p.get('helmet_number') and p.get('country') == 'CHN':
            helmets.setdefault((heat['gender'], p['helmet_number']), set()).add(p['athlete_id'])
            names_by_helmet.setdefault((heat['gender'], p['helmet_number']), set()).add(norm_name(p['name']))
rows = []
for i, page in enumerate(reader.pages, 1):
    text = page.extract_text(extraction_mode='layout')
    match = re.search(r'EVENT CLASSIFICATION\s*\n\s*(Women|Men)\s+(500|1000|1500|3000|5000)\s*m(\s+Relay)?', text)
    mixed = bool(re.search(r'EVENT CLASSIFICATION\s*\n\s*Mixed Team Relay', text))
    if not match and not mixed:
        continue
    gender = 'mixed' if mixed else ('women' if match[1] == 'Women' else 'men')
    distance = 2000 if mixed else int(match[2])
    relay = mixed or bool(match[3])
    for line in text.splitlines():
        if relay:
            m = re.match(r'^\s*(?:[A-Za-z. ]+?\s+)?(\d+)\s+CHN\s+-\s+', line)
            if m:
                rows.append({'gender': gender, 'distance_m': distance, 'format': 'relay', 'official_rank': int(m[1]), 'page': i, 'line': line.strip()})
        else:
            m = re.match(r'^\s*(?:[A-Za-z. ]+?\s+)?(\d+)\s+(\d+)\s+(.+?)\s+CHN\s+', line)
            if m:
                rows.append({'gender': gender, 'distance_m': distance, 'format': 'individual', 'official_rank': int(m[1]),
                             'helmet': int(m[2]), 'official_name': m[3].strip(), 'page': i, 'line': line.strip()})
for r in rows:
    candidates = [x for x in archive['results'] if x['gender'] == r['gender'] and x['distance_m'] == r['distance_m']
                  and x['format'] == r['format']]
    if r['format'] == 'individual':
        ids = helmets.get((r['gender'], r['helmet']), set())
        observed_names = names_by_helmet.get((r['gender'], r['helmet']), set())
        official_name = norm_name(r['official_name'])
        candidates = [x for x in candidates if x.get('athlete_id') in ids or (
            official_name in observed_names and norm_name(x['name']) == official_name
        )]
    if not candidates:
        r['outcome'] = 'official_row_missing_from_archive'
    elif len(candidates) != 1:
        r['outcome'] = 'ambiguous_identity'
    else:
        x = candidates[0]
        r['archive_rank'] = x.get('rank')
        r['archive_rank_scope'] = x.get('rank_scope', 'overall')
        r['archive_final_group'] = x.get('final_group')
        r['outcome'] = ('same_overall_rank' if r['archive_rank'] == r['official_rank'] else 'different_overall_rank') \
            if r['archive_rank_scope'] == 'overall' else 'group_rank_only_not_compared_to_overall'
rpt = {'source_url': 'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/uploads/isunewrevamp/document/original/f287f824479994deccf3aa5b8feffb7cf74f956138eef0e11eda96ad535b31c9.pdf',
       'sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(), 'pages': len(reader.pages), 'rows': rows}
(OUT / 'vancouver_official_classification.json').write_text(json.dumps(rpt, ensure_ascii=False, indent=2), encoding='utf-8')
print('OFFICIAL C74 CHN CLASSIFICATIONS', len(rows), dict(Counter(r['outcome'] for r in rows)))
