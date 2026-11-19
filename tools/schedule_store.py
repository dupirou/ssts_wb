"""Read and validate stored, source-backed ISU programme CSV without any network code."""

import csv
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

import stations

FIELDS = ['date', 'time', 'session', 'gender', 'distance', 'kind', 'round', 'group']
IDENTITY = ('date', 'session', 'gender', 'distance', 'kind', 'round', 'group')
DISTANCES = {('I', 500), ('I', 1000), ('I', 1500), ('R', 2000), ('R', 3000), ('R', 5000)}
# Every World Tour stage races these nine; a programme missing one's Final A is partial.
REQUIRED = {
    ('W', '500', 'I'),
    ('M', '500', 'I'),
    ('W', '1000', 'I'),
    ('M', '1000', 'I'),
    ('W', '1500', 'I'),
    ('M', '1500', 'I'),
    ('W', '3000', 'R'),
    ('M', '5000', 'R'),
    ('X', '2000', 'R'),
}


def validate(rows, station):
    """Shared by sync and build: a stored programme is always a complete, ordered one."""
    allowed = {d.isoformat() for d in stations.dates(station)}
    seen = set()
    finals = set()
    previous = None
    for n, r in enumerate(rows, 1):
        if r['date'] not in allowed or not re.fullmatch(r'[0-2]\d:[0-5]\d', r['time']):
            raise ValueError("Programme row outside the station's dates on row " + str(n))
        if (
            r['session'] not in ('Q', 'R', 'F')
            or r['gender'] not in ('W', 'M', 'X')
            or r['kind'] not in ('I', 'R')
            or r['round'] not in ('P', 'H', 'Q', 'S', 'F')
            or not r['distance'].isdigit()
        ):
            raise ValueError('Invalid event fields on row ' + str(n))
        if (r['kind'], int(r['distance'])) not in DISTANCES or (
            r['gender'] == 'X' and (r['kind'], r['distance']) != ('R', '2000')
        ):
            raise ValueError('Invalid distance/format on row ' + str(n))
        if r['group'] not in (('A', 'B', '-') if r['round'] == 'F' else ('-',)):
            raise ValueError('Invalid final group on row ' + str(n))
        ident = tuple(r[k] for k in IDENTITY)
        if ident in seen:
            raise ValueError('Ambiguous duplicated official round on row ' + str(n))
        seen.add(ident)
        current = r['date'] + ' ' + r['time']
        if previous and current < previous:
            raise ValueError('Non-chronological official programme')
        previous = current
        if r['round'] == 'F' and r['group'] in ('A', '-'):
            finals.add((r['gender'], r['distance'], r['kind']))
    missing = REQUIRED - finals
    if missing:
        raise ValueError(
            'Partial or changed ISU timetable: no Final A for ' + ', '.join('/'.join(m) for m in sorted(missing))
        )
    return rows


def read(path):
    if not Path(path).exists():
        return None
    with Path(path).open(encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


BJ = ZoneInfo('Asia/Shanghai')
STAGES = {'Q': 'qualifying', 'R': 'repechage', 'F': 'main'}
GENDERS = {'W': 'women', 'M': 'men', 'X': 'mixed'}
ROUNDS = {'P': 'preliminaries', 'H': 'heats', 'Q': 'quarterfinal', 'S': 'semifinal', 'F': 'final'}


def read_schedule(station_id, directory=stations.SCHEDULES):
    """A station's stored official programme as Beijing-time rows; [] until ISU publishes one."""
    station = stations.get(station_id)
    data = read(stations.schedule_path(station_id, directory))
    if data is None:
        return []
    validate(data, station)
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
