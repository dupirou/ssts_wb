"""Derived results and current-season athlete indexes."""

import json
from pathlib import Path


def export(out: Path, calendar: dict, schedules: dict):
    people, finals, ranking_tables = {}, [], {}
    genders = {'women': '女子', 'men': '男子', 'mixed': '混合'}
    for event in calendar['stations']:
        path = out / 'data/competitions' / (event['id'] + '.json')
        if not path.exists():
            continue
        snapshot = json.loads(path.read_text(encoding='utf-8'))
        # Helmet numbers come from official individual heat/start-list rows, not roster entries.
        # Keep them station-scoped: a later venue can legitimately publish a different number.
        helmets, conflicts = {}, set()
        for heat in snapshot['rounds']['items']:
            if heat.get('format') != 'individual' or heat.get('evidence') not in (
                'official_results', 'official_start_list'
            ):
                continue
            for participant in heat['participants']:
                number = participant.get('helmet_number')
                if type(number) is not int or number <= 0:
                    continue
                key = (participant.get('athlete_id'), participant.get('country'), heat.get('gender'))
                if key in helmets and helmets[key] != number:
                    conflicts.add(key)
                helmets[key] = number
        for person in snapshot['entries']['items']:
            aid = person['athlete_id']
            item = people.setdefault(
                aid,
                dict(id=aid, name=person['name'], country=person['country'], gender=person['gender'], events=[]),
            )
            if person['name'] != item['name']:
                item.setdefault('aliases', []).append(person['name'])
            item['events'].append(dict(event_id=event['id'], city=event['city'], season=calendar['season']))
            key = (aid, person['country'], person['gender'])
            if key in helmets and key not in conflicts:
                item.setdefault('helmet_numbers', []).append(
                    dict(event_id=event['id'], city=event['city'], number=helmets[key])
                )
        rankings = snapshot.get('rankings', {})
        tables = {}
        for ranking in rankings.get('items', []):
            if (
                ranking.get('ranking_type') == 'world_tour'
                and ranking.get('format') == 'individual'
                and ranking.get('gender') in ('men', 'women')
                and type(ranking.get('rank')) is int
                and ranking['rank'] > 0
            ):
                tables.setdefault((ranking['gender'], ranking['distance_m']), []).append(ranking)
        order = (event.get('date_end', event.get('date_start', '')), rankings.get('updated_at') or '')
        for key, items in tables.items():
            if key not in ranking_tables or order > ranking_tables[key]['order']:
                ranking_tables[key] = dict(order=order, event_id=event['id'], city=event['city'], items=items)
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
    ranking_events = {}
    for table in ranking_tables.values():
        ranking_events[table['event_id']] = dict(event_id=table['event_id'], city=table['city'])
        for ranking in table['items']:
            person = people.get(ranking['athlete_id'])
            if person and person['gender'] == ranking['gender']:
                person.setdefault('season_rankings', []).append(
                    dict(distance_m=ranking['distance_m'], rank=ranking['rank'])
                )
    for person in people.values():
        if 'season_rankings' in person:
            person['season_rankings'].sort(key=lambda r: r['distance_m'])
    finals.sort(key=lambda f: (f['utc_start'], f['event_id']), reverse=True)
    datasets = {
        'portal.json': dict(schema_version=1, season=calendar['season'], finals=finals[:12]),
        'athletes.json': dict(
            schema_version=1,
            season=calendar['season'],
            ranking_as_of=list(ranking_events.values()),
            items=sorted(people.values(), key=lambda p: (p['name'].casefold(), p['id'])),
        ),
    }
    for name, value in datasets.items():
        (out / 'data' / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
