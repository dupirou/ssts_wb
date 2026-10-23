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


def reviewed_source(url):
    """A local report image shipped with the site, not a substitute official-page URL."""
    return bool(re.fullmatch(r'/sources/[a-z0-9-]+\.jpg', url or '') and
                (ROOT / 'web' / url.lstrip('/')).is_file())


def published_snapshot(event_id, directory=DATA, reviewed_directory=None):
    """Supplement API data with reviewed report images; a live round replaces its image rows."""
    snapshot = load_snapshot(event_id, directory)
    path = (reviewed_directory or ROOT / 'data/reviewed_groups') / f'{event_id}.json'
    if not path.exists():
        return snapshot
    import build
    from datetime import datetime
    reviewed = json.loads(path.read_text(encoding='utf-8'))
    if reviewed.get('schema_version') != 1 or reviewed.get('event_id') != event_id:
        raise ValueError('Reviewed group event/schema mismatch')
    if datetime.fromisoformat(reviewed['verified_at']).utcoffset() is None:
        raise ValueError('Reviewed groups require a timezone')
    schedule = build.read_schedule(event_id)
    rounds = snapshot['rounds']
    for report in reviewed['reports']:
        source = report['source_url']
        if not reviewed_source(source) or hashlib.sha256((ROOT / 'web' / source.lstrip('/')).read_bytes()).hexdigest() != report['source_sha256']:
            raise ValueError('Reviewed group source image mismatch')
        matching = [r for r in schedule if r['gender'] == report['gender'] and
                    r['distance_m'] == report['distance_m'] and r['round'] == report['round'] and
                    r['session'] == 'qualifying' and r['format'] == 'individual']
        if len(matching) != 1:
            raise ValueError('Reviewed group round is ambiguous')
        target = matching[0]
        if any(h.get('round_key') == target['round_key'] for h in rounds['items']):
            continue
        seen_people, seen_heats = set(), set()
        for group in report['groups']:
            number = group['heat_number']
            if type(number) is not int or number < 1 or number in seen_heats or not group['participants']:
                raise ValueError('Invalid reviewed heat')
            seen_heats.add(number)
            members = []
            for person in group['participants']:
                if person['athlete_id'] in seen_people or not re.fullmatch('[A-Z]{3}', person['country']):
                    raise ValueError('Duplicate/invalid reviewed competitor')
                seen_people.add(person['athlete_id'])
                members.append(dict(person, starting_position=None, rank=None, result=None,
                                    qualification=None, penalty=None))
            rounds['items'].append(dict(id=f'reviewed-{event_id}-{report["gender"]}-{report["distance_m"]}-{number}',
                gender=report['gender'], distance_m=report['distance_m'], format='individual',
                round=report['round'], round_label=report['round'], round_key=target['round_key'],
                local_date=target['local_date'], group=None, heat_number=number,
                heat_label=f'Heat {number}', source_start=None, result_status=None,
                evidence='reviewed_seeding_image', source_kind=reviewed['source_kind'],
                partial_round=report['coverage'] == 'partial', source_page=report['page'],
                source_page_count=report['page_count'], source_url=source,
                has_china=any(p['country'] == 'CHN' for p in members), participants=members))
        rounds.update(status='available', update_status='ok',
                      checked_at=max(rounds.get('checked_at') or '', reviewed['verified_at']),
                      updated_at=max(rounds.get('updated_at') or '', reviewed['verified_at']))
        rounds.pop('error', None)
    rounds['source_urls'] = sorted({h['source_url'] for h in rounds['items']})
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
        if heat.get('round_key') and heat.get('evidence') in ('official_start_list', 'official_results', 'reviewed_seeding_image'):
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


def export(out, venues, distances=lambda event_id: {}):
    """`distances(event_id)` maps athlete_id to the individual distances entered there."""
    directory = out / 'data/competitions'
    directory.mkdir(parents=True, exist_ok=True)
    events = []
    for event in venues:
        event_id, city, city_en = event[:3]
        snapshot = published_snapshot(event_id)
        entered = distances(event_id)
        for person in snapshot['entries']['items']:
            if person['athlete_id'] in entered:
                person['distances'] = entered[person['athlete_id']]
        events.append(dict(id=event_id, city=city, city_en=city_en,
                           **{kind: snapshot[kind]['status'] for kind in KINDS}))
        (directory / f'{event_id}.json').write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (directory / 'index.json').write_text(
        json.dumps(dict(schema_version=1, season='2026/27', events=events),
                   ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
