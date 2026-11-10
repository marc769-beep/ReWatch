import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot  # noqa: E402

CFG = {"global_exclude": ["correa", "series"]}
SEARCH = {"keywords": "apple watch se 2", "min_price": 100, "max_price": 180,
          "must_include_in_title": ["watch"], "only_se2": True}
RAW = {"id": 555, "title": "Apple Watch SE 2 44mm GPS",
       "price": {"amount": "150.0", "currency_code": "EUR"},
       "url": "https://www.vinted.es/items/555-apple-watch-se-2",
       "photo": {"url": "https://img/1.jpg"}, "size_title": "44mm", "status": "Muy bueno"}


class FakeClient:
    base = "https://www.vinted.es"

    def __init__(self, items):
        self.items = items

    def search(self, params):
        return self.items if params["page"] == 1 else []


class TestBot(unittest.TestCase):
    def test_parse(self):
        l = bot.parse_item(RAW)
        self.assertEqual((l.id, l.price, l.currency, l.size), ("555", 150.0, "EUR", "44mm"))
        self.assertEqual(l.url, RAW["url"])
        old = bot.parse_item({"id": 1, "title": "x", "price": "99.5", "currency": "EUR", "url": "/items/1-x"})
        self.assertEqual((old.price, old.url), (99.5, "https://www.vinted.es/items/1-x"))

    def test_is_se2(self):
        yes = ["Apple Watch SE 2 44mm", "Apple watch SE2", "Apple Watch SE 2ª generación",
               "Apple Watch SE (2022) 40mm", "Apple Watch SE 2nd gen", "apple watch se segunda generación",
               "Apple Watch SE (2ª gen) GPS", "Apple Watch SE 2023", "Apple Watch SE gen 2"]
        no = ["Apple Watch SE 40mm", "Apple Watch SE 1ª generación", "Apple Watch SE 44mm 2020",
              "Apple Watch Series 2", "Apple Watch SE 22mm correa"]
        for t in yes:
            self.assertTrue(bot.is_se2(t), t)
        for t in no:
            self.assertFalse(bot.is_se2(t), t)

    def test_matches(self):
        l = bot.parse_item(RAW)
        self.assertTrue(bot.matches(l, SEARCH, CFG))
        self.assertFalse(bot.matches(l, {**SEARCH, "max_price": 140}, CFG))
        self.assertFalse(bot.matches(l, {**SEARCH, "min_price": 160}, CFG))
        l.title = "Correa Apple Watch SE 2"
        self.assertFalse(bot.matches(l, SEARCH, CFG))
        l.title = "Apple Watch SE 44mm"
        self.assertFalse(bot.matches(l, SEARCH, CFG))

    def test_params(self):
        p = bot.build_params(SEARCH)
        self.assertEqual((p["price_from"], p["price_to"], p["order"]), (100, 180, "newest_first"))

    def test_run_once_sends_links_once(self):
        sent = []
        bot.notify_telegram = sent.append
        bot.time.sleep = lambda *_: None
        cfg = {**CFG, "searches": [SEARCH]}
        client = FakeClient([RAW, {**RAW, "id": 9, "title": "Apple Watch SE 40mm"}])
        with tempfile.TemporaryDirectory() as d:
            seen = Path(d) / "seen.json"
            self.assertEqual(bot.run_once(cfg, client, seen, False), 1)
            self.assertEqual(bot.run_once(cfg, client, seen, False), 0)
        self.assertEqual(len(sent), 1)
        self.assertIn(RAW["url"], sent[0])


if __name__ == "__main__":
    unittest.main()
