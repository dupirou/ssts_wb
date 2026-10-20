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
            frame, _ = decoder.raw_decode(text[match.end():])
        except ValueError:
            continue
        if len(frame) < 2 or not isinstance(frame[1], str):
            continue
        marker = '"eventResultsData":'
        position = frame[1].find(marker)
        if position >= 0:
            found, _ = decoder.raw_decode(frame[1][position + len(marker):])
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
        if str(heat['event_result_id']) != str(event['event_result_id']) or str(heat['event_result_round_id']) != str(round_meta['event_result_round_id']):
            raise ValueError('ISU API event/round mismatch')
        relay = disc['format'] == 'relay'
        people = heat.get('event_result_round_heats_competitors')
        if people is None and relay:
            people = heat.get('event_result_round_heats_teams')
        if not isinstance(people, list) or not people:
            raise ValueError('Empty or unsupported official heat table')
        members = []
        for person in people:
            skater = person.get('skaters_team' if relay else 'skaters') or {}
            country = person.get('started_for_nf_code')
            name = (skater.get('name') or country) if relay else skater.get('full_name')
            if not name or not re.fullmatch(r'[A-Z]{3}', country or ''):
                raise ValueError('Competitor identity missing')
            aid = ('team-' + country + '-' + disc['gender']) if relay else data.athlete_id(name, country, disc['gender'])
            result = person.get('final_result') or None
            # Only the official final_result field supplies PEN/YC/RC. DNS/DNF/ADV
            # are kept as separate result/qualification statuses.
            members.append(dict(athlete_id=aid, name=name, country=country,
                official_skater_id=person.get('skaters_team_id' if relay else 'skaters_id'),
                helmet_number=integer(person.get('bib_number')),
                starting_position=integer(person.get('starting_position')),
                rank=integer(person.get('final_rank')), result=result,
                qualification=person.get('qualification_code') or None,
                penalty=sync.penalty(result)))
        if len({m['athlete_id'] for m in members}) != len(members):
            raise ValueError('Duplicate competitor in official heat')
        label = heat.get('name', '')
        number = re.fullmatch(r'Heat\s+(\d+)', label, re.I)
        group = re.fullmatch(r'Final\s+([AB])', label, re.I)
        round_info = sync_china.round_from_text(round_meta['name'])
        if round_info is None:
            raise ValueError('Unsupported official round label')
        stage, rep = round_info
        candidates = sync_china.round_matches(schedule, (disc['gender'], disc['distance_m'], disc['format']), round_info)
        if stage == 'final':
            candidates = [r for r in candidates if group and r['group'] == group[1].upper()]
        if len(candidates) > 1:
            raise ValueError('Ambiguous schedule round mapping')
        match = candidates[0] if candidates else None
        published_result = (heat.get('result_status') or '').lower() in ('official', 'unofficial', 'provisional') and any(
            m['result'] is not None or m['rank'] is not None for m in members)
        output.append(dict(id='isu-heat-' + str(heat['event_result_round_heats_id']),
            **disc, round_key=match['round_key'] if match else None,
            local_date=match['local_date'] if match else None,
            round=stage, round_label=round_meta['name'],
            group=group[1].upper() if group else None,
            heat_number=int(number[1]) if number else None, heat_label=label,
            source_start=heat.get('date'), result_status=heat.get('result_status'),
            evidence='official_results' if published_result else 'official_start_list',
            has_china=any(m['country'] == 'CHN' for m in members),
            source_url=source_url, participants=members))
    return output


def collect(body, config, api_fetch, schedule=()):
    events = embedded_results(body)
    rounds = []
    requests = 0
    seen = set()
    for event in events:
        if event.get('discipline_id') != 3 or not re.match(str(config['year']) + '-', event.get('start_date', '')):
            raise ValueError('ISU discipline/season mismatch')
        eid = event['event_result_id']
        metas = api_data(api_fetch('/events/get-event-result-round', {'event_result_id': str(eid)}))
        requests += 1
        for meta in metas:
            if meta['event_result_id'] != eid or meta['event_id'] != event['event_id']:
                raise ValueError('Official round belongs to another event')
            rid = meta['event_result_round_id']
            disc = config['results_url'] + '&type=' + str(eid) + '&round=' + str(rid)
            team = event.get('discipline_type') == 'Teams' or 'relay' in event['name'].lower()
            endpoint = '/events/get-event-result-round-heats-stk-' + ('team' if team else 'single')
            heats = api_data(api_fetch(endpoint, dict(event_result_id=str(eid),
                event_result_round_id=str(rid), country_code='')))
            requests += 1
            if requests > 100:
                raise ValueError('ISU traversal exceeds request budget')
            if heats:
                parsed = heat_items(heats, event, meta, disc, schedule)
                for item in parsed:
                    if item['id'] in seen:
                        raise ValueError('Duplicate ISU heat ID')
                    seen.add(item['id'])
                rounds.extend(parsed)
    return rounds
