"""Official evidence URLs cannot be forged by subdomains or insecure schemes."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import official_sources


class EvidenceHostTests(unittest.TestCase):
    def test_official_and_historical_domains(self):
        for url in (
            'https://isu-skating.com/en/short-track/',
            'https://www.isu-skating.com/en/short-track/',
            'https://www.isu.org/results',
            'https://shorttrack.sportresult.com/results/',
        ):
            with self.subTest(url=url):
                self.assertTrue(official_sources.valid_evidence(url))

    def test_insecure_or_lookalike_domains_rejected(self):
        for url in (
            'http://isu-skating.com/results',
            'https://isu-skating.com.evil.example/',
            'https://shorttrack.sportresult.com.evil.example/',
            'https://user:pw@isu.org/',
            'https://isu.org:444/',
        ):
            with self.subTest(url=url):
                self.assertFalse(official_sources.valid_evidence(url))


if __name__ == '__main__':
    unittest.main()
