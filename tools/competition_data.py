"""Small, source-backed competition snapshots shared by sync and build."""
import hashlib
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/competitions'
KINDS = ('entries', 'rounds', 'rankings')


def athlete_id(name, country, gender):
    # PDF rosters use LAST First, while results can use First LAST.
    tokens = sorted(re.findall(r'\w+', unicodedata.normalize('NFKC', name).casefold()))
    key = '|'.join([country, gender, *tokens])
    return 'ath-' + hashlib.sha256(key.encode()).hexdigest()[:20]


def empty_dataset():
    return dict(status='not_published', update_status='not_checked',
                checked_at=None, updated_at=None, source_urls=[], items=[])


def empty_snapshot(event_id):
    return dict(schema_version=1, event_id=event_id,
                **{kind: empty_dataset() for kind in KINDS})


def load_snapshot(event_id, directory=DATA):
    path = directory / f'{event_id}.json'
    if not path.exists():
        return empty_snapshot(event_id)
    snapshot = json.loads(path.read_text(encoding='utf-8'))
    validate(snapshot, event_id)
    return snapshot


def validate(snapshot, event_id):
    if snapshot.get('schema_version') != 1 or snapshot.get('event_id') != event_id:
        raise ValueError('Snapshot event/schema mismatch')
    for kind in KINDS:
        dataset = snapshot[kind]
        if not isinstance(dataset['items'], list):
            raise ValueError('Invalid snapshot items')
        ids = [item['id'] for item in dataset['items']]
        if len(ids) != len(set(ids)):
            raise ValueError('Duplicate snapshot IDs: ' + kind)


def write_snapshot(snapshot, directory=DATA):
    validate(snapshot, snapshot['event_id'])
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (snapshot['event_id'] + '.json')
    content = json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'
    if path.exists() and path.read_text(encoding='utf-8') == content:
        return False
    candidate = path.with_suffix('.tmp')
    candidate.write_text(content, encoding='utf-8')
    candidate.replace(path)
    return True


def china_evidence(snapshot):
    """Bridge the new official heat feed to the existing schedule highlighter.

    Return covered keys separately, so official corrections can remove old
    auto-highlights. Human-reviewed overrides still take precedence in build.
    """
    grouped = {}
    for heat in snapshot['rounds']['items']:
        if heat.get('round_key') and heat.get('evidence') in ('official_start_list', 'official_results'):
            grouped.setdefault(heat['round_key'], []).append(heat)
    records = []
    for key, heats in grouped.items():
        chinese = []
        for heat in heats:
            names = [p['name'] for p in heat['participants'] if p['country'] == 'CHN']
            number = heat.get('heat_number')
            # Each explicitly named Final A/B is one race within its own
            # schedule row; this does not infer which final a skater enters.
            if number is None and heat.get('group') in ('A', 'B') and len(heats) == 1:
                number = 1
            if names and isinstance(number, int):
                chinese.append(dict(number=number, athletes=names))
        if chinese:
            records.append(dict(round_key=key, country='CHN',
                evidence='official_round_results' if all(h['evidence'] == 'official_results' for h in heats) else 'official_start_list',
                source_url=heats[0]['source_url'], verified_at=snapshot['rounds']['updated_at'], heats=chinese))
    return records, set(grouped)


def export(out, venues):
    directory = out / 'data/competitions'
    directory.mkdir(parents=True, exist_ok=True)
    events = []
    for event in venues:
        event_id, city, city_en = event[:3]
        snapshot = load_snapshot(event_id)
        events.append(dict(id=event_id, city=city, city_en=city_en,
                           **{kind: snapshot[kind]['status'] for kind in KINDS}))
        (directory / f'{event_id}.json').write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (directory / 'index.json').write_text(
        json.dumps(dict(schema_version=1, season='2026/27', events=events),
                   ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
