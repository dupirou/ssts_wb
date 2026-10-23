"""Small, source-backed competition snapshots shared by sync and build."""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/competitions'
INPUTS = ROOT / 'data/prediction_inputs'
KINDS = ('entries', 'rounds', 'rankings')


def athlete_id(name, country, gender):
    # PDF rosters use LAST First, while results can use First LAST.
    tokens = sorted(re.findall(r'\w+', unicodedata.normalize('NFKC', name).casefold()))
    key = '|'.join([country, gender, *tokens])
    return 'ath-' + hashlib.sha256(key.encode()).hexdigest()[:20]


def empty_dataset():
    return dict(
        status='not_published', update_status='not_checked', checked_at=None, updated_at=None, source_urls=[], items=[]
    )


def empty_snapshot(event_id):
    return dict(schema_version=1, event_id=event_id, **{kind: empty_dataset() for kind in KINDS})


def load_snapshot(event_id, directory=DATA):
    path = directory / f'{event_id}.json'
    if not path.exists():
        return empty_snapshot(event_id)
    snapshot = json.loads(path.read_text(encoding='utf-8'))
    validate(snapshot, event_id)
    return snapshot


def surname_last(name):
    """'LI Kun' -> 'Kun LI'. Entry PDFs lead with the upper-case surname. An all-capitals
    two-part name is still 'SURNAME Given' ('SONG KERUI' -> 'Kerui SONG'); None when the
    capitals cannot mark the surname (no capitals, or three or more all-capital parts)."""
    tokens = name.split()
    n = next((i for i, t in enumerate(tokens) if not t.isupper()), len(tokens))
    if n == len(tokens) == 2:
        return '-'.join(part.capitalize() for part in tokens[1].split('-')) + ' ' + tokens[0]
    return ' '.join(tokens[n:] + tokens[:n]) if 0 < n < len(tokens) else None


def given_first(name):
    """Whether a name already reads 'Given SURNAME', as ISU's results feed mostly writes it."""
    tokens = name.split()
    n = next((i for i, t in enumerate(reversed(tokens)) if not t.isupper()), len(tokens))
    return 0 < n < len(tokens)


def display_names(snapshot, extra=()):
    """One spelling per athlete across the site, 'Given SURNAME'.

    Official sources disagree ('LI Kun' in entry PDFs, 'Kun LI' or 'Margherita Betti' in the
    results feed, 'SONG KERUI'), so the entry PDF's capitals decide the surname when they can,
    and any other source already in that form is the fallback. Stored data keeps ISU's text."""
    others = [p for heat in snapshot['rounds']['items'] for p in heat['participants']] + list(extra)
    names = {p['athlete_id']: ' '.join(p['name'].split()) for p in others if given_first(p['name'])}
    for person in snapshot['entries']['items']:
        flipped = surname_last(person['name'])
        if flipped:
            names[person['athlete_id']] = flipped
    return names


def distance_entrants(event_id, directory=INPUTS):
    path = directory / f'{event_id}.json'
    lists = json.loads(path.read_text(encoding='utf-8')).get('lists', []) if path.exists() else []
    return [p for entered in lists for p in entered['participants']]


def display_snapshot(event_id):
    """The stored snapshot with every athlete under their display name, for publishing."""
    snapshot = load_snapshot(event_id)
    names = display_names(snapshot, distance_entrants(event_id))
    for person in snapshot['entries']['items'] + [p for h in snapshot['rounds']['items'] for p in h['participants']]:
        person['name'] = names.get(person['athlete_id'], person['name'])
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
            records.append(
                dict(
                    round_key=key,
                    country='CHN',
                    evidence='official_round_results'
                    if all(h['evidence'] == 'official_results' for h in heats)
                    else 'official_start_list',
                    source_url=heats[0]['source_url'],
                    verified_at=snapshot['rounds']['updated_at'],
                    heats=chinese,
                )
            )
    return records, set(grouped)


def export(out, venues, distances=lambda event_id: {}, season=None):
    """`distances(event_id)` maps athlete_id to the individual distances entered there."""
    directory = out / 'data/competitions'
    directory.mkdir(parents=True, exist_ok=True)
    events = []
    for event in venues:
        event_id, city, city_en = event[:3]
        snapshot = display_snapshot(event_id)
        entered = distances(event_id)
        for person in snapshot['entries']['items']:
            if person['athlete_id'] in entered:
                person['distances'] = entered[person['athlete_id']]
        events.append(
            dict(id=event_id, city=city, city_en=city_en, **{kind: snapshot[kind]['status'] for kind in KINDS})
        )
        (directory / f'{event_id}.json').write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
        )
    (directory / 'index.json').write_text(
        json.dumps(dict(schema_version=1, season=season, events=events), ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
