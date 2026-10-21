#!/usr/bin/env python3
"""Synchronize official ISU distance entries and historic distance standings.

The public Entries tab identifies skaters per distance. Historical WCD decides
the first 20 byes at World Tour #1; WRD orders the first qualifying round.
An incomplete upload, tied draw or missing ranking leaves the model waiting.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.request import Request, build_opener

from bs4 import BeautifulSoup

import competition_data as data
import predict_groups
import sync_competitions as sync

CONFIG = data.ROOT / 'data/competition_sources.json'
INPUTS = data.ROOT / 'data/prediction_inputs'
API = 'https://front-api.isu.org'
STANDINGS = 'https://isu-skating.com/en/short-track/world-standings/'
DISTANCES = {(g, d) for g in ('women', 'men') for d in (500, 1000, 1500)}
MIN_STABLE = timedelta(minutes=29)
# Historic (previous-season) standings are frozen, so each list is fetched once and kept here.
RANKING_CACHE = INPUTS / 'historic_rankings.json'
MAX_PAGES = 20


def post_json(url, payload):
    if not sync.allowed(url):
        raise ValueError('Non-official ranking endpoint')
    req = Request(url, data=json.dumps(payload).encode('utf-8'),
                  headers={'User-Agent': 'SSTS-WB/1.0 (+https://github.com/dupirou/ssts_wb)',
                           'Content-Type': 'application/json', 'Accept': 'application/json'})
    with build_opener(sync.OfficialRedirect()).open(req, timeout=25) as response:
        body = response.read(sync.MAX_BYTES + 1)
    if len(body) > sync.MAX_BYTES:
        raise ValueError('ISU response exceeds size limit')
    return body


def property_from_page(body, property_name):
    """Read one JSON property from Next's quoted server transport; no JS eval."""
    soup = BeautifulSoup(body, 'html.parser')
    decoder = json.JSONDecoder()
    marker = '"' + property_name + '":'
    for script in soup.find_all('script'):
        for match in re.finditer(r'self\.__next_f\.push\(', script.get_text()):
            try:
                frame, _ = decoder.raw_decode(script.get_text()[match.end():])
            except ValueError:
                continue
            if len(frame) < 2 or not isinstance(frame[1], str):
                continue
            pos = frame[1].find(marker)
            if pos >= 0:
                value, _ = decoder.raw_decode(frame[1][pos + len(marker):])
                return value
    raise ValueError('Missing ISU ' + property_name)


def response(body, endpoint, page=None):
    obj = json.loads(body)
    if not isinstance(obj, dict) or obj.get('status') != 200 or not isinstance(obj.get('data'), list):
        raise ValueError('Unsupported ISU response: ' + endpoint)
    if page is not None:
        if type(obj.get('current_page')) is not int or obj['current_page'] != page:
            raise ValueError('Unexpected ranking page')
        if type(obj.get('total_page')) is not int or not 1 <= obj['total_page'] <= MAX_PAGES:
            raise ValueError('Unexpected ranking page count')
        if type(obj.get('total_items')) is not int or not 1 <= obj['total_items'] <= 300:
            raise ValueError('Unexpected ranking item count')
        if obj.get('is_next_page') != ('Y' if page < obj['total_page'] else 'N'):
            raise ValueError('Inconsistent ranking pagination')
    return obj


def discover_events(body, cfg):
    sync.assert_identity(BeautifulSoup(body, 'html.parser').get_text(' ', strip=True), cfg)
    events = property_from_page(body, 'eventResults')
    if not isinstance(events, list):
        raise ValueError('Invalid eventResults shape')
    found = {}
    for item in events:
        if item.get('discipline_type') != 'Singles':
            continue
        gender = {'Women': 'women', 'Men': 'men'}.get(item.get('gender'))
        distance = item.get('discipline_distance')
        key = (gender, int(distance)) if gender and str(distance) in ('500', '1000', '1500') else None
        if key is None:
            continue
        if (item.get('event_id') != cfg['prediction']['event_id']
                or item.get('discipline_id') != 3
                or item.get('name') != f'{item["gender"]} {distance} m'
                or type(item.get('event_result_id')) is not int or key in found):
            raise ValueError('ISU distance/event identity mismatch')
        found[key] = item
    if set(found) != DISTANCES:
        raise ValueError('Six individual ISU distance results required')
    return found


def parse_entries(body, event, key, cfg):
    rows = response(body, 'distance entry')['data']
    if not rows or len(rows) > 95:
        raise ValueError('Unexpected distance entry count')
    gender, distance = key
    seen, output = set(), []
    for row in rows:
        skater = row.get('skaters') or {}
        sid, country, name = row.get('skaters_id'), row.get('started_for_nf_code'), skater.get('full_name')
        if (row.get('event_id') != cfg['prediction']['event_id']
                or row.get('event_result_id') != event['event_result_id']
                or type(sid) is not int or sid <= 0 or sid in seen
                or not isinstance(name, str) or not name.strip()
                or not re.fullmatch(r'[A-Z]{3}', country or '')
                or skater.get('gender') != ('F' if gender == 'women' else 'M')
                or skater.get('id') != sid):
            raise ValueError('Invalid or duplicate ISU distance entrant')
        seen.add(sid)
        output.append(dict(athlete_id=data.athlete_id(name, country, gender),
                           official_skater_id=sid, name=name.strip(), country=country))
    if len({r['athlete_id'] for r in output}) != len(output):
        raise ValueError('Ambiguous local athlete identity')
    return sorted(output, key=lambda r: (r['country'], r['official_skater_id']))


def discover_rankings(body, season, season_id):
    obj = response(body, 'ranking catalogue', 1)
    if obj['total_page'] != 1 or len(obj['data']) != obj['total_items']:
        raise ValueError('Ranking catalogue incomplete')
    found = {}
    for row in obj['data']:
        gender = {'Women': 'women', 'Men': 'men'}.get(row.get('gender'))
        distance = row.get('discipline_distance')
        key = (gender, int(distance)) if gender and str(distance) in ('500', '1000', '1500') else None
        kind = row.get('type')
        if (key not in DISTANCES or kind not in ('WCD', 'WRD')
                or row.get('season_name') != season or row.get('level_name') != 'Senior'
                or row.get('team_type') != 'Singles'):
            continue
        if (row.get('season_id') != season_id or row.get('discipline_id') != 3
                or type(row.get('world_standings_list_fsk_id')) is not int
                or (key, kind) in found):
            raise ValueError('Ambiguous historic distance ranking')
        found[key, kind] = row
    if set(found) != {(key, kind) for key in DISTANCES for kind in ('WCD', 'WRD')}:
        raise ValueError('Missing historic WCD or WRD for an individual distance')
    return found


def ranking_rows(meta, sender=post_json):
    rid = meta['world_standings_list_fsk_id']
    url = API + '/events/get-world-standings-fsk-detail-skater-single'
    output, total = {}, None
    for page in range(1, MAX_PAGES + 1):
        obj = response(sender(url, {'world_standings_list_fsk_id': rid, 'page': page}),
                       'ranking detail', page)
        detail = obj.get('detail') or {}
        if any(detail.get(k) != meta.get(k) for k in
               ('world_standings_list_fsk_id', 'season_name', 'gender',
                'discipline_distance', 'type', 'level_name')):
            raise ValueError('Ranking page belongs to another list')
        if total is None:
            total = (obj['total_items'], obj['total_page'])
        elif total != (obj['total_items'], obj['total_page']):
            raise ValueError('Ranking pagination changed during fetch')
        for row in obj['data']:
            sid = row.get('skaters_id')
            skater = row.get('skaters') or {}
            if (row.get('world_standings_list_fsk_id') != rid or
                    type(sid) is not int or sid <= 0 or sid in output or
                    skater.get('id') != sid or
                    type(row.get('rank')) is not int or row['rank'] <= 0 or
                    type(row.get('points')) is not int or row['points'] < 0 or
                    not re.fullmatch(r'[A-Z]{3}', row.get('nf_for_country_code') or '')):
                raise ValueError('Unsupported or duplicate ranking row')
            output[sid] = dict(rank=row['rank'], points=row['points'])
        if page == obj['total_page']:
            if len(output) != obj['total_items']:
                raise ValueError('Incomplete historic distance ranking')
            return output
    raise ValueError('Ranking request budget exceeded')


def cached_rankings(catalog, sender, season, path=RANKING_CACHE):
    """Rows for each historic list, requesting ISU only for lists not cached yet."""
    cache = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if cache and (cache.get('schema_version') != 1 or cache.get('season') != season):
        cache = {}
    lists = cache.get('lists', {})
    rows, added = {}, False
    for key, meta in catalog.items():
        rid = str(meta['world_standings_list_fsk_id'])
        if rid not in lists:
            lists[rid] = {str(sid): row for sid, row in ranking_rows(meta, sender).items()}
            added = True
        rows[key] = {int(sid): row for sid, row in lists[rid].items()}
    if added:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict(schema_version=1, season=season, lists=lists),
                                   ensure_ascii=False, sort_keys=True) + '\n', encoding='utf-8')
    return rows


def predictions_settled(event_id):
    """Every distance has an official start list or results: predictions no longer matter."""
    rounds = data.load_snapshot(event_id)['rounds']['items']
    official = {(r.get('gender'), r.get('distance_m')) for r in rounds
                if r.get('evidence') in ('official_start_list', 'official_results') and r.get('format') != 'relay'}
    return DISTANCES <= official


def select_byes(people, tour, world, count):
    """Select entered WCD point earners, then fill from entered WRD skaters."""
    if count == 0:
        return set(), None
    scored = [p for p in people if (r := tour.get(p['official_skater_id'])) and r['points'] > 0]
    scored.sort(key=lambda p: (tour[p['official_skater_id']]['rank'], p['official_skater_id']))
    if (len(scored) > count and
            tour[scored[count - 1]['official_skater_id']]['rank'] ==
            tour[scored[count]['official_skater_id']]['rank']):
        return set(), 'prequalification_tie'
    selected = scored[:count]
    if len(selected) < count:
        remaining = [p for p in people if p not in selected and p['official_skater_id'] in world]
        remaining.sort(key=lambda p: (world[p['official_skater_id']]['rank'], p['official_skater_id']))
        missing = count - len(selected)
        if len(remaining) < missing:
            return set(), 'prequalification_list'
        if (len(remaining) > missing and
                world[remaining[missing-1]['official_skater_id']]['rank'] ==
                world[remaining[missing]['official_skater_id']]['rank']):
            return set(), 'prequalification_tie'
        selected += remaining[:missing]
    return {p['official_skater_id'] for p in selected}, None


def seed_order(people, world):
    ranked = [p for p in people if p['official_skater_id'] in world]
    ranked.sort(key=lambda p: (world[p['official_skater_id']]['rank'], p['official_skater_id']))
    ranks = [world[p['official_skater_id']]['rank'] for p in ranked]
    if len(ranks) != len(set(ranks)):
        return ranked, 'ranking_tie'
    if len(ranked) != len(people):
        return ranked, 'unranked_draw'
    return ranked, None


def stable_since(previous, entrants, now):
    keys = ('athlete_id', 'official_skater_id', 'name', 'country')
    old_ids = sorted(tuple(p.get(k) for k in keys) for p in (previous or {}).get('participants', []))
    new_ids = sorted(tuple(p.get(k) for k in keys) for p in entrants)
    if previous and old_ids == new_ids and previous.get('first_seen_at'):
        first = datetime.fromisoformat(previous['first_seen_at'].replace('Z', '+00:00'))
        if first.utcoffset() is not None and first <= now:
            return first
    return now


def make_observation(key, entrants, world, tour, previous, timestamp, schedule,
                     feed_consistent=True):
    now = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
    if now.utcoffset() is None:
        raise ValueError('Naive sync time')
    gender, distance = key
    first = stable_since(previous, entrants, now)
    plan = predict_groups.first_round(distance, len(entrants))
    expected = next((r['round'] for r in schedule if r['gender'] == gender and
                     r['distance_m'] == distance and r['format'] == 'individual' and
                     r['session'] == 'qualifying'), None)
    byes, bye_issue = select_byes(entrants, tour, world, plan['prequalified_count']) if plan else (set(), None)
    ordered, seed_issue = seed_order(entrants, world)
    order = {p['official_skater_id']: n for n, p in enumerate(ordered, 1)}
    missing = []
    if not plan or plan['round'] != expected:
        missing.append('matching_schedule' if plan else 'qualifying_table')
    if now - first < MIN_STABLE or not feed_consistent:
        missing.append('awaiting_complete_entries')
    if bye_issue:
        missing.append(bye_issue)
    if seed_issue:
        missing.append(seed_issue)
    verified_byes = (not bye_issue and plan is not None and plan['round'] == expected
                     and 'awaiting_complete_entries' not in missing)
    decorated = [dict(p, seed_rank=order.get(p['official_skater_id']),
                      world_rank=world.get(p['official_skater_id'], {}).get('rank'),
                      tour_rank=tour.get(p['official_skater_id'], {}).get('rank'),
                      prequalified=(p['official_skater_id'] in byes) if verified_byes else None)
                 for p in entrants]
    return dict(event_id='vancouver', gender=gender, distance_m=distance,
                first_seen_at=first.isoformat(), verified_at=timestamp,
                complete=not missing, missing=missing,
                participants=sorted(decorated, key=lambda p: (p['seed_rank'] is None,
                                     p['seed_rank'] or 999, p['name'])))


def sync_event(event_id, cfg, *, now=None, directory=INPUTS, get=sync.fetch,
               form=sync.fetch, sender=post_json):
    if 'prediction' not in cfg:
        return None, []
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    path = directory / (event_id + '.json')
    old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if old and (old.get('schema_version') != 1 or old.get('event_id') != event_id):
        raise ValueError('Prediction snapshot identity mismatch')
    previous = {(r['gender'], r['distance_m']): r for r in old.get('observed_lists', [])}
    if old and predictions_settled(event_id):
        return old, []
    try:
        page = get(cfg['prediction']['entries_url'])
        events = discover_events(page, cfg)
        entries = {}
        for key, event in events.items():
            body = form(API + '/events/get-event-result-entrylist-single',
                        dict(event_result_id=event['event_result_id'],
                             event_id=cfg['prediction']['event_id'], country_code=''))
            entries[key] = parse_entries(body, event, key, cfg)
        raw = sender(API + '/events/get-world-standings-list',
                     dict(discipline_id=3, season_id=cfg['prediction']['standings_season_id'],
                          pagesize=300, page=1))
        catalog = discover_rankings(raw, cfg['prediction']['historical_season'],
                                    cfg['prediction']['standings_season_id'])
        import build
        schedule = build.read_schedule() if event_id == 'vancouver' else []
        # A whole-event roster is used only as a completeness alarm. No roster
        # athlete is inserted into any distance or assigned a seed.
        roster = data.load_snapshot(event_id)['entries']['items']
        coverage = {}
        for gender in ('women', 'men'):
            active = {p['athlete_id'] for p in roster if p['gender'] == gender
                      and p['participation'] == 'active'}
            published = {p['athlete_id'] for key in DISTANCES if key[0] == gender
                         for p in entries[key]}
            coverage[gender] = not active or len(published & active) / len(active) >= 0.55
        observations = []
        ranked = cached_rankings(catalog, sender, cfg['prediction']['historical_season'],
                                 directory / 'historic_rankings.json')
        for key in sorted(DISTANCES):
            tour_meta, world_meta = catalog[key, 'WCD'], catalog[key, 'WRD']
            tour, world = ranked[key, 'WCD'], ranked[key, 'WRD']
            observed = make_observation(key, entries[key], world, tour,
                                        previous.get(key), now, schedule,
                                        feed_consistent=coverage[key[0]])
            observed['event_id'] = event_id
            observed['source_urls'] = [
                cfg['prediction']['entries_url'] + '&type=' + str(events[key]['event_result_id']),
                STANDINGS + str(tour_meta['world_standings_list_fsk_id']) + '/',
                STANDINGS + str(world_meta['world_standings_list_fsk_id']) + '/']
            earlier = previous.get(key)
            if earlier and all(earlier.get(field) == observed.get(field) for field in
                               ('participants', 'missing', 'source_urls', 'first_seen_at')):
                observed['verified_at'] = earlier.get('verified_at', now)
            observations.append(observed)
        result = dict(schema_version=1, event_id=event_id,
                      update_status='ok', checked_at=now, observed_lists=observations,
                      seed_lists=[dict(item, participants=[
                          {k: p[k] for k in ('athlete_id', 'name', 'country', 'seed_rank',
                                            'prequalified', 'world_rank', 'tour_rank')}
                          for p in item['participants']])
                          for item in observations if item['complete']])
        # Only daily check timestamps or material changes are published.
        material = {k: v for k, v in result.items() if k != 'checked_at'}
        old_material = {k: v for k, v in old.items() if k != 'checked_at'}
        if material == old_material and old.get('checked_at', '')[:10] == now[:10]:
            return old, []
    except Exception as exc:
        if not old:
            old = dict(schema_version=1, event_id=event_id, seed_lists=[], observed_lists=[])
        result = dict(old, update_status='error', error=str(exc)[:300])
        if result == old:
            return old, [str(exc)]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return result, [str(exc)]
    path.parent.mkdir(parents=True, exist_ok=True)
    candidate = path.with_suffix('.tmp')
    candidate.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    candidate.replace(path)
    return result, []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--event', default='vancouver')
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text(encoding='utf-8'))['events']
    item, errors = sync_event(args.event, config[args.event])
    print(args.event, [(x['gender'], x['distance_m'], len(x['participants']),
                         x['missing']) for x in item['observed_lists']] if item else 'not configured')
    for error in errors:
        print(error, file=sys.stderr)
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())
