"""The season's stations, where each one's official ISU pages live, and its stored programme.

data/stations.json is the only per-station configuration. A station's detailed programme
appears as data/schedules/<id>.csv once ISU publishes it and the schedule sync accepts it;
until then the station shows dates and a countdown only.
"""
import json
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'data/stations.json'
SCHEDULES = ROOT / 'data/schedules'
META = ROOT / 'data/sync_meta.json'
OVERRIDES = ROOT / 'data/competition_sources.json'
EVENT_PAGE = 'https://www.isu-skating.com/en/short-track/events/eventdetail/'
FIELDS = ('id', 'city', 'city_en', 'country', 'date_start', 'date_end', 'timezone', 'venue')


def load(path=CONFIG):
    config = json.loads(path.read_text(encoding='utf-8'))
    if config.get('schema_version') != 1:
        raise ValueError('Unsupported station configuration')
    ids = [s['id'] for s in config['stations'] + config['championships']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate station id')
    for station in config['stations'] + config['championships']:
        if not re.fullmatch(r'[a-z][a-z0-9-]*', station['id']) or not re.fullmatch(r'[A-Z]{3}', station['country']):
            raise ValueError('Invalid station identity: ' + station['id'])
        start, end = dates(station)[0], dates(station)[-1]
        if not start <= end <= start + timedelta(days=6):
            raise ValueError('Invalid station dates: ' + station['id'])
        ZoneInfo(station['timezone'])
        isu = station.get('isu')
        if isu is not None and (not re.fullmatch(r'[a-z0-9-]+', isu.get('slug', '')) or type(isu.get('event_id')) is not int):
            raise ValueError('Invalid ISU reference: ' + station['id'])
    return config


def stations(path=CONFIG):
    return load(path)['stations']


def get(station_id, path=CONFIG):
    found = [s for s in stations(path) if s['id'] == station_id]
    if not found:
        raise KeyError('Unknown station: ' + station_id)
    return found[0]


def venues(path=CONFIG):
    """Tuples in the historical VENUES layout, for modules that only need id/city."""
    return [tuple(s[k] for k in FIELDS) for s in stations(path)]


def dates(station):
    first, last = date.fromisoformat(station['date_start']), date.fromisoformat(station['date_end'])
    return [first + timedelta(days=n) for n in range((last - first).days + 1)]


def local_start(station):
    return datetime.fromisoformat(station['date_start']).replace(tzinfo=ZoneInfo(station['timezone']))


def within(station, now, before_days, after_days=None):
    """Whether `now` lies between `before_days` before the first local day and `after_days` after
    the last; without `after_days` the window stays open once it has begun."""
    tz = ZoneInfo(station['timezone'])
    first = datetime.fromisoformat(station['date_start']).replace(tzinfo=tz)
    last = datetime.fromisoformat(station['date_end']).replace(tzinfo=tz) + timedelta(days=1)
    return first - timedelta(days=before_days) <= now and (after_days is None or now < last + timedelta(days=after_days))


def page_url(station, tab=None):
    isu = station.get('isu')
    if not isu:
        return None
    url = EVENT_PAGE + isu['slug'] + '/'
    return url + f'?tab={tab}_{isu["event_id"]}' if tab else url


def plain(text):
    """Case- and accent-insensitive form, so 'Montréal' and 'Montreal' compare equal."""
    return ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c)).casefold()


def sources(station):
    """Official source configuration for the competition syncs; manual overrides win."""
    config = dict(city=station['city_en'], year=int(station['date_start'][:4]), documents=[])
    if station.get('isu'):
        config.update(documents_url=page_url(station, 'documents'), results_url=page_url(station, 'results'),
                      isu_event_id=station['isu']['event_id'])
    if OVERRIDES.exists():
        overrides = json.loads(OVERRIDES.read_text(encoding='utf-8'))
        if overrides.get('schema_version') != 1:
            raise ValueError('Unsupported source configuration')
        config.update(overrides['events'].get(station['id'], {}))
    return config


def schedule_path(station_id, directory=SCHEDULES):
    return directory / f'{station_id}.csv'


def has_schedule(station_id, directory=SCHEDULES):
    return schedule_path(station_id, directory).exists()


def load_meta(path=META):
    if not path.exists():
        return {}
    meta = json.loads(path.read_text(encoding='utf-8'))
    if meta.get('schema_version') != 2 or not isinstance(meta.get('stations'), dict):
        raise ValueError('Unsupported schedule sync metadata')
    return meta['stations']


def save_meta(by_station, path=META):
    content = json.dumps(dict(schema_version=2, stations=dict(sorted(by_station.items()))), ensure_ascii=False, indent=2) + '\n'
    if not path.exists() or path.read_text(encoding='utf-8') != content:
        path.write_text(content, encoding='utf-8')


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0)
