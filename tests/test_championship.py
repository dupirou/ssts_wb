import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class ChampionshipCalendarTests(unittest.TestCase):
    def test_worlds_is_separate_from_seven_world_tour_stages(self):
        calendar = json.loads((ROOT / "dist/data/calendar.json").read_text(encoding="utf-8"))
        self.assertEqual(len(calendar["stations"]), 7)
        self.assertEqual(len(calendar["championships"]), 1)
        worlds = calendar["championships"][0]
        self.assertEqual(worlds["id"], "worlds-2027")
        self.assertEqual(worlds["kind"], "world_championships")
        self.assertEqual((worlds["date_start"], worlds["date_end"]), ("2027-03-12", "2027-03-14"))
        self.assertEqual((worlds["city"], worlds["timezone"]), ("首尔", "Asia/Seoul"))
        self.assertIsNone(worlds["venue"])
        self.assertEqual(worlds["detail_status"], "not_entered")
        self.assertTrue(worlds["source_url"].startswith("https://www.isu-skating.com/"))
        self.assertNotIn("worlds-2027", [st["id"] for st in calendar["stations"]])

if __name__ == "__main__":
    unittest.main()
