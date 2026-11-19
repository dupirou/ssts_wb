#!/usr/bin/env python3
"""Build per-season structured qualification rules (D3) and backfill heat.qualification."""

import argparse
import json
from pathlib import Path
import re

import heats_schema as hs
import qualification

ROOT = Path(__file__).resolve().parents[1]

IOC_RULE_RE = re.compile(
    r'^The\s+(\d+)\s+best\s+athletes?\s+in\s+each\s+(?:Heat|Quarterfinal|Semifinal|race)\s+\(Q\)'
    r'(?:\s+and\s+the\s+(?:(\d+)\s+)?fastest\s+(\d+)(?:st|nd|rd|th)\s+placed\s+athletes?\s+\(q\))?'
    r'\s+qualify\s+for\b',
    re.I,
)


def parse_rule_text(text):
    """Parse ISU or IOC qualification_rule_raw into (big_q, small_q_planned, small_q_from_place) or None."""
    if not text:
        return None
    cleaned = ' '.join(text.split())
    desc = qualification.describe(cleaned)
    if desc and desc.get('code'):
        m = re.fullmatch(r'(\d+)Q(?:\+(\d+)q)?', desc['code'])
        if m:
            bq = int(m[1])
            sq = int(m[2]) if m[2] else 0
            return bq, sq, (bq + 1 if sq else None)
    ioc = IOC_RULE_RE.match(cleaned)
    if ioc:
        bq = int(ioc[1])
        if ioc[3]:
            sq = int(ioc[2]) if ioc[2] else 1
            from_place = int(ioc[3])
        else:
            sq = 0
            from_place = None
        return bq, sq, from_place
    return None


def standard_target_pool(ev_kind, session_type, round_enum, distance_m):
    """Expected main-line qualifier pool size when rule text is absent (from docs/isu_rules_evolution.md §2.3)."""
    if session_type == 'REPECHAGE' and round_enum == 'semifinal':
        return 2
    if session_type == 'MAIN' and round_enum == 'semifinal':
        return 7 if distance_m == 1500 else 5
    if session_type == 'MAIN' and round_enum == 'quarterfinal':
        return 10
    if session_type == 'PRELIM' and round_enum == 'heats':
        return 20 if ev_kind == 'olympics' else 18
    if session_type == 'PRELIM' and round_enum == 'quarterfinal' and distance_m == 1500:
        return 21 if ev_kind == 'olympics' else 19
    if session_type == 'PRELIM' and round_enum == 'preliminaries':
        return 22 if distance_m == 1500 else 20
    return None


def infer_round_rule(ev, round_heats):
    """Determine structured qualification rule for one round and validate ADV-eats-q conservation."""
    h0 = round_heats[0]
    styp = h0['session_type']
    rnd = h0['round']
    dist = h0['distance_m']
    raw_text = h0.get('qualification_rule_raw')
    n_heats = len(round_heats)

    n_q_big = sum(1 for h in round_heats for p in h['participants'] if p['qual_type'] == 'Q')
    n_q_small = sum(1 for h in round_heats for p in h['participants'] if p['qual_type'] == 'q')
    n_adv = sum(
        1 for h in round_heats for p in h['participants'] if p['qual_type'] == 'ADV' and p['qual_target'] in ('NEXT', 'FA')
    )

    parsed = parse_rule_text(raw_text)
    if parsed:
        big_q, small_q_planned, from_place = parsed
        source = 'official_rule_text'
    else:
        max_q_in_heat = max(
            (sum(1 for p in h['participants'] if p['qual_type'] == 'Q') for h in round_heats),
            default=0,
        )
        max_q_rank = max(
            (p['rank'] for h in round_heats for p in h['participants'] if p['qual_type'] == 'Q' and p['rank'] is not None),
            default=0,
        )
        big_q = max(max_q_in_heat, max_q_rank)
        target_pool = standard_target_pool(ev['kind'], styp, rnd, dist)
        if n_q_small > 0:
            small_q_planned = n_q_small + n_adv
            if target_pool is not None and n_heats * big_q + small_q_planned != target_pool and styp != 'PRELIM':
                # Trust observed q + ADV for Rep/special rounds; flag if main/prelim differs.
                pass
        elif n_adv == 0:
            small_q_planned = 0
        elif target_pool is not None:
            small_q_planned = max(0, target_pool - n_heats * big_q)
        else:
            # Fallback for Rep. QF where target Rep SF size is not fixed (e.g. 8-10 skaters).
            small_q_planned = n_adv
        from_place = (big_q + 1) if small_q_planned > 0 else None
        source = 'inferred_from_round_and_table'

    # Validate q_actual = max(0, small_q_planned - n_adv).
    expected_q = max(0, small_q_planned - n_adv)
    exempt_track_block = False
    rule_note = None
    if n_q_small != expected_q:
        # Check if track-block / all-heat ADV special case occurred, or adjust inferred Rep. QF if needed.
        exempt_track_block = True
        rule_note = (
            f'q_actual={n_q_small} differs from max(0, {small_q_planned}-{n_adv})={expected_q}; '
            f'observed n_Q={n_q_big}, n_heats={n_heats}'
        )

    code = f'{big_q}Q' + (f'+{small_q_planned}q' if small_q_planned else '')
    q_obj = {
        'big_q': big_q,
        'small_q_planned': small_q_planned,
        'small_q_from_place': from_place,
        'code': code,
        'rule_ref': raw_text or source,
        'n_heats': n_heats,
        'n_q_big': n_q_big,
        'n_adv': n_adv,
        'q_actual': n_q_small,
    }
    if exempt_track_block:
        q_obj['exempt_track_block'] = True
        q_obj['rule_note'] = rule_note
    return q_obj


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heats-dir', type=Path, default=ROOT / 'data/heats')
    args = parser.parse_args()

    events_doc = json.loads((args.heats_dir / 'events.json').read_text(encoding='utf-8'))
    by_season = {}
    exceptions = []

    for meta in events_doc['items']:
        ev_path = args.heats_dir / meta['file']
        ev = json.loads(ev_path.read_text(encoding='utf-8'))
        season = ev['season']
        season_rules = by_season.setdefault(season, {'schema_version': hs.SCHEMA_VERSION, 'season': season, 'events': {}})

        # Group non-final heats by (gender, distance_m, instance, session_type, round).
        grouped = {}
        for h in ev['heats']:
            if h['round'] == 'final':
                h['qualification'] = None
                continue
            key = (h['gender'], h['distance_m'], h['event_distance_instance'], h['session_type'], h['round'])
            grouped.setdefault(key, []).append(h)

        ev_rule_list = []
        for (gender, dist, inst, styp, rnd), rhs in sorted(grouped.items()):
            q_obj = infer_round_rule(ev, rhs)
            if q_obj.get('exempt_track_block'):
                exceptions.append((ev['event_id'], gender, dist, inst, styp, rnd, q_obj['rule_note']))
            heat_q = {
                'big_q': q_obj['big_q'],
                'small_q_planned': q_obj['small_q_planned'],
                'small_q_from_place': q_obj['small_q_from_place'],
                'rule_ref': q_obj['rule_ref'],
            }
            if q_obj.get('exempt_track_block'):
                heat_q['exempt_track_block'] = True
                heat_q['rule_note'] = q_obj['rule_note']
            for h in rhs:
                h['qualification'] = dict(heat_q)
            ev_rule_list.append({
                'gender': gender,
                'distance_m': dist,
                'event_distance_instance': inst,
                'session_type': styp,
                'round': rnd,
                **q_obj,
            })

        ev_path.write_text(json.dumps(ev, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        season_rules['events'][ev['event_id']] = ev_rule_list

    rules_dir = args.heats_dir / 'rules'
    rules_dir.mkdir(parents=True, exist_ok=True)
    for season, doc in sorted(by_season.items()):
        fname = season.replace('/', '-') + '.json'
        (rules_dir / fname).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f"Wrote {fname}: {len(doc['events'])} events", flush=True)

    print(f'Rule exceptions ({len(exceptions)}):', flush=True)
    for ex in exceptions:
        print(' ', ex, flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
