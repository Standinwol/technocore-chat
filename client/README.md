# Signal ID dApp client

The client uses two independent identities and Technocore as the message transport:

1. The browser creates a **User DID**. Its active seed is tab-scoped; an optional local vault
   encrypts saved seeds with PBKDF2-SHA-256 and AES-GCM.
2. A Vercel Function publishes only the configured **Host DID**. The corresponding Host seed never
   leaves the VPS.
3. The browser signs `room|nonce|text` and POSTs the envelope to the same-origin
   `/api/technocore` proxy. The proxy has a fixed upstream, accepts only valid signed shapes, and
   returns the server-assigned sequence.
4. The VPS long-polls the same `mb-p-<random>` room. It ignores unsigned/unknown senders, calls
   Binance only for allowlisted User DIDs, and posts a signed Host reply.
5. The browser long-poll renders that reply as Host output only when `from` exactly equals the
   public `HOST_DID` returned by `/api/host`.

No DID registry or application database is required. Technocore stores the full signed writer DID
in each JSON message; the browser vault stores User identities, Vercel stores only the public Host
DID, and SQLite on the VPS stores agent cursors/nonces/outbox state.

## Deployment order for the test dApp

1. Import this Git repository into Vercel. Set the project root to `client`, framework preset to
   **Other**, and leave the static build command empty. The generated `*.vercel.app` URL is enough;
   a custom domain is optional.
2. Deploy once, open the Vercel URL, generate the User DID, and save it in the encrypted vault.
   Copy the public User DID.
3. On the VPS, follow [`../agent/README.md`](../agent/README.md): create a random `mb-p-` mailbox,
   generate the Host seed, and put the User DID in `ALLOWED_USER_DIDS`.
4. Copy the printed public Host DID into Vercel as `HOST_DID`. Optional variables are `HOST_NAME`
   and `TECHNOCORE_URL`; the latter defaults to `https://technocore.chat`.
5. Redeploy Vercel so `/api/host` sees the new environment, then start the systemd Host service.
6. In the client Rooms panel, enter the private mailbox name and connect. Put the same room in the
   Publish panel, write `BTC price`, and use **Sign & post**. The UI shows the returned sequence;
   the Host reply appears in room history with the Host label.

The private mailbox is intentionally not embedded in client source or Vercel environment output.
Anyone who learns it can read it, so use a long random suffix and treat the URL as a secret. Message
content is not encrypted from the Technocore operator.

## Local and Vercel checks

A plain static server is enough for layout, browser crypto, and direct Binance data:

```bash
python -m http.server 4173 --directory client
```

The `/api/*` Vercel Functions do not exist under that static server. Use a Vercel preview deployment
for the full room/Host workflow. Before deploying, run the checked-in contracts:

```bash
node --check client/app.mjs
node tests/client_crypto_probe.mjs
node tests/client_technocore_probe.mjs
node tests/client_vault_probe.mjs
node tests/client_security_probe.mjs
```

`client/vercel.json` applies the CSP and related browser security headers. The browser talks to
Binance directly for its live watchlist, but all Technocore reads/writes use the same-origin proxy
because the public Technocore service does not expose browser CORS for arbitrary Vercel origins.
