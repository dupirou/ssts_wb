"""Validated ISU World Tour penalty tables from an official event Protocol.

C98P is the authority for season counts. C89I2 supplies referee decisions.
Do not infer a season sanction from a generic PEN in the live results API.
"""

import hashlib
import io
import re

from pypdf import PdfReader

import competition_data

STATUSES = {'PEN', 'YC', 'RC'}
MAX_PDF_BYTES = 20_000_000
ROW = re.compile(r'^\s*(\d+)\s{2,}(.+?)\s{2,}([A-Z]{3})\s+((?:\d+|-)(?:\s+(?:\d+|-)){7})\s*$')
INFRINGEMENT = re.compile(
    r'^\s*(\d+)\s+(\d+)\s+(Women|Men|Mixed)\s+(\d+)\s*m(\s+Relay)?\s{2,}(.+)$',
    re.I,
)


def clean(value):
    return ' '.join(re.findall(r'\w+', value.casefold()))


def parse_pages(pages, config, source_url, sha256=''):
    """Parse an entire Protocol, rejecting incomplete or conflicting summary tables."""
    text = '\n'.join(pages)
    if config['city'].casefold() not in text.casefold() or str(config['year']) not in text:
        raise ValueError('Protocol city/year does not match station')
    totals = [(i + 1, page) for i, page in enumerate(pages) if re.search(r'^\s*WORLD TOUR PENALTIES\s*$', page, re.M)]
    violations = [(i + 1, page) for i, page in enumerate(pages) if re.search(r'^\s*INFRINGEMENT REPORT\s*$', page, re.M)]
    if len(totals) != 2 or not violations:
        raise ValueError('Missing or incomplete World Tour penalties or infringement tables')
    completed = set()
    records = {}
    for page_number, page in totals:
        progress = re.search(r'After\s+(\d+)\s+of\s+7\s+World Tour Events', page, re.I)
        gender = re.search(r'^\s*(Women|Men)\s*$', page, re.M)
        if not progress or not gender:
            raise ValueError('Missing season penalty gender or progress')
        completed.add(int(progress.group(1)))
        sex = gender.group(1).lower()
        found = 0
        for line in page.splitlines():
            match = ROW.match(line)
            if not match:
                continue
            helmet, name, country, values = match.groups()
            amounts = values.split()
            station_counts = [int(v) if v != '-' else 0 for v in amounts[:7]]
            total = int(amounts[7])
            if total != sum(station_counts):
                raise ValueError('Official season penalty count inconsistent with station columns')
            ident = competition_data.athlete_id(name, country, sex)
            if ident in records:
                raise ValueError('Duplicate official season penalty identity')
            records[ident] = dict(athlete_id=ident, name=name, country=country, gender=sex,
                                  helmet_number=int(helmet), station_counts=station_counts, total=total)
            found += 1
        if not found:
            raise ValueError(f'Empty official season penalties table on page {page_number}')
    if len(completed) != 1:
        raise ValueError('Season penalties pages disagree about completed events')
    after = completed.pop()
    if not 1 <= after <= 7:
        raise ValueError('Unsupported season penalty progress')
    if any(any(v for v in row['station_counts'][after:]) for row in records.values()):
        raise ValueError('Future stations must not contain penalty counts')
    notes = re.findall(r'This report does not include the following penalties:\s*([^\n]+)', '\n'.join(p for _, p in totals), re.I)
    if not notes:
        raise ValueError('Official exclusion note is missing')
    excluded = sorted(set(re.findall(r'\b[A-Z]+\d*\b', notes[-1].upper())))
    infringements = []
    summary_counts = set()
    for page_number, page in violations:
        match = re.search(r'Summary:\s+PEN:\s*(\d+)', page)
        if match:
            summary_counts.add(int(match.group(1)))
        for line in page.splitlines():
            found = INFRINGEMENT.match(line)
            if not found:
                continue
            serial, race, gender, distance, relay, remainder = found.groups()
            parts = re.split(r'\s{2,}', remainder.strip())
            member = next((i for i, value in enumerate(parts) if re.fullmatch(r'[A-Z]{3}', value) and i >= 2), None)
            if member is None or member + 1 >= len(parts):
                continue
            status = parts[member + 1].strip().split()[0]
            if status not in STATUSES:
                continue
            if member + 2 >= len(parts) or not parts[member + 2].strip():
                raise ValueError('Sanction without an official referee decision')
            code = parts[member + 2].strip()
            country = parts[member]
            helmet = int(parts[1]) if len(parts) > 2 and parts[1].isdigit() else None
            name = parts[2] if helmet is not None else parts[1]
            sex = gender.lower()
            ident = (('team-' + country + '-' + sex) if relay else
                     competition_data.athlete_id(name, country, sex))
            infringements.append(dict(
                number=int(serial), race_number=int(race), athlete_id=ident,
                name=name, country=country, gender=sex, distance_m=int(distance),
                format='relay' if relay else 'individual', round_label=parts[0],
                helmet_number=helmet, status=status, infringement_code=code,
                page=page_number,
            ))
    if not infringements or len({(p['race_number'], p['athlete_id']) for p in infringements}) != len(infringements):
        raise ValueError('Incomplete or duplicate official infringement lines')
    if summary_counts and len(summary_counts) != 1:
        raise ValueError('Infringement report summary pages disagree')
    observed_pen = sum(p['status'] == 'PEN' for p in infringements)
    if summary_counts and observed_pen != next(iter(summary_counts)):
        raise ValueError('Infringement report PEN rows disagree with official summary')
    counted = {}
    for row in infringements:
        if row['format'] == 'relay' or row['infringement_code'] in excluded:
            continue
        counted[row['athlete_id']] = counted.get(row['athlete_id'], 0) + 1
    current = {ident: row['station_counts'][after - 1] for ident, row in records.items()
               if row['station_counts'][after - 1]}
    if counted != current:
        raise ValueError('Eligible infringement rows disagree with official station penalty totals')
    return dict(schema_version=1, source_url=source_url, source_sha256=sha256,
                completed_events=after, excluded_codes=excluded,
                official=[records[k] for k in sorted(records)],
                infringements=sorted(infringements, key=lambda x: x['number']),
                pages={'penalties': [i for i, _ in totals], 'infringements': [i for i, _ in violations]})


def parse_pdf(body, config, source_url):
    if len(body) > MAX_PDF_BYTES or not body.startswith(b'%PDF-'):
        raise ValueError('Invalid or oversized official Protocol')
    reader = PdfReader(io.BytesIO(body))
    if len(reader.pages) > 250:
        raise ValueError('Official Protocol exceeds page limit')
    pages = [page.extract_text(extraction_mode='layout') or '' for page in reader.pages]
    return parse_pages(pages, config, source_url, hashlib.sha256(body).hexdigest())


def attach_codes(snapshot, report):
    """Return a verified copy with referee codes linked to official result rows."""
    import copy

    updated = copy.deepcopy(snapshot)
    official_heats = [heat for heat in updated['rounds']['items']
                      if heat.get('evidence') == 'official_results'
                      and (heat.get('result_status') or '').lower() == 'official']
    for row in report['infringements']:
        candidates = []
        for heat in official_heats:
            if (heat['gender'] != row['gender'] or heat['distance_m'] != row['distance_m']
                    or heat['format'] != row['format']):
                continue
            label = (heat.get('round_label') or heat.get('round') or '').replace('-', ' ')
            if clean(label) != clean(row['round_label']):
                continue
            for person in heat['participants']:
                penalty = person.get('penalty')
                if (person['athlete_id'] == row['athlete_id'] and penalty
                        and penalty['code'] == row['status']
                        and (row['helmet_number'] is None
                             or person.get('helmet_number') == row['helmet_number'])):
                    candidates.append(person)
        if len(candidates) != 1:
            raise ValueError('Cannot match official infringement uniquely: '
                             + str((row['race_number'], row['country'], row['name'])))
        current = candidates[0]['penalty'].get('infringement_code')
        if current not in (None, row['infringement_code']):
            raise ValueError('Conflicting referee decision for existing heat')
        candidates[0]['penalty']['infringement_code'] = row['infringement_code']
    return updated
