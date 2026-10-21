"""Audience-facing "what's new" feed, derived only from data the sync already accepted.

data/updates.json remembers every milestone it has announced, so each one is announced once:
an entry list appears or changes, a round's official groups or results are published, a
scheduled start moves, final rankings appear. Event times come from the data's own timestamps,
so rebuilding the same data reproduces the same feed.
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


def digest(*parts):
    return hashlib.sha256('|'.join(map(str, parts)).encode()).hexdigest()[:16]


def parse(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00'))


def discipline(item):
    return dict(gender=item['gender'], distance_m=item['distance_m'], format=item['format'])


def round_facts(event_id, rounds):
    """One 'groups published' and one 'official results' milestone per scheduled round."""
    grouped = {}
    for heat in rounds['items']:
        ident = heat.get('round_key') or '/'.join(map(str, (heat['gender'], heat['distance_m'], heat['format'],
                                                             heat.get('round_label'), heat.get('group'))))
        grouped.setdefault(ident, []).append(heat)
    facts = {}
    for ident, heats in grouped.items():
        first = heats[0]
        base = dict(at=rounds['updated_at'], local_date=first.get('local_date'), round=first['round'],
                    group=first.get('group'),
                    repechage=('/repechage/' in first['round_key']) if first.get('round_key')
                    else bool(re.search(r'\brep(?:echage)?\b', first.get('round_label') or '', re.I)),
                    **discipline(first))
        people = [p for h in heats for p in h['participants']]
        china = sorted({p['name'] for p in people if p['country'] == 'CHN'})
        facts[f'{event_id}/round/{ident}/groups'] = ('published', dict(base, kind='groups', heats=len(heats), china=china))
        if all(h['evidence'] == 'official_results' and (h.get('result_status') or '').lower() == 'official' for h in heats):
            results = dict(base, kind='results', china=china)
            if first['round'] == 'final' and first.get('group') == 'A':
                ranked = sorted((p for p in people if isinstance(p.get('rank'), int) and 1 <= p['rank'] <= 3),
                                key=lambda p: p['rank'])
                results['podium'] = [dict(rank=p['rank'], name=p['name'], country=p['country']) for p in ranked]
            facts[f'{event_id}/round/{ident}/results'] = ('official', results)
    return facts


def collect(venues, schedule, schedule_checked_at, load=competition_data.load_snapshot):
    """Current milestone facts: key -> (value, announcement or None for a silent baseline)."""
    facts = {}
    for venue in venues:
        event_id = venue[0]
        snapshot = load(event_id)
        entries = snapshot['entries']
        if entries['status'] == 'available' and entries['items']:
            facts[f'{event_id}/entries'] = (digest(*sorted(i['id'] for i in entries['items'])),
                dict(kind='entries', at=entries['updated_at'], count=len(entries['items'])))
        facts.update(round_facts(event_id, snapshot['rounds']))
        rankings = snapshot['rankings']
        if rankings['status'] == 'available' and rankings['items']:
            facts[f'{event_id}/rankings'] = (digest(*sorted(i['id'] for i in rankings['items'])),
                dict(kind='rankings', at=rankings['updated_at']))
        for e in schedule.get(event_id, []):
            facts[f'{event_id}/time/{e["round_key"]}'] = (e['beijing_date'] + ' ' + e['beijing_time'],
                dict(kind='time', at=schedule_checked_at, local_date=e['local_date'], round=e['round'],
                     group=e['group'], repechage=e['session'] == 'repechage', **discipline(e)))
    return facts


def update(log, facts):
    """Append an announcement for each new or changed fact; known facts are never forgotten."""
    known = dict(log.get('facts', {}))
    events = list(log.get('events', []))
    for key, (value, event) in sorted(facts.items()):
        old = known.get(key)
        if old == value or not event.get('at'):
            continue  # an undated fact waits until the data carries its own timestamp
        known[key] = value
        if event['kind'] == 'time':
            if old is None:
                continue  # first sighting is the baseline, not a change
            event = dict(event, kind='time_change', previous=old, current=value)
        elif event['kind'] in ('entries', 'rankings') and old is not None:
            event = dict(event, changed=True)
        events.append(dict(id=digest(key, value), station=key.split('/', 1)[0], **event))
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
