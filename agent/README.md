# Agente ReWatch — buscador de Apple Watches en Vinted

Rastrea Vinted, se queda solo con los Apple Watch que encajan con tus criterios
(modelo, tamaño, precio máximo, estado) y te avisa **una sola vez** por anuncio.

Sin dependencias: solo Node 20 o superior.

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

## Qué busca ahora mismo

**Solo Apple Watch SE (cualquier generación), en buen estado:**

| Tamaño | Precio máximo |
| --- | --- |
| 44 mm | 70 € |
| 40 mm | 60 € |
| sin indicar | 70 €, marcado como "tamaño sin confirmar" |

El precio que compara es el **total que pagas** (con protección de compra
incluida), no el del escaparate. Estados admitidos: nuevo, muy bueno y bueno;
"satisfactorio" queda fuera. Los demás modelos se descartan.

## Cambiar los criterios (config.json)

Todo está en `config.json`, no en el código:

| Campo | Para qué sirve |
| --- | --- |
| `queries` | Búsquedas que lanza en Vinted |
| `models.<id>.sizePrices` | **Precio máximo por tamaño**, p. ej. `{ "44": 70, "40": 60 }` |
| `models.<id>.maxPrice` | Tope del modelo si el anuncio no dice el tamaño |
| `filters.maxPriceEur` / `minPriceEur` | Tope global y suelo antiestafa (30 €) |
| `filters.sizesMm` | Tamaños admitidos: `[40, 44]` |
| `filters.allowedConditions` | Estados de Vinted admitidos (se comparan por inclusión) |
| `filters.allowUnknownCondition` | Si el anuncio no trae estado: aceptar y marcarlo |
| `filters.treatPlainSeAsSe2` | Ver más abajo |
| `filters.excludePatterns` | Descarta el anuncio (correas, "para piezas", iCloud, réplicas T500, pantalla rajada…) |
| `filters.warnPatterns` | No descarta: marca el anuncio con un aviso (rayado, sin caja, marcas de uso…) |
| `intervalMinutes` | Cada cuánto revisa en modo `--watch` |

Subir el tope del 44 mm a 75 € es cambiar un número. Volver a buscar otro modelo
es añadir una línea:

```json
"s6": { "label": "Apple Watch Series 6", "sizePrices": { "44": 130, "40": 115 } }
```

Si además pones `"resalePrice": 169` en un modelo, cada resultado incluye el
margen estimado frente a tu precio de venta.

### Las dos generaciones del SE

Ahora mismo se buscan las dos (`se` y `se2` en `models`, con los mismos topes).
Para volver a admitir solo la 2ª generación, borra la entrada `se`: los anuncios
que no digan la generación pasarán marcados con **"generación sin confirmar"**
(o quedarán descartados si pones `"treatPlainSeAsSe2": false`).

### Cómo decide

1. Debe parecer un Apple Watch (`apple watch` / `iwatch` en título o descripción).
2. Se descartan los `excludePatterns` (accesorios, averiados, bloqueados, falsos).
3. Se deduce el modelo del texto: `SE 2`, `SE 2ª generación`, `SE 2022`, `Series 6`, `S7`…
   (`"se vende Apple Watch Series 6"` se clasifica como Series 6, no como SE).
4. Se comprueban tamaño, precio total y estado, con el tope del tamaño concreto.
5. Lo que sobrevive se ordena de más barato a más caro.

Con `--show-rejected` ves el motivo exacto de cada descarte, útil para saber si
un filtro se está pasando de estricto.

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
