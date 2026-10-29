#!/usr/bin/env python3
"""Build static pages and validated ISU data; never manufacture unverified competition facts."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import competition_data
import penalty_protocol
import stations
import schedule_store
import official_sources
import predict_groups
import qualification
import site_catalog
import history_data
import updates
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CHINA = ROOT / 'data/china.json'
OUT = ROOT / 'dist'
BUNDLE = 'site.js'
BUNDLES = {
    BUNDLE: ('ui.js', 'navigation.js', 'portal.js', 'app.js'),
    'results-page.js': ('results-model.js', 'results-store.js', 'results-compare.js', 'results.js'),
}
SCRIPTS = tuple(name for scripts in BUNDLES.values() for name in scripts)
SHELL_FILES = ('index.html', *BUNDLES, 'site.css', 'manifest.webmanifest')
BJ = ZoneInfo('Asia/Shanghai')
STAGES = {'Q': 'qualifying', 'R': 'repechage', 'F': 'main'}
GENDERS = {'W': 'women', 'M': 'men', 'X': 'mixed'}
ROUNDS = {'P': 'preliminaries', 'H': 'heats', 'Q': 'quarterfinal', 'S': 'semifinal', 'F': 'final'}
# Initial engineering assumptions only, not calibrated ISU data (min, max minutes / heat).
HEAT_DURATIONS = {
    ('I', 500): (2.5, 4.0),
    ('I', 1000): (3.0, 5.0),
    ('I', 1500): (4.0, 7.0),
    ('R', 2000): (6.0, 10.0),
    ('R', 3000): (7.0, 12.0),
    ('R', 5000): (8.0, 15.0),
}


def read_schedule(station_id, directory=stations.SCHEDULES):
    """A station's stored official programme as Beijing-time rows; [] until ISU publishes one."""
    station = stations.get(station_id)
    data = schedule_store.read(stations.schedule_path(station_id, directory))
    if data is None:
        return []
    schedule_store.validate(data, station)
    tz = ZoneInfo(station['timezone'])
    result = []
    for row in data:
        d, t = row['date'], row['time']
        st, sex, typ, rnd = row['session'], row['gender'], row['kind'], row['round']
        dist, group = int(row['distance']), row['group']
        naive = datetime.strptime(f'{d} {t}', '%Y-%m-%d %H:%M')
        local = naive.replace(tzinfo=tz)
        other = naive.replace(tzinfo=tz, fold=1)
        if local.utcoffset() != other.utcoffset():
            # A backward clock transition maps a local time to two different UTC instants.
            if all(
                value.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) == naive for value in (local, other)
            ):
                raise ValueError('Ambiguous daylight-saving fold in station start time: ' + d + ' ' + t)
        if local.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) != naive:
            raise ValueError("Start time does not exist in the station's timezone: " + d + ' ' + t)
        utc = local.astimezone(timezone.utc)
        bj = utc.astimezone(BJ)
        key = '/'.join((d, STAGES[st], GENDERS[sex], str(dist), ROUNDS[rnd], group))
        result.append(
            {
                'id': key.replace('/', '-'),
                'round_key': key,
                'local_date': d,
                'local_time': t,
                'local_start': local.isoformat(),
                'utc_start': utc.isoformat().replace('+00:00', 'Z'),
                'beijing_date': bj.strftime('%Y-%m-%d'),
                'beijing_time': bj.strftime('%H:%M'),
                'session': STAGES[st],
                'gender': GENDERS[sex],
                'distance_m': dist,
                'format': 'relay' if typ == 'R' else 'individual',
                'round': ROUNDS[rnd],
                'group': None if group == '-' else group,
                'status': 'scheduled',
                'china': {'status': 'unknown', 'heats': []},
            }
        )
    if len({r['round_key'] for r in result}) != len(result):
        raise ValueError('Ambiguous duplicated official round')
    return result


def valid_evidence(url):
    return official_sources.valid_evidence(url)


def attach_china(rows, station_id):
    # The human-reviewed file wins any disagreement with the automatic
    # result importer. Both files are source-validated before acceptance.
    # Both files cover every station; a round key's date says which station it belongs to.
    data = json.loads(CHINA.read_text(encoding='utf-8'))
    auto_path = ROOT / 'data/china_auto.json'
    auto = (
        json.loads(auto_path.read_text(encoding='utf-8')) if auto_path.exists() else {'schema_version': 1, 'heats': []}
    )
    for obj in (data, auto):
        if obj.get('schema_version') != 1 or not isinstance(obj.get('heats'), list):
            raise ValueError('Invalid China provenance schema')
    new_evidence, covered = competition_data.china_evidence(competition_data.display_snapshot(station_id))
    auto['heats'] = new_evidence + [item for item in auto['heats'] if item['round_key'] not in covered]
    lookup = {r['round_key']: r for r in rows}
    days = {d.isoformat() for d in stations.dates(stations.get(station_id))}
    seen = set()
    for item in data['heats'] + auto['heats']:
        if str(item.get('round_key'))[:10] not in days:
            continue
        # Explicitly reviewed overrides remain authoritative; the auto file
        # may still carry the previous official result after a correction.
        if item.get('round_key') in seen:
            continue
        key = item.get('round_key')
        if key not in lookup:
            raise ValueError('China record references unknown round_key')
        seen.add(key)
        if (
            item.get('country') != 'CHN'
            or item.get('evidence') not in ('official_start_list', 'official_round_results')
            or not valid_evidence(item.get('source_url', ''))
        ):
            raise ValueError('CHN highlight needs an official exact-round start-list URL')
        verified_at = datetime.fromisoformat(item['verified_at'].replace('Z', '+00:00'))
        if not verified_at.tzinfo:
            raise ValueError('Verification timestamp must be timezone-aware')
        heats = item.get('heats')
        if not isinstance(heats, list) or not heats:
            raise ValueError('Confirmed round needs at least one verified heat')
        seen_heat = set()
        confirmed = []
        row = lookup[key]
        typ = 'R' if row['format'] == 'relay' else 'I'
        durations = HEAT_DURATIONS.get((typ, row['distance_m']))
        if durations is None:
            print(
                f'::warning::{station_id}: no heat duration model for {typ}/{row["distance_m"]}; estimates omitted',
                file=sys.stderr,
            )
        base = datetime.fromisoformat(row['local_start'])
        for heat in heats:
            number = heat.get('number')
            athletes = heat.get('athletes')
            if type(number) is not int or not (1 <= number <= 40) or number in seen_heat:
                raise ValueError('Invalid heat index')
            if (
                not isinstance(athletes, list)
                or not athletes
                or not all(isinstance(a, str) and a.strip() for a in athletes)
            ):
                raise ValueError('Missing verified Chinese athlete or team names')
            seen_heat.add(number)
            estimate = None
            if durations is not None:
                lo, hi = durations
                a, b = base + timedelta(minutes=(number - 1) * lo), base + timedelta(minutes=(number - 1) * hi)
                estimate = {
                    'status': 'model_estimate_not_official',
                    'earliest_local': a.isoformat(),
                    'latest_local': b.isoformat(),
                    'earliest_beijing': a.astimezone(BJ).isoformat(),
                    'latest_beijing': b.astimezone(BJ).isoformat(),
                    'assumed_minutes_per_heat': [lo, hi],
                }
            confirmed.append({'number': number, 'athletes': athletes, 'estimate': estimate})
        row['china'] = {
            'status': 'confirmed',
            'heats': sorted(confirmed, key=lambda h: h['number']),
            'source_url': item['source_url'],
            'verified_at': item['verified_at'],
        }
    return rows


# Booking sites the curated ticket links may point to, with the name shown on the button.
BOOKING_SITES = {'m.ticketlink.co.kr': 'Ticketlink'}
# Curated platform domains are not interchangeable with direct event-ticket URLs.
SHANGHAI_TICKET_CHANNELS = {
    '大麦': {'m.damai.cn': 'event'},
    '久事体育': {'www.jussyun.com': 'platform'},
    '携程': {'www.ctrip.com': 'platform'},
    'MAISEAT': {'maiseat.com': 'platform'},
}
SHANGHAI_TICKET_SOURCE = 'english.shanghai.gov.cn'


def attach_qualification(rows, station_id):
    """Each round's published qualification rule ('2Q+6q' and in Chinese), once ISU lists it."""
    rules = competition_data.load_snapshot(station_id)['rounds'].get('rules', {})
    for row in rows:
        rule = qualification.describe(rules.get(row['round_key']))
        if rule and rule['code']:
            row['qualification'] = rule
    return rows


def load_ticketing():
    """Validate curated ticket links before publishing them to the calendar."""
    path = ROOT / 'data/tickets.json'
    cfg = json.loads(path.read_text(encoding='utf-8'))
    if cfg.get('schema_version') != 1 or not isinstance(cfg.get('stations'), dict):
        raise ValueError('Invalid ticket information schema')
    by_id = {st['id']: st for st in stations.load()['stations']}
    result = {}
    for station, item in cfg['stations'].items():
        if station not in by_id or not isinstance(item, dict):
            raise ValueError('Unknown ticket event')
        if 'channels' in item:
            if station != 'shanghai':
                raise ValueError('Unsupported ticket channel configuration')
            source = urlsplit(item.get('source_url', ''))
            if (
                source.scheme != 'https'
                or source.hostname != SHANGHAI_TICKET_SOURCE
                or source.username
                or source.password
            ):
                raise ValueError('Invalid Shanghai ticket announcement URL')
            channels = item['channels']
            if not isinstance(channels, list) or not 1 <= len(channels) <= len(SHANGHAI_TICKET_CHANNELS):
                raise ValueError('Invalid ticket channels')
            seen, verified = set(), []
            for channel in channels:
                if not isinstance(channel, dict):
                    raise ValueError('Invalid ticket channel')
                name = channel.get('name')
                uri = urlsplit(channel.get('url', ''))
                kind = channel.get('kind')
                if (
                    name not in SHANGHAI_TICKET_CHANNELS
                    or name in seen
                    or uri.scheme != 'https'
                    or uri.username
                    or uri.password
                    or SHANGHAI_TICKET_CHANNELS[name].get(uri.hostname) != kind
                ):
                    raise ValueError('Invalid ticket channel URL or type')
                if kind == 'event' and (uri.path != '/shows/item.html' or 'itemId=1095988161093' not in uri.query):
                    raise ValueError('Unverified Damai event URL')
                seen.add(name)
                verified.append(dict(name=name, url=channel['url'], kind=kind))
            result[station] = dict(source_url=item['source_url'], channels=verified)
            continue
        for field, hosts in (('isu_url', official_sources.ISU_OFFICIAL_HOSTS), ('booking_url', set(BOOKING_SITES))):
            u = urlsplit(item.get(field, ''))
            if u.scheme != 'https' or u.hostname not in hosts or u.username or u.password:
                raise ValueError('Invalid ticket source: ' + field)
        start = datetime.fromisoformat(item['sale_start'])
        # Ticket offices announce local time; the stored offset must be the station's own.
        if (
            start.tzinfo is None
            or start.utcoffset() != start.astimezone(ZoneInfo(by_id[station]['timezone'])).utcoffset()
        ):
            raise ValueError("Ticket opening must carry the station's local UTC offset")
        result[station] = {
            'sale_start': item['sale_start'],
            'isu_url': item['isu_url'],
            'booking_url': item['booking_url'],
            'booking_name': BOOKING_SITES[urlsplit(item['booking_url']).hostname],
        }
    return result


def season_text(text):
    """Fill the page shell's season wording from data/stations.json, so a new season edits one file."""
    config = stations.load()
    worlds = ''.join(f'及{c["date_start"][:4]}{c["city"]}世锦赛' for c in config['championships'])
    description = f'{config["season"]} ISU 短道速滑世巡赛 {len(config["stations"])} 站{worlds}赛程，北京时间、官方报名和分组信息。'
    return text.replace('{{SEASON}}', config['season']).replace('{{DESCRIPTION}}', description)


def next_event(now):
    """The stage, then championship, whose last local day has not ended yet; None after the season."""
    for event in stations.load()['stations'] + stations.load()['championships']:
        end = datetime.fromisoformat(event['date_end']).replace(tzinfo=ZoneInfo(event['timezone'])) + timedelta(days=1)
        if now < end:
            return event
    return None


def manifest_text(text, now):
    """The web manifest with its home-screen shortcut on the next event; the twice-daily build moves it on."""
    config = stations.load()
    manifest = json.loads(season_text(text))
    event = next_event(now)
    manifest['shortcuts'] = (
        [
            {
                'name': event['title'] if event in config['championships'] else event['city'] + '站赛程',
                'short_name': '世锦赛' if event in config['championships'] else event['city'],
                'url': '/events/' + config['season'].replace('/', '-') + '/' + event['id'] + '/',
                'icons': [{'src': 'icons/icon-192.png', 'sizes': '192x192'}],
            }
        ]
        if event
        else []
    )
    return json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'


def _compile(now, out, prior, source_log):
    config = stations.load()
    calendar_url = config['calendar_url']
    venues = [tuple(st[field] for field in stations.FIELDS) for st in config['stations']]
    championships = [
        dict(
            {k: v for k, v in championship.items() if k != 'isu'},
            detail_status='not_entered',
            source_url=stations.page_url(championship) or calendar_url,
        )
        for championship in config['championships']
    ]
    meta = stations.load_meta()
    errors = {}
    try:
        ticketing = load_ticketing()
    except (ValueError, KeyError, TypeError) as exc:
        # Human-maintained links must be validated by tests; a bad edit must not
        # block fresh official results for unrelated stations.
        old_calendar = prior / 'data/calendar.json'
        previous = json.loads(old_calendar.read_text(encoding='utf-8')) if old_calendar.exists() else {}
        ticketing = {
            item['id']: item['ticketing'] for item in previous.get('stations', []) if item.get('ticketing') is not None
        }
        errors['ticketing'] = {'state': 'retained', 'reason': str(exc)}
        print(f'::error::Ticket source rejected; previously published links retained: {exc}', file=sys.stderr)
    schedules = {}
    for st in config['stations']:
        station_id = st['id']
        try:
            rows = read_schedule(station_id)
            if rows:
                schedules[station_id] = attach_qualification(attach_china(rows, station_id), station_id)
            elif (prior / 'data' / (station_id + '.json')).exists():
                # Deliberately missing stored programme: stale published routes must disappear.
                errors[station_id] = {'state': 'removed', 'reason': 'Stored schedule no longer exists'}
        except (ValueError, KeyError, TypeError, OSError) as exc:
            # Only a previously published, source-backed station is eligible for fallback.
            previous_path = prior / 'data' / (station_id + '.json')
            state = 'unavailable'
            if previous_path.exists():
                previous = json.loads(previous_path.read_text(encoding='utf-8'))
                if previous.get('event_id') == station_id and isinstance(previous.get('entries'), list):
                    schedules[station_id] = previous['entries']
                    state = 'retained'
            errors[station_id] = {'state': state, 'reason': str(exc)}
            print(f'::error::{station_id}: build input rejected ({state}): {exc}', file=sys.stderr)
    season = {
        'schema_version': 1,
        'season': config['season'],
        'source_url': calendar_url,
        'stations': [
            dict(
                {k: st[k] for k in stations.FIELDS},
                ticketing=ticketing.get(st['id']),
                # The station's own ISU event page once found; the season calendar until then.
                source_url=stations.page_url(st) or calendar_url,
                detail_status='verified' if st['id'] in schedules else 'not_entered',
                predictions=predict_groups.has_open_items(st['id'], schedules.get(st['id'], [])),
            )
            for st in config['stations']
        ],
        'championships': championships,
        'notice': '各分站详细赛程在 ISU 公布后自动录入。',
    }
    (out / 'data').mkdir(parents=True, exist_ok=True)
    (out / 'data/calendar.json').write_text(json.dumps(season, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for st in config['stations']:
        rows = schedules.get(st['id'])
        if not rows:
            continue
        if st['id'] in errors:
            previous_path = prior / 'data' / (st['id'] + '.json')
            if errors[st['id']]['state'] == 'retained':
                target_path = out / 'data' / (st['id'] + '.json')
                if previous_path.resolve() != target_path.resolve():
                    shutil.copyfile(previous_path, target_path)
            continue
        sync = meta.get(st['id'], {})
        days = {}
        for r in rows:
            days[r['local_date']] = days.get(r['local_date'], 0) + 1
        schedule = {
            'schema_version': 1,
            'event_id': st['id'],
            'source_url': sync.get('source_url') or stations.page_url(st, 'schedule'),
            'source_timezone': st['timezone'],
            'status': 'provisional',
            'source_checked_at': (sync.get('last_successful_schedule_check_utc') or '')[:10] or None,
            'sync': sync,
            'notice': 'ISU暂定轮次时间；中国队单组时间仅是非官方模型估算。',
            'day_counts': days,
            'total_items': len(rows),
            'entries': rows,
        }
        (out / 'data' / (st['id'] + '.json')).write_text(
            json.dumps(schedule, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
        )
    (out / 'index.html').write_text(
        season_text((ROOT / 'web/index.html').read_text(encoding='utf-8')), encoding='utf-8'
    )
    (out / 'manifest.webmanifest').write_text(
        manifest_text((ROOT / 'web/manifest.webmanifest').read_text(encoding='utf-8'), now), encoding='utf-8'
    )
    for filename in SCRIPTS:
        shutil.copyfile(ROOT / 'web' / filename, out / filename)
    # Plain concatenation keeps source modules testable without extra browser round trips or a bundler dependency.
    for bundle, scripts in BUNDLES.items():
        (out / bundle).write_text(
            ';\n'.join((ROOT / 'web' / name).read_text(encoding='utf-8') for name in scripts), encoding='utf-8'
        )
    shutil.copyfile(ROOT / 'web/site.css', out / 'site.css')
    shutil.copyfile(ROOT / 'web/_headers', out / '_headers')
    shutil.copytree(ROOT / 'web/icons', out / 'icons', dirs_exist_ok=True)
    # The service worker cache name follows the published shell, so a new release replaces the old cache.
    shell = b''.join((out / name).read_bytes() for name in SHELL_FILES) + (ROOT / 'web/sw.js').read_bytes()
    (out / 'sw.js').write_text(
        (ROOT / 'web/sw.js')
        .read_text(encoding='utf-8')
        .replace('__BUILD_VERSION__', hashlib.sha256(shell).hexdigest()[:12]),
        encoding='utf-8',
    )
    competition_data.export(out, venues, predict_groups.entered_distances, config['season'])
    penalty_protocol.export(out, config)
    predict_groups.export(out, venues, schedules)
    site_catalog.export(out, season, schedules)
    history_data.export(out, calendar=season)
    try:
        subprocess.run(
            ['node', str(ROOT / 'tools/build_results.mjs'), str(out), config['season']],
            check=True,
            cwd=ROOT,
            timeout=120,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('Node results compiler timed out after 120 seconds') from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f'Node results compiler failed: {(exc.stderr or "").strip()[-1000:]}') from exc
    # Real index files make deep links work on Workers Assets and a plain static server alike.
    results_index = json.loads((out / 'data/results/index.json').read_text(encoding='utf-8'))
    page_paths = (
        [
            'events',
            'results',
            'results/events',
            'results/seasons',
            'results/cycles',
            'results/compare',
            'history',
            'athletes',
        ]
        + ['results/events/' + event['id'] for event in results_index['events']]
        + [
            'results/seasons/' + result_season.replace('/', '-')
            for result_season in sorted({s for cycle in results_index['cycles'] for s in cycle['seasons']})
            if result_season <= config['season']
        ]
        + ['results/cycles/' + cycle['id'] for cycle in results_index['cycles']]
        + [
            'events/' + config['season'].replace('/', '-') + '/' + event['id']
            for event in config['stations'] + config['championships']
        ]
    )
    for page_path in page_paths:
        page_dir = out / page_path
        page_dir.mkdir(parents=True, exist_ok=True)
        page_html = (out / 'index.html').read_text(encoding='utf-8')
        if page_path == 'history' or page_path == 'results' or page_path.startswith('results/'):
            # Discover the route bundle with the shell, without loading it on other pages.
            page_html = page_html.replace(
                '<script defer src="/site.js"></script>',
                '<link rel="preload" href="/results-page.js" as="script">\n<script defer src="/site.js"></script>',
            )
        (page_dir / 'index.html').write_text(page_html, encoding='utf-8')
    feed = updates.export(
        out,
        venues,
        schedules,
        {k: v.get('last_successful_schedule_check_utc') for k, v in meta.items()},
        path=source_log,
    )
    for station_id, rows in schedules.items():
        print(
            'Validated and built',
            station_id,
            len(rows),
            'ISU round start times; verified CHN:',
            sum(r['china']['status'] == 'confirmed' for r in rows),
        )
    (out / 'data/build_report.json').write_text(
        json.dumps({'schema_version': 1, 'errors': errors}, ensure_ascii=False, sort_keys=True, indent=2) + '\n',
        encoding='utf-8',
    )
    print('Update notices:', len(feed['events']))


def export(now=None, out=OUT):
    """Generate into a sibling staging directory, then publish only a complete build.

    Existing station snapshots are used only for explicit validated fallback.
    The update history and public assets are promoted only after compilation succeeds.
    """
    import updates

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    now = now or stations.utc_now()
    with tempfile.TemporaryDirectory(prefix='.ssts-build-', dir=out.parent) as temp:
        work = Path(temp)
        staged = work / 'new_dist'
        staged.mkdir()
        staged_log = work / 'updates.json'
        if updates.LOG.exists():
            shutil.copyfile(updates.LOG, staged_log)
        _compile(now, staged, out, staged_log)

        backup = work / 'old_dist'
        replaced = out.exists()
        if replaced:
            os.replace(out, backup)
        try:
            os.replace(staged, out)
            # The public output may be on /tmp while the tracked log is on a different
            # volume. Copy to a temporary file next to the destination before replace.
            with tempfile.NamedTemporaryFile(prefix='.ssts-updates-', dir=updates.LOG.parent, delete=False) as temp_log:
                prepared_log = Path(temp_log.name)
            try:
                shutil.copyfile(staged_log, prepared_log)
                os.replace(prepared_log, updates.LOG)
            finally:
                prepared_log.unlink(missing_ok=True)
        except Exception:
            if out.exists():
                shutil.rmtree(out)
            if replaced:
                os.replace(backup, out)
            raise


if __name__ == '__main__':
    export()
