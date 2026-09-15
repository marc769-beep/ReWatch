#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadDotEnv, resolvePath } from './config.js';
import { VintedClient, sleep } from './vinted-client.js';
import { selectMatches } from './matcher.js';
import { SeenStore } from './store.js';
import { notify, telegramConfigured, testTelegram } from './notify.js';
import { verifyMatches } from './verify.js';
import { visionEnabled } from './vision.js';

const USAGE = `
Agente ReWatch — busca Apple Watches en Vinted

  node src/index.js --once                 una pasada y salir
  node src/index.js --watch                vigilancia continua (intervalMinutes)
  node src/index.js --once --show-rejected explica por que se descarta cada anuncio
  node src/index.js --test-telegram        comprueba la conexion con Telegram paso a paso
  node src/index.js --diagnose             comprueba si Vinted te esta respondiendo
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
    else if (a === '--diagnose') args.mode = 'diagnose';
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
  const failed = [];
  for (const text of config.queries) {
    logger.log(`Buscando "${text}"...`);
    try {
      const items = await client.searchAll({
        text,
        pages: config.maxPagesPerQuery,
        perPage: config.perPage,
        priceTo: Number.isFinite(config.filters.maxPriceEur) ? config.filters.maxPriceEur : undefined,
        currency: config.currency,
        catalogIds: config.catalogIds,
      });
      for (const item of items) byId.set(String(item.id), item);
    } catch (err) {
      // Una busqueda que falla no puede tumbar la pasada: quedan las demas y
      // cualquiera de ellas puede traer el reloj bueno.
      failed.push(text);
      logger.warn?.(`  fallo "${text}": ${err.message}`);
    }
    await sleep(config.requestDelayMs);
  }

  if (failed.length === config.queries.length) {
    throw new Error(`Vinted no respondio a ninguna de las ${failed.length} busquedas`);
  }
  if (failed.length) {
    logger.log(`(${failed.length} de ${config.queries.length} busquedas fallaron; se reintentan en la proxima pasada)`);
  }
  return [...byId.values()];
}

/**
 * Comprueba de forma aislada si Vinted contesta: primero la portada (cookies)
 * y luego una busqueda pequena. Sirve para distinguir "el agente esta roto" de
 * "Vinted no nos quiere atender ahora mismo", que se parecen mucho por fuera.
 */
async function runDiagnosis(config, { logger = console } = {}) {
  const client = new VintedClient({ domain: config.domain, requestDelayMs: config.requestDelayMs, logger });
  logger.log(`Comprobando ${config.domain}...\n`);

  try {
    await client.bootstrap();
    logger.log(`1. Portada .............. OK (${client.cookies.size} cookie(s) de sesion)`);
  } catch (err) {
    logger.log(`1. Portada .............. FALLO: ${err.message}`);
    logger.log('\n   Sin cookies no hay busqueda posible. Mira tu conexion a internet;');
    logger.log('   si internet va bien, es Vinted quien esta bloqueando este ordenador.');
    return false;
  }

  const text = config.queries[0];
  try {
    const items = await client.search({ text, perPage: 10, currency: config.currency });
    logger.log(`2. Busqueda "${text}" ... OK (${items.length} anuncios)`);
    logger.log('\nVinted responde bien. Si antes fallaba, era pasajero y ya esta resuelto.');
    return true;
  } catch (err) {
    logger.log(`2. Busqueda "${text}" ... FALLO: ${err.message}`);
    logger.log(
      '\n   Un 404 o un 429 aqui significa casi siempre que Vinted esta frenando a esta IP'
      + '\n   por demasiadas peticiones. No se arregla tocando el agente: deja encendido'
      + '\n   uno solo, espera 15-20 minutos y vuelve a lanzar este mismo comando.',
    );
    return false;
  }
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

  // Segunda criba: anuncio completo (y foto, si hay clave) de cada candidato.
  let confirmed = fresh;
  let processed = new Set(fresh.map((m) => m.id));
  if (fresh.length && !fixture) {
    logger.log(`Verificando ${fresh.length} candidato(s): descripcion completa${visionEnabled() ? ' y foto' : ''}...`);
    ({ kept: confirmed, processed } = await verifyMatches(fresh, { client, config, logger }));
  }

  // Avisar va antes de apuntar: si el mensaje no sale, el anuncio no puede
  // darse por avisado o se perderia para siempre.
  let delivered = true;
  if (confirmed.length) {
    const stamped = confirmed.map((m) => ({ ...m, foundAt: new Date().toISOString() }));
    ({ delivered } = await notify(stamped, config, { logger }));
  } else if (fresh.length) {
    logger.log('Ningun candidato supero la verificacion.');
  }

  if (store) {
    const confirmedIds = new Set(confirmed.map((m) => m.id));
    for (const m of fresh) {
      // Lo que quedo sin verificar (por el limite o por un 429) se reintenta.
      if (!processed.has(m.id)) continue;
      // Y lo que encajaba pero cuyo aviso no llego, tambien.
      if (confirmedIds.has(m.id) && !delivered) continue;
      store.add(m.id);
    }
    store.save();
  }

  if (!delivered) {
    logger.warn?.('El aviso no salio: estos anuncios se vuelven a intentar en la proxima pasada.');
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
  if (args.mode === 'diagnose') {
    const ok = await runDiagnosis(config);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const client = new VintedClient({ domain: config.domain, requestDelayMs: config.requestDelayMs });
  const store = args.store ? new SeenStore(config.output.seenPath, config.output.seenTtlDays) : null;

  console.log(
    telegramConfigured()
      ? 'Avisos por Telegram: ACTIVADOS'
      : 'Avisos por Telegram: DESACTIVADOS — ejecuta "node src/index.js --test-telegram" para configurarlos',
  );

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

// pathToFileURL, y no `file://` a mano: en Windows argv[1] llega como
// C:\Users\... y la comparacion nunca cuadraba, asi que el agente se cerraba
// sin ejecutar nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
