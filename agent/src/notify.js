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
  const extras = [m.cellular ? 'cellular' : null, ...(m.flags?.length ? ['ojo: ' + m.flags.length + ' aviso(s)'] : [])]
    .filter(Boolean)
    .join(', ');
  return `${String(m.price).padStart(5)} ${m.currency}  ${m.modelLabel} ${size}${extras ? ` (${extras})` : ''}\n`
    + `        ${m.title}\n`
    + `        ${m.url}`;
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
    if (!res.ok) logger.warn?.(`Telegram respondio HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    logger.warn?.(`No se pudo avisar por Telegram: ${err.message}`);
    return false;
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
