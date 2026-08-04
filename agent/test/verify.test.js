import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { verifyMatches } from '../src/verify.js';

const config = { ...loadConfig(), requestDelayMs: 0 };
const silent = { log: () => {}, warn: () => {} };

function candidate(overrides = {}) {
  return {
    id: '5001',
    title: 'Apple Watch SE 2 44mm',
    description: '',
    brand: 'Apple',
    price: 60,
    currency: 'EUR',
    size: '',
    condition: 'Bueno',
    seller: '',
    favourites: 0,
    photo: 'https://images.vinted.net/foto.jpg',
    url: 'https://www.vinted.es/items/5001',
    createdAt: null,
    match: true,
    reason: null,
    model: 'se2',
    modelLabel: 'Apple Watch SE 2',
    sizeMm: 44,
    cellular: false,
    flags: [],
    ...overrides,
  };
}

const clientWith = (description) => ({ itemDetails: async () => ({ description }) });
const noPhoto = async () => null;

test('descarta el anuncio si la ficha completa revela iCloud o rotura', async () => {
  for (const desc of [
    'Perfecto estado pero esta bloqueado por icloud, no conozco la cuenta',
    'Funciona bien aunque tiene la pantalla rota en una esquina',
    'Lo vendo para piezas',
  ]) {
    const kept = await verifyMatches([candidate()], {
      client: clientWith(desc),
      config,
      logger: silent,
      photoCheck: noPhoto,
    });
    assert.equal(kept.length, 0, `deberia descartar: "${desc}"`);
  }
});

test('mantiene el anuncio si la ficha completa esta limpia', async () => {
  const kept = await verifyMatches([candidate()], {
    client: clientWith('Muy cuidado, con caja y cargador. Bateria al 95%.'),
    config,
    logger: silent,
    photoCheck: noPhoto,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].match, true);
});

test('la ficha completa puede anadir avisos sin descartar', async () => {
  const kept = await verifyMatches([candidate()], {
    client: clientWith('Funciona perfecto, lo vendo sin caja y sin cargador'),
    config,
    logger: silent,
    photoCheck: noPhoto,
  });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].flags.includes('sin caja'));
  assert.ok(kept[0].flags.includes('sin cargador'));
});

test('si la ficha no se puede leer, pasa marcado como sin verificar', async () => {
  const kept = await verifyMatches([candidate()], {
    client: { itemDetails: async () => { throw new Error('HTTP 500'); } },
    config,
    logger: silent,
    photoCheck: noPhoto,
  });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].flags.includes('descripcion sin verificar'));
});

test('descarta cuando el analisis de foto ve la pantalla rota', async () => {
  const kept = await verifyMatches([candidate()], {
    client: clientWith('Todo perfecto'),
    config,
    logger: silent,
    photoCheck: async () => ({ damaged: true, reason: 'pantalla agrietada visible' }),
  });
  assert.equal(kept.length, 0);
});

test('marca photoChecked cuando la foto se analiza y esta bien', async () => {
  const kept = await verifyMatches([candidate()], {
    client: clientWith('Todo perfecto'),
    config,
    logger: silent,
    photoCheck: async () => ({ damaged: false, reason: 'sin danos visibles' }),
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].photoChecked, true);
});
