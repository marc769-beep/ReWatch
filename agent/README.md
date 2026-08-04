# Agente ReWatch — buscador de Apple Watches en Vinted

Rastrea Vinted, se queda solo con los Apple Watch que encajan con tus criterios
(modelo, tamaño, precio máximo, estado) y te avisa **una sola vez** por anuncio.

Sin dependencias: solo Node 18 o superior.

## Uso rápido

```bash
cd agent

npm test                 # comprueba la lógica de filtrado (sin red)
npm start                # una pasada y sale
npm run watch            # vigilancia continua cada ~15 min
```

Otras opciones:

```bash
node src/index.js --once --show-rejected          # explica por qué descarta cada anuncio
node src/index.js --once --max-price 150          # precio máximo puntual
node src/index.js --once --fixture test/fixtures/items.json --no-store   # prueba sin red
node src/index.js --help
```

## Qué busca (config.json)

Los criterios están en `config.json`, no en el código:

| Campo | Para qué sirve |
| --- | --- |
| `queries` | Búsquedas que lanza en Vinted |
| `models` | Modelos objetivo y **precio máximo por modelo** (`s6`, `se`, `se2`, `s7`…) |
| `filters.maxPriceEur` / `minPriceEur` | Tope global y suelo antiestafa |
| `filters.sizesMm` | Tamaños de caja, p. ej. `[40, 44]`. Vacío = todos |
| `filters.allowedConditions` | Estados de Vinted admitidos, p. ej. `["muy bueno", "nuevo con etiqueta"]`. Vacío = todos |
| `filters.excludePatterns` | Descarta el anuncio (correas, fundas, "para piezas", iCloud, réplicas T500…) |
| `filters.warnPatterns` | No descarta: marca el anuncio con un aviso (rayado, sin caja, batería baja…) |
| `intervalMinutes` | Cada cuánto revisa en modo `--watch` |

Añadir un modelo nuevo es una línea:

```json
"ultra2": { "label": "Apple Watch Ultra 2", "maxPrice": 480 }
```

Si además pones `"resalePrice": 199` en un modelo, cada resultado incluye el
margen estimado frente a tu precio de venta.

Los precios de `models` que trae el fichero son de compra pensados para revender
(Series 6 hasta 130 €, SE hasta 110 €…). Ajústalos a tu margen real.

### Cómo decide

1. Debe parecer un Apple Watch (`apple watch` / `iwatch` en título o descripción).
2. Se descartan los `excludePatterns` (accesorios, averiados, bloqueados, falsos).
3. Se deduce el modelo del texto: `Series 6`, `serie 6`, `S6`, `SE`, `SE 2`, `Ultra 2`…
   (`"se vende Apple Watch Series 6"` se clasifica como Series 6, no como SE).
4. Se comprueban tamaño, precio total (el que pagas, con protección incluida) y estado.
5. Lo que sobrevive se ordena de más barato a más caro.

## Avisos

Siempre imprime por consola y guarda en `data/found.jsonl` y `data/found.csv`.
Además, si defines estas variables de entorno:

```bash
export TELEGRAM_BOT_TOKEN=...   # bot creado con @BotFather
export TELEGRAM_CHAT_ID=...     # tu chat id
export WEBHOOK_URL=...          # opcional: Slack, Discord, n8n, Make...
```

`data/seen.json` guarda los anuncios ya avisados (30 días) para no repetirlos.
Bórralo si quieres volver a recibirlo todo.

## Dejarlo funcionando solo

Con `cron` (cada 20 minutos, una pasada por ejecución):

```cron
*/20 * * * * cd /ruta/a/ReWatch/agent && TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... /usr/bin/node src/index.js --once >> data/agent.log 2>&1
```

O simplemente `npm run watch` en una terminal / `screen` / `tmux`.

## Notas y límites

- Vinted no tiene API pública documentada. El agente usa el mismo endpoint que
  la web (`/api/v2/catalog/items`) con una sesión anónima que renueva cuando
  caduca. Si Vinted cambia el endpoint, hay que tocar `src/vinted-client.js`.
- Hay un retardo entre peticiones (`requestDelayMs`, 1,5 s) y jitter entre
  pasadas. No lo bajes: bajar el intervalo es la forma rápida de comerse un 429.
- Desde IPs de centros de datos (GitHub Actions, VPS) Vinted suele responder
  403. Va mucho mejor desde tu conexión doméstica.
- El dominio es configurable (`domain`): `www.vinted.fr`, `www.vinted.it`, etc.
