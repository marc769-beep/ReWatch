import { readFileSync, writeFileSync } from 'node:fs';
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
 * Escribe o reemplaza KEY=VALOR en agent/.env, conservando el resto de lineas.
 * Lo usa el asistente de Telegram para que el usuario no edite ficheros a mano.
 */
export function saveEnvVar(key, value, file = '.env') {
  const path = resolvePath(file);
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // primer uso: se crea de cero
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'm');
  const next = re.test(raw) ? raw.replace(re, line) : raw + (raw && !raw.endsWith('\n') ? '\n' : '') + line + '\n';
  writeFileSync(path, next);
  process.env[key] = value;
}

/**
 * Carga agent/.env (KEY=VALOR por linea) en process.env si existe, para que
 * el token de Telegram no haya que escribirlo en cada comando ni acabe en git.
 * Las variables ya definidas en el entorno tienen prioridad.
 */
export function loadDotEnv(file = '.env') {
  let raw;
  try {
    raw = readFileSync(resolvePath(file), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
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
