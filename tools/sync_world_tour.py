"""Official current-season ISU World Tour distance classifications (WCD).

These are season point standings, distinct from any station's Event Classification.
Reuse the verified ISU pagination and response contracts in sync_predictions.
"""

import json
import sys
from datetime import datetime, timezone

import competition_data
import stations
import sync_predictions

OUTPUT = competition_data.ROOT / 'data/world_tour_rankings.json'
STANDINGS_URL = 'https://www.isu-skating.com/en/short-track/world-standings/'
DISTANCES = {(g, d) for g in ('men', 'women') for d in (500, 1000, 1500)}


def catalog(body, season_name, season_id):
    value = sync_predictions.response(body, 'current World Tour standings', 1)
    if value.get('total_page') != 1 or value.get('total_items') != len(value['data']):
        raise ValueError('Incomplete World Tour catalogue')
    found = {}
    for row in value['data']:
        gender = {'Men': 'men', 'Women': 'women'}.get(row.get('gender'))
        distance = row.get('discipline_distance')
        key = (gender, int(distance)) if gender and str(distance) in ('500', '1000', '1500') else None
        if (
            key not in DISTANCES
            or row.get('type') != 'WCD'
            or row.get('season_name') != season_name
            or row.get('level_name') != 'Senior'
            or row.get('team_type') != 'Singles'
        ):
            continue
        if (
            row.get('season_id') != season_id
            or row.get('discipline_id') != 3
            or type(row.get('world_standings_list_fsk_id')) is not int
            or key in found
        ):
            raise ValueError('Ambiguous current-season World Tour list')
        found[key] = row
    if set(found) != DISTANCES:
        observed = sorted(
            {
                (
                    str(row.get('season_name')),
                    str(row.get('season_id')),
                    str(row.get('type')),
                    str(row.get('level_name')),
                    str(row.get('team_type')),
                )
                for row in value['data']
                if row.get('discipline_id') == 3
            }
        )
        raise ValueError(
            'Six senior individual World Tour lists required; '
            f'matched={sorted(found)}, official_catalogue={observed[:20]}'
        )
    return found


def known_skaters(directory, station_list):
    """Map official skater IDs to published heats; never infer identity from spelling."""
    identities = {}
    for station in station_list:
        path = directory / (station['id'] + '.json')
        if not path.exists():
            continue
        snapshot = json.loads(path.read_text(encoding='utf-8'))
        for heat in snapshot['rounds']['items']:
            if heat.get('format') != 'individual' or heat.get('evidence') not in (
                'official_start_list',
                'official_results',
            ):
                continue
            for participant in heat['participants']:
                sid = participant.get('official_skater_id')
                if type(sid) is not int:
                    continue
                identity = (participant['athlete_id'], participant['country'], heat['gender'])
                if sid in identities and identities[sid] != identity:
                    raise ValueError('Conflicting ISU skater identity between stations')
                identities[sid] = identity
    if not identities:
        raise ValueError('No verified ISU skaters for World Tour standings')
    return identities


def collect(calendar, sender=sync_predictions.post_json, directory=competition_data.DATA):
    season = calendar['season']
    season_name = season[:5] + '20' + season[5:]
    season_id = calendar.get('world_tour_standings_season_id')
    if type(season_id) is not int:
        raise ValueError('Missing configured season standings ID')
    body = sender(
        sync_predictions.API + '/events/get-world-standings-list',
        dict(discipline_id=3, season_id=season_id, pagesize=300, page=1),
    )
    found = catalog(body, season_name, season_id)
    identities = known_skaters(directory, calendar['stations'])
    tables = []
    for (gender, distance), meta in sorted(found.items()):
        rows = sync_predictions.ranking_rows(meta, sender)
        matched = []
        for sid, place in rows.items():
            known = identities.get(sid)
            if known is None or known[2] != gender:
                continue
            athlete_id, country, _ = known
            matched.append(dict(athlete_id=athlete_id, country=country, rank=place['rank'], points=place['points']))
        if not matched or len({p['athlete_id'] for p in matched}) != len(matched):
            raise ValueError('No unique official skater identities for a published distance list')
        tables.append(
            dict(
                gender=gender,
                distance_m=distance,
                list_id=meta['world_standings_list_fsk_id'],
                items=sorted(matched, key=lambda p: (p['rank'], p['athlete_id'])),
            )
        )
    return dict(schema_version=1, season=season, source_url=STANDINGS_URL, tables=tables)


def sync(calendar, sender=sync_predictions.post_json, directory=competition_data.DATA, path=OUTPUT, now=None):
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    previous = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    try:
        payload = collect(calendar, sender, directory)
    except Exception as exc:
        print(
            f'::warning::Current WCD rankings not verified, retained last accepted snapshot: {exc}',
            file=sys.stderr,
        )
        return previous, False
    old_data = {k: v for k, v in (previous or {}).items() if k not in ('updated_at', 'checked_at')}
    if previous and payload == old_data and previous.get('checked_at', '')[:10] == now[:10]:
        return previous, False
    value = dict(
        payload,
        updated_at=previous.get('updated_at', now) if previous and payload == old_data else now,
        checked_at=now,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    return value, True


def main():
    value, changed = sync(stations.load())
    print('ISU World Tour distance rankings:', len(value['tables']) if value else 0, 'updated:', changed)
    return 0


if __name__ == '__main__':
    sys.exit(main())
