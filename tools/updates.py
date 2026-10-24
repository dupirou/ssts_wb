"""Audience-facing "what's new" feed, derived only from data the sync already accepted.

data/updates.json remembers every milestone it has announced, so each one is announced once:
a station's detailed programme is published, an entry list appears or changes, a round's
official groups or results are published, a scheduled start moves, final rankings appear. Event times come from the data's own timestamps,
so rebuilding the same data reproduces the same feed. A results announcement says where each Chinese
skater or team went from that round; it is refreshed from the current data while the round is
still published, so a repechage or Final B start list that appears later is reflected in it.
"""

import hashlib
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
import competition_data

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / 'data/updates.json'
KEEP_DAYS = 30
KEEP_MAX = 150
ROUND_KINDS = ('groups', 'results')


def digest(*parts):
    return hashlib.sha256('|'.join(map(str, parts)).encode()).hexdigest()[:16]


def parse(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00'))


def discipline(item):
    return dict(gender=item['gender'], distance_m=item['distance_m'], format=item['format'])


def same_discipline(a, b):
    return all(a[k] == b[k] for k in ('gender', 'distance_m', 'format'))


def is_repechage(heat):
    """Whether ISU names the round a repechage ('Rep. Heats'); a main round can sit in the repechage
    session, like the mixed relay semi-final in Vancouver, so the session alone does not say."""
    label = heat.get('round_label')
    if label:
        return bool(re.search(r'\brep(?:echage)?\b', label, re.I))
    return '/repechage/' in (heat.get('round_key') or '')


def standing(person, first, items):
    """One published result: a final's place, or where the round led (advanced, Final B, repechage, out)."""
    out = dict(name=person['name'], rank=person.get('rank'))
    penalty = (person.get('penalty') or {}).get('code')
    if penalty:
        out['penalty'] = penalty
    if first['round'] == 'final':
        return out
    later = set()
    for heat in items:
        if heat.get('round_key') == first.get('round_key') or not same_discipline(heat, first):
            continue
        if not any(p.get('athlete_id') == person.get('athlete_id') for p in heat['participants']):
            continue
        if first['round'] == 'semifinal' and heat['round'] == 'final' and heat.get('group') == 'B':
            later.add('final_b')
        elif is_repechage(heat) and not is_repechage(first):
            later.add('repechage')
    code = (person.get('qualification') or '').upper()
    if 'final_b' in later or (first['round'] == 'semifinal' and code.endswith('B')):
        out['status'] = 'final_b'
    elif code:
        out['status'] = 'advanced'
    elif 'repechage' in later:
        out['status'] = 'repechage'
    else:
        out['status'] = 'out'
    return out


def round_facts(event_id, rounds):
    """One 'groups published' and one 'official results' milestone per scheduled round."""
    grouped = {}
    for heat in rounds['items']:
        ident = heat.get('round_key') or '/'.join(
            map(str, (heat['gender'], heat['distance_m'], heat['format'], heat.get('round_label'), heat.get('group')))
        )
        grouped.setdefault(ident, []).append(heat)
    facts = {}
    for ident, heats in grouped.items():
        first = heats[0]
        base = dict(
            at=rounds['updated_at'],
            local_date=first.get('local_date'),
            round=first['round'],
            group=first.get('group'),
            repechage=is_repechage(first),
            **discipline(first),
        )
        people = [p for h in heats for p in h['participants']]
        china = sorted({p['name'] for p in people if p['country'] == 'CHN'})
        facts[f'{event_id}/round/{ident}/groups'] = (
            'published',
            dict(base, kind='groups', heats=len(heats), china=china),
        )
        if all(
            h['evidence'] == 'official_results' and (h.get('result_status') or '').lower() == 'official' for h in heats
        ):
            standings = [standing(p, first, rounds['items']) for p in people if p['country'] == 'CHN']
            results = dict(base, kind='results', china=china, china_results=sorted(standings, key=lambda s: s['name']))
            if first['round'] == 'final' and first.get('group') == 'A':
                ranked = sorted(
                    (p for p in people if isinstance(p.get('rank'), int) and 1 <= p['rank'] <= 3),
                    key=lambda p: p['rank'],
                )
                results['podium'] = [dict(rank=p['rank'], name=p['name'], country=p['country']) for p in ranked]
            facts[f'{event_id}/round/{ident}/results'] = ('official', results)
    return facts


def collect(venues, schedule, schedule_checked_at, load=competition_data.display_snapshot):
    """Current milestone facts: key -> (value, announcement or None for a silent baseline).

    schedule_checked_at is one timestamp, or a mapping of station id to its last schedule check."""
    facts = {}
    for venue in venues:
        event_id = venue[0]
        checked = schedule_checked_at.get(event_id) if isinstance(schedule_checked_at, dict) else schedule_checked_at
        rows = schedule.get(event_id, [])
        if rows:
            facts[f'{event_id}/schedule'] = (
                'published',
                dict(kind='schedule', at=checked, local_date=rows[0]['local_date'], count=len(rows)),
            )
        snapshot = load(event_id)
        entries = snapshot['entries']
        if entries['status'] == 'available' and entries['items']:
            facts[f'{event_id}/entries'] = (
                digest(*sorted(i['id'] for i in entries['items'])),
                dict(kind='entries', at=entries['updated_at'], count=len(entries['items'])),
            )
        facts.update(round_facts(event_id, snapshot['rounds']))
        rankings = snapshot['rankings']
        if rankings['status'] == 'available' and rankings['items']:
            facts[f'{event_id}/rankings'] = (
                digest(*sorted(i['id'] for i in rankings['items'])),
                dict(kind='rankings', at=rankings['updated_at']),
            )
        for e in rows:
            facts[f'{event_id}/time/{e["round_key"]}'] = (
                e['beijing_date'] + ' ' + e['beijing_time'],
                dict(
                    kind='time',
                    at=checked,
                    local_date=e['local_date'],
                    round=e['round'],
                    group=e['group'],
                    repechage=e['session'] == 'repechage',
                    **discipline(e),
                ),
            )
    return facts


def update(log, facts):
    """Append an announcement for each new or changed fact; known facts are never forgotten."""
    known = dict(log.get('facts', {}))
    fresh = not known  # a brand-new log records what is already published without announcing it
    events = list(log.get('events', []))
    for key, (value, event) in sorted(facts.items()):
        old = known.get(key)
        if old == value or not event.get('at'):
            continue  # an undated fact waits until the data carries its own timestamp
        station = key.split('/', 1)[0]
        if (
            event['kind'] == 'schedule'
            and old is None
            and (fresh or any(k.startswith(station + '/time/') for k in known))
        ):
            known[key] = value
            continue  # a programme already on the site before this notice existed is not news
        known[key] = value
        if event['kind'] == 'time':
            if old is None:
                continue  # first sighting is the baseline, not a change
            event = dict(event, kind='time_change', previous=old, current=value)
        elif event['kind'] in ('entries', 'rankings') and old is not None:
            event = dict(event, changed=True)
        events.append(dict(id=digest(key, value), station=station, **event))
    # A round's announcement keeps its time but follows the data for what it describes.
    current = {digest(key, value): event for key, (value, event) in facts.items() if event['kind'] in ROUND_KINDS}
    events = [
        dict(e, **{k: v for k, v in current[e['id']].items() if k != 'at'})
        if e['kind'] in ROUND_KINDS and e['id'] in current
        else e
        for e in events
    ]
    events.sort(key=lambda e: (parse(e['at']), e['id']))
    if events:
        horizon = parse(events[-1]['at']) - timedelta(days=KEEP_DAYS)
        events = [e for e in events if parse(e['at']) >= horizon][-KEEP_MAX:]
    return dict(schema_version=1, facts=dict(sorted(known.items())), events=events)


def export(out, venues, schedule, schedule_checked_at, path=LOG):
    log = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if log and log.get('schema_version') != 1:
        raise ValueError('Unsupported updates log schema')
    result = update(log, collect(venues, schedule, schedule_checked_at))
    content = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if not path.exists() or path.read_text(encoding='utf-8') != content:
        path.write_text(content, encoding='utf-8')
    feed = dict(schema_version=1, events=result['events'][::-1])
    (out / 'data/updates.json').write_text(json.dumps(feed, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result
