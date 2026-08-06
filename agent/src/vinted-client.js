/**
 * Cliente minimo de la API publica de Vinted.
 *
 * Vinted no ofrece API documentada: la web usa /api/v2/catalog/items y exige
 * las cookies de sesion anonima que reparte la portada. El cliente las obtiene,
 * las reutiliza y las renueva solo cuando caducan (401/403).
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
export function decodeHtmlEntities(s) {
  return s
    .replace(/&(?:amp|quot|#39|#x27|lt|gt|nbsp);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * Saca la descripcion del vendedor del HTML de un anuncio.
 *
 * La pagina trae varios campos "description" (textos del propio Vinted,
 * categorias, etc.), asi que quedarse con el primero devolvia casi siempre
 * texto generico y los filtros no veian lo que escribio el vendedor. Aqui se
 * recogen todos los candidatos y se juntan los que parecen texto real: para
 * detectar "pantalla rota" o "icloud" es mejor mirar de mas que de menos.
 */
export function extractDescription(html) {
  const candidates = [];

  for (const m of html.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      candidates.push(JSON.parse(`"${m[1]}"`));
    } catch {
      // fragmento con escapes raros: se ignora
    }
  }

  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
  if (og) candidates.push(decodeHtmlEntities(og[1]));

  const seen = new Set();
  const useful = [];
  for (const c of candidates) {
    const text = (c ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 15 || seen.has(text)) continue;
    seen.add(text);
    useful.push(text);
  }
  if (!useful.length) return null;

  // Los textos mas largos son los que suele escribir el vendedor.
  return useful.sort((a, b) => b.length - a.length).slice(0, 4).join(' \n');
}

export class VintedClient {
  constructor({ domain = 'www.vinted.es', requestDelayMs = 1500, fetchImpl = fetch, logger = console } = {}) {
    this.domain = domain;
    this.requestDelayMs = requestDelayMs;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.cookies = new Map();
  }

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  /** Pide la portada para conseguir _vinted_fr_session / access_token_web. */
  async bootstrap() {
    const res = await this.fetch(`https://${this.domain}/`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'es-ES,es;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    this.storeCookies(res);
    if (!this.cookies.size) {
      throw new Error(`Vinted no devolvio cookies de sesion (HTTP ${res.status})`);
    }
    return this.cookies;
  }

  async apiGet(path, { retryOnAuth = true } = {}) {
    if (!this.cookies.size) await this.bootstrap();

    const res = await this.fetch(`https://${this.domain}${path}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
        Referer: `https://${this.domain}/`,
        Cookie: this.cookieHeader,
      },
    });

    if ((res.status === 401 || res.status === 403) && retryOnAuth) {
      this.logger.warn?.(`Sesion caducada (HTTP ${res.status}), renovando cookies...`);
      this.cookies.clear();
      await this.bootstrap();
      await sleep(this.requestDelayMs);
      return this.apiGet(path, { retryOnAuth: false });
    }

    if (res.status === 429) {
      throw Object.assign(new Error('Vinted esta limitando las peticiones (429)'), { retryable: true });
    }
    if (!res.ok) {
      throw new Error(`GET ${path} -> HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Busca en el catalogo. Devuelve los items crudos de la API.
   * @param {{text: string, page?: number, perPage?: number, priceTo?: number, currency?: string, catalogIds?: number[]}} opts
   */
  async search({ text, page = 1, perPage = 96, priceTo, currency = 'EUR', catalogIds = [] }) {
    const qs = new URLSearchParams({
      search_text: text,
      page: String(page),
      per_page: String(perPage),
      order: 'newest_first',
      currency,
    });
    if (Number.isFinite(priceTo)) qs.set('price_to', String(priceTo));
    if (catalogIds.length) qs.set('catalog_ids', catalogIds.join(','));

    const data = await this.apiGet(`/api/v2/catalog/items?${qs}`);
    return Array.isArray(data?.items) ? data.items : [];
  }

  /**
   * Descripcion completa de un anuncio. Los resultados de busqueda la traen
   * recortada, y ahi es donde los vendedores confiesan "bloqueado por icloud"
   * o "pantalla rota". El endpoint /api/v2/items/{id} ya no existe (404), asi
   * que se lee la pagina publica del anuncio y se extrae la descripcion del
   * JSON embebido o de la etiqueta og:description.
   */
  async itemDescription(id, url) {
    const target = url || `https://${this.domain}/items/${id}`;
    if (!this.cookies.size) await this.bootstrap();

    const res = await this.fetch(target, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9',
        Referer: `https://${this.domain}/`,
        Cookie: this.cookieHeader,
      },
      redirect: 'follow',
    });
    if (res.status === 429) {
      throw Object.assign(new Error('Vinted esta limitando las peticiones (429)'), { retryable: true });
    }
    if (!res.ok) return null;
    const html = await res.text();
    return extractDescription(html);
  }

  /** Recorre varias paginas de una query respetando el retardo entre llamadas. */
  async searchAll({ text, pages = 1, ...rest }) {
    const out = [];
    for (let page = 1; page <= pages; page += 1) {
      const items = await this.search({ text, page, ...rest });
      out.push(...items);
      if (items.length === 0) break;
      if (page < pages) await sleep(this.requestDelayMs);
    }
    return out;
  }
}
