#!/usr/bin/env python3
"""
ReWatch · Bot de Wallapop
Busca relojes (por defecto Apple Watch) en Wallapop, filtra los anuncios
según config.json y avisa de los nuevos por consola y, opcionalmente, Telegram.

Solo usa la librería estándar de Python (3.9+).

Uso:
    python bot.py               # una búsqueda y termina
    python bot.py --loop        # repite cada `interval_minutes`
    python bot.py --config otra_config.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEARCH_URL = "https://api.wallapop.com/api/v3/search"
ITEM_URL = "https://es.wallapop.com/item/{slug}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "es-ES,es;q=0.9",
    "X-DeviceOS": "0",
}


@dataclass
class Listing:
    id: str
    title: str
    description: str
    price: float
    currency: str
    url: str
    city: str
    image: str
    reserved: bool
    shipping: bool

    def format(self) -> str:
        extra = " · envío" if self.shipping else ""
        return (f"⌚ {self.title}\n💶 {self.price:.0f} {self.currency} · "
                f"📍 {self.city or '?'}{extra}\n🔗 {self.url}")


# --------------------------------------------------------------------------- #
# Wallapop
# --------------------------------------------------------------------------- #
def http_get_json(url: str, headers: dict | None = None, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers=headers or HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_search_url(search: dict, cfg: dict, next_page: str | None = None) -> str:
    if next_page:
        return f"{SEARCH_URL}?{urllib.parse.urlencode({'next_page': next_page})}"
    params = {
        "keywords": search["keywords"],
        "source": "search_box",
        "order_by": cfg.get("order_by", "newest"),
        "latitude": cfg["location"]["latitude"],
        "longitude": cfg["location"]["longitude"],
    }
    if cfg.get("category_id"):
        params["category_ids"] = cfg["category_id"]
    if search.get("min_price") is not None:
        params["min_sale_price"] = search["min_price"]
    if search.get("max_price") is not None:
        params["max_sale_price"] = search["max_price"]
    if cfg.get("distance_km"):
        params["distance"] = int(cfg["distance_km"] * 1000)
    if cfg.get("shipping_only"):
        params["is_shippable"] = "true"
    return f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"


def extract_items(data: dict) -> tuple[list[dict], str | None]:
    """Soporta el formato actual (data.section.payload.items) y el antiguo (search_objects)."""
    items = (
        data.get("data", {}).get("section", {}).get("payload", {}).get("items")
        or data.get("search_objects")
        or []
    )
    next_page = data.get("meta", {}).get("next_page")
    return items, next_page


def parse_item(raw: dict) -> Listing:
    price = raw.get("price")
    if isinstance(price, dict):
        amount, currency = price.get("amount", 0), price.get("currency", "EUR")
    else:
        amount, currency = price or 0, raw.get("currency", "EUR")

    images = raw.get("images") or []
    image = ""
    if images:
        urls = images[0].get("urls") or {}
        image = urls.get("medium") or urls.get("big") or urls.get("small") or images[0].get("original", "")

    reserved = raw.get("reserved")
    if isinstance(reserved, dict):
        reserved = reserved.get("flag", False)

    shipping = raw.get("shipping") or {}
    if isinstance(shipping, dict):
        shipping = shipping.get("user_allows_shipping") or shipping.get("item_is_shippable") or False

    slug = raw.get("web_slug") or raw.get("id", "")
    return Listing(
        id=str(raw.get("id", "")),
        title=(raw.get("title") or "").strip(),
        description=(raw.get("description") or "").strip(),
        price=float(amount or 0),
        currency=currency,
        url=ITEM_URL.format(slug=slug),
        city=(raw.get("location") or {}).get("city", ""),
        image=image,
        reserved=bool(reserved),
        shipping=bool(shipping),
    )


def search_wallapop(search: dict, cfg: dict) -> list[Listing]:
    listings: list[Listing] = []
    next_page = None
    for _ in range(max(1, cfg.get("pages", 1))):
        data = http_get_json(build_search_url(search, cfg, next_page))
        items, next_page = extract_items(data)
        listings.extend(parse_item(i) for i in items)
        if not next_page:
            break
        time.sleep(1.5)  # ser amable con el servidor
    return listings


# --------------------------------------------------------------------------- #
# Filtros
# --------------------------------------------------------------------------- #
def matches(listing: Listing, search: dict, cfg: dict) -> bool:
    text = f"{listing.title} {listing.description}".lower()
    title = listing.title.lower()

    if listing.reserved and not cfg.get("include_reserved", False):
        return False
    if search.get("min_price") is not None and listing.price < search["min_price"]:
        return False
    if search.get("max_price") is not None and listing.price > search["max_price"]:
        return False
    must = search.get("must_include_in_title", [])
    if must and not all(w.lower() in title for w in must):
        return False
    any_of = search.get("any_of_in_title", [])
    if any_of and not any(w.lower() in title for w in any_of):
        return False
    excluded = search.get("exclude", []) + cfg.get("global_exclude", [])
    if any(w.lower() in text for w in excluded):
        return False
    return True


# --------------------------------------------------------------------------- #
# Estado (anuncios ya vistos)
# --------------------------------------------------------------------------- #
def load_seen(path: Path) -> set[str]:
    try:
        return set(json.loads(path.read_text("utf-8")))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_seen(path: Path, seen: set[str]) -> None:
    path.write_text(json.dumps(sorted(seen)), "utf-8")


# --------------------------------------------------------------------------- #
# Notificaciones
# --------------------------------------------------------------------------- #
def notify_telegram(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat_id):
        return
    body = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body)
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except urllib.error.URLError as e:
        print(f"[telegram] error: {e}", file=sys.stderr)


def append_csv(path: Path, search_name: str, l: Listing) -> None:
    import csv
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["busqueda", "id", "titulo", "precio", "moneda", "ciudad", "envio", "url"])
        w.writerow([search_name, l.id, l.title, l.price, l.currency, l.city, l.shipping, l.url])


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def run_once(cfg: dict, seen_path: Path, csv_path: Path | None, first_run_silent: bool) -> int:
    seen = load_seen(seen_path)
    silent = first_run_silent and not seen
    new_count = 0
    for search in cfg["searches"]:
        name = search.get("name", search["keywords"])
        try:
            results = search_wallapop(search, cfg)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"[{name}] error al buscar: {e}", file=sys.stderr)
            continue
        hits = [l for l in results if matches(l, search, cfg)]
        print(f"[{name}] {len(results)} resultados, {len(hits)} pasan filtros")
        for l in sorted(hits, key=lambda x: x.price):
            if l.id in seen:
                continue
            seen.add(l.id)
            new_count += 1
            if csv_path:
                append_csv(csv_path, name, l)
            if not silent:
                print(f"\n🆕 [{name}]\n{l.format()}")
                notify_telegram(f"🆕 {name}\n{l.format()}")
        time.sleep(2)
    save_seen(seen_path, seen)
    if silent:
        print(f"Primera ejecución: {new_count} anuncios guardados como vistos (sin avisar).")
    return new_count


def main() -> None:
    ap = argparse.ArgumentParser(description="Bot de búsqueda de relojes en Wallapop")
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--loop", action="store_true", help="repetir cada interval_minutes")
    ap.add_argument("--notify-all", action="store_true",
                    help="avisar también en la primera ejecución (por defecto solo guarda)")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text("utf-8"))
    seen_path = HERE / cfg.get("seen_file", "seen.json")
    csv_path = HERE / cfg["csv_file"] if cfg.get("csv_file") else None

    while True:
        run_once(cfg, seen_path, csv_path, first_run_silent=not args.notify_all)
        if not args.loop:
            break
        mins = max(5, cfg.get("interval_minutes", 15))
        print(f"Esperando {mins} min...\n")
        time.sleep(mins * 60)


if __name__ == "__main__":
    main()
