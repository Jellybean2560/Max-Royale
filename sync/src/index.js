// Max Royale sync — one Durable Object per sync code. The phones merge; this
// only stores the last merged copy of the app's history (BACKUP_KEYS in the app).
// The code is the only secret: anyone who knows it can read and write that copy.
import { DurableObject } from 'cloudflare:workers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

const CODE_RE = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/;
const MAX_BODY = 20 * 1024 * 1024;
const CHUNK = 400000;   // characters per stored row (a row holds at most 2 MB)

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return json({ ok: true, service: 'max-royale-sync' });
    const m = url.pathname.match(/^\/s\/([^/]+)$/);
    if (!m) return json({ error: 'Not found' }, 404);
    const code = decodeURIComponent(m[1]).toLowerCase();
    if (!CODE_RE.test(code)) return json({ error: 'Invalid sync code' }, 400);
    const stub = env.VAULTS.get(env.VAULTS.idFromName(code));
    if (req.method === 'GET') return json(await stub.read());
    if (req.method === 'PUT') {
      const text = await req.text();
      if (text.length > MAX_BODY) return json({ error: 'Too much data' }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'Bad JSON' }, 400); }
      if (!body || typeof body.data !== 'object' || Array.isArray(body.data)) return json({ error: 'No data' }, 400);
      for (const v of Object.values(body.data)) if (typeof v !== 'string') return json({ error: 'Values must be strings' }, 400);
      const res = await stub.write(body.data, +body.base || 0);
      return json(res, res.conflict ? 409 : 200);
    }
    return json({ error: 'Method not allowed' }, 405);
  },
};

export class Vault extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT, i INTEGER, v TEXT, PRIMARY KEY (k, i))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, at INTEGER)`);
  }
  at() { return this.sql.exec(`SELECT at FROM meta WHERE id = 1`).toArray()[0]?.at || 0; }
  read() {
    const data = {};
    for (const r of this.sql.exec(`SELECT k, v FROM kv ORDER BY k, i`)) data[r.k] = (data[r.k] || '') + r.v;
    return { data, at: this.at() };
  }
  // Only on top of the copy the phone merged with: if another phone wrote in
  // between, it gets the newer copy back and merges again
  write(data, base) {
    const at = this.at();
    if (base !== at) return { conflict: true, ...this.read() };
    const now = Math.max(Date.now(), at + 1);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM kv`);
      for (const [k, v] of Object.entries(data))
        for (let i = 0; i * CHUNK < v.length || i === 0; i++) this.sql.exec(`INSERT INTO kv (k, i, v) VALUES (?, ?, ?)`, k, i, v.slice(i * CHUNK, (i + 1) * CHUNK));
      this.sql.exec(`INSERT OR REPLACE INTO meta (id, at) VALUES (1, ?)`, now);
    });
    return { ok: true, at: now };
  }
}
