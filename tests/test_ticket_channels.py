"""Ticket links must be genuine curated platform URLs, never synthesized event pages."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build


class TicketChannelsTests(unittest.TestCase):
    def test_shanghai_direct_damai_and_seoul_existing_ticketlink(self):
        result = build.load_ticketing()
        channels = result['shanghai']['channels']
        self.assertEqual([c['name'] for c in channels], ['大麦', '久事体育', '携程', 'MAISEAT'])
        self.assertEqual(channels[0]['kind'], 'event')
        self.assertIn('itemId=1095988161093', channels[0]['url'])
        self.assertTrue(all(c['kind'] == 'platform' for c in channels[1:]))
        self.assertEqual(result['seoul']['booking_name'], 'Ticketlink')
        self.assertEqual(result['seoul']['sale_start'], '2026-10-23T14:00:00+09:00')
        self.assertNotIn('sale_start', result['shanghai'])

    def test_rejects_invalid_channel_hosts_and_forged_event_ids(self):
        original = json.loads((ROOT / 'data/tickets.json').read_text(encoding='utf-8'))
        for name, url in [
            ('malicious-host', 'https://evil.example/shows/item.html?itemId=1095988161093'),
            ('different-damai-event', 'https://m.damai.cn/shows/item.html?itemId=1095988161094'),
            ('http-link', 'http://m.damai.cn/shows/item.html?itemId=1095988161093'),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                altered = json.loads(json.dumps(original))
                altered['stations']['shanghai']['channels'][0]['url'] = url
                data_dir = Path(temp) / 'data'
                data_dir.mkdir()
                (data_dir / 'tickets.json').write_text(json.dumps(altered), encoding='utf-8')
                with patch.object(build, 'ROOT', Path(temp)):
                    with self.assertRaises(ValueError):
                        build.load_ticketing()


if __name__ == '__main__':
    unittest.main()
