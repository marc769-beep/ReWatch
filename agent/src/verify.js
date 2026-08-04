import { evaluate } from './matcher.js';
import { sleep } from './vinted-client.js';
import { checkPhotoDamage } from './vision.js';

/**
 * Segunda criba sobre los candidatos que pasaron el filtro de busqueda.
 *
 * Los resultados del catalogo de Vinted traen la descripcion recortada, asi
 * que "bloqueado por icloud" o "pantalla rota" pueden no aparecer hasta abrir
 * el anuncio completo. Aqui se abre el anuncio, se reevalua con la descripcion
 * entera y, si hay clave de Anthropic, se revisa tambien la foto.
 *
 * Para no provocar un 429, cada pasada verifica como mucho
 * `config.maxVerifyPerPass` candidatos (los mas baratos primero); los que no
 * se procesan NO se marcan como vistos y se reintentan en la siguiente pasada.
 * Devuelve { kept, processed }.
 */
export async function verifyMatches(matches, { client, config, logger = console, photoCheck = checkPhotoDamage }) {
  const kept = [];
  const processed = new Set();
  const limit = config.maxVerifyPerPass ?? 20;
  const queue = matches.slice(0, limit);
  if (matches.length > limit) {
    logger.log(`  (se verifican los ${limit} mas baratos; los otros ${matches.length - limit} quedan para la proxima pasada)`);
  }

  for (const [i, m] of queue.entries()) {
    if (i > 0) await sleep(config.requestDelayMs);
    let current = m;

    let description = null;
    let rateLimited = false;
    try {
      description = await client.itemDescription(m.id, m.url);
    } catch (err) {
      if (err.retryable) {
        rateLimited = true;
      } else {
        logger.warn?.(`No se pudo abrir el anuncio ${m.id}: ${err.message}`);
      }
    }
    if (rateLimited) {
      // Vinted nos esta frenando: lo que queda se reintenta en la proxima pasada.
      logger.warn?.('Vinted esta limitando las peticiones; el resto de candidatos se verificara en la proxima pasada.');
      break;
    }
    processed.add(m.id);

    if (description !== null) {
      const reevaluated = evaluate({ ...m, description }, config);
      if (!reevaluated.match) {
        logger.log(`  fuera al leer el anuncio completo [${reevaluated.reason}]: ${m.title}`);
        continue;
      }
      current = reevaluated;
    } else {
      // El anuncio no se pudo leer: se acepta, pero avisando de que va a ciegas.
      current = { ...m, flags: [...m.flags, 'descripcion sin verificar'] };
    }

    const photo = await photoCheck(current.photo, { logger });
    if (photo?.damaged) {
      logger.log(`  fuera por la foto (${photo.reason}): ${m.title}`);
      continue;
    }
    if (photo) current = { ...current, photoChecked: true };

    kept.push(current);
  }

  return { kept, processed };
}
