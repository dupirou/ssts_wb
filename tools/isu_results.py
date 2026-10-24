"""Adapter for the public JSON endpoints used by ISU's current results UI.

Endpoint names and column mappings were checked against the official site and
a published 2025 Gdansk response. Future schema changes must fail closed.
"""

import json
import re
from bs4 import BeautifulSoup
import competition_data as data
import sync_china

API = 'https://front-api.isu.org'
# Database bookkeeping on each heat row; it says nothing about the skater or the race.
BOOKKEEPING = {
    'event_result_round_heats_competitors_id',
    'event_result_round_heats_teams_id',
    'created_at',
    'updated_at',
}


def embedded_results(body):
    """Decode Next's text transport as data, never evaluate page JavaScript."""
    soup = BeautifulSoup(body, 'html.parser')
    decoder = json.JSONDecoder()
    for script in soup.find_all('script'):
        text = script.get_text()
        match = re.search(r'self\.__next_f\.push\(', text)
        if not match:
            continue
        try:
            frame, _ = decoder.raw_decode(text[match.end() :])
        except ValueError:
            continue
        if len(frame) < 2 or not isinstance(frame[1], str):
            continue
        marker = '"eventResultsData":'
        position = frame[1].find(marker)
        if position >= 0:
            found, _ = decoder.raw_decode(frame[1][position + len(marker) :])
            if not isinstance(found, list):
                raise ValueError('Unexpected eventResultsData shape')
            return found
    return []


def api_data(body):
    obj = json.loads(body)
    if obj.get('status') != 200 or not isinstance(obj.get('data'), list):
        raise ValueError('ISU API returned an error or unsupported response')
    return obj['data']


def integer(value):
    if value is None or value == '':
        return None
    if isinstance(value, bool) or not re.fullmatch(r'\d+', str(value)):
        raise ValueError('Unexpected numeric official field')
    return int(value)


def heat_items(heats, event, round_meta, source_url, schedule=()):
    import sync_competitions as sync

    disc = sync.discipline(event['name'])
    if not disc:
        raise ValueError('Unsupported discipline')
    output = []
    for heat in heats:
        if str(heat['event_result_id']) != str(event['event_result_id']) or str(heat['event_result_round_id']) != str(
            round_meta['event_result_round_id']
        ):
            raise ValueError('ISU API event/round mismatch')
        relay = disc['format'] == 'relay'
        people = heat.get('event_result_round_heats_competitors')
        if people is None and relay:
            people = heat.get('event_result_round_heats_teams')
        if not isinstance(people, list) or not people:
            raise ValueError('Empty or unsupported official heat table')
        # ISU has entered one start-list row twice (2026-10-23, women's 500 m heats 5-8): rows that agree on
        # everything but their own record id and timestamps are one entry. Two different rows for one
        # skater (another lane, rank or time) still fail below.
        content = [{k: v for k, v in p.items() if k not in BOOKKEEPING} for p in people]
        people = [p for i, p in enumerate(people) if content[i] not in content[:i]]
        # Once that heat was raced, ISU filled in one of the two rows and left the other empty: an empty
        # row in the same lane under the same helmet as a filled one adds nothing and is dropped.
        people = [
            p for p in people if not (placeholder(p) and any(same_entry(p, o) and not placeholder(o) for o in people))
        ]
        members = []
        for person in people:
            skater = person.get('skaters_team' if relay else 'skaters') or {}
            country = person.get('started_for_nf_code')
            name = (skater.get('name') or country) if relay else skater.get('full_name')
            if not name or not re.fullmatch(r'[A-Z]{3}', country or ''):
                raise ValueError('Competitor identity missing')
            aid = (
                ('team-' + country + '-' + disc['gender']) if relay else data.athlete_id(name, country, disc['gender'])
            )
            result = person.get('final_result') or None
            # Only the official final_result field supplies PEN/YC/RC. DNS/DNF/ADV
            # are kept as separate result/qualification statuses.
            members.append(
                dict(
                    athlete_id=aid,
                    name=name,
                    country=country,
                    official_skater_id=person.get('skaters_team_id' if relay else 'skaters_id'),
                    helmet_number=integer(person.get('bib_number')),
                    starting_position=integer(person.get('starting_position')),
                    rank=integer(person.get('final_rank')),
                    result=result,
                    qualification=person.get('qualification_code') or None,
                    penalty=sync.penalty(result),
                )
            )
        if len({m['athlete_id'] for m in members}) != len(members):
            raise ValueError('Duplicate competitor in official heat')
        label = heat.get('name', '')
        number = re.fullmatch(r'Heat\s+(\d+)', label, re.I)
        group = re.fullmatch(r'Final\s+([AB])', label, re.I)
        round_info = sync_china.round_from_text(round_meta['name'])
        if round_info is None:
            raise ValueError('Unsupported official round label')
        stage, rep = round_info
        candidates = sync_china.round_matches(
            schedule, (disc['gender'], disc['distance_m'], disc['format']), round_info
        )
        if stage == 'final':
            candidates = [r for r in candidates if group and r['group'] == group[1].upper()]
        if len(candidates) > 1:
            raise ValueError('Ambiguous schedule round mapping')
        match = candidates[0] if candidates else None
        published_result = (heat.get('result_status') or '').lower() in (
            'official',
            'unofficial',
            'provisional',
        ) and any(m['result'] is not None or m['rank'] is not None for m in members)
        output.append(
            dict(
                id='isu-heat-' + str(heat['event_result_round_heats_id']),
                **disc,
                round_key=match['round_key'] if match else None,
                local_date=match['local_date'] if match else None,
                round=stage,
                round_label=round_meta['name'],
                group=group[1].upper() if group else None,
                heat_number=int(number[1]) if number else None,
                heat_label=label,
                source_start=heat.get('date'),
                result_status=heat.get('result_status'),
                evidence='official_results' if published_result else 'official_start_list',
                has_china=any(m['country'] == 'CHN' for m in members),
                source_url=source_url,
                participants=members,
            )
        )
    return output


def placeholder(person):
    """A heat row with no outcome at all: no rank, time, qualification or laps."""
    return (
        person.get('final_rank') in (None, '')
        and str(person.get('final_result') or '').strip().lower() in ('', 'no time')
        and not person.get('qualification_code')
        and not person.get('lap')
    )


def same_entry(a, b):
    """Two heat rows for the same skater or team in the same lane under the same helmet number."""
    keys = ('skaters_id', 'skaters_team_id', 'started_for_nf_code', 'starting_position', 'bib_number')
    return a is not b and all(a.get(k) == b.get(k) for k in keys)


def scheduled_rounds(event, meta, schedule):
    """The scheduled rows one official round stands for: one round, or Final A and B together."""
    import sync_competitions as sync

    disc, stage = sync.discipline(event['name']), sync_china.round_from_text(meta['name'])
    if not disc or not stage:
        return []
    rows = sync_china.round_matches(schedule, (disc['gender'], disc['distance_m'], disc['format']), stage)
    return rows if stage[0] == 'final' or len(rows) == 1 else []


def is_final(items):
    """A round whose every heat already carries official (not provisional) results."""
    return bool(items) and all(
        i.get('evidence') == 'official_results' and (i.get('result_status') or '').lower() == 'official' for i in items
    )


def collect(body, config, api_fetch, schedule=(), known=(), problems=None, rules=None):
    """Read official rounds. Rounds already stored with official results are reused, not
    re-requested; a discipline whose official Final A is stored and whose every stored round is
    official is complete, so even its round list is not requested again.

    With a `problems` list, a round whose official heats fail validation is left out (so the
    caller keeps what it stored from that round's source) and its error appended, instead of one
    bad heat holding back every other round of the event.

    With a `rules` dict, each fetched round's published qualification rule is recorded under the
    round_key of every scheduled round it describes (both finals share one), heats or not."""
    events = embedded_results(body)
    stored = {}
    for item in known:
        stored.setdefault(item.get('source_url'), []).append(item)
    rounds = []
    requests = 0
    seen = set()
    for event in events:
        # Before racing ISU publishes each discipline with start_date null; the event id
        # (when configured) pins the station, and any published date must be in its year.
        start = event.get('start_date')
        if (
            event.get('discipline_id') != 3
            or ('isu_event_id' in config and event.get('event_id') != config['isu_event_id'])
            or (start is not None and not re.match(str(config['year']) + '-', str(start)))
            or (start is None and 'isu_event_id' not in config)
        ):
            raise ValueError('ISU discipline/season mismatch')
        eid = event['event_result_id']
        prefix = config['results_url'] + '&type=' + str(eid) + '&round='
        mine = {url: items for url, items in stored.items() if (url or '').startswith(prefix)}
        if (
            mine
            and all(is_final(items) for items in mine.values())
            and any(i.get('round') == 'final' and i.get('group') == 'A' for items in mine.values() for i in items)
        ):
            reused = [i for items in mine.values() for i in items]
            seen.update(i['id'] for i in reused)
            rounds.extend(reused)
            continue
        metas = api_data(api_fetch('/events/get-event-result-round', {'event_result_id': str(eid)}))
        requests += 1
        for meta in metas:
            if meta['event_result_id'] != eid or meta['event_id'] != event['event_id']:
                raise ValueError('Official round belongs to another event')
            rid = meta['event_result_round_id']
            disc = prefix + str(rid)
            if rules is not None and (meta.get('qualification_rule') or '').strip():
                for row in scheduled_rounds(event, meta, schedule):
                    rules[row['round_key']] = ' '.join(meta['qualification_rule'].split())
            if is_final(stored.get(disc)):
                seen.update(i['id'] for i in stored[disc])
                rounds.extend(stored[disc])
                continue
            team = event.get('discipline_type') == 'Teams' or 'relay' in event['name'].lower()
            endpoint = '/events/get-event-result-round-heats-stk-' + ('team' if team else 'single')
            heats = api_data(
                api_fetch(endpoint, dict(event_result_id=str(eid), event_result_round_id=str(rid), country_code=''))
            )
            requests += 1
            if requests > 100:
                raise ValueError('ISU traversal exceeds request budget')
            if heats:
                try:
                    parsed = heat_items(heats, event, meta, disc, schedule)
                except ValueError as exc:
                    if problems is None:
                        raise
                    problems.append(f'{event["name"]} {meta["name"]}: {exc}')
                    continue
                for item in parsed:
                    if item['id'] in seen:
                        raise ValueError('Duplicate ISU heat ID')
                    seen.add(item['id'])
                rounds.extend(parsed)
    return rounds
