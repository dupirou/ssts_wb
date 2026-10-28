"""Create one GitHub incident only after three consecutive session-sync crashes.

The previous attempts are read from Actions step outcomes; no state is committed
to main and no daily build is triggered merely to count failures.
"""

import json
import os
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

TITLE = 'ISU session sync: consecutive unexpected errors'
GATE = 'Fail job when any synchronization crashed'
SESSION_RUN = 'ISU sync (session)'


def previous_crashes(runs, get_jobs, current_run, count=2):
    """Read preceding session runs in newest-first order; any healthy session resets the streak."""
    outcomes = []
    for run in runs:
        if run['id'] == current_run or run.get('display_title') != SESSION_RUN:
            continue
        if run.get('status') != 'completed':
            return False  # Never skip an incomplete earlier session.
        jobs = get_jobs(run['id'])
        steps = [step for job in jobs for step in job.get('steps', []) if step['name'] == GATE]
        outcomes.append(any(step.get('conclusion') == 'failure' for step in steps))
        if len(outcomes) == count:
            return all(outcomes)
    return False


def api(method, path, token, payload=None):
    body = json.dumps(payload).encode('utf-8') if payload is not None else None
    request = Request(
        'https://api.github.com/' + path,
        data=body,
        method=method,
        headers={
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'ssts-wb-session-health',
            **({'Content-Type': 'application/json'} if body is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f'GitHub incident API {method} failed: HTTP {error.code}') from error


def track(repo, run_id, failed, token, get=api):
    prefix = f'repos/{repo}'
    issues = get('GET', prefix + '/issues?state=all&per_page=100', token)
    incident = next((issue for issue in issues if issue.get('title') == TITLE and 'pull_request' not in issue), None)
    if not failed:
        if incident and incident['state'] == 'open':
            get('PATCH', prefix + f'/issues/{incident["number"]}', token, {'state': 'closed'})
            print('Closed recovered sync incident', incident['number'])
        return 'healthy'
    runs = get('GET', prefix + '/actions/workflows/sync.yml/runs?event=workflow_dispatch&per_page=100', token)[
        'workflow_runs'
    ]
    get_jobs = lambda rid: get('GET', prefix + f'/actions/runs/{rid}/jobs?per_page=100', token)['jobs']
    if not previous_crashes(runs, get_jobs, run_id):
        print('Session sync error; fewer than three consecutive unexpected failures')
        return 'below_threshold'
    link = f'https://github.com/{repo}/actions/runs/{run_id}'
    body = 'Three or more consecutive race-session sync runs had unexpected failures.\n\n'
    body += f'Latest affected run: {link}\n\nValidation refusals are not counted.'
    if incident:
        if incident.get('body') == body and incident['state'] == 'open':
            return 'already_reported'
        get('PATCH', prefix + f'/issues/{incident["number"]}', token, {'state': 'open', 'body': body})
        print('Updated existing sync incident', incident['number'])
        return 'updated'
    created = get('POST', prefix + '/issues', token, {'title': TITLE, 'body': body})
    print('Created sync incident', created['number'])
    return 'created'


def main():
    repo = os.environ['GITHUB_REPOSITORY']
    token = os.environ['GH_TOKEN']
    run_id = int(os.environ['GITHUB_RUN_ID'])
    failed = os.environ['SYNC_FAILED'] == 'true'
    try:
        track(repo, run_id, failed, token)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f'::error::Unable to assess session sync incident: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
