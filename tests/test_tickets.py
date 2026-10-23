import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build


class TicketConfigTests(unittest.TestCase):
    def test_seoul_ticket_sources_and_opening(self):
        tickets = build.load_ticketing()
        self.assertEqual(set(tickets), {'seoul'})
        self.assertEqual(tickets['seoul']['sale_start'], '2026-10-23T14:00:00+09:00')
        self.assertEqual(tickets['seoul']['booking_url'], 'https://m.ticketlink.co.kr/global/zh/product/66349?null')
        self.assertEqual(tickets['seoul']['booking_name'], 'Ticketlink')
        self.assertEqual(
            tickets['seoul']['isu_url'],
            'https://isu-skating.com/zh-CN/short-track/news/short-track-world-tour-seoul-2026-tickets/',
        )

    def test_reject_non_official_and_insecure_links(self):
        original = build.ROOT
        for field, url in (
            ('booking_url', 'https://m.ticketlink.co.kr.evil.example/global/zh/product/66349'),
            ('isu_url', 'http://isu-skating.com/zh-CN/short-track/news/foo'),
            ('sale_start', '2026-10-23T14:00:00+08:00'),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'data'
                path.mkdir()
                sample = json.loads((original / 'data/tickets.json').read_text(encoding='utf-8'))
                sample['stations']['seoul'][field] = url
                (path / 'tickets.json').write_text(json.dumps(sample), encoding='utf-8')
                try:
                    build.ROOT = Path(tmp)
                    with self.assertRaises(ValueError):
                        build.load_ticketing()
                finally:
                    build.ROOT = original


if __name__ == '__main__':
    unittest.main()
