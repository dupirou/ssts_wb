"""Verified ISU World Standings requests shared by the ranking syncs.

The response contract is checked here once; each caller still validates that
the lists belong to the season it asked for.
"""

import json

import isu_transport
import sync_competitions as sync

API = 'https://front-api.isu.org'
MAX_PAGES = 20


def post_json(url, payload):
    return isu_transport.request_bytes(
        url, hosts=sync.HOSTS, max_bytes=sync.MAX_BYTES, json_payload=payload, accept='application/json'
    )


def response(body, endpoint, page=None):
    obj = json.loads(body)
    if not isinstance(obj, dict) or obj.get('status') != 200 or not isinstance(obj.get('data'), list):
        raise ValueError('Unsupported ISU response: ' + endpoint)
    if page is not None and (obj.get('current_page') != page or type(obj.get('total_page')) is not int):
        raise ValueError('Unexpected ranking page')
    return obj


def ranking_rows(meta, sender=post_json):
    """Every published row of one distance ranking, keyed by ISU skater ID."""
    rid = meta['world_standings_list_fsk_id']
    url = API + '/events/get-world-standings-fsk-detail-skater-single'
    output = {}
    for page in range(1, MAX_PAGES + 1):
        obj = response(sender(url, {'world_standings_list_fsk_id': rid, 'page': page}), 'ranking detail', page)
        detail = obj.get('detail') or {}
        if any(
            detail.get(k) != meta.get(k)
            for k in (
                'world_standings_list_fsk_id',
                'season_name',
                'gender',
                'discipline_distance',
                'type',
                'level_name',
            )
        ):
            raise ValueError('Ranking page belongs to another list')
        for row in obj['data']:
            sid = row.get('skaters_id')
            if (
                type(sid) is not int
                or sid in output
                or type(row.get('rank')) is not int
                or type(row.get('points')) is not int
            ):
                raise ValueError('Unsupported or duplicate ranking row')
            output[sid] = dict(rank=row['rank'], points=row['points'])
        if page == obj['total_page']:
            if len(output) != obj['total_items']:
                raise ValueError('Incomplete distance ranking')
            return output
    raise ValueError('Ranking request budget exceeded')
