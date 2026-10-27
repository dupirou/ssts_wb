"""Small, derived indexes for the homepage and current-season athlete directory."""

import json
from pathlib import Path


def export(out: Path, calendar: dict, schedules: dict):
    people, finals = {}, []
    genders = {'women': '女子', 'men': '男子', 'mixed': '混合'}
    for event in calendar['stations']:
        path = out / 'data/competitions' / (event['id'] + '.json')
        if not path.exists():
            continue
        snapshot = json.loads(path.read_text(encoding='utf-8'))
        for person in snapshot['entries']['items']:
            aid = person['athlete_id']
            item = people.setdefault(
                aid,
                dict(id=aid, name=person['name'], country=person['country'], gender=person['gender'], events=[]),
            )
            if person['name'] != item['name']:
                item.setdefault('aliases', []).append(person['name'])
            item['events'].append(dict(event_id=event['id'], city=event['city'], season=calendar['season']))
        rows = {row['round_key']: row for row in schedules.get(event['id'], [])}
        for heat in snapshot['rounds']['items']:
            row = rows.get(heat.get('round_key'))
            if (
                not row
                or heat.get('round') != 'final'
                or heat.get('group') != 'A'
                or heat.get('evidence') != 'official_results'
            ):
                continue
            if (heat.get('result_status') or '').lower() != 'official':
                continue
            podium = sorted(
                (
                    dict(rank=p['rank'], name=p['name'], country=p['country'])
                    for p in heat['participants']
                    if type(p.get('rank')) is int and 1 <= p['rank'] <= 3 and not p.get('penalty')
                ),
                key=lambda p: p['rank'],
            )
            if not podium:
                continue
            label = genders[row['gender']] + ' ' + str(row['distance_m']) + 'm'
            if row['format'] == 'relay':
                label += ' 接力'
            finals.append(
                dict(
                    event_id=event['id'],
                    city=event['city'],
                    local_date=row['local_date'],
                    utc_start=row['utc_start'],
                    schedule_id=row['id'],
                    label=label,
                    podium=podium,
                )
            )
    finals.sort(key=lambda f: (f['utc_start'], f['event_id']), reverse=True)
    datasets = {
        'portal.json': dict(schema_version=1, season=calendar['season'], finals=finals[:12]),
        'athletes.json': dict(
            schema_version=1,
            season=calendar['season'],
            items=sorted(people.values(), key=lambda p: (p['name'].casefold(), p['id'])),
        ),
    }
    for name, value in datasets.items():
        (out / 'data' / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
