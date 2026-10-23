#!/usr/bin/env python3
"""Conservative ISU HTML schedule checker for every station: reject partial or garbled programmes.

A station's programme is recorded the first time ISU publishes a complete one (every World Tour
discipline reaches its Final A, all on the station's own dates, in time order). Before racing
starts ISU may still restructure the tentative programme and the new one replaces it whole; once
racing has started only time changes are accepted, and more than ten at once need manual review.
"""
import argparse,csv,io,json,re,sys
from pathlib import Path
from urllib.parse import urljoin,urlsplit
from urllib.request import Request,urlopen
import stations
import tls

ROOT=Path(__file__).resolve().parents[1]
EVENTS="https://www.isu-skating.com/en/short-track/events/"
HOSTS={"www.isu-skating.com","isu-skating.com"}
DAY=re.compile(r"(\d{2})\.(\d{2})\.(\d{4})\b")
TIME=re.compile(r"^([0-2]\d):([0-5]\d)(?:\s+(.*))?$")
DIST=re.compile(r"\b(5000|3000|2000|1500|1000|500)\s*(?:m|metre|meter)",re.I)
FIELDS=["date","time","session","gender","distance","kind","round","group"]
IDENTITY=("date","session","gender","distance","kind","round","group")
DISTANCES={("I",500),("I",1000),("I",1500),("R",2000),("R",3000),("R",5000)}
# Every World Tour stage races these nine; a programme missing one's Final A is partial.
REQUIRED={("W","500","I"),("M","500","I"),("W","1000","I"),("M","1000","I"),("W","1500","I"),
          ("M","1500","I"),("W","3000","R"),("M","5000","R"),("X","2000","R")}
MAX_TIME_CHANGES=10
# Stop looking once a station's racing is over; start well before ISU usually publishes.
LOOKAHEAD_DAYS=45

def event(label,session):
    x=re.sub(r"\s+"," ",label).lower().strip()
    d=DIST.search(x)
    sex="X" if re.search(r"\bmixed\b",x) else "W" if re.search(r"\b(women|women.s|ladies)\b",x) else "M" if re.search(r"\b(men|men.s)\b",x) else None
    if not d or not sex:raise ValueError("Unrecognized event: "+label)
    distance=int(d.group(1))
    fmt="R" if "relay" in x else "I"
    group="-"
    if re.search(r"\bfinal\s*b\b|\bb\s*final\b",x):round_="F";group="B"
    elif re.search(r"\bfinal\s*a\b|\ba\s*final\b",x):round_="F";group="A"
    elif "quarter" in x:round_="Q"
    elif "semi" in x:round_="S"
    elif "prelim" in x:round_="P"
    elif re.search(r"\bheats?\b",x):round_="H"
    elif "final" in x:round_="F";group="A"
    else:raise ValueError("Unrecognized round: "+label)
    return {"session":session,"gender":sex,"distance":str(distance),"kind":fmt,"round":round_,"group":group}

def parse_text(text,station=None):
    station=station or stations.get("vancouver")
    allowed={d.isoformat() for d in stations.dates(station)}
    lines=[re.sub(r"\s+"," ",line).strip() for line in text.splitlines()]
    lines=[line for line in lines if line]
    day=session=None
    out=[]
    for i,line in enumerate(lines):
        match=DAY.match(line)
        if match:
            iso="-".join(reversed(match.groups()))
            # Practice or travel days outside the station's dates carry no racing rows.
            day=iso if iso in allowed else None;session=None;continue
        low=line.lower()
        if day and "session" in low:
            if "qualif" in low:session="Q"
            elif "repechage" in low:session="R"
            elif "main" in low:session="F"
            continue
        if not day or not session:continue
        m=TIME.match(line)
        if not m:continue
        name=m.group(3) or (lines[i+1] if i+1<len(lines) else "")
        if not re.search(r"\b(women|men|mixed|ladies)\b",name,re.I):continue
        out.append({"date":day,"time":m.group(1)+":"+m.group(2),**event(name,session)})
    return out

def validate(rows,station):
    """Shared by sync and build: a stored programme is always a complete, ordered one."""
    allowed={d.isoformat() for d in stations.dates(station)}
    seen=set();finals=set();previous=None
    for n,r in enumerate(rows,1):
        if r["date"] not in allowed or not re.fullmatch(r"[0-2]\d:[0-5]\d",r["time"]):
            raise ValueError("Programme row outside the station's dates on row "+str(n))
        if (r["session"] not in ("Q","R","F") or r["gender"] not in ("W","M","X") or r["kind"] not in ("I","R")
                or r["round"] not in ("P","H","Q","S","F") or not r["distance"].isdigit()):
            raise ValueError("Invalid event fields on row "+str(n))
        if (r["kind"],int(r["distance"])) not in DISTANCES or (r["gender"]=="X" and (r["kind"],r["distance"])!=("R","2000")):
            raise ValueError("Invalid distance/format on row "+str(n))
        if (r["round"]=="F")!=(r["group"] in ("A","B")) or (r["round"]!="F" and r["group"]!="-"):
            raise ValueError("Invalid final group on row "+str(n))
        ident=tuple(r[k] for k in IDENTITY)
        if ident in seen:raise ValueError("Ambiguous duplicated official round on row "+str(n))
        seen.add(ident)
        current=r["date"]+" "+r["time"]
        if previous and current<previous:raise ValueError("Non-chronological official programme")
        previous=current
        if r["round"]=="F" and r["group"]=="A":finals.add((r["gender"],r["distance"],r["kind"]))
    missing=REQUIRED-finals
    if missing:
        raise ValueError("Partial or changed ISU timetable: no Final A for "+", ".join("/".join(m) for m in sorted(missing)))
    return rows

def read(path):
    if not Path(path).exists():return None
    with Path(path).open(encoding="utf-8",newline="") as f:return list(csv.DictReader(f))

def merge(found,old,station,now):
    """Return (action, rows to store or None, time changes) for an already validated programme."""
    if old is None:return "created",found,[]
    started=now>=stations.local_start(station)
    if [tuple(a[k] for k in IDENTITY) for a in found]!=[tuple(b[k] for k in IDENTITY) for b in old]:
        if started:raise ValueError("ISU identity/order changed after racing began; manual review required")
        return "replaced",found,[]
    changes=[(i,b["time"],a["time"]) for i,(a,b) in enumerate(zip(found,old),1) if a["time"]!=b["time"]]
    if not changes:return "unchanged",None,[]
    if len(changes)>MAX_TIME_CHANGES and started:raise ValueError("Large change requires manual approval")
    return "times",[{**b,"time":a["time"]} for a,b in zip(found,old)],changes

def write(rows,path):
    buffer=io.StringIO(newline="")
    writer=csv.DictWriter(buffer,fieldnames=FIELDS,lineterminator="\n")
    writer.writeheader();writer.writerows({k:r[k] for k in FIELDS} for r in rows)
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    candidate=Path(path).with_suffix(".tmp")
    candidate.write_text(buffer.getvalue(),encoding="utf-8")
    candidate.replace(path)

def compare_and_update(found,write_file=True,path=None,station=None,now=None):
    station=station or stations.get("vancouver")
    path=path or stations.schedule_path(station["id"])
    action,rows,changes=merge(validate(found,station),read(path),station,now or stations.utc_now())
    if rows is not None and write_file:write(rows,path)
    return action,changes

def page_text(html):
    from bs4 import BeautifulSoup
    soup=BeautifulSoup(html,"html.parser")
    for node in soup.select("script,style,nav,footer,header"):node.decompose()
    return soup.get_text("\n",strip=True)

def identity(text,station):
    """ISU event pages head with 'City / CAN' and '30.10-01.11, 2026'."""
    days=stations.dates(station)
    span=f"{days[0]:%d.%m}-{days[-1]:%d.%m}, {days[-1]:%Y}"
    flat=stations.plain(re.sub(r"\s+"," ",text))
    return span in flat and stations.plain(station["city_en"]+" / "+station["country"]) in flat

def fetch(url):
    p=urlsplit(url)
    if p.scheme!="https" or p.hostname not in HOSTS or p.username or p.password:raise ValueError("Non-official source refused")
    req=Request(url,headers={"User-Agent":"SSTS-WB-ScheduleChecker/1.0 (+https://github.com/dupirou/ssts_wb)","Accept":"text/html"})
    with urlopen(req,timeout=25,context=tls.CONTEXT) as response:
        if urlsplit(response.geturl()).hostname not in HOSTS:raise ValueError("Unexpected external redirect")
        content=response.read(3_000_001)
        if len(content)>3_000_000:raise ValueError("Official page too large")
        return content.decode("utf-8")

def discover(station,taken,fetcher=fetch,limit=12):
    """Find a station's ISU event page on ISU's events listing by its dates, city and country."""
    listing=fetcher(EVENTS)
    slugs=list(dict.fromkeys(re.findall(r"/short-track/events/eventdetail/(isu-short-track-[a-z0-9-]+)/",listing)))
    for slug in [s for s in slugs if s not in taken][:limit]:
        html=fetcher(urljoin(EVENTS,"eventdetail/"+slug+"/"))
        if not identity(page_text(html)[:5000],station):continue
        # Event tabs carry the event id (tab=schedule_16272); short ids belong to shared tabs.
        ids={i for i in re.findall(r"[?&]tab=[a-z]+_(\d+)",html) if len(i)>=4}
        if len(ids)!=1:raise ValueError("Ambiguous ISU event id for "+station["id"])
        return {"slug":slug,"event_id":int(ids.pop())}
    return None

def sync_station(station,fetcher=fetch,now=None,directory=stations.SCHEDULES,meta=None):
    """Check one station's official programme. Returns (action, time changes)."""
    now=now or stations.utc_now()
    meta=meta if meta is not None else {}
    url=stations.page_url(station,"schedule")
    html=fetcher(url)
    text=page_text(html)
    if not identity(text[:5000],station):raise ValueError("ISU page is not labelled with the station's city and dates")
    found=parse_text(text,station)
    if not found:
        # The requested URL itself names the schedule tab, so ask the plain event page whether
        # ISU lists one: a listed tab without readable rows is a parsing failure, not "unpublished".
        if re.search(rf"[?&]tab=schedule_{station['isu']['event_id']}\b",fetcher(stations.page_url(station))):
            raise ValueError("Schedule tab is published but no programme rows could be read")
        return "not_published",[]
    path=stations.schedule_path(station["id"],directory)
    action,rows,changes=merge(validate(found,station),read(path),station,now)
    if rows is not None:write(rows,path)
    stamp=now.isoformat()
    last=(meta.get(station["id"]) or {}).get("last_successful_schedule_check_utc") or ""
    # A successful check is published once per UTC day, or immediately when the programme changed.
    if rows is not None or last[:10]!=stamp[:10]:
        meta[station["id"]]={"last_successful_schedule_check_utc":stamp,"source":"official_isu_schedule_html","source_url":url,
                             "notes":"Full programme verification passed: every discipline reaches its Final A on the station's dates."}
    return action,changes

def save_stations(config,path=stations.CONFIG):
    path.write_text(json.dumps(config,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--station",help="Check one station id; default: every station due a check")
    p.add_argument("--fixture",help="Parse a saved schedule page instead of fetching (requires --station)")
    args=p.parse_args()
    now=stations.utc_now()
    config=stations.load()
    meta=stations.load_meta()
    if args.fixture:
        station=stations.get(args.station)
        rows=validate(parse_text(page_text(Path(args.fixture).read_text(encoding="utf-8")),station),station)
        print("Fixture programme valid:",len(rows),"rounds");return 0
    failed=False
    taken={s["isu"]["slug"] for s in config["stations"]+config["championships"] if s.get("isu")}
    for station in config["stations"]:
        if args.station and station["id"]!=args.station:continue
        if not args.station and not stations.within(station,now,LOOKAHEAD_DAYS,0):continue
        try:
            if not station.get("isu"):
                found=discover(station,taken)
                if not found:
                    print(station["id"],"ISU event page not listed yet");continue
                station["isu"]=found;taken.add(found["slug"]);save_stations(config)
                print(station["id"],"ISU event page found:",found)
            action,changes=sync_station(station,now=now,meta=meta)
            print(station["id"],"official schedule",action,"; time changes:",changes)
        except Exception as exc:
            failed=True
            print(f"::warning::{station['id']}: ISU schedule rejected, keeping the last verified programme: {exc}",file=sys.stderr)
    stations.save_meta(meta)
    return int(failed)

if __name__=="__main__":
    sys.exit(main())
