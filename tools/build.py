#!/usr/bin/env python3
"""Compile strictly verified provisional ISU timetable and China start-list evidence."""
import csv
import json
import shutil
import competition_data
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/vancouver.csv"
CHINA = ROOT / "data/china.json"
OUT = ROOT / "dist"
VAN = ZoneInfo("America/Vancouver")
BJ = ZoneInfo("Asia/Shanghai")
SCHEDULE_URL = "https://www.isu-skating.com/ja/short-track/events/eventdetail/isu-short-track-world-tour-1/?tab=schedule_16230"
CALENDAR_URL = "https://www.isu-skating.com/en/short-track/news/isu-short-track-event-calendar-202627/"
EXPECTED = {"2026-10-23": 14, "2026-10-24": 25, "2026-10-25": 23}
STAGES = {"Q": "qualifying", "R": "repechage", "F": "main"}
GENDERS = {"W": "women", "M": "men", "X": "mixed"}
ROUNDS = {"P": "preliminaries", "H": "heats", "Q": "quarterfinal", "S": "semifinal", "F": "final"}
# Initial engineering assumptions only, not calibrated ISU data (min, max minutes / heat).
HEAT_DURATIONS = {("I",500):(2.5,4.0), ("I",1000):(3.0,5.0),
                  ("I",1500):(4.0,7.0), ("R",2000):(6.0,10.0),
                  ("R",3000):(7.0,12.0), ("R",5000):(8.0,15.0)}
VENUES = [
 ("vancouver","温哥华","Vancouver","2026-10-23","2026-10-25","America/Vancouver","Pacific Coliseum","CAN"),
 ("montreal","蒙特利尔","Montreal","2026-10-30","2026-11-01","America/Toronto",None,"CAN"),
 ("seoul","首尔","Seoul","2026-11-20","2026-11-22","Asia/Seoul",None,"KOR"),
 ("shanghai","上海","Shanghai","2026-11-27","2026-11-29","Asia/Shanghai",None,"CHN"),
 ("beijing","北京","Beijing","2026-12-04","2026-12-06","Asia/Shanghai",None,"CHN"),
 ("gdansk","格但斯克","Gdansk","2027-02-05","2027-02-07","Europe/Warsaw",None,"POL"),
 ("tilburg","蒂尔堡","Tilburg","2027-02-12","2027-02-14","Europe/Amsterdam",None,"NED"),
]

def read_schedule():
    with SOURCE.open(encoding="utf-8", newline="") as f:
        data = list(csv.DictReader(f))
    if len(data) != 62:
        raise ValueError("Unexpected number of ISU rounds; manual identity review required")
    result = []
    for n, row in enumerate(data, 1):
        d, t = row["day"], row["time"]
        st, sex, typ, rnd = row["session"], row["gender"], row["kind"], row["round"]
        dist, group = int(row["distance"]), row["group"]
        if d not in ("23","24","25") or st not in STAGES or sex not in GENDERS or typ not in ("I","R") or rnd not in ROUNDS:
            raise ValueError("Invalid event fields on row " + str(n))
        if (rnd == "F") != (group in ("A","B")) or (rnd != "F" and group != "-"):
            raise ValueError("Invalid final group on row " + str(n))
        if (typ, dist) not in HEAT_DURATIONS or (sex == "X" and (typ,dist) != ("R",2000)):
            raise ValueError("Invalid distance/format on row " + str(n))
        local = datetime.strptime(f"2026-10-{d} {t}", "%Y-%m-%d %H:%M").replace(tzinfo=VAN)
        if local.utcoffset().total_seconds() != -25200:
            raise ValueError("Unexpected timezone / daylight saving")
        utc = local.astimezone(timezone.utc)
        bj = utc.astimezone(BJ)
        key = "/".join((f"2026-10-{d}",STAGES[st],GENDERS[sex],str(dist),ROUNDS[rnd],group))
        result.append({
            "id":key.replace("/","-"),"round_key":key,
            "local_date":f"2026-10-{d}","local_time":t,
            "local_start":local.isoformat(),"utc_start":utc.isoformat().replace("+00:00","Z"),
            "beijing_date":bj.strftime("%Y-%m-%d"),"beijing_time":bj.strftime("%H:%M"),
            "session":STAGES[st],"gender":GENDERS[sex],"distance_m":dist,
            "format":"relay" if typ=="R" else "individual","round":ROUNDS[rnd],
            "group":None if group=="-" else group,"status":"scheduled",
            "china":{"status":"unknown","heats":[]}
        })
    if Counter(r["local_date"] for r in result) != EXPECTED:
        raise ValueError("Per-day programme count mismatch")
    if len({r["round_key"] for r in result}) != len(result):
        raise ValueError("Ambiguous duplicated official round")
    times = [r["utc_start"] for r in result]
    if times != sorted(times):
        raise ValueError("Programme times are not chronological")
    return result

def valid_evidence(url):
    parsed = urlsplit(url)
    return parsed.scheme == "https" and parsed.hostname in {
        "www.isu-skating.com","isu-skating.com","www.isu.org","isu.org",
        "shorttrack.sportresult.com"
    } and not parsed.username and not parsed.password

def attach_china(rows):
    # The human-reviewed file wins any disagreement with the automatic
    # result importer. Both files are source-validated before acceptance.
    data = json.loads(CHINA.read_text(encoding="utf-8"))
    auto_path = ROOT / "data/china_auto.json"
    auto = json.loads(auto_path.read_text(encoding="utf-8")) if auto_path.exists() else {"schema_version":1,"heats":[]}
    for obj in (data, auto):
        if obj.get("schema_version") != 1 or not isinstance(obj.get("heats"),list):
            raise ValueError("Invalid China provenance schema")
    new_evidence, covered = competition_data.china_evidence(competition_data.load_snapshot('vancouver'))
    auto['heats'] = new_evidence + [item for item in auto['heats'] if item['round_key'] not in covered]
    lookup = {r["round_key"]:r for r in rows}
    seen = set()
    for item in data["heats"] + auto["heats"]:
        # Explicitly reviewed overrides remain authoritative; the auto file
        # may still carry the previous official result after a correction.
        if item.get("round_key") in seen:
            continue
        key = item.get("round_key")
        if key not in lookup:
            raise ValueError("China record references unknown round_key")
        seen.add(key)
        if item.get("country") != "CHN" or item.get("evidence") not in ("official_start_list","official_round_results") or not valid_evidence(item.get("source_url","")):
            raise ValueError("CHN highlight needs an official exact-round start-list URL")
        verified_at = datetime.fromisoformat(item["verified_at"].replace("Z","+00:00"))
        if not verified_at.tzinfo:
            raise ValueError("Verification timestamp must be timezone-aware")
        heats = item.get("heats")
        if not isinstance(heats,list) or not heats:
            raise ValueError("Confirmed round needs at least one verified heat")
        seen_heat = set()
        confirmed = []
        row = lookup[key]
        typ = "R" if row["format"]=="relay" else "I"
        lo,hi = HEAT_DURATIONS[(typ,row["distance_m"])]
        base = datetime.fromisoformat(row["local_start"])
        for heat in heats:
            number = heat.get("number")
            athletes = heat.get("athletes")
            if type(number) is not int or not (1 <= number <= 40) or number in seen_heat:
                raise ValueError("Invalid heat index")
            if not isinstance(athletes,list) or not athletes or not all(isinstance(a,str) and a.strip() for a in athletes):
                raise ValueError("Missing verified Chinese athlete or team names")
            seen_heat.add(number)
            a,b = base+timedelta(minutes=(number-1)*lo),base+timedelta(minutes=(number-1)*hi)
            confirmed.append({
                "number":number,"athletes":athletes,
                "estimate":{"status":"model_estimate_not_official",
                    "earliest_local":a.isoformat(),"latest_local":b.isoformat(),
                    "earliest_beijing":a.astimezone(BJ).isoformat(),
                    "latest_beijing":b.astimezone(BJ).isoformat(),
                    "assumed_minutes_per_heat":[lo,hi]}
            })
        row["china"]={"status":"confirmed","heats":sorted(confirmed,key=lambda h:h["number"]),
                      "source_url":item["source_url"],"verified_at":item["verified_at"]}
    return rows

def export():
    rows=attach_china(read_schedule())
    meta=json.loads((ROOT/"data/sync_meta.json").read_text(encoding="utf-8"))
    stations=[dict(id=a,city=b,city_en=c,date_start=d,date_end=e,timezone=f,venue=g,country=k,
                   detail_status="verified" if a=="vancouver" else "not_entered")
              for a,b,c,d,e,f,g,k in VENUES]
    season={"schema_version":1,"season":"2026/27","source_url":CALENDAR_URL,
            "stations":stations,"notice":"其他分站的详细赛程尚未录入。"}
    schedule={"schema_version":1,"event_id":"vancouver","source_url":SCHEDULE_URL,
              "source_timezone":"America/Vancouver","status":"provisional",
              "source_checked_at":"2026-10-20","sync":meta,
              "notice":"ISU暂定轮次时间；中国队单组时间仅是非官方模型估算。",
              "day_counts":EXPECTED,"total_items":len(rows),"entries":rows}
    (OUT/"data").mkdir(parents=True,exist_ok=True)
    for path,obj in (("calendar.json",season),("vancouver.json",schedule)):
        (OUT/"data"/path).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    shutil.copyfile(ROOT/"web/index.html",OUT/"index.html")
    shutil.copyfile(ROOT/"web/app.js",OUT/"app.js")
    shutil.copyfile(ROOT/"web/site.css",OUT/"site.css")
    competition_data.export(OUT, VENUES)
    import predict_groups
    predict_groups.export(OUT, VENUES, rows)
    print("Validated and built",len(rows),"ISU round start times; verified CHN:",sum(r["china"]["status"]=="confirmed" for r in rows))

if __name__ == "__main__":
    export()
