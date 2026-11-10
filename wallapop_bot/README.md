# Bot de Wallapop · ReWatch

Busca relojes (por defecto Apple Watch) en Wallapop, filtra por precio y palabras
clave, y avisa de los anuncios **nuevos** por consola y, si quieres, por Telegram.
Pensado para encontrar unidades a buen precio para reacondicionar.

Solo necesita Python 3.9+ (sin dependencias externas).

## Uso

```bash
cd wallapop_bot
python bot.py            # una búsqueda
python bot.py --loop     # se repite cada `interval_minutes`
```

En la primera ejecución guarda los anuncios existentes como "vistos" sin avisar,
para no inundarte; a partir de ahí solo avisa de los nuevos. Usa `--notify-all`
si quieres verlos todos desde el principio.

Los anuncios encontrados se guardan además en `anuncios.csv`.

## Configuración (`config.json`)

| Campo | Qué hace |
|---|---|
| `location` | Latitud/longitud desde la que buscar (por defecto Madrid) |
| `distance_km` | Radio de búsqueda (0 = sin límite) |
| `shipping_only` | Solo anuncios con envío |
| `include_reserved` | Incluir anuncios reservados |
| `global_exclude` | Palabras que descartan un anuncio (correa, roto, icloud…) |
| `searches[]` | Lista de búsquedas: `keywords`, `min_price`, `max_price`, `must_include_in_title`, `any_of_in_title`, `exclude` |
| `interval_minutes` | Frecuencia en modo `--loop` (mínimo 5) |

## Avisos por Telegram (opcional)

1. Crea un bot con [@BotFather](https://t.me/BotFather) y copia el token.
2. Escríbele un mensaje a tu bot y obtén tu `chat_id` en
   `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. Exporta las variables antes de lanzar el bot:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export TELEGRAM_CHAT_ID="123456789"
python bot.py --loop
```

## Tests

```bash
python -m unittest discover -s tests
```

## Nota

El bot usa la API pública que utiliza la web de Wallapop, que no está documentada
y puede cambiar. Usa intervalos razonables (≥ 15 min) y respeta las condiciones de
uso de Wallapop.
