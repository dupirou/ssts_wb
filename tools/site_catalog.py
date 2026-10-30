"""Derived results and current-season athlete indexes."""

import json
from pathlib import Path


def export(out: Path, calendar: dict):
    people, ranking_tables, helmet_evidence = {}, {}, {}
    for event in calendar['stations']:
        path = out / 'data/competitions' / (event['id'] + '.json')
        if not path.exists():
            continue
        snapshot = json.loads(path.read_text(encoding='utf-8'))
        # ISU assigns a single helmet number per athlete for the current season.
        # Confirm it against official individual heats from every available station;
        # never let a conflicting station silently overwrite the season number.
        for heat in snapshot['rounds']['items']:
            if heat.get('format') != 'individual' or heat.get('evidence') not in (
                'official_results',
                'official_start_list',
            ):
                continue
            for participant in heat['participants']:
                number = participant.get('helmet_number')
                if type(number) is not int or number <= 0:
                    continue
                key = (participant.get('athlete_id'), participant.get('country'), heat.get('gender'))
                if key[0] is None:
                    continue
                evidence = helmet_evidence.setdefault(key, dict(numbers=set(), events=set()))
                evidence['numbers'].add(number)
                evidence['events'].add(event['id'])
        for person in snapshot['entries']['items']:
            aid = person['athlete_id']
            item = people.setdefault(
                aid,
                dict(id=aid, name=person['name'], country=person['country'], gender=person['gender'], events=[]),
            )
            if person['name'] != item['name']:
                item.setdefault('aliases', []).append(person['name'])
            item['events'].append(dict(event_id=event['id'], city=event['city'], season=calendar['season']))
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
    for person in people.values():
        evidence = helmet_evidence.get((person['id'], person['country'], person['gender']))
        if evidence and len(evidence['numbers']) == 1:
            person['helmet_number'] = next(iter(evidence['numbers']))
            person['helmet_source_events'] = sorted(evidence['events'])

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
    datasets = {
        'athletes.json': dict(
            schema_version=1,
            season=calendar['season'],
            ranking_as_of=list(ranking_events.values()),
            items=sorted(people.values(), key=lambda p: (p['name'].casefold(), p['id'])),
        ),
    }
    for name, value in datasets.items():
        (out / 'data' / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
