"""Stored schedules can be validated without importing the network fetcher."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))

import schedule_store
import stations
import sync_schedule


class ScheduleStoreTests(unittest.TestCase):
    def test_shared_validation_keeps_existing_rejection_semantics(self):
        path = stations.schedule_path('vancouver')
        station = stations.get('vancouver')
        rows = schedule_store.read(path)
        self.assertEqual(schedule_store.validate(rows, station), sync_schedule.validate(rows, station))
        with self.assertRaises(ValueError):
            schedule_store.validate(rows[:-1], station)

    def test_missing_programme_is_not_published(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertIsNone(schedule_store.read(Path(temp) / 'missing.csv'))


if __name__ == '__main__':
    unittest.main()
