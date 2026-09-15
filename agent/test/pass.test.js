import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { runOnce } from '../src/index.js';
import { notify } from '../src/notify.js';

const silent = { log: () => {}, warn: () => {} };

/** Config de pruebas: sin esperas y sin escribir ficheros de salida. */
function testConfig(overrides = {}) {
  const base = loadConfig();
  return {
    ...base,
    requestDelayMs: 0,
    output: { ...base.output, jsonlPath: null, csvPath: null },
    ...overrides,
  };
}

function rawItem(id) {
  return {
    id,
    title: 'Apple Watch SE 2 44mm',
    price: { amount: '65.0', currency_code: 'EUR' },
    status: 'Bueno',
    brand_title: 'Apple',
    url: `https://www.vinted.es/items/${id}`,
  };
}

/** Historial en memoria, para no tocar data/seen.json en las pruebas. */
function memoryStore() {
  const ids = new Set();
  return { ids, has: (id) => ids.has(id), add: (id) => ids.add(id), save: () => {} };
}

test('una busqueda que falla no tumba la pasada entera', async () => {
  const config = testConfig({ queries: ['la que falla', 'la que va'] });
  const client = {
    searchAll: async ({ text }) => {
      if (text === 'la que falla') throw Object.assign(new Error('HTTP 404'), { retryable: true });
      return [rawItem(901)];
    },
    itemDescription: async () => 'Impecable, con caja y cargador. Bateria al 95%.',
  };

  const found = await runOnce(config, client, null, { logger: silent });
  assert.equal(found.length, 1, 'las demas busquedas deben seguir su curso');
});

test('si fallan todas las busquedas, la pasada si avisa del problema', async () => {
  const config = testConfig({ queries: ['una', 'otra'] });
  const client = {
    searchAll: async () => { throw new Error('HTTP 404'); },
    itemDescription: async () => null,
  };

  await assert.rejects(() => runOnce(config, client, null, { logger: silent }), /ninguna de las 2 busquedas/);
});

test('un anuncio avisado se apunta para no repetirlo', async () => {
  const config = testConfig({ queries: ['apple watch se'] });
  const store = memoryStore();
  const client = {
    searchAll: async () => [rawItem(902)],
    itemDescription: async () => 'Perfecto estado, con caja.',
  };

  await runOnce(config, client, store, { logger: silent });
  assert.ok(store.has('902'), 'sin Telegram configurado, la consola cuenta como aviso');
});

test('si el aviso de Telegram falla, el anuncio NO se da por avisado', async () => {
  const config = testConfig({ queries: ['apple watch se'] });
  const store = memoryStore();
  const client = {
    searchAll: async () => [rawItem(903)],
    itemDescription: async () => 'Perfecto estado, con caja.',
  };

  const realFetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  process.env.TELEGRAM_CHAT_ID = '12345';
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ description: 'chat not found' }),
  });

  try {
    await runOnce(config, client, store, { logger: silent });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }

  assert.ok(!store.has('903'), 'debe reintentarse en la proxima pasada, no perderse');
});

test('notify dice si el aviso llego de verdad', async () => {
  const config = testConfig();
  const match = { modelLabel: 'Apple Watch SE 2', sizeMm: 44, price: 65, currency: 'EUR', url: 'https://x', flags: [] };

  const sinTelegram = await notify([match], config, { logger: silent });
  assert.equal(sinTelegram.delivered, true, 'sin Telegram no hay nada que pueda fallar');

  const realFetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  process.env.TELEGRAM_CHAT_ID = '12345';
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  try {
    const conTelegram = await notify([match], config, { logger: silent });
    assert.equal(conTelegram.delivered, true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
});
