"""A rejected station must not hold back other verified site outputs."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build


class BuildIsolationTests(unittest.TestCase):
    def test_invalid_schedule_or_china_record_retains_only_that_station(self):
        original_read = build.read_schedule
        original_attach = build.attach_china

        for cause in ('csv', 'china_auto'):
            with self.subTest(cause=cause), tempfile.TemporaryDirectory() as temp:
                out = Path(temp) / 'public'

                def fail_read(station_id, *args, **kwargs):
                    if cause == 'csv' and station_id == 'vancouver':
                        raise ValueError('Invalid official CSV row')
                    return original_read(station_id, *args, **kwargs)

                def fail_china(rows, station_id):
                    if cause == 'china_auto' and station_id == 'vancouver':
                        raise ValueError('China record references unknown round_key')
                    return original_attach(rows, station_id)

                with patch.object(build, 'read_schedule', fail_read), patch.object(build, 'attach_china', fail_china):
                    build.export(out=out)

                old = (ROOT / 'dist/data/vancouver.json').read_text(encoding='utf-8')
                self.assertEqual((out / 'data/vancouver.json').read_text(encoding='utf-8'), old)
                self.assertTrue((out / 'data/competitions/montreal.json').exists())
                report = json.loads((out / 'data/build_report.json').read_text(encoding='utf-8'))
                self.assertEqual(report['errors']['vancouver']['state'], 'retained')

    def test_bad_ticket_config_retains_verified_links_and_other_stations_build(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'public'
            with patch.object(build, 'load_ticketing', side_effect=ValueError('Invalid ticket source: booking_url')):
                build.export(out=out)
            report = json.loads((out / 'data/build_report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['errors']['ticketing']['state'], 'retained')
            self.assertTrue((out / 'data/competitions/montreal.json').exists())
            self.assertTrue((out / 'index.html').exists())


if __name__ == '__main__':
    unittest.main()
