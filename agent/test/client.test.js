import test from 'node:test';
import assert from 'node:assert/strict';
import { VintedClient } from '../src/vinted-client.js';

const silent = { log: () => {}, warn: () => {} };

function fakeResponse({ status = 200, json = {}, cookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => cookies, get: () => cookies[0] ?? null },
    json: async () => json,
    text: async () => '',
  };
}

const SESSION = ['_vinted_fr_session=abc123; Path=/; HttpOnly'];

/** fetch de mentira: la portada siempre da cookies, la API responde a guion. */
function stubFetch(apiResponses) {
  const state = { apiCalls: 0, bootstraps: 0 };
  const fetchImpl = async (url) => {
    if (!url.includes('/api/')) {
      state.bootstraps += 1;
      return fakeResponse({ cookies: SESSION });
    }
    const next = apiResponses[Math.min(state.apiCalls, apiResponses.length - 1)];
    state.apiCalls += 1;
    return next;
  };
  return { fetchImpl, state };
}

test('un 404 de la API renueva la sesion y reintenta una vez', async () => {
  const { fetchImpl, state } = stubFetch([
    fakeResponse({ status: 404 }),
    fakeResponse({ json: { items: [{ id: 1 }] } }),
  ]);
  const client = new VintedClient({ fetchImpl, requestDelayMs: 0, logger: silent });

  const items = await client.search({ text: 'apple watch se' });
  assert.equal(items.length, 1);
  assert.equal(state.apiCalls, 2, 'debe reintentar la busqueda');
  assert.equal(state.bootstraps, 2, 'debe pedir cookies nuevas antes de reintentar');
});

test('un 404 que persiste se marca como pasajero, no como error del agente', async () => {
  const { fetchImpl } = stubFetch([fakeResponse({ status: 404 })]);
  const client = new VintedClient({ fetchImpl, requestDelayMs: 0, logger: silent });

  await assert.rejects(
    () => client.search({ text: 'apple watch se' }),
    (err) => err.retryable === true && /404/.test(err.message),
  );
});

test('un 429 sigue siendo pasajero y no reintenta a lo loco', async () => {
  const { fetchImpl, state } = stubFetch([fakeResponse({ status: 429 })]);
  const client = new VintedClient({ fetchImpl, requestDelayMs: 0, logger: silent });

  await assert.rejects(() => client.search({ text: 'x' }), (err) => err.retryable === true);
  assert.equal(state.apiCalls, 1, 'un 429 no se reintenta al momento');
});

test('searchAll conserva la primera pagina aunque falle la segunda', async () => {
  const { fetchImpl } = stubFetch([
    fakeResponse({ json: { items: [{ id: 1 }, { id: 2 }] } }),
    fakeResponse({ status: 500 }),
  ]);
  const client = new VintedClient({ fetchImpl, requestDelayMs: 0, logger: silent });

  const items = await client.searchAll({ text: 'apple watch se', pages: 2 });
  assert.equal(items.length, 2, 'lo ya recogido no se tira por un fallo posterior');
});

test('searchAll propaga el fallo si no llego a recoger nada', async () => {
  const { fetchImpl } = stubFetch([fakeResponse({ status: 500 })]);
  const client = new VintedClient({ fetchImpl, requestDelayMs: 0, logger: silent });

  await assert.rejects(() => client.searchAll({ text: 'apple watch se', pages: 2 }));
});
