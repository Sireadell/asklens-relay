'use strict';
// Pretends to be the phone. Usage: node test/phone-listen.js <relay url> <pairing code>
// Claims the code, then prints every item the PC sends and how long it took.
const [relay, code] = process.argv.slice(2);
if (!relay || !code) { console.log('Usage: node test/phone-listen.js <relay url> <code>'); process.exit(1); }

(async () => {
  const r = await fetch(relay + '/v1/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!r.ok) { console.log('claim failed: ' + r.status); process.exit(1); }
  const { pairId, secret } = await r.json();
  console.log('phone paired, waiting for items...');
  let since = 0;
  for (;;) {
    try {
      const e = await fetch(`${relay}/v1/events?pairId=${pairId}&since=${since}`, { headers: { 'x-pair-secret': secret } });
      if (!e.ok) { console.log('events failed: ' + e.status); process.exit(1); }
      for (const i of (await e.json()).items) {
        since = Math.max(since, i.ts);
        console.log(`[${i.kind}] ${i.text}  (arrived ${Date.now() - i.ts} ms after the copy)`);
      }
    } catch (err) { await new Promise((s) => setTimeout(s, 1000)); }
  }
})();
