#!/usr/bin/env python3
"""
ReWatch · Bot de Vinted
Busca Apple Watch SE 2 (2ª generación) en Vinted dentro de un rango de precio y
manda el link de cada anuncio nuevo por Telegram (y lo muestra por consola).

Solo usa la librería estándar de Python (3.9+).

Uso:
    python bot.py               # una búsqueda y termina
    python bot.py --loop        # repite cada `interval_minutes`
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "es-ES,es;q=0.9",
}

# "SE 2", "SE2", "SE 2ª gen", "SE (2022)", "SE 2nd generation", "SE segunda generación"...
SE2_RE = re.compile(
    r"\bse\s*[-(]?\s*(2(?!\d)|2ª|2a\b|2nd|ii\b|segunda|2022|2023|2024|\(?2\s*gen|gen(eraci[oó]n)?\s*2)",
    re.IGNORECASE,
)
SE2_ALT_RE = re.compile(r"\bse\b.*\b(2ª|segunda)\s*generaci", re.IGNORECASE)


@dataclass
class Listing:
    id: str
    title: str
    price: float
    currency: str
    url: str
    photo: str
    size: str
    status: str

    def format(self) -> str:
        details = " · ".join(x for x in (self.size, self.status) if x)
        line2 = f"💶 {self.price:.2f} {self.currency}" + (f" · {details}" if details else "")
        return f"⌚ {self.title}\n{line2}\n🔗 {self.url}"


# --------------------------------------------------------------------------- #
# Vinted
# --------------------------------------------------------------------------- #
class VintedClient:
    """Vinted pide una cookie de sesión: se obtiene visitando la portada."""

    def __init__(self, domain: str = "www.vinted.es"):
        self.base = f"https://{domain}"
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self._has_session = False

    def _open(self, url: str, timeout: int = 20) -> bytes:
        req = urllib.request.Request(url, headers=HEADERS)
        with self.opener.open(req, timeout=timeout) as resp:
            return resp.read()

    def _ensure_session(self, force: bool = False) -> None:
        if self._has_session and not force:
            return
        self.jar.clear()
        self._open(self.base + "/")
        self._has_session = True

    def search(self, params: dict) -> list[dict]:
        self._ensure_session()
        url = f"{self.base}/api/v2/catalog/items?{urllib.parse.urlencode(params)}"
        try:
            data = self._open(url)
        except urllib.error.HTTPError as e:
            if e.code not in (401, 403):
                raise
            self._ensure_session(force=True)  # cookie caducada: renovar y reintentar
            data = self._open(url)
        return json.loads(data.decode("utf-8")).get("items", [])


def build_params(search: dict, page: int = 1) -> dict:
    params = {
        "search_text": search["keywords"],
        "order": "newest_first",
        "per_page": 96,
        "page": page,
    }
    if search.get("min_price") is not None:
        params["price_from"] = search["min_price"]
    if search.get("max_price") is not None:
        params["price_to"] = search["max_price"]
    return params


def parse_item(raw: dict, base: str = "https://www.vinted.es") -> Listing:
    price = raw.get("price")
    if isinstance(price, dict):
        amount, currency = price.get("amount", 0), price.get("currency_code", "EUR")
    else:
        amount, currency = price or 0, raw.get("currency", "EUR")
    url = raw.get("url") or f"{base}/items/{raw.get('id')}"
    if url.startswith("/"):
        url = base + url
    return Listing(
        id=str(raw.get("id", "")),
        title=(raw.get("title") or "").strip(),
        price=float(amount or 0),
        currency=currency,
        url=url,
        photo=(raw.get("photo") or {}).get("url", ""),
        size=raw.get("size_title") or "",
        status=raw.get("status") or "",
    )


# --------------------------------------------------------------------------- #
# Filtros
# --------------------------------------------------------------------------- #
def is_se2(title: str) -> bool:
    return bool(SE2_RE.search(title) or SE2_ALT_RE.search(title))


def matches(l: Listing, search: dict, cfg: dict) -> bool:
    title = l.title.lower()
    if search.get("min_price") is not None and l.price < search["min_price"]:
        return False
    if search.get("max_price") is not None and l.price > search["max_price"]:
        return False
    if not all(w.lower() in title for w in search.get("must_include_in_title", [])):
        return False
    if search.get("only_se2") and not is_se2(l.title):
        return False
    excluded = search.get("exclude", []) + cfg.get("global_exclude", [])
    return not any(w.lower() in title for w in excluded)


# --------------------------------------------------------------------------- #
# Estado y notificaciones
# --------------------------------------------------------------------------- #
def load_seen(path: Path) -> set[str]:
    try:
        return set(json.loads(path.read_text("utf-8")))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_seen(path: Path, seen: set[str]) -> None:
    path.write_text(json.dumps(sorted(seen)), "utf-8")


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


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def run_once(cfg: dict, client, seen_path: Path, first_run_silent: bool) -> int:
    seen = load_seen(seen_path)
    silent = first_run_silent and not seen
    new_count = 0
    for search in cfg["searches"]:
        name = search.get("name", search["keywords"])
        results: list[Listing] = []
        try:
            for page in range(1, max(1, cfg.get("pages", 1)) + 1):
                raw = client.search(build_params(search, page))
                results.extend(parse_item(r, client.base) for r in raw)
                if not raw:
                    break
                time.sleep(1.5)
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
            if not silent:
                print(f"\n🆕 [{name}]\n{l.format()}")
                notify_telegram(f"🆕 {name}\n{l.format()}")
    save_seen(seen_path, seen)
    if silent:
        print(f"Primera ejecución: {new_count} anuncios guardados como vistos (sin avisar). "
              "Usa --notify-all para recibirlos.")
    return new_count


def main() -> None:
    ap = argparse.ArgumentParser(description="Bot de búsqueda de Apple Watch SE 2 en Vinted")
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--loop", action="store_true", help="repetir cada interval_minutes")
    ap.add_argument("--notify-all", action="store_true",
                    help="mandar también los anuncios que ya existen en la primera ejecución")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text("utf-8"))
    for s in cfg["searches"]:
        if s.get("min_price") is None or s.get("max_price") is None:
            print(f"⚠️  '{s.get('name')}': falta min_price/max_price en config.json", file=sys.stderr)
    client = VintedClient(cfg.get("domain", "www.vinted.es"))
    seen_path = HERE / cfg.get("seen_file", "seen.json")

    while True:
        try:
            run_once(cfg, client, seen_path, first_run_silent=not args.notify_all)
        except Exception as e:  # que un fallo puntual no tumbe el bucle
            print(f"error: {e}", file=sys.stderr)
            client._has_session = False
        if not args.loop:
            break
        mins = max(5, cfg.get("interval_minutes", 10))
        print(f"Esperando {mins} min...\n")
        time.sleep(mins * 60)


if __name__ == "__main__":
    main()
