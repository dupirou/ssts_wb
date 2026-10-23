"""Compare reviewed image rows against the frozen prediction before manual entry."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def compare(reviewed, baseline):
    results = []
    for report in reviewed['reports']:
        prior = next(p for p in baseline['items'] if
                     (p['gender'], p['distance_m']) == (report['gender'], report['distance_m']))
        entrants = next(p['participants'] for p in baseline['lists'] if
                        (p['gender'], p['distance_m']) == (report['gender'], report['distance_m']))
        people = {p['athlete_id']: p for p in entrants}
        groups = {p['athlete_id']: g['heat_number'] for g in prior['groups'] for p in g['participants']}
        rows = []
        for group in report['groups']:
            for p in group['participants']:
                before = people.get(p['athlete_id'])
                old_group = groups.get(p['athlete_id'])
                rows.append(dict(name=p['name'], country=p['country'], athlete_id=p['athlete_id'],
                    present_in_previous_entries=before is not None,
                    world_rank=p['world_rank'], previous_world_rank=before and before['world_rank'],
                    assigned_rank=p['assigned_rank'], heat_number=group['heat_number'],
                    previous_heat_number=old_group,
                    world_rank_matches=before is not None and p['world_rank'] == before['world_rank'],
                    group_matches=None if old_group is None else old_group == group['heat_number']))
        ranked = [p for p in rows if p['world_rank'] is not None]
        results.append(dict(gender=report['gender'], distance_m=report['distance_m'],
            visible_groups=len(report['groups']), visible_people=len(rows),
            ranked_people=len(ranked), world_rank_matches=sum(p['world_rank_matches'] for p in ranked),
            ranked_group_matches=sum(p['group_matches'] is True for p in ranked),
            unranked_people=len(rows)-len(ranked), previous_heat_count=len(prior['groups']),
            rows=rows))
    return dict(schema_version=1, event_id=reviewed['event_id'], baseline_commit=baseline['commit'],
                baseline_checked_at=baseline['checked_at'], coverage='uploaded_pages_only', items=results)


if __name__ == '__main__':
    directory = ROOT / 'data/reviewed_groups'
    result = compare(json.loads((directory / 'vancouver.json').read_text()),
                     json.loads((directory / 'vancouver_prediction_baseline.json').read_text()))
    (directory / 'vancouver_comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    for item in result['items']:
        print(item['distance_m'], {k: v for k, v in item.items() if k != 'rows'})
