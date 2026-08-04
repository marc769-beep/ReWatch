import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, resolvePath } from '../src/config.js';
import { detectModel, detectSizeMm, extractPrice, normalize, selectMatches, toListing } from '../src/matcher.js';

const config = loadConfig();
const items = JSON.parse(readFileSync(resolvePath('test/fixtures/items.json'), 'utf8'));
const byId = (list, id) => list.find((x) => x.id === String(id));

test('detectModel reconoce las formas habituales del titulo', () => {
  assert.equal(detectModel(normalize('Apple Watch Series 6 44mm')), 's6');
  assert.equal(detectModel(normalize('apple watch serie 7 41 mm')), 's7');
  assert.equal(detectModel(normalize('Apple Watch S8 45mm')), 's8');
  assert.equal(detectModel(normalize('Apple Watch SE 40mm GPS')), 'se');
  assert.equal(detectModel(normalize('Apple Watch SE 2 44mm')), 'se2');
  assert.equal(detectModel(normalize('Apple Watch Ultra 2 49mm')), 'ultra2');
  assert.equal(detectModel(normalize('Apple Watch Ultra 49mm')), 'ultra');
  assert.equal(detectModel(normalize('Reloj bonito sin modelo')), null);
});

test('"se vende" no se confunde con el modelo SE', () => {
  assert.equal(detectModel(normalize('Se vende Apple Watch Series 6 40mm')), 's6');
  assert.equal(detectModel(normalize('Se vende reloj apple watch')), null);
});

test('detectSizeMm lee el tamano de la caja', () => {
  assert.equal(detectSizeMm(normalize('Apple Watch Series 6 44mm')), 44);
  assert.equal(detectSizeMm(normalize('apple watch 41 mm')), 41);
  assert.equal(detectSizeMm(normalize('apple watch series 6')), null);
});

test('extractPrice prefiere el precio total con proteccion', () => {
  assert.equal(extractPrice({ total_item_price: { amount: '118.50' }, price: { amount: '110.00' } }), 118.5);
  assert.equal(extractPrice({ price: '90' }), 90);
  assert.equal(extractPrice({}), null);
});

test('toListing aplana el item de la API', () => {
  const l = toListing(items[0]);
  assert.equal(l.id, '1001');
  assert.equal(l.price, 118.5);
  assert.equal(l.brand, 'Apple');
  assert.equal(l.seller, 'ana_m');
});

test('selectMatches acepta los relojes validos dentro de precio', () => {
  const { matches } = selectMatches(items, config);
  const ids = matches.map((m) => m.id);
  assert.deepEqual(ids.sort(), ['1001', '1002', '1004', '1005', '1011'].sort());
});

test('selectMatches descarta accesorios, averiados, falsos y caros', () => {
  const { evaluated } = selectMatches(items, config);
  const rejected = (id) => byId(evaluated, id);

  assert.match(rejected(1003).reason, /patron/); // correa
  assert.match(rejected(1006).reason, /patron/); // para piezas
  assert.match(rejected(1007).reason, /patron/); // replica T500
  assert.match(rejected(1010).reason, /patron/); // bloqueado icloud
  assert.match(rejected(1008).reason, /por encima del maximo/); // Series 9 a 389
  assert.match(rejected(1009).reason, /fuera de los objetivos/); // Ultra 2 no buscado
  assert.match(rejected(1012).reason, /no parece un Apple Watch/);
});

test('los resultados salen ordenados por precio y con avisos', () => {
  const { matches } = selectMatches(items, config);
  const prices = matches.map((m) => m.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.ok(byId(matches, 1011).flags.length > 0, 'el reloj rayado deberia llevar aviso');
  assert.equal(byId(matches, 1005).cellular, true);
});

test('el filtro de tamano se aplica cuando se configura', () => {
  const only44 = { ...config, filters: { ...config.filters, sizesMm: [44], allowUnknownSize: false } };
  const { matches } = selectMatches(items, only44);
  assert.deepEqual(matches.map((m) => m.id).sort(), ['1001', '1005']);
});
