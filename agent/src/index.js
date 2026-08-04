#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig, loadDotEnv, resolvePath } from './config.js';
import { VintedClient, sleep } from './vinted-client.js';
import { selectMatches } from './matcher.js';
import { SeenStore } from './store.js';
import { notify, testTelegram } from './notify.js';
import { verifyMatches } from './verify.js';
import { visionEnabled } from './vision.js';

const USAGE = `
Agente ReWatch — busca Apple Watches en Vinted

  node src/index.js --once                 una pasada y salir
  node src/index.js --watch                vigilancia continua (intervalMinutes)
  node src/index.js --once --show-rejected explica por que se descarta cada anuncio
  node src/index.js --test-telegram        comprueba la conexion con Telegram paso a paso
  node src/index.js --fixture test/fixtures/items.json   prueba sin red

Opciones:
  --config <ruta>   fichero de configuracion (por defecto config.json)
  --max-price <n>   sobrescribe el precio maximo global
  --no-store        no guarda el historial de vistos (util para probar)
`;

function parseArgs(argv) {
  const args = { mode: 'once', config: 'config.json', showRejected: false, store: true, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--watch') args.mode = 'watch';
    else if (a === '--once') args.mode = 'once';
    else if (a === '--test-telegram') args.mode = 'test-telegram';
    else if (a === '--show-rejected') args.showRejected = true;
    else if (a === '--no-store') args.store = false;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--max-price') process.env.REWATCH_MAX_PRICE = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/** Descarga (o lee del fixture) todos los anuncios de todas las queries, sin duplicados. */
async function collectItems(config, client, { fixture, logger }) {
  if (fixture) {
    logger.log(`Modo fixture: leyendo ${fixture}`);
    return JSON.parse(readFileSync(resolvePath(fixture), 'utf8'));
  }

  const byId = new Map();
  for (const text of config.queries) {
    logger.log(`Buscando "${text}"...`);
    const items = await client.searchAll({
      text,
      pages: config.maxPagesPerQuery,
      perPage: config.perPage,
      priceTo: Number.isFinite(config.filters.maxPriceEur) ? config.filters.maxPriceEur : undefined,
      currency: config.currency,
      catalogIds: config.catalogIds,
    });
    for (const item of items) byId.set(String(item.id), item);
    await sleep(config.requestDelayMs);
  }
  return [...byId.values()];
}

export async function runOnce(config, client, store, { fixture = null, showRejected = false, logger = console } = {}) {
  const items = await collectItems(config, client, { fixture, logger });
  const { matches, evaluated } = selectMatches(items, config);

  if (showRejected) {
    logger.log('\n--- descartes ---');
    for (const e of evaluated.filter((x) => !x.match)) {
      logger.log(`  [${e.reason}] ${e.title}`);
    }
  }

  const fresh = store ? matches.filter((m) => !store.has(m.id)) : matches;
  logger.log(
    `\n${items.length} anuncios revisados · ${matches.length} encajan · ${fresh.length} sin avisar todavia`,
  );

  // Segunda criba: ficha completa (y foto, si hay clave) de cada candidato.
  let confirmed = fresh;
  if (fresh.length && !fixture) {
    logger.log(`Verificando ${fresh.length} candidato(s): descripcion completa${visionEnabled() ? ' y foto' : ''}...`);
    confirmed = await verifyMatches(fresh, { client, config, logger });
  }

  if (store) {
    // Tambien los descartados en la verificacion: asi no se reexaminan cada pasada.
    for (const m of fresh) store.add(m.id);
    store.save();
  }

  if (confirmed.length) {
    const stamped = confirmed.map((m) => ({ ...m, foundAt: new Date().toISOString() }));
    await notify(stamped, config, { logger });
  } else if (fresh.length) {
    logger.log('Ningun candidato supero la verificacion.');
  }
  return confirmed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  loadDotEnv();
  if (args.mode === 'test-telegram') {
    const ok = await testTelegram();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const config = loadConfig(args.config);
  const client = new VintedClient({ domain: config.domain, requestDelayMs: config.requestDelayMs });
  const store = args.store ? new SeenStore(config.output.seenPath, config.output.seenTtlDays) : null;

  if (args.mode === 'once') {
    await runOnce(config, client, store, { fixture: args.fixture, showRejected: args.showRejected });
    return;
  }

  console.log(`Vigilando Vinted cada ~${config.intervalMinutes} min. Ctrl+C para parar.`);
  let backoff = 1;
  for (;;) {
    try {
      await runOnce(config, client, store, { showRejected: args.showRejected });
      backoff = 1;
    } catch (err) {
      // Un fallo puntual (429, corte de red) no debe matar la vigilancia.
      console.error(`Error en la pasada: ${err.message}`);
      backoff = Math.min(backoff * 2, 8);
    }
    const jitter = Math.random() * config.jitterSeconds * 1000;
    const wait = config.intervalMinutes * 60 * 1000 * backoff + jitter;
    console.log(`Siguiente revision en ${Math.round(wait / 60000)} min\n`);
    await sleep(wait);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
