#!/usr/bin/env python3
"""Fetch official entry PDFs and competition reports; keep known-good snapshots.

Only official published rows are imported. A roster never confirms a heat.
Document URL discovery is repeated each run so replacement PDFs are picked up.
"""

import argparse
import io
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit, urlencode
from urllib.request import Request, HTTPRedirectHandler, HTTPSHandler, build_opener

from bs4 import BeautifulSoup
from pypdf import PdfReader
import competition_data as data
import stations
import tls

HOSTS = {'isu-skating.com', 'www.isu-skating.com', 'isu-d8g8b4b7ece7aphs.a03.azurefd.net', 'front-api.isu.org'}
GENDERS = {'M': 'men', 'F': 'women', 'X': 'mixed'}
MAX_BYTES = 20_000_000


def allowed(url):
    p = urlsplit(url)
    return p.scheme == 'https' and p.hostname in HOSTS and p.port in (None, 443) and not p.username and not p.password


class OfficialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise ValueError('Non-official redirect refused')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, form=None):
    if not allowed(url):
        raise ValueError('Non-official source refused')
    headers = {'User-Agent': 'SSTS-WB/1.0 (+https://github.com/dupirou/ssts_wb)'}
    if form is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    request = Request(url, data=urlencode(form).encode() if form is not None else None, headers=headers)
    with build_opener(HTTPSHandler(context=tls.CONTEXT), OfficialRedirect()).open(request, timeout=25) as response:
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError('Official document exceeds size limit')
        return body


# Entries appear about two weeks before a station. Checks then continue for good, as before, so
# late corrections are picked up and the API never reports a finished station as stale; official
# results already stored are reused rather than requested again.
WINDOW_BEFORE_DAYS = 14


def assert_identity(text, config):
    if stations.plain(config['city']) not in stations.plain(text) or not re.search(
        r'\b' + str(config['year']) + r'\b', text
    ):
        raise ValueError('Source is not labelled with the expected city and year')


def pdf_pages(body, layout=False):
    if not body.startswith(b'%PDF-'):
        raise ValueError('Expected PDF document')
    reader = PdfReader(io.BytesIO(body))
    if len(reader.pages) > 250:
        raise ValueError('Report exceeds page limit')
    return [p.extract_text(extraction_mode='layout' if layout else 'plain') or '' for p in reader.pages]


def parse_entries(body, config):
    text = '\n'.join(pdf_pages(body))
    assert_identity(text, config)
    if not all(label in text for label in ('ISU Member', 'Participation', 'Gender')):
        raise ValueError('Unsupported entry document columns')
    items = []
    # Do not infer registered distances from a whole-event roster.
    for line in text.splitlines():
        match = re.fullmatch(r'([A-Z]{3})\s+(.+?)\s+([MFX])\s+(Active|Substitute)', line.strip())
        if not match:
            if re.match(r'^[A-Z]{3}\s+.+\s+[MFX]\s+', line.strip()):
                raise ValueError('Unrecognized entry row; refusing partial roster')
            continue
        country, name, sex, participation = match.groups()
        gender = GENDERS[sex]
        aid = data.athlete_id(name, country, gender)
        items.append(
            dict(id=aid, athlete_id=aid, name=name, country=country, gender=gender, participation=participation.lower())
        )
    if not items:
        raise ValueError('No supported roster rows')
    if len({item['id'] for item in items}) != len(items):
        raise ValueError('Ambiguous duplicate athlete in roster')
    return sorted(items, key=lambda i: (i['country'], i['gender'], i['name']))


def discover_documents(body, url, config):
    soup = BeautifulSoup(body, 'html.parser')
    assert_identity(soup.get_text(' ', strip=True), config)
    docs = {}
    for a in soup.select('a[href]'):
        href = urljoin(url, a['href'])
        label = a.get_text(' ', strip=True)
        if not allowed(href) or not urlsplit(href).path.lower().endswith('.pdf'):
            continue
        if re.search(r'\bentr(?:y|ies)\b', label, re.I):
            kind = 'entries'
        elif re.search(r'classification|ranking|standings|protocol', label, re.I):
            kind = 'reports'
        else:
            continue
        date = re.search(r'(\d{2})\.(\d{2})\.(\d{4})', label)
        published_at = '-'.join(reversed(date.groups())) if date else None
        docs[href] = dict(kind=kind, url=href, published_at=published_at)
    return list(docs.values())


def discipline(text):
    sex = re.search(r'\b(Women|Men|Mixed)\b', text, re.I)
    distance = re.search(r'\b(5000|3000|2000|1500|1000|500)\s*m\b', text, re.I)
    if not sex:
        return None
    distance = int(distance[1]) if distance else 2000 if sex[1].lower() == 'mixed' else None
    if distance is None:
        return None
    return dict(
        gender=sex[1].lower(),
        distance_m=distance,
        format='relay' if re.search(r'\brelay\b', text, re.I) else 'individual',
    )


def penalty(value, infringement=None):
    # ADV, DNS and DNF are not penalties. Preserve only explicit official codes.
    if re.fullmatch(r'PEN|YC(?:-[A-Z0-9]+)?|RC(?:-[A-Z0-9]+)?', value or ''):
        return dict(code=value, infringement_code=infringement)
    return None


def parse_reports(body, config, source_url):
    """Read published C74A/C98B ranking columns, including wrapped names.

    Heat results come exclusively from the verified JSON adapter. PDF print
    dates are not treated as race dates, nor are finishing ranks reconstructed.
    """
    pages = pdf_pages(body, layout=True)
    assert_identity('\n'.join(pages), config)
    rankings = []
    recognized = False
    for text in pages:
        title = re.search(
            r'^\s*(WORLD RANKING|EVENT CLASSIFICATION|FINAL CLASSIFICATION|WORLD TOUR CLASSIFICATION)\s*$', text, re.M
        )
        if not title:
            continue
        lines = text.splitlines()
        heading = next(
            (
                discipline(line.strip())
                for line in lines
                if discipline(line.strip()) and 'Record' not in line and len(line.strip()) < 100
            ),
            None,
        )
        header = next((line for line in lines if 'Name' in line and 'ISU' in line), None)
        if not heading or not header:
            continue
        recognized = True
        kind = {
            'WORLD RANKING': 'world',
            'EVENT CLASSIFICATION': 'event',
            'FINAL CLASSIFICATION': 'event',
            'WORLD TOUR CLASSIFICATION': 'world_tour',
        }[title[1]]
        name_col, country_col = header.index('Name'), header.index('ISU')
        points_col = header.find('Total')
        last = None
        for line in lines:
            if len(line) <= name_col:
                continue
            name = line[name_col:country_col].strip()
            prefix = line[:name_col].split()
            country = line[country_col : country_col + 3]
            if not re.fullmatch(r'[A-Z]{3}', country) or not prefix:
                if (
                    last is not None
                    and not prefix
                    and name
                    and re.fullmatch(r"[A-Za-z .’'\-]+", name)
                    and not line[country_col:].strip()
                ):
                    last['name'] += ' ' + name
                continue
            ranks = [x for x in prefix if x.isdigit()]
            has_helmet = 'Helmet' in header or 'Helmet' in text[: text.index(header) + len(header)]
            if len(ranks) < (2 if has_helmet else 1):
                continue
            rank = int(ranks[-2] if has_helmet else ranks[-1])
            point = re.match(r'\s*(\d+)\b', line[points_col:]) if points_col >= 0 else None
            last = dict(
                ranking_type=kind,
                **heading,
                name=name,
                country=country,
                rank=rank,
                points=int(point[1]) if point else None,
                official_details=line[country_col + 3 :].strip(),
                source_url=source_url,
            )
            # Re-key after all continuation lines have been appended.
            rankings.append(last)
    output = {}
    for row in rankings:
        aid = data.athlete_id(row['name'], row['country'], row['gender'])
        key = f'{row["ranking_type"]}/{row["gender"]}/{row["distance_m"]}/{aid}'
        value = dict(id=key, athlete_id=aid, **row)
        if key in output and output[key] != value:
            raise ValueError('Conflicting official ranking rows')
        output[key] = value
    if not recognized or not output:
        raise ValueError('No supported official ranking tables in document')
    return [], sorted(output.values(), key=lambda i: i['id'])


def update_dataset(dataset, items, urls, now, published_at=None):
    if not items:
        return
    changed = dataset['items'] != items or dataset['source_urls'] != sorted(set(urls))
    if changed:
        dataset.update(items=items, updated_at=now, source_urls=sorted(set(urls)))
    # Publish successful checks once per UTC day; content changes publish immediately.
    if changed or not dataset['checked_at'] or dataset['checked_at'][:10] != now[:10]:
        dataset['checked_at'] = now
    dataset.update(status='available', update_status='ok')
    dataset.pop('error', None)
    if published_at:
        dataset['published_at'] = published_at


def sync_event(event_id, config, fetcher=fetch, now=None, directory=data.DATA, api_fetcher=None):
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    snapshot = data.load_snapshot(event_id, directory)
    docs = list(config.get('documents', []))
    errors = []
    try:
        docs += discover_documents(fetcher(config['documents_url']), config['documents_url'], config)
    except Exception as exc:
        errors.append('documents: ' + str(exc))
    entry_docs = sorted(
        [d for d in docs if d['kind'] == 'entries'], key=lambda d: d.get('published_at') or '', reverse=True
    )
    entries = snapshot['entries']
    if (
        entry_docs
        and entries['items']
        and entries['source_urls'] == [entry_docs[0]['url']]
        and entries['update_status'] == 'ok'
    ):
        # Same official PDF already parsed: ISU publishes revisions under new URLs.
        update_dataset(entries, entries['items'], entries['source_urls'], now, entries.get('published_at'))
    elif entry_docs:
        doc = entry_docs[0]
        try:
            items = parse_entries(fetcher(doc['url']), config)
            update_dataset(snapshot['entries'], items, [doc['url']], now, doc.get('published_at'))
        except Exception as exc:
            snapshot['entries'].update(update_status='error', error=str(exc))
            errors.append('entries: ' + str(exc))
    report_docs = {d['url']: d for d in docs if d['kind'] == 'reports'}
    if len(report_docs) > 20:
        raise ValueError('Too many official report documents')
    proposed_rounds, proposed_rankings = [], []
    parsed_reports = set()
    for kind in ('rounds', 'rankings'):
        if snapshot[kind]['update_status'] == 'ok':
            parsed_reports |= {i['source_url'] for i in snapshot[kind]['items']}
    for url in report_docs:
        if url in parsed_reports:
            # A report PDF is immutable once parsed; reuse its rows instead of downloading again.
            proposed_rounds += [i for i in snapshot['rounds']['items'] if i['source_url'] == url]
            proposed_rankings += [i for i in snapshot['rankings']['items'] if i['source_url'] == url]
            continue
        try:
            rounds, rankings = parse_reports(fetcher(url), config, url)
            proposed_rounds += rounds
            proposed_rankings += rankings
        except Exception as exc:
            errors.append('reports: ' + str(exc))
    try:
        import build
        import isu_results

        body = fetcher(config['results_url'])
        assert_identity(BeautifulSoup(body, 'html.parser').get_text(' ', strip=True), config)
        api_fetcher = api_fetcher or (lambda endpoint, form: fetch(isu_results.API + endpoint, form))
        schedule = build.read_schedule(event_id)
        known = [
            i for i in snapshot['rounds']['items'] if i.get('evidence') in ('official_results', 'official_start_list')
        ]
        problems = []
        proposed_rounds += isu_results.collect(body, config, api_fetcher, schedule, known, problems)
        for problem in problems:
            # Only that round keeps its last accepted data; the rest of the event still updates.
            print(f'::warning::{event_id} results: kept the last accepted data for {problem}', file=sys.stderr)
    except Exception as exc:
        errors.append('results: ' + str(exc))
    for kind, proposed in [('rounds', proposed_rounds), ('rankings', proposed_rankings)]:
        if proposed:
            # Replace full source reports, not individual rows: corrections/removals
            # are authoritative within a successfully parsed report.
            replaced_sources = {p['source_url'] for p in proposed}
            merged = {p['id']: p for p in snapshot[kind]['items'] if p['source_url'] not in replaced_sources}
            merged.update({p['id']: p for p in proposed})
            update_dataset(
                snapshot[kind],
                sorted(merged.values(), key=lambda i: i['id']),
                [p['source_url'] for p in merged.values()],
                now,
            )
        elif snapshot[kind]['items']:
            snapshot[kind].update(
                update_status='error', error='Previously published data absent; retained last snapshot'
            )
        elif not errors:
            snapshot[kind].update(update_status='ok')
            snapshot[kind].pop('error', None)  # a recovered check must not keep reporting the old failure
            if not snapshot[kind]['checked_at'] or snapshot[kind]['checked_at'][:10] != now[:10]:
                snapshot[kind]['checked_at'] = now
    if errors:
        for kind in data.KINDS:
            if kind != 'entries' or not entry_docs:
                snapshot[kind].update(update_status='error', error='; '.join(errors)[:500])
    elif not entry_docs:
        snapshot['entries'].update(update_status='error' if snapshot['entries']['items'] else 'ok')
        if snapshot['entries']['update_status'] == 'ok':
            snapshot['entries'].pop('error', None)
        if not snapshot['entries']['checked_at'] or snapshot['entries']['checked_at'][:10] != now[:10]:
            snapshot['entries']['checked_at'] = now
    data.write_snapshot(snapshot, directory)
    return snapshot, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--event', help='Station ID; default: every station inside its sync window')
    args = parser.parse_args()
    now = stations.utc_now()
    failed = False
    for station in stations.stations():
        if args.event and station['id'] != args.event:
            continue
        if not station.get('isu') or (not args.event and not stations.within(station, now, WINDOW_BEFORE_DAYS)):
            continue
        try:
            snapshot, errors = sync_event(station['id'], stations.sources(station))
        except Exception as exc:
            # One station's unexpected failure keeps its last snapshot and never stops the others.
            snapshot, errors = None, ['unexpected: ' + str(exc)]
        if snapshot:
            print(station['id'], {k: len(snapshot[k]['items']) for k in data.KINDS})
        for message in errors:
            print(f'::warning::{station["id"]} entries/results sync: {message}', file=sys.stderr)
        failed |= bool(errors)
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
