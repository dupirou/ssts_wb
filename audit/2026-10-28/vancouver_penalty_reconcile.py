#!/usr/bin/env python3
"""Independently transcribe C98P and the PEN rows in C89I2 by helmet and report number."""
import json
import re
from collections import Counter
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
pdf = ROOT.parent / 'ssts-audit-evidence-20261028/vancouver-protocol.pdf'
reader = PdfReader(pdf)
source = json.loads((ROOT / 'data/penalties/vancouver.json').read_text(encoding='utf-8'))
totals, decisions = [], []
for page in (124, 125):
    text = reader.pages[page - 1].extract_text(extraction_mode='layout')
    gender = 'women' if re.search(r'^\s*Women\s*$', text, re.M) else 'men'
    for line in text.splitlines():
        m = re.match(r'^\s*(\d+)\s+(.+?)\s+([A-Z]{3})\s+((?:\d+|-)(?:\s+(?:\d+|-)){7})\s*$', line)
        if m:
            values = m[4].split()
            totals.append({'page': page, 'gender': gender, 'helmet': int(m[1]), 'name': m[2].strip(),
                           'country': m[3], 'official_total': int(values[-1]), 'line': line.strip()})
for page in (126, 127):
    for line in reader.pages[page - 1].extract_text(extraction_mode='layout').splitlines():
        m = re.match(r'^\s*(\d+)\s+(\d+)\s+(.+?)\s+PEN\s+([A-Z0-9]+)\s*$', line)
        if m:
            decisions.append({'page': page, 'number': int(m[1]), 'race_number': int(m[2]),
                              'official_code': m[4], 'line': line.strip()})
for row in totals:
    matches = [x for x in source['official'] if x['gender'] == row['gender'] and x['country'] == row['country']
               and x['helmet_number'] == row['helmet']]
    row['repository_total'] = matches[0]['total'] if len(matches) == 1 else None
    row['outcome'] = 'same_total' if row['repository_total'] == row['official_total'] else 'different_or_missing'
for row in decisions:
    matches = [x for x in source['infringements'] if x['number'] == row['number'] and x['race_number'] == row['race_number']]
    row['repository_code'] = matches[0]['infringement_code'] if len(matches) == 1 else None
    row['outcome'] = 'same_code' if row['repository_code'] == row['official_code'] else 'different_or_missing'
report = {'source_url': source['source_url'], 'source_sha256': source['source_sha256'],
          'official_totals': totals, 'official_pen_decisions': decisions,
          'repository_totals_count': len(source['official']), 'repository_pen_decisions_count': len(source['infringements'])}
(OUT / 'vancouver_penalty_checks.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('C98P', len(totals), dict(Counter(r['outcome'] for r in totals)), 'C89I2', len(decisions), dict(Counter(r['outcome'] for r in decisions)))
