"""Read and validate stored, source-backed ISU programme CSV without any network code."""

import csv
import re
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
        if (r['round'] == 'F') != (r['group'] in ('A', 'B')) or (r['round'] != 'F' and r['group'] != '-'):
            raise ValueError('Invalid final group on row ' + str(n))
        ident = tuple(r[k] for k in IDENTITY)
        if ident in seen:
            raise ValueError('Ambiguous duplicated official round on row ' + str(n))
        seen.add(ident)
        current = r['date'] + ' ' + r['time']
        if previous and current < previous:
            raise ValueError('Non-chronological official programme')
        previous = current
        if r['round'] == 'F' and r['group'] == 'A':
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


