# Bot de Vinted · ReWatch

Busca **Apple Watch SE 2 (2ª generación)** en Vinted dentro de un rango de precio y
te manda **el link de cada anuncio nuevo** por Telegram (y lo muestra por consola).

Solo necesita Python 3.9+ (sin dependencias externas).

## 1. Pon tu rango de precio

En `config.json`:

```json
"min_price": 100,
"max_price": 180,
```

## 2. Configura Telegram (para recibir los links en el móvil)

1. En Telegram, habla con [@BotFather](https://t.me/BotFather) → `/newbot` → copia el token.
2. Mándale cualquier mensaje a tu bot nuevo.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia el número de `"chat":{"id": ...}`.

## 3. Ejecuta

```bash
cd vinted_bot
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export TELEGRAM_CHAT_ID="123456789"
python bot.py --loop --notify-all
```

- `--loop`: revisa Vinted cada `interval_minutes` (por defecto 10).
- `--notify-all`: en la primera ejecución te manda también los anuncios que ya existen.
  Sin él, la primera vez solo los apunta y a partir de ahí te avisa de los nuevos.

Cada aviso se ve así:

```
🆕 Apple Watch SE 2
⌚ Apple Watch SE 2 44mm GPS
💶 150.00 EUR · 44mm · Muy bueno
🔗 https://www.vinted.es/items/555-apple-watch-se-2
```

## Cómo detecta que es un SE 2

Vinted no distingue generaciones, así que el bot mira el título: acepta "SE 2", "SE2",
"SE 2ª generación", "SE (2022)", "SE 2nd gen", "segunda generación"… y descarta
"Series", "Ultra", correas, fundas, piezas, bloqueados por iCloud, etc.
(lista en `global_exclude`). Los anuncios que solo dicen "Apple Watch SE" sin
indicar generación se descartan.

## Tests

```bash
python -m unittest discover -s tests
```

## Nota

Usa la API interna de la web de Vinted, que no está documentada y puede cambiar.
Mantén intervalos razonables y respeta las condiciones de uso de Vinted.
