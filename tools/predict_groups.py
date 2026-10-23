"""Non-official first-round groups from ISU 2026 Rule 293 (see docs/isu-seeding-2026-27.md).

Only skaters with a distance World Ranking have a known seed, so only they are placed. Skaters
without one are seeded by submitted entry times that ISU does not publish; they are listed apart,
and each group shows how many places they fill. Lanes, results and later rounds are not predicted.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS = ROOT / 'data/prediction_inputs'
RULES_URL = 'https://isudam.blob.core.windows.net/isudamcontainer/2026-Short-Track-Sport-Rules-20260513-FINAL-as-of-1-June-2026-1780065543-3994.pdf'
TOUR_URL = 'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/CMS/Corporate-Site/Governance/Transparency/ISU-Communications/2806-ISU-Short-Track-World-Tour-2026-27-1782891715-3107.pdf'
TABLES = json.loads((ROOT / 'data/prediction_tables.json').read_text())


def first_round(distance, total):
    """Counts transcribed from the official standard qualifying tables, pp1–4."""
    kind = '1500' if distance == 1500 else '500_1000'
    if distance not in (500, 1000, 1500) or str(total) not in TABLES['first_round_heat_counts'][kind]:
        return None
    preliminary = total >= (64 if distance == 1500 else 41)
    stage = (
        ('heats' if preliminary else 'quarterfinal')
        if distance == 1500
        else ('preliminaries' if preliminary else 'heats')
    )
    return dict(
        round=stage,
        heat_count=TABLES['first_round_heat_counts'][kind][str(total)],
        prequalified_count=20 if preliminary else 0,
    )


def heat_sizes(total, heat_count):
    """Places per race once every entrant is seeded: full rows, then a snake-direction last row."""
    rows, extra = divmod(total, heat_count)
    order = range(heat_count) if rows % 2 == 0 else reversed(range(heat_count))
    sizes = [rows] * heat_count
    for heat in list(order)[:extra]:
        sizes[heat] += 1
    return sizes


def snake_groups(people, heat_count, separate_country=True):
    """Rule 293.4 snake, then 293.5(a) same-row moves/exchanges for country clashes.

    The referee-approved prior-row changes are discretionary and not modelled; clashes that
    remain are returned. No operation moves a skater between seeding rows.
    """
    groups = [[] for _ in range(heat_count)]
    clash = lambda g, c: any(p['country'] == c for p in groups[g])
    for start in range(0, len(people), heat_count):
        order = list(range(heat_count))
        if (start // heat_count) % 2:
            order.reverse()
        placed = {}
        for person in people[start : start + heat_count]:
            available = [g for g in order if g not in placed]
            target = available[0]
            if separate_country and clash(target, person['country']):
                free = next((g for g in available if not clash(g, person['country'])), None)
                if free is not None:
                    target = free
                else:
                    # Exchange with a skater already placed on this row.
                    for previous, other in reversed(list(placed.items())):
                        if not clash(previous, person['country']) and not clash(target, other['country']):
                            placed[previous], person = person, other
                            break
            placed[target] = person
        for g, person in placed.items():
            groups[g].append(person)
    conflicts = [
        i for i, group in enumerate(groups, 1) if separate_country and len({p['country'] for p in group}) != len(group)
    ]
    return groups, conflicts


def project(event_id, schedule, snapshot, inputs=None):
    lists = {(l['gender'], l['distance_m']): l for l in (inputs or {}).get('lists', [])}
    output = []
    for gender in ('women', 'men'):
        for distance in (500, 1000, 1500):
            target = next(
                (
                    r
                    for r in schedule
                    if r['gender'] == gender
                    and r['distance_m'] == distance
                    and r['format'] == 'individual'
                    and r['session'] == 'qualifying'
                ),
                None,
            )
            item = dict(
                id=f'{gender}-{distance}',
                gender=gender,
                distance_m=distance,
                round_key=target and target['round_key'],
                round=target and target['round'],
                status='waiting_for_data',
                missing=[],
                groups=[],
                unseeded=[],
                prequalified=[],
                source_urls=[],
                updated_at=None,
                country_conflicts=[],
            )
            official = [
                h
                for h in snapshot['rounds']['items']
                if target
                and h.get('round_key') == target['round_key']
                and h.get('evidence') in ('official_start_list', 'official_results')
            ]
            entered = lists.get((gender, distance))
            if official:
                item.update(status='official_available', source_urls=sorted({h['source_url'] for h in official}))
            elif not target:
                item['missing'] = ['schedule']
            elif not entered:
                item['missing'] = ['distance_entries']
            else:
                people = entered['participants']
                plan = first_round(distance, len(people))
                item.update(source_urls=entered['source_urls'], updated_at=entered['verified_at'])
                if entered['missing']:
                    item['missing'] = entered['missing']
                elif not plan or plan['round'] != target['round']:
                    item['missing'] = ['matching_schedule']
                else:
                    racing = [p for p in people if not p['prequalified']]
                    seeded = [dict(p, seed_rank=n) for n, p in enumerate(racing, 1) if p['world_rank'] is not None]
                    # Rule 293.5(a) country separation does not apply when the first round is a quarter-final.
                    groups, conflicts = snake_groups(seeded, plan['heat_count'], plan['round'] != 'quarterfinal')
                    item.update(
                        status='predicted',
                        country_conflicts=conflicts,
                        prequalified=[p for p in people if p['prequalified']],
                        unseeded=[p for p in racing if p['world_rank'] is None],
                        groups=[
                            dict(
                                heat_number=n,
                                size=size,
                                participants=group,
                                has_china=any(p['country'] == 'CHN' for p in group),
                            )
                            for n, (group, size) in enumerate(
                                zip(groups, heat_sizes(len(racing), plan['heat_count'])), 1
                            )
                        ],
                    )
            output.append(item)
    return dict(
        schema_version=1,
        event_id=event_id,
        resource='predictions',
        status='available' if any(i['status'] == 'predicted' for i in output) else 'waiting_for_data',
        evidence='model_prediction_not_official',
        update_status=(inputs or {}).get('update_status', 'not_checked'),
        checked_at=(inputs or {}).get('checked_at'),
        stale=(inputs or {}).get('update_status') == 'error',
        rules=[
            dict(label='ISU 规则 293', url=RULES_URL),
            dict(label='世巡赛通告 2806 §7', url=TOUR_URL),
            dict(label='2026/27 晋级表', url=TABLES['source_url']),
        ],
        total=len(output),
        items=output,
    )


def load_inputs(event_id):
    path = INPUTS / f'{event_id}.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None


def has_open_items(event_id, schedule):
    """Whether the station needs a prediction tab: distance entries exist and some first
    round still has no official groups."""
    import competition_data

    inputs = load_inputs(event_id)
    return bool(inputs) and any(
        i['status'] != 'official_available'
        for i in project(event_id, schedule, competition_data.load_snapshot(event_id), inputs)['items']
    )


def entered_distances(event_id):
    """Individual distances each athlete entered, by athlete_id, from the synced distance entries."""
    found = {}
    for entered in (load_inputs(event_id) or {}).get('lists', []):
        for p in entered['participants']:
            found.setdefault(p['athlete_id'], []).append(entered['distance_m'])
    return {k: sorted(v) for k, v in found.items()}


def export(out, venues, schedules):
    import competition_data

    directory = out / 'data/predictions'
    directory.mkdir(parents=True, exist_ok=True)
    for event in venues:
        event_id = event[0]
        snapshot, inputs = competition_data.load_snapshot(event_id), load_inputs(event_id)
        if inputs:
            # Same spelling as the entry list and the official groups.
            names = competition_data.display_names(snapshot, competition_data.distance_entrants(event_id))
            for p in (p for entered in inputs.get('lists', []) for p in entered['participants']):
                p['name'] = names.get(p['athlete_id'], p['name'])
        result = project(event_id, schedules.get(event_id, []), snapshot, inputs)
        (directory / f'{event_id}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
