/**
 * Analisis opcional de la foto del anuncio con la API de Claude.
 *
 * Solo se activa si ANTHROPIC_API_KEY esta definido (en agent/.env) y el
 * paquete @anthropic-ai/sdk esta instalado (npm install). Sin ambas cosas el
 * agente funciona igual, simplemente sin mirar las fotos.
 */

const VISION_MODEL = process.env.REWATCH_VISION_MODEL || 'claude-opus-5';

let clientPromise = null;

async function getClient(logger) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then((mod) => new mod.default())
      .catch(() => {
        logger.warn?.(
          'ANTHROPIC_API_KEY esta definido pero falta el paquete @anthropic-ai/sdk.\n'
          + 'Ejecuta "npm install" dentro de la carpeta agent para activar el analisis de fotos.',
        );
        return null;
      });
  }
  return clientPromise;
}

export function visionEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Mira la foto principal del anuncio y devuelve { damaged, reason } o null si
 * no se pudo analizar (sin clave, sin foto, error de red...). Cualquier fallo
 * es no-bloqueante: mejor dejar pasar un anuncio que tirar el agente.
 */
export async function checkPhotoDamage(photoUrl, { logger = console } = {}) {
  const client = await getClient(logger);
  if (!client || !photoUrl) return null;

  try {
    const res = await fetch(photoUrl);
    if (!res.ok) return null;
    const mediaType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');

    const response = await client.beta.messages.create({
      model: VISION_MODEL,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              danado: { type: 'boolean' },
              motivo: { type: 'string' },
            },
            required: ['danado', 'motivo'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            {
              type: 'text',
              text:
                'Foto de un anuncio de Apple Watch de segunda mano. '
                + '¿Se aprecia la pantalla rota, rajada o el cristal agrietado? '
                + 'Marcas leves de uso o reflejos no cuentan como rotura. '
                + 'Responde danado=true solo si hay rotura claramente visible, con el motivo en una frase.',
            },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    const verdict = JSON.parse(text);
    return { damaged: Boolean(verdict.danado), reason: verdict.motivo ?? '' };
  } catch (err) {
    logger.warn?.(`No se pudo analizar la foto (${err.message}); el anuncio pasa sin revisar.`);
    return null;
  }
}
