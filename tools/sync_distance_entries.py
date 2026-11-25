#!/usr/bin/env python3
"""Synchronize the official ISU per-distance entry lists.

The public Entries tab identifies which individual distances each entrant is
entered in; the whole-station roster cannot be split by distance, so this is the
only source for the distances shown on an athlete card.

A station is checked from two weeks before its first day and stops once every
distance has an official start list or results, because the stored lists are not
read after that.
"""

import argparse
import json
import re
import sys
import traceback
from datetime import datetime, timezone

from bs4 import BeautifulSoup

import competition_data as data
import isu_rankings
import isu_transport
import stations
import sync_competitions as sync

ENTRIES = data.ROOT / 'data/distance_entries'
API = 'https://front-api.isu.org'
DISTANCES = {(g, d) for g in ('women', 'men') for d in (500, 1000, 1500)}
WINDOW_BEFORE_DAYS = 14


def config(station):
    """Official addresses for one station, derived from `data/stations.json`."""
    cfg = stations.sources(station)
    cfg.update(entries_url=stations.page_url(station, 'entries'), event_id=station['isu']['event_id'])
    return cfg


def discover_events(body, cfg):
    sync.assert_identity(BeautifulSoup(body, 'html.parser').get_text(' ', strip=True), cfg)
    events = isu_transport.next_property(body, 'eventResults')
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
        if (
            item.get('event_id') != cfg['event_id']
            or item.get('discipline_id') != 3
            or item.get('name') != f'{item["gender"]} {distance} m'
            or type(item.get('event_result_id')) is not int
            or item['event_result_id'] <= 0
            or item['event_result_id'] in result_ids
        ):
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
        published = [item for item in items if type(item.get('display_order')) is int and item['display_order'] > 0]
        if len(published) != 1:
            raise ValueError('Ambiguous published ISU distance entries')
        found[key] = published[0]
    return found


def parse_entries(body, event, key, cfg):
    rows = isu_rankings.response(body, 'distance entry')['data']
    if not rows or len(rows) > 95:
        raise ValueError('Unexpected distance entry count')
    gender, distance = key
    seen, output = set(), []
    for row in rows:
        skater = row.get('skaters') or {}
        sid, country, name = row.get('skaters_id'), row.get('started_for_nf_code'), skater.get('full_name')
        if (
            row.get('event_id') != cfg['event_id']
            or row.get('event_result_id') != event['event_result_id']
            or type(sid) is not int
            or sid <= 0
            or sid in seen
            or not isinstance(name, str)
            or not name.strip()
            or not re.fullmatch(r'[A-Z]{3}|AIN[0-9]+', country or '')
            or skater.get('gender') != ('F' if gender == 'women' else 'M')
            or skater.get('id') != sid
        ):
            raise ValueError('Invalid or duplicate ISU distance entrant')
        seen.add(sid)
        output.append(
            dict(
                athlete_id=data.athlete_id(name, country, gender),
                official_skater_id=sid,
                name=name.strip(),
                country=country,
            )
        )
    if len({r['athlete_id'] for r in output}) != len(output):
        raise ValueError('Ambiguous local athlete identity')
    return sorted(output, key=lambda r: (r['country'], r['official_skater_id']))


def entries_settled(event_id):
    """Every distance has an official start list or results: the lists are no longer read."""
    rounds = data.load_snapshot(event_id)['rounds']['items']
    official = {
        (r.get('gender'), r.get('distance_m'))
        for r in rounds
        if r.get('evidence') in ('official_start_list', 'official_results') and r.get('format') != 'relay'
    }
    return DISTANCES <= official


def sync_event(event_id, cfg, *, now=None, directory=ENTRIES, get=sync.fetch, form=sync.fetch):
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    path = directory / (event_id + '.json')
    old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    previous = {(r['gender'], r['distance_m']): r for r in old.get('lists', [])}
    if old and entries_settled(event_id):
        return old, []
    try:
        page = get(cfg['entries_url'])
        events = discover_events(page, cfg)
        lists = []
        for key in sorted(DISTANCES):
            result_id = events[key]['event_result_id']
            body = form(
                API + '/events/get-event-result-entrylist-single',
                dict(event_result_id=result_id, event_id=cfg['event_id'], country_code=''),
            )
            gender, distance = key
            entered = dict(
                gender=gender,
                distance_m=distance,
                participants=parse_entries(body, events[key], key, cfg),
                source_urls=[cfg['entries_url'] + '&type=' + str(result_id)],
            )
            earlier = previous.get(key, {})
            unchanged = all(earlier.get(f) == entered[f] for f in ('participants', 'source_urls'))
            entered['verified_at'] = earlier['verified_at'] if unchanged else now
            lists.append(entered)
        result = dict(schema_version=1, event_id=event_id, update_status='ok', checked_at=now, lists=lists)
        # Only daily check timestamps or material changes are published.
        material = {k: v for k, v in result.items() if k != 'checked_at'}
        old_material = {k: v for k, v in old.items() if k != 'checked_at'}
        if material == old_material and old.get('checked_at', '')[:10] == now[:10]:
            return old, []
    except Exception as exc:
        # Keep the last lists; the build reports them as unverified and stops using them.
        result = dict(
            old or dict(schema_version=1, event_id=event_id, lists=[]), update_status='error', error=str(exc)[:300]
        )
        if result != old:
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return result, [('rejected: ' if isinstance(exc, ValueError) else 'unexpected: ') + str(exc)]
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result, []


def main():
    """Check every station inside its entries window; one station's failure never stops the others."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--event', help='Station ID; default: every station inside its entries window')
    args = parser.parse_args()
    now = stations.utc_now()
    unexpected = False
    for station in stations.stations_to_sync(stations.stations()):
        if args.event and station['id'] != args.event:
            continue
        if not station.get('isu') or not stations.within(station, now, WINDOW_BEFORE_DAYS):
            continue
        try:
            item, errors = sync_event(station['id'], config(station))
        except Exception as exc:
            # One station's unexpected failure keeps its last lists and never stops the others.
            item, errors = None, [('rejected: ' if isinstance(exc, ValueError) else 'unexpected: ') + str(exc)]
            if not isinstance(exc, ValueError):
                traceback.print_exc()
        print(
            station['id'],
            [(x['gender'], x['distance_m'], len(x['participants'])) for x in item['lists']] if item else 'not updated',
        )
        for error in errors:
            is_unexpected = error.startswith('unexpected: ')
            print(
                f'::{"error" if is_unexpected else "warning"}::{station["id"]} entries sync: {error}',
                file=sys.stderr,
            )
            unexpected |= is_unexpected
    return int(unexpected)


if __name__ == '__main__':
    sys.exit(main())
