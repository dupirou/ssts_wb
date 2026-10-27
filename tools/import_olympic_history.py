#!/usr/bin/env python3
"""Read IOC C74 classifications using PDF word coordinates, not inferred ranks.

Poppler's plain layout compresses some IOC column headers. Bbox coordinates
keep FA/FB and participation X columns aligned across font sizes.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

import history_data
import competition_data

ROUND_CODES = {'P', 'H', 'QF', 'SF', 'FB', 'FA'}


def parse_bbox(xml, expected):
    document = ET.fromstring(xml)
    records = {}
    covered = set()
    programme = []
    for page_no, page in enumerate(document.findall('.//{*}page'), 1):
        words = [
            dict(
                text=''.join(w.itertext()),
                x=float(w.attrib['xMin']),
                right=float(w.attrib['xMax']),
                y=float(w.attrib['yMin']),
                bottom=float(w.attrib['yMax']),
            )
            for w in page.findall('.//{*}word')
        ]
        text = ' '.join(w['text'] for w in words)
        code = re.search(r'\bSTK([WMX])([A-Z0-9]+)-+_74[AB]', text)
        if not code:
            continue
        gender = {'W': 'women', 'M': 'men', 'X': 'mixed'}[code[1]]
        relay = 'RY' in code[2] or gender == 'mixed'
        distance = re.match(r'\d+', code[2])
        distance = int(distance[0]) if distance else 2000
        disc = dict(gender=gender, distance_m=distance, format='relay' if relay else 'individual')
        key = (gender, distance, disc['format'])
        covered.add(key)
        if disc not in programme:
            programme.append(disc)
        rank_header = next((w for w in words if w['text'] == 'Rank' and 100 < w['y'] < 300), None)
        if not rank_header:
            continue
        name_header = next(
            w for w in words if w['text'] == ('Team' if relay else 'Name') and abs(w['y'] - rank_header['y']) < 3
        )
        round_columns = sorted(
            [
                w
                for w in words
                if w['text'] in ROUND_CODES
                and rank_header['y'] - 10 < w['y'] < rank_header['y'] + 22
                and w['x'] > name_header['right']
            ],
            key=lambda w: w['x'],
        )
        if not any(w['text'] == 'FA' for w in round_columns):
            raise ValueError('Missing physical FA column')
        centers = {w['text']: (w['x'] + w['right']) / 2 for w in round_columns}
        first_round = min(centers.values()) - 10
        top = max(w['bottom'] for w in round_columns)
        legend = min(
            (w['y'] for w in words if w['text'] in {'Legend:', 'Legend'} and w['y'] > top),
            default=float(page.attrib['height']) - 40,
        )
        lines = []
        for word in sorted(words, key=lambda w: (w['y'], w['x'])):
            if not top < word['y'] < legend:
                continue
            if lines and abs(lines[-1][0] - word['y']) < 2:
                lines[-1][1].append(word)
            else:
                lines.append([word['y'], [word]])

        def cells(row):
            return {
                code: ' '.join(w['text'] for w in row if abs((w['x'] + w['right']) / 2 - x) < 10)
                for code, x in centers.items()
            }

        current = None
        for _, row in lines:
            row.sort(key=lambda w: w['x'])
            values = cells(row)
            if relay:
                country = next(
                    (
                        w
                        for i, w in enumerate(row[:-1])
                        if re.fullmatch(r'[A-Z]{3}', w['text']) and row[i + 1]['text'] == '-'
                    ),
                    None,
                )
                if country:
                    current = None
                    if country['text'] != 'CHN':
                        continue
                    prefix = [
                        w['text'] for w in row if rank_header['x'] - 3 < w['x'] < country['x'] and w['text'].isdigit()
                    ]
                    if len(prefix) > 1:
                        raise ValueError('Ambiguous relay rank')
                    groups = [c[-1] for c in ['FA', 'FB'] if values.get(c)]
                    if len(groups) > 1:
                        raise ValueError('Relay classified in both finals')
                    right = [w['text'] for w in row if w['x'] >= first_round]
                    times = [t for t in right if re.fullmatch(r'(?:\d+:)?\d{1,2}\.\d{3}', t)]
                    current = dict(
                        **disc,
                        name='China',
                        country='CHN',
                        rank=int(prefix[0]) if prefix else None,
                        final_group=groups[0] if groups else None,
                        status=history_data.terminal_status(right),
                        best_time=times[-1] if times else None,
                        source_page=page_no,
                        members=[],
                    )
                    history_data.save_record(records, current)
                elif current:
                    left = [w for w in row if name_header['x'] - 2 <= w['x'] < first_round]
                    if not left or not left[0]['text'].isdigit():
                        continue
                    tokens = [w['text'] for w in left[1:]]
                    sex = next((t for t in tokens if t in {'Male', 'Female'}), None)
                    if sex:
                        tokens = tokens[: tokens.index(sex)]
                    rounds = [c for c, v in values.items() if v == 'X']
                    if not rounds:
                        continue
                    name = ' '.join(tokens)
                    if not name:
                        raise ValueError('Missing relay member name')
                    member_gender = {'Male': 'men', 'Female': 'women'}.get(sex, gender)
                    if member_gender == 'mixed':
                        raise ValueError('Mixed relay member lacks explicit gender')
                    current['members'].append(dict(name=name, gender=member_gender, rounds=rounds))
            else:
                country = next(
                    (w for w in row if w['text'] == 'CHN' and name_header['right'] < w['x'] < first_round), None
                )
                if not country:
                    continue
                prefix = [
                    w['text']
                    for w in row
                    if rank_header['x'] - 3 <= w['x'] < name_header['x'] - 1 and w['text'].isdigit()
                ]
                if len(prefix) not in {1, 2}:
                    raise ValueError('Ambiguous individual rank and helmet')
                name = ' '.join(w['text'] for w in row if name_header['x'] - 1 <= w['x'] < country['x'])
                groups = [c[-1] for c in ['FA', 'FB'] if values.get(c)]
                if len(groups) > 1:
                    raise ValueError('Skater classified in both finals')
                right = [w['text'] for w in row if w['x'] > country['right']]
                times = [t for t in right if re.fullmatch(r'(?:\d+:)?\d{1,2}\.\d{3}', t)]
                history_data.save_record(
                    records,
                    dict(
                        **disc,
                        name=name,
                        country='CHN',
                        rank=int(prefix[0]) if len(prefix) == 2 else None,
                        final_group=groups[0] if groups else None,
                        status=history_data.terminal_status(right),
                        best_time=times[-1] if times else None,
                        source_page=page_no,
                    ),
                )
    if len(covered) != expected:
        raise ValueError('Incomplete IOC programme: ' + str(len(covered)))
    for row in records.values():
        if row['format'] == 'relay' and row['final_group']:
            count = sum('F' + row['final_group'] in m['rounds'] for m in row['members'])
            if count != 4:
                raise ValueError('Incomplete actual Olympic relay final lineup: ' + str((row['gender'], count)))
    return list(records.values()), programme, len(document.findall('.//{*}page'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('year', type=int, choices=[2018, 2022])
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--import-records', action='store_true')
    args = parser.parse_args()
    xml = subprocess.check_output(['pdftotext', '-bbox-layout', str(args.pdf), '-'])
    rows, programme, pages = parse_bbox(xml, 8 if args.year == 2018 else 9)
    result = dict(
        year=args.year,
        results=rows,
        programme=programme,
        pages=pages,
        sha256=hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
    )
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if args.import_records:
        urls = {
            2018: 'https://library.olympics.com/Default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=173359&parentDocumentId=173345',
            2022: 'https://library.olympics.com/default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=1568649&parentDocumentId=1568639',
        }
        details = {
            2018: ('2017/18', 'pyeongchang', '平昌', '5869', '2018-02-10', '2018-02-22'),
            2022: ('2021/22', 'beijing', '北京', '4134', '2022-02-05', '2022-02-16'),
        }
        season, slug, city, official_id, start, end = details[args.year]
        ident = season.replace('/', '-') + '-olympics-' + slug
        directory = history_data.DIRECTORY
        catalog = json.loads((directory / 'catalog.json').read_text())
        registry = json.loads((directory / 'athletes.json').read_text())
        old = next((e for e in catalog['events'] if e['id'] == ident), None)
        if old and old['source_sha256'] != result['sha256']:
            raise ValueError('IOC PDF differs from registered source')
        aliases = {
            history_data.identity_key(n, p['gender']): p for p in registry['items'] for n in [p['name'], *p['aliases']]
        }
        for row in rows:
            entries = [row] if row['format'] == 'individual' else row['members']
            for member in entries:
                gender = member['gender']
                name = member['name']
                key = history_data.identity_key(name, gender)
                if key not in aliases:
                    person = dict(
                        id='pdf-' + key.removeprefix('ath-'),
                        name=competition_data.surname_last(name) or name,
                        gender=gender,
                        aliases=[name],
                        identity_sources=[dict(competition_id=ident, url=urls[args.year], page=row['source_page'])],
                    )
                    registry['items'].append(person)
                    aliases[key] = person
        history_data.attach_identities(rows, registry)
        meta = dict(
            id=ident,
            season=season,
            kind='olympics',
            title=city + '冬奥会',
            city=city,
            date_start=start,
            date_end=end,
            official_event_id=official_id,
            source_url=urls[args.year],
            source_sha256=result['sha256'],
            coverage='complete',
            source_kind='pdf',
            expected_disciplines=len(programme),
        )
        event = dict(
            schema_version=1,
            competition_id=ident,
            country='CHN',
            results=rows,
            programme=programme,
            source=dict(url=meta['source_url'], sha256=result['sha256'], pages=pages),
        )
        history_data.validate_event(event, meta, registry)
        if old:
            catalog['events'][catalog['events'].index(old)] = meta
        else:
            catalog['events'].append(meta)
        (directory / 'events' / (ident + '.json')).write_text(json.dumps(event, ensure_ascii=False, indent=2) + '\n')
        (directory / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
        (directory / 'athletes.json').write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n')
    print(
        args.year,
        len(rows),
        'results',
        [(r['gender'], r['distance_m'], r['rank']) for r in rows if r['rank'] and r['rank'] <= 3],
    )


if __name__ == '__main__':
    main()
