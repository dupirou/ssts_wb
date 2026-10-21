"""Official fetches trust certifi's current Mozilla roots, not the runner's possibly stale system store."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import certifi
import sync_china
import sync_competitions
import sync_predictions
import sync_schedule
import tls


class Stop(Exception):
    pass


class TrustStoreTests(unittest.TestCase):
    def test_bundle_no_longer_trusts_the_compromised_emsign_root(self):
        self.assertNotIn('emSign ECC Root CA - G3', Path(certifi.where()).read_text(encoding='ascii'))

    def test_every_official_fetch_uses_the_certifi_context(self):
        seen = []

        def opener(*handlers):
            seen.append(next(h._context for h in handlers if hasattr(h, '_context')))
            raise Stop

        def urlopen(*args, context=None, **kwargs):
            seen.append(context)
            raise Stop

        with patch.object(sync_schedule, 'urlopen', urlopen), patch.object(sync_china, 'urlopen', urlopen), \
                patch.object(sync_competitions, 'build_opener', opener), patch.object(sync_predictions, 'build_opener', opener):
            for call in (lambda: sync_schedule.fetch('https://www.isu-skating.com/'),
                         lambda: sync_china.fetch_page('https://www.isu-skating.com/'),
                         lambda: sync_competitions.fetch('https://www.isu-skating.com/'),
                         lambda: sync_predictions.post_json('https://front-api.isu.org/x', {})):
                with self.assertRaises(Stop):
                    call()
        self.assertEqual(seen, [tls.CONTEXT] * 4)


if __name__ == '__main__':
    unittest.main()
