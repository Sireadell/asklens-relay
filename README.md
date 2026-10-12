# AskLens relay

This is the small server that carries a link or wallet address from your PC to your phone. It does one job and it keeps nothing.

**The relay forgets everything after 10 minutes.** Copied items live in memory only, they are deleted 10 minutes after they arrive, nothing is written to a disk or a database, and I never write the copied text into a log. If the server restarts, it forgets even sooner. A pairing itself (the secret that lets your PC and phone talk) is dropped after 12 hours without use, or right away when you unpair.

I do not check anything here. The relay only passes the text along. The phone app runs the real check.

## How it works

1. The PC asks for a pairing and gets a one-time 8 character code that lasts 10 minutes.
2. The phone sends that code and gets the same secret. After that the code is useless.
3. When the PC copies a link or address, it posts it. If the phone gave a push token, the relay sends a short notification ("Tap to check: example.com...", never the whole text).
4. The phone holds a request open for up to 25 seconds and gets the item the moment it arrives.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone | `{ok:true}` |
| `POST /v1/pair` | PC | returns `{pairId, secret, code}` |
| `POST /v1/claim` | phone | body `{code, pushToken?}`, returns `{pairId, secret}` |
| `POST /v1/send` | PC | header `x-pair-secret`, body `{pairId, kind, text}`, returns `{id, ts}`. `kind` is `link`, `evm-address` or `solana-address`. Text up to 2000 characters, 50 items per pair |
| `GET /v1/events?pairId=...&since=<ts>` | phone | header `x-pair-secret`, waits up to 25 s, returns `{items:[{id,ts,kind,text}]}` |
| `POST /v1/push-token` | phone | header `x-pair-secret`, body `{pairId, pushToken}` |
| `POST /v1/unpair` | either | header `x-pair-secret`, body `{pairId}` |

## Safety

- Secrets are 32 random bytes in hex, compared in constant time.
- Rate limits per IP and per pairing, and a tight one on guessing codes.
- No CORS headers, so a website cannot talk to it. It is for the app and the PC tool only.
- Only Node's built in modules. No packages to install.

## Run it on your computer

```powershell
cd relay
node server.js
```

It listens on port 8787 (or the `PORT` variable). To run the tests:

```powershell
cd relay
node test/phone-sim.js
```

To play the phone by hand, start the relay, start the PC companion with `--relay http://localhost:8787`, then in a third window:

```powershell
node test/phone-listen.js http://localhost:8787 YOURCODE
```

To put it online, follow `DEPLOY.md`.
