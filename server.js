'use strict';
// AskLens relay: passes a copied link or address from a PC to a phone.
// Everything lives in memory. Items are deleted after 10 minutes. Nothing is
// written to disk and the text of an item is never logged.
const http = require('http');
const crypto = require('crypto');

const ITEM_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const PAIR_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_ITEMS = 50;
const MAX_TEXT = 2000;
const MAX_BODY = 8 * 1024;
const LONG_POLL_MS = 25 * 1000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KINDS = ['link', 'evm-address', 'solana-address'];
const PUSH_URL = process.env.PUSH_URL || 'https://exp.host/--/api/v2/push/send';

function makeApp(opts = {}) {
  const limits = Object.assign(
    { ipPerMin: 120, pairPerMin: 60, newPairPerMin: 6, claimPerMin: 10 },
    opts.limits || {}
  );
  const itemTtl = opts.itemTtlMs || ITEM_TTL_MS;
  const codeTtl = opts.codeTtlMs || CODE_TTL_MS;
  const pairs = new Map(); // pairId -> {secret, pushToken, items, waiters, lastActive}
  const codes = new Map(); // code -> {pairId, expires}
  const hits = new Map(); // bucket key -> {count, reset}
  let lastTs = 0;

  const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));
  const rand = (n) => crypto.randomBytes(n).toString('hex');

  function newCode() {
    for (;;) {
      let c = '';
      const bytes = crypto.randomBytes(8);
      for (let i = 0; i < 8; i++) c += CODE_CHARS[bytes[i] % CODE_CHARS.length];
      if (!codes.has(c)) return c;
    }
  }

  function tooMany(key, max) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + 60000 }; hits.set(key, h); }
    h.count++;
    return h.count > max;
  }

  function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  function auth(req, pairId) {
    const p = typeof pairId === 'string' ? pairs.get(pairId) : null;
    // Compare against a dummy when the pair is unknown so timing does not tell.
    const ok = sameSecret(req.headers['x-pair-secret'], p ? p.secret : 'x'.repeat(64));
    return p && ok ? p : null;
  }

  function freshItems(p) {
    const cut = Date.now() - itemTtl;
    p.items = p.items.filter((i) => i.ts > cut);
    return p.items;
  }

  function wake(p) {
    const ws = p.waiters.splice(0);
    for (const w of ws) w();
  }

  function shorten(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 37) + '...' : t;
  }

  function push(p, item) {
    if (!p.pushToken) return;
    const body = JSON.stringify({
      to: p.pushToken,
      title: 'Copied on your PC',
      body: 'Tap to check: ' + shorten(item.text),
      data: { pairId: p.id, itemId: item.id },
      sound: 'default',
    });
    const done = (r) => { if (opts.onPush) opts.onPush(r); };
    fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    }).then((r) => done(r.status)).catch(() => done('error'));
  }

  function send(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
        catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (tooMany('ip:' + ip, limits.ipPerMin)) return send(res, 429, { error: 'slow down' });

    if (req.method === 'POST' && path === '/v1/pair') {
      if (tooMany('np:' + ip, limits.newPairPerMin)) return send(res, 429, { error: 'slow down' });
      const id = rand(8), secret = rand(32), code = newCode();
      pairs.set(id, { id, secret, pushToken: null, items: [], waiters: [], lastActive: Date.now() });
      codes.set(code, { pairId: id, expires: Date.now() + codeTtl });
      return send(res, 200, { pairId: id, secret, code });
    }

    if (req.method === 'POST' && path === '/v1/claim') {
      if (tooMany('cl:' + ip, limits.claimPerMin)) return send(res, 429, { error: 'slow down' });
      const b = await readBody(req);
      const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
      const c = codes.get(code);
      if (!c || c.expires < Date.now() || !pairs.has(c.pairId)) {
        codes.delete(code);
        return send(res, 404, { error: 'code not found or expired' });
      }
      codes.delete(code); // one use
      const p = pairs.get(c.pairId);
      if (typeof b.pushToken === 'string' && b.pushToken.length < 200) p.pushToken = b.pushToken;
      p.lastActive = Date.now();
      return send(res, 200, { pairId: p.id, secret: p.secret });
    }

    if (req.method === 'POST' && path === '/v1/send') {
      const b = await readBody(req);
      const p = auth(req, b.pairId);
      if (!p) return send(res, 401, { error: 'bad pairing' });
      if (tooMany('pr:' + p.id, limits.pairPerMin)) return send(res, 429, { error: 'slow down' });
      if (!KINDS.includes(b.kind)) return send(res, 400, { error: 'bad kind' });
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > MAX_TEXT) return send(res, 400, { error: 'bad text' });
      const items = freshItems(p);
      const item = { id: rand(8), ts: nextTs(), kind: b.kind, text: b.text };
      items.push(item);
      while (items.length > MAX_ITEMS) items.shift();
      p.lastActive = Date.now();
      wake(p);
      push(p, item);
      return send(res, 200, { id: item.id, ts: item.ts });
    }

    if (req.method === 'GET' && path === '/v1/events') {
      const p = auth(req, url.searchParams.get('pairId'));
      if (!p) return send(res, 401, { error: 'bad pairing' });
      if (tooMany('pr:' + p.id, limits.pairPerMin)) return send(res, 429, { error: 'slow down' });
      const since = Number(url.searchParams.get('since')) || 0;
      p.lastActive = Date.now();
      const pick = () => freshItems(p).filter((i) => i.ts > since).map(({ id, ts, kind, text }) => ({ id, ts, kind, text }));
      const first = pick();
      if (first.length) return send(res, 200, { items: first });
      let finished = false;
      const drop = () => { const i = p.waiters.indexOf(finish); if (i >= 0) p.waiters.splice(i, 1); };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        drop();
        if (!res.writableEnded && !res.destroyed) send(res, 200, { items: pick() });
      };
      const timer = setTimeout(finish, opts.longPollMs || LONG_POLL_MS);
      p.waiters.push(finish);
      req.on('close', () => { finished = true; clearTimeout(timer); drop(); });
      return;
    }

    if (req.method === 'POST' && path === '/v1/push-token') {
      const b = await readBody(req);
      const p = auth(req, b.pairId);
      if (!p) return send(res, 401, { error: 'bad pairing' });
      if (typeof b.pushToken !== 'string' || b.pushToken.length > 200) return send(res, 400, { error: 'bad token' });
      p.pushToken = b.pushToken;
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/v1/unpair') {
      const b = await readBody(req);
      const p = auth(req, b.pairId);
      if (!p) return send(res, 401, { error: 'bad pairing' });
      pairs.delete(p.id);
      for (const [c, v] of codes) if (v.pairId === p.id) codes.delete(c);
      wake(p);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  }

  // No CORS headers on purpose: this is for the native app and the PC tool only.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    });
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [c, v] of codes) if (v.expires < now) codes.delete(c);
    for (const [id, p] of pairs) {
      freshItems(p);
      if (p.lastActive < now - PAIR_IDLE_MS) pairs.delete(id);
    }
    for (const [k, h] of hits) if (h.reset <= now) hits.delete(k);
  }, 30000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));
  return server;
}

module.exports = { makeApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  makeApp().listen(port, () => console.log('AskLens relay listening on port ' + port));
}
