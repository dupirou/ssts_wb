#!/usr/bin/env python3
"""Compare numeric individual C74 ranks using per-event country, gender and helmet."""
import json
import re
from collections import Counter
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
pdf = ROOT.parent / 'ssts-audit-evidence-20261028/vancouver-protocol.pdf'
reader = PdfReader(pdf)
snapshot = json.loads((ROOT / 'data/competitions/vancouver.json').read_text(encoding='utf-8'))
helmets = {}
for h in snapshot['rounds']['items']:
    if h['format'] != 'individual': continue
    for p in h['participants']:
        if p.get('helmet_number'):
            helmets.setdefault((h['gender'],p['country'],p['helmet_number']),set()).add(p['athlete_id'])
rankings = [r for r in snapshot['rankings']['items'] if r['ranking_type']=='event' and r['format']=='individual']
official = []
for page_number, page in enumerate(reader.pages,1):
    text = page.extract_text(extraction_mode='layout')
    m = re.search(r'EVENT CLASSIFICATION\s*\n\s*(Women|Men)\s+(500|1000|1500)\s*m\s*\n', text)
    if not m: continue
    gender = 'women' if m[1]=='Women' else 'men'
    distance = int(m[2])
    for line in text.splitlines():
        r = re.match(r'^\s*(?:[A-Za-z. ]+?\s+)?(\d+)\s+(\d+)\s+(.+?)\s+([A-Z]{3})\s{2,}',line)
        if not r: continue
        official.append({'gender':gender,'distance_m':distance,'rank':int(r[1]),'helmet':int(r[2]),
                         'name':r[3].strip(),'country':r[4],'page':page_number,'official_line':line.strip()})
matched_ids = set()
for row in official:
    ids=helmets.get((row['gender'],row['country'],row['helmet']),set())
    candidates=[r for r in rankings if r['gender']==row['gender'] and r['distance_m']==row['distance_m']
                and r['country']==row['country'] and r['athlete_id'] in ids]
    if len(candidates)!=1:
        row['outcome']='missing_or_ambiguous_identity'
    else:
        candidate=candidates[0];matched_ids.add(candidate['id'])
        row['repository_rank']=candidate['rank']
        row['outcome']='same_rank' if candidate['rank']==row['rank'] else 'different_rank'
remaining=[{'id':r['id'],'name':r['name'],'gender':r['gender'],'distance_m':r['distance_m'],'country':r['country'],'rank':r['rank']}
           for r in rankings if r['id'] not in matched_ids]
(OUT/'vancouver_all_individual_rank_checks.json').write_text(json.dumps({'official':official,'repository_unmatched':remaining},ensure_ascii=False,indent=2),encoding='utf-8')
print('OFFICIAL NUMERIC C74 ROWS',len(official),dict(Counter(x['outcome'] for x in official)),
      'REPOSITORY UNMATCHED',len(remaining),flush=True)
