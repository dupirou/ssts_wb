#!/usr/bin/env python3
"""Deterministic 2026-27 ISU Short Track quota, points, ranking & penalty engine.

Pure rule layer backed by config/quota_rules_2026_27.yaml (zero ML).
Covers:
  - Age eligibility & dual-eligibility (CER 2026 Art. 9.2 & Comm. 2807)
  - World Tour 1x / Team Globe 3x / World Ranking 1x / 2027 Worlds 2x points & tie-breakers
  - 2027 World Championships individual quotas (Rule 281.3.a, Comm. 2805 II.3(i))
  - 2027 World Championships relay quotas & 3-step tie-breaker (Rule 281.3.b, Comm. 2805 II.3(ii))
  - 2027 World Championships category max roster cap (Comm. 2805 II.3(iii))
  - 2026-27 World Tour per-stop quotas, 4-skater Top-40 exception, & cumulative penalty bans
  - Official 2026 Worlds C74A back-calculation verifier against Comm. 2805 PDF
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PYLIB = ROOT / '.cache/pylib'
if PYLIB.exists() and str(PYLIB) not in sys.path:
    sys.path.insert(0, str(PYLIB))

import yaml

DEFAULT_CONFIG_PATH = ROOT / 'config/quota_rules_2026_27.yaml'
DISTANCES = (500, 1000, 1500)
DIST_KEYS = ('500m', '1000m', '1500m')

# Official ISU Member full name (as printed in Comm. 2805) -> 3-letter ISU Member code.
MEMBER_NAME_TO_CODE = {
    'Australia': 'AUS',
    'Austria': 'AUT',
    'Belgium': 'BEL',
    'Brazil': 'BRA',
    'Bulgaria': 'BUL',
    'Canada': 'CAN',
    'China': 'CHN',
    "People's Republic of China": 'CHN',
    'Croatia': 'CRO',
    'Czechia': 'CZE',
    'France': 'FRA',
    'Germany': 'GER',
    'Great Britain': 'GBR',
    'Hong Kong/China': 'HKG',
    'Hong Kong, China': 'HKG',
    'Hungary': 'HUN',
    'Ireland': 'IRL',
    'Italy': 'ITA',
    'Japan': 'JPN',
    'Kazakhstan': 'KAZ',
    'Korea': 'KOR',
    'Republic of Korea': 'KOR',
    'Latvia': 'LAT',
    'Lithuania': 'LTU',
    'Netherlands': 'NED',
    'Norway': 'NOR',
    'Philippines': 'PHI',
    'Poland': 'POL',
    'Serbia': 'SRB',
    'Slovakia': 'SVK',
    'Switzerland': 'SUI',
    'Türkiye': 'TUR',
    'Turkiye': 'TUR',
    'Turkey': 'TUR',
    'Ukraine': 'UKR',
    'USA': 'USA',
    'United States of America': 'USA',
    'Uzbekistan': 'UZB',
}


def load_rules_config(path: Path = DEFAULT_CONFIG_PATH) -> dict:
    with Path(path).open('r', encoding='utf-8') as fh:
        return yaml.safe_load(fh)


def _norm_dist_key(distance: int | str) -> str:
    s = str(distance).strip().lower()
    return s if s.endswith('m') else f'{s}m'


# ------------------------------------------------------------------------------
# 1. Age Eligibility & Dual-Eligibility (CER 2026 Art. 9.2 & Comm. 2807)
# ------------------------------------------------------------------------------


def classify_age_group(birth_date: str | None, cfg: dict | None = None) -> str:
    """Return SENIOR_ONLY / DUAL_ELIGIBLE / JUNIOR_ONLY / INELIGIBLE_TOO_YOUNG / UNKNOWN."""
    if not birth_date or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(birth_date).strip()):
        return 'UNKNOWN'
    dob = str(birth_date).strip()
    cfg = cfg or load_rules_config()
    age_cfg = cfg['age_eligibility']
    senior_only_max = age_cfg['senior_only']['dob_max']
    dual_min = age_cfg['dual_eligible']['dob_min']
    dual_max = age_cfg['dual_eligible']['dob_max']
    junior_max = age_cfg['junior_isu_events']['dob_max']

    if dob <= senior_only_max:
        return 'SENIOR_ONLY'
    if dual_min <= dob <= dual_max:
        return 'DUAL_ELIGIBLE'
    if dual_max < dob <= junior_max:
        return 'JUNIOR_ONLY'
    return 'INELIGIBLE_TOO_YOUNG'


def is_senior_eligible(birth_date: str | None, cfg: dict | None = None, *, allow_unknown: bool = False) -> bool:
    group = classify_age_group(birth_date, cfg)
    if group in ('SENIOR_ONLY', 'DUAL_ELIGIBLE'):
        return True
    return allow_unknown and group == 'UNKNOWN'


def check_jwc_prize_forfeit(participated_events: list[str], cfg: dict | None = None) -> dict:
    """Comm. 2807 Sec. 11: skating WT #1-#5 forfeits JWC prize money but NOT points or eligibility."""
    cfg = cfg or load_rules_config()
    trig_cfg = cfg['age_eligibility']['dual_eligible']['jwc_prize_money_forfeit_trigger']
    red_zone = set(trig_cfg['trigger_events'])
    triggered = sorted(e for e in participated_events if e in red_zone)
    return {
        'forfeits_jwc_prize_money': bool(triggered) and bool(trig_cfg['forfeits_jwc_prize_money']),
        'forfeits_points_or_eligibility': False,
        'triggered_events': triggered,
    }


# ------------------------------------------------------------------------------
# 2. Points & Standings Scoring (Comm. 2806 & Comm. 2807)
# ------------------------------------------------------------------------------


def points_for_rank(rank: int | None, table_name: str, cfg: dict | None = None) -> int:
    if rank is None or rank <= 0:
        return 0
    cfg = cfg or load_rules_config()
    tbl = cfg['points_tables'][table_name]
    if isinstance(tbl, list):
        return int(tbl[rank - 1]) if rank <= len(tbl) else 0
    values = tbl['values']
    if rank <= len(values):
        return int(values[rank - 1])
    return int(tbl.get('rank_68_plus', 0))


def score_world_tour_classification(
    stop_results: list[dict],
    cfg: dict | None = None,
    *,
    best_m: int = 5,
    table_name: str = 'world_tour_standard_1x',
    break_tie_by_recent: bool = True,
) -> dict:
    """Compute Best-M-of-N World Tour points & deterministic tie-breaker tuple.

    Each item in `stop_results` should contain:
      - stop_index (int, 1..7)
      - rank (int | None)
      - in_main_session (bool, optional; default True — set False for individual non-main-session)
    """
    cfg = cfg or load_rules_config()
    scored = []
    for row in stop_results:
        rank = row.get('rank')
        eligible = row.get('in_main_session', True)
        pts = points_for_rank(rank, table_name, cfg) if eligible else 0
        scored.append(
            {
                'stop_index': int(row.get('stop_index', 0)),
                'rank': rank if eligible else None,
                'points': pts,
                'best_time_s': row.get('best_time_s'),
            }
        )
    # Sort descending by points, then better rank, then more recent stop for deterministic selection
    ranked = sorted(
        scored,
        key=lambda x: (x['points'], -(x['rank'] or 999), x['stop_index']),
        reverse=True,
    )
    counting = ranked[:best_m] if best_m > 0 else ranked
    total_pts = sum(x['points'] for x in counting)
    c1 = sum(1 for x in counting if x['rank'] == 1)
    c2 = sum(1 for x in counting if x['rank'] == 2)
    c3 = sum(1 for x in counting if x['rank'] == 3)
    most_recent_pts = 0
    most_recent_neg_rank = -999
    if scored:
        latest = max(scored, key=lambda x: x['stop_index'])
        most_recent_pts = latest['points']
        most_recent_neg_rank = -(latest['rank'] or 999)

    tie_key = (
        (total_pts, c1, c2, c3, most_recent_pts, most_recent_neg_rank)
        if break_tie_by_recent
        else (total_pts, c1, c2, c3)
    )
    return {
        'total_points': total_pts,
        'counting_results': counting,
        'count_1st': c1,
        'count_2nd': c2,
        'count_3rd': c3,
        'tie_key': tie_key,
    }


def score_crystal_globe(all_distance_results: list[dict], cfg: dict | None = None) -> dict:
    """Comm. 2806 Sec. 11: Best 15 individual results across all 3 distances; joint winners allowed."""
    cfg = cfg or load_rules_config()
    max_res = cfg['world_tour']['classifications']['overall_crystal_globe']['counting_results'][
        'max_individual_results'
    ]
    return score_world_tour_classification(
        all_distance_results,
        cfg,
        best_m=max_res,
        table_name='world_tour_standard_1x',
        break_tie_by_recent=False,
    )


def score_team_crystal_globe(
    individual_results: list[dict],
    relay_results: list[dict],
    cfg: dict | None = None,
) -> dict:
    """Comm. 2806 Sec. 12: All 7 stops count; individual 1x + all 3 relays 3x; joint winners allowed."""
    cfg = cfg or load_rules_config()
    ind_pts = sum(
        points_for_rank(r.get('rank'), 'world_tour_standard_1x', cfg)
        for r in individual_results
        if r.get('in_main_session', True)
    )
    rel_pts = sum(points_for_rank(r.get('rank'), 'world_tour_team_globe_relay_3x', cfg) for r in relay_results)
    combined = [r for r in individual_results if r.get('in_main_session', True)] + list(relay_results)
    c1 = sum(1 for r in combined if r.get('rank') == 1)
    c2 = sum(1 for r in combined if r.get('rank') == 2)
    c3 = sum(1 for r in combined if r.get('rank') == 3)
    total = ind_pts + rel_pts
    return {
        'individual_points': ind_pts,
        'relay_points_3x': rel_pts,
        'total_points': total,
        'count_1st': c1,
        'count_2nd': c2,
        'count_3rd': c3,
        'tie_key': (total, c1, c2, c3),
    }


# ------------------------------------------------------------------------------
# 3. 2027 World Championships Quota Rules (Comm. 2805 & Rule 281.3)
# ------------------------------------------------------------------------------


def compute_wc_2027_max_roster(
    slots_by_dist: dict[str, int],
    has_gender_relay: bool,
    has_mixed_relay: bool,
    cfg: dict | None = None,
) -> int:
    """Exact piecewise category roster cap (Comm. 2805 Sec. II.3(iii))."""
    cfg = cfg or load_rules_config()
    cap_cfg = cfg['world_championships_2027']['category_max_roster_cap_rules']
    vals = [int(slots_by_dist.get(k, 1)) for k in DIST_KEYS]
    if has_gender_relay:
        return int(cap_cfg['if_gender_relay_entered'])
    if any(v >= 3 for v in vals):
        return int(cap_cfg['else_if_any_distance_has_3_spots'])
    two_count = sum(1 for v in vals if v >= 2)
    if has_mixed_relay or two_count >= 2:
        return int(cap_cfg['else_if_mixed_relay_qualified_or_at_least_two_distances_have_2_spots'])
    if two_count == 1:
        return int(cap_cfg['else_if_exactly_one_distance_has_2_spots'])
    return int(cap_cfg['else_default'])


def compute_wc_2027_individual_quotas(
    prev_wc_classifications: dict[tuple[str, str], list[dict]],
    cfg: dict | None = None,
    *,
    apply_host_upgrade: bool = True,
) -> dict[str, dict[str, dict]]:
    """Compute 2027 WC individual quotas per (gender, country) from 2026 WC distance classifications.

    prev_wc_classifications maps (gender, '500m'|'1000m'|'1500m') -> list of {'country': 'CHN', 'rank': int}.
    Returns {gender: {country: {'slots_500m': int, 'slots_1000m': int, 'slots_1500m': int,
                                'earned_500m': int, ..., 'host_upgraded_distances': [...]}}}.
    """
    cfg = cfg or load_rules_config()
    wc_cfg = cfg['world_championships_2027']
    ind_cfg = wc_cfg['individual_quota_calculation']
    base = int(ind_cfg['base_quota_per_distance'])
    r2_min = int(ind_cfg['two_spots_rule']['min_skaters'])
    r2_max_rank = int(ind_cfg['two_spots_rule']['max_rank'])
    r3_min = int(ind_cfg['three_spots_rule']['min_skaters'])
    r3_max_rank = int(ind_cfg['three_spots_rule']['max_rank'])
    host = wc_cfg['host_member']
    host_can_upgrade = bool(ind_cfg['host_exception']['can_upgrade_to_3_per_distance'])
    special_members = set(ind_cfg.get('special_members_comm_2804', []))

    result: dict[str, dict[str, dict]] = {'women': {}, 'men': {}}
    for gender in ('women', 'men'):
        countries: set[str] = {host}
        for dk in DIST_KEYS:
            for row in prev_wc_classifications.get((gender, dk), []):
                c = row.get('country')
                if c and c not in special_members:
                    countries.add(c)

        for country in sorted(countries):
            entry = {
                'country': country,
                'gender': gender,
                'host_upgraded_distances': [],
            }
            for dk in DIST_KEYS:
                rows = [
                    r
                    for r in prev_wc_classifications.get((gender, dk), [])
                    if r.get('country') == country and isinstance(r.get('rank'), int) and r['rank'] > 0
                ]
                n_top16 = sum(1 for r in rows if r['rank'] <= r3_max_rank)
                n_top32 = sum(1 for r in rows if r['rank'] <= r2_max_rank)
                if n_top16 >= r3_min:
                    earned = 3
                elif n_top32 >= r2_min:
                    earned = 2
                else:
                    earned = base
                slots = earned
                if apply_host_upgrade and host_can_upgrade and country == host and earned < 3:
                    slots = 3
                    entry['host_upgraded_distances'].append(dk)
                entry[f'earned_{dk}'] = earned
                entry[f'slots_{dk}'] = slots
            result[gender][country] = entry
    return result


def compute_wc_2027_relay_quotas(
    wt_relay_standings: dict[str, list[dict]],
    cfg: dict | None = None,
) -> dict[str, dict]:
    """Compute 2027 WC Top-12 relay qualifiers per relay discipline with Comm. 2805 II.3(ii) tie-breaker.

    wt_relay_standings maps 'women_3000m' | 'men_5000m' | 'mixed_2000m' -> list of team entries:
      - country: str
      - either 'stop_results': [{'stop_index', 'rank', 'best_time_s'?}, ...]
        OR pre-aggregated 'points': int, 'rank': int (when pulled directly from ISU standings API)
    """
    cfg = cfg or load_rules_config()
    wc_cfg = cfg['world_championships_2027']
    rel_cfg = wc_cfg['relay_quota_calculation']
    top_n = int(rel_cfg['top_n_qualified'])
    host = wc_cfg['host_member']
    best_m = int(cfg['world_tour']['classifications']['relay_distance']['counting_results']['best_m'])

    out = {}
    for disc_key, teams in wt_relay_standings.items():
        evaluated = []
        for team in teams:
            country = team['country']
            if 'stop_results' in team:
                scored = score_world_tour_classification(
                    team['stop_results'],
                    cfg,
                    best_m=best_m,
                    table_name='world_tour_standard_1x',
                    break_tie_by_recent=False,
                )
                counting = scored['counting_results']
                pts = scored['total_points']
                # Comm. 2805 II.3(ii) tie-breaker: highest single-event rank, 2nd highest, ..., best skated time
                sorted_ranks = sorted(r['rank'] for r in counting if isinstance(r.get('rank'), int))
                padded_ranks = tuple(sorted_ranks + [999] * max(0, best_m - len(sorted_ranks)))
                times = [r['best_time_s'] for r in counting if isinstance(r.get('best_time_s'), (int, float))]
                best_time = min(times) if times else 99999.0
                # Sort key: higher points first, then LOWER (better) ranks tuple, then LOWER best time
                sort_key = (-pts, padded_ranks, best_time, country)
                evaluated.append(
                    {
                        'country': country,
                        'points': pts,
                        'counting_ranks': sorted_ranks,
                        'best_time_s': min(times) if times else None,
                        '_sort_key': sort_key,
                    }
                )
            else:
                pts = int(team.get('points', 0))
                api_rank = int(team.get('rank', 999))
                evaluated.append(
                    {
                        'country': country,
                        'points': pts,
                        'official_rank': api_rank,
                        '_sort_key': (-pts, (api_rank,), 99999.0, country),
                    }
                )

        evaluated.sort(key=lambda x: x['_sort_key'])
        qualified = []
        host_replaced = False
        for idx, row in enumerate(evaluated, 1):
            clean = {k: v for k, v in row.items() if k != '_sort_key'}
            clean['standing_rank'] = idx
            if idx <= top_n:
                clean['qualified'] = True
                qualified.append(clean)
            else:
                clean['qualified'] = False

        qualified_countries = [q['country'] for q in qualified]
        if host not in qualified_countries and len(qualified) >= top_n:
            replaced = qualified[-1]
            replaced['qualified'] = False
            replaced['replaced_by_host'] = True
            host_row = next((r for r in evaluated if r['country'] == host), None)
            host_entry = {
                'country': host,
                'points': host_row['points'] if host_row else 0,
                'standing_rank': next((i for i, r in enumerate(evaluated, 1) if r['country'] == host), None),
                'qualified': True,
                'qualified_as_host': True,
            }
            qualified = qualified[:-1] + [host_entry]
            host_replaced = True

        standings_clean = []
        qual_set = {q['country'] for q in qualified}
        for idx, row in enumerate(evaluated, 1):
            clean = {k: v for k, v in row.items() if k != '_sort_key'}
            clean['standing_rank'] = idx
            clean['qualified'] = clean['country'] in qual_set
            standings_clean.append(clean)

        out[disc_key] = {
            'top_n': top_n,
            'host_member': host,
            'host_replaced_12th': host_replaced,
            'qualified_countries': [q['country'] for q in qualified],
            'standings': standings_clean,
        }
    return out


# ------------------------------------------------------------------------------
# 4. 2026-27 World Tour Entry Quotas & Cumulative Penalty Bans (Comm. 2806)
# ------------------------------------------------------------------------------


def _blocked_count_for_penalties(total_penalties: int, thresholds: list[dict]) -> int:
    blocked = 0
    for item in sorted(thresholds, key=lambda x: int(x['sanctions'])):
        if total_penalties >= int(item['sanctions']):
            blocked = int(item['blocked_individual_distances_count'])
    return blocked


def compute_wt_2026_27_quotas(
    world_ranking_by_dist: dict[tuple[str, str], list[dict]],
    cumulative_penalties: list[dict] | None = None,
    cfg: dict | None = None,
    *,
    enable_penalty_bans: bool | None = None,
    countries_filter: set[str] | None = None,
) -> dict:
    """Compute 2026-27 World Tour per-stop quotas (incl. 4-skater Top-40 exception & penalty bans).

    world_ranking_by_dist maps (gender, '500m'|'1000m'|'1500m') ->
        list of {'athlete_id': str, 'country': str, 'rank': int, 'points': int, 'name'?: str}.
    cumulative_penalties is a list of C98P official rows:
        {'athlete_id': str, 'country': str, 'gender': str, 'name': str, 'total': int}.
    """
    cfg = cfg or load_rules_config()
    wt_entries = cfg['world_tour']['entries']
    max_total = int(wt_entries['max_skaters_per_gender_total'])
    default_dist = int(wt_entries['max_skaters_per_distance_default'])
    exc = wt_entries['four_skater_exception']
    exc_enabled = bool(exc['enabled'])
    exc_max = int(exc['max_skaters_per_distance'])
    req_top_rank = int(exc['required_top_rank'])
    req_count = int(exc['required_skater_count'])

    pen_cfg = cfg['world_tour']['cumulative_penalty_system']
    pen_enabled = bool(pen_cfg['enabled']) if enable_penalty_bans is None else bool(enable_penalty_bans)
    thresholds = pen_cfg['thresholds']

    quotas: dict[str, dict[str, dict]] = {'women': {}, 'men': {}}
    athlete_ranks: dict[str, dict[str, int]] = {}
    athlete_ranks_by_name: dict[tuple[str, str], dict[str, int]] = {}

    def _name_key(name: str | None) -> str:
        tokens = sorted(re.findall(r'[a-z]+', (name or '').lower()))
        return ' '.join(tokens)

    crosswalk_path = ROOT / 'data/heats/athlete_crosswalk.json'
    ath_to_skr: dict[str, str] = {}
    if crosswalk_path.exists():
        cw = json.loads(crosswalk_path.read_text(encoding='utf-8')).get('mappings', {})
        for k, v in cw.items():
            if isinstance(v, dict) and v.get('athlete_id'):
                ath_to_skr[k] = v['athlete_id']

    for gender in ('women', 'men'):
        countries: set[str] = set()
        for dk in DIST_KEYS:
            for row in world_ranking_by_dist.get((gender, dk), []):
                c = row.get('country')
                if c:
                    countries.add(c)
                aid = row.get('athlete_id')
                if aid and isinstance(row.get('rank'), int):
                    athlete_ranks.setdefault(aid, {})[dk] = row['rank']
                if c and row.get('name') and isinstance(row.get('rank'), int):
                    athlete_ranks_by_name.setdefault((c, _name_key(row['name'])), {})[dk] = row['rank']
        if countries_filter:
            countries = (countries & countries_filter) | countries_filter

        for country in sorted(countries):
            entry = {
                'country': country,
                'gender': gender,
                'max_roster_size': max_total,
                'four_skater_distances': [],
                'top40_counts': {},
            }
            for dk in DIST_KEYS:
                rows = world_ranking_by_dist.get((gender, dk), [])
                top40 = [
                    r
                    for r in rows
                    if r.get('country') == country and isinstance(r.get('rank'), int) and r['rank'] <= req_top_rank
                ]
                entry['top40_counts'][dk] = len(top40)
                if exc_enabled and len(top40) >= req_count:
                    entry[f'slots_{dk}'] = exc_max
                    entry['four_skater_distances'].append(dk)
                else:
                    entry[f'slots_{dk}'] = default_dist
            quotas[gender][country] = entry

    penalty_bans = []
    penalty_warnings = []
    for row in cumulative_penalties or []:
        total = int(row.get('total', 0))
        aid = row.get('athlete_id')
        skr_id = ath_to_skr.get(aid, aid)
        ranks = (
            athlete_ranks.get(aid)
            or athlete_ranks.get(skr_id)
            or athlete_ranks_by_name.get((row.get('country') or '', _name_key(row.get('name'))))
            or {}
        )
        # Rank distances by best (lowest) World Ranking rank; fallback deterministic order 500/1000/1500
        ordered_dists = sorted(DIST_KEYS, key=lambda dk: (ranks.get(dk, 9999), DIST_KEYS.index(dk)))
        blocked_n = _blocked_count_for_penalties(total, thresholds) if pen_enabled else 0
        blocked_dists = ordered_dists[:blocked_n]
        rec = {
            'athlete_id': aid,
            'name': row.get('name'),
            'country': row.get('country'),
            'gender': row.get('gender'),
            'cumulative_penalties': total,
            'blocked_count': blocked_n,
            'blocked_distances': blocked_dists,
            'world_ranks': ranks,
        }
        if blocked_n > 0:
            penalty_bans.append(rec)
        elif total == 2:
            penalty_warnings.append(rec)

    return {
        'penalty_bans_enabled': pen_enabled,
        'quotas': quotas,
        'next_stop_penalty_bans': penalty_bans,
        'one_away_from_ban_warnings': penalty_warnings,
    }


# ------------------------------------------------------------------------------
# 5. Official PDF Extraction & Comm. 2805 Verification (Phase 1 Acceptance)
# ------------------------------------------------------------------------------


def extract_2026_worlds_c74a_from_pdf(pdf_path: Path) -> dict[tuple[str, str], list[dict]]:
    """Extract all 6 individual Event Classification (C74A) tables from 2026 Montreal Worlds Protocol PDF."""
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    tables: dict[tuple[str, str], list[dict]] = {}
    code_re = re.compile(r'STK([WM])(500|1000|1500)M-+_C74A')
    row_re = re.compile(
        r'^\s*(?:Final [AB]|Semifinals|Quarterfinals|Heats|Preliminaries|Rep\.?\s*\w+)?\s*(\d+)\s+(\d+)\s+(.+?)\s+([A-Z]{3}|AIN\d?)\s+'
    )

    for page in reader.pages:
        plain = page.extract_text() or ''
        m = code_re.search(plain)
        if not m:
            continue
        gender = 'women' if m.group(1) == 'W' else 'men'
        dk = f'{m.group(2)}m'
        key = (gender, dk)
        rows = tables.setdefault(key, [])
        seen_ranks = {(r['rank'], r['helmet'], r['country']) for r in rows}
        layout = page.extract_text(extraction_mode='layout') or ''
        for line in layout.splitlines():
            rm = row_re.match(line)
            if not rm:
                continue
            rank = int(rm.group(1))
            helmet = int(rm.group(2))
            name = ' '.join(rm.group(3).split())
            country = rm.group(4)
            sig = (rank, helmet, country)
            if sig in seen_ranks:
                continue
            seen_ranks.add(sig)
            rows.append({'rank': rank, 'helmet': helmet, 'name': name, 'country': country})
    return tables


def extract_comm_2805_wc_quotas_from_pdf(pdf_path: Path) -> dict[str, dict[str, dict[str, int]]]:
    """Extract exact (x,y)-aligned 2027 World Championships quota table from Comm. 2805 Page 5."""
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    page = reader.pages[4]  # Page 5 (1-indexed)
    items: list[tuple[float, float, str]] = []

    def visitor(text, cm, tm, font_dict, font_size):
        t = text.strip()
        if t:
            items.append((round(tm[5], 1), round(tm[4], 1), t))

    page.extract_text(visitor_text=visitor)

    # Split Women (y > 425) vs Men (125 < y < 410)
    out: dict[str, dict[str, dict[str, int]]] = {'women': {}, 'men': {}}
    col_bounds = {
        'women': [(50, 220, '500m'), (220, 385, '1000m'), (385, 560, '1500m')],
        'men': [(50, 215, '500m'), (215, 380, '1000m'), (380, 560, '1500m')],
    }
    y_bounds = {'women': (430, 706), 'men': (130, 400)}

    for gender, (ymin, ymax) in y_bounds.items():
        # Handle occasional combined span where PDF puts two adjacent columns in a single text run
        expanded: list[tuple[float, float, str]] = []
        for y, x, t in items:
            if not (ymin <= y <= ymax):
                continue
            # Split merged row like "Hungary 2 competitors Italy 3 competitors"
            merged = re.findall(r'([A-Za-zÀ-ÿ/\s*]+?)\s+([23])\s*competiti?ors?', t)
            if len(merged) >= 2:
                # Assign into col 0 and col 1 based on start x
                base_col = 0 if x < 200 else 1
                for offset, (cname, qnum) in enumerate(merged):
                    cx = col_bounds[gender][base_col + offset][0] + 10
                    expanded.append((y, cx, f'{cname.strip()} {qnum} competitors'))
            else:
                expanded.append((y, x, t))

        for xmin, xmax, dk in col_bounds[gender]:
            col_items = [(y, x, t) for y, x, t in expanded if xmin <= x < xmax]
            col_items.sort(key=lambda z: (-z[0], z[1]))
            # Group by y within 14pt? No, 3.5pt for same row, then join multi-line "Hong" / "Kong/China"
            rows: list[tuple[float, list[tuple[float, str]]]] = []
            for y, x, t in col_items:
                if rows and abs(rows[-1][0] - y) <= 3.5:
                    rows[-1][1].append((x, t))
                else:
                    rows.append((y, [(x, t)]))
            pending_prefix = ''
            for _, parts in rows:
                parts.sort()
                joined = ' '.join(t for _, t in parts)
                # Fix broken word like "2 c ompetitors" or "2 competitiors"
                joined = re.sub(r'(\d)\s+c\s+ompetitors', r'\1 competitors', joined)
                m = re.match(r'^(.+?)\s+([23])\s+competiti?ors?$', joined)
                if m:
                    raw_name = (pending_prefix + ' ' + m.group(1)).strip().rstrip('*')
                    pending_prefix = ''
                    code = MEMBER_NAME_TO_CODE.get(raw_name)
                    if not code:
                        raise ValueError(f'Unmapped Comm. 2805 member name: {raw_name!r}')
                    out[gender].setdefault(code, {'500m': 1, '1000m': 1, '1500m': 1})[dk] = int(m.group(2))
                elif joined in ('Hong', 'Hong Kong/China', 'Kong/China'):
                    # Multi-line Hong Kong/China wraps around the "2 competitors" line
                    if joined == 'Hong':
                        pending_prefix = 'Hong'
                    elif joined == 'Kong/China' and pending_prefix == 'Hong':
                        pending_prefix = ''
                elif re.fullmatch(r'([23])\s+competiti?ors?', joined) and pending_prefix == 'Hong':
                    out[gender].setdefault('HKG', {'500m': 1, '1000m': 1, '1500m': 1})[dk] = int(joined[0])
    return out


def verify_wc_2027_against_comm_2805(
    worlds_2026_pdf: Path,
    comm_2805_pdf: Path,
    cfg: dict | None = None,
) -> dict:
    """Back-calculate 2027 WC individual quotas from 2026 Worlds C74A and compare 100% with Comm. 2805."""
    cfg = cfg or load_rules_config()
    cls_tables = extract_2026_worlds_c74a_from_pdf(worlds_2026_pdf)
    computed = compute_wc_2027_individual_quotas(cls_tables, cfg, apply_host_upgrade=True)
    official = extract_comm_2805_wc_quotas_from_pdf(comm_2805_pdf)

    mismatches = []
    checked = 0
    for gender in ('women', 'men'):
        all_countries = sorted(set(computed[gender]) | set(official[gender]))
        for country in all_countries:
            for dk in DIST_KEYS:
                got = computed[gender].get(country, {}).get(f'slots_{dk}', 1)
                exp = official[gender].get(country, {}).get(dk, 1)
                checked += 1
                if got != exp:
                    mismatches.append(
                        {
                            'gender': gender,
                            'country': country,
                            'distance': dk,
                            'computed': got,
                            'official_comm_2805': exp,
                        }
                    )
    return {
        'checked_cells': checked,
        'mismatch_count': len(mismatches),
        'exact_match': len(mismatches) == 0,
        'mismatches': mismatches,
        'computed_quotas': computed,
        'official_comm_2805': official,
    }


def load_latest_penalties(penalties_dir: Path = ROOT / 'data/penalties') -> tuple[str | None, list[dict]]:
    """Load the latest verified C98P cumulative penalties snapshot by completed_events."""
    best_path = None
    best_data = None
    best_n = -1
    if not penalties_dir.exists():
        return None, []
    for p in sorted(penalties_dir.glob('*.json')):
        d = json.loads(p.read_text(encoding='utf-8'))
        n = int(d.get('completed_events', 0))
        if n > best_n:
            best_n = n
            best_path = p.name
            best_data = d
    if not best_data:
        return None, []
    return best_path, best_data.get('official', [])


def build_quotas_snapshot(
    *,
    cfg_path: Path = DEFAULT_CONFIG_PATH,
    worlds_2026_pdf: Path | None = None,
    comm_2805_pdf: Path | None = None,
    wt_rankings_path: Path = ROOT / 'data/world_tour_rankings.json',
    live_standings_path: Path | None = None,
    out_path: Path = ROOT / 'data/quota_roster/quotas_2026_27.json',
) -> dict:
    """Build deterministic 2026-27 WT & 2027 WC quota snapshot JSON."""
    cfg = load_rules_config(cfg_path)

    # 1. 2027 WC Individual quotas
    wc_verification = None
    if worlds_2026_pdf and worlds_2026_pdf.exists() and comm_2805_pdf and comm_2805_pdf.exists():
        wc_verification = verify_wc_2027_against_comm_2805(worlds_2026_pdf, comm_2805_pdf, cfg)
        wc_individual = wc_verification['computed_quotas']
    elif comm_2805_pdf and comm_2805_pdf.exists():
        official = extract_comm_2805_wc_quotas_from_pdf(comm_2805_pdf)
        wc_individual = {'women': {}, 'men': {}}
        for gender in ('women', 'men'):
            for c, dmap in official[gender].items():
                wc_individual[gender][c] = {
                    'country': c,
                    'gender': gender,
                    'slots_500m': dmap['500m'],
                    'slots_1000m': dmap['1000m'],
                    'slots_1500m': dmap['1500m'],
                    'earned_500m': dmap['500m'],
                    'earned_1000m': dmap['1000m'],
                    'earned_1500m': dmap['1500m'],
                    'host_upgraded_distances': [],
                }
    else:
        # Fallback to verified CHN status in config
        chn_cfg = cfg['world_championships_2027']['china_chn_verified_status']['individual_quotas']
        wc_individual = {
            gender: {
                'CHN': {
                    'country': 'CHN',
                    'gender': gender,
                    'slots_500m': chn_cfg[gender]['500m'],
                    'slots_1000m': chn_cfg[gender]['1000m'],
                    'slots_1500m': chn_cfg[gender]['1500m'],
                    'earned_500m': chn_cfg[gender]['500m'],
                    'earned_1000m': chn_cfg[gender]['1000m'],
                    'earned_1500m': chn_cfg[gender]['1500m'],
                    'host_upgraded_distances': [],
                }
            }
            for gender in ('women', 'men')
        }

    # 2. World Ranking (WRD) + WT Relay (WCD) from live standings cache if available, else local rankings fallback
    wrd_by_dist: dict[tuple[str, str], list[dict]] = {}
    relay_standings: dict[str, list[dict]] = {}
    if live_standings_path and live_standings_path.exists():
        live = json.loads(live_standings_path.read_text(encoding='utf-8'))
        for tbl in live.get('world_rankings_individual', []):
            wrd_by_dist[(tbl['gender'], _norm_dist_key(tbl['distance_m']))] = tbl['items']
        for key, items in (live.get('world_tour_relay_standings') or {}).items():
            relay_standings[key] = items
    elif wt_rankings_path.exists():
        wtr = json.loads(wt_rankings_path.read_text(encoding='utf-8'))
        for tbl in wtr.get('tables', []):
            wrd_by_dist[(tbl['gender'], _norm_dist_key(tbl['distance_m']))] = tbl['items']

    wc_relays = compute_wc_2027_relay_quotas(relay_standings, cfg) if relay_standings else {}

    # Attach relay flags + max_roster_size to every country in wc_individual
    w_rel_qual = set(wc_relays.get('women_3000m', {}).get('qualified_countries', []))
    m_rel_qual = set(wc_relays.get('men_5000m', {}).get('qualified_countries', []))
    x_rel_qual = set(wc_relays.get('mixed_2000m', {}).get('qualified_countries', []))
    for gender in ('women', 'men'):
        g_rel_set = w_rel_qual if gender == 'women' else m_rel_qual
        for country, row in wc_individual[gender].items():
            has_g = country in g_rel_set if wc_relays else (country == 'CHN')
            has_x = country in x_rel_qual if wc_relays else (country == 'CHN')
            row['has_gender_relay'] = has_g
            row['has_mixed_relay'] = has_x
            row['max_roster_size'] = compute_wc_2027_max_roster(
                {'500m': row['slots_500m'], '1000m': row['slots_1000m'], '1500m': row['slots_1500m']},
                has_g,
                has_x,
                cfg,
            )

    # 3. 2026-27 WT quotas + cumulative penalties
    pen_source, pen_rows = load_latest_penalties()
    wt_summary = compute_wt_2026_27_quotas(wrd_by_dist, pen_rows, cfg)

    payload = {
        'schema_version': 1,
        'season': cfg['season'],
        'generated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        'config_version': cfg['schema_version'],
        'penalty_source': pen_source,
        'wc_2027_verification': {
            'checked_cells': wc_verification['checked_cells'],
            'mismatch_count': wc_verification['mismatch_count'],
            'exact_match': wc_verification['exact_match'],
        }
        if wc_verification
        else None,
        'world_championships_2027': {
            'individual_and_roster': wc_individual,
            'relays': wc_relays,
        },
        'world_tour_2026_27': wt_summary,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text(encoding='utf-8'))
            if {k: v for k, v in prev.items() if k != 'generated_at'} == {
                k: v for k, v in payload.items() if k != 'generated_at'
            } and prev.get('generated_at'):
                payload['generated_at'] = prev['generated_at']
        except Exception:
            pass
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument('--worlds-2026-pdf', type=Path, default=ROOT / '.cache/isu/1_worlds.pdf')
    parser.add_argument('--comm-2805-pdf', type=Path, default=ROOT / '.cache/isu_phase0/comm_2805.pdf')
    parser.add_argument('--live-standings', type=Path, default=ROOT / 'data/quota_roster/standings_2026_27.json')
    parser.add_argument('--out', type=Path, default=ROOT / 'data/quota_roster/quotas_2026_27.json')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()

    cfg = load_rules_config(args.config)
    if args.verify_only:
        res = verify_wc_2027_against_comm_2805(args.worlds_2026_pdf, args.comm_2805_pdf, cfg)
        print(f'Verified {res["checked_cells"]} country×gender×distance cells: mismatches={res["mismatch_count"]}')
        if res['mismatches']:
            for m in res['mismatches']:
                print('  MISMATCH:', m)
            raise SystemExit(1)
        print('100% EXACT MATCH with ISU Communication No. 2805!')
        return

    payload = build_quotas_snapshot(
        cfg_path=args.config,
        worlds_2026_pdf=args.worlds_2026_pdf if args.worlds_2026_pdf.exists() else None,
        comm_2805_pdf=args.comm_2805_pdf if args.comm_2805_pdf.exists() else None,
        live_standings_path=args.live_standings if args.live_standings.exists() else None,
        out_path=args.out,
    )
    print(f'Wrote {args.out}')
    chn_w = payload['world_championships_2027']['individual_and_roster']['women']['CHN']
    chn_m = payload['world_championships_2027']['individual_and_roster']['men']['CHN']
    print('2027 WC CHN Women:', chn_w)
    print('2027 WC CHN Men:  ', chn_m)


if __name__ == '__main__':
    main()
