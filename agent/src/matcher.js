/**
 * Normalizacion y clasificacion de anuncios de Vinted.
 *
 * Los titulos de Vinted son texto libre ("Apple Watch serie 6 44mm rojo"), asi
 * que el modelo, el tamano y el estado se deducen del titulo/descripcion y no
 * de campos estructurados.
 */

const SIZE_RE = /\b(38|40|41|42|44|45|46|49)\s*-?\s*mm\b/;
const CELLULAR_RE = /\b(cellular|celular|lte|4g|gps\s*\+\s*(cellular|celular))\b/;
const APPLE_WATCH_RE = /\b(apple\s*watch|iwatch)\b/;

export function normalize(text) {
  return (text ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Devuelve el id canonico del modelo (ultra2, ultra, se2, se, s1..s10) o null.
 * El orden importa: "Ultra 2" antes que "Ultra", "SE 2" antes que "SE".
 */
export function detectModel(normalizedTitle) {
  const t = normalizedTitle;

  if (/\bultra\s*2\b/.test(t)) return 'ultra2';
  if (/\bultra\b/.test(t)) return 'ultra';

  // "series 6", "serie 6", "s6", "s-6". Va antes que SE porque muchos anuncios
  // dicen "se vende apple watch series 6" y "se" no debe ganar la partida.
  const series = t.match(/\b(?:series|serie)\s*-?\s*(\d{1,2})\b/) ?? t.match(/\bs\s*-?\s*(\d{1,2})\b/);
  if (series) {
    const n = Number(series[1]);
    if (n >= 1 && n <= 10) return `s${n}`;
  }

  // "apple watch 8" / "iwatch 9" a secas, sin la palabra "series"
  const bare = t.match(/\b(?:apple\s*watch|iwatch)\s+(\d{1,2})\b/);
  if (bare) {
    const n = Number(bare[1]);
    if (n >= 1 && n <= 10) return `s${n}`;
  }

  // "se" solo cuenta como modelo si va pegado al reloj o a un dato del reloj,
  // nunca cuando es el pronombre castellano ("se vende", "se entrega").
  const VERB = '(?:vende|venden|entrega|regala|envia|acepta|puede|da|lo|la)';
  const seNextToWatch = new RegExp(`\\bwatch\\s*(?:nike\\s*)?se\\b(?!\\s+${VERB}\\b)`).test(t);
  const seWithSpec = /\bse\b\s*(?:2|3|ii|iii|gen|generacion|gps|cellular|celular|nike|\d{2}\s*-?\s*mm|\(|20\d{2})/.test(t);
  if (seNextToWatch || seWithSpec) {
    const thirdGen = /\bse\s*(?:3|iii)\b/.test(t)
      || /\b(?:3|3a|iii|tercera)\s*(?:gen|generacion)\b/.test(t)
      || /\b(?:2025|2026)\b/.test(t);
    if (thirdGen) return 'se3';
    const secondGen = /\bse\s*(?:2|ii)\b/.test(t)
      || /\b(?:2|2a|ii|segunda)\s*(?:gen|generacion)\b/.test(t)
      || /\b(?:2022|2023|2024)\b/.test(t);
    return secondGen ? 'se2' : 'se';
  }

  return null;
}

export function detectSizeMm(normalizedTitle) {
  const m = normalizedTitle.match(SIZE_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Precio del anuncio tal cual lo pone el vendedor (sin la proteccion de
 * compra de Vinted, que se suma aparte al pagar). Los topes de config se
 * comparan contra este precio.
 */
export function extractPrice(item) {
  const candidates = [item?.price, item?.total_item_price];
  for (const c of candidates) {
    const value = typeof c === 'object' && c !== null ? c.amount : c;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Aplana un item crudo de la API de Vinted a la forma que usa el agente. */
export function toListing(item, domain = 'www.vinted.es') {
  const title = item?.title ?? '';
  const description = item?.description ?? '';
  return {
    id: String(item?.id ?? ''),
    title,
    description,
    price: extractPrice(item),
    currency: item?.price?.currency_code ?? item?.total_item_price?.currency_code ?? 'EUR',
    brand: item?.brand_title ?? '',
    size: item?.size_title ?? '',
    condition: item?.status ?? '',
    seller: item?.user?.login ?? '',
    favourites: item?.favourite_count ?? 0,
    photo: item?.photo?.url ?? item?.photos?.[0]?.url ?? '',
    url: item?.url ?? (item?.id ? `https://${domain}/items/${item.id}` : ''),
    createdAt: item?.photo?.high_resolution?.timestamp
      ? new Date(item.photo.high_resolution.timestamp * 1000).toISOString()
      : null,
  };
}

/**
 * Precio maximo aplicable a un anuncio. `sizePrices` manda sobre `maxPrice`
 * porque el tope depende del tamano de la caja (un 44mm vale mas que un 40mm).
 * Si el anuncio no dice el tamano se usa el tope mas alto y se marca el aviso
 * "tamano sin confirmar": mejor revisar de mas que perder una ganga.
 */
export function priceCap(target, sizeMm) {
  const fallback = Number.isFinite(target.maxPrice) ? target.maxPrice : Number.POSITIVE_INFINITY;
  if (!target.sizePrices) return fallback;

  if (sizeMm !== null && sizeMm !== undefined) {
    const exact = target.sizePrices[String(sizeMm)];
    return Number.isFinite(exact) ? exact : fallback;
  }
  const values = Object.values(target.sizePrices).filter(Number.isFinite);
  return values.length ? Math.max(...values) : fallback;
}

/**
 * El estado que devuelve Vinted es texto ("Muy bueno", "Nuevo con etiquetas"),
 * y varia entre paises, asi que se compara por inclusion y no por igualdad.
 */
export function checkCondition(condition, filters) {
  const allowed = filters.allowedConditions ?? [];
  if (!allowed.length) return { ok: true };

  const value = normalize(condition);
  if (!value) {
    return filters.allowUnknownCondition
      ? { ok: true, flag: 'estado sin especificar' }
      : { ok: false, reason: 'estado sin especificar' };
  }
  return allowed.some((a) => value.includes(a))
    ? { ok: true }
    : { ok: false, reason: `estado "${condition}" no admitido` };
}

/**
 * Decide si un anuncio encaja con los criterios de config.
 * Devuelve siempre el motivo del descarte para poder depurar busquedas.
 */
export function evaluate(listing, config) {
  const f = config.filters;
  const haystack = normalize(`${listing.title} ${listing.description} ${listing.brand}`);
  const result = {
    ...listing,
    match: false,
    reason: null,
    model: null,
    modelLabel: null,
    sizeMm: null,
    cellular: false,
    flags: [],
  };

  if (f.requireAppleWatchInTitle && !APPLE_WATCH_RE.test(haystack)) {
    result.reason = 'no parece un Apple Watch';
    return result;
  }

  const blocked = f.excludeRegexes?.find(({ re }) => re.test(haystack));
  if (blocked) {
    result.reason = `descartado por: ${blocked.label}`;
    return result;
  }

  let model = detectModel(haystack);
  result.model = model;
  if (!model) {
    result.reason = 'modelo no identificado en el titulo';
    return result;
  }

  // Muchos SE de 2a generacion se anuncian solo como "Apple Watch SE": no hay
  // forma de distinguirlos por el texto, asi que se aceptan como SE 2 marcados
  // para revisar (desactivable con filters.treatPlainSeAsSe2 = false).
  if (model === 'se' && !config.models.se && f.treatPlainSeAsSe2 && config.models.se2) {
    model = 'se2';
    result.model = 'se2';
    result.flags.push('generacion sin confirmar');
  }

  const target = config.models[model];
  if (!target) {
    result.reason = `modelo ${model} fuera de los objetivos`;
    return result;
  }
  result.modelLabel = target.label ?? model;

  result.sizeMm = detectSizeMm(haystack);
  if (f.sizesMm.length) {
    if (result.sizeMm === null && !f.allowUnknownSize) {
      result.reason = 'tamano no identificado';
      return result;
    }
    if (result.sizeMm !== null && !f.sizesMm.includes(result.sizeMm)) {
      result.reason = `tamano ${result.sizeMm}mm fuera de los buscados`;
      return result;
    }
  }

  // Un tamano que no existe para ese modelo (p. ej. un "SE de 41mm") delata un
  // anuncio mal etiquetado: mejor fuera.
  if (result.sizeMm !== null && target.sizePrices && !(String(result.sizeMm) in target.sizePrices)) {
    result.reason = `tamano ${result.sizeMm}mm no existe en ${result.modelLabel}`;
    return result;
  }

  if (listing.price === null) {
    result.reason = 'sin precio';
    return result;
  }
  const cap = Math.min(priceCap(target, result.sizeMm), f.maxPriceEur);
  result.priceCap = cap;
  if (result.sizeMm === null && target.sizePrices) {
    result.flags.push('tamano sin confirmar');
  }
  if (listing.price > cap) {
    result.reason = `precio ${listing.price}${listing.currency} por encima del maximo ${cap}`;
    return result;
  }
  if (listing.price < f.minPriceEur) {
    result.reason = `precio ${listing.price}${listing.currency} sospechosamente bajo`;
    return result;
  }

  const conditionCheck = checkCondition(listing.condition, f);
  if (!conditionCheck.ok) {
    result.reason = conditionCheck.reason;
    return result;
  }
  if (conditionCheck.flag) result.flags.push(conditionCheck.flag);

  result.cellular = CELLULAR_RE.test(haystack);
  result.flags.push(...(f.warnRegexes ?? []).filter(({ re }) => re.test(haystack)).map(({ label }) => label));
  result.margin = Number.isFinite(target.resalePrice) ? target.resalePrice - listing.price : null;
  result.match = true;
  return result;
}

/** Filtra, ordena por precio ascendente y devuelve solo lo que encaja. */
export function selectMatches(items, config) {
  const evaluated = items.map((item) => evaluate(toListing(item, config.domain), config));
  const matches = evaluated.filter((e) => e.match).sort((a, b) => a.price - b.price);
  return { matches, evaluated };
}
