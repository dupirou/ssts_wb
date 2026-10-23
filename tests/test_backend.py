import csv
from datetime import datetime, timezone
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"tools"))
import build
import sync_schedule

class DataTests(unittest.TestCase):
    def test_schedule_and_timezones(self):
        rows=build.read_schedule('vancouver')
        self.assertEqual(len(rows),62)
        self.assertEqual([sum(x["local_date"]==date for x in rows) for date in ("2026-10-23","2026-10-24","2026-10-25")],[14,25,23])
        self.assertEqual((rows[0]["local_time"],rows[0]["beijing_date"],rows[0]["beijing_time"]),("09:00","2026-10-24","00:00"))
        self.assertEqual((rows[-1]["beijing_date"],rows[-1]["beijing_time"]),("2026-10-26","10:30"))
    def test_meta_refresh_is_day_scoped(self):
        # A scheduled official check should not force 48 Pages builds daily.
        previous = "2026-10-20T00:05:00+00:00"
        same_day = "2026-10-20T22:05:00+00:00"
        next_day = "2026-10-21T00:05:00+00:00"
        self.assertEqual(previous[:10],same_day[:10])
        self.assertNotEqual(previous[:10],next_day[:10])

    def test_china_rows_keep_evidence_when_official_data_arrives(self):
        rows=build.attach_china(build.read_schedule('vancouver'), 'vancouver')
        for row in rows:
            china=row['china']
            self.assertIn(china['status'],('unknown','confirmed'))
            if china['status']=='confirmed':
                self.assertTrue(build.valid_evidence(china['source_url']))
                self.assertTrue(china['heats'])
            else:
                self.assertEqual(china['heats'],[])
    def test_verified_heat_provenance_and_prediction(self):
        row=build.read_schedule('vancouver')[0]
        example={"schema_version":1,"heats":[{
            "round_key":row["round_key"],"country":"CHN","evidence":"official_start_list",
            "source_url":"https://www.isu-skating.com/en/short-track/",
            "verified_at":"2026-10-21T10:00:00+08:00",
            "heats":[{"number":6,"athletes":["FAKE_TEST_ATHLETE"]}]
        }]}
        original=build.CHINA
        with tempfile.TemporaryDirectory() as temp, patch.object(build.competition_data, 'load_snapshot',
                return_value=build.competition_data.empty_snapshot('vancouver')):
            file=Path(temp)/"china.json"
            file.write_text(json.dumps(example),encoding="utf-8")
            build.CHINA=file
            try:
                result=build.attach_china(build.read_schedule('vancouver'), 'vancouver')
                self.assertEqual(sum(x["china"]["status"]=="confirmed" for x in result),1)
                e=result[0]["china"]["heats"][0]["estimate"]
                self.assertEqual(e["earliest_beijing"],"2026-10-24T00:12:30+08:00")
                self.assertEqual(e["latest_beijing"],"2026-10-24T00:20:00+08:00")
                example["heats"][0]["evidence"]="inferred_from_entry"
                file.write_text(json.dumps(example),encoding="utf-8")
                with self.assertRaises(ValueError):build.attach_china(build.read_schedule('vancouver'), 'vancouver')
            finally:
                build.CHINA=original
    def test_checker_matches_official_round_shape(self):
        sess={"Q":"Qualifying","R":"Repechage","F":"Main"}
        gender={"W":"Women","M":"Men","X":"Mixed Team"}
        rnd={"P":"Preliminaries","H":"Heats","Q":"Quarterfinal","S":"Semifinal","F":"Final"}
        with build.stations.schedule_path('vancouver').open(encoding="utf-8",newline="") as f:
            raw=list(csv.DictReader(f))
        fragments=[]
        old_day=old_session=None
        for r in raw:
            if r["date"]!=old_day:
                old_day=r["date"];old_session=None;fragments.append(".".join(reversed(old_day.split("-"))))
            if r["session"]!=old_session:
                old_session=r["session"];fragments.append("Day - "+sess[old_session]+" Session")
            label=gender[r["gender"]]+" "+r["distance"]+"m "+("Relay " if r["kind"]=="R" else "")+rnd[r["round"]]
            if r["group"]!="-":label+=" "+r["group"]
            fragments += [r["time"],label]
        official=sync_schedule.parse_text("\n".join(fragments),build.stations.get("vancouver"))
        racing=datetime(2026,10,23,12,tzinfo=timezone.utc)
        self.assertEqual(sync_schedule.compare_and_update(official,build.stations.get("vancouver"),write_file=False,now=racing),("unchanged",[]))
        moved=[dict(r) for r in official];moved[0]["time"]="08:55"
        self.assertEqual(sync_schedule.compare_and_update(moved,build.stations.get("vancouver"),write_file=False,now=racing),("times",[(1,"09:00","08:55")]))
        # Once racing has begun a restructured programme needs a person; before, ISU may still revise it.
        official[3]["session"]="R"
        with self.assertRaises(ValueError):sync_schedule.compare_and_update(official,build.stations.get("vancouver"),write_file=False,now=racing)
        before=datetime(2026,10,21,tzinfo=timezone.utc)
        self.assertEqual(sync_schedule.compare_and_update(official,build.stations.get("vancouver"),write_file=False,now=before)[0],"replaced")
        # A page cut off before the last finals is partial, never a new programme.
        with self.assertRaises(ValueError):sync_schedule.validate(sync_schedule.parse_text("\n".join(fragments[:-40]),build.stations.get("vancouver")),build.stations.get("vancouver"))

if __name__=="__main__":unittest.main()
