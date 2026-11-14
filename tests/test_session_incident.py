"""Incident tracking counts every kind of completed sync run."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import session_incident as incident


class IncidentTests(unittest.TestCase):
    def test_two_previous_failures_required_whatever_the_trigger(self):
        run = lambda n, title, conclusion: dict(id=n, display_title=title, status='completed', conclusion=conclusion)
        runs = [
            run(4, 'ISU sync (hourly)', 'failure'),
            run(3, 'ISU sync (periodic)', 'failure'),
            run(2, 'ISU sync (session)', 'failure'),
            run(1, 'ISU sync (hourly)', 'success'),
        ]
        self.assertTrue(incident.previous_failures(runs, 4))
        runs[1]['conclusion'] = 'success'
        self.assertFalse(incident.previous_failures(runs, 4))
        runs[1].update(conclusion=None, status='in_progress')
        self.assertFalse(incident.previous_failures(runs, 4))
        self.assertFalse(incident.previous_failures(runs[:2], 4))

    def test_incident_create_once_update_then_recover(self):
        state = {
            'issues': [],
            'runs': [dict(id=n, status='completed', conclusion='failure') for n in (3, 2, 1)],
        }
        calls = []

        def api(method, path, token, payload=None):
            calls.append((method, path, payload))
            if path.endswith('/issues?state=all&per_page=100'):
                return state['issues']
            if path.endswith('/runs?per_page=100'):
                return {'workflow_runs': state['runs']}
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
