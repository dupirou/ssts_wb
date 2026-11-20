#!/usr/bin/env python3
"""Fetch and normalize ISU heat-level historical data (2022/23–2025/26) and athlete registry.

Reuses SourceCache (stored under .cache/isu/) and enforces >= 1.0s spacing between
live HTTP requests while running deterministically offline once cached.
"""

import argparse
import io
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / '.cache/pylib') not in sys.path:
    pylib = ROOT / '.cache/pylib'
    if pylib.exists():
        sys.path.insert(0, str(pylib))

from pypdf import PdfReader

import competition_data
import heats_schema as hs
import import_history_api as hist_api
import isu_results
import isu_transport
import penalty_protocol

TARGET_SEASONS = ('2022/23', '2023/24', '2024/25', '2025/26')
TARGET_KINDS = ('worldcup', 'worldtour', 'worlds', 'olympics')
API = 'https://front-api.isu.org/events/'
PDF_HOSTS = {
    'front-api.isu.org',
    'www.isu-skating.com',
    'isu-skating.com',
    'isu-d8g8b4b7ece7aphs.a03.azurefd.net',
    'isudam.blob.core.windows.net',
}

# Known official Protocol PDFs that carry C89I2 Infringement Reports with ST/S/C/F subcodes.
PROTOCOL_PDFS = {
    '1': 'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/CMS/Fansite/Short-Track/2025-2026/Events/World-STSS-Championships/Documents/Protocol-1773648916-2179.pdf',
}

# Official Protocol PDFs used to repair heats left as 'Start List' or 'Live' in ISU's front-api.
C73_PATCH_PDFS = {
    '1762': (
        'https://isudam.blob.core.windows.net/isudamcontainer/WC2425KOR-1784039688-0088.pdf',
        ['Women 1500 m - Rep. Quarterfinals'],
    ),
    '1502': (
        'https://isu-d8g8b4b7ece7aphs.a03.azurefd.net/isudamcontainer/CMS/Fansite/Short-Track/2024-2025/Events/World-STSS-Championships/Documents/Protocol-of-Results-ISU-World-Short-Track-Championships-2025-Beijing-1760795859-7587.pdf',
        ['Women 1500 m - Rep. Quarterfinals', 'Men 1000 m - Rep. Quarterfinals', 'Women 500 m - Rep. Quarterfinals'],
    ),
}


class ThrottledCache:
    """Disk-backed official source cache with sequential rate limiting and offline support."""

    def __init__(self, directory, *, delay=1.0, offline=False):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.delay = max(float(delay), 1.0) if not offline else 0.0
        self.offline = offline
        self._last_fetch = 0.0

    def _cache_path(self, url, form=None, ext=None):
        form = dict(sorted((form or {}).items()))
        key = hist_api.digest(json.dumps([url, form], sort_keys=True).encode())
        suffix = ext or ('.json' if form else '.html')
        return self.directory / (key + suffix), form

    def read(self, url, form=None, *, ext=None):
        if not isu_transport.allowed(url, PDF_HOSTS):
            raise ValueError(f'Unexpected official source host: {url}')
        path, form = self._cache_path(url, form, ext=ext)
        if path.exists():
            body = path.read_bytes()
        else:
            if self.offline:
                raise FileNotFoundError(f'Cache miss in offline mode for {url} form={form}')
            elapsed = time.monotonic() - self._last_fetch
            if self._last_fetch > 0 and elapsed < self.delay:
                time.sleep(self.delay - elapsed)
            for attempt in range(3):
                try:
                    body = isu_transport.request_bytes(url, hosts=PDF_HOSTS, max_bytes=25_000_000, form=form or None)
                    self._last_fetch = time.monotonic()
                    break
                except HTTPError as ex:
                    if ex.code not in {429, 500, 502, 503, 504} or attempt == 2:
                        raise
                    time.sleep(2 ** (attempt + 1))
                except (URLError, TimeoutError):
                    if attempt == 2:
                        raise
                    time.sleep(2 ** (attempt + 1))
            if len(body) > 25_000_000:
                raise ValueError('Official response exceeds size limit')
            path.write_bytes(body)
        return body, {'url': url, 'form': form, 'sha256': hist_api.digest(body)}

    def api(self, endpoint, **form):
        body, source = self.read(API + endpoint, form)
        obj = json.loads(body)
        if obj.get('status') != 200 or not isinstance(obj.get('data'), list):
            raise ValueError(f'Unsupported official response: {endpoint}')
        return obj['data'], source


def load_target_events(inventory_path=ROOT / 'data/history/inventory.json'):
    """Return the 27 target events from inventory.json sorted chronologically with stop indices."""
    inventory = json.loads(inventory_path.read_text(encoding='utf-8'))
    events = []
    for scope in inventory['scopes']:
        if scope['season'] in TARGET_SEASONS and scope['kind'] in TARGET_KINDS:
            for ev in scope['events']:
                events.append(dict(ev))
    # Compute chronological stop number within each (season, kind).
    by_group = {}
    for ev in events:
        by_group.setdefault((ev['season'], ev['kind']), []).append(ev)
    for (season, kind), group in by_group.items():
        group.sort(key=lambda e: (e['date_start'], int(e['official_event_id'])))
        for idx, ev in enumerate(group, 1):
            raw_city = ev['city'].split(',')[0].strip()
            city_slug = re.sub(r'[^a-z0-9]+', '-', hs.plain_text(raw_city).lower()).strip('-')
            suffix = f'-{idx}' if kind in ('worldcup', 'worldtour') else ''
            ev['event_slug'] = f'{season.replace("/", "-")}-{kind}-{city_slug}{suffix}'
            ev['stop_number'] = idx if kind in ('worldcup', 'worldtour') else None
            ev['base_city'] = raw_city
    events.sort(key=lambda e: (e['date_start'], int(e['official_event_id'])))
    return events


def parse_c89i2_infringements(pdf_bytes):
    """Extract C89I2 Infringement Report rows (individual PEN/YC/RC with ST/S/C/F subcodes)."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    rows = []
    for page_no, page in enumerate(reader.pages, 1):
        text = page.extract_text(extraction_mode='layout') or ''
        if not re.search(r'^\s*INFRINGEMENT REPORT\s*$', text, re.M):
            continue
        for line in text.splitlines():
            m = penalty_protocol.INFRINGEMENT.match(line)
            if not m:
                continue
            serial, race, gender, distance, relay, team_relay, remainder = m.groups()
            if relay or team_relay:
                continue
            parts = re.split(r'\s{2,}', remainder.strip())
            member_idx = next((i for i, v in enumerate(parts) if re.fullmatch(r'[A-Z]{3}|AIN', v) and i >= 2), None)
            if member_idx is None or member_idx + 1 >= len(parts):
                continue
            status = parts[member_idx + 1].strip().split()[0]
            if status not in ('PEN', 'YC', 'RC'):
                continue
            if member_idx + 2 >= len(parts) or not parts[member_idx + 2].strip():
                continue
            code = parts[member_idx + 2].strip()
            country = parts[member_idx]
            embedded_helmet = re.match(r'^([0-9]+)\s+(.+)', parts[1])
            helmet = int(parts[1]) if parts[1].isdigit() else (int(embedded_helmet[1]) if embedded_helmet else None)
            name = parts[2] if parts[1].isdigit() else (embedded_helmet[2] if embedded_helmet else parts[1])
            rows.append(
                {
                    'number': int(serial),
                    'race_number': int(race),
                    'gender': gender.lower(),
                    'distance_m': int(distance),
                    'round_label': parts[0],
                    'helmet_number': helmet,
                    'name': name,
                    'country': country,
                    'status': status,
                    'infringement_code': code,
                    'page': page_no,
                }
            )
    return rows


def parse_c73_pages(pdf_bytes, target_titles):
    """Parse Swiss Timing C73_ResultList pages for specific '<Event> - <Round>' sections."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    results = {}
    for pg in reader.pages:
        t = pg.extract_text(extraction_mode='layout') or ''
        if 'RESULTS' not in t:
            continue
        title = next((tgt for tgt in target_titles if tgt in t), None)
        if not title:
            continue
        note_m = re.search(r'^\s*NOTE\s*\n\s*(.+?)\s*$', t, re.M)
        note = ' '.join(note_m[1].split()) if note_m else None
        cur_heat = None
        for line in t.splitlines():
            m = re.match(
                r'^\s*(?:(\d+)\s+[A-Z]+(\d+)\s+)?(\d+|-)\s+(\d+)\s+(.+?)\s+([A-Z]{3}|AIN)\s+'
                r'((?:\d+:)?\d{1,2}\.\d{3}|No time|PEN|DNS|DNF|YC|RC)'
                r'(?:\s+(Q|q|QA|qA|QB|qB|ADV|ADVA|ADVB))?\s*$',
                line,
            )
            if not m:
                continue
            _, hnum, rnk, helm, nm, noc, res, qual = m.groups()
            if hnum:
                cur_heat = int(hnum)
            if cur_heat is None:
                continue
            bucket = results.setdefault((title, cur_heat), {'note': note, 'rows': []})
            bucket['rows'].append(
                {
                    'rank': int(rnk) if rnk.isdigit() else None,
                    'helmet_number': int(helm),
                    'name': ' '.join(nm.split()),
                    'country': noc,
                    'result': 'no time' if res == 'No time' else res,
                    'qual': qual or '',
                }
            )
    return results


def _apply_c73_patches(disciplines, c73_data):
    """Repair heats left as 'Start List' or 'Live' in ISU API using official C73 Protocol rows."""
    for disc_entry in disciplines:
        disc_name = disc_entry['meta'].get('discipline_name') or disc_entry['meta'].get('name')
        for r_entry in disc_entry['rounds']:
            rmeta = r_entry['round_meta']
            title = f'{disc_name} - {rmeta["name"]}'
            for heat in r_entry['heats']:
                if (heat.get('result_status') or '').strip() not in ('Start List', 'Live'):
                    continue
                m = re.search(r'(\d+)\s*$', heat.get('name') or '')
                if not m:
                    continue
                patch = c73_data.get((title, int(m[1])))
                if not patch:
                    continue
                if patch.get('note') and not (rmeta.get('qualification_rule') or '').strip():
                    rmeta['qualification_rule'] = patch['note']
                api_comps = heat.get('event_result_round_heats_competitors') or []
                by_bib = {isu_results.integer(c.get('bib_number')): c for c in api_comps}
                by_key = {
                    (
                        hs.normalize_name_key((c.get('skaters') or {}).get('full_name')),
                        (c.get('started_for_nf_code') or '').strip(),
                    ): c
                    for c in api_comps
                }
                patched_comps = []
                for row in patch['rows']:
                    comp = by_bib.get(row['helmet_number']) or by_key.get(
                        (hs.normalize_name_key(row['name']), row['country'])
                    )
                    if not comp:
                        raise ValueError(f'C73 patch could not match {row} in {title} Heat {m[1]}')
                    comp = dict(comp)
                    comp['final_rank'] = row['rank']
                    comp['final_result'] = row['result']
                    comp['qualification_code'] = row['qual']
                    comp['result_status'] = ''
                    patched_comps.append(comp)
                # Clear colliding starting_positions left over from pre-redraw Start List rows.
                sp_counts = {}
                for comp in patched_comps:
                    sp = comp.get('starting_position')
                    if sp is not None:
                        sp_counts[sp] = sp_counts.get(sp, 0) + 1
                for comp in patched_comps:
                    if sp_counts.get(comp.get('starting_position'), 0) > 1:
                        comp['starting_position'] = None
                heat['event_result_round_heats_competitors'] = patched_comps
                heat['result_status'] = 'Official'


def discipline_from_meta(meta):
    gender = hist_api.SEX.get(meta.get('gender'))
    distance = isu_results.integer(meta.get('discipline_distance'))
    relay = (
        meta.get('discipline_type') == 'Couples'
        or 'relay' in (meta.get('discipline_name', '') + meta.get('name', '')).lower()
    )
    if gender == 'mixed' and not distance:
        distance = 2000
    if gender not in ('women', 'men', 'mixed') or distance not in (500, 1000, 1500, 2000, 3000, 5000):
        raise ValueError(f'Unsupported discipline metadata: {meta}')
    return {'gender': gender, 'distance_m': distance, 'format': 'relay' if relay else 'individual'}


def included_individual(meta):
    low = (meta.get('name') or '').lower()
    if any(tok in low for tok in ('madison', 'overall', 'all-around', 'allround', 'super final', 'superfinal')):
        return False
    disc = discipline_from_meta(meta)
    return disc['format'] == 'individual' and disc['distance_m'] in (500, 1000, 1500)


def fetch_event_raw(cache, ev):
    """Fetch and cache the event page, rounds, and individual heat payloads for one event."""
    url = ev['source_url']
    body, page_source = cache.read(url)
    rows = isu_results.embedded_results(body)
    eid = str(ev['official_event_id'])
    from datetime import date, timedelta

    first = date.fromisoformat(ev['date_start']) - timedelta(days=2)
    last = date.fromisoformat(ev['date_end']) + timedelta(days=2)
    filtered = [
        r
        for r in rows
        if str(r.get('event_id')) == eid
        and (not r.get('start_date') or first <= date.fromisoformat(r['start_date'][:10]) <= last)
    ]
    if not filtered:
        raise ValueError(f'No matching embedded disciplines for event {eid}')

    disciplines = []
    # Group by (gender, distance_m) to resolve double-distance instance (1)/(2) deterministically.
    by_disc = {}
    for m in filtered:
        if not included_individual(m):
            continue
        d = discipline_from_meta(m)
        by_disc.setdefault((d['gender'], d['distance_m']), []).append((m, d))

    for (gender, distance_m), group in sorted(by_disc.items()):
        group.sort(
            key=lambda item: (
                item[0].get('start_date') or '',
                item[0].get('display_order') or 0,
                item[0]['event_result_id'],
            )
        )
        for fallback_inst, (meta, disc) in enumerate(group, 1):
            instance = hs.parse_distance_instance(meta.get('name'), fallback=fallback_inst)
            if ev['season'] in ('2024/25', '2025/26') and instance != 1:
                raise ValueError(f'Double-distance instance {instance} unexpected in {ev["season"]} event {eid}')
            erid = meta['event_result_id']
            rounds, round_source = cache.api('get-event-result-round', event_result_id=erid)
            round_entries = []
            for rmeta in sorted(
                rounds, key=lambda r: (r.get('date') or '', r.get('display_order') or 0, r['event_result_round_id'])
            ):
                if str(rmeta['event_result_id']) != str(erid) or str(rmeta['event_id']) != eid:
                    raise ValueError(f'Round metadata mismatch in event {eid} erid={erid}')
                heats, heat_source = cache.api(
                    'get-event-result-round-heats-stk-single',
                    event_result_id=erid,
                    event_result_round_id=rmeta['event_result_round_id'],
                    country_code='',
                )
                round_entries.append(
                    {
                        'round_meta': rmeta,
                        'round_source': round_source,
                        'heats': heats,
                        'heat_source': heat_source,
                    }
                )
            disciplines.append(
                {
                    'meta': meta,
                    'disc': disc,
                    'instance': instance,
                    'rounds': round_entries,
                }
            )

    infringements = []
    pdf_source = None
    extra_sources = []
    if eid in PROTOCOL_PDFS:
        pdf_bytes, pdf_source = cache.read(PROTOCOL_PDFS[eid], ext='.pdf')
        infringements = parse_c89i2_infringements(pdf_bytes)
    if eid in C73_PATCH_PDFS:
        c73_url, c73_titles = C73_PATCH_PDFS[eid]
        c73_bytes, c73_source = cache.read(c73_url, ext='.pdf')
        c73_data = parse_c73_pages(c73_bytes, c73_titles)
        _apply_c73_patches(disciplines, c73_data)
        extra_sources.append(c73_source)

    return {
        'event': ev,
        'page_source': page_source,
        'disciplines': disciplines,
        'infringements': infringements,
        'pdf_source': pdf_source,
        'extra_sources': extra_sources,
    }


def _clean_round_token(label):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', (label or '').lower())).strip()


def _match_infringement(infringements, gender, distance_m, round_label, country, helmet_number):
    target_round = _clean_round_token(round_label)
    matches = [
        row
        for row in infringements
        if row['gender'] == gender
        and row['distance_m'] == distance_m
        and _clean_round_token(row['round_label']) == target_round
        and row['country'] == country
        and (row['helmet_number'] is None or row['helmet_number'] == helmet_number)
    ]
    if len(matches) == 1:
        return matches[0]['infringement_code']
    return None


def build_athlete_registry(raw_events):
    """Build athletes.json and athlete_crosswalk.json across 27 historical events + 26/27 + legacy history."""
    zh_path = ROOT / 'data/athlete_names_zh.json'
    zh_map = json.loads(zh_path.read_text(encoding='utf-8')).get('names', {}) if zh_path.exists() else {}
    zh_by_key = {hs.normalize_name_key(k): v for k, v in zh_map.items()}

    # Primary store keyed by official_skater_id -> raw appearances.
    by_oid = {}

    def record_appearance(oid, name, gender, country, seen_date):
        if not isinstance(oid, int) or oid <= 0:
            raise ValueError(f'Invalid official_skater_id: {oid!r} ({name})')
        entry = by_oid.setdefault(
            oid,
            {
                'oid': oid,
                'names': [],
                'genders': set(),
                'sightings': [],
            },
        )
        clean_name = ' '.join((name or '').split())
        if clean_name and clean_name not in entry['names']:
            entry['names'].append(clean_name)
        if gender in ('men', 'women'):
            entry['genders'].add(gender)
        if country and seen_date:
            entry['sightings'].append((seen_date, country))

    # 1. Scan all 27 historical events.
    for raw in raw_events:
        ev = raw['event']
        for disc_entry in raw['disciplines']:
            gender = disc_entry['disc']['gender']
            for r_entry in disc_entry['rounds']:
                for heat in r_entry['heats']:
                    local_date = (heat.get('date') or r_entry['round_meta'].get('date') or ev['date_start'])[:10]
                    comps = heat.get('event_result_round_heats_competitors') or []
                    # Remove bookkeeping duplicates and withdrawn ghosts before registering.
                    non_ghosts = [c for c in comps if not hs.is_withdrawn_ghost(c)]
                    for comp in non_ghosts:
                        sk = comp.get('skaters') or {}
                        oid = comp.get('skaters_id')
                        name = sk.get('full_name') or ' '.join(
                            p for p in (sk.get('first_name'), sk.get('last_name')) if p
                        )
                        country = (
                            (comp.get('started_for_nf_code') or '').strip()
                            or (sk.get('organization_code') or '').strip()
                            or (sk.get('nationality_code') or '').strip()
                        )
                        sk_gender = {'F': 'women', 'W': 'women', 'M': 'men'}.get(sk.get('gender'), gender)
                        record_appearance(oid, name, sk_gender, country, local_date)

    # 2. Scan 2026/27 data/competitions/*.json (rounds + relay members).
    comp_aids = {}  # ath_id -> list of (name, country, gender, oid_or_none)
    for p in sorted((ROOT / 'data/competitions').glob('*.json')):
        snap = json.loads(p.read_text(encoding='utf-8'))
        for item in snap.get('entries', {}).get('items', []):
            aid = item.get('athlete_id')
            if aid and aid.startswith('ath-'):
                comp_aids.setdefault(aid, []).append((item['name'], item['country'], item['gender'], None))
        for item in snap.get('rankings', {}).get('items', []):
            aid = item.get('athlete_id')
            if aid and aid.startswith('ath-') and item.get('format') == 'individual':
                comp_aids.setdefault(aid, []).append((item['name'], item['country'], item['gender'], None))
        for heat in snap.get('rounds', {}).get('items', []):
            local_date = heat.get('local_date') or (heat.get('source_start') or '')[:10]
            for part in heat.get('participants', []):
                if heat.get('format') == 'individual':
                    oid = part.get('official_skater_id')
                    aid = part.get('athlete_id')
                    if oid:
                        record_appearance(oid, part['name'], heat['gender'], part['country'], local_date)
                    if aid and aid.startswith('ath-'):
                        comp_aids.setdefault(aid, []).append((part['name'], part['country'], heat['gender'], oid))
                else:
                    for mem in part.get('members', []):
                        oid = mem.get('official_skater_id')
                        aid = mem.get('athlete_id')
                        # Relay member gender might differ in mixed relay; record if already known else omit guess.
                        if oid and oid in by_oid:
                            record_appearance(
                                oid, mem['name'], next(iter(by_oid[oid]['genders'])), part['country'], local_date
                            )
                        if aid and aid.startswith('ath-'):
                            g = next(iter(by_oid[oid]['genders'])) if oid in by_oid else heat['gender']
                            comp_aids.setdefault(aid, []).append((mem['name'], part['country'], g, oid))

    # 3. Merge data/history/athletes.json (CHN skater IDs + aliases).
    hist_ath_path = ROOT / 'data/history/athletes.json'
    hist_items = json.loads(hist_ath_path.read_text(encoding='utf-8'))['items'] if hist_ath_path.exists() else []
    merge_groups = {}  # canonical_oid -> list of oids
    oid_to_canon = {}
    for hitem in hist_items:
        oids = [x for x in hitem.get('official_skater_ids', []) if isinstance(x, int) and x > 0]
        if not oids:
            continue
        canon = min(oids)
        for oid in oids:
            oid_to_canon[oid] = canon
            merge_groups.setdefault(canon, set()).add(oid)
        if canon in by_oid:
            for alias in [hitem.get('name'), *hitem.get('aliases', [])]:
                clean_a = ' '.join((alias or '').split())
                if clean_a and clean_a not in by_oid[canon]['names']:
                    by_oid[canon]['names'].append(clean_a)

    # Collapse any merged official_skater_ids into canonical entry.
    canonical_records = {}
    for oid, info in sorted(by_oid.items()):
        canon = oid_to_canon.get(oid, oid)
        rec = canonical_records.setdefault(
            canon,
            {
                'oids': set(),
                'names': [],
                'genders': set(),
                'sightings': [],
                'merge_notes': [],
            },
        )
        rec['oids'].add(oid)
        for n in info['names']:
            if n not in rec['names']:
                rec['names'].append(n)
        rec['genders'].update(info['genders'])
        rec['sightings'].extend(info['sightings'])

    for canon, rec in canonical_records.items():
        if len(rec['oids']) > 1:
            rec['merge_notes'].append(
                f'Merged official_skater_ids {sorted(rec["oids"])} from data/history/athletes.json'
            )

    athletes = []
    name_index = {}  # (name_key, country, gender) -> set of skr_ids
    name_gender_index = {}  # (name_key, gender) -> set of skr_ids

    for canon in sorted(canonical_records):
        rec = canonical_records[canon]
        if len(rec['genders']) != 1:
            raise ValueError(f'Ambiguous gender for skater {canon}: {rec["genders"]} ({rec["names"]})')
        gender = next(iter(rec['genders']))

        # Build contiguous chronological country spells.
        spells = []
        for seen_date, ctry in sorted(rec['sightings'], key=lambda x: (x[0], x[1])):
            if not spells or spells[-1]['country'] != ctry:
                spells.append({'country': ctry, 'first_seen': seen_date, 'last_seen': seen_date})
            else:
                if seen_date < spells[-1]['first_seen']:
                    spells[-1]['first_seen'] = seen_date
                if seen_date > spells[-1]['last_seen']:
                    spells[-1]['last_seen'] = seen_date

        # Choose canonical display name: prefer 'Given SURNAME' form with uppercase surname.
        display_name = next((n for n in rec['names'] if competition_data.given_first(n)), rec['names'][0])
        aliases = sorted({n for n in rec['names'] if n != display_name})

        # Resolve name_zh if any CHN spell exists.
        name_zh = None
        if any(s['country'] == 'CHN' for s in spells):
            for candidate in [display_name, *aliases]:
                nk = hs.normalize_name_key(candidate)
                if nk in zh_by_key:
                    name_zh = zh_by_key[nk]
                    break

        skr_id = f'skr-{canon}'
        item = {
            'id': skr_id,
            'official_skater_ids': sorted(rec['oids']),
            'name': display_name,
            'gender': gender,
            'countries': spells,
            'aliases': aliases,
            'name_zh': name_zh,
            'merge_notes': rec['merge_notes'],
        }
        athletes.append(item)
        all_countries = {s['country'] for s in spells}
        for n in [display_name, *aliases]:
            nk = hs.normalize_name_key(n)
            name_gender_index.setdefault((nk, gender), set()).add(skr_id)
            for ctry in all_countries:
                name_index.setdefault((nk, ctry, gender), set()).add(skr_id)

    oid_to_skr = {oid: a['id'] for a in athletes for oid in a['official_skater_ids']}

    # Build crosswalk for every ath-* ID in 2026/27 data/competitions/*.json.
    crosswalk_items = {}
    unmapped_entries = []
    for aid, occs in sorted(comp_aids.items()):
        oids = {o for _, _, _, o in occs if o is not None}
        if oids:
            skrs = {oid_to_skr[o] for o in oids}
            if len(skrs) != 1:
                raise ValueError(f'Crosswalk conflict for {aid}: {skrs}')
            crosswalk_items[aid] = {
                'athlete_id': next(iter(skrs)),
                'official_skater_id': min(oids),
                'source': 'rounds_official_skater_id',
            }
            continue
        # Match by normalized (name_key, country, gender), then fallback to (name_key, gender) if unique.
        matched = set()
        for nm, ctry, gen, _ in occs:
            nk = hs.normalize_name_key(nm)
            matched |= name_index.get((nk, ctry, gen), set())
        if not matched:
            for nm, ctry, gen, _ in occs:
                nk = hs.normalize_name_key(nm)
                cands = name_gender_index.get((nk, gen), set())
                if len(cands) == 1:
                    matched |= cands
        if len(matched) == 1:
            skr = next(iter(matched))
            ath_obj = next(a for a in athletes if a['id'] == skr)
            crosswalk_items[aid] = {
                'athlete_id': skr,
                'official_skater_id': ath_obj['official_skater_ids'][0],
                'source': 'normalized_name_country_gender',
            }
        else:
            unmapped_entries.append((aid, occs[0][0], occs[0][1], occs[0][2], sorted(matched)))

    athletes_doc = {'schema_version': hs.SCHEMA_VERSION, 'items': athletes}
    crosswalk_doc = {
        'schema_version': hs.SCHEMA_VERSION,
        'mappings': dict(sorted(crosswalk_items.items())),
        'unmapped_entries_only': [
            {'legacy_id': aid, 'name': nm, 'country': ctry, 'gender': gen, 'candidates': cands}
            for aid, nm, ctry, gen, cands in unmapped_entries
        ],
    }
    return athletes_doc, crosswalk_doc, oid_to_skr


def convert_event(raw, oid_to_skr):
    """Convert one raw fetched event into the canonical data/heats/events/<slug>.json structure."""
    ev = raw['event']
    city = ev['base_city']
    infringements = raw['infringements']
    heats_out = []
    source_docs = [raw['page_source']]
    seen_doc_keys = {(raw['page_source']['url'], json.dumps(raw['page_source']['form'], sort_keys=True))}
    if raw['pdf_source']:
        source_docs.append(raw['pdf_source'])
        seen_doc_keys.add((raw['pdf_source']['url'], json.dumps(raw['pdf_source']['form'], sort_keys=True)))
    for extra in raw.get('extra_sources', []):
        ek = (extra['url'], json.dumps(extra['form'], sort_keys=True))
        if ek not in seen_doc_keys:
            seen_doc_keys.add(ek)
            source_docs.append(extra)

    dropped_ghosts = []
    seen_heat_ids = set()

    for disc_entry in raw['disciplines']:
        gender = disc_entry['disc']['gender']
        distance_m = disc_entry['disc']['distance_m']
        instance = disc_entry['instance']
        rep_sf_qualifiers = set()
        disc_heats = []

        for r_entry in disc_entry['rounds']:
            rmeta = r_entry['round_meta']
            session_type, round_enum, base_tier = hs.parse_round_name(rmeta['name'])
            for doc in (r_entry['round_source'], r_entry['heat_source']):
                dk = (doc['url'], json.dumps(doc['form'], sort_keys=True))
                if dk not in seen_doc_keys:
                    seen_doc_keys.add(dk)
                    source_docs.append(doc)

            for heat in sorted(
                r_entry['heats'], key=lambda h: (h.get('display_order') or 0, h['event_result_round_heats_id'])
            ):
                if int(heat['event_result_id']) != int(disc_entry['meta']['event_result_id']) or int(
                    heat['event_result_round_id']
                ) != int(rmeta['event_result_round_id']):
                    raise ValueError(f'Heat event/round mismatch in {ev["event_slug"]}')

                heat_id = f'isu-heat-{heat["event_result_round_heats_id"]}'
                if heat_id in seen_heat_ids:
                    raise ValueError(f'Duplicate heat id {heat_id}')
                seen_heat_ids.add(heat_id)

                heat_number, final_group = hs.parse_heat_label(heat.get('name'), round_enum)
                round_tier = (4 if final_group == 'B' else 5) if round_enum == 'final' else base_tier

                raw_date = heat.get('date') or rmeta.get('date') or ev['date_start']
                local_date = raw_date[:10]
                start_time_utc = hs.local_wallclock_to_utc(heat.get('date') or rmeta.get('date'), city)

                raw_comps = heat.get('event_result_round_heats_competitors') or []
                # Deduplicate identical bookkeeping rows (as in isu_results.py).
                content = [{k: v for k, v in c.items() if k not in isu_results.BOOKKEEPING} for c in raw_comps]
                comps = [c for i, c in enumerate(raw_comps) if content[i] not in content[:i]]

                # Drop withdrawn/placeholder ghost rows that carry no race outcome at all.
                filtered_comps = []
                for c in comps:
                    if hs.is_withdrawn_ghost(c):
                        dropped_ghosts.append(
                            {
                                'event': ev['event_slug'],
                                'heat_id': heat_id,
                                'skaters_id': c.get('skaters_id'),
                                'name': (c.get('skaters') or {}).get('full_name'),
                                'starting_position': c.get('starting_position'),
                            }
                        )
                        continue
                    filtered_comps.append(c)

                if not filtered_comps:
                    raise ValueError(f'Empty competitor list after filtering in {heat_id}')

                # Count actual starters (non-DNS) for rel_lane denominator.
                prelim_parsed = []
                for c in filtered_comps:
                    sk = c.get('skaters') or {}
                    oid = c.get('skaters_id')
                    if oid not in oid_to_skr:
                        raise ValueError(f'Unregistered official_skater_id {oid} in {heat_id}')
                    name = sk.get('full_name') or ' '.join(p for p in (sk.get('first_name'), sk.get('last_name')) if p)
                    country = (
                        (c.get('started_for_nf_code') or '').strip()
                        or (sk.get('organization_code') or '').strip()
                        or (sk.get('nationality_code') or '').strip()
                    )
                    if not country:
                        raise ValueError(f'Missing country for skater {oid} in {heat_id}')

                    q_raw, q_type, q_target, advanced = hs.normalize_qualification(
                        c.get('qualification_code'), session_type, round_enum
                    )
                    status, time_s, penalty, is_incident, incident_type = hs.normalize_status(
                        c.get('final_result'), c.get('result_status'), q_raw
                    )
                    opening_split_s, lap_times_s = hs.extract_laps(c.get('lap'))
                    sp = isu_results.integer(c.get('starting_position'))
                    helmet = isu_results.integer(c.get('bib_number'))
                    rank = isu_results.integer(c.get('final_rank'))
                    result_str = (c.get('final_result') or '').strip()
                    if result_str == 'no time':
                        result_str = 'no time'

                    p_code = None
                    if penalty in ('PEN', 'YC', 'RC') and infringements:
                        p_code = _match_infringement(infringements, gender, distance_m, rmeta['name'], country, helmet)

                    prelim_parsed.append(
                        {
                            'athlete_id': oid_to_skr[oid],
                            'official_skater_id': oid,
                            'name': ' '.join(name.split()),
                            'country': country,
                            'helmet_number': helmet,
                            'starting_position': sp,
                            'rank': rank,
                            'result': result_str,
                            'time_s': time_s,
                            'status': status,
                            'penalty': penalty,
                            'penalty_code': p_code,
                            'is_incident': is_incident,
                            'incident_type': incident_type,
                            'qual_flag_raw': q_raw,
                            'qual_type': q_type,
                            'qual_target': q_target,
                            'advanced': advanced,
                            'opening_split_s': opening_split_s,
                            'lap_times_s': lap_times_s,
                        }
                    )

                entered_size = len(prelim_parsed)
                heat_size = sum(1 for p in prelim_parsed if p['status'] != 'DNS')
                for p in prelim_parsed:
                    sp = p['starting_position']
                    if sp is not None and p['status'] != 'DNS':
                        p['rel_lane'] = round((sp - 1) / max(heat_size - 1, 1), 6)
                    else:
                        p['rel_lane'] = None
                    p['is_repechage_qualifier'] = False
                    if session_type == 'REPECHAGE' and round_enum == 'semifinal' and p['advanced']:
                        rep_sf_qualifiers.add(p['athlete_id'])

                # Sort participants deterministically by rank (nulls last), then starting_position.
                prelim_parsed.sort(
                    key=lambda p: (
                        p['rank'] is None,
                        p['rank'] or 999,
                        p['starting_position'] is None,
                        p['starting_position'] or 999,
                        p['athlete_id'],
                    )
                )

                inst_seg = f'/dist{instance}' if instance > 1 else ''
                round_key = (
                    f'{local_date}/{session_type.lower()}/{gender}/{distance_m}{inst_seg}/'
                    f'{round_enum}/{(final_group or "-").lower()}'
                )

                disc_heats.append(
                    {
                        'id': heat_id,
                        'gender': gender,
                        'distance_m': distance_m,
                        'format': 'individual',
                        'event_distance_instance': instance,
                        'session_type': session_type,
                        'round': round_enum,
                        'final_group': final_group,
                        'round_tier': round_tier,
                        'round_key': round_key,
                        'round_label': rmeta['name'],
                        'heat_number': heat_number,
                        'heat_label': heat.get('name'),
                        'local_date': local_date,
                        'start_time_utc': start_time_utc,
                        'heat_size': heat_size,
                        'entered_size': entered_size,
                        'qualification': None,
                        'qualification_rule_raw': (rmeta.get('qualification_rule') or '').strip() or None,
                        'result_status': (heat.get('result_status') or '').strip() or None,
                        'evidence': 'official_results',
                        'source_url': (
                            f'{ev["source_url"]}&type={disc_entry["meta"]["event_result_id"]}'
                            f'&round={rmeta["event_result_round_id"]}'
                        ),
                        'source_sha256': r_entry['heat_source']['sha256'],
                        'participants': prelim_parsed,
                    }
                )

        # Tag is_repechage_qualifier on the main-draw entry round fed by Rep. Semifinals.
        entry_round = 'semifinal' if distance_m == 1500 else 'quarterfinal'
        for h in disc_heats:
            if h['session_type'] == 'MAIN' and h['round'] == entry_round:
                for p in h['participants']:
                    if p['athlete_id'] in rep_sf_qualifiers:
                        p['is_repechage_qualifier'] = True

        heats_out.extend(disc_heats)

    # Sort all heats chronologically within the event.
    session_order = {'PRELIM': 0, 'REPECHAGE': 1, 'MAIN': 2}
    heats_out.sort(
        key=lambda h: (
            h['start_time_utc'] or '',
            h['local_date'],
            session_order[h['session_type']],
            h['round_tier'],
            h['heat_number'] or 0,
            h['id'],
        )
    )

    source_docs_sorted = sorted(source_docs, key=lambda d: (d['url'], json.dumps(d['form'], sort_keys=True)))
    source_sha256 = hist_api.digest(json.dumps(source_docs_sorted, sort_keys=True, separators=(',', ':')).encode())

    partial_events = {
        '960': 'ISU front-api omits ~35% of skaters across 171 heats; official Protocol PDF STWT-2-Montreal-2025-26-1761561207-5928.pdf is vector-outlined without a text layer.',
    }

    event_doc = {
        'schema_version': hs.SCHEMA_VERSION,
        'event_id': ev['event_slug'],
        'official_event_id': str(ev['official_event_id']),
        'season': ev['season'],
        'kind': ev['kind'],
        'stop_number': ev['stop_number'],
        'title': ev['title'],
        'city': ev['base_city'],
        'date_start': ev['date_start'],
        'date_end': ev['date_end'],
        'timezone': str(hs.event_timezone(ev['base_city'])),
        'coverage': 'partial' if str(ev['official_event_id']) in partial_events else 'complete',
        'coverage_note': partial_events.get(str(ev['official_event_id'])),
        'source': {
            'url': ev['source_url'],
            'sha256': source_sha256,
            'documents': source_docs_sorted,
        },
        'heats': heats_out,
    }
    return event_doc, dropped_ghosts


def write_json_deterministic(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.cache/isu')
    parser.add_argument('--out', type=Path, default=ROOT / 'data/heats')
    parser.add_argument('--season', help='Filter to one season, e.g. 2022/23')
    parser.add_argument('--event', action='append', help='Filter to official_event_id (repeatable)')
    parser.add_argument('--delay', type=float, default=1.0, help='Minimum seconds between live requests (>= 1.0)')
    parser.add_argument('--offline', action='store_true', help='Read strictly from cache without network access')
    parser.add_argument('--fetch-only', action='store_true', help='Warm the cache without writing data/heats outputs')
    args = parser.parse_args()

    events = load_target_events()
    if args.season:
        events = [e for e in events if e['season'] == args.season]
    if args.event:
        wanted = set(args.event)
        events = [e for e in events if str(e['official_event_id']) in wanted]

    cache = ThrottledCache(args.cache, delay=args.delay, offline=args.offline)
    raw_events = []
    for idx, ev in enumerate(events, 1):
        print(
            f'[{idx}/{len(events)}] {ev["season"]} {ev["kind"]} {ev["official_event_id"]} ({ev["base_city"]})',
            flush=True,
        )
        raw_events.append(fetch_event_raw(cache, ev))

    if args.fetch_only:
        print(f'Cached {len(raw_events)} events.', flush=True)
        return 0

    if args.season or args.event:
        raise ValueError('Full athletes.json / events.json build requires running without --season/--event filters')

    athletes_doc, crosswalk_doc, oid_to_skr = build_athlete_registry(raw_events)
    write_json_deterministic(args.out / 'athletes.json', athletes_doc)
    write_json_deterministic(args.out / 'athlete_crosswalk.json', crosswalk_doc)
    print(
        f'Athletes: {len(athletes_doc["items"])}, crosswalk: {len(crosswalk_doc["mappings"])}, '
        f'entries-only unmapped: {len(crosswalk_doc["unmapped_entries_only"])}',
        flush=True,
    )

    events_index = []
    all_ghosts = []
    events_dir = args.out / 'events'
    events_dir.mkdir(parents=True, exist_ok=True)
    for raw in raw_events:
        ev_doc, ghosts = convert_event(raw, oid_to_skr)
        all_ghosts.extend(ghosts)
        out_path = events_dir / f'{ev_doc["event_id"]}.json'
        write_json_deterministic(out_path, ev_doc)
        heats = ev_doc['heats']
        starts = sum(len(h['participants']) for h in heats)
        events_index.append(
            {
                'event_id': ev_doc['event_id'],
                'official_event_id': ev_doc['official_event_id'],
                'season': ev_doc['season'],
                'kind': ev_doc['kind'],
                'stop_number': ev_doc['stop_number'],
                'title': ev_doc['title'],
                'city': ev_doc['city'],
                'date_start': ev_doc['date_start'],
                'date_end': ev_doc['date_end'],
                'timezone': ev_doc['timezone'],
                'coverage': ev_doc['coverage'],
                'coverage_note': ev_doc['coverage_note'],
                'file': f'events/{ev_doc["event_id"]}.json',
                'heat_count': len(heats),
                'start_count': starts,
                'disciplines': sorted({(h['gender'], h['distance_m'], h['event_distance_instance']) for h in heats}),
                'source_url': ev_doc['source']['url'],
                'source_sha256': ev_doc['source']['sha256'],
            }
        )

    # Convert discipline tuples to dicts for clean JSON.
    for item in events_index:
        item['disciplines'] = [
            {'gender': g, 'distance_m': d, 'event_distance_instance': inst} for g, d, inst in item['disciplines']
        ]

    events_doc = {
        'schema_version': hs.SCHEMA_VERSION,
        'event_count': len(events_index),
        'total_heats': sum(e['heat_count'] for e in events_index),
        'total_starts': sum(e['start_count'] for e in events_index),
        'dropped_ghost_rows': all_ghosts,
        'items': events_index,
    }
    write_json_deterministic(args.out / 'events.json', events_doc)
    print(
        f'Imported {events_doc["event_count"]} events, {events_doc["total_heats"]} heats, '
        f'{events_doc["total_starts"]} starts, {len(all_ghosts)} dropped ghost rows.',
        flush=True,
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
