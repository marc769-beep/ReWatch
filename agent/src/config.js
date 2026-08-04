import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './matcher.js';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULTS = {
  domain: 'www.vinted.es',
  currency: 'EUR',
  perPage: 96,
  maxPagesPerQuery: 2,
  requestDelayMs: 1500,
  intervalMinutes: 15,
  jitterSeconds: 90,
  queries: ['apple watch'],
  catalogIds: [],
  models: {},
  filters: {
    minPriceEur: 0,
    maxPriceEur: Number.POSITIVE_INFINITY,
    sizesMm: [],
    allowUnknownSize: true,
    allowedConditions: [],
    allowUnknownCondition: true,
    treatPlainSeAsSe2: true,
    requireAppleWatchInTitle: true,
    excludePatterns: [],
    warnPatterns: [],
  },
  output: {
    consoleLimit: 40,
    jsonlPath: 'data/found.jsonl',
    csvPath: 'data/found.csv',
    seenPath: 'data/seen.json',
    seenTtlDays: 30,
  },
};

/**
 * Acepta patrones como cadena ("\\bsin caja\\b") o como objeto con etiqueta
 * ({ "pattern": "...", "label": "sin caja" }) y devuelve siempre { re, label },
 * para que los avisos se lean en castellano y no como una expresion regular.
 */
export function compilePatterns(patterns = []) {
  return patterns.map((p) => {
    const pattern = typeof p === 'string' ? p : p.pattern;
    const fallback = pattern.replace(/\\b/g, '').replace(/\\/g, '').trim();
    return { re: new RegExp(pattern, 'i'), label: (typeof p === 'object' && p.label) || fallback };
  });
}

export function resolvePath(p) {
  return isAbsolute(p) ? p : join(ROOT, p);
}

/**
 * Lee config.json (o el fichero indicado), aplica los valores por defecto y
 * deja los patrones compilados como RegExp para no recompilarlos por anuncio.
 */
export function loadConfig(file = 'config.json') {
  const raw = JSON.parse(readFileSync(resolvePath(file), 'utf8'));
  const cfg = {
    ...DEFAULTS,
    ...raw,
    filters: { ...DEFAULTS.filters, ...(raw.filters ?? {}) },
    output: { ...DEFAULTS.output, ...(raw.output ?? {}) },
  };

  if (!Object.keys(cfg.models).length) {
    throw new Error('config.models esta vacio: define al menos un modelo objetivo');
  }

  cfg.filters.excludeRegexes = compilePatterns(cfg.filters.excludePatterns);
  cfg.filters.warnRegexes = compilePatterns(cfg.filters.warnPatterns);
  cfg.filters.allowedConditions = cfg.filters.allowedConditions.map((c) => normalize(c));

  // Overrides puntuales sin tocar el fichero, utiles para probar desde consola.
  if (process.env.REWATCH_MAX_PRICE) {
    cfg.filters.maxPriceEur = Number(process.env.REWATCH_MAX_PRICE);
  }
  if (process.env.REWATCH_QUERIES) {
    cfg.queries = process.env.REWATCH_QUERIES.split(',').map((q) => q.trim()).filter(Boolean);
  }
  if (process.env.REWATCH_DOMAIN) {
    cfg.domain = process.env.REWATCH_DOMAIN;
  }

  return cfg;
}
