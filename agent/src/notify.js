import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resolvePath, saveEnvVar } from './config.js';

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

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** Aviso por Telegram si estan definidos TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID. */
export async function sendTelegram(matches, { logger = console } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!matches.length) return false;
  if (!token || !chatId) {
    logger.warn?.(
      'AVISO: Telegram no esta configurado (falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en agent/.env).\n'
      + 'Ejecuta: node src/index.js --test-telegram',
    );
    return false;
  }

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
      logger.warn?.(`FALLO el aviso por Telegram (HTTP ${res.status}: ${body.description ?? 'sin detalle'})`);
      return false;
    }
    logger.log(`Aviso enviado a Telegram (${Math.min(matches.length, 10)} de ${matches.length} anuncios en el mensaje).`);
    return true;
  } catch (err) {
    logger.warn?.(`No se pudo avisar por Telegram: ${err.message}`);
    return false;
  }
}

async function tg(token, method) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

async function findChats(token) {
  const updates = await tg(token, 'getUpdates');
  const chats = new Map();
  for (const u of updates.result ?? []) {
    const c = u.message?.chat;
    if (c) chats.set(String(c.id), c.first_name ?? c.title ?? c.username ?? '');
  }
  return chats;
}

/**
 * Asistente interactivo de Telegram (comando --test-telegram).
 * Pide el token por pantalla, descubre el chat id, guarda ambos en agent/.env
 * el solo y termina enviando un mensaje de prueba. En cada fallo explica que
 * corregir; no hace falta editar ningun fichero a mano.
 */
export async function testTelegram({ logger = console } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+D o entrada agotada cuentan como "salir", no como error.
  const ask = (q) => rl.question(q).then((a) => a.trim()).catch(() => null);

  try {
    // ---- Paso 1: token ----
    let token = process.env.TELEGRAM_BOT_TOKEN;
    let me = token ? await tg(token, 'getMe') : null;
    if (me && !me.ok) {
      logger.log(`El token guardado ya no vale (Telegram dice: ${me.description}). Vamos a pedirlo de nuevo.\n`);
      token = null;
    }

    while (!token) {
      logger.log(
        'PASO 1 — El token de tu bot\n'
        + '  1. En Telegram, abre @BotFather y envia /newbot\n'
        + '  2. Dale un nombre (el que quieras) y un usuario que acabe en "bot"\n'
        + '  3. BotFather te respondera con un token tipo 123456789:AAH3xxxxx\n',
      );
      const answer = await ask('Pega aqui el token y pulsa Enter (o escribe q para salir): ');
      if (!answer || answer.toLowerCase() === 'q') {
        logger.log('Asistente cancelado. Vuelve cuando tengas el token: node src/index.js --test-telegram');
        return false;
      }

      me = await tg(answer, 'getMe');
      if (!me.ok) {
        logger.log(
          `\nEse token no vale (Telegram dice: ${me.description}).\n`
          + 'Copialo entero del mensaje de @BotFather, con los dos puntos, sin espacios.\n',
        );
        continue;
      }
      token = answer;
      saveEnvVar('TELEGRAM_BOT_TOKEN', token);
      logger.log('\nGuardado en agent/.env — no tendras que volver a pegarlo.');
    }
    logger.log(`Token correcto. Tu bot es @${me.result.username}\n`);

    // ---- Paso 2: chat id ----
    let chatId = process.env.TELEGRAM_CHAT_ID;
    while (!chatId) {
      const chats = await findChats(token);
      if (chats.size === 1) {
        const [[id, name]] = [...chats];
        chatId = id;
        saveEnvVar('TELEGRAM_CHAT_ID', chatId);
        logger.log(`PASO 2 — Chat encontrado: ${name} (id ${id}). Guardado en agent/.env.\n`);
      } else if (chats.size > 1) {
        logger.log('PASO 2 — Varios chats han hablado con tu bot:');
        for (const [id, name] of chats) logger.log(`   ${id}  (${name})`);
        const pick = await ask('\nEscribe el id que es el tuyo (q para salir): ');
        if (pick === null || pick.toLowerCase() === 'q') return false;
        if (chats.has(pick)) {
          chatId = pick;
          saveEnvVar('TELEGRAM_CHAT_ID', chatId);
        } else {
          logger.log('Ese id no esta en la lista, prueba otra vez.\n');
        }
      } else {
        logger.log(
          'PASO 2 — Tu chat id\n'
          + `  1. Abre este enlace en Telegram: https://t.me/${me.result.username}\n`
          + '  2. Pulsa "Iniciar" (o "Start")\n'
          + '  3. Enviale cualquier mensaje, por ejemplo "hola"\n',
        );
        const cont = await ask('Cuando lo hayas hecho, pulsa Enter y lo detecto solo (q para salir): ');
        if (cont === null || cont.toLowerCase() === 'q') return false;
      }
    }

    // ---- Paso 3: mensaje de prueba ----
    const fake = [{ modelLabel: 'Prueba ReWatch', sizeMm: 44, price: 65, currency: 'EUR', url: 'https://www.vinted.es' }];
    const ok = await sendTelegram(fake, { logger });
    if (ok) {
      logger.log('PASO 3 — Mensaje de prueba enviado: mira tu Telegram. Todo conectado.\n\nYa puedes arrancar el agente con: npm run watch');
    } else {
      logger.log(
        'PASO 3 — No se pudo enviar el mensaje de prueba.\n'
        + 'Si el error dice "chat not found", borra la linea TELEGRAM_CHAT_ID de agent/.env\n'
        + 'y vuelve a ejecutar este comando para detectarlo de nuevo.',
      );
    }
    return ok;
  } finally {
    rl.close();
  }
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
