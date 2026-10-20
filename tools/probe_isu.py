"""Temporary inspection of the public ISU JavaScript pagination endpoints."""
import json
import re
from urllib.parse import urljoin
from urllib.request import Request, urlopen

def fetch(url):
    with urlopen(Request(url, headers={"User-Agent":"Mozilla/5.0"}), timeout=25) as r:
        return r.read(5_000_000).decode("utf-8")

urls = [
    "https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=entries_16230",
    "https://isu-skating.com/en/short-track/world-standings/",
    "https://isu-skating.com/en/short-track/world-standings/615/",
]
paths = set()
for url in urls:
    html=fetch(url)
    paths.update(urljoin(url, p) for p in re.findall(r'<script[^>]+src="([^"]+)', html))
    text="\n".join(json.JSONDecoder().raw_decode(html[m.end():])[0][1] for m in re.finditer(r'self\.__next_f\.push\(', html) if html[m.end():].lstrip().startswith("["))
    if "world-standings/" in url:
        for term in ('"initialData":','"itemLists":','"totalCount":','"total":','"page":','"pagination":','"selectedResult":'):
            i=text.find(term)
            if i>=0:
                value,end=json.JSONDecoder().raw_decode(text[i+len(term):])
                print("RSC",url.split("world-standings/")[-1][:25],term,
                      "shape",len(value) if isinstance(value,(list,dict)) else value,
                      "example",json.dumps(value[0] if isinstance(value,list) and value else value,ensure_ascii=False)[:500])
print("SCRIPTS",len(paths))
patterns=[r'get-event-result-competitors',r'get-event.*competitor',r'get-world-standings',r'get-world-standing',
          r'world_standings_list_fsk',r'initialPlayers',r'initialData',r'front-api.isu.org']
for path in sorted(paths):
    if "polyfills" in path or "webpack" in path:continue
    try: js=fetch(path)
    except Exception as exc:
        print("FETCH_ERR",path,repr(exc));continue
    found=[]
    for pat in patterns:
        match=re.search(pat,js,re.I)
        if match:found.append((pat,repr(js[max(0,match.start()-250):match.start()+500])))
    if found:
        print("SCRIPT",path,len(js))
        for k,context in found:print("HIT",k,context)
