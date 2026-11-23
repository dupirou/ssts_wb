#!/usr/bin/env python3
"""Isolated ISU Junior World Cup & World Junior Championships crawler + 2026/27 standings & CHN DOB sync.

STRICT DATA ISOLATION:
  - Writes ONLY under data/quota_roster/ (and caches under .cache/isu_junior/).
  - NEVER writes to data/heats/ or data/heats/prediction_state.json so the Senior
    match-prediction OpenSkill pool and backtest scores remain 100% untouched.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
PYLIB = ROOT / '.cache/pylib'
if PYLIB.exists() and str(PYLIB) not in sys.path:
    sys.path.insert(0, str(PYLIB))
if str(ROOT / 'tools') not in sys.path:
    sys.path.insert(0, str(ROOT / 'tools'))

import heats_schema as hs
import isu_results
import isu_transport
import quota_engine as qe
import yaml

API = 'https://front-api.isu.org/events/'
HOSTS = {
    'front-api.isu.org',
    'www.isu-skating.com',
    'isu-skating.com',
}
DEFAULT_SEASONS = ('2024/2025', '2025/2026', '2026/2027')
DEFAULT_CACHE = ROOT / '.cache/isu_junior'
DEFAULT_OUT_DIR = ROOT / 'data/quota_roster'
SEX_MAP = {
    'Women': 'women',
    'Ladies': 'women',
    'F': 'women',
    'W': 'women',
    'Men': 'men',
    'M': 'men',
    'Mixed': 'mixed',
    'X': 'mixed',
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class JuniorSourceCache:
    """Disk-backed throttled cache for ISU Junior API, standings, and skater bio pages."""

    def __init__(self, directory: Path = DEFAULT_CACHE, *, delay: float = 0.25, offline: bool = False):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.delay = max(0.0, float(delay)) if not offline else 0.0
        self.offline = offline
        self._last_fetch = 0.0

    def _path_for(self, url: str, form: dict | None = None, json_payload: dict | None = None) -> Path:
        key_obj = [url, sorted((form or {}).items()), sorted((json_payload or {}).items())]
        digest = _sha256(json.dumps(key_obj, sort_keys=True).encode('utf-8'))
        ext = '.json' if (form or json_payload) else '.html'
        return self.directory / f'{digest}{ext}'

    def fetch(
        self,
        url: str,
        *,
        form: dict | None = None,
        json_payload: dict | None = None,
        accept: str | None = None,
    ) -> bytes:
        if not isu_transport.allowed(url, HOSTS):
            raise ValueError(f'Unexpected ISU host: {url}')
        path = self._path_for(url, form, json_payload)
        if path.exists() and (self.offline or json_payload is None):
            return path.read_bytes()
        if self.offline:
            raise FileNotFoundError(f'Cache miss in offline mode: {url} form={form} json={json_payload}')
        elapsed = time.monotonic() - self._last_fetch
        if self._last_fetch > 0 and elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        for attempt in range(3):
            try:
                body = isu_transport.request_bytes(
                    url,
                    hosts=HOSTS,
                    max_bytes=20_000_000,
                    form=form,
                    json_payload=json_payload,
                    accept=accept,
                )
                self._last_fetch = time.monotonic()
                path.write_bytes(body)
                return body
            except HTTPError as exc:
                if exc.code not in {429, 500, 502, 503, 504} or attempt == 2:
                    raise
                time.sleep(1.5 * (attempt + 1))
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f'Failed to fetch {url}')

    def api_form(self, endpoint: str, **form) -> list[dict]:
        raw = self.fetch(API + endpoint, form=form)
        obj = json.loads(raw)
        if obj.get('status') != 200 or not isinstance(obj.get('data'), list):
            raise ValueError(f'Unexpected ISU API response for {endpoint}')
        return obj['data']

    def api_json(self, endpoint: str, payload: dict) -> dict:
        raw = self.fetch(API + endpoint, json_payload=payload, accept='application/json')
        obj = json.loads(raw)
        if obj.get('status') != 200:
            raise ValueError(f'Unexpected ISU JSON response for {endpoint}')
        return obj


def _parse_time_seconds(val: str | None) -> float | None:
    if not val:
        return None
    s = str(val).strip()
    if not s or s.lower() in ('no time', 'dnf', 'dns', 'pen', 'yc', 'rc', '-'):
        return None
    m = re.fullmatch(r'(?:(\d+):)?(\d+(?:\.\d+)?)', s)
    if not m:
        return None
    mins = int(m.group(1)) if m.group(1) else 0
    return round(mins * 60.0 + float(m.group(2)), 4)


def _norm_status(final_result: str | None, result_status: str | None, time_s: float | None) -> str:
    fr = (final_result or '').strip().upper()
    rs = (result_status or '').strip().lower()
    if fr == 'DNS' or 'did not start' in rs:
        return 'DNS'
    if fr == 'DNF' or 'did not finish' in rs:
        return 'DNF'
    if fr == 'RC' or 'red card' in rs:
        return 'RC'
    if fr == 'YC' or 'yellow card' in rs:
        return 'YC'
    if fr == 'PEN' or 'penalty' in rs:
        return 'PEN'
    if fr == 'NO TIME' or (time_s is None and fr == ''):
        return 'NO_TIME'
    return 'OK'


def _classify_round(round_name: str, heat_name: str) -> tuple[str, str, int]:
    rn = (round_name or '').strip().lower()
    hn = (heat_name or '').strip().lower()
    is_rep = rn.startswith('rep')
    session_type = 'REPECHAGE' if is_rep else 'MAIN'
    if 'final' in rn and not ('quarter' in rn or 'semi' in rn):
        if 'ranking' in rn:
            return 'MAIN', 'ranking_final', 3
        if 'final b' in hn or 'final b' in rn:
            return 'MAIN', 'final_b', 4
        return 'MAIN', 'final_a', 5
    if 'semi' in rn:
        return session_type, 'semifinal', 3
    if 'quarter' in rn:
        return session_type, 'quarterfinal', 2
    if 'heat' in rn:
        return ('REPECHAGE' if is_rep else 'PRELIM'), 'heats', 1
    if 'pre-prelim' in rn:
        return 'PRELIM', 'pre_preliminaries', -1
    return 'PRELIM', 'preliminaries', 0


def discover_junior_events(cache: JuniorSourceCache, seasons: tuple[str, ...] = DEFAULT_SEASONS) -> list[dict]:
    events = []
    for season in seasons:
        rows = cache.api_form(
            'list',
            discipline_id=3,
            state='Finished',
            page=1,
            pagesize=200,
            season=season,
            event_level='ISU',
        )
        short_season = f'{season[:4]}/{season[7:9]}'
        for ev in rows:
            name = ev.get('name') or ''
            if 'junior' not in name.lower():
                continue
            kind = 'junior_worlds' if 'championship' in name.lower() else 'junior_worldcup'
            city = (ev.get('city') or '').strip()
            city_slug = re.sub(r'[^a-z0-9]+', '-', hs.plain_text(city).lower()).strip('-') or 'event'
            date_start = (ev.get('from_date') or '')[:10]
            date_end = (ev.get('to_date') or '')[:10]
            events.append(
                {
                    'season': short_season,
                    'season_full': season,
                    'official_event_id': str(ev['event_id']),
                    'kind': kind,
                    'category': 'JUNIOR',
                    'title': name,
                    'city': city,
                    'country': ev.get('country_code') or '',
                    'date_start': date_start,
                    'date_end': date_end,
                    'slug': ev.get('slug') or '',
                    'city_slug': city_slug,
                }
            )
    events.sort(key=lambda e: (e['date_start'], int(e['official_event_id'])))
    # Assign deterministic stop_number and event_id slug per (season, kind)
    counters: dict[tuple[str, str], int] = {}
    for ev in events:
        key = (ev['season'], ev['kind'])
        counters[key] = counters.get(key, 0) + 1
        idx = counters[key]
        ev['stop_number'] = idx if ev['kind'] == 'junior_worldcup' else None
        suffix = f'-{idx}' if ev['kind'] == 'junior_worldcup' else ''
        ev['event_id'] = f'{ev["season"].replace("/", "-")}-{ev["kind"].replace("_", "")}-{ev["city_slug"]}{suffix}'
    return events


def crawl_junior_event(cache: JuniorSourceCache, ev: dict, athletes_registry: dict[str, dict]) -> dict:
    """Fetch complete individual heats, final classifications, and relay appearances for one Junior event."""
    page_url = f'https://www.isu-skating.com/en/short-track/events/eventdetail/{ev["slug"]}/?tab=results_{ev["official_event_id"]}'
    html = cache.fetch(page_url)
    discs = isu_results.embedded_results(html)

    heats: list[dict] = []
    classifications: list[dict] = []
    relays: list[dict] = []

    for meta in discs:
        dname = meta.get('name') or ''
        gender = SEX_MAP.get(meta.get('gender'))
        dist_m = isu_results.integer(meta.get('discipline_distance'))
        is_relay = meta.get('discipline_type') == 'Couples' or 'relay' in dname.lower()
        if gender == 'mixed' and not dist_m:
            dist_m = 2000
        if not gender or not dist_m:
            continue
        if not is_relay and dist_m not in (500, 1000, 1500):
            continue
        if 'overall' in dname.lower() or 'all-around' in dname.lower():
            continue

        er_id = meta['event_result_id']
        race_num_m = re.search(r'\((\d+)\)\s*$', dname)
        dist_instance = int(race_num_m.group(1)) if race_num_m else 1

        # 1. Final distance classification
        cls_ep = 'get-event-result-fsksys-team' if is_relay else 'get-event-result-fsk-single'
        cls_rows = cache.api_form(
            cls_ep, event_id=ev['official_event_id'], event_result_id=er_id, country_code='', code=''
        )
        cls_rank_by_id: dict[int, int | None] = {}
        for cr in cls_rows:
            oid = cr.get('skaters_team_id' if is_relay else 'skaters_id')
            rk = isu_results.integer(cr.get('final_rank'))
            country = cr.get('started_for_nf_code') or ((cr.get('skaters') or {}).get('organization_code') or '')
            if is_relay:
                if oid:
                    cls_rank_by_id[int(oid)] = rk
                continue
            skater = cr.get('skaters') or {}
            full_name = skater.get('full_name') or ''
            if not oid or not full_name:
                continue
            aid = f'skr-{oid}'
            _register_athlete(
                athletes_registry, aid, int(oid), full_name, gender, country, skater.get('slug'), ev['date_start']
            )
            classifications.append(
                {
                    'gender': gender,
                    'distance_m': dist_m,
                    'event_distance_instance': dist_instance,
                    'athlete_id': aid,
                    'official_skater_id': int(oid),
                    'athlete_name': full_name,
                    'country': country,
                    'final_classification': rk,
                    'status': cr.get('final_result') or 'OK',
                }
            )

        # 2. Rounds & heats
        rounds = cache.api_form('get-event-result-round', event_result_id=er_id)
        rounds.sort(key=lambda r: (r.get('date') or '', r.get('display_order') or 0))

        relay_team_members: dict[tuple[str, int], dict] = {}
        for rmeta in rounds:
            rnd_id = rmeta['event_result_round_id']
            ht_ep = 'get-event-result-round-heats-stk-' + ('team' if is_relay else 'single')
            ht_rows = cache.api_form(ht_ep, event_result_id=er_id, event_result_round_id=rnd_id, country_code='')
            for hidx, h in enumerate(ht_rows, 1):
                session_type, round_slug, round_tier = _classify_round(rmeta.get('name') or '', h.get('name') or '')
                local_date = (h.get('date') or ev['date_start'])[:10]
                if is_relay:
                    teams = (
                        h.get('event_result_round_heats_teams') or h.get('event_result_round_heats_competitors') or []
                    )
                    for tm in teams:
                        country = tm.get('started_for_nf_code') or ''
                        tid = tm.get('skaters_team_id') or 0
                        if not country:
                            continue
                        rec = relay_team_members.setdefault(
                            (country, int(tid)),
                            {
                                'gender': gender,
                                'distance_m': dist_m,
                                'country': country,
                                'final_classification': cls_rank_by_id.get(int(tid)),
                                'members': {},
                            },
                        )
                        for mem in tm.get('event_result_round_heats_competitors_team_members') or []:
                            sk = mem.get('skaters') or {}
                            sid = mem.get('skaters_id')
                            nm = sk.get('full_name')
                            mg = SEX_MAP.get(sk.get('gender')) or (gender if gender in ('women', 'men') else None)
                            if not sid or not nm:
                                continue
                            aid = f'skr-{sid}'
                            if mg in ('women', 'men'):
                                _register_athlete(
                                    athletes_registry, aid, int(sid), nm, mg, country, sk.get('slug'), local_date
                                )
                            mrec = rec['members'].setdefault(
                                aid,
                                {
                                    'athlete_id': aid,
                                    'official_skater_id': int(sid),
                                    'name': nm,
                                    'gender': mg,
                                    'rounds': [],
                                },
                            )
                            if round_slug not in mrec['rounds']:
                                mrec['rounds'].append(round_slug)
                    continue

                comps = h.get('event_result_round_heats_competitors') or []
                participants = []
                seen_ids = set()
                for c in comps:
                    sid = c.get('skaters_id')
                    sk = c.get('skaters') or {}
                    nm = sk.get('full_name') or ''
                    if not sid or not nm or sid in seen_ids:
                        continue
                    seen_ids.add(sid)
                    country = c.get('started_for_nf_code') or sk.get('organization_code') or ''
                    aid = f'skr-{sid}'
                    _register_athlete(athletes_registry, aid, int(sid), nm, gender, country, sk.get('slug'), local_date)
                    time_s = _parse_time_seconds(c.get('final_result'))
                    status = _norm_status(c.get('final_result'), c.get('result_status'), time_s)
                    rk = isu_results.integer(c.get('final_rank'))
                    laps = []
                    for lp in c.get('lap') or []:
                        lt = _parse_time_seconds(lp.get('LapTime'))
                        if lt is not None:
                            laps.append(lt)
                    participants.append(
                        {
                            'athlete_id': aid,
                            'official_skater_id': int(sid),
                            'name': nm,
                            'country': country,
                            'lane': isu_results.integer(c.get('starting_position')),
                            'rank': rk,
                            'finish_time_s': time_s,
                            'status': status,
                            'qualification_code': (c.get('qualification_code') or '').strip(),
                            'opening_split_s': laps[0] if laps else None,
                            'lap_times_s': laps,
                        }
                    )
                if participants:
                    heats.append(
                        {
                            'id': f'{ev["event_id"]}:{gender}:{dist_m}:{dist_instance}:{round_slug}:{h.get("event_result_round_heats_id", hidx)}',
                            'category': 'JUNIOR',
                            'event_id': ev['event_id'],
                            'season': ev['season'],
                            'city': ev['city'],
                            'local_date': local_date,
                            'start_time_utc': h.get('date') or f'{local_date}T12:00:00Z',
                            'gender': gender,
                            'distance_m': dist_m,
                            'event_distance_instance': dist_instance,
                            'session_type': session_type,
                            'round': round_slug,
                            'round_tier': round_tier,
                            'heat_name': h.get('name') or f'Heat {hidx}',
                            'heat_size': len(participants),
                            'participants': participants,
                        }
                    )

        if is_relay:
            for rec in relay_team_members.values():
                rec['members'] = list(rec['members'].values())
                relays.append(rec)

    return {
        'schema_version': 1,
        'category': 'JUNIOR',
        'event_id': ev['event_id'],
        'official_event_id': ev['official_event_id'],
        'season': ev['season'],
        'kind': ev['kind'],
        'stop_number': ev['stop_number'],
        'title': ev['title'],
        'city': ev['city'],
        'country': ev['country'],
        'date_start': ev['date_start'],
        'date_end': ev['date_end'],
        'source_url': page_url,
        'heat_count': len(heats),
        'classification_count': len(classifications),
        'relay_count': len(relays),
        'heats': heats,
        'classifications': classifications,
        'relays': relays,
    }


def _register_athlete(
    registry: dict[str, dict],
    aid: str,
    oid: int,
    name: str,
    gender: str,
    country: str,
    slug: str | None,
    seen_date: str,
) -> None:
    rec = registry.get(aid)
    if not rec:
        registry[aid] = {
            'id': aid,
            'official_skater_id': oid,
            'name': name,
            'gender': gender,
            'country': country,
            'slug': slug or '',
            'first_seen': seen_date,
            'last_seen': seen_date,
            'birth_date': None,
        }
        return
    if slug and not rec.get('slug'):
        rec['slug'] = slug
    if country:
        rec['country'] = country
    if seen_date and (not rec['first_seen'] or seen_date < rec['first_seen']):
        rec['first_seen'] = seen_date
    if seen_date and (not rec['last_seen'] or seen_date > rec['last_seen']):
        rec['last_seen'] = seen_date


def fetch_skater_birth_date(cache: JuniorSourceCache, slug: str) -> str | None:
    """Fetch official YYYY-MM-DD birth date from ISU skater bio page."""
    if not slug:
        return None
    url = f'https://www.isu-skating.com/en/short-track/skaters/{slug}/'
    try:
        html = cache.fetch(url).decode('utf-8', errors='ignore')
    except Exception:
        return None
    # Match JSON date_of_birth / birthDate or DD.MM.YYYY near "Date of birth"
    for pat in (
        r'"(?:date_of_birth|birth_date|birthdate|dob)"\s*:\s*"(\d{4}-\d{2}-\d{2})"',
        r'date_of_birth\\?":\\?"(\d{4}-\d{2}-\d{2})',
    ):
        m = re.search(pat, html, re.I)
        if m:
            return m.group(1)
    m_dmy = re.search(r'Date of birth.*?(\d{2})\.(\d{2})\.(\d{4})', html, re.I | re.S)
    if m_dmy:
        return f'{m_dmy.group(3)}-{m_dmy.group(2)}-{m_dmy.group(1)}'
    m_iso = re.search(r'(19\d{2}|20[01]\d)-(\d{2})-(\d{2})', html)
    if m_iso:
        return m_iso.group(0)
    return None


def sync_standings_2026_27(cache: JuniorSourceCache, season_id: int = 47) -> dict:
    """Fetch 2026/27 Senior WRD (individual), Senior WT Relay WCD, and Junior WCD standings."""
    cat = cache.api_json(
        'get-world-standings-list',
        dict(discipline_id=3, season_id=season_id, pagesize=300, page=1),
    )
    lists = cat.get('data') or []

    def fetch_single_rows(meta: dict) -> list[dict]:
        rid = meta['world_standings_list_fsk_id']
        items = []
        for page in range(1, 20):
            obj = cache.api_json(
                'get-world-standings-fsk-detail-skater-single', {'world_standings_list_fsk_id': rid, 'page': page}
            )
            if obj.get('current_page') != page or (obj.get('detail') or {}).get('world_standings_list_fsk_id') != rid:
                return []
            for row in obj.get('data') or []:
                sid = row.get('skaters_id')
                sk = row.get('skaters') or {}
                country = (
                    row.get('organization_code') or sk.get('organization_code') or sk.get('nationality_code') or ''
                )
                items.append(
                    {
                        'athlete_id': f'skr-{sid}' if sid else None,
                        'official_skater_id': sid,
                        'name': sk.get('full_name') or row.get('full_name') or '',
                        'slug': sk.get('slug') or '',
                        'country': country,
                        'rank': row.get('rank'),
                        'points': row.get('points'),
                    }
                )
            if page >= int(obj.get('total_page') or 1):
                break
        if page != int(obj.get('total_page') or 1) or len(items) != obj.get('total_items'):
            return []
        return items

    def fetch_team_rows(meta: dict) -> list[dict]:
        rid = meta['world_standings_list_fsk_id']
        items = []
        for page in range(1, 10):
            # Try team detail endpoint first; fallback to single endpoint if ISU serves teams there
            try:
                obj = cache.api_json(
                    'get-world-standings-fsk-detail-skater-team',
                    {'world_standings_list_fsk_id': rid, 'page': page},
                )
            except Exception:
                obj = cache.api_json(
                    'get-world-standings-fsk-detail-skater-single',
                    {'world_standings_list_fsk_id': rid, 'page': page},
                )
            if obj.get('current_page') != page or (obj.get('detail') or {}).get('world_standings_list_fsk_id') != rid:
                return []
            for row in obj.get('data') or []:
                st = row.get('skaters_team') or row.get('skaters') or {}
                team_name = st.get('full_name') or st.get('name') or ''
                country = (
                    row.get('organization_code')
                    or row.get('nf_code')
                    or st.get('organization_code')
                    or st.get('country_code')
                    or qe.MEMBER_NAME_TO_CODE.get(team_name, '')
                )
                items.append(
                    {
                        'country': country,
                        'name': team_name or country,
                        'rank': row.get('rank'),
                        'points': row.get('points'),
                    }
                )
            if page >= int(obj.get('total_page') or 1):
                break
        if page != int(obj.get('total_page') or 1) or len(items) != obj.get('total_items'):
            return []
        return items

    wrd_individual = []
    wt_relays: dict[str, list[dict]] = {}
    jwc_individual = []

    for meta in lists:
        name = meta.get('name') or ''
        typ = meta.get('type')
        lvl = meta.get('level_name')
        team = meta.get('team_type')
        gender = SEX_MAP.get(meta.get('gender'))

        if typ == 'WRD' and lvl == 'Senior' and team == 'Singles':
            m = re.search(r'(500|1000|1500)\s*m', name)
            if m and gender in ('women', 'men'):
                wrd_individual.append(
                    {
                        'gender': gender,
                        'distance_m': int(m.group(1)),
                        'list_id': meta['world_standings_list_fsk_id'],
                        'name': name,
                        'items': fetch_single_rows(meta),
                    }
                )
        elif typ == 'WCD' and lvl == 'Senior' and team == 'Couples':
            if 'Women Relay 3000' in name:
                wt_relays['women_3000m'] = fetch_team_rows(meta)
            elif 'Men Relay 5000' in name:
                wt_relays['men_5000m'] = fetch_team_rows(meta)
            elif 'Mixed Relay 2000' in name:
                wt_relays['mixed_2000m'] = fetch_team_rows(meta)
        elif typ == 'WCD' and lvl == 'Junior' and team == 'Singles':
            m = re.search(r'(500|1000|1500)\s*m', name)
            if m and gender in ('women', 'men'):
                jwc_individual.append(
                    {
                        'gender': gender,
                        'distance_m': int(m.group(1)),
                        'list_id': meta['world_standings_list_fsk_id'],
                        'name': name,
                        'items': fetch_single_rows(meta),
                    }
                )

    return {
        'schema_version': 1,
        'season': '2026/27',
        'season_id': season_id,
        'fetched_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        'world_rankings_individual': wrd_individual,
        'world_tour_relay_standings': wt_relays,
        'junior_world_cup_individual': jwc_individual,
    }


def collect_senior_chn_slugs(cache: JuniorSourceCache, standings: dict) -> dict[str, dict]:
    """Collect CHN Senior athlete metadata & slugs from data/heats/athletes.json + standings WRD."""
    profiles: dict[str, dict] = {}
    zh_map = json.loads((ROOT / 'data/athlete_names_zh.json').read_text(encoding='utf-8')).get('names', {})
    # Case-insensitive normalized lookup for zh names
    zh_norm = {re.sub(r'[^a-z]+', '', k.lower()): v for k, v in zh_map.items()}
    # Also reversed order "SURNAME Given" -> "Given SURNAME"
    for k, v in list(zh_map.items()):
        parts = k.split()
        if len(parts) == 2:
            zh_norm[re.sub(r'[^a-z]+', '', (parts[1] + parts[0]).lower())] = v

    heats_athletes = json.loads((ROOT / 'data/heats/athletes.json').read_text(encoding='utf-8')).get('items', [])
    for a in heats_athletes:
        countries = [c['country'] for c in a.get('countries') or []]
        if 'CHN' not in countries:
            continue
        aid = a['id']
        oid = (a.get('official_skater_ids') or [None])[0]
        nkey = re.sub(r'[^a-z]+', '', (a.get('name') or '').lower())
        profiles[aid] = {
            'athlete_id': aid,
            'official_skater_id': oid,
            'name_en': a.get('name'),
            'name_zh': a.get('name_zh') or zh_norm.get(nkey),
            'gender': a.get('gender'),
            'country': 'CHN',
            'slug': '',
            'birth_date': None,
            'last_seen_senior': (a.get('countries') or [{}])[-1].get('last_seen'),
            'pools': ['senior'],
        }

    # Enrich slugs & add newly debuted 2026/27 CHN skaters from WRD standings
    for tbl in standings.get('world_rankings_individual', []):
        for row in tbl.get('items', []):
            if row.get('country') != 'CHN' or not row.get('athlete_id'):
                continue
            aid = row['athlete_id']
            if aid not in profiles:
                nkey = re.sub(r'[^a-z]+', '', (row.get('name') or '').lower())
                profiles[aid] = {
                    'athlete_id': aid,
                    'official_skater_id': row.get('official_skater_id'),
                    'name_en': row.get('name'),
                    'name_zh': zh_norm.get(nkey),
                    'gender': tbl['gender'],
                    'country': 'CHN',
                    'slug': row.get('slug') or '',
                    'birth_date': None,
                    'last_seen_senior': '2026-11-20',
                    'pools': ['senior'],
                }
            elif row.get('slug'):
                profiles[aid]['slug'] = row['slug']

    return profiles


def _guess_slug_from_name(name_en: str) -> str:
    tokens = re.findall(r'[A-Za-z]+', hs.plain_text(name_en or '').lower())
    return '-'.join(tokens)


def sync_all(
    *,
    seasons: tuple[str, ...] = DEFAULT_SEASONS,
    cache_dir: Path = DEFAULT_CACHE,
    out_dir: Path = DEFAULT_OUT_DIR,
    delay: float = 0.25,
    offline: bool = False,
    skip_dobs: bool = False,
) -> dict:
    cfg = qe.load_rules_config()
    cache = JuniorSourceCache(cache_dir, delay=delay, offline=offline)
    junior_dir = out_dir / 'junior'
    events_dir = junior_dir / 'events'
    events_dir.mkdir(parents=True, exist_ok=True)

    # 1. Discover & crawl Junior events (2024/25 - 2026/27)
    events = discover_junior_events(cache, seasons)
    athletes_registry: dict[str, dict] = {}
    event_index = []
    total_heats = 0

    for ev in events:
        ev_doc = crawl_junior_event(cache, ev, athletes_registry)
        fname = f'{ev["event_id"]}.json'
        (events_dir / fname).write_text(json.dumps(ev_doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        total_heats += ev_doc['heat_count']
        event_index.append(
            {
                'event_id': ev['event_id'],
                'official_event_id': ev['official_event_id'],
                'season': ev['season'],
                'kind': ev['kind'],
                'stop_number': ev['stop_number'],
                'title': ev['title'],
                'city': ev['city'],
                'country': ev['country'],
                'date_start': ev['date_start'],
                'date_end': ev['date_end'],
                'file': f'events/{fname}',
                'heat_count': ev_doc['heat_count'],
                'classification_count': ev_doc['classification_count'],
                'relay_count': ev_doc['relay_count'],
            }
        )
        print(
            f'Crawled Junior {ev["event_id"]} ({ev["date_start"]}): heats={ev_doc["heat_count"]}, cls={ev_doc["classification_count"]}, relays={ev_doc["relay_count"]}'
        )

    # 2. Fetch 2026/27 standings (WRD + WT Relay WCD + JWC WCD)
    stations_cfg = json.loads((ROOT / 'data/stations.json').read_text(encoding='utf-8'))
    season_id = int(stations_cfg.get('world_tour_standings_season_id', 47))
    standings_path = out_dir / 'standings_2026_27.json'
    previous = json.loads(standings_path.read_text()) if standings_path.exists() else None
    standings = merge_standings(previous, sync_standings_2026_27(cache, season_id=season_id))
    standings_path.write_text(json.dumps(standings, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # 3. Merge CHN profiles (Senior + Junior) & fetch official ISU birth dates
    chn_profiles = collect_senior_chn_slugs(cache, standings)
    for aid, a in athletes_registry.items():
        if a['country'] != 'CHN':
            continue
        if aid in chn_profiles:
            if 'junior' not in chn_profiles[aid]['pools']:
                chn_profiles[aid]['pools'].append('junior')
            if a.get('slug') and not chn_profiles[aid].get('slug'):
                chn_profiles[aid]['slug'] = a['slug']
            chn_profiles[aid]['last_seen_junior'] = a['last_seen']
        else:
            chn_profiles[aid] = {
                'athlete_id': aid,
                'official_skater_id': a['official_skater_id'],
                'name_en': a['name'],
                'name_zh': None,
                'gender': a['gender'],
                'country': 'CHN',
                'slug': a.get('slug') or '',
                'birth_date': None,
                'last_seen_junior': a['last_seen'],
                'pools': ['junior'],
            }

    if not skip_dobs:
        for aid, prof in sorted(chn_profiles.items()):
            slug = prof.get('slug') or _guess_slug_from_name(prof.get('name_en') or '')
            dob = fetch_skater_birth_date(cache, slug) if slug else None
            if dob:
                prof['birth_date'] = dob
                if aid in athletes_registry:
                    athletes_registry[aid]['birth_date'] = dob
            prof['age_group_2026_27'] = qe.classify_age_group(prof.get('birth_date'), cfg)

    for a in athletes_registry.values():
        a['age_group_2026_27'] = qe.classify_age_group(a.get('birth_date'), cfg)

    # Write isolated junior index & athletes
    (junior_dir / 'events.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'category': 'JUNIOR',
                'generated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                'event_count': len(event_index),
                'total_heats': total_heats,
                'items': event_index,
            },
            ensure_ascii=False,
            indent=2,
        )
        + '\n',
        encoding='utf-8',
    )
    (junior_dir / 'athletes.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'category': 'JUNIOR',
                'count': len(athletes_registry),
                'items': sorted(athletes_registry.values(), key=lambda x: (x['country'], x['gender'], x['name'])),
            },
            ensure_ascii=False,
            indent=2,
        )
        + '\n',
        encoding='utf-8',
    )
    (out_dir / 'chn_athlete_profiles.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'country': 'CHN',
                'season': '2026/27',
                'generated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                'count': len(chn_profiles),
                'items': sorted(chn_profiles.values(), key=lambda x: (x['gender'] or '', x['name_en'] or '')),
            },
            ensure_ascii=False,
            indent=2,
        )
        + '\n',
        encoding='utf-8',
    )

    # Bootstrap or refresh config/chn_name_mapping.yaml without losing manual teams/aliases
    mapping_path = ROOT / 'config/chn_name_mapping.yaml'
    existing = yaml.safe_load(mapping_path.read_text(encoding='utf-8')) if mapping_path.exists() else {}
    existing_by_id = {a['athlete_id']: a for a in (existing.get('athletes') or []) if a.get('athlete_id')}
    merged_athletes = []
    for aid, prof in sorted(
        chn_profiles.items(), key=lambda kv: (kv[1].get('gender') or '', kv[1].get('name_en') or '')
    ):
        prev = existing_by_id.get(aid, {})
        merged_athletes.append(
            {
                'athlete_id': aid,
                'official_skater_id': prof.get('official_skater_id'),
                'name_zh': prev.get('name_zh') or prof.get('name_zh') or '',
                'aliases_zh': prev.get('aliases_zh') or [],
                'name_en': prof.get('name_en') or prev.get('name_en') or '',
                'gender': prof.get('gender') or prev.get('gender') or '',
                'birth_date': prof.get('birth_date') or prev.get('birth_date'),
                'age_group_2026_27': prof.get('age_group_2026_27')
                or qe.classify_age_group(prev.get('birth_date'), cfg),
                'teams': prev.get('teams') or [],
                'pools': prof.get('pools') or [],
            }
        )
    # Keep any manually added domestic-only athletes not yet in ISU pools
    for aid, prev in existing_by_id.items():
        if aid not in chn_profiles:
            merged_athletes.append(prev)
    mapping_doc = {
        'schema_version': 1,
        'season': '2026/27',
        'note': 'Composite-key (name_zh, team) mapping for CHN athletes across Senior ISU, Junior ISU, and Domestic PDFs. Populate teams[] to disambiguate domestic homonyms.',
        'athletes': merged_athletes,
    }
    mapping_path.parent.mkdir(parents=True, exist_ok=True)
    mapping_path.write_text(yaml.safe_dump(mapping_doc, allow_unicode=True, sort_keys=False), encoding='utf-8')

    return {
        'events': len(event_index),
        'heats': total_heats,
        'junior_athletes': len(athletes_registry),
        'chn_profiles': len(chn_profiles),
    }


def merge_standings(previous, fresh):
    """Replace a ranking only after its full table arrives; keep each table's data date."""
    previous = previous or {}
    merged = dict(fresh)

    def complete(rows, identity):
        return (
            bool(rows)
            and all(
                row.get(identity)
                and row.get('country')
                and isinstance(row.get('rank'), int)
                and row['rank'] > 0
                and isinstance(row.get('points'), (int, float))
                for row in rows
            )
            and len({r[identity] for r in rows}) == len(rows)
        )

    for section in ('world_rankings_individual', 'junior_world_cup_individual'):
        key = lambda table: (table['gender'], table['distance_m'])
        old = {key(t): t for t in previous.get(section, [])}
        tables = {}
        for table in fresh[section]:
            k = key(table)
            if k in tables:
                raise ValueError(f'Duplicate {section} table: {k}')
            if complete(table['items'], 'athlete_id'):
                tables[k] = table
        expected = [(g, d) for g in ('men', 'women') for d in (500, 1000, 1500)]
        merged[section] = []
        for k in expected:
            current = tables.get(k)
            prior = old.get(k)
            if current is None and prior is None:
                raise ValueError(f'Missing {section} table: {k}')
            if current is None or (
                prior and current['items'] == prior['items'] and current['list_id'] == prior['list_id']
            ):
                merged[section].append({**prior, 'as_of': prior.get('as_of', previous['fetched_at'])})
            else:
                merged[section].append({**current, 'as_of': fresh['fetched_at']})

    relays = {}
    dates = {}
    for key in ('women_3000m', 'men_5000m', 'mixed_2000m'):
        rows = fresh['world_tour_relay_standings'].get(key)
        prior = previous.get('world_tour_relay_standings', {}).get(key)
        if not complete(rows, 'country'):
            if not prior:
                raise ValueError(f'Missing relay standings: {key}')
            rows = prior
        relays[key] = rows
        dates[key] = (
            (previous.get('relay_as_of', {}).get(key) or previous.get('fetched_at'))
            if rows == prior
            else fresh['fetched_at']
        )
    merged['world_tour_relay_standings'] = relays
    merged['relay_as_of'] = dates
    return merged


def sync_standings_only(
    *, cache_dir: Path = DEFAULT_CACHE, out_dir: Path = DEFAULT_OUT_DIR, delay: float = 0.25
) -> bool:
    """Refresh data/quota_roster/standings_2026_27.json from ISU API; preserve previous snapshot on error."""
    out_path = out_dir / 'standings_2026_27.json'
    previous = json.loads(out_path.read_text(encoding='utf-8')) if out_path.exists() else None
    try:
        stations_cfg = json.loads((ROOT / 'data/stations.json').read_text(encoding='utf-8'))
        season_id = int(stations_cfg.get('world_tour_standings_season_id', 47))
        cache = JuniorSourceCache(cache_dir, delay=delay, offline=False)
        fresh = sync_standings_2026_27(cache, season_id=season_id)
        standings = merge_standings(previous, fresh)
    except Exception as exc:
        print(
            f'::warning::2026/27 WRD standings not verified, retained last accepted snapshot: {exc}',
            file=sys.stderr,
        )
        return False

    if previous:
        old_cmp = {k: v for k, v in previous.items() if k != 'fetched_at'}
        new_cmp = {k: v for k, v in standings.items() if k != 'fetched_at'}
        if old_cmp == new_cmp:
            return False

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(standings, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument('--delay', type=float, default=0.25)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--skip-dobs', action='store_true')
    parser.add_argument('--standings-only', action='store_true')
    args = parser.parse_args()
    if args.standings_only:
        updated = sync_standings_only(cache_dir=args.cache, out_dir=args.out, delay=args.delay)
        print('2026/27 WRD & relay standings updated:', updated)
        return
    summary = sync_all(
        cache_dir=args.cache,
        out_dir=args.out,
        delay=args.delay,
        offline=args.offline,
        skip_dobs=args.skip_dobs,
    )
    print('Junior sync complete:', summary)


if __name__ == '__main__':
    main()
