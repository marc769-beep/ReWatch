import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePath } from './config.js';

const CSV_COLUMNS = ['foundAt', 'id', 'modelLabel', 'sizeMm', 'price', 'currency', 'condition', 'seller', 'title', 'url'];

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatLine(m) {
  const size = m.sizeMm ? `${m.sizeMm}mm` : 'tamano?';
  const head = `${String(m.price).padStart(6)} ${m.currency}  ${m.modelLabel} ${size}`
    + `${m.cellular ? ' cellular' : ''}${m.condition ? ` · ${m.condition}` : ''}`;
  const avisos = m.flags?.length ? `\n        ojo: ${m.flags.join(', ')}` : '';
  return `${head}\n        ${m.title}\n        ${m.url}${avisos}`;
}

export function appendJsonl(path, matches) {
  if (!path || !matches.length) return;
  const file = resolvePath(path);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, matches.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

export function appendCsv(path, matches) {
  if (!path || !matches.length) return;
  const file = resolvePath(path);
  mkdirSync(dirname(file), { recursive: true });
  const header = existsSync(file) ? '' : CSV_COLUMNS.join(',') + '\n';
  const rows = matches.map((m) => CSV_COLUMNS.map((c) => csvCell(m[c])).join(',')).join('\n');
  appendFileSync(file, header + rows + '\n');
}

/** Aviso por Telegram si estan definidos TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID. */
export async function sendTelegram(matches, { logger = console } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !matches.length) return false;

  const body = matches
    .slice(0, 10)
    .map((m) => `${m.modelLabel}${m.sizeMm ? ` ${m.sizeMm}mm` : ''} — ${m.price} ${m.currency}\n${m.url}`)
    .join('\n\n');
  const text = `ReWatch: ${matches.length} Apple Watch nuevos en Vinted\n\n${body}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      logger.warn?.(`Telegram respondio HTTP ${res.status}: ${body.description ?? 'sin detalle'}`);
    }
    return res.ok;
  } catch (err) {
    logger.warn?.(`No se pudo avisar por Telegram: ${err.message}`);
    return false;
  }
}

async function tg(token, method) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

/**
 * Diagnostico paso a paso de la conexion con Telegram (comando --test-telegram).
 * Comprueba el token, ayuda a encontrar el chat id y envia un mensaje de prueba,
 * explicando en cada fallo que hay que corregir.
 */
export async function testTelegram({ logger = console } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    logger.log(
      'Falta TELEGRAM_BOT_TOKEN.\n\n'
      + '1. En Telegram, abre @BotFather y envia /newbot\n'
      + '2. Dale un nombre y un usuario (debe acabar en "bot", p. ej. rewatch_marc_bot)\n'
      + '3. BotFather te dara un token tipo 123456789:AAH3xxxxx...\n'
      + '4. Crea el fichero agent/.env con esta linea:\n\n'
      + '   TELEGRAM_BOT_TOKEN=tu_token\n\n'
      + 'y vuelve a ejecutar: node src/index.js --test-telegram',
    );
    return false;
  }

  const me = await tg(token, 'getMe');
  if (!me.ok) {
    logger.log(
      `El token no es valido (Telegram dice: ${me.description}).\n`
      + 'Copia el token completo de @BotFather, incluidos los dos puntos, sin espacios.',
    );
    return false;
  }
  logger.log(`Token correcto. Tu bot es @${me.result.username}`);

  if (!chatId) {
    const updates = await tg(token, 'getUpdates');
    const chats = new Map();
    for (const u of updates.result ?? []) {
      const c = u.message?.chat;
      if (c) chats.set(c.id, c.first_name ?? c.title ?? c.username ?? '');
    }
    if (!chats.size) {
      logger.log(
        '\nFalta TELEGRAM_CHAT_ID y tu bot aun no ha recibido ningun mensaje.\n\n'
        + `1. Abre https://t.me/${me.result.username} en Telegram\n`
        + '2. Pulsa "Iniciar" (o "Start") y envia cualquier mensaje, p. ej. "hola"\n'
        + '3. Vuelve a ejecutar: node src/index.js --test-telegram\n'
        + 'y te dire tu chat id.',
      );
      return false;
    }
    logger.log('\nHe encontrado estos chats hablando con tu bot:');
    for (const [id, name] of chats) logger.log(`   chat id ${id}  (${name})`);
    logger.log(
      '\nAnade el tuyo a agent/.env:\n\n'
      + `   TELEGRAM_CHAT_ID=${[...chats.keys()][0]}\n\n`
      + 'y vuelve a ejecutar: node src/index.js --test-telegram',
    );
    return false;
  }

  const fake = [{ modelLabel: 'Prueba ReWatch', sizeMm: 44, price: 65, currency: 'EUR', url: 'https://www.vinted.es' }];
  const ok = await sendTelegram(fake, { logger });
  if (ok) {
    logger.log('\nMensaje de prueba enviado: mira tu Telegram. Ya esta todo conectado.');
  } else {
    logger.log(
      '\nNo se pudo enviar. Si el error dice "chat not found", el chat id esta mal\n'
      + 'o todavia no has pulsado "Iniciar" en el chat con tu bot.\n'
      + 'Borra TELEGRAM_CHAT_ID del .env y vuelve a ejecutar este comando para detectarlo.',
    );
  }
  return ok;
}

/** Aviso generico (Slack, Discord, n8n...) si esta definido WEBHOOK_URL. */
export async function sendWebhook(matches, { logger = console } = {}) {
  const url = process.env.WEBHOOK_URL;
  if (!url || !matches.length) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'rewatch-agent', count: matches.length, matches }),
    });
    if (!res.ok) logger.warn?.(`Webhook respondio HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    logger.warn?.(`No se pudo avisar por webhook: ${err.message}`);
    return false;
  }
}

export async function notify(matches, config, { logger = console } = {}) {
  const limit = config.output.consoleLimit;
  logger.log(`\n${matches.length} anuncio(s) nuevos que encajan:\n`);
  for (const m of matches.slice(0, limit)) logger.log(formatLine(m) + '\n');
  if (matches.length > limit) logger.log(`... y ${matches.length - limit} mas (ver ${config.output.jsonlPath})`);

  appendJsonl(config.output.jsonlPath, matches);
  appendCsv(config.output.csvPath, matches);
  await Promise.all([sendTelegram(matches, { logger }), sendWebhook(matches, { logger })]);
}
