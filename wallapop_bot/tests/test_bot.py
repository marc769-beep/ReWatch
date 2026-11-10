import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot  # noqa: E402

CFG = {"location": {"latitude": 40.4, "longitude": -3.7}, "global_exclude": ["correa"]}

RAW_NEW = {
    "id": "abc123",
    "title": "Apple Watch Series 6 44mm",
    "description": "Perfecto estado, batería 90%",
    "price": {"amount": 120.0, "currency": "EUR"},
    "web_slug": "apple-watch-series-6-44mm-abc123",
    "location": {"city": "Madrid"},
    "images": [{"urls": {"medium": "https://img/1.jpg"}}],
    "reserved": {"flag": False},
    "shipping": {"user_allows_shipping": True},
}
RAW_OLD = {"id": "x9", "title": "Apple Watch SE", "price": 90, "currency": "EUR",
           "web_slug": "apple-watch-se-x9", "location": {"city": "Bilbao"},
           "reserved": False}


class TestBot(unittest.TestCase):
    def test_parse_new_format(self):
        l = bot.parse_item(RAW_NEW)
        self.assertEqual((l.id, l.price, l.city, l.shipping, l.reserved), ("abc123", 120.0, "Madrid", True, False))
        self.assertEqual(l.url, "https://es.wallapop.com/item/apple-watch-series-6-44mm-abc123")
        self.assertEqual(l.image, "https://img/1.jpg")

    def test_parse_old_format(self):
        l = bot.parse_item(RAW_OLD)
        self.assertEqual((l.price, l.city, l.shipping), (90.0, "Bilbao", False))

    def test_extract_items_both_formats(self):
        items, nxt = bot.extract_items({"data": {"section": {"payload": {"items": [RAW_NEW]}}},
                                        "meta": {"next_page": "tok"}})
        self.assertEqual((len(items), nxt), (1, "tok"))
        items, nxt = bot.extract_items({"search_objects": [RAW_OLD]})
        self.assertEqual((len(items), nxt), (1, None))

    def test_filters(self):
        l = bot.parse_item(RAW_NEW)
        s = {"keywords": "x", "min_price": 50, "max_price": 150, "must_include_in_title": ["watch"]}
        self.assertTrue(bot.matches(l, s, CFG))
        self.assertFalse(bot.matches(l, {**s, "max_price": 100}, CFG))
        self.assertFalse(bot.matches(l, {**s, "any_of_in_title": ["ultra"]}, CFG))
        self.assertFalse(bot.matches(l, {**s, "exclude": ["batería"]}, CFG))
        l.title += " con correa"
        self.assertFalse(bot.matches(l, s, CFG))
        l.title, l.reserved = "Apple Watch", True
        self.assertFalse(bot.matches(l, s, CFG))
        self.assertTrue(bot.matches(l, s, {**CFG, "include_reserved": True}))

    def test_build_url(self):
        url = bot.build_search_url({"keywords": "apple watch", "max_price": 100},
                                   {**CFG, "distance_km": 10, "shipping_only": True})
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        self.assertEqual(q["keywords"], ["apple watch"])
        self.assertEqual(q["max_sale_price"], ["100"])
        self.assertEqual(q["distance"], ["10000"])
        self.assertEqual(q["is_shippable"], ["true"])

    def test_run_once_dedup(self):
        import tempfile
        orig = bot.search_wallapop
        bot.search_wallapop = lambda s, c: [bot.parse_item(RAW_NEW)]
        bot.time.sleep = lambda *_: None
        try:
            with tempfile.TemporaryDirectory() as d:
                seen = Path(d) / "seen.json"
                cfg = {**CFG, "searches": [{"keywords": "apple watch"}]}
                self.assertEqual(bot.run_once(cfg, seen, Path(d) / "a.csv", False), 1)
                self.assertEqual(bot.run_once(cfg, seen, None, False), 0)
                self.assertIn("abc123", bot.load_seen(seen))
        finally:
            bot.search_wallapop = orig


if __name__ == "__main__":
    unittest.main()
