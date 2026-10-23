#!/usr/bin/env python3
"""Synchronize official ISU distance entries and historic distance standings.

The public Entries tab identifies skaters per distance. Historical WCD decides
the 20 byes at World Tour #1; WRD orders the first qualifying round
(docs/isu-seeding-2026-27.md).
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from urllib.request import Request, HTTPSHandler, build_opener

from bs4 import BeautifulSoup

import competition_data as data
import predict_groups
import stations
import tls
import sync_competitions as sync

INPUTS = data.ROOT / 'data/prediction_inputs'
API = 'https://front-api.isu.org'
STANDINGS = 'https://isu-skating.com/en/short-track/world-standings/'
DISTANCES = {(g, d) for g in ('women', 'men') for d in (500, 1000, 1500)}
# Historic (previous-season) standings are frozen, so each list is fetched once and kept here.
RANKING_CACHE = INPUTS / 'historic_rankings.json'
MAX_PAGES = 20


def post_json(url, payload):
    req = Request(url, data=json.dumps(payload).encode('utf-8'),
                  headers={'User-Agent': 'SSTS-WB/1.0 (+https://github.com/dupirou/ssts_wb)',
                           'Content-Type': 'application/json', 'Accept': 'application/json'})
    with build_opener(HTTPSHandler(context=tls.CONTEXT), sync.OfficialRedirect()).open(req, timeout=25) as response:
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
    if page is not None and (obj.get('current_page') != page or type(obj.get('total_page')) is not int):
        raise ValueError('Unexpected ranking page')
    return obj


def discover_events(body, cfg):
    sync.assert_identity(BeautifulSoup(body, 'html.parser').get_text(' ', strip=True), cfg)
    events = property_from_page(body, 'eventResults')
    if not isinstance(events, list):
        raise ValueError('Invalid eventResults shape')
    candidates = {}
    result_ids = set()
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
                or type(item.get('event_result_id')) is not int
                or item['event_result_id'] <= 0 or item['event_result_id'] in result_ids):
            raise ValueError('ISU distance/event identity mismatch')
        result_ids.add(item['event_result_id'])
        candidates.setdefault(key, []).append(item)
    if set(candidates) != DISTANCES:
        raise ValueError('Six individual ISU distance results required')
    found = {}
    for key, items in candidates.items():
        if len(items) == 1:
            found[key] = items[0]
            continue
        # ISU can retain its draft rows (null display_order) alongside the
        # published entries. Only a unique explicitly ordered row is usable.
        published = [item for item in items if type(item.get('display_order')) is int
                     and item['display_order'] > 0]
        if len(published) != 1:
            raise ValueError('Ambiguous published ISU distance entries')
        found[key] = published[0]
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
    output = {}
    for page in range(1, MAX_PAGES + 1):
        obj = response(sender(url, {'world_standings_list_fsk_id': rid, 'page': page}),
                       'ranking detail', page)
        detail = obj.get('detail') or {}
        if any(detail.get(k) != meta.get(k) for k in
               ('world_standings_list_fsk_id', 'season_name', 'gender',
                'discipline_distance', 'type', 'level_name')):
            raise ValueError('Ranking page belongs to another list')
        for row in obj['data']:
            sid = row.get('skaters_id')
            if type(sid) is not int or sid in output or type(row.get('rank')) is not int or type(row.get('points')) is not int:
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
    """§7(a): entered WCD point earners by rank, topped up from WRD. A tie on the cut is
    broken by results ISU does not publish here, so it leaves the byes undecided."""
    chosen = []
    for ranking in (tour, world):
        rank = lambda p: ranking[p['official_skater_id']]['rank']
        pool = sorted((p for p in people if p not in chosen
                       and ranking.get(p['official_skater_id'], {}).get('points', 0) > 0), key=rank)
        need = count - len(chosen)
        if len(pool) > need > 0 and rank(pool[need - 1]) == rank(pool[need]):
            return set(), 'prequalification_tie'
        chosen += pool[:need]
    if len(chosen) < count:
        return set(), 'prequalification_list'
    return {p['official_skater_id'] for p in chosen}, None


def observe(key, entrants, world, tour):
    """One distance: who entered, by WRD rank (ISU breaks equal ranks by recent results, which
    is not modelled), and the byes when the first round has them."""
    gender, distance = key
    plan = predict_groups.first_round(distance, len(entrants))
    byes, issue = select_byes(entrants, tour, world, plan['prequalified_count'] if plan else 0)
    people = [dict(p, world_rank=world.get(p['official_skater_id'], {}).get('rank'),
                   prequalified=p['official_skater_id'] in byes) for p in entrants]
    people.sort(key=lambda p: (p['world_rank'] is None, p['world_rank'] or 0, p['official_skater_id']))
    return dict(gender=gender, distance_m=distance, missing=[issue] if issue else [], participants=people)


def sync_event(event_id, cfg, *, now=None, directory=INPUTS, get=sync.fetch,
               form=sync.fetch, sender=post_json):
    if 'prediction' not in cfg:
        return None, []
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    path = directory / (event_id + '.json')
    old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    previous = {(r['gender'], r['distance_m']): r for r in old.get('lists', [])}
    if old and predictions_settled(event_id):
        return old, []
    try:
        page = get(cfg['prediction']['entries_url'])
        events = discover_events(page, cfg)
        raw = sender(API + '/events/get-world-standings-list',
                     dict(discipline_id=3, season_id=cfg['prediction']['standings_season_id'],
                          pagesize=300, page=1))
        catalog = discover_rankings(raw, cfg['prediction']['historical_season'],
                                    cfg['prediction']['standings_season_id'])
        ranked = cached_rankings(catalog, sender, cfg['prediction']['historical_season'],
                                 directory / 'historic_rankings.json')
        lists = []
        for key in sorted(DISTANCES):
            body = form(API + '/events/get-event-result-entrylist-single',
                        dict(event_result_id=events[key]['event_result_id'],
                             event_id=cfg['prediction']['event_id'], country_code=''))
            entered = observe(key, parse_entries(body, events[key], key, cfg),
                              ranked[key, 'WRD'], ranked[key, 'WCD'])
            entered['source_urls'] = [
                cfg['prediction']['entries_url'] + '&type=' + str(events[key]['event_result_id']),
                STANDINGS + str(catalog[key, 'WCD']['world_standings_list_fsk_id']) + '/',
                STANDINGS + str(catalog[key, 'WRD']['world_standings_list_fsk_id']) + '/']
            earlier = previous.get(key, {})
            unchanged = all(earlier.get(f) == entered[f] for f in ('participants', 'missing', 'source_urls'))
            entered['verified_at'] = earlier['verified_at'] if unchanged else now
            lists.append(entered)
        result = dict(schema_version=2, event_id=event_id, update_status='ok', checked_at=now, lists=lists)
        # Only daily check timestamps or material changes are published.
        material = {k: v for k, v in result.items() if k != 'checked_at'}
        old_material = {k: v for k, v in old.items() if k != 'checked_at'}
        if material == old_material and old.get('checked_at', '')[:10] == now[:10]:
            return old, []
    except Exception as exc:
        # Keep the last lists; the API reports them as stale.
        result = dict(old or dict(schema_version=2, event_id=event_id, lists=[]),
                      update_status='error', error=str(exc)[:300])
        if result != old:
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return result, [str(exc)]
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result, []


def main():
    """Only stations configured with a prediction source (World Tour #1's seeding rule) are modelled."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--event', help='Station ID; default: every station with a prediction source')
    args = parser.parse_args()
    failed = False
    for station in stations.stations():
        cfg = stations.sources(station)
        if (args.event and station['id'] != args.event) or 'prediction' not in cfg:
            continue
        try:
            item, errors = sync_event(station['id'], cfg)
        except Exception as exc:
            # One station's unexpected failure keeps its last inputs and never stops the others.
            item, errors = None, ['unexpected: ' + str(exc)]
        print(station['id'], [(x['gender'], x['distance_m'], len(x['participants']),
                               x['missing']) for x in item['lists']] if item else 'not updated')
        for error in errors:
            print(f"::warning::{station['id']} prediction sync: {error}", file=sys.stderr)
        failed |= bool(errors)
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
