"""China's historical final classifications, independent of the live season feed."""

import hashlib
import json
import re
from pathlib import Path

import competition_data
import sync_competitions

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / 'data/history'
STATUSES = {'PEN', 'DNS', 'DNF', 'DSQ', 'YC', 'RC'}


def parse_classifications(pages):
    """Read C74 A/B final classifications, never ranks in individual heat reports.

    Input is Poppler's layout-preserving text, one string per physical PDF page.
    Relay X columns identify actual participation per round, not the entry roster.
    """
    records, covered = {}, set()
    for page_no, text in enumerate(pages, 1):
        if not re.search(r'^\s*(?:EVENT|FINAL) CLASSIFICATION\s*$', text, re.M):
            continue
        lines = text.splitlines()
        disc = next(
            (
                sync_competitions.discipline(l)
                for l in lines
                if len(l.strip()) < 80 and 'Record' not in l and sync_competitions.discipline(l)
            ),
            None,
        )
        if not disc:
            continue
        key = (disc['gender'], disc['distance_m'], disc['format'])
        header_index = next(
            (i for i, l in enumerate(lines) if 'Group' in l and 'Rank' in l and ('Name' in l or 'Team' in l)), None
        )
        if header_index is None:
            if re.search(r'^\s*LEGEND\s*$', text, re.M):
                continue
            raise ValueError('Unsupported classification header on page ' + str(page_no))
        header = lines[header_index]
        relay = disc['format'] == 'relay'
        name_col = header.index('Team' if relay else 'Name')
        rank_col = header.index('Rank')
        country_line = next((l for l in lines[max(0, header_index - 1) : header_index + 2] if 'ISU' in l), '')
        country_col = None if relay else country_line.index('ISU')
        round_header = next(
            (l for l in lines[header_index + 1 : header_index + 4] if re.search(r'\b(?:FA|FB)\b', l)), None
        )
        if round_header is None:
            raise ValueError('Missing round columns on page ' + str(page_no))
        columns = [
            (m.group(), m.start(), m.end()) for m in re.finditer(r'\b(?:P|H|QF|RH|RQ|RS|SF|FB|FA)\b', round_header)
        ]
        covered.add(key)
        first_round = columns[0][1]
        current_team = None
        for line in lines[header_index + 2 :]:
            final_group = None
            if relay:
                team = re.search(r'\b([A-Z]{3})\s+-\s+', line)
                if team:
                    current_team = None
                    if team[1] != 'CHN':
                        continue
                    value = line[rank_col : team.start()].strip()
                    if value and not value.isdigit():
                        raise ValueError('Invalid relay classification rank')
                    current_team = dict(
                        **disc,
                        name='China',
                        country='CHN',
                        rank=int(value) if value else None,
                        final_group=final_group,
                        source_page=page_no,
                        members=[],
                    )
                    right = line[first_round:].split()
                    current_team['status'] = terminal_status(right)
                    current_team['best_time'] = best_time(right)
                    save_record(records, current_team)
                elif current_team:
                    member = re.match(r'\s*(\d+)\s+(.+?)\s{2,}', line[name_col:])
                    if member:
                        name = member[2].strip()
                        sex = re.search(r'\s+\(([MW])\)$', name)
                        gender = ('men' if sex[1] == 'M' else 'women') if sex else disc['gender']
                        name = name[: sex.start()] if sex else name
                        rounds = [code for code, start, end in columns if 'X' in line[max(0, start - 1) : end + 2]]
                        if not rounds:
                            raise ValueError('Relay member without participation columns')
                        current_team['members'].append(dict(name=name, gender=gender, rounds=rounds))
            else:
                if len(line) < country_col + 3 or line[country_col : country_col + 3] != 'CHN':
                    continue
                prefix = line[rank_col:name_col].split()
                digits = [p for p in prefix if p.isdigit()]
                if len(digits) not in (1, 2):
                    raise ValueError('Invalid individual classification rank/helmet')
                name = line[name_col:country_col].strip()
                if not name:
                    raise ValueError('Missing classified skater')
                right = line[country_col + 3 :].split()
                finals = [
                    code[-1]
                    for code, start, end in columns
                    if code in ('FA', 'FB') and line[max(0, start - 1) : end + 2].strip()
                ]
                if len(finals) > 1:
                    raise ValueError('Skater appears in both finals')
                final_group = finals[0] if finals else None
                save_record(
                    records,
                    dict(
                        **disc,
                        name=name,
                        country='CHN',
                        rank=int(digits[0]) if len(digits) == 2 else None,
                        final_group=final_group,
                        status=terminal_status(right),
                        best_time=best_time(right),
                        source_page=page_no,
                    ),
                )
    if not records or len(covered) != 9:
        raise ValueError('Expected all nine senior disciplines; found ' + str(len(covered)))
    for row in records.values():
        if row['format'] == 'relay':
            finals = {code[-1] for m in row['members'] for code in m['rounds'] if code in ('FA', 'FB')}
            if len(finals) > 1:
                raise ValueError('Relay team appears in both finals')
            row['final_group'] = next(iter(finals), None)
            if finals and sum('F' + row['final_group'] in m['rounds'] for m in row['members']) != 4:
                raise ValueError('Incomplete actual relay final lineup')
    return list(records.values())


def terminal_status(tokens):
    results = [t for t in tokens if not re.fullmatch(r'(?:\d+:)?\d{1,2}\.\d{3}', t)]
    return results[-1] if results and results[-1] in STATUSES else 'classified'


def best_time(tokens):
    return tokens[-1] if tokens and re.fullmatch(r'(?:\d+:)?\d{1,2}\.\d{3}', tokens[-1]) else None


def save_record(records, row):
    key = (row['gender'], row['distance_m'], row['format'], row['name'])
    if key in records:
        raise ValueError('Duplicate final classification: ' + str(key))
    records[key] = row


def identity_key(name, gender):
    return competition_data.athlete_id(name, 'CHN', gender)


def attach_identities(records, registry):
    aliases = {}
    for person in registry['items']:
        for name in [person['name'], *person['aliases']]:
            key = identity_key(name, person['gender'])
            if key in aliases and aliases[key]['id'] != person['id']:
                raise ValueError('Ambiguous athlete alias: ' + name)
            aliases[key] = person
    for row in records:
        if row['format'] == 'individual':
            person = aliases.get(identity_key(row['name'], row['gender']))
            if not person:
                raise ValueError('Unregistered athlete: ' + row['name'])
            row['athlete_id'] = person['id']
        else:
            for member in row['members']:
                gender = member.get('gender', row['gender'])
                candidates = [
                    aliases.get(identity_key(member['name'], g))
                    for g in (('men', 'women') if gender == 'mixed' else (gender,))
                ]
                matches = {p['id']: p for p in candidates if p}
                if len(matches) != 1:
                    raise ValueError('Unregistered or ambiguous relay athlete: ' + member['name'])
                member['athlete_id'] = next(iter(matches))


def validate_event(event, config, registry):
    if event['schema_version'] != 1 or event['competition_id'] != config['id']:
        raise ValueError('Historical event/schema mismatch')
    if event['country'] != 'CHN' or not event['results']:
        raise ValueError('Expected Chinese final classifications')
    ids = {p['id'] for p in registry['items']}
    seen = set()
    for r in event['results']:
        identity = r.get('athlete_id') if r['format'] == 'individual' else 'CHN'
        key = (r['gender'], r['distance_m'], identity)
        if key in seen:
            raise ValueError('Duplicate historical result')
        seen.add(key)
        if r['country'] != 'CHN' or r['final_group'] not in ('A', 'B', None):
            raise ValueError('Invalid association/final group')
        if r['rank'] is not None and (type(r['rank']) is not int or r['rank'] <= 0):
            raise ValueError('Invalid historical rank')
        if r['format'] == 'individual' and identity not in ids:
            raise ValueError('Unknown historical athlete')
        if not 1 <= r['source_page'] <= event['source']['pages']:
            raise ValueError('Invalid result source page')
        if any(m['athlete_id'] not in ids for m in r.get('members', [])):
            raise ValueError('Unknown relay athlete')
    if not re.fullmatch(r'[a-f0-9]{64}', event['source']['sha256']):
        raise ValueError('Missing source fingerprint')
    if event['source']['sha256'] != config['source_sha256'] or event['source']['url'] != config['source_url']:
        raise ValueError('Historical source does not match catalog')


def load(directory=DIRECTORY):
    catalog = json.loads((directory / 'catalog.json').read_text())
    registry = json.loads((directory / 'athletes.json').read_text())
    if len({p['id'] for p in registry['items']}) != len(registry['items']):
        raise ValueError('Duplicate historical athlete identity')
    events = []
    event_ids = set()
    seasons = {s for c in catalog['cycles'] for s in c['seasons']}
    for meta in catalog['events']:
        if meta['id'] in event_ids or meta['season'] not in seasons:
            raise ValueError('Invalid historical competition identity/season')
        event_ids.add(meta['id'])
        file = directory / 'events' / (meta['id'] + '.json')
        if meta['coverage'] != 'complete':
            if file.exists():
                raise ValueError('Unpublished event has stored results')
            continue
        event = json.loads(file.read_text())
        validate_event(event, meta, registry)
        medals = {str(i): sum(r['rank'] == i for r in event['results']) for i in (1, 2, 3)}
        events.append(dict(**meta, source=event['source'], results=event['results'], medals=medals))
    return dict(
        schema_version=1,
        country='CHN',
        cycles=catalog['cycles'],
        events=sorted(events, key=lambda e: e['date_end'], reverse=True),
        pending=[e for e in catalog['events'] if e['coverage'] != 'complete'],
        athletes=registry['items'],
    )


def export(out, directory=DIRECTORY):
    data = load(directory)
    target = out / 'data/history'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'index.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def document_hash(body):
    return hashlib.sha256(body).hexdigest()
