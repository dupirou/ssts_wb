"""Apply reviewed classification evidence to the existing discrepancy list only."""
import argparse
import hashlib
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('repository', type=Path)
p.add_argument('--apply', action='store_true')
a = p.parse_args()
root = Path(__file__).resolve().parent
report = []
files = {}
for name in ('concentrated-15.json', 'laval-2023-findings.json'):
    evidence_bytes = (root / name).read_bytes()
    for evidence in json.loads(evidence_bytes):
        path = a.repository / 'data/history/events' / (evidence['event_id'] + '.json')
        if path not in files:
            files[path] = json.loads(path.read_text(encoding='utf-8'))
        matches = [r for r in files[path]['results']
                   if r.get('name') == evidence['name']
                   and r.get('gender') == evidence['gender']
                   and r.get('distance_m') == evidence['distance_m']
                   and (not evidence.get('official_result_id')
                        or r.get('official_result_id') == evidence['official_result_id'])]
        entry = dict(evidence=evidence, evidence_file=name,
                     evidence_sha256=hashlib.sha256(evidence_bytes).hexdigest())
        if len(matches) != 1:
            entry.update(outcome='ambiguous_identity', matches=len(matches))
        else:
            row = matches[0]
            entry['before'] = {k: row.get(k) for k in ('rank', 'rank_scope', 'status', 'final_group')}
            rank = evidence.get('official_rank')
            status = evidence.get('official_status')
            if status is not None and status != row.get('status'):
                entry['outcome'] = 'status_conflict_requires_version_evidence'
            elif row.get('rank') is not None and row.get('rank_scope') != 'final' and row['rank'] != rank:
                entry['outcome'] = 'numeric_conflict_requires_version_evidence'
            elif rank is None:
                entry['outcome'] = 'no_numeric_evidence'
            elif row.get('rank') == rank and row.get('rank_scope') == 'overall':
                entry['outcome'] = 'already_matches'
            else:
                entry['outcome'] = 'confirmed_rank_repair'
                if row.get('rank_scope') == 'final' and row.get('rank') is not None:
                    row['final_rank'] = row['rank']
                row.update(rank=rank, rank_scope='overall')
                row['classification_evidence'] = {
                    'url': evidence['source_url'],
                    'locator': evidence.get('source_table', evidence.get('source_locator')),
                    'mode': evidence['evidence_mode'],
                    'raw_pdf_retrieved': evidence['raw_pdf_retrieved'],
                    'revision_order': evidence['revision_order'],
                    'verified_fields': ['rank'],
                    'decision_basis': 'user_accepts_uncontested_official_index_and_overall_classification',
                }
            entry['after'] = {k: row.get(k) for k in ('rank', 'rank_scope', 'status', 'final_group')}
        report.append(entry)
if a.apply:
    for path, data in files.items():
        text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
        if text != path.read_text(encoding='utf-8'):
            path.write_text(text, encoding='utf-8')
(root / 'classification-repair-reconciliation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
from collections import Counter
print(json.dumps(Counter(r['outcome'] for r in report), ensure_ascii=False))
