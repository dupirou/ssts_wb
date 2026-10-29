"""Reconcile the reviewed 37 classifications and verify local original-file hashes."""
import argparse
import hashlib
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument('repository', type=Path)
parser.add_argument('--evidence-directory', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
rows = json.loads((root / 'classification-37-progress.json').read_text(encoding='utf-8'))
assert len(rows) == 37
seen = set()
for evidence in rows:
    expected = evidence['after']
    key = (evidence['event_id'], expected['official_result_id'], expected['name'])
    assert key not in seen, key
    seen.add(key)
    event = json.loads((args.repository / 'data/history/events' / (evidence['event_id'] + '.json')).read_text(encoding='utf-8'))
    matches = [r for r in event['results'] if r['official_result_id'] == key[1] and r['name'] == key[2]]
    assert len(matches) == 1, key
    actual = matches[0]
    for field in ('rank', 'rank_scope', 'status', 'race_number'):
        assert actual.get(field) == expected.get(field), (key, field)
    assert actual['classification_evidence']['literal']
    assert actual['classification_evidence']['verified_fields'] == ['rank', 'status']
for path in (args.repository / 'data/history/events').glob('*.json'):
    event = json.loads(path.read_text(encoding='utf-8'))
    metas = {p.get('official_result_id'): p for p in event.get('programme', [])}
    for row in event['results']:
        meta = metas.get(row.get('official_result_id'))
        if meta:
            match = re.search(r'\((\d+)\)\s*$', meta.get('name', ''))
            if match:
                assert row.get('race_number') == int(match[1]), (path.name, row['name'])
if args.evidence_directory:
    hashes = {hashlib.sha256(path.read_bytes()).hexdigest() for path in args.evidence_directory.glob('*.pdf')}
    for evidence in rows:
        if evidence['raw_pdf_retrieved']:
            assert evidence['after']['classification_evidence']['sha256'] in hashes
print('37/37 classification checks passed; official repeated-distance numbers agree.')
