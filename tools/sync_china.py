#!/usr/bin/env python3
"""Discover official ISU round pages and confirm CHN heats without inference.

Reads public ISU results pages, never attempts to guess a future start list.
If results are not yet published, exits cleanly without changing the known-good data.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup
import build
import tls
import stations

ROOT = Path(__file__).resolve().parents[1]
AUTO = ROOT / "data/china_auto.json"
CONFIG = ROOT / "data/china_sources.json"
INDEX = "https://www.isu-skating.com/en/short-track/results/"
ALLOWED = {"isu-skating.com", "www.isu-skating.com"}
RESULT_PATH = re.compile(r"^/(?:en/)?short-track/results/[^/?#]+/[^/?#]+/?$")
HEAT = re.compile(r"(?m)^Heat\s+(\d+)(?:\s*[-–]\s*Final\s*([AB]))?\s*$", re.I)
CHN_NAME = re.compile(r"^([A-Za-z][A-Za-z .'\-’]{2,85}?)\s*CHN$", re.I)
# Results appear from the first race day; late corrections for a few days after.
WINDOW_BEFORE_DAYS, WINDOW_AFTER_DAYS = 1, 3
MAX_BYTES = 2_500_000

def allowed(url):
    p = urlsplit(url)
    return p.scheme == "https" and p.hostname in ALLOWED and not p.username and not p.password

def fetch_page(url):
    if not allowed(url):
        raise ValueError("Non-official or insecure source URL: " + url)
    request = Request(url, headers={"User-Agent":"SSTS-WB-ChinaHeats/1.0 (+https://github.com/dupirou/ssts_wb)", "Accept":"text/html"})
    with urlopen(request, timeout=22, context=tls.CONTEXT) as response:
        if not allowed(response.geturl()):
            raise ValueError("Unexpected external redirect")
        size = response.read(MAX_BYTES + 1)
        if len(size) > MAX_BYTES:
            raise ValueError("ISU page exceeds size bound")
        return BeautifulSoup(size.decode("utf-8"), "html.parser")

def is_station(text, station):
    """A page names the station's city and year (accents ignored: Montréal is Montreal)."""
    return stations.plain(station["city_en"]) in stations.plain(text) and station["date_start"][:4] in text

def page_text(soup):
    for node in soup.select("script,style,nav,footer,header"):
        node.decompose()
    return soup.get_text("\n", strip=True)

def discover_event(index_soup, station, base=INDEX):
    """Only accept an explicit results listing for this station and year, not last season's."""
    for a in index_soup.find_all("a", href=True):
        href = urljoin(base, a["href"])
        if not allowed(href):
            continue
        if not RESULT_PATH.match(urlsplit(href).path):
            continue
        parent = a.find_parent(["article","li","section"]) or a.parent
        context = parent.get_text(" ", strip=True) if parent else ""
        context = (a.get_text(" ", strip=True) + " " + context)[:600]
        if is_station(context, station):
            return href
    return None

def discipline_from_text(text):
    label = re.sub(r"\s+", " ", text).strip().lower()
    if not label or len(label) > 50:
        return None
    if re.search(r"\b(mixed)\b", label) and "relay" in label:
        return ("mixed", 2000, "relay")
    sex = "women" if re.search(r"\b(women|ladies)\b",label) else "men" if re.search(r"\bmen\b",label) else None
    if sex is None:
        return None
    d = re.search(r"\b(5000|3000|1500|1000|500)\s*m?\b",label)
    if not d:
        return None
    distance = int(d.group(1))
    typ = "relay" if "relay" in label else "individual"
    return sex, distance, typ

def round_from_text(text):
    label = re.sub(r"\s+", " ",text).strip().lower()
    if not label or len(label) > 30:
        return None
    rep = bool(re.search(r"\brep(?:echage)?\b", label))
    if "prelim" in label:
        return ("preliminaries",rep)
    if "quarter" in label:
        return ("quarterfinal",rep)
    if "semi" in label:
        return ("semifinal",rep)
    if "heat" in label:
        return ("heats",rep)
    if "final" in label:
        return ("final",rep)
    return None

def official_links(soup, page_url):
    """URLs of official discipline tabs on a particular results event page."""
    result={}
    for a in soup.find_all("a",href=True):
        d=discipline_from_text(a.get_text(" ",strip=True))
        if d is None:
            continue
        url=urljoin(page_url,a["href"])
        p=urlsplit(url)
        if not allowed(url) or not RESULT_PATH.match(p.path):
            continue
        if not p.path.startswith(urlsplit(page_url).path.rsplit("/",2)[0]+"/"):
            continue
        result[d]=urlunsplit((p.scheme,p.netloc,p.path,"",""))
    # The active tab may be plain text; try the page itself using active category header.
    return result

def round_links(soup,page_url):
    rounds={}
    for a in soup.find_all("a",href=True):
        state=round_from_text(a.get_text(" ",strip=True))
        if not state:
            continue
        url=urljoin(page_url,a["href"])
        p=urlsplit(url)
        if (not allowed(url) or p.path != urlsplit(page_url).path or "round=" not in p.query):
            continue
        rounds[state]=url
    return rounds

def names_from_heat(chunk,relay=False):
    """Only pick nationality attached to a skater/team within a Heat block."""
    names=set()
    lines=[re.sub(r"\s+"," ",s).strip() for s in chunk.splitlines()]
    for i,line in enumerate(lines):
        match=CHN_NAME.fullmatch(line)
        if match:
            name=match.group(1).strip(" -")
            if not re.fullmatch(r"(?:People's Republic of )?China",name,re.I) and name.lower() not in ("team","isu member","results"):
                names.add(name)
            elif relay:
                names.add("中国队")
        elif line == "CHN" and i:
            # Official result tables often put nationality on the next line.
            prior=next((s for s in reversed(lines[max(0,i-3):i]) if s and not s.isdigit()),"")
            # ISU pages can show "ATHLETE CHN" followed by a separate
            # country column "CHN". Both refer to the same competitor.
            prior=re.sub(r"\s*CHN$", "", prior).strip()
            if prior and re.fullmatch(r"[A-Za-z][A-Za-z .'\-’]{2,85}",prior):
                names.add(prior)
            elif relay:
                names.add("中国队")
    return sorted(names)

def heats_from_page(soup,relay=False):
    lines=page_text(soup)
    parts=list(HEAT.finditer(lines))
    output=[]
    for i,match in enumerate(parts):
        section=lines[match.end():parts[i+1].start() if i+1<len(parts) else len(lines)]
        names=names_from_heat(section,relay)
        if names:
            number=int(match.group(1))
            if number < 1 or number > 40:
                raise ValueError("Implausible official heat index")
            # Final labels must explicitly come from source text; do not
            # guess which heat is Final A or Final B from position.
            group=match.group(2)
            header=section[:200]
            if not group:
                gm=re.search(r"(?i)\bFinal\s*([AB])\b",header)
                if gm:group=gm.group(1).upper()
            output.append({"number":number,"athletes":names,"final_group":group})
    return output

def round_matches(rows, discipline, round_info):
    sex, dist, kind=discipline
    stage,rep=round_info
    matches=[r for r in rows if r["gender"]==sex and r["distance_m"]==dist and
             r["format"]==kind and r["round"]==stage]
    if rep:
        return [r for r in matches if r["session"]=="repechage"]
    regular=[r for r in matches if r["session"]!="repechage"]
    return regular or matches

def collect_one(soup, url, discipline, round_info, rows, now, station):
    text=page_text(BeautifulSoup(str(soup),"html.parser"))
    if not is_station(text[:1400], station):
        raise ValueError("Result page is not labelled with the station's city and year")
    candidates=round_matches(rows,discipline,round_info)
    found=heats_from_page(BeautifulSoup(str(soup),"html.parser"),discipline[2]=="relay")
    result=[]
    for row in candidates:
        heats=[{"number":h["number"],"athletes":h["athletes"]} for h in found
               if row["round"]!="final" or h["final_group"]==row["group"]]
        if not heats:
            continue
        if row["round"]!="final" and len(candidates)!=1:
            raise ValueError("Ambiguous round/day mapping")
        if len(set(h["number"] for h in heats))!=len(heats):
            raise ValueError("Duplicated official heats")
        result.append({"round_key":row["round_key"],"country":"CHN",
                       "evidence":"official_round_results","source_url":url,
                       "verified_at":now,"heats":heats})
    return result

def sync(station_id, event_url=None, dry_run=False, fetcher=fetch_page, now=None):
    timestamp=now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    station=stations.get(station_id)
    rows=build.read_schedule(station_id)
    if not rows:
        print(station_id,"has no official programme yet")
        return 0
    config=json.loads(CONFIG.read_text(encoding="utf-8"))
    if config.get("schema_version")!=2:
        raise ValueError("Invalid results source configuration")
    if event_url is None:
        event_url=config["event_results_urls"].get(station_id)
    if not event_url:
        event_url=discover_event(fetcher(INDEX), station=station)
    if not event_url:
        print(station_id,"official results not published in ISU results index")
        return 0
    if not allowed(event_url) or not RESULT_PATH.match(urlsplit(event_url).path):
        raise ValueError("Invalid event results URL")
    start=fetcher(event_url)
    if not is_station(page_text(BeautifulSoup(str(start),"html.parser"))[:1500], station):
        raise ValueError("Refusing results from another event or year")
    categories=official_links(start,event_url)
    # Strict source identity: all links must remain inside the event's results path.
    if not categories:
        print(station_id,"no official discipline pages yet")
        return 0
    proposed={}
    requests=0
    existing=json.loads(AUTO.read_text(encoding="utf-8"))
    if existing.get("schema_version")!=1 or not isinstance(existing.get("heats"),list):
        raise ValueError("Invalid stored results")
    # Rounds the official results feed already covers take precedence in build, and
    # rounds already confirmed here do not change: neither page is requested again.
    import competition_data
    _, covered=competition_data.china_evidence(competition_data.load_snapshot(station_id))
    settled=covered | {x["round_key"] for x in existing["heats"]}
    for disc, disc_url in categories.items():
        disc_page=fetcher(disc_url)
        requests+=1
        for round_info, round_url in round_links(disc_page,disc_url).items():
            candidates=round_matches(rows,disc,round_info)
            if not candidates or all(r["round_key"] in settled for r in candidates):
                continue
            round_page=fetcher(round_url)
            requests+=1
            for item in collect_one(round_page,round_url,disc,round_info,rows,timestamp,station):
                key=item["round_key"]
                if key in proposed and proposed[key]["heats"]!=item["heats"]:
                    raise ValueError("Conflicting heat lists for "+key)
                proposed[key]=item
            if requests>=90:
                raise ValueError("Exceeded source traversal cap")
    # Source can temporarily be incomplete. Never clear confirmed rounds. The file holds every
    # station's rounds; round keys start with the race date, so stations never collide.
    merged={x["round_key"]:x for x in existing["heats"]}
    changed=0
    for key,item in proposed.items():
        prev=merged.get(key)
        if prev is None or prev["heats"]!=item["heats"] or prev["source_url"]!=item["source_url"]:
            merged[key]=item
            changed+=1
    result={"schema_version":1,"heats":sorted(merged.values(),key=lambda x:x["round_key"])}
    if changed and not dry_run:
        # Validate whole candidate against existing schedule before committing.
        original=build.CHINA
        try:
            build.CHINA=AUTO
            # Ensure a newly written bad file cannot survive validation failure.
            temp=AUTO.with_suffix(".candidate.json")
            temp.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
            build.CHINA=temp
            build.attach_china(build.read_schedule(station_id),station_id)
            temp.replace(AUTO)
        finally:
            build.CHINA=original
            temp=AUTO.with_suffix(".candidate.json")
            if temp.exists():temp.unlink()
    print(station_id,"ISU China heat evidence found:",len(proposed),"updated:",changed)
    return changed

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--station",help="Station ID; default: every station racing now or just finished")
    p.add_argument("--event-url",help="Verified official results landing page for --station")
    p.add_argument("--dry-run",action="store_true")
    a=p.parse_args()
    now=datetime.now(timezone.utc)
    failed=False
    for station in stations.stations():
        if a.station and station["id"]!=a.station:
            continue
        if not a.station and not stations.within(station,now,WINDOW_BEFORE_DAYS,WINDOW_AFTER_DAYS):
            continue
        try:
            sync(station["id"],event_url=a.event_url if a.station else None,dry_run=a.dry_run)
        except Exception as exc:
            failed=True
            print(station["id"],"China results sync rejected; retaining previously verified evidence:",str(exc),file=sys.stderr)
    return int(failed)

if __name__=="__main__":
    sys.exit(main())
