'use strict';
// Plays the phone against a relay running in this process. Run: node test/phone-sim.js
const http = require('http');
const assert = require('assert');
const { makeApp } = require('../server');

let pushes = [];
const fakePush = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => { pushes.push(JSON.parse(b)); res.end('{}'); });
});

async function call(base, method, path, body, secret) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-pair-secret': secret } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json, headers: r.headers };
}

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['ok  ', name]); } catch (e) { results.push(['FAIL', name + ' -> ' + e.message]); process.exitCode = 1; }
}

(async () => {
  await new Promise((r) => fakePush.listen(0, r));
  process.env.PUSH_URL = 'http://127.0.0.1:' + fakePush.address().port + '/push';
  // PUSH_URL is read when the module loads, so reload it.
  delete require.cache[require.resolve('../server')];
  const { makeApp: mk } = require('../server');

  const server = mk({ longPollMs: 3000, itemTtlMs: 1500, codeTtlMs: 1000, limits: { claimPerMin: 5, pairPerMin: 8, newPairPerMin: 100 } });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const pc = await call(base, 'POST', '/v1/pair');
  let phone;

  await t('health works', async () => assert.strictEqual((await call(base, 'GET', '/health')).status, 200));
  await t('pair returns an 8 character code with no lookalikes', async () => {
    assert.match(pc.json.code, /^[A-HJ-KM-NP-Z2-9]{8}$/);
    assert.match(pc.json.secret, /^[0-9a-f]{64}$/);
  });
  await t('phone claims the code and gets the same pairing', async () => {
    const r = await call(base, 'POST', '/v1/claim', { code: pc.json.code, pushToken: 'ExponentPushToken[test]' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.pairId, pc.json.pairId);
    assert.strictEqual(r.json.secret, pc.json.secret);
    phone = r.json;
  });
  await t('code works only once', async () => assert.strictEqual((await call(base, 'POST', '/v1/claim', { code: pc.json.code })).status, 404));
  await t('no CORS headers', async () => {
    const r = await call(base, 'GET', '/health');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });
  await t('a copied link arrives within 2 seconds on a waiting phone, and a push goes out', async () => {
    pushes = [];
    const started = Date.now();
    const poll = call(base, 'GET', `/v1/events?pairId=${phone.pairId}&since=0`, null, phone.secret);
    await new Promise((r) => setTimeout(r, 300));
    const long = 'https://example.com/' + 'a'.repeat(300);
    const sent = await call(base, 'POST', '/v1/send', { pairId: pc.json.pairId, kind: 'link', text: long }, pc.json.secret);
    assert.strictEqual(sent.status, 200);
    const got = await poll;
    const ms = Date.now() - started;
    assert.strictEqual(got.json.items.length, 1);
    assert.strictEqual(got.json.items[0].text, long);
    assert.ok(ms < 2000, 'took ' + ms + 'ms');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].title, 'Copied on your PC');
    assert.ok(pushes[0].body.length < 70 && pushes[0].body.startsWith('Tap to check: '));
    assert.ok(!JSON.stringify(pushes[0]).includes('a'.repeat(100)));
    assert.deepStrictEqual(Object.keys(pushes[0].data).sort(), ['itemId', 'pairId']);
    console.log('   (delivered in ' + ms + ' ms)');
  });
  await t('since filters out items already seen', async () => {
    const all = await call(base, 'GET', `/v1/events?pairId=${phone.pairId}&since=0`, null, phone.secret);
    const last = all.json.items[all.json.items.length - 1].ts;
    const r = await call(base, 'GET', `/v1/events?pairId=${phone.pairId}&since=${last}`, null, phone.secret);
    assert.deepStrictEqual(r.json.items, []); // returns empty after the 3s long poll
  });
  await t('items expire', async () => {
    await new Promise((r) => setTimeout(r, 1700));
    const r = await call(base, 'GET', `/v1/events?pairId=${phone.pairId}&since=0`, null, phone.secret);
    assert.deepStrictEqual(r.json.items, []);
  });
  await t('wrong secret is refused on send, events, push-token and unpair', async () => {
    const bad = 'f'.repeat(64);
    assert.strictEqual((await call(base, 'POST', '/v1/send', { pairId: phone.pairId, kind: 'link', text: 'https://a.io' }, bad)).status, 401);
    assert.strictEqual((await call(base, 'GET', `/v1/events?pairId=${phone.pairId}`, null, bad)).status, 401);
    assert.strictEqual((await call(base, 'POST', '/v1/push-token', { pairId: phone.pairId, pushToken: 'x' }, bad)).status, 401);
    assert.strictEqual((await call(base, 'POST', '/v1/unpair', { pairId: phone.pairId }, bad)).status, 401);
    assert.strictEqual((await call(base, 'POST', '/v1/send', { pairId: phone.pairId, kind: 'link', text: 'https://a.io' })).status, 401);
  });
  await t('bad kind and oversize text are refused', async () => {
    assert.strictEqual((await call(base, 'POST', '/v1/send', { pairId: phone.pairId, kind: 'note', text: 'hi' }, phone.secret)).status, 400);
    assert.strictEqual((await call(base, 'POST', '/v1/send', { pairId: phone.pairId, kind: 'link', text: 'x'.repeat(2001) }, phone.secret)).status, 400);
  });
  await t('a pairing code expires', async () => {
    const p2 = await call(base, 'POST', '/v1/pair');
    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual((await call(base, 'POST', '/v1/claim', { code: p2.json.code })).status, 404);
  });
  await t('only 50 items are kept per pair', async () => {
    const p3 = await call(base, 'POST', '/v1/pair');
    const s = p3.json;
    // the per pair limit is 8 a minute in this test, so use a relay with a high limit
    const big = mk({ itemTtlMs: 60000, limits: { pairPerMin: 1000, ipPerMin: 1000, newPairPerMin: 100 } });
    await new Promise((r) => big.listen(0, r));
    const b2 = 'http://127.0.0.1:' + big.address().port;
    const q = await call(b2, 'POST', '/v1/pair');
    for (let i = 0; i < 60; i++) await call(b2, 'POST', '/v1/send', { pairId: q.json.pairId, kind: 'link', text: 'https://e.com/' + i }, q.json.secret);
    const ev = await call(b2, 'GET', `/v1/events?pairId=${q.json.pairId}&since=0`, null, q.json.secret);
    assert.strictEqual(ev.json.items.length, 50);
    big.close();
  });
  await t('rate limit kicks in per pair', async () => {
    const q = await call(base, 'POST', '/v1/pair');
    let hit = false;
    for (let i = 0; i < 12; i++) {
      const r = await call(base, 'POST', '/v1/send', { pairId: q.json.pairId, kind: 'link', text: 'https://e.com/' + i }, q.json.secret);
      if (r.status === 429) hit = true;
    }
    assert.ok(hit);
  });
  await t('claim attempts are rate limited per IP (code guessing)', async () => {
    let hit = false;
    for (let i = 0; i < 8; i++) if ((await call(base, 'POST', '/v1/claim', { code: 'AAAAAAAA' })).status === 429) hit = true;
    assert.ok(hit);
  });
  await t('unpair removes the pairing', async () => {
    const q = await call(base, 'POST', '/v1/pair');
    assert.strictEqual((await call(base, 'POST', '/v1/unpair', { pairId: q.json.pairId }, q.json.secret)).status, 200);
    assert.strictEqual((await call(base, 'POST', '/v1/send', { pairId: q.json.pairId, kind: 'link', text: 'https://a.io' }, q.json.secret)).status, 401);
  });

  for (const [s, n] of results) console.log(s, n);
  server.close();
  fakePush.close();
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})();
