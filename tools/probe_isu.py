"""Temporary read-only source probe for ISU distance entry and ranking APIs."""
import json
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE="https://front-api.isu.org"
ENTRY_PAGE="https://isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=entries_16230"
def fetch(url, data=None, content_type="application/x-www-form-urlencoded"):
    raw=None if data is None else (json.dumps(data).encode() if content_type=="application/json" else urlencode(data).encode())
    req=Request(url,data=raw,headers={"User-Agent":"Mozilla/5.0","Content-Type":content_type,"Accept":"application/json"})
    with urlopen(req,timeout=25) as r:return r.read(10_000_000)
def rsc(html, key):
    text="\n".join(frame[1] for m in re.finditer(r'self\.__next_f\.push\(',html) if
       (frame:=json.JSONDecoder().raw_decode(html[m.end():])[0]) and len(frame)>1 and isinstance(frame[1],str))
    marker='"'+key+'":'
    pos=text.find(marker)
    if pos<0:raise ValueError("missing "+key)
    return json.JSONDecoder().raw_decode(text[pos+len(marker):])[0]
def summarize(label,body):
    obj=json.loads(body)
    print(label, "keys",list(obj) if isinstance(obj,dict) else type(obj).__name__)
    val=obj.get("data") if isinstance(obj,dict) else obj
    print(label,"data shape",len(val) if isinstance(val,(list,dict)) else type(val).__name__,
          "example",json.dumps(val[0] if isinstance(val,list) and val else {k:(len(v) if isinstance(v,list) else v) for k,v in val.items()} if isinstance(val,dict) else val,ensure_ascii=False)[:1500])
    return obj
events=rsc(fetch(ENTRY_PAGE).decode(),"eventResults")
events=[x for x in events if x["discipline_type"]=="Singles"]
print("EVENTS",[(x["name"],x["event_result_id"],x["event_id"]) for x in events])
for event in events[:2]:
    id=event["event_result_id"]
    summarize("ENTRY_"+event["name"],fetch(BASE+"/events/get-event-result-entrylist-single",
                        {"event_result_id":id,"event_id":16230,"country_code":""}))
for typ,data in [
    ("LIST",{"discipline_id":3,"season_id":1,"pagesize":300,"page":1}),
    ("DETAIL",{"world_standings_list_fsk_id":615,"page":1}),
    ("DETAIL_NEXT",{"world_standings_list_fsk_id":615,"page":2})]:
    end="/events/get-world-standings-list" if typ=="LIST" else "/events/get-world-standings-fsk-detail-skater-single"
    summarize(typ,fetch(BASE+end,data,"application/json"))
