"""Shared ISU transport helpers: strict hosts and non-executing HTML decoding."""

import json
import sys
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import isu_transport


class ISUTransportTests(unittest.TestCase):
    def test_allowlist_checks_host_port_credentials_and_scheme(self):
        hosts = {'isu-skating.com'}
        self.assertTrue(isu_transport.allowed('https://isu-skating.com/en/short-track/', hosts))
        for url in [
            'http://isu-skating.com/',
            'https://evil.test/',
            'https://isu-skating.com.evil.test/',
            'https://user@isu-skating.com/',
            'https://isu-skating.com:444/',
            'not a URL',
        ]:
            self.assertFalse(isu_transport.allowed(url, hosts), url)
            with self.assertRaises(ValueError):
                isu_transport.request_bytes(url, hosts=hosts, max_bytes=100)

    def test_redirect_cannot_escape_allowlist(self):
        redirect = isu_transport.OfficialRedirect({'isu-skating.com'})
        with self.assertRaises(ValueError):
            redirect.redirect_request(None, None, 302, 'Found', {}, 'https://untrusted.test/')
        with self.assertRaises(ValueError):
            redirect.redirect_request(None, None, 302, 'Found', {}, 'https://isu-skating.com:8080/')

    def test_html_text_is_shared_without_mutating_input(self):
        soup = BeautifulSoup('<header>Hide</header><main>Montréal</main><script>ignore()</script>', 'html.parser')
        self.assertEqual(isu_transport.page_text(soup), 'Montréal')
        self.assertIsNotNone(soup.find('script'))
        self.assertEqual(isu_transport.page_text(str(soup)), 'Montréal')

    def test_next_property_decodes_data_without_running_code(self):
        events = [{'event_result_id': 10, 'name': 'Women 500 m'}]
        frame = [1, '1:["$",null,{"eventResultsData":' + json.dumps(events) + '}]']
        page = '<script>self.__next_f.push(' + json.dumps(frame) + ')</script>'
        self.assertEqual(isu_transport.next_property(page, 'eventResultsData'), events)
        with self.assertRaisesRegex(ValueError, 'Missing ISU'):
            isu_transport.next_property('<script>dangerous()</script>', 'eventResultsData')


if __name__ == '__main__':
    unittest.main()
