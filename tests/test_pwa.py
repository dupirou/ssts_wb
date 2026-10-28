"""The site installs as a PWA: valid manifest, real icons, and a service worker versioned by the app shell."""

import hashlib
import json
import re
import struct
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build


def png_size(path):
    head = path.read_bytes()[:24]
    assert head[:8] == b'\x89PNG\r\n\x1a\n', path
    return struct.unpack('>II', head[16:24])


class PwaTests(unittest.TestCase):
    def test_static_security_headers_are_built(self):
        source = (ROOT / 'web/_headers').read_text(encoding='utf-8')
        built = (ROOT / 'dist/_headers').read_text(encoding='utf-8')
        self.assertEqual(built, source)
        self.assertIn('X-Frame-Options: DENY', built)
        self.assertIn("object-src 'none'", built)
        self.assertNotIn('Access-Control-Allow-Origin', built)

    def test_manifest_is_installable(self):
        manifest = json.loads((ROOT / 'web/manifest.webmanifest').read_text(encoding='utf-8'))
        self.assertEqual((manifest['display'], manifest['start_url'], manifest['scope']), ('standalone', './', './'))
        sizes = {}
        for icon in manifest['icons']:
            path = ROOT / 'web' / icon['src']
            self.assertTrue(path.exists(), icon['src'])
            if icon['type'] == 'image/png':
                w, h = png_size(path)
                self.assertEqual(icon['sizes'], f'{w}x{h}')
                sizes.setdefault(icon['purpose'], set()).add(w)
        self.assertLessEqual({192, 512}, sizes['any'])
        self.assertIn(512, sizes['maskable'])
        self.assertEqual(png_size(ROOT / 'web/icons/apple-touch-icon.png'), (180, 180))

    def test_shortcut_follows_the_next_event(self):
        utc = lambda iso: datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)
        source = (ROOT / 'web/manifest.webmanifest').read_text(encoding='utf-8')
        shortcut = lambda iso: json.loads(build.manifest_text(source, utc(iso)))['shortcuts']
        self.assertEqual(shortcut('2026-10-20T00:00:00')[0]['url'], '/events/2026-27/vancouver/')
        # Vancouver's last local day ends 2026-10-26 07:00 UTC; the shortcut then moves to Montréal.
        self.assertEqual(shortcut('2026-10-26T06:59:00')[0]['url'], '/events/2026-27/vancouver/')
        self.assertEqual(shortcut('2026-10-26T07:00:00')[0]['name'], '蒙特利尔站赛程')
        self.assertEqual(shortcut('2027-02-20T00:00:00')[0]['short_name'], '世锦赛')
        self.assertEqual(shortcut('2027-04-01T00:00:00'), [])
        self.assertNotIn('{{', build.manifest_text(source, utc('2026-10-20T00:00:00')))

    def test_page_links_manifest_and_registers_worker(self):
        html = (ROOT / 'web/index.html').read_text(encoding='utf-8')
        self.assertIn('rel="manifest" href="/manifest.webmanifest"', html)
        self.assertIn('rel="apple-touch-icon"', html)
        self.assertIn(
            "serviceWorker.register('/sw.js', {scope: '/'})", (ROOT / 'web/app.js').read_text(encoding='utf-8')
        )

    def test_modules_belong_to_their_route_bundle(self):
        html = (ROOT / 'web/index.html').read_text()
        worker = (ROOT / 'web/sw.js').read_text()
        declared = re.findall(r'<script defer src="/([^"]+)"', html)
        self.assertEqual(declared, [build.BUNDLE])
        self.assertIn("'./" + build.BUNDLE + "'", worker)
        for name, scripts in build.BUNDLES.items():
            bundle = (ROOT / 'dist' / name).read_text()
            for script in scripts:
                self.assertIn((ROOT / 'web' / script).read_text(), bundle)
        self.assertNotIn('results-page.js', worker)
        self.assertIn('results-page.js', build.SHELL_FILES)
        self.assertNotIn('results-page.js', html)
        self.assertIn('href="/results-page.js" as="script"', (ROOT / 'dist/results/index.html').read_text())

    def test_built_worker_is_stamped_with_the_shell_version(self):
        built = (ROOT / 'dist/sw.js').read_text(encoding='utf-8')
        shell = (
            b''.join((ROOT / 'dist' / name).read_bytes() for name in build.SHELL_FILES)
            + (ROOT / 'web/sw.js').read_bytes()
        )
        self.assertEqual(re.search(r"VERSION = '(\w+)'", built)[1], hashlib.sha256(shell).hexdigest()[:12])
        for asset in re.search(r'SHELL = \[(.*?)\];', built, re.S)[1].replace("'", '').replace('\n', '').split(','):
            path = asset.strip().removeprefix('./') or 'index.html'
            self.assertTrue((ROOT / 'dist' / path).exists(), path)


if __name__ == '__main__':
    unittest.main()
