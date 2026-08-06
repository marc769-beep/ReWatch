import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { verifyMatches } from '../src/verify.js';
import { extractDescription } from '../src/vinted-client.js';

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

const clientWith = (description) => ({ itemDescription: async () => description });
const noPhoto = async () => null;

test('descarta el anuncio si la ficha completa revela iCloud o rotura', async () => {
  for (const desc of [
    'Perfecto estado pero esta bloqueado por icloud, no conozco la cuenta',
    'Funciona bien aunque tiene la pantalla rota en una esquina',
    'Lo vendo para piezas',
  ]) {
    const { kept } = await verifyMatches([candidate()], {
      client: clientWith(desc),
      config,
      logger: silent,
      photoCheck: noPhoto,
    });
    assert.equal(kept.length, 0, `deberia descartar: "${desc}"`);
  }
});

test('mantiene el anuncio si la ficha completa esta limpia', async () => {
  const { kept } = await verifyMatches([candidate()], {
    client: clientWith('Muy cuidado, con caja y cargador. Bateria al 95%.'),
    config,
    logger: silent,
    photoCheck: noPhoto,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].match, true);
});

test('la ficha completa puede anadir avisos sin descartar', async () => {
  const { kept } = await verifyMatches([candidate()], {
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
  const { kept } = await verifyMatches([candidate()], {
    client: { itemDescription: async () => { throw new Error('HTTP 500'); } },
    config,
    logger: silent,
    photoCheck: noPhoto,
  });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].flags.includes('descripcion sin verificar'));
});

test('descarta cuando el analisis de foto ve la pantalla rota', async () => {
  const { kept } = await verifyMatches([candidate()], {
    client: clientWith('Todo perfecto'),
    config,
    logger: silent,
    photoCheck: async () => ({ damaged: true, reason: 'pantalla agrietada visible' }),
  });
  assert.equal(kept.length, 0);
});

test('marca photoChecked cuando la foto se analiza y esta bien', async () => {
  const { kept } = await verifyMatches([candidate()], {
    client: clientWith('Todo perfecto'),
    config,
    logger: silent,
    photoCheck: async () => ({ damaged: false, reason: 'sin danos visibles' }),
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].photoChecked, true);
});

test('verifica como mucho maxVerifyPerPass y deja el resto sin procesar', async () => {
  const many = Array.from({ length: 5 }, (_, i) => candidate({ id: String(6000 + i) }));
  const capped = { ...config, maxVerifyPerPass: 2 };
  const { kept, processed } = await verifyMatches(many, {
    client: clientWith('Todo perfecto'),
    config: capped,
    logger: silent,
    photoCheck: noPhoto,
  });
  assert.equal(kept.length, 2);
  assert.equal(processed.size, 2);
});

test('un 429 detiene la verificacion sin marcar como procesado lo pendiente', async () => {
  let calls = 0;
  const client = {
    itemDescription: async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('429'), { retryable: true });
      return 'Todo perfecto';
    },
  };
  const many = [candidate({ id: '7001' }), candidate({ id: '7002' }), candidate({ id: '7003' })];
  const { kept, processed } = await verifyMatches(many, { client, config, logger: silent, photoCheck: noPhoto });
  assert.equal(kept.length, 1, 'solo el primero llego a verificarse');
  assert.ok(processed.has('7001'));
  assert.ok(!processed.has('7002'), 'el que fallo por 429 se reintenta');
  assert.ok(!processed.has('7003'));
});

test('extractDescription coge el texto del vendedor, no el generico de Vinted', () => {
  const html = `<html><head>
    <meta property="og:description" content="Compra Apple Watch SE de segunda mano en Vinted">
    <script>{"description":"Vinted es la app para comprar y vender ropa de segunda mano","catalog":{"description":"Relojes y complementos"},"item":{"description":"Reloj impecable salvo que la pantalla esta rota por una esquina, se ve perfectamente igual","id":1}}</script>
  </head></html>`;
  const text = extractDescription(html);
  assert.match(text, /pantalla esta rota/, 'debe incluir lo que escribio el vendedor');
});

test('extractDescription devuelve null cuando no hay nada util', () => {
  assert.equal(extractDescription('<html><body>hola</body></html>'), null);
  assert.equal(extractDescription('<html>{"description":"corto"}</html>'), null);
});

test('un anuncio danado solo en la descripcion larga se descarta', async () => {
  const html = `<html><script>{"description":"Vinted es la app para comprar y vender ropa de segunda mano","item":{"description":"Todo funciona pero esta bloqueado por icloud y no tengo la cuenta del anterior dueno"}}</script></html>`;
  const client = { itemDescription: async () => extractDescription(html) };
  const { kept } = await verifyMatches([candidate()], { client, config, logger: silent, photoCheck: noPhoto });
  assert.equal(kept.length, 0, 'el iCloud escondido en la descripcion larga debe tumbarlo');
});
