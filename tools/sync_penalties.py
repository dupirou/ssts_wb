"""Synchronize audited C98P/C89I2 records without inferring sanctions from PEN alone."""

import argparse
import json
import os
import tempfile
from pathlib import Path

import competition_data
import penalty_protocol
import stations
import sync_competitions

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data/penalties'


def save_verified(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + '\n'
    if path.exists() and path.read_text(encoding='utf-8') == content:
        return False
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                     prefix='.penalties-', delete=False) as file:
        temporary = Path(file.name)
        file.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def sync_event(station, fetcher=sync_competitions.fetch, store=STORE, directory=competition_data.DATA):
    """Only accepted protocol, official heat identities, and station order can update data."""
    event_id = station['id']
    config = stations.sources(station)
    idx = [s['id'] for s in stations.stations()].index(event_id) + 1
    path = store / f'{event_id}.json'
    current = competition_data.load_snapshot(event_id, directory)
    if path.exists():
        accepted = json.loads(path.read_text(encoding='utf-8'))
        if accepted.get('schema_version') != 1 or accepted.get('completed_events') != idx:
            raise ValueError('Invalid stored season penalty snapshot')
        patched = penalty_protocol.attach_codes(current, accepted)
        if patched != current:
            competition_data.write_snapshot(patched, directory)
        return True
    body = fetcher(config['documents_url'])
    docs = sync_competitions.discover_documents(body, config['documents_url'], config)
    reports = sorted((item for item in docs if item['kind'] == 'reports'),
                     key=lambda item: item.get('published_at') or '', reverse=True)
    for doc in reports[:20]:
        pdf = fetcher(doc['url'])
        try:
            accepted = penalty_protocol.parse_pdf(pdf, config, doc['url'])
        except ValueError as exc:
            # A classification PDF is not a Protocol and need not carry C98P.
            if 'Missing or incomplete World Tour penalties' in str(exc):
                continue
            raise
        if accepted['completed_events'] != idx:
            raise ValueError('Protocol world-tour index differs from the station sequence')
        patched = penalty_protocol.attach_codes(current, accepted)
        # No partial publication: the document and its linked round codes are both validated first.
        save_verified(path, accepted)
        if patched != current:
            competition_data.write_snapshot(patched, directory)
        return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--event', help='One World Tour station (otherwise active station windows)')
    args = parser.parse_args()
    for station in stations.stations():
        if args.event and station['id'] != args.event:
            continue
        if not args.event and not stations.within(station, stations.utc_now(), 14):
            continue
        verified = sync_event(station)
        print(f"{station['id']} penalty protocol: {'verified' if verified else 'not published'}")


if __name__ == '__main__':
    main()
