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
STATISTICS_SCOPE = dict(
    individual_distances_m=[500, 1000, 1500],
    include_relays=True,
    include_all_around=False,
    include_super_3000=False,
    relay_lineups_required=False,
)


def included_discipline(row):
    """Count standard individual distances and relays; omit all-around and super finals."""
    return (
        row.get('format') == 'individual' and row.get('distance_m') in {500, 1000, 1500}
    ) or (row.get('format') == 'relay' and row.get('distance_m') in {2000, 3000, 5000})


def coverage_detail(event):
    """Result completeness is independent of optional historical relay lineups."""
    rows = [r for r in event['results'] if included_discipline(r)]
    programme = event.get('programme')
    included_ids = {d.get('official_result_id') for d in programme or [] if included_discipline(d)}
    missing = [ident for ident in event.get('missing_disciplines', []) if programme is None or ident in included_ids]
    return dict(
        missing_disciplines=missing,
        classification_conflicts=sum(bool(r.get('classification_conflict')) for r in rows),
        missing_classifications=sum(bool(r.get('classification_missing')) for r in rows),
        relay_lineups_unavailable=sum(r['format'] == 'relay' and not r.get('members') for r in rows),
        relay_lineups_required=False,
    )


def result_coverage(event):
    detail = coverage_detail(event)
    return (
        'partial'
        if any(detail[key] for key in ('missing_disciplines', 'classification_conflicts', 'missing_classifications'))
        else 'complete'
    )


def parse_classifications(pages, expected_disciplines=9):
    """Read C74 A/B final classifications, never ranks in individual heat reports.

    Input is Poppler's layout-preserving text, one string per physical PDF page.
    Relay X columns identify actual participation per round, not the entry roster.
    """
    records, covered = {}, set()
    for page_no, text in enumerate(pages, 1):
        if not re.search(r'^\s*(?:EVENT|FINAL) CLASSIFICATION\s*$', text, re.M | re.I):
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
            if re.search(r'^\s*LEGEND:?\s*$', text, re.M | re.I):
                continue
            raise ValueError('Unsupported classification header on page ' + str(page_no))
        header = lines[header_index]
        relay = disc['format'] == 'relay'
        name_col = header.index('Team' if relay else 'Name')
        rank_col = header.index('Rank')
        country_line = next(
            (l for l in lines[max(0, header_index - 1) : header_index + 2] if 'ISU' in l or 'NOC' in l), ''
        )
        country_col = (
            None if relay else (country_line.index('ISU') if 'ISU' in country_line else country_line.index('NOC'))
        )
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
                        explicit_sex = re.search(r'\b(Female|Male)\b', line)
                        gender = (
                            ('women' if explicit_sex[1] == 'Female' else 'men')
                            if explicit_sex
                            else ('men' if sex[1] == 'M' else 'women')
                            if sex
                            else disc['gender']
                        )
                        name = name[: sex.start()] if sex else name
                        rounds = [code for code, start, end in columns if 'X' in line[max(0, start - 1) : end + 2]]
                        if not rounds:
                            if 'X' in line[first_round:]:
                                raise ValueError('Relay participation columns do not align')
                            continue
                        current_team['members'].append(dict(name=name, gender=gender, rounds=rounds))
            else:
                if len(line) < country_col + 3 or line[country_col : country_col + 3] != 'CHN':
                    continue
                match = re.fullmatch(r'\s*(?:(\d+)\s+)?(\d+)\s+(.+?)\s*', line[rank_col:country_col])
                if not match:
                    raise ValueError('Invalid individual classification rank/helmet')
                rank = int(match[1]) if match[1] else None
                name = match[3]
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
                        rank=rank,
                        final_group=final_group,
                        status=terminal_status(right),
                        best_time=best_time(right),
                        source_page=page_no,
                    ),
                )
    if not records or len(covered) != expected_disciplines:
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
    if event['country'] != 'CHN' or (not event['results'] and event.get('participation') != 'none'):
        raise ValueError('Expected Chinese final classifications')
    ids = {p['id'] for p in registry['items']}
    seen = set()
    for r in event['results']:
        identity = r.get('athlete_id') if r['format'] == 'individual' else 'CHN'
        key = (r['gender'], r['distance_m'], r['format'], r.get('race_number', 1), identity)
        if key in seen:
            raise ValueError('Duplicate historical result')
        seen.add(key)
        if r['country'] != 'CHN' or r['final_group'] not in ('A', 'B', None):
            raise ValueError('Invalid association/final group')
        if r['rank'] is not None and (type(r['rank']) is not int or r['rank'] <= 0):
            raise ValueError('Invalid historical rank')
        if r['format'] == 'individual' and identity not in ids:
            raise ValueError('Unknown historical athlete')
        if event['source'].get('kind') == 'isu_api':
            if r.get('source_ref') not in {d['sha256'] for d in event['source']['documents']}:
                raise ValueError('Invalid API result source')
        elif not 1 <= r['source_page'] <= event['source']['pages']:
            raise ValueError('Invalid result source page')
        if any(m['athlete_id'] not in ids for m in r.get('members', [])):
            raise ValueError('Unknown relay athlete')
    if event['source'].get('kind') == 'isu_api':
        from urllib.parse import urlsplit

        docs = event['source']['documents']
        if not docs or any(
            urlsplit(d['url']).scheme != 'https'
            or urlsplit(d['url']).hostname not in {'front-api.isu.org', 'isu-skating.com', 'www.isu-skating.com'}
            or not re.fullmatch(r'[a-f0-9]{64}', d['sha256'])
            for d in docs
        ):
            raise ValueError('Invalid official API provenance')
        fingerprint = hashlib.sha256(json.dumps(docs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if fingerprint != event['source']['sha256']:
            raise ValueError('API provenance fingerprint mismatch')
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
        if meta['coverage'] not in {'complete', 'partial'}:
            if file.exists():
                raise ValueError('Unpublished event has stored results')
            continue
        event = json.loads(file.read_text())
        validate_event(event, meta, registry)
        event['results'] = [r for r in event['results'] if included_discipline(r)]
        if event.get('programme') is not None:
            event['programme'] = [d for d in event['programme'] if included_discipline(d)]
        medals = {
            str(i): sum(
                r['rank'] == i
                and r['status'] == 'classified'
                and r.get('medal_eligible', True)
                and r.get('medal_verified', True)
                and (r.get('rank_scope') != 'final' or r['final_group'] == 'A')
                for r in event['results']
            )
            for i in (1, 2, 3)
        }
        events.append(
            dict(
                **dict(meta, coverage=result_coverage(event)),
                coverage_detail=coverage_detail(event),
                participation=event.get('participation', 'recorded'),
                source=event['source'],
                programme=event.get('programme'),
                missing_disciplines=coverage_detail(event)['missing_disciplines'],
                results=event['results'],
                medals=medals,
            )
        )
    inventory = (
        json.loads((directory / 'inventory.json').read_text())['scopes']
        if (directory / 'inventory.json').exists()
        else []
    )
    pending = [e for e in catalog['events'] if e['coverage'] == 'pending']
    registered = {str(e.get('official_event_id')) for e in catalog['events']}
    for scope in inventory:
        for event in scope.get('events', []):
            if event['official_event_id'] not in registered:
                pending.append(
                    dict(
                        event,
                        id='pending-isu-' + event['official_event_id'],
                        coverage='pending',
                        pending_reason='not_imported',
                    )
                )
    return dict(
        schema_version=1,
        country='CHN',
        statistics_scope=STATISTICS_SCOPE,
        cycles=catalog['cycles'],
        inventory=inventory,
        events=sorted(events, key=lambda e: e['date_end'], reverse=True),
        pending=pending,
        athletes=registry['items'],
    )


def result_catalog(out, calendar, archive):
    """One browsing index for stored classifications and the current official feed."""
    people = {p['id']: dict(p) for p in archive['athletes']}
    aliases = {identity_key(name, p['gender']): p['id'] for p in people.values() for name in [p['name'], *p['aliases']]}

    def person(row, gender):
        aid = aliases.get(identity_key(row['name'], gender), row['athlete_id'])
        if aid not in people:
            people[aid] = dict(
                id=aid,
                name=competition_data.surname_last(row['name'])
                if not competition_data.given_first(row['name'])
                else row['name'],
                gender=gender,
                aliases=[row['name']],
            )
            people[aid]['name'] = people[aid]['name'] or row['name']
        return aid

    events = []
    for event in archive['events']:
        rows = [dict(r, rank_scope=r.get('rank_scope', 'overall')) for r in event['results']]
        events.append(
            dict(
                id=event['id'],
                season=event['season'],
                kind=event['kind'],
                title=re.sub(r'(\d)站', r'\1 站', event['title']),
                date_start=event['date_start'],
                date_end=event['date_end'],
                source={k: v for k, v in event['source'].items() if k != 'documents'},
                programme=event.get('programme'),
                participation=event.get('participation', 'recorded'),
                coverage=event['coverage'],
                coverage_detail=event['coverage_detail'],
                results=rows,
            )
        )
    for number, event in enumerate(calendar['stations'], 1):
        path = out / 'data/competitions' / (event['id'] + '.json')
        if not path.exists():
            continue
        snapshot = json.loads(path.read_text())
        genders = {p['athlete_id']: p['gender'] for p in snapshot.get('entries', {}).get('items', [])}
        rows, final_groups = [], {}
        heats = [
            h
            for h in snapshot['rounds']['items']
            if h.get('round') == 'final'
            and h.get('group') in ('A', 'B')
            and h.get('evidence') == 'official_results'
            and str(h.get('result_status', '')).lower() == 'official'
        ]
        for heat in heats:
            for p in heat['participants']:
                if p['country'] != 'CHN':
                    continue
                final_groups[(p['athlete_id'], heat['gender'], heat['distance_m'])] = heat['group']
                if heat['format'] != 'relay' or p.get('rank') is None:
                    continue
                members = [
                    dict(
                        name=m['name'],
                        athlete_id=person(m, genders.get(m['athlete_id'], heat['gender']))
                        if genders.get(m['athlete_id'], heat['gender']) != 'mixed'
                        else m['athlete_id'],
                        rounds=['F' + heat['group']],
                    )
                    for m in p.get('members', [])
                ]
                rows.append(
                    dict(
                        gender=heat['gender'],
                        distance_m=heat['distance_m'],
                        format='relay',
                        name='China',
                        country='CHN',
                        rank=p['rank'],
                        rank_scope='final',
                        final_group=heat['group'],
                        status=p.get('penalty', {}).get('code', 'classified')
                        if p.get('penalty')
                        else terminal_status([p.get('result') or '']),
                        members=members,
                        source_url=heat['source_url'],
                    )
                )
        for r in snapshot['rankings']['items']:
            if r['country'] != 'CHN' or r['ranking_type'] != 'event' or r['format'] != 'individual':
                continue
            rows.append(
                dict(
                    gender=r['gender'],
                    distance_m=r['distance_m'],
                    format='individual',
                    name=r['name'],
                    athlete_id=person(r, r['gender']),
                    country='CHN',
                    rank=r['rank'],
                    rank_scope='overall',
                    final_group=final_groups.get((r['athlete_id'], r['gender'], r['distance_m'])),
                    status=terminal_status(r.get('official_details', '').split()),
                    source_url=r['source_url'],
                )
            )
        if rows:
            events.append(
                dict(
                    id=calendar['season'].replace('/', '-') + '-worldtour-' + event['id'] + '-' + str(number),
                    season=calendar['season'],
                    kind='worldtour',
                    title='世巡赛第 ' + str(number) + ' 站 · ' + event['city'],
                    date_start=event['date_start'],
                    date_end=event['date_end'],
                    source=dict(url=(snapshot['rankings'].get('source_urls') or [rows[0]['source_url']])[0]),
                    results=rows,
                )
            )
    cycles = list(archive['cycles'])
    if not any(calendar['season'] in c['seasons'] for c in cycles):
        start = int(calendar['season'][:4])
        start -= (start - 2014) % 4
        cycles.append(
            dict(
                id='cycle-' + str(start + 4),
                label=str(start) + '—' + str(start + 4),
                seasons=[str(y) + '/' + str(y + 1)[-2:] for y in range(start, start + 4)],
            )
        )
    return dict(
        schema_version=1,
        country='CHN',
        statistics_scope=archive['statistics_scope'],
        cycles=cycles,
        athletes=list(people.values()),
        events=sorted(events, key=lambda e: e['date_end'], reverse=True),
        pending=archive['pending'],
        inventory=archive.get('inventory', []),
    )


def export(out, directory=DIRECTORY, calendar=None):
    data = load(directory)
    target = out / 'data/history'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'index.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if calendar:
        (out / 'data/results.json').write_text(
            json.dumps(result_catalog(out, calendar, data), ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
        )


def document_hash(body):
    return hashlib.sha256(body).hexdigest()
