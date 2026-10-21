"""Non-official first-round projections using ISU 2026 Rule 293.

A whole-event roster is never a distance entry or a seeding list. Only a
complete, source-reviewed distance list is accepted. Draws/lane positions,
race outcomes and later-round entrants are deliberately not invented.
"""
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
RULES_URL = 'https://isudam.blob.core.windows.net/isudamcontainer/2026-Short-Track-Sport-Rules-20260513-FINAL-as-of-1-June-2026-1780065543-3994.pdf'
TOUR_URL = 'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/CMS/Corporate-Site/Governance/Transparency/ISU-Communications/2806-ISU-Short-Track-World-Tour-2026-27-1782891715-3107.pdf'
TABLES = json.loads((ROOT / 'data/prediction_tables.json').read_text())
OFFICIAL_HOSTS = {'isu.org', 'www.isu.org', 'isu-skating.com', 'www.isu-skating.com',
    'isu-d8g8b4b7ece7aphs.a03.azurefd.net', 'isudam.blob.core.windows.net',
    'shorttrack.sportresult.com', 'front-api.isu.org'}


def official_url(url):
    p = urlsplit(url or '')
    return p.scheme == 'https' and p.hostname in OFFICIAL_HOSTS and not p.username and not p.password and p.port in (None, 443)


def first_round(distance, total):
    """Counts transcribed from the official standard qualifying tables, pp1–4."""
    kind = '1500' if distance == 1500 else '500_1000'
    if distance not in (500, 1000, 1500) or str(total) not in TABLES['first_round_heat_counts'][kind]:
        return None
    preliminary = total >= (64 if distance == 1500 else 41)
    stage = ('heats' if preliminary else 'quarterfinal') if distance == 1500 else ('preliminaries' if preliminary else 'heats')
    return dict(round=stage, heat_count=TABLES['first_round_heat_counts'][kind][str(total)],
                prequalified_count=20 if preliminary else 0)


def snake_groups(people, heat_count, separate_country=True):
    """Rule 293.4 snake, then 293.5 same-row moves/swaps for country clashes.

    Choice of official discretionary prior-row changes is unknowable. Keep
    unresolved clashes visible; never claim this is the Competition Coordinator's
    unique answer. No operation moves a skater between seeding rows.
    """
    groups = [[] for _ in range(heat_count)]
    adjustments = 0
    for start in range(0, len(people), heat_count):
        row = people[start:start + heat_count]
        order = list(range(heat_count))
        if (start // heat_count) % 2:
            order.reverse()
        placed = {}
        for person in row:
            available = [g for g in order if g not in placed]
            target = available[0]
            country = person['country']
            clash = lambda g, c: any(p['country'] == c for p in groups[g])
            if separate_country and clash(target, country):
                # Next available race within this seeding row.
                free = next((g for g in available if not clash(g, country)), None)
                if free is not None:
                    target = free
                    adjustments += 1
                else:
                    # Exchange with previously placed skaters on this same row.
                    for previous in reversed(list(placed)):
                        other = placed[previous]
                        if not clash(previous, country) and not clash(target, other['country']):
                            placed[previous] = person
                            person = other
                            adjustments += 1
                            break
            placed[target] = person
        # A short final row may shift to a later free race for country separation.
        for g, person in placed.items():
            groups[g].append(person)
    conflicts = []
    for i, group in enumerate(groups, 1):
        countries = [p['country'] for p in group]
        if separate_country and len(countries) != len(set(countries)):
            conflicts.append(i)
    return [dict(heat_number=i, participants=p, has_china=any(x['country'] == 'CHN' for x in p))
            for i, p in enumerate(groups, 1)], adjustments, conflicts


def validate_seed_list(item, event_id):
    if item.get('event_id') != event_id or item.get('complete') is not True:
        raise ValueError('Prediction requires a complete distance entry list for this event')
    if item.get('gender') not in ('women', 'men') or item.get('distance_m') not in (500, 1000, 1500):
        raise ValueError('Unsupported prediction discipline')
    if not item.get('source_urls') or not all(official_url(u) for u in item['source_urls']):
        raise ValueError('Prediction inputs require official sources')
    if not item.get('verified_at'):
        raise ValueError('Prediction input review date missing')
    if datetime.fromisoformat(item['verified_at'].replace('Z', '+00:00')).utcoffset() is None:
        raise ValueError('Prediction review date requires timezone')
    people = item.get('participants', [])
    if not people or len(people) > 95:
        raise ValueError('Unsupported or empty prediction entry count')
    ids, ranks = set(), set()
    for p in people:
        aid, rank = p.get('athlete_id'), p.get('seed_rank')
        if not aid or aid in ids or type(rank) is not int or rank < 1 or rank in ranks:
            raise ValueError('Duplicate/missing athlete or unresolved seeding order')
        if not p.get('name') or not re.fullmatch('[A-Z]{3}', p.get('country', '')):
            raise ValueError('Invalid prediction participant')
        if type(p.get('prequalified')) is not bool:
            raise ValueError('Prequalification must be explicitly confirmed for every entrant')
        ids.add(aid)
        ranks.add(rank)
    if ranks != set(range(1, len(people) + 1)):
        raise ValueError('Incomplete seeding list; ties must be resolved in the official input')


def project(event_id, schedule, snapshot, inputs=None):
    inputs = inputs or dict(schema_version=1, event_id=event_id, seed_lists=[])
    if inputs.get('schema_version') != 1 or inputs.get('event_id') != event_id:
        raise ValueError('Prediction input schema/event mismatch')
    seed_lists = {}
    observations = {}
    for observed in inputs.get('observed_lists', []):
        key = (observed.get('gender'), observed.get('distance_m'))
        if key not in {(g, d) for g in ('women', 'men') for d in (500, 1000, 1500)} or key in observations:
            raise ValueError('Invalid or duplicate observed distance')
        if not observed.get('source_urls') or not all(official_url(u) for u in observed['source_urls']):
            raise ValueError('Observed distance needs official sources')
        observations[key] = observed
    for item in inputs['seed_lists']:
        validate_seed_list(item, event_id)
        key = (item['gender'], item['distance_m'])
        if key in seed_lists:
            raise ValueError('Duplicate prediction distance list')
        seed_lists[key] = item
    output = []
    for gender in ('women', 'men'):
        for distance in (500, 1000, 1500):
            candidates = [r for r in schedule if r['gender'] == gender and r['distance_m'] == distance
                          and r['format'] == 'individual' and r['session'] == 'qualifying']
            target = candidates[0] if candidates else None
            item = dict(id=f'{gender}-{distance}', gender=gender, distance_m=distance,
                round_key=target['round_key'] if target else None, round=target['round'] if target else None,
                status='waiting_for_data', missing=['distance_seeding_list'], groups=[], prequalified=[],
                source_urls=[], updated_at=None, country_adjustments=0, country_conflicts=[])
            official = [h for h in snapshot['rounds']['items'] if target and h.get('round_key') == target['round_key']
                        and h.get('evidence') in ('official_start_list', 'official_results')]
            seed = seed_lists.get((gender, distance))
            observed = observations.get((gender, distance))
            if observed:
                item.update(entry_count=len(observed['participants']),
                    seeded_count=sum(p.get('seed_rank') is not None for p in observed['participants']),
                    observed_entries=observed['participants'])
            if official:
                item.update(status='official_available', missing=[], source_urls=sorted({h['source_url'] for h in official}))
            elif not target:
                item['missing'] = ['schedule', 'distance_seeding_list']
            elif seed:
                people = sorted(seed['participants'], key=lambda p: p['seed_rank'])
                plan = first_round(distance, len(people))
                item.update(source_urls=seed['source_urls'], updated_at=seed['verified_at'])
                if not plan:
                    item['missing'] = ['qualifying_table']
                elif plan['round'] != target['round']:
                    item['missing'] = ['matching_schedule']
                elif sum(p['prequalified'] for p in people) != plan['prequalified_count']:
                    item['missing'] = ['prequalification_list']
                else:
                    entrants = [p for p in people if not p['prequalified']]
                    groups, changes, conflicts = snake_groups(entrants, plan['heat_count'],
                        separate_country=plan['round'] not in ('quarterfinal', 'semifinal'))
                    item.update(status='predicted', missing=[], groups=groups,
                        prequalified=[p for p in people if p['prequalified']],
                        country_adjustments=changes, country_conflicts=conflicts)
            elif observed:
                item.update(missing=observed.get('missing') or ['distance_seeding_list'],
                    source_urls=observed['source_urls'], updated_at=observed.get('verified_at'))
                if 'prequalification_list' not in item['missing'] and 'prequalification_tie' not in item['missing']:
                    item['prequalified'] = [p for p in observed['participants'] if p.get('prequalified')]
            output.append(item)
    return dict(schema_version=1, event_id=event_id, resource='predictions',
        status='available' if any(i['status'] == 'predicted' for i in output) else 'waiting_for_data',
        evidence='model_prediction_not_official', model_version='isu-2026-first-round-v1',
        update_status=inputs.get('update_status', 'not_checked'),
        checked_at=inputs.get('checked_at'),
        stale=inputs.get('update_status') == 'error',
        rules=[dict(label='ISU 规则 293', url=RULES_URL), dict(label='世巡赛通告 2806 §7', url=TOUR_URL),
               dict(label='2026/27 晋级表', url=TABLES['source_url'])],
        limitations=['country_discretion', 'no_lane_prediction', 'first_qualifying_round_only'],
        total=len(output), items=output)


def export(out, venues, schedules):
    import competition_data
    directory = out / 'data/predictions'
    directory.mkdir(parents=True, exist_ok=True)
    for event in venues:
        event_id = event[0]
        path = ROOT / 'data/prediction_inputs' / f'{event_id}.json'
        inputs = json.loads(path.read_text()) if path.exists() else None
        result = project(event_id, schedules.get(event_id, []),
                         competition_data.load_snapshot(event_id), inputs)
        (directory / f'{event_id}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
