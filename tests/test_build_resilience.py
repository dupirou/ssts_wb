"""A rejected station must not hold back other verified site outputs."""

import json
import hashlib
import errno
import os
import subprocess
from datetime import datetime, timezone
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build
import updates


class BuildIsolationTests(unittest.TestCase):
    def test_invalid_schedule_or_china_record_retains_only_that_station(self):
        original_read = build.read_schedule
        original_attach = build.attach_china

        for cause in ('csv', 'china_auto'):
            with self.subTest(cause=cause), tempfile.TemporaryDirectory() as temp:
                out = Path(temp) / 'public'
                (out / 'data').mkdir(parents=True)
                (out / 'data/vancouver.json').write_bytes((ROOT / 'dist/data/vancouver.json').read_bytes())

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

    def test_two_identical_builds_and_removed_schedule_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'public'
            now = datetime(2026, 10, 28, tzinfo=timezone.utc)
            build.export(now=now, out=out)

            def hashes():
                return {
                    str(path.relative_to(out)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in out.rglob('*')
                    if path.is_file()
                }

            first = hashes()
            build.export(now=now, out=out)
            self.assertEqual(hashes(), first)

            original_read = build.read_schedule

            def without_vancouver(station_id, *args, **kwargs):
                return [] if station_id == 'vancouver' else original_read(station_id, *args, **kwargs)

            with patch.object(build, 'read_schedule', without_vancouver):
                build.export(now=now, out=out)
            self.assertFalse((out / 'data/vancouver.json').exists())
            report = json.loads((out / 'data/build_report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['errors']['vancouver']['state'], 'removed')

    def test_update_log_is_atomically_promoted_on_its_own_volume(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            out = root / 'public' / 'dist'
            log = root / 'repository' / 'updates.json'
            log.parent.mkdir()
            original_replace = os.replace

            def prohibit_cross_volume_log_replace(src, dst):
                if Path(dst) == log and Path(src).parent != log.parent:
                    raise OSError(errno.EXDEV, 'Invalid cross-device link')
                return original_replace(src, dst)

            with (
                patch.object(updates, 'LOG', log),
                patch.object(build.os, 'replace', side_effect=prohibit_cross_volume_log_replace),
            ):
                build.export(out=out)
            self.assertEqual(json.loads(log.read_text(encoding='utf-8'))['schema_version'], 1)
            self.assertTrue((out / 'index.html').exists())

    def test_failing_compiler_leaves_published_tree_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'public'
            out.mkdir()
            (out / 'index.html').write_text('previous accepted version', encoding='utf-8')
            with patch.object(build.subprocess, 'run', side_effect=subprocess.TimeoutExpired('node', 120)):
                with self.assertRaisesRegex(RuntimeError, 'timed out'):
                    build.export(out=out)
            self.assertEqual((out / 'index.html').read_text(encoding='utf-8'), 'previous accepted version')


if __name__ == '__main__':
    unittest.main()
