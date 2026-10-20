"""Temporary shape inspection for public ISU entry and standings data."""
import json
import re
from urllib.request import Request, urlopen

PAGES = {
    "entries": "https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=entries_16230",
    "standings": "https://isu-skating.com/en/short-track/world-standings/",
    "ranking": "https://isu-skating.com/en/short-track/world-standings/615/",
}
for label, url in PAGES.items():
    with urlopen(Request(url, headers={"User-Agent":"Mozilla/5.0"}), timeout=25) as response:
        html = response.read(5_000_000).decode("utf-8")
    fragments = []
    for match in re.finditer(r'self\.__next_f\.push\(', html):
        try:
            frame, _ = json.JSONDecoder().raw_decode(html[match.end():])
            if len(frame) > 1 and isinstance(frame[1], str):
                fragments.append(frame[1])
        except ValueError:
            pass
    text = "\n".join(fragments)
    print("PAGE", label, len(html), len(text))
    if label == "entries":
        for marker in ("event_result_competitors_id", "event_result_id", "event_id", "eventResult", "entries", "competitorsData", "skaters_id"):
            pos = text.find(marker)
            print("FIELD", marker, "count", text.count(marker), "context", repr(text[max(0,pos-250):pos+250]))
        print("NEAR-FIRST", repr(text[max(0,text.find('"event_result_competitors_id"')-1100):text.find('"event_result_competitors_id"')+1100]))
        pos = text.find("Men 500 m")
        print("MEN500", repr(text[max(0,pos-200):pos+400]))
    elif label == "standings":
        index = text.find('"itemLists":')
        raw, _ = json.JSONDecoder().raw_decode(text[index+len('"itemLists":'):])
        wanted = [dict(id=x.get("world_standings_list_fsk_id"), name=x.get("name"), type=x.get("type"), level=x.get("level_name"), season=x.get("season_name"), gender=x.get("gender"), distance=x.get("discipline_distance"), date=x.get("calculation_date"), team=x.get("team_type")) for x in raw if x.get("season_name") in ("2025/2026","2026/2027") and x.get("level_name") != "Junior" and x.get("team_type") == "Singles"]
        print("STANDINGS_COUNT", len(raw), "TARGET", json.dumps(wanted, ensure_ascii=False))
    else:
        for marker in ('"itemLists":', '"worldStandingsData":', '"world_standings_list_fsk_id":', '"rank":', '"skaters_id":', '"data":'):
            pos=text.find(marker)
            print("FIELD", marker, "count", text.count(marker), "context", repr(text[max(0,pos-150):pos+450]))
