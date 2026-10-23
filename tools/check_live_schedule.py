#!/usr/bin/env python3
"""Race-day check: compare a station's stored programme with ISU's official per-heat times.

Read-only; it prints a report and changes nothing. Once racing starts ISU's schedule tab loads in
the browser and the schedule sync keeps the stored programme (docs/log.md, 2026-10-23), so rounds
that ISU moves or drops are found here and corrected by hand in data/schedules/<id>.csv.

ISU's heat 'date' comes in two forms: heats already raced carry their actual local start written
as if it were UTC ('09:00:07Z' for 09:00 local), and planned heats have been seen both that way and
as true UTC. Both readings are kept; the one on the round's stored local date nearest its stored
time is used, and the report says which, so an ambiguous case is visible rather than guessed.
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import build
import isu_results
import stations
import sync_china
import sync_competitions

RACED = {'official', 'unofficial', 'provisional', 'live'}


def readings(raw, tz):
    """The heat start as local time under both of ISU's forms: (as true UTC, as local clock)."""
    stamp = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    return {'utc': stamp.astimezone(tz).replace(tzinfo=None), 'local': stamp.replace(tzinfo=None)}


def pick(raw, tz, stored):
    """(reading name, local datetime) on the stored date nearest the stored start, or None."""
    options = [(k, v) for k, v in readings(raw, tz).items() if v.date() == stored.date()]
    return min(options, key=lambda kv: abs(kv[1] - stored)) if options else None


def official_rounds(station, fetch=sync_competitions.fetch):
    """Every official round with its first heat: discipline, (stage, rep), group, raw date, status."""
    config = stations.sources(station)
    api = lambda endpoint, form: isu_results.api_data(fetch(isu_results.API + endpoint, form))
    found = []
    for event in isu_results.embedded_results(fetch(config['results_url'])):
        if event.get('discipline_id') != 3 or event.get('event_id') != config.get('isu_event_id'):
            continue
        disc = sync_competitions.discipline(event['name'])
        if not disc:
            raise ValueError('Unsupported discipline: ' + event['name'])
        team = disc['format'] == 'relay'
        for meta in api('/events/get-event-result-round', {'event_result_id': str(event['event_result_id'])}):
            heats = api(
                '/events/get-event-result-round-heats-stk-' + ('team' if team else 'single'),
                dict(
                    event_result_id=str(event['event_result_id']),
                    event_result_round_id=str(meta['event_result_round_id']),
                    country_code='',
                ),
            )
            stage = sync_china.round_from_text(meta['name'])
            if stage is None:
                raise ValueError('Unsupported round label: ' + meta['name'])
            groups = {}
            for heat in heats:
                label = heat.get('name', '')
                group = label[-1].upper() if label.lower().startswith('final ') else None
                groups.setdefault(group, []).append(heat)
            if not heats:
                groups = {None: []}
            for group, items in groups.items():
                first = min(items, key=lambda h: h.get('date') or '') if items else {}
                found.append(
                    dict(
                        disc=disc,
                        stage=stage,
                        label=meta['name'],
                        group=group,
                        heats=len(items),
                        date=first.get('date'),
                        status=(first.get('result_status') or '').lower(),
                    )
                )
    return found


def compare(rows, official, tz):
    """Report lines per stored round, plus official rounds the stored programme lacks."""
    report, matched = [], set()
    for item in official:
        d = item['disc']
        candidates = sync_china.round_matches(rows, (d['gender'], d['distance_m'], d['format']), item['stage'])
        name = f'{d["gender"]} {d["distance_m"]} {d["format"]} {item["label"]}' + (
            f' Final {item["group"]}' if item['group'] else ''
        )
        if item['stage'][0] == 'final' and not item['date']:
            # Finals list no heats until the semi-finals are over; that covers Final A and B alike.
            matched.update(r['round_key'] for r in candidates)
            report.append(dict(kind='no_heats', round=name, detail='no heats published yet'))
            continue
        if item['stage'][0] == 'final':
            candidates = [r for r in candidates if r['group'] == item['group']]
        if len(candidates) != 1:
            report.append(dict(kind='extra', round=name, detail='official round not in stored programme'))
            continue
        row = candidates[0]
        matched.add(row['round_key'])
        stored = datetime.fromisoformat(row['local_start']).replace(tzinfo=None)
        entry = dict(round_key=row['round_key'], round=name, stored=stored.strftime('%m-%d %H:%M'), heats=item['heats'])
        if not item['date']:
            report.append(dict(entry, kind='no_heats', detail='no heats published yet'))
            continue
        both = {k: v.strftime('%m-%d %H:%M') for k, v in readings(item['date'], tz).items()}
        chosen = pick(item['date'], tz, stored)
        raced = item['status'] in RACED
        if chosen is None:
            report.append(dict(entry, kind='unclear', raw=item['date'], readings=both, raced=raced))
            continue
        delta = round((chosen[1] - stored) / timedelta(minutes=1))
        report.append(
            dict(
                entry,
                kind='same' if delta == 0 else 'moved',
                official=chosen[1].strftime('%m-%d %H:%M'),
                reading=chosen[0],
                readings=both,
                delta_min=delta,
                raced=raced,
                status=item['status'],
            )
        )
    for row in rows:
        if row['round_key'] not in matched:
            report.append(
                dict(kind='missing', round_key=row['round_key'], stored=row['local_time'], detail='no official round')
            )
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--station', required=True)
    p.add_argument('--json', action='store_true', help='print the report as JSON')
    args = p.parse_args()
    station = stations.get(args.station)
    tz = ZoneInfo(station['timezone'])
    report = compare(build.read_schedule(args.station), official_rounds(station), tz)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    for line in report:
        if line['kind'] == 'same':
            continue
        print(json.dumps(line, ensure_ascii=False))
    counts = {}
    for line in report:
        counts[line['kind']] = counts.get(line['kind'], 0) + 1
    print('summary:', counts, '(times are', station['timezone'], 'local)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
