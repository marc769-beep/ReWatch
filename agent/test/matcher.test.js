import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, resolvePath } from '../src/config.js';
import {
  checkCondition,
  detectModel,
  detectSizeMm,
  extractPrice,
  normalize,
  priceCap,
  selectMatches,
  toListing,
} from '../src/matcher.js';

const config = loadConfig();
const items = JSON.parse(readFileSync(resolvePath('test/fixtures/items.json'), 'utf8'));
const byId = (list, id) => list.find((x) => x.id === String(id));

test('detectModel reconoce las formas habituales del titulo', () => {
  assert.equal(detectModel(normalize('Apple Watch SE 2 44mm')), 'se2');
  assert.equal(detectModel(normalize('Apple Watch SE 2ª generación 40mm')), 'se2');
  assert.equal(detectModel(normalize('Apple Watch SE 2022 40mm')), 'se2');
  assert.equal(detectModel(normalize('Apple Watch SE 40mm GPS')), 'se');
  assert.equal(detectModel(normalize('Apple Watch Series 6 44mm')), 's6');
  assert.equal(detectModel(normalize('Apple Watch Ultra 2 49mm')), 'ultra2');
  assert.equal(detectModel(normalize('Reloj bonito sin modelo')), null);
});

test('"se vende" no se confunde con el modelo SE', () => {
  assert.equal(detectModel(normalize('Se vende Apple Watch Series 6 40mm')), 's6');
  assert.equal(detectModel(normalize('Se vende reloj apple watch')), null);
});

test('detectSizeMm lee el tamano de la caja', () => {
  assert.equal(detectSizeMm(normalize('Apple Watch SE 2 44mm')), 44);
  assert.equal(detectSizeMm(normalize('apple watch se 40 mm')), 40);
  assert.equal(detectSizeMm(normalize('apple watch se 2')), null);
});

test('extractPrice prefiere el precio total con proteccion', () => {
  assert.equal(extractPrice({ total_item_price: { amount: '68.00' }, price: { amount: '62.00' } }), 68);
  assert.equal(extractPrice({ price: '55' }), 55);
  assert.equal(extractPrice({}), null);
});

test('priceCap aplica el tope de cada tamano', () => {
  const target = { sizePrices: { 44: 70, 40: 60 }, maxPrice: 70 };
  assert.equal(priceCap(target, 44), 70);
  assert.equal(priceCap(target, 40), 60);
  assert.equal(priceCap(target, null), 70, 'sin tamano se usa el tope mas alto');
  assert.equal(priceCap({ maxPrice: 100 }, 44), 100, 'sin sizePrices manda maxPrice');
});

test('checkCondition compara por inclusion, no por igualdad exacta', () => {
  const f = { allowedConditions: ['nuevo', 'muy bueno', 'bueno'], allowUnknownCondition: true };
  assert.equal(checkCondition('Muy bueno', f).ok, true);
  assert.equal(checkCondition('Nuevo con etiquetas', f).ok, true);
  assert.equal(checkCondition('Satisfactorio', f).ok, false);
  assert.equal(checkCondition('', f).flag, 'estado sin especificar');
  assert.equal(checkCondition('', { ...f, allowUnknownCondition: false }).ok, false);
});

test('toListing aplana el item de la API', () => {
  const l = toListing(items.find((i) => i.id === 2001));
  assert.equal(l.id, '2001');
  assert.equal(l.price, 68);
  assert.equal(l.seller, 'laura');
});

test('solo pasan los SE 2 dentro del tope de su tamano y en buen estado', () => {
  const { matches } = selectMatches(items, config);
  assert.deepEqual(matches.map((m) => m.id).sort(), ['2001', '2002', '2003', '2006', '2010']);
  assert.ok(matches.every((m) => m.model === 'se2'));
});

test('cada descarte explica su motivo', () => {
  const { evaluated } = selectMatches(items, config);
  const why = (id) => byId(evaluated, id).reason;

  assert.match(why(1001), /fuera de los objetivos/); // Series 6
  assert.match(why(1009), /fuera de los objetivos/); // Ultra 2
  assert.match(why(1003), /descartado por/); // correa
  assert.match(why(1007), /descartado por/); // replica T500
  assert.match(why(2007), /pantalla \(rajada/); // pantalla rajada
  assert.match(why(1012), /no parece un Apple Watch/);
  assert.match(why(1005), /por encima del maximo 70/); // SE 2 44mm a 132
  assert.match(why(2004), /por encima del maximo 70/); // SE 2 44mm a 85
  assert.match(why(2008), /tamano 41mm fuera de los buscados/);
  assert.match(why(2009), /sospechosamente bajo/);
  assert.match(why(2005), /estado "Satisfactorio" no admitido/);
});

test('el tope de 40mm es mas estricto que el de 44mm', () => {
  const { evaluated } = selectMatches(items, config);
  assert.equal(byId(evaluated, 2002).priceCap, 60); // 40mm
  assert.equal(byId(evaluated, 2001).priceCap, 70); // 44mm

  const cuarenta = { ...items.find((i) => i.id === 2002), id: 9999 };
  cuarenta.total_item_price = { amount: '64.00', currency_code: 'EUR' };
  const { evaluated: e2 } = selectMatches([cuarenta], config);
  assert.match(e2[0].reason, /por encima del maximo 60/);
});

test('marca los anuncios que hay que mirar con lupa', () => {
  const { matches } = selectMatches(items, config);
  assert.ok(byId(matches, 2003).flags.includes('generacion sin confirmar'));
  assert.ok(byId(matches, 2006).flags.includes('tamano sin confirmar'));
  assert.deepEqual(byId(matches, 2010).flags, ['marcas de uso']);
  assert.deepEqual(byId(matches, 2001).flags, [], 'un anuncio limpio no lleva avisos');
});

test('treatPlainSeAsSe2 desactivado descarta los SE sin generacion', () => {
  const strict = { ...config, filters: { ...config.filters, treatPlainSeAsSe2: false } };
  const { evaluated } = selectMatches(items, strict);
  assert.match(byId(evaluated, 2003).reason, /modelo se fuera de los objetivos/);
});
