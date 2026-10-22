"""Render the PWA icons from web/icons/icon.svg with headless Chromium.

The artwork fades to the manifest background (#070B12) at its edges, so the Android splash
screen shows the glowing track on a seamless background rather than a pasted square.
Run after editing icon.svg: python3 tools/render_icons.py [path-to-chromium]
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / 'web/icons'
# name, size, corner radius as a fraction of the size (0 = full bleed for masking launchers)
OUTPUTS = [('maskable-512', 512, 0), ('apple-touch-icon', 180, 0), ('icon-512', 512, .22), ('icon-192', 192, .22)]


def chromium():
    # headless_shell sizes the viewport exactly; full Chrome's new headless mode trims it.
    shells = sorted(glob.glob('/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell'))
    for path in (sys.argv[1:2] or []) + [os.environ.get('CHROMIUM', '')] + shells[-1:] + [
            '/opt/pw-browsers/chromium', 'chromium', 'chromium-browser', 'google-chrome']:
        if path and shutil.which(path):
            return shutil.which(path)
    raise SystemExit('Chromium not found; pass its path as the first argument')


def main():
    browser = chromium()
    svg = (ICONS / 'icon.svg').read_text(encoding='utf-8')
    with tempfile.TemporaryDirectory() as temp:
        for name, size, radius in OUTPUTS:
            page = Path(temp) / f'{name}.html'
            page.write_text(
                '<!doctype html><style>html,body{margin:0;background:transparent}'
                f'div{{width:{size}px;height:{size}px;border-radius:{radius * size}px;overflow:hidden}}'
                'svg{display:block;width:100%;height:100%}</style>'
                f'<div>{svg}</div>', encoding='utf-8')
            subprocess.run([browser, '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
                            '--default-background-color=00000000', f'--window-size={size},{size}',
                            f'--screenshot={ICONS / (name + ".png")}', page.as_uri()],
                           check=True, capture_output=True)
            print('wrote', name, size)


if __name__ == '__main__':
    main()
