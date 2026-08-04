import { evaluate } from './matcher.js';
import { sleep } from './vinted-client.js';
import { checkPhotoDamage } from './vision.js';

/**
 * Segunda criba sobre los candidatos que pasaron el filtro de busqueda.
 *
 * Los resultados del catalogo de Vinted traen la descripcion recortada, asi
 * que "bloqueado por icloud" o "pantalla rota" pueden no aparecer hasta abrir
 * la ficha completa. Aqui se descarga esa ficha, se reevalua el anuncio con la
 * descripcion entera y, si hay clave de Anthropic, se revisa tambien la foto.
 */
export async function verifyMatches(matches, { client, config, logger = console, photoCheck = checkPhotoDamage }) {
  const kept = [];

  for (const [i, m] of matches.entries()) {
    if (i > 0) await sleep(config.requestDelayMs);
    let current = m;

    let description = null;
    try {
      const detail = await client.itemDetails(m.id);
      description = detail?.description ?? null;
    } catch (err) {
      logger.warn?.(`No se pudo abrir la ficha de ${m.id}: ${err.message}`);
    }

    if (description !== null) {
      const reevaluated = evaluate({ ...m, description }, config);
      if (!reevaluated.match) {
        logger.log(`  fuera al leer la ficha completa [${reevaluated.reason}]: ${m.title}`);
        continue;
      }
      current = reevaluated;
    } else {
      // La ficha no se pudo leer: se acepta, pero avisando de que va a ciegas.
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

  return kept;
}
