"""Shared, strictly allowlisted ISU transport and HTML/Next.js decoding.

Callers keep source-specific identity and schema validation. No arbitrary URL,
redirect or JavaScript evaluation is allowed.
"""

import json
import re
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from bs4 import BeautifulSoup

import tls

USER_AGENT = 'SSTS-WB/1.0 (+https://github.com/dupirou/ssts_wb)'
REMOVED = 'script,style,nav,footer,header'


def allowed(url, hosts):
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme == 'https'
            and parsed.hostname in hosts
            and parsed.port in (None, 443)
            and not parsed.username
            and not parsed.password
        )
    except (TypeError, ValueError):
        return False


class OfficialRedirect(HTTPRedirectHandler):
    def __init__(self, hosts):
        super().__init__()
        self.hosts = frozenset(hosts)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl, self.hosts):
            raise ValueError('Non-official redirect refused')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request_bytes(
    url,
    *,
    hosts,
    max_bytes,
    timeout=25,
    form=None,
    json_payload=None,
    accept=None,
    user_agent=USER_AGENT,
):
    if not allowed(url, hosts):
        raise ValueError('Non-official source refused')
    if form is not None and json_payload is not None:
        raise ValueError('Ambiguous request body')
    headers = {'User-Agent': user_agent}
    body = None
    if form is not None:
        body = urlencode(form).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    elif json_payload is not None:
        body = json.dumps(json_payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if accept:
        headers['Accept'] = accept
    opener = build_opener(HTTPSHandler(context=tls.CONTEXT), OfficialRedirect(hosts))
    with opener.open(Request(url, data=body, headers=headers), timeout=timeout) as response:
        if not allowed(response.geturl(), hosts):
            raise ValueError('Non-official response refused')
        content = response.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise ValueError('Official response exceeds size limit')
    return content


def page_text(document):
    """Strip non-content tags without mutating the caller's BeautifulSoup tree."""
    soup = BeautifulSoup(str(document) if isinstance(document, BeautifulSoup) else document, 'html.parser')
    for node in soup.select(REMOVED):
        node.decompose()
    return soup.get_text('\n', strip=True)


def next_property(body, property_name):
    """Decode a property from Next.js quoted server frames, never execute scripts."""
    soup = BeautifulSoup(body, 'html.parser')
    decoder = json.JSONDecoder()
    marker = '"' + property_name + '":'
    for script in soup.find_all('script'):
        content = script.get_text()
        for match in re.finditer(r'self\.__next_f\.push\(', content):
            try:
                frame, _ = decoder.raw_decode(content[match.end():])
            except ValueError:
                continue
            if len(frame) < 2 or not isinstance(frame[1], str):
                continue
            pos = frame[1].find(marker)
            if pos >= 0:
                value, _ = decoder.raw_decode(frame[1][pos + len(marker):])
                return value
    raise ValueError('Missing ISU ' + property_name)
