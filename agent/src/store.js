import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePath } from './config.js';

/** Registro de anuncios ya avisados para no repetir notificaciones. */
export class SeenStore {
  constructor(path, ttlDays = 30) {
    this.path = resolvePath(path);
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    this.ids = new Map();
    this.load();
  }

  load() {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [id, ts] of Object.entries(data.ids ?? {})) this.ids.set(id, ts);
      this.prune();
    } catch {
      // Un fichero corrupto no debe tumbar el agente: se empieza de cero.
      this.ids.clear();
    }
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.ids) {
      if (Date.parse(ts) < cutoff) this.ids.delete(id);
    }
  }

  has(id) {
    return this.ids.has(id);
  }

  add(id) {
    this.ids.set(id, new Date().toISOString());
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      JSON.stringify({ updatedAt: new Date().toISOString(), ids: Object.fromEntries(this.ids) }, null, 2),
    );
  }
}
