#!/usr/bin/env python3
"""Compile strictly verified provisional ISU timetable and China start-list evidence."""
import hashlib
import json
import shutil
import competition_data
import stations
import sync_schedule
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CHINA = ROOT / "data/china.json"
OUT = ROOT / "dist"
BJ = ZoneInfo("Asia/Shanghai")
CONFIG = stations.load()
CALENDAR_URL = CONFIG["calendar_url"]
STAGES = {"Q": "qualifying", "R": "repechage", "F": "main"}
GENDERS = {"W": "women", "M": "men", "X": "mixed"}
ROUNDS = {"P": "preliminaries", "H": "heats", "Q": "quarterfinal", "S": "semifinal", "F": "final"}
# Initial engineering assumptions only, not calibrated ISU data (min, max minutes / heat).
HEAT_DURATIONS = {("I",500):(2.5,4.0), ("I",1000):(3.0,5.0),
                  ("I",1500):(4.0,7.0), ("R",2000):(6.0,10.0),
                  ("R",3000):(7.0,12.0), ("R",5000):(8.0,15.0)}
VENUES = stations.venues()
SOURCE = stations.schedule_path("vancouver")

# Championships are independent events, never counted as World Tour stages.
CHAMPIONSHIPS = [
    dict({k: v for k, v in c.items() if k != "isu"}, detail_status="not_entered", source_url=CALENDAR_URL)
    for c in CONFIG["championships"]
]

def read_schedule(station_id="vancouver", directory=stations.SCHEDULES):
    """A station's stored official programme as Beijing-time rows; [] until ISU publishes one."""
    station = stations.get(station_id)
    data = sync_schedule.read(stations.schedule_path(station_id, directory))
    if data is None:
        return []
    sync_schedule.validate(data, station)
    tz = ZoneInfo(station["timezone"])
    result = []
    for row in data:
        d, t = row["date"], row["time"]
        st, sex, typ, rnd = row["session"], row["gender"], row["kind"], row["round"]
        dist, group = int(row["distance"]), row["group"]
        naive = datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M")
        local = naive.replace(tzinfo=tz)
        if local.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) != naive:
            raise ValueError("Start time does not exist in the station's timezone: " + d + " " + t)
        utc = local.astimezone(timezone.utc)
        bj = utc.astimezone(BJ)
        key = "/".join((d,STAGES[st],GENDERS[sex],str(dist),ROUNDS[rnd],group))
        result.append({
            "id":key.replace("/","-"),"round_key":key,
            "local_date":d,"local_time":t,
            "local_start":local.isoformat(),"utc_start":utc.isoformat().replace("+00:00","Z"),
            "beijing_date":bj.strftime("%Y-%m-%d"),"beijing_time":bj.strftime("%H:%M"),
            "session":STAGES[st],"gender":GENDERS[sex],"distance_m":dist,
            "format":"relay" if typ=="R" else "individual","round":ROUNDS[rnd],
            "group":None if group=="-" else group,"status":"scheduled",
            "china":{"status":"unknown","heats":[]}
        })
    if len({r["round_key"] for r in result}) != len(result):
        raise ValueError("Ambiguous duplicated official round")
    return result

def valid_evidence(url):
    if competition_data.reviewed_source(url):
        return True
    parsed = urlsplit(url)
    return parsed.scheme == "https" and parsed.hostname in {
        "www.isu-skating.com","isu-skating.com","www.isu.org","isu.org",
        "shorttrack.sportresult.com"
    } and not parsed.username and not parsed.password

def attach_china(rows, station_id="vancouver"):
    # The human-reviewed file wins any disagreement with the automatic
    # result importer. Both files are source-validated before acceptance.
    # Both files cover every station; a round key's date says which station it belongs to.
    data = json.loads(CHINA.read_text(encoding="utf-8"))
    auto_path = ROOT / "data/china_auto.json"
    auto = json.loads(auto_path.read_text(encoding="utf-8")) if auto_path.exists() else {"schema_version":1,"heats":[]}
    for obj in (data, auto):
        if obj.get("schema_version") != 1 or not isinstance(obj.get("heats"),list):
            raise ValueError("Invalid China provenance schema")
    new_evidence, covered = competition_data.china_evidence(competition_data.published_snapshot(station_id))
    auto['heats'] = new_evidence + [item for item in auto['heats'] if item['round_key'] not in covered]
    lookup = {r["round_key"]:r for r in rows}
    days = {d.isoformat() for d in stations.dates(stations.get(station_id))}
    seen = set()
    for item in data["heats"] + auto["heats"]:
        if str(item.get("round_key"))[:10] not in days:
            continue
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

def load_ticketing():
    """Validate curated ticket links before publishing them to the calendar."""
    from urllib.parse import urlsplit
    path = ROOT / "data/tickets.json"
    cfg = json.loads(path.read_text(encoding="utf-8"))
    if cfg.get("schema_version") != 1 or not isinstance(cfg.get("stations"), dict):
        raise ValueError("Invalid ticket information schema")
    allowed = {st["id"] for st in CONFIG["stations"]}
    result = {}
    for station, item in cfg["stations"].items():
        if station not in allowed or not isinstance(item, dict):
            raise ValueError("Unknown ticket event")
        for field, host in (("isu_url", "isu-skating.com"), ("booking_url", "m.ticketlink.co.kr")):
            u = urlsplit(item.get(field, ""))
            if u.scheme != "https" or u.hostname != host or u.username or u.password:
                raise ValueError("Invalid ticket source: " + field)
        start = datetime.fromisoformat(item["sale_start"])
        if start.tzinfo is None or start.utcoffset().total_seconds() != 9 * 3600:
            raise ValueError("Ticket opening must include Korea timezone")
        result[station] = {"sale_start": item["sale_start"], "isu_url": item["isu_url"],
                           "booking_url": item["booking_url"]}
    return result

def export():
    import predict_groups
    meta=stations.load_meta()
    ticketing=load_ticketing()
    schedules={}
    for st in CONFIG["stations"]:
        rows=read_schedule(st["id"])
        if rows:
            schedules[st["id"]]=attach_china(rows,st["id"])
    season={"schema_version":1,"season":CONFIG["season"],"source_url":CALENDAR_URL,
            "stations":[dict({k:st[k] for k in stations.FIELDS},ticketing=ticketing.get(st["id"]),
                             detail_status="verified" if st["id"] in schedules else "not_entered",
                             predictions=predict_groups.load_inputs(st["id"]) is not None)
                        for st in CONFIG["stations"]],
            "championships":CHAMPIONSHIPS,
            "notice":"各分站详细赛程在 ISU 公布后自动录入。"}
    (OUT/"data").mkdir(parents=True,exist_ok=True)
    (OUT/"data/calendar.json").write_text(json.dumps(season,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    for st in CONFIG["stations"]:
        rows=schedules.get(st["id"])
        if not rows:
            continue
        sync=meta.get(st["id"],{})
        days={}
        for r in rows:
            days[r["local_date"]]=days.get(r["local_date"],0)+1
        schedule={"schema_version":1,"event_id":st["id"],"source_url":sync.get("source_url") or stations.page_url(st,"schedule"),
                  "source_timezone":st["timezone"],"status":"provisional",
                  "source_checked_at":(sync.get("last_successful_schedule_check_utc") or "")[:10] or None,"sync":sync,
                  "notice":"ISU暂定轮次时间；中国队单组时间仅是非官方模型估算。",
                  "day_counts":days,"total_items":len(rows),"entries":rows}
        (OUT/"data"/(st["id"]+".json")).write_text(json.dumps(schedule,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    shutil.copyfile(ROOT/"web/index.html",OUT/"index.html")
    shutil.copyfile(ROOT/"web/app.js",OUT/"app.js")
    shutil.copyfile(ROOT/"web/site.css",OUT/"site.css")
    shutil.copyfile(ROOT/"web/manifest.webmanifest",OUT/"manifest.webmanifest")
    shutil.copytree(ROOT/"web/icons",OUT/"icons",dirs_exist_ok=True)
    if (ROOT/"web/sources").exists():
        shutil.copytree(ROOT/"web/sources",OUT/"sources",dirs_exist_ok=True)
    # The service worker cache name follows the app shell, so a new release replaces the old cache.
    shell=b"".join((ROOT/"web"/name).read_bytes() for name in ("index.html","app.js","site.css","manifest.webmanifest","sw.js"))
    (OUT/"sw.js").write_text((ROOT/"web/sw.js").read_text(encoding="utf-8").replace(
        "__BUILD_VERSION__",hashlib.sha256(shell).hexdigest()[:12]),encoding="utf-8")
    competition_data.export(OUT, VENUES, predict_groups.entered_distances)
    predict_groups.export(OUT, VENUES, schedules)
    import updates
    feed = updates.export(OUT, VENUES, schedules,
                          {k: v.get("last_successful_schedule_check_utc") for k, v in meta.items()})
    for station_id, rows in schedules.items():
        print("Validated and built",station_id,len(rows),"ISU round start times; verified CHN:",
              sum(r["china"]["status"]=="confirmed" for r in rows))
    print("Update notices:",len(feed["events"]))

if __name__ == "__main__":
    export()
