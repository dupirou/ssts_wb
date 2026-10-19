#!/usr/bin/env python3
"""Conservative ISU HTML schedule checker: reject partial/changed programmes."""
import argparse,csv,io,json,re,sys
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parents[1]
PATH=ROOT/"data/vancouver.csv"
URL="https://www.isu-skating.com/en/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230"
DAY=re.compile(r"\b(2[345])\.10\.2026\b")
TIME=re.compile(r"^([0-2]\d):([0-5]\d)(?:\s+(.*))?$")
DIST=re.compile(r"\b(5000|3000|2000|1500|1000|500)\s*(?:m|metre|meter)",re.I)

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

def parse_text(text):
    lines=[re.sub(r"\s+"," ",line).strip() for line in text.splitlines()]
    lines=[line for line in lines if line]
    day=session=None
    out=[]
    for i,line in enumerate(lines):
        match=DAY.search(line)
        if match and line.startswith(match.group(0)):
            day=match.group(1);session=None;continue
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
        out.append({"day":day,"time":m.group(1)+":"+m.group(2),**event(name,session)})
    if len(out)!=62:raise ValueError("Partial or changed ISU timetable: "+str(len(out))+" rows (expected 62)")
    return out

def parse_html(html):
    from bs4 import BeautifulSoup
    soup=BeautifulSoup(html,"html.parser")
    for node in soup.select("script,style,nav,footer,header"):node.decompose()
    return parse_text(soup.get_text("\n",strip=True))

def compare_and_update(found,write=True,path=PATH):
    with Path(path).open(encoding="utf-8",newline="") as f:old=list(csv.DictReader(f))
    if len(found)!=len(old):raise ValueError("Round count changed")
    identity=("day","session","gender","distance","kind","round","group")
    changes=[]
    updated=[]
    previous=None
    for i,(a,b) in enumerate(zip(found,old),1):
        if tuple(a[x] for x in identity)!=tuple(b[x] for x in identity):
            raise ValueError("ISU identity/order differs on round "+str(i))
        current="2026-10-"+a["day"]+" "+a["time"]
        if previous and current<previous:raise ValueError("Non-chronological official programme")
        previous=current
        if a["time"]!=b["time"]:changes.append((i,b["time"],a["time"]))
        updated.append({**b,"time":a["time"]})
    if len(changes)>10:raise ValueError("Large change requires manual approval")
    if changes and write:
        buffer=io.StringIO(newline="")
        writer=csv.DictWriter(buffer,fieldnames=list(old[0]),lineterminator="\n")
        writer.writeheader();writer.writerows(updated)
        Path(path).write_text(buffer.getvalue(),encoding="utf-8")
    return changes

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--fixture");p.add_argument("--dry-run",action="store_true")
    args=p.parse_args()
    if args.fixture:html=Path(args.fixture).read_text(encoding="utf-8")
    else:
        req=Request(URL,headers={"User-Agent":"SSTS-WB-ScheduleChecker/1.0 (+https://github.com/dupirou/ssts_wb)","Accept":"text/html"})
        with urlopen(req,timeout=25) as response:
            content=response.read(2_000_001)
            if len(content)>2_000_000:raise ValueError("Official page too large")
            html=content.decode("utf-8")
    changes=compare_and_update(parse_html(html),not args.dry_run)
    if not args.dry_run:
        meta={"last_successful_schedule_check_utc":datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
              "source":"official_isu_schedule_html","notes":"Full 62-round identity verification passed"}
        (ROOT/"data/sync_meta.json").write_text(json.dumps(meta,indent=2)+"\n",encoding="utf-8")
    print("Official schedule accepted; time changes:",changes)

if __name__=="__main__":
    try:main()
    except Exception as exc:
        print("Safe ISU sync rejection:",exc,file=sys.stderr);sys.exit(1)
