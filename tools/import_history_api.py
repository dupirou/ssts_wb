#!/usr/bin/env python3
"""Import adult CHN final classifications from ISU's public results API.

Caches reviewed responses outside the repository. Keeps final classifications
separate from heat ranks and reads relay members only from race snapshots.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

import history_data
import isu_results
import tls

API = 'https://front-api.isu.org/events/'
CITIES = {
    'Montréal': '蒙特利尔',
    'Montreal': '蒙特利尔',
    'Moscow': '莫斯科',
    'Rotterdam': '鹿特丹',
    'Seoul': '首尔',
    'Beijing': '北京',
    'Shanghai': '上海',
    'Dresden': '德累斯顿',
    'Dordrecht': '多德雷赫特',
    'Dordrech': '多德雷赫特',
    'Erzurum': '埃尔祖鲁姆',
    'Minsk': '明斯克',
    'Gangneung': '江陵',
    'Nagoya': '名古屋',
    'Toronto': '多伦多',
    'Salt Lake City': '盐湖城',
    'Calgary': '卡尔加里',
    'Budapest': '布达佩斯',
    'Sofia': '索非亚',
    'Torino': '都灵',
    'Almaty': '阿拉木图',
    'Debrecen': '德布勒森',
    'Gdansk': '格但斯克',
    'Milan': '米兰',
    'Milano Cortina': '米兰',
    'Tilburg': '蒂尔堡',
    'Laval': '拉瓦尔',
}
SEX = {
    'Ladies': 'women',
    'Women': 'women',
    'Men': 'men',
    'Mixed': 'mixed',
    'F': 'women',
    'W': 'women',
    'M': 'men',
    'X': 'mixed',
}


def digest(body):
    return hashlib.sha256(body).hexdigest()


class SourceCache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.context = (
            ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])
            if os.environ.get('SSL_CERT_FILE')
            else tls.CONTEXT
        )

    def read(self, url, form=None):
        if urlsplit(url).hostname not in {'front-api.isu.org', 'www.isu-skating.com', 'isu-skating.com'}:
            raise ValueError('Unexpected official source host')
        form = dict(sorted((form or {}).items()))
        key = digest(json.dumps([url, form], sort_keys=True).encode())
        path = self.directory / (key + '.json' if form else key + '.html')
        if path.exists():
            body = path.read_bytes()
        else:
            request = Request(
                url,
                data=urlencode(form).encode() if form else None,
                headers={
                    'User-Agent': 'SSTS-WB/1.0',
                    **({'Content-Type': 'application/x-www-form-urlencoded'} if form else {}),
                },
            )
            for attempt in range(3):
                try:
                    with urlopen(request, context=self.context, timeout=25) as response:
                        body = response.read(20_000_001)
                    break
                except HTTPError as ex:
                    if ex.code not in {429, 500, 502, 503, 504} or attempt == 2:
                        raise
                    time.sleep(2**attempt)
                except (URLError, TimeoutError):
                    if attempt == 2:
                        raise
                    time.sleep(2**attempt)
            if len(body) > 20_000_000:
                raise ValueError('Official response exceeds size limit')
            path.write_bytes(body)
        return body, dict(url=url, form=form, sha256=digest(body))

    def api(self, endpoint, **form):
        body, source = self.read(API + endpoint, form)
        obj = json.loads(body)
        if obj.get('status') != 200 or not isinstance(obj.get('data'), list):
            raise ValueError('Unsupported official response: ' + endpoint)
        return obj['data'], source


def discipline(meta):
    gender = SEX.get(meta.get('gender'))
    distance = isu_results.integer(meta.get('discipline_distance'))
    relay = (
        meta.get('discipline_type') == 'Couples' or 'relay' in (meta.get('discipline_name', '') + meta['name']).lower()
    )
    if gender == 'mixed' and not distance:
        distance = 2000
    if gender not in {'women', 'men', 'mixed'} or distance not in {500, 1000, 1500, 2000, 3000, 5000}:
        raise ValueError('Unsupported historical discipline: ' + str(meta))
    return dict(gender=gender, distance_m=distance, format='relay' if relay else 'individual')


def official_race_number(meta, fallback):
    """Use the official repeated-distance suffix before API display ordering."""
    match = re.search(r'\((\d+)\)\s*$', meta['name'])
    return int(match[1]) if match else fallback


def included_meta(meta):
    name = meta['name'].lower()
    if any(label in name for label in ('madison', 'overall', 'all-around', 'allround', 'super final', 'superfinal')):
        return False
    return history_data.included_discipline(discipline(meta))


def final_group(heat, round_meta):
    label = (heat.get('name') or '').strip()
    match = re.fullmatch(r'Final\s*([AB])', label, re.I)
    if match:
        return match[1].upper()
    if label.lower() == 'final':
        return 'A'
    match = re.fullmatch(r'Final\s*([AB])', round_meta['name'], re.I)
    return match[1].upper() if match else None


def round_code(meta, group):
    if group:
        return 'F' + group
    name = meta['name'].lower()
    if 'quarter' in name:
        return 'QF'
    if 'semi' in name:
        return 'SF'
    if 'prelim' in name:
        return 'P'
    if 'heat' in name:
        return 'H'
    return None


def collect_missing_classification(cache, meta, disc, total_source):
    relay = disc['format'] == 'relay'
    rounds, doc = cache.api('get-event-result-round', event_result_id=meta['event_result_id'])
    docs = [total_source, doc]
    people = {}
    global_results = False
    for round_meta in sorted(rounds, key=lambda r: (r.get('date') or '', r.get('display_order') or 0)):
        heats, source = cache.api(
            'get-event-result-round-heats-stk-' + ('team' if relay else 'single'),
            event_result_id=meta['event_result_id'],
            event_result_round_id=round_meta['event_result_round_id'],
            country_code='',
        )
        docs.append(source)
        is_final = bool(re.fullmatch(r'Finals?(?:\s+[AB])?', round_meta['name'], re.I))
        for heat in heats:
            if int(heat['event_result_id']) != int(meta['event_result_id']) or int(
                heat['event_result_round_id']
            ) != int(round_meta['event_result_round_id']):
                raise ValueError('Fallback heat identity mismatch')
            entries = heat.get('event_result_round_heats_competitors', heat.get('event_result_round_heats_teams', []))
            global_results = global_results or bool(entries)
            group = final_group(heat, round_meta) if is_final else None
            for p in entries:
                if p.get('started_for_nf_code') != 'CHN':
                    continue
                official_id = p.get('skaters_team_id' if relay else 'skaters_id')
                skater = p.get('skaters') or {}
                key = 'CHN' if relay else official_id
                name = 'China' if relay else skater.get('full_name')
                if not official_id or not name:
                    raise ValueError('Missing historical race identity')
                row = people.setdefault(
                    key,
                    dict(
                        **disc,
                        name=name,
                        country='CHN',
                        rank=None,
                        rank_scope='overall',
                        final_group=None,
                        status='classified',
                        best_time=None,
                        source_page=None,
                        source_url=source['url'],
                        source_ref=source['sha256'],
                        official_result_id=meta['event_result_id'],
                        official_skater_id=official_id,
                        medal_eligible='superfinal' not in meta['name'].lower().replace(' ', ''),
                        classification_missing=True,
                        started=False,
                        **({'members': []} if relay else {}),
                    ),
                )
                result = p.get('final_result') or ''
                if result != 'DNS' and (p.get('final_rank') is not None or result):
                    row['started'] = True
                row['status'] = result if result in history_data.STATUSES else 'classified'
                row['last_round'] = round_meta['name']
                if is_final and group:
                    row.update(
                        rank=isu_results.integer(p.get('final_rank')),
                        rank_scope='final',
                        final_group=group,
                        source_url=source['url'],
                        source_ref=source['sha256'],
                    )
                if relay:
                    code = round_code(round_meta, group)
                    for member in p.get('event_result_round_heats_competitors_team_members', []):
                        athlete = member.get('skaters') or {}
                        sex = SEX.get(athlete.get('gender'))
                        if (
                            sex not in {'men', 'women'}
                            or (disc['gender'] != 'mixed' and sex != disc['gender'])
                            or not code
                        ):
                            continue
                        if not athlete.get('full_name'):
                            continue
                        known = next(
                            (m for m in row['members'] if m['official_skater_id'] == member['skaters_id']), None
                        )
                        if not known:
                            row['members'].append(
                                dict(
                                    name=athlete['full_name'],
                                    gender=sex,
                                    official_skater_id=member['skaters_id'],
                                    rounds=[code],
                                )
                            )
                        elif code not in known['rounds']:
                            known['rounds'].append(code)
    if not global_results:
        raise ValueError('No published classification or actual race results')
    for row in people.values():
        if relay:
            row['lineup_status'] = 'recorded' if row['members'] else 'unavailable'
    return dict(
        meta=meta, disc=disc, results=list(people.values()), documents=docs, incomplete_classification=bool(people)
    )


def collect_discipline(cache, meta):
    disc = discipline(meta)
    relay = disc['format'] == 'relay'
    endpoint = 'get-event-result-fsksys-team' if relay else 'get-event-result-fsk-single'
    rows, total_source = cache.api(
        endpoint, event_id=meta['event_id'], event_result_id=meta['event_result_id'], country_code='', code=''
    )
    if not rows:
        return collect_missing_classification(cache, meta, disc, total_source)
    for r in rows:
        if int(r['event_result_id']) != int(meta['event_result_id']) or int(r['event_id']) != int(meta['event_id']):
            raise ValueError('Final classification identity mismatch')
    chinese = [r for r in rows if r.get('started_for_nf_code') == 'CHN']
    docs = [total_source]
    if not chinese:
        return collect_missing_classification(cache, meta, disc, total_source)
    rounds, round_source = cache.api('get-event-result-round', event_result_id=meta['event_result_id'])
    docs.append(round_source)
    finals, appearances, unavailable_teams = {}, {}, set()
    for round_meta in rounds:
        is_final = bool(re.fullmatch(r'Finals?(?:\s+[AB])?', round_meta['name'], re.I))
        if not relay and not is_final:
            continue
        heats, source = cache.api(
            'get-event-result-round-heats-stk-' + ('team' if relay else 'single'),
            event_result_id=meta['event_result_id'],
            event_result_round_id=round_meta['event_result_round_id'],
            country_code='',
        )
        docs.append(source)
        for heat in heats:
            if int(heat['event_result_id']) != int(meta['event_result_id']) or int(
                heat['event_result_round_id']
            ) != int(round_meta['event_result_round_id']):
                raise ValueError('Heat identity mismatch')
            group = final_group(heat, round_meta) if is_final else None
            people = heat.get('event_result_round_heats_competitors', heat.get('event_result_round_heats_teams', []))
            for person in people:
                if person.get('started_for_nf_code') != 'CHN':
                    continue
                official_id = person.get('skaters_team_id' if relay else 'skaters_id')
                if is_final and group:
                    if official_id in finals:
                        raise ValueError('Competitor appears in both finals')
                    finals[official_id] = dict(
                        group=group,
                        rank=isu_results.integer(person.get('final_rank')),
                        status=person.get('final_result'),
                        source=source,
                    )
                if not relay:
                    continue
                code = round_code(round_meta, group)
                for member in person.get('event_result_round_heats_competitors_team_members', []):
                    skater = member.get('skaters') or {}
                    sex = SEX.get(skater.get('gender'))
                    if sex not in {'women', 'men'} or (disc['gender'] != 'mixed' and sex != disc['gender']):
                        unavailable_teams.add(official_id)
                        continue
                    if not skater.get('full_name') or not member.get('skaters_id') or not code:
                        continue
                    key = (official_id, member['skaters_id'])
                    value = appearances.setdefault(
                        key,
                        dict(name=skater['full_name'], official_skater_id=member['skaters_id'], gender=sex, rounds=[]),
                    )
                    if code not in value['rounds']:
                        value['rounds'].append(code)
    output = []
    for r in chinese:
        oid = r.get('skaters_team_id' if relay else 'skaters_id')
        skater = r.get('skaters_team' if relay else 'skaters') or {}
        rank = isu_results.integer(r.get('final_rank'))
        name = 'China' if relay else skater.get('full_name')
        if not name or not oid:
            raise ValueError('Missing official competitor identity')
        final = finals.get(oid, {})
        status = r.get('final_result') if r.get('final_result') in history_data.STATUSES else 'classified'
        conflict = status == 'classified' and (
            (final.get('group') == 'A' and rank != final.get('rank'))
            or (rank is not None and rank <= 3 and final.get('group') != 'A')
        )
        item = dict(
            **disc,
            name=name,
            country='CHN',
            rank=rank,
            rank_scope='overall',
            final_group=final.get('group'),
            status=status,
            best_time=None,
            source_page=None,
            source_url=API + endpoint,
            source_ref=total_source['sha256'],
            official_result_id=meta['event_result_id'],
            official_skater_id=oid,
            medal_eligible='super final' not in meta['name'].lower(),
        )
        if conflict:
            adopt_current_classification(
                item,
                r,
                total_source,
                dict(
                    rank=final.get('rank'),
                    rank_scope='final' if final.get('group') else 'overall',
                    final_group=final.get('group'),
                    status=final.get('status'),
                    source_ref=final.get('source', total_source)['sha256'],
                    source_url=final.get('source', total_source)['url'],
                ),
            )
        if relay:
            item['members'] = [
                m for (team, _), m in appearances.items() if team == oid and oid not in unavailable_teams
            ]
            item['lineup_status'] = 'recorded' if item['members'] else 'unavailable'
        output.append(item)
    if relay and len(output) > 1:
        positions = {r.get('reported_overall_rank', r['rank']) for r in output}
        groups = {r['final_group'] for r in output if r['final_group']}
        if len(positions) != 1 or len(groups) > 1:
            raise ValueError('Conflicting country relay classifications')
        base = next((r for r in output if r['final_group']), output[0])
        members = {}
        for row in output:
            for member in row['members']:
                key = member['official_skater_id']
                if key not in members:
                    members[key] = dict(member, rounds=list(member['rounds']))
                else:
                    members[key]['rounds'] = list(dict.fromkeys(members[key]['rounds'] + member['rounds']))
        base['members'] = list(members.values())
        base['team_source_ids'] = [r['official_skater_id'] for r in output]
        base['lineup_status'] = 'recorded' if base['members'] else 'unavailable'
        output = [base]
    return dict(meta=meta, disc=disc, results=output, documents=docs)


def adopt_current_classification(row, official, source, previous_final=None):
    """Adopt the currently published final classification and retain the earlier race evidence."""
    rank = isu_results.integer(official.get('final_rank'))
    if rank is None:
        raise ValueError('Current official classification has no rank')
    if previous_final is None:
        previous_final = {
            key: row.get(key) for key in ('rank', 'rank_scope', 'final_group', 'status', 'source_ref', 'source_url')
        }
    row.update(
        previous_final_result=previous_final,
        previous_reported_overall_rank=row.get('reported_overall_rank', row.get('rank')),
        reported_overall_rank=rank,
        rank=rank,
        rank_scope='overall',
        status=official.get('final_result') if official.get('final_result') in history_data.STATUSES else 'classified',
        source_ref=source['sha256'],
        source_url=source['url'],
        classification_conflict=True,
        classification_resolution='current_official_classification',
        classification_selected_at=datetime.now(timezone.utc).isoformat(),
        medal_verified=True,
    )


def register_person(registry, name, gender, official_id):
    key = history_data.identity_key(name, gender)
    matches = [
        p
        for p in registry['items']
        if p['gender'] == gender
        and (
            official_id in p.get('official_skater_ids', [])
            or any(history_data.identity_key(n, gender) == key for n in [p['name'], *p['aliases']])
        )
    ]
    if len(matches) > 1:
        raise ValueError('Conflicting athlete identity: ' + name)
    if matches:
        person = matches[0]
        if official_id not in person.setdefault('official_skater_ids', []):
            person['official_skater_ids'].append(official_id)
        if name not in [person['name'], *person['aliases']]:
            person['aliases'].append(name)
    else:
        person = dict(
            id='isu-' + str(official_id), name=name, gender=gender, aliases=[], official_skater_ids=[official_id]
        )
        registry['items'].append(person)
    return person['id']


def kind_of(e):
    name = e['name'].lower()
    if 'junior' in name or 'youth' in name:
        return None
    if 'olympic' in name:
        return 'olympics'
    if 'four continents' in name:
        return 'fourcontinents'
    if 'world' in name and ('championship' in name):
        return 'worlds'
    if 'world tour' in name:
        return 'worldtour'
    if 'world cup' in name:
        return 'worldcup'
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('calendar', type=Path)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--season')
    parser.add_argument('--event', action='append', help='Limit to an official event ID; may be repeated')
    parser.add_argument('--refresh-api', action='store_true')
    args = parser.parse_args()
    cache = SourceCache(args.cache)
    catalog = json.loads((history_data.DIRECTORY / 'catalog.json').read_text())
    registry = json.loads((history_data.DIRECTORY / 'athletes.json').read_text())
    official = json.loads(args.calendar.read_text())
    selected = [e for e in official if kind_of(e) and (not args.season or e['season'].startswith(args.season))]
    existing = {
        str(
            e.get('official_event_id')
            or (re.search(r'results_(\d+)', e['source_url'])[1] if re.search(r'results_(\d+)', e['source_url']) else '')
        ): e
        for e in catalog['events']
    }
    known = {
        str(e.get('official_event_id'))
        for e in catalog['events']
        if e['coverage'] == 'complete' and not (args.refresh_api and e.get('source_kind') == 'isu_api')
    }
    metadata = {}
    failures = {}
    collected = {}

    def get_meta(e):
        page = (
            'https://www.isu-skating.com/en/short-track/events/eventdetail/'
            + e['slug']
            + '/?tab=results_'
            + str(e['event_id'])
        )
        body, source = cache.read(page)
        rows = isu_results.embedded_results(body)
        from datetime import date, timedelta

        first = date.fromisoformat(e['from_date'][:10]) - timedelta(days=1)
        last = date.fromisoformat(e['to_date'][:10]) + timedelta(days=1)
        rows = [r for r in rows if not r.get('start_date') or first <= date.fromisoformat(r['start_date'][:10]) <= last]
        if not rows or any(str(r['event_id']) != str(e['event_id']) for r in rows):
            raise ValueError('Missing or mismatched discipline metadata')
        return rows, source, page

    pending = [
        e for e in selected if str(e['event_id']) not in known and (not args.event or str(e['event_id']) in args.event)
    ]
    with ThreadPoolExecutor(max_workers=min(args.workers, 6)) as pool:
        futures = {pool.submit(get_meta, e): e for e in pending}
        for f in as_completed(futures):
            e = futures[f]
            try:
                metadata[str(e['event_id'])] = f.result()
            except Exception as ex:
                failures[str(e['event_id'])] = str(ex)
    print('Metadata ready:', len(metadata), 'failed:', failures, flush=True)
    tasks = [(eid, meta) for eid, (rows, _, _) in metadata.items() for meta in rows if included_meta(meta)]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(collect_discipline, cache, meta): (eid, meta) for eid, meta in tasks}
        for i, f in enumerate(as_completed(futures), 1):
            eid, meta = futures[f]
            try:
                collected.setdefault(eid, []).append(f.result())
            except Exception as ex:
                failures[eid] = str(ex)
            if i % 25 == 0 or i == len(tasks):
                print('Disciplines:', i, '/', len(tasks), 'event errors:', len(failures), flush=True)
    for e in sorted(selected, key=lambda e: e['from_date']):
        eid = str(e['event_id'])
        if eid in known:
            continue
        if eid not in metadata or not collected.get(eid):
            continue
        rows, meta_source, page = metadata[eid]
        results = []
        docs = [meta_source]
        by_key = {}
        values = {c['meta']['event_result_id']: c for c in collected[eid]}
        for m in rows:
            if not included_meta(m):
                continue
            disc = discipline(m)
            by_key.setdefault((disc['gender'], disc['distance_m'], disc['format']), []).append(m)
        for group in by_key.values():
            group.sort(key=lambda m: (m.get('start_date') or '', m['display_order'], m['event_result_id']))
            for number, m in enumerate(group, 1):
                c = values.get(m['event_result_id'])
                if c is None:
                    continue
                docs.extend(c['documents'])
                for r in c['results']:
                    if len(group) > 1:
                        r['race_number'] = official_race_number(m, number)
                    if r['format'] == 'individual':
                        r['athlete_id'] = register_person(registry, r['name'], r['gender'], r['official_skater_id'])
                    else:
                        for m in r['members']:
                            m['athlete_id'] = register_person(registry, m['name'], m['gender'], m['official_skater_id'])
                    results.append(r)
        season = e['season'][:5] + e['season'][-2:]
        kind = kind_of(e)
        raw_city = e['city'].split(',')[0].strip()
        city = CITIES.get(raw_city, raw_city)
        siblings = sorted(
            [v for v in official if v['season'] == e['season'] and kind_of(v) == kind], key=lambda v: v['from_date']
        )
        number = next(i + 1 for i, v in enumerate(siblings) if str(v['event_id']) == eid)
        ident = existing.get(eid, {}).get('id') or season.replace('/', '-') + '-' + kind + '-' + re.sub(
            r'[^a-z0-9]+', '-', raw_city.lower().replace('é', 'e')
        ).strip('-') + ('-' + str(number) if kind in {'worldcup', 'worldtour'} else '')
        title = (
            {
                'worlds': '世锦赛',
                'olympics': '冬奥会',
                'fourcontinents': '四大洲锦标赛',
                'worldcup': '世界杯第 ' + str(number) + ' 站',
                'worldtour': '世巡赛第 ' + str(number) + ' 站',
            }[kind]
            + ' · '
            + city
        )
        source = dict(
            kind='isu_api',
            url=page,
            documents=sorted(docs, key=lambda d: (d['url'], json.dumps(d['form'], sort_keys=True))),
            retrieved_at=datetime.now(timezone.utc).isoformat(),
        )
        source['sha256'] = digest(json.dumps(source['documents'], sort_keys=True, separators=(',', ':')).encode())
        meta = dict(
            id=ident,
            season=season,
            kind=kind,
            title=title,
            city=city,
            date_start=e['from_date'][:10],
            date_end=e['to_date'][:10],
            official_event_id=eid,
            source_url=page,
            source_sha256=source['sha256'],
            coverage='partial',
            source_kind='isu_api',
        )
        programme = [
            dict(
                **discipline(m),
                official_result_id=m['event_result_id'],
                name=m['name'],
                medal_eligible='super final' not in m['name'].lower(),
            )
            for m in rows
            if included_meta(m)
        ]
        missing = [m['event_result_id'] for m in rows if m['event_result_id'] not in values and included_meta(m)]
        event = dict(
            schema_version=1,
            competition_id=ident,
            country='CHN',
            participation='recorded' if results else 'none',
            programme=programme,
            missing_disciplines=missing,
            results=results,
            source=source,
        )
        meta['coverage'] = history_data.result_coverage(event)
        try:
            history_data.validate_event(event, meta, registry)
        except ValueError as ex:
            failures[eid] = str(ex)
            continue
        target = history_data.DIRECTORY / 'events' / (ident + '.json')
        target.write_text(json.dumps(event, ensure_ascii=False, indent=2) + '\n')
        if eid in existing:
            catalog['events'][catalog['events'].index(existing[eid])] = meta
        else:
            catalog['events'].append(meta)
        print('Imported', ident, len(results), 'results', flush=True)
    (history_data.DIRECTORY / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
    (history_data.DIRECTORY / 'athletes.json').write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n')
    (args.cache / 'import-errors.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2))
    print('Errors:', failures, flush=True)


if __name__ == '__main__':
    main()
