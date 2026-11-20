#!/usr/bin/env python3
"""Export chronologically sorted heat-start wide tables (JSONL & CSV) for 2022/23–2026/27."""

import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / '.cache/pylib') not in sys.path:
    pylib = ROOT / '.cache/pylib'
    if pylib.exists():
        sys.path.insert(0, str(pylib))

import heats_schema as hs
import penalty_protocol

CSV_COLUMNS = [
    'season',
    'event_id',
    'official_event_id',
    'event_kind',
    'city',
    'local_date',
    'start_time_utc',
    'gender',
    'distance_m',
    'event_distance_instance',
    'session_type',
    'round',
    'final_group',
    'round_tier',
    'round_key',
    'heat_id',
    'heat_number',
    'heat_size',
    'entered_size',
    'lane_mode',
    'athlete_id',
    'official_skater_id',
    'name',
    'country',
    'helmet_number',
    'starting_position',
    'rel_lane',
    'rank',
    'result',
    'time_s',
    'status',
    'penalty',
    'penalty_code',
    'is_incident',
    'incident_type',
    'qual_flag_raw',
    'qual_type',
    'qual_target',
    'advanced',
    'is_repechage_qualifier',
    'opening_split_s',
    'lap_times_s',
    'big_q',
    'small_q_planned',
]


def _load_2026_27_rows(heats_dir, crosswalk, season_cfg):
    """Normalize finished 2026/27 individual heats from data/competitions/*.json."""
    stations_doc = json.loads((ROOT / 'data/stations.json').read_text(encoding='utf-8'))
    station_meta = {s['id']: s for s in stations_doc['stations']}
    season = stations_doc['season']
    lane_mode = season_cfg['seasons'][season]['lane_mode']
    mappings = crosswalk['mappings']
    registry = json.loads((heats_dir / 'athletes.json').read_text())['items']
    official_ids = {oid: a['id'] for a in registry for oid in a['official_skater_ids']}

    rows = []
    events_seen = set()
    for p in sorted((ROOT / 'data/competitions').glob('*.json')):
        snap = json.loads(p.read_text(encoding='utf-8'))
        st_id = snap['event_id']
        st = station_meta[st_id]
        city = st['city_en']
        oid_event = str(st['isu']['event_id']) if st.get('isu') else None
        event_id = f'{season.replace("/", "-")}-worldtour-{st_id}'

        # Attach penalty codes from data/penalties/<station>.json if available.
        pen_path = ROOT / 'data/penalties' / f'{st_id}.json'
        if pen_path.exists():
            report = json.loads(pen_path.read_text(encoding='utf-8'))
            snap = penalty_protocol.attach_codes(snap, report, unmatched=[])

        heats = [
            h
            for h in snap.get('rounds', {}).get('items', [])
            if h.get('format') == 'individual'
            and h.get('evidence') == 'official_results'
            and (h.get('result_status') or '').lower() == 'official'
        ]
        if not heats:
            continue
        events_seen.add(event_id)

        # Compute is_repechage_qualifier per (gender, distance_m)
        rep_sf_qualifiers = {}
        for h in heats:
            styp, rnd, _ = hs.parse_round_name(h['round_label'])
            if styp == 'REPECHAGE' and rnd == 'semifinal':
                for part in h['participants']:
                    q_raw, q_type, q_target, adv = hs.normalize_qualification(part.get('qualification'), styp, rnd)
                    if adv:
                        skr = hs.live_athlete_id(part, mappings, official_ids)
                        rep_sf_qualifiers.setdefault((h['gender'], h['distance_m']), set()).add(skr)

        for h in heats:
            styp, rnd, base_tier = hs.parse_round_name(h['round_label'])
            fgrp = h.get('group')
            tier = (4 if fgrp == 'B' else 5) if rnd == 'final' else base_tier
            start_utc = hs.local_wallclock_to_utc(h.get('source_start'), city)
            local_date = h.get('local_date') or (h.get('source_start') or '')[:10]

            parts = h['participants']
            entered_size = len(parts)
            # Determine status for each participant first to compute heat_size (non-DNS).
            parsed_parts = []
            for part in parts:
                pen_obj = part.get('penalty')
                raw_res = part.get('result') or (pen_obj['code'] if pen_obj else '')
                q_raw, q_type, q_target, adv = hs.normalize_qualification(part.get('qualification'), styp, rnd)
                status, time_s, pen_str, is_inc, inc_type = hs.normalize_status(raw_res, '', q_raw)
                p_code = pen_obj.get('infringement_code') if pen_obj else None
                skr_id = hs.live_athlete_id(part, mappings, official_ids)
                parsed_parts.append(
                    (part, skr_id, q_raw, q_type, q_target, adv, status, time_s, pen_str, p_code, is_inc, inc_type)
                )

            heat_size = sum(1 for item in parsed_parts if item[6] != 'DNS')
            entry_round = 'semifinal' if h['distance_m'] == 1500 else 'quarterfinal'
            rep_set = rep_sf_qualifiers.get((h['gender'], h['distance_m']), set())

            for (
                part,
                skr_id,
                q_raw,
                q_type,
                q_target,
                adv,
                status,
                time_s,
                pen_str,
                p_code,
                is_inc,
                inc_type,
            ) in parsed_parts:
                sp = part.get('starting_position')
                rel_lane = round((sp - 1) / max(heat_size - 1, 1), 6) if (sp is not None and status != 'DNS') else None
                rows.append(
                    {
                        'season': season,
                        'event_id': event_id,
                        'official_event_id': oid_event,
                        'event_kind': 'worldtour',
                        'city': city,
                        'local_date': local_date,
                        'start_time_utc': start_utc,
                        'gender': h['gender'],
                        'distance_m': h['distance_m'],
                        'event_distance_instance': 1,
                        'session_type': styp,
                        'round': rnd,
                        'final_group': fgrp,
                        'round_tier': tier,
                        'round_key': h.get('round_key'),
                        'heat_id': h['id'],
                        'heat_number': h.get('heat_number'),
                        'heat_size': heat_size,
                        'entered_size': entered_size,
                        'lane_mode': lane_mode,
                        'athlete_id': skr_id,
                        'official_skater_id': part.get('official_skater_id'),
                        'name': part['name'],
                        'country': part['country'],
                        'helmet_number': part.get('helmet_number'),
                        'starting_position': sp,
                        'rel_lane': rel_lane,
                        'rank': part.get('rank'),
                        'result': part.get('result') or '',
                        'time_s': time_s,
                        'status': status,
                        'penalty': pen_str,
                        'penalty_code': p_code,
                        'is_incident': is_inc,
                        'incident_type': inc_type,
                        'qual_flag_raw': q_raw,
                        'qual_type': q_type,
                        'qual_target': q_target,
                        'advanced': adv,
                        'is_repechage_qualifier': bool(styp == 'MAIN' and rnd == entry_round and skr_id in rep_set),
                        'opening_split_s': None,
                        'lap_times_s': None,
                        'big_q': None,
                        'small_q_planned': None,
                    }
                )
    return rows, events_seen


def build_wide_rows(heats_dir=ROOT / 'data/heats'):
    events_doc = json.loads((heats_dir / 'events.json').read_text(encoding='utf-8'))
    crosswalk = json.loads((heats_dir / 'athlete_crosswalk.json').read_text(encoding='utf-8'))
    season_cfg = json.loads((heats_dir / 'rules/season_config.json').read_text(encoding='utf-8'))

    rows = []
    for meta in events_doc['items']:
        ev = json.loads((heats_dir / meta['file']).read_text(encoding='utf-8'))
        lane_mode = season_cfg['seasons'][ev['season']]['lane_mode']
        for h in ev['heats']:
            qrule = h.get('qualification') or {}
            for p in h['participants']:
                rows.append(
                    {
                        'season': ev['season'],
                        'event_id': ev['event_id'],
                        'official_event_id': ev['official_event_id'],
                        'event_kind': ev['kind'],
                        'city': ev['city'],
                        'local_date': h['local_date'],
                        'start_time_utc': h['start_time_utc'],
                        'gender': h['gender'],
                        'distance_m': h['distance_m'],
                        'event_distance_instance': h['event_distance_instance'],
                        'session_type': h['session_type'],
                        'round': h['round'],
                        'final_group': h['final_group'],
                        'round_tier': h['round_tier'],
                        'round_key': h['round_key'],
                        'heat_id': h['id'],
                        'heat_number': h['heat_number'],
                        'heat_size': h['heat_size'],
                        'entered_size': h['entered_size'],
                        'lane_mode': lane_mode,
                        'athlete_id': p['athlete_id'],
                        'official_skater_id': p['official_skater_id'],
                        'name': p['name'],
                        'country': p['country'],
                        'helmet_number': p['helmet_number'],
                        'starting_position': p['starting_position'],
                        'rel_lane': p['rel_lane'],
                        'rank': p['rank'],
                        'result': p['result'],
                        'time_s': p['time_s'],
                        'status': p['status'],
                        'penalty': p['penalty'],
                        'penalty_code': p['penalty_code'],
                        'is_incident': p['is_incident'],
                        'incident_type': p['incident_type'],
                        'qual_flag_raw': p['qual_flag_raw'],
                        'qual_type': p['qual_type'],
                        'qual_target': p['qual_target'],
                        'advanced': p['advanced'],
                        'is_repechage_qualifier': p['is_repechage_qualifier'],
                        'opening_split_s': p['opening_split_s'],
                        'lap_times_s': p['lap_times_s'],
                        'big_q': qrule.get('big_q'),
                        'small_q_planned': qrule.get('small_q_planned'),
                    }
                )

    live_rows, _ = _load_2026_27_rows(heats_dir, crosswalk, season_cfg)
    rows.extend(live_rows)

    session_order = {'PRELIM': 0, 'REPECHAGE': 1, 'MAIN': 2}
    rows.sort(
        key=lambda r: (
            r['start_time_utc'] or '',
            r['local_date'],
            session_order[r['session_type']],
            r['round_tier'],
            r['heat_number'] or 0,
            r['heat_id'],
            r['rank'] is None,
            r['rank'] or 999,
            r['starting_position'] is None,
            r['starting_position'] or 999,
            r['athlete_id'],
        )
    )

    # Assert strict uniqueness & chronological monotonicity.
    seen_pairs = set()
    prev_ts = ''
    for r in rows:
        pair = (r['heat_id'], r['athlete_id'])
        if pair in seen_pairs:
            raise ValueError(f'Duplicate (heat_id, athlete_id) in export: {pair}')
        seen_pairs.add(pair)
        ts = r['start_time_utc'] or ''
        if ts and prev_ts and ts < prev_ts:
            raise ValueError(f'Timestamp regression: {ts} < {prev_ts}')
        if ts:
            prev_ts = ts
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heats-dir', type=Path, default=ROOT / 'data/heats')
    parser.add_argument('--out-dir', type=Path, default=ROOT / 'build')
    args = parser.parse_args()

    rows = build_wide_rows(args.heats_dir)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = args.out_dir / 'heat_starts.jsonl'
    csv_path = args.out_dir / 'heat_starts.csv'

    with jsonl_path.open('w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    with csv_path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for r in rows:
            row_csv = dict(r)
            if row_csv['lap_times_s'] is not None:
                row_csv['lap_times_s'] = json.dumps(row_csv['lap_times_s'])
            writer.writerow(row_csv)

    events_total = len({r['event_id'] for r in rows})
    heats_total = len({r['heat_id'] for r in rows})
    starts_total = len(rows)
    status_cnt = Counter(r['status'] for r in rows)
    by_season = {}
    for r in rows:
        s = by_season.setdefault(r['season'], {'starts': 0, 'non_dns': 0, 'pen': 0, 'dnf': 0})
        s['starts'] += 1
        if r['status'] != 'DNS':
            s['non_dns'] += 1
        if r['status'] in ('PEN', 'YC', 'RC'):
            s['pen'] += 1
        elif r['status'] == 'DNF':
            s['dnf'] += 1

    print(f'Exported {events_total} events, {heats_total} heats, {starts_total} starts -> {jsonl_path} & {csv_path}')
    print('Status share:', {k: f'{v} ({v / starts_total * 100:.2f}%)' for k, v in sorted(status_cnt.items())})
    for season in sorted(by_season):
        st = by_season[season]
        print(
            f'  {season}: starts={st["starts"]}, pen_rate={st["pen"] / max(st["non_dns"], 1) * 100:.2f}%, '
            f'dnf_rate={st["dnf"] / max(st["non_dns"], 1) * 100:.2f}%'
        )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
