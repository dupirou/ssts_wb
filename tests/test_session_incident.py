"""Session incident tracking uses only completed prior session runs."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import session_incident as incident


class IncidentTests(unittest.TestCase):
    def test_two_previous_unexpected_crashes_required(self):
        runs = [
            dict(id=3, display_title=incident.SESSION_RUN, status='completed'),
            dict(id=2, display_title=incident.SESSION_RUN, status='completed'),
            dict(id=1, display_title=incident.SESSION_RUN, status='completed'),
        ]

        def jobs(run_id):
            return [{'steps': [dict(name=incident.GATE, conclusion='failure' if run_id != 1 else 'success')]}]

        self.assertFalse(incident.previous_crashes(runs, jobs, 3))
        runs[2]['display_title'] = 'ISU sync (hourly)'
        self.assertFalse(incident.previous_crashes(runs, jobs, 3))
        runs[2]['display_title'] = incident.SESSION_RUN
        self.assertTrue(
            incident.previous_crashes(runs, lambda _: [{'steps': [dict(name=incident.GATE, conclusion='failure')]}], 3)
        )

    def test_incident_create_once_update_then_recover(self):
        state = {
            'issues': [],
            'runs': [dict(id=n, display_title=incident.SESSION_RUN, status='completed') for n in (3, 2, 1)],
        }
        calls = []

        def api(method, path, token, payload=None):
            calls.append((method, path, payload))
            if path.endswith('/issues?state=all&per_page=100'):
                return state['issues']
            if path.endswith('/runs?event=workflow_dispatch&per_page=100'):
                return {'workflow_runs': state['runs']}
            if '/jobs?' in path:
                return {'jobs': [{'steps': [dict(name=incident.GATE, conclusion='failure')]}]}
            if method == 'POST':
                item = dict(number=7, state='open', title=incident.TITLE, body=payload['body'])
                state['issues'].append(item)
                return item
            if method == 'PATCH':
                state['issues'][0].update(payload)
                return state['issues'][0]
            raise AssertionError((method, path))

        self.assertEqual(incident.track('dupirou/ssts_wb', 3, True, 'token', api), 'created')
        self.assertEqual(incident.track('dupirou/ssts_wb', 3, True, 'token', api), 'already_reported')
        self.assertEqual(incident.track('dupirou/ssts_wb', 3, False, 'token', api), 'healthy')
        self.assertEqual(state['issues'][0]['state'], 'closed')
        self.assertEqual(len([call for call in calls if call[0] == 'POST']), 1)


if __name__ == '__main__':
    unittest.main()
