"""The site installs as a PWA: valid manifest, real icons, and a service worker versioned by the app shell."""
import hashlib
import json
import re
import struct
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def png_size(path):
    head = path.read_bytes()[:24]
    assert head[:8] == b'\x89PNG\r\n\x1a\n', path
    return struct.unpack('>II', head[16:24])


class PwaTests(unittest.TestCase):
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

    def test_page_links_manifest_and_registers_worker(self):
        html = (ROOT / 'web/index.html').read_text(encoding='utf-8')
        self.assertIn('rel="manifest" href="./manifest.webmanifest"', html)
        self.assertIn('rel="apple-touch-icon"', html)
        self.assertIn("serviceWorker.register('./sw.js')", (ROOT / 'web/app.js').read_text(encoding='utf-8'))

    def test_built_worker_is_stamped_with_the_shell_version(self):
        built = (ROOT / 'dist/sw.js').read_text(encoding='utf-8')
        shell = b''.join((ROOT / 'web' / name).read_bytes()
                         for name in ('index.html', 'app.js', 'site.css', 'manifest.webmanifest', 'sw.js'))
        self.assertEqual(re.search(r"VERSION = '(\w+)'", built)[1], hashlib.sha256(shell).hexdigest()[:12])
        for asset in re.search(r'SHELL = \[(.*?)\];', built, re.S)[1].replace("'", '').replace('\n', '').split(','):
            path = asset.strip().removeprefix('./') or 'index.html'
            self.assertTrue((ROOT / 'dist' / path).exists(), path)


if __name__ == '__main__':
    unittest.main()
