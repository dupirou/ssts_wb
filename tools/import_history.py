#!/usr/bin/env python3
"""Import an explicitly configured official protocol from a local PDF.

Usage: python tools/import_history.py COMPETITION_ID /path/to/protocol.pdf
Uses pdftotext (Poppler), or pypdf's layout extraction when Poppler is unavailable.
The source URL and expected SHA live in catalog.json.
No scraping or live-season data is changed by this command.
"""

import argparse
import json
import shutil
import subprocess
from pathlib import Path

import history_data
import sync_competitions


def classification_pages(pdf):
    if shutil.which('pdftotext'):
        text = subprocess.check_output(['pdftotext', '-layout', str(pdf.resolve()), '-'], text=True)
        return text.rstrip('\f').split('\f')
    from pypdf import PdfReader

    return [page.extract_text(extraction_mode='layout') for page in PdfReader(pdf).pages]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('competition_id')
    parser.add_argument('pdf', type=Path)
    args = parser.parse_args()
    directory = history_data.DIRECTORY
    catalog = json.loads((directory / 'catalog.json').read_text())
    config = next(e for e in catalog['events'] if e['id'] == args.competition_id)
    digest = history_data.document_hash(args.pdf.read_bytes())
    if digest != config['source_sha256']:
        raise ValueError('PDF differs from the reviewed source')
    pages = classification_pages(args.pdf)
    text = '\f'.join(pages)
    sync_competitions.assert_identity(text, dict(city=config['source_city'], year=config['date_end'][:4]))
    results = history_data.parse_classifications(pages, config.get('expected_disciplines', 9))
    registry = json.loads((directory / 'athletes.json').read_text())
    history_data.attach_identities(results, registry)
    event = dict(
        schema_version=1,
        competition_id=config['id'],
        country='CHN',
        results=results,
        source=dict(url=config['source_url'], sha256=digest, pages=len(pages)),
    )
    history_data.validate_event(event, config, registry)
    target = directory / 'events' / (config['id'] + '.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(event, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(config['id'], len(results), 'Chinese final classifications')


if __name__ == '__main__':
    main()
