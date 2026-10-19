import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"tools"))
import build
import sync_schedule

class DataTests(unittest.TestCase):
    def test_schedule_and_timezones(self):
        rows=build.read_schedule()
        self.assertEqual(len(rows),62)
        self.assertEqual([sum(x["local_date"]==date for x in rows) for date in build.EXPECTED],[14,25,23])
        self.assertEqual((rows[0]["local_time"],rows[0]["beijing_date"],rows[0]["beijing_time"]),("09:00","2026-10-24","00:00"))
        self.assertEqual((rows[-1]["beijing_date"],rows[-1]["beijing_time"]),("2026-10-26","10:30"))
    def test_unknown_china_rows(self):
        rows=build.attach_china(build.read_schedule())
        self.assertTrue(all(x["china"]["status"]=="unknown" for x in rows))
    def test_verified_heat_provenance_and_prediction(self):
        row=build.read_schedule()[0]
        example={"schema_version":1,"heats":[{
            "round_key":row["round_key"],"country":"CHN","evidence":"official_start_list",
            "source_url":"https://www.isu-skating.com/en/short-track/",
            "verified_at":"2026-10-21T10:00:00+08:00",
            "heats":[{"number":6,"athletes":["FAKE_TEST_ATHLETE"]}]
        }]}
        original=build.CHINA
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/"china.json"
            file.write_text(json.dumps(example),encoding="utf-8")
            build.CHINA=file
            try:
                result=build.attach_china(build.read_schedule())
                self.assertEqual(sum(x["china"]["status"]=="confirmed" for x in result),1)
                e=result[0]["china"]["heats"][0]["estimate"]
                self.assertEqual(e["earliest_beijing"],"2026-10-24T00:12:30+08:00")
                self.assertEqual(e["latest_beijing"],"2026-10-24T00:20:00+08:00")
                example["heats"][0]["evidence"]="inferred_from_entry"
                file.write_text(json.dumps(example),encoding="utf-8")
                with self.assertRaises(ValueError):build.attach_china(build.read_schedule())
            finally:
                build.CHINA=original
    def test_checker_matches_official_round_shape(self):
        sess={"Q":"Qualifying","R":"Repechage","F":"Main"}
        gender={"W":"Women","M":"Men","X":"Mixed Team"}
        rnd={"P":"Preliminaries","H":"Heats","Q":"Quarterfinal","S":"Semifinal","F":"Final"}
        with build.SOURCE.open(encoding="utf-8",newline="") as f:
            raw=list(csv.DictReader(f))
        fragments=[]
        old_day=old_session=None
        for r in raw:
            if r["day"]!=old_day:
                old_day=r["day"];old_session=None;fragments.append(old_day+".10.2026")
            if r["session"]!=old_session:
                old_session=r["session"];fragments.append("Day - "+sess[old_session]+" Session")
            label=gender[r["gender"]]+" "+r["distance"]+"m "+("Relay " if r["kind"]=="R" else "")+rnd[r["round"]]
            if r["group"]!="-":label+=" "+r["group"]
            fragments += [r["time"],label]
        official=sync_schedule.parse_text("\n".join(fragments))
        self.assertEqual(sync_schedule.compare_and_update(official,write=False),[])
        official[3]["gender"]="W"
        with self.assertRaises(ValueError):sync_schedule.compare_and_update(official,write=False)
        with self.assertRaises(ValueError):sync_schedule.parse_text("\n".join(fragments[:20]))

if __name__=="__main__":unittest.main()
