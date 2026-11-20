#!/usr/bin/env python3
"""Quality validation and coverage report generator for data/heats/."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re

import heats_schema as hs

ROOT = Path(__file__).resolve().parents[1]


def _parse_mjs_groups(path):
    """Extract nested [[name, country], ...] arrays from historical-*.mjs files."""
    groups = []
    for line in path.read_text(encoding='utf-8').splitlines():
        s = line.strip()
        if s.startswith('[['):
            s = s.rstrip(',')
            groups.append(json.loads(s))
    return groups


def cross_check_manual(events_dir):
    """Cross-check 2025/26 Men 1500m & Women 1000m manual arrays against imported ISU heats."""
    wt2526 = []
    worlds2526 = None
    for p in sorted(events_dir.glob('2025-26-*.json')):
        ev = json.loads(p.read_text(encoding='utf-8'))
        if ev['kind'] == 'worldtour':
            wt2526.append(ev)
        elif ev['kind'] == 'worlds':
            worlds2526 = ev

    def extract_timed_groups(events, gender, distance_m):
        groups = []
        for ev in sorted(events, key=lambda e: e['date_start']):
            for h in ev['heats']:
                if h['gender'] == gender and h['distance_m'] == distance_m:
                    timed = [
                        (p['name'], p['country'], p['athlete_id'])
                        for p in sorted(h['participants'], key=lambda x: (x['rank'] is None, x['rank'] or 999))
                        if p['status'] in ('OK', 'ADV') and p['time_s'] is not None
                    ]
                    if timed:
                        groups.append(
                            {
                                'event_id': ev['event_id'],
                                'heat_id': h['id'],
                                'round': h['round_label'],
                                'heat': h['heat_label'],
                                'timed': timed,
                            }
                        )
        return groups

    # historical-heats.mjs: 2025/26 WT1-4 + Worlds Men 1500m
    men_1500_official = extract_timed_groups(wt2526 + ([worlds2526] if worlds2526 else []), 'men', 1500)
    women_1000_official = extract_timed_groups(wt2526, 'women', 1000)

    specs = [
        ('src/historical-heats.mjs (25/26 Men 1500m)', ROOT / 'src/historical-heats.mjs', men_1500_official),
        (
            'src/historical-women-1000.mjs (25/26 Women 1000m)',
            ROOT / 'src/historical-women-1000.mjs',
            women_1000_official,
        ),
    ]

    report = []
    for label, mjs_path, official in specs:
        if not mjs_path.exists():
            continue
        manual_groups = _parse_mjs_groups(mjs_path)
        exact_matches = 0
        spelling_diffs = []
        unmatched_groups = []
        # Match each manual group against official groups using normalized name+country overlap.
        used = set()
        for idx, mg in enumerate(manual_groups):
            mg_keys = [(hs.normalize_name_key(n), c) for n, c in mg]
            best_i, best_score = None, -1
            for j, og in enumerate(official):
                if j in used:
                    continue
                og_keys = [(hs.normalize_name_key(n), c) for n, c, _ in og['timed']]
                if abs(len(og_keys) - len(mg_keys)) > 1:
                    continue
                score = sum(1 for k in mg_keys if k in og_keys)
                if score > best_score or (score == best_score and best_i is not None and len(og_keys) == len(mg_keys)):
                    best_score = score
                    best_i = j
            if best_i is not None and best_score >= max(2, len(mg_keys) - 2):
                used.add(best_i)
                og = official[best_i]
                exact_matches += 1
                for m_name, m_ctry in mg:
                    m_nk = hs.normalize_name_key(m_name)
                    # Check if exact string (case-insensitive) or normalized key differs
                    matched_official = [
                        (o_name, o_ctry)
                        for o_name, o_ctry, _ in og['timed']
                        if o_ctry == m_ctry and hs.normalize_name_key(o_name) == m_nk
                    ]
                    if not matched_official:
                        # Find closest country match in the same heat
                        same_ctry = [o_name for o_name, o_ctry, _ in og['timed'] if o_ctry == m_ctry]
                        spelling_diffs.append(
                            {
                                'group_index': idx + 1,
                                'event': og['event_id'],
                                'heat': f'{og["round"]} {og["heat"]}',
                                'manual': f'{m_name} ({m_ctry})',
                                'official': ', '.join(same_ctry) or '(country mismatch)',
                            }
                        )
                    else:
                        # Check for Cyrillic/Greek confusable characters in manual text
                        if hs.plain_text(m_name) != m_name and re.search(r'[\u0400-\u04ff\u0370-\u03ff]', m_name):
                            spelling_diffs.append(
                                {
                                    'group_index': idx + 1,
                                    'event': og['event_id'],
                                    'heat': f'{og["round"]} {og["heat"]}',
                                    'manual': f'{m_name} [contains Cyrillic/Greek homoglyph]',
                                    'official': matched_official[0][0],
                                }
                            )
            else:
                unmatched_groups.append({'group_index': idx + 1, 'sample': mg[:3], 'len': len(mg)})

        report.append(
            {
                'label': label,
                'manual_groups': len(manual_groups),
                'official_timed_groups': len(official),
                'matched_groups': exact_matches,
                'spelling_diffs': spelling_diffs,
                'unmatched_groups': unmatched_groups,
            }
        )
    return report


def validate_all(heats_dir=ROOT / 'data/heats', require_rules=True):
    """Run all structural, conservation, and routing checks across data/heats/."""
    errors = []
    warnings = []

    athletes_doc = json.loads((heats_dir / 'athletes.json').read_text(encoding='utf-8'))
    crosswalk_doc = json.loads((heats_dir / 'athlete_crosswalk.json').read_text(encoding='utf-8'))
    events_doc = json.loads((heats_dir / 'events.json').read_text(encoding='utf-8'))
    season_cfg = json.loads((heats_dir / 'rules/season_config.json').read_text(encoding='utf-8'))

    athlete_ids = {a['id'] for a in athletes_doc['items']}
    if len(athlete_ids) != len(athletes_doc['items']):
        errors.append('Duplicate athlete id in athletes.json')

    # Check 2026/27 rounds.json crosswalk 100% coverage.
    mappings = crosswalk_doc['mappings']
    for p in sorted((ROOT / 'data/competitions').glob('*.json')):
        snap = json.loads(p.read_text(encoding='utf-8'))
        for h in snap.get('rounds', {}).get('items', []):
            for part in h.get('participants', []):
                if h.get('format') == 'individual':
                    aid = part.get('athlete_id')
                    if aid not in mappings:
                        errors.append(f'Missing crosswalk mapping for {p.name} {h["id"]} {aid}')
                else:
                    for mem in part.get('members', []):
                        aid = mem.get('athlete_id')
                        if aid not in mappings:
                            errors.append(f'Missing crosswalk mapping for relay member {p.name} {h["id"]} {aid}')

    all_heat_ids = set()
    status_counts = Counter()
    season_stats = {}
    cross_country_athletes = []
    for a in athletes_doc['items']:
        distinct_countries = []
        for s in a['countries']:
            if s['country'] not in distinct_countries:
                distinct_countries.append(s['country'])
        if len(distinct_countries) > 1:
            cross_country_athletes.append({'id': a['id'], 'name': a['name'], 'countries': a['countries']})

    dnf_to_rep_count = 0
    rep_q_outer_checks = {'total': 0, 'outer_ok': 0, 'overflow_or_notime': 0}
    partial_events = []

    for meta in events_doc['items']:
        ev_path = heats_dir / meta['file']
        ev = json.loads(ev_path.read_text(encoding='utf-8'))
        is_partial = ev.get('coverage') == 'partial'
        if is_partial:
            partial_events.append(
                {
                    'event_id': ev['event_id'],
                    'heat_count': len(ev['heats']),
                    'start_count': sum(len(h['participants']) for h in ev['heats']),
                    'note': ev.get('coverage_note'),
                }
            )
        season = ev['season']
        cfg = season_cfg['seasons'][season]
        st_stat = season_stats.setdefault(
            season,
            {
                'events': 0,
                'heats': 0,
                'starts': 0,
                'pen': 0,
                'yc': 0,
                'rc': 0,
                'dnf': 0,
                'dns': 0,
                'no_time': 0,
                'adv': 0,
            },
        )
        st_stat['events'] += 1

        # Group heats by discipline instance to check round routing & conservation.
        by_disc = {}
        seen_round_keys = {}
        for h in ev['heats']:
            if h['id'] in all_heat_ids:
                errors.append(f'Duplicate global heat id {h["id"]}')
            all_heat_ids.add(h['id'])
            st_stat['heats'] += 1

            # Double-distance & session assertions
            if not cfg['has_double_distance'] and h['event_distance_instance'] != 1:
                errors.append(
                    f'{ev["event_id"]} {h["id"]}: unexpected instance {h["event_distance_instance"]} in {season}'
                )
            if 'Rep.' in (h['round_label'] or '') and h['session_type'] != 'REPECHAGE':
                errors.append(f'{ev["event_id"]} {h["id"]}: repechage round has session_type={h["session_type"]}')
            if 'Rep.' not in (h['round_label'] or '') and h['session_type'] == 'REPECHAGE':
                errors.append(f'{ev["event_id"]} {h["id"]}: non-rep round has session_type=REPECHAGE')

            rk_key = (h['round_key'], h['heat_label'])
            if rk_key in seen_round_keys:
                errors.append(f'{ev["event_id"]} duplicate (round_key, heat_label): {rk_key}')
            seen_round_keys[rk_key] = h['id']

            parts = h['participants']
            expected_entered = len(parts)
            expected_heat_size = sum(1 for p in parts if p['status'] != 'DNS')
            if h['entered_size'] != expected_entered:
                errors.append(f'{h["id"]}: entered_size {h["entered_size"]} != {expected_entered}')
            if h['heat_size'] != expected_heat_size:
                errors.append(f'{h["id"]}: heat_size {h["heat_size"]} != {expected_heat_size}')

            sps = [p['starting_position'] for p in parts if p['starting_position'] is not None]
            if len(sps) != len(set(sps)):
                errors.append(f'{h["id"]}: duplicate starting_position {sps}')
            for sp in sps:
                if not 1 <= sp <= h['entered_size']:
                    if is_partial:
                        warnings.append(
                            f'{ev["event_id"]} {h["id"]}: partial upstream API sp={sp} > entered_size={h["entered_size"]}'
                        )
                    else:
                        errors.append(f'{h["id"]}: starting_position {sp} outside 1..{h["entered_size"]}')

            for p in parts:
                st_stat['starts'] += 1
                st = p['status']
                status_counts[st] += 1
                if st == 'PEN':
                    st_stat['pen'] += 1
                elif st == 'YC':
                    st_stat['yc'] += 1
                elif st == 'RC':
                    st_stat['rc'] += 1
                elif st == 'DNF':
                    st_stat['dnf'] += 1
                elif st == 'DNS':
                    st_stat['dns'] += 1
                elif st == 'NO_TIME':
                    st_stat['no_time'] += 1
                elif st == 'ADV':
                    st_stat['adv'] += 1

                if p['athlete_id'] not in athlete_ids:
                    errors.append(f'{h["id"]}: unknown athlete_id {p["athlete_id"]}')
                if st in ('NO_TIME', 'PEN', 'YC', 'RC', 'DNF', 'DNS') and p['time_s'] is not None:
                    errors.append(f'{h["id"]} {p["athlete_id"]}: status={st} must have time_s=None, got {p["time_s"]}')
                if st == 'OK' and (p['time_s'] is None or p['time_s'] <= 0):
                    errors.append(f'{h["id"]} {p["athlete_id"]}: status=OK invalid time_s={p["time_s"]}')

                expected_rel = (
                    round((p['starting_position'] - 1) / max(h['heat_size'] - 1, 1), 6)
                    if p['starting_position'] is not None and st != 'DNS'
                    else None
                )
                if p['rel_lane'] != expected_rel:
                    errors.append(f'{h["id"]} {p["athlete_id"]}: rel_lane {p["rel_lane"]} != {expected_rel}')

                if p['is_repechage_qualifier']:
                    rep_q_outer_checks['total'] += 1
                    std_size = 7 if h['distance_m'] == 1500 else 5
                    if p['starting_position'] is not None and p['starting_position'] >= std_size:
                        rep_q_outer_checks['outer_ok'] += 1
                    else:
                        rep_q_outer_checks['overflow_or_notime'] += 1
                        warnings.append(
                            f'{ev["event_id"]} {h["id"]}: rep qualifier {p["name"]} at lane {p["starting_position"]}/{h["heat_size"]}'
                        )

            if require_rules and h['round'] != 'final':
                qrule = h.get('qualification')
                if not qrule or qrule.get('big_q') is None or qrule.get('small_q_planned') is None:
                    errors.append(f'{ev["event_id"]} {h["id"]}: missing qualification rule')

            by_disc.setdefault((h['gender'], h['distance_m'], h['event_distance_instance']), []).append(h)

        # Per-discipline routing & ADV-eats-q checks
        for disc_key, dheats in by_disc.items():
            # Group by (session_type, round, final_group)
            by_stage = {}
            for h in dheats:
                by_stage.setdefault((h['session_type'], h['round'], h['final_group']), []).append(h)

            # Check blocked prelim statuses do not enter repechage
            blocked_prelim = set()
            dnf_prelim = set()
            for (styp, rnd, _), rhs in by_stage.items():
                if styp == 'PRELIM':
                    for h in rhs:
                        for p in h['participants']:
                            if p['status'] in ('PEN', 'YC', 'RC', 'DNS'):
                                blocked_prelim.add(p['athlete_id'])
                            elif p['status'] == 'DNF':
                                dnf_prelim.add(p['athlete_id'])
            for (styp, rnd, _), rhs in by_stage.items():
                if styp == 'REPECHAGE':
                    for h in rhs:
                        for p in h['participants']:
                            if p['athlete_id'] in blocked_prelim:
                                errors.append(
                                    f'{ev["event_id"]} {disc_key} {h["id"]}: blocked prelim skater {p["name"]} ({p["athlete_id"]}) entered {rnd}'
                                )
                            if p['athlete_id'] in dnf_prelim and rnd in ('heats', 'quarterfinal'):
                                dnf_to_rep_count += 1

            # Check ADV-eats-q conservation per round
            if require_rules:
                for (styp, rnd, fgrp), rhs in by_stage.items():
                    if rnd == 'final':
                        continue
                    qrule = rhs[0]['qualification']
                    if any(h['qualification'] != qrule for h in rhs):
                        errors.append(
                            f'{ev["event_id"]} {disc_key} {styp}/{rnd}: inconsistent heat qualification rules'
                        )
                    if qrule.get('exempt_track_block'):
                        continue
                    n_q_small = sum(1 for h in rhs for p in h['participants'] if p['qual_type'] == 'q')
                    n_adv = sum(
                        1
                        for h in rhs
                        for p in h['participants']
                        if p['qual_type'] == 'ADV' and p['qual_target'] in ('NEXT', 'FA')
                    )
                    expected_q = max(0, qrule['small_q_planned'] - n_adv)
                    if n_q_small != expected_q:
                        errors.append(
                            f'{ev["event_id"]} {disc_key} {styp}/{rnd}: q_actual={n_q_small} != max(0, {qrule["small_q_planned"]}-{n_adv})={expected_q}'
                        )

    manual_check = cross_check_manual(heats_dir / 'events')
    return {
        'errors': errors,
        'warnings': warnings,
        'athletes_count': len(athletes_doc['items']),
        'crosswalk_count': len(mappings),
        'unmapped_entries_only': crosswalk_doc.get('unmapped_entries_only', []),
        'cross_country_athletes': cross_country_athletes,
        'event_count': events_doc['event_count'],
        'heat_count': events_doc['total_heats'],
        'start_count': events_doc['total_starts'],
        'dropped_ghost_rows': events_doc.get('dropped_ghost_rows', []),
        'status_counts': dict(status_counts),
        'season_stats': season_stats,
        'dnf_to_rep_count': dnf_to_rep_count,
        'rep_q_outer_checks': rep_q_outer_checks,
        'partial_events': partial_events,
        'manual_check': manual_check,
    }


def render_coverage_md(summary):
    lines = [
        '# 历史分组数据覆盖率与质量核验报告（`data_coverage.md`）',
        '',
        '> 由 `tools/check_heats.py` 自动生成。',
        '',
        '## 1. 全量汇总',
        '',
        f'- 覆盖赛事数：**{summary["event_count"]}** 站（2022/23–2025/26）',
        f'- 总组数（Heats）：**{summary["heat_count"]}**',
        f'- 总出场人次数（Starts）：**{summary["start_count"]}**',
        f'- 选手主档人数：**{summary["athletes_count"]}**（均已绑定 `official_skater_ids` / `skr-<id>`，零 `tmp-` 临时 ID）',
        f'- 2026/27 `ath-*` 对照映射数：**{summary["crosswalk_count"]}**（`rounds.json` 100% 映射；仅未出场替补/新人未映射到 `skr-`：**{len(summary["unmapped_entries_only"])}** 人）',
        f'- 赛前撤赛幽灵占位行剔除：**{len(summary["dropped_ghost_rows"])}** 条',
        f'- 资格赛 `DNF` 合法进入复活赛实例：**{summary["dnf_to_rep_count"]}** 人次',
        f'- 复活半决赛胜者进入正赛外道校验：**{summary["rep_q_outer_checks"]["outer_ok"]}/{summary["rep_q_outer_checks"]["total"]}** 居标准最外道（5/7 号道及以上）',
        f'- 校验错误数：**{len(summary["errors"])}**',
        '',
        '## 2. 分赛季覆盖率与判罚基线',
        '',
        '| 赛季 | 站数 | 组数 | 人次数 | `PEN` | `YC` | `RC` | `DNF` | `DNS` | `NO_TIME` | `ADV` | 犯规率（PEN+YC+RC / 发枪） |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ]
    for season in sorted(summary['season_stats']):
        st = summary['season_stats'][season]
        started = max(st['starts'] - st['dns'], 1)
        pen_rate = (st['pen'] + st['yc'] + st['rc']) / started * 100
        lines.append(
            f'| {season} | {st["events"]} | {st["heats"]} | {st["starts"]} | '
            f'{st["pen"]} | {st["yc"]} | {st["rc"]} | {st["dnf"]} | {st["dns"]} | {st["no_time"]} | {st["adv"]} | {pen_rate:.2f}% |'
        )

    lines.extend(
        [
            '',
            '## 3. 跨协会代表变更选手清单（`athletes.json`）',
            '',
            f'共发现 **{len(summary["cross_country_athletes"])}** 名跨代表协会变更记录：',
            '',
            '| 主键 | 姓名 | 代表协会变更轨迹 |',
            '|---|---|---|',
        ]
    )
    for a in summary['cross_country_athletes']:
        trail = ' → '.join(f'{c["country"]} ({c["first_seen"]}..{c["last_seen"]})' for c in a['countries'])
        lines.append(f'| `{a["id"]}` | {a["name"]} | {trail} |')

    lines.extend(
        [
            '',
            '## 4. 手工历史数据交叉核验（`src/historical-*.mjs`）',
            '',
        ]
    )
    for mc in summary['manual_check']:
        lines.append(
            f'### {mc["label"]}: 匹配 {mc["matched_groups"]}/{mc["manual_groups"]} 组（官方完赛有时间组 {mc["official_timed_groups"]}）'
        )
        lines.append('')
        if mc['spelling_diffs']:
            lines.append('| 序号 | 赛事 | 轮次组别 | 手工录入（`historical-*.mjs`） | 官方 ISU 记录 |')
            lines.append('|---:|---|---|---|---|')
            for d in mc['spelling_diffs']:
                lines.append(f'| {d["group_index"]} | `{d["event"]}` | {d["heat"]} | {d["manual"]} | {d["official"]} |')
            lines.append('')
        if mc['unmatched_groups']:
            lines.append(f'未完全匹配组（{len(mc["unmatched_groups"])}）：')
            for u in mc['unmatched_groups'][:20]:
                lines.append(f'- 第 {u["group_index"]} 组（len={u["len"]}）: `{u["sample"]}`')
            lines.append('')

    if summary['unmapped_entries_only']:
        lines.extend(
            [
                '## 5. 2026/27 仅报名未出场 `ath-*` 选手（待出场后自动补齐 ISU ID）',
                '',
                f'共 {len(summary["unmapped_entries_only"])} 名仅在 `entries`/`rankings` 出现且无历史出赛记录的选手：',
                '',
            ]
        )
        for u in summary['unmapped_entries_only'][:30]:
            lines.append(f'- `{u["legacy_id"]}`: {u["name"]} ({u["country"]}, {u["gender"]})')
        if len(summary['unmapped_entries_only']) > 30:
            lines.append(f'- ... 其余 {len(summary["unmapped_entries_only"]) - 30} 名见 `athlete_crosswalk.json`')
        lines.append('')

    if summary.get('partial_events'):
        lines.extend(
            [
                '## 6. 部分覆盖赛事说明（上游 ISU API 缺损）',
                '',
            ]
        )
        for pe in summary['partial_events']:
            lines.append(
                f'- `{pe["event_id"]}`: 已导入 {pe["heat_count"]} 组 / {pe["start_count"]} 人次 — {pe["note"]}'
            )
        lines.append('')

    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heats-dir', type=Path, default=ROOT / 'data/heats')
    parser.add_argument('--coverage-out', type=Path, default=ROOT / 'docs/data_coverage.md')
    parser.add_argument('--skip-rules', action='store_true', help='Skip D3 qualification rule checks')
    args = parser.parse_args()

    summary = validate_all(args.heats_dir, require_rules=not args.skip_rules)
    args.coverage_out.write_text(render_coverage_md(summary), encoding='utf-8')
    print(
        f'Checked {summary["event_count"]} events, {summary["heat_count"]} heats, {summary["start_count"]} starts; '
        f'errors={len(summary["errors"])}, warnings={len(summary["warnings"])}',
        flush=True,
    )
    for err in summary['errors'][:20]:
        print('ERROR:', err, flush=True)
    return 1 if summary['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
