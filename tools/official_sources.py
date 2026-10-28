"""Conservative allowlists for verified ISU sources used in published links.

The historical shorttrack.sportresult.com endpoint is linked as an official
results channel in older ISU event publications. It is not a general-purpose
domain for current ticketing and cannot authorize arbitrary subdomains.
"""

from urllib.parse import urlsplit

ISU_OFFICIAL_HOSTS = frozenset({'isu-skating.com', 'www.isu-skating.com', 'isu.org', 'www.isu.org'})
ISU_LEGACY_RESULT_HOSTS = frozenset({'shorttrack.sportresult.com'})


def valid_evidence(url):
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme == 'https'
            and parsed.hostname in (ISU_OFFICIAL_HOSTS | ISU_LEGACY_RESULT_HOSTS)
            and parsed.port in (None, 443)
            and not parsed.username
            and not parsed.password
        )
    except ValueError:
        return False
