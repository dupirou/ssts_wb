"""Temporary metadata probe for the public ISU entry and ranking pages."""
import json
import re
from urllib.request import Request, urlopen

PAGES = {
    "vancouver_entries": "https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=entries_16230",
    "world_standings": "https://isu-skating.com/en/short-track/world-standings/",
}
for label, url in PAGES.items():
    with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25) as response:
        html = response.read(4_000_000).decode("utf-8")
    print("PAGE", label, "bytes", len(html))
    for script in re.findall(r'<script[^>]+src="([^"]+)', html):
        if "chunk" in script or "main" in script:
            print("JS", script[:180])
    text = ""
    marker_counts = {}
    for match in re.finditer(r'self\.__next_f\.push\(', html):
        try:
            frame, _ = json.JSONDecoder().raw_decode(html[match.end():])
        except ValueError:
            continue
        if len(frame) > 1 and isinstance(frame[1], str):
            text += frame[1]
    print("RSC bytes", len(text))
    for pattern in ("eventEntries", "eventEntry", "EntriesData", "entriesData", "worldRanking",
                    "WorldTour", "worldTour", "standing", "Standing", "ranking", "Ranking",
                    "Brendan COREY", "season_id", "discipline_id", "entry_id"):
        matches = list(re.finditer(re.escape(pattern), text, re.I))
        marker_counts[pattern] = len(matches)
        for m in matches[:2]:
            print("MARK", pattern, repr(text[max(0,m.start()-100):m.start()+280]))
    print("COUNTS", json.dumps(marker_counts))
