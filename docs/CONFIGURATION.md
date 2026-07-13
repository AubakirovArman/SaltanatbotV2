# Configuration & deployment

SaltanatbotV2 is configured mostly at runtime through the app itself. The backend reads a small set of environment variables for listen/auth/session behavior; everything sensitive — exchange API keys, Telegram/VK notification credentials — is entered in the UI, encrypted with AES-256-GCM, and persisted in a local SQLite database. This guide covers the environment variables, where runtime state lives, how to configure secrets through the app, the at-rest encryption scheme, a production deployment recipe, and a hardening checklist for exposing the server publicly.

## Environment variables

The backend reads these environment variables in `backend/src/server.ts` / `backend/src/auth.ts`:

| Variable          | Default       | Purpose                                                                                 |
| ----------------- | ------------- | --------------------------------------------------------------------------------------- |
| `PORT`            | `4180`        | TCP port the HTTP + WebSocket server listens on.                                        |
| `HOST`            | `127.0.0.1`   | Interface the server binds to. Loopback by default (fail-safe). Set `0.0.0.0` to expose. |
| `AUTH_TOKEN`      | *(auto)*      | Admin token used to unlock the Trade tab. Browser login exchanges it for an HttpOnly session cookie. |
| `AUTH_READONLY_TOKEN` | *(unset)* | Optional token for read-only trade visibility. Cannot mutate bots/settings. |
| `AUTH_PAPER_TRADE_TOKEN` | *(unset)* | Optional token that can manage paper bots and price-alert delivery, but cannot create/start live bots. |
| `AUTH_LIVE_TRADE_TOKEN` | *(unset)* | Optional token that can start/stop/command live bots once live trading is armed. Admin still controls keys/settings. |
| `AUTH_SESSION_TTL_MS` | `43200000` | HttpOnly browser session TTL (default 12 hours). |
| `AUTH_WS_TICKET_TTL_MS` | `30000` | One-time `/trade-stream` ticket TTL. |
| `COOKIE_SECURE`   | *(off)*       | Set to `1` behind HTTPS so session cookies are marked `Secure`. |
| `DEMO_MODE`       | *(off)*       | `1`/`true` disables exchange keys and live trading — paper only. For public demos.       |
| `ALLOWED_ORIGINS` | dev localhost | Comma-separated CORS allowlist for cross-origin browser access. Same-origin always works. |

To run on a different port, exposed on all interfaces, with a fixed token:

```bash
PORT=8080 HOST=0.0.0.0 AUTH_TOKEN="your-long-random-secret" npm start
```

On first run (no `AUTH_TOKEN` set) the server prints the generated token — you need it to log in to the **Trade** tab:

```
SaltanatbotV2 backend listening on http://127.0.0.1:4180

🔑 Trading API access token (needed to log in to the Trade tab):
      qN7x2Lp9wR4tKv8mZ3bYc6Hs1Fd0Ea5   ← example only; yours will differ
   Stored in backend/data/.authtoken · override with the AUTH_TOKEN env var.
```

If you bind to a non-loopback address, the server prints a warning to put it behind a reverse proxy with TLS (see [Security hardening](#security-hardening)).

> **Public market data is open; the trading API is not.** `/api/candles`, `/api/sparklines`, `/api/catalog` and the `/stream` market socket need no token (they only serve public candles). The browser exchanges `AUTH_TOKEN` at `POST /api/trade/session` for an HttpOnly `sbv2_session` cookie and a CSRF token; mutating trade requests require `X-CSRF-Token`. `/trade-stream` uses a short-lived one-time ticket from `POST /api/trade/ws-ticket`. Exchange keys and notification tokens are still entered in the UI and stored encrypted — never in environment variables.

> **`.env` is git-ignored** (with a committed `.env.example` allowed). Secrets belong in the encrypted store or `AUTH_TOKEN`, not committed files.

### Exchange testnet release smoke

The release-only `npm run test:testnet` command is deliberately separate from normal CI and refuses all network access unless `RUN_EXCHANGE_TESTNET_SMOKE=1`. It performs read-only authenticated checks against Binance Futures Demo and Bybit Testnet; it never creates a trading order. The Binance listenKey check creates and immediately invalidates a temporary user-data token.

| Variable | Required when selected | Purpose |
| --- | --- | --- |
| `RUN_EXCHANGE_TESTNET_SMOKE` | Always | Must equal `1`, otherwise the runner exits before network access. |
| `TESTNET_EXCHANGES` | No | `binance`, `bybit`, or `binance,bybit` (default). |
| `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` | Binance | Futures Demo credentials. |
| `BYBIT_TESTNET_API_KEY` / `BYBIT_TESTNET_API_SECRET` | Bybit | Bybit Testnet credentials. |
| `BINANCE_TESTNET_BASE` | No | Override only for an HTTPS hostname containing `demo` or `testnet`. |
| `BYBIT_TESTNET_BASE` | No | Override only for an HTTPS hostname containing `demo` or `testnet`. |

Repository maintainers configure these four credentials as secrets in the protected GitHub `exchange-testnet` environment and add required reviewers there. The `Exchange testnet smoke` workflow is `workflow_dispatch` only, has read-only repository permissions, and never runs on pull requests or pushes.

### Live-trading arming

Live trading (Binance/Bybit) is **disarmed by default**. Even with valid API keys, a live bot will not start until you:

1. Enable **Arm live trading** in the Trade → Settings panel (persisted server-side), and
2. Confirm the live-start prompt on the bot (`confirmLive`).

The **kill switch** (Trade → Settings) stops every running bot and disarms live trading instantly. `DEMO_MODE=1` forces paper-only regardless of these settings.

### Development ports

In development the Vite dev server (frontend) runs separately and proxies API and WebSocket traffic to the backend. From `frontend/vite.config.ts`:

| Service          | Port   | Notes                                              |
| ---------------- | ------ | -------------------------------------------------- |
| Backend (Express)| `4181` | Root `npm run dev` sets `PORT=4181`; serves HTTP `/api/*` and WebSockets. |
| Frontend (Vite)  | `4180` | Proxies `/api`, `/stream`, and `/trade-stream` to `127.0.0.1:4181`. |

In production this split disappears — the backend serves the built frontend directly (see [Production deployment](#production-deployment)).

## Where runtime state lives

All runtime state is stored under `backend/data/`, resolved relative to the compiled backend in `backend/src/trading/store.ts`:

```ts
const dataDir = path.resolve(__dirname, "../../data");
const dbPath = path.join(dataDir, "trading.db");
const secretPath = path.join(dataDir, ".secret");
```

| Path                       | What it is                                                        |
| -------------------------- | ---------------------------------------------------------------- |
| `backend/data/.secret`     | Random 32-byte hex seed for the AES encryption key. Written with file mode `0600`. |
| `backend/data/trading.db`  | SQLite database (`node:sqlite`) holding bots, fills, logs, and encrypted settings. |

Both are **created automatically at runtime** the first time the store initializes — `initStore()` calls `mkdirSync(dataDir, { recursive: true })` if the directory is missing, generates `.secret` if absent, and runs `CREATE TABLE IF NOT EXISTS` for every table. You do not create these by hand.

Both are **gitignored and must never be committed.** The repository's `.gitignore` explicitly excludes `backend/data/`, `data/`, `*.secret`, `*.db`, and `*.sqlite*`.

Use the verified [backup and restore workflow](./BACKUP_RESTORE.md) before upgrades or deployment
changes. A backup must keep `trading.db` and `.secret` together and must be treated as secret data.

### Database schema

`initStore()` creates the following tables:

| Table      | Holds                                                                 |
| ---------- | --------------------------------------------------------------------- |
| `bots`     | Bot configurations (JSON), keyed by `id`.                             |
| `fills`    | Trade journal / fill records per bot.                                 |
| `logs`     | Per-bot log lines (`info` / `warn` / `error`).                        |
| `orders`   | Durable order-intent/result journal keyed by `clientOrderId` / exchange order id. |
| `order_events` | Per-order lifecycle events, including intent, result, fill, and reconciliation records. |
| `audit_log` | Mutating trade API calls with role, status, target, and redacted request data. |
| `settings` | Key/value store with an `encrypted` flag — exchange keys and notification config live here. |
| `schema_migrations` | Applied forward migration versions, names and timestamps. |

The trading database uses SQLite `PRAGMA user_version`. Startup upgrades an older/unversioned schema
inside one transaction and preserves existing records. If the database was created by a newer
application schema, startup fails closed instead of attempting to run against unknown columns or
semantics. Create and verify a backup before upgrading.

## Configuring exchange API keys

Exchange API keys are **never** placed in environment variables or plaintext files. They are submitted through the app and stored encrypted in the `settings` table.

Submit keys with:

```
POST /api/trade/keys
Content-Type: application/json

{ "exchange": "binance", "apiKey": "<your-key>", "apiSecret": "<your-secret>" }
```

`exchange` must be `binance` or `bybit`. The handler in `backend/src/trading/routes.ts` stores them encrypted under the setting key `keys:<exchange>`:

```ts
setSetting(`keys:${body.exchange}`, { apiKey: body.apiKey ?? "", apiSecret: body.apiSecret ?? "" }, true);
```

The third argument (`true`) means the value is encrypted at rest. Keys are **never returned in plaintext.** The status endpoint reports only whether keys are present:

```
GET /api/trade/keys
→ { "binance": true, "bybit": false }
```

Presence is computed by `hasKeys()`, which returns `true` only when both `apiKey` and `apiSecret` are set.

## Configuring Telegram / VK notifications

Notifications are configured the same way — through the app, stored encrypted under the `notify` setting key. From `backend/src/trading/notifications.ts`, the defaults are all disabled:

```ts
export const DEFAULT_NOTIFY: NotifyConfig = {
  telegram: { enabled: false, token: "", chatId: "" },
  vk: { enabled: false, token: "", peerId: "" }
};
```

Update the configuration with:

```
POST /api/trade/notify
Content-Type: application/json

{
  "telegram": { "enabled": true, "token": "<bot-token>", "chatId": "<chat-id>" },
  "vk":       { "enabled": false, "token": "", "peerId": "" }
}
```

This is persisted encrypted (`setSetting("notify", next, true)`). As with exchange keys, tokens are never returned in plaintext — `GET /api/trade/notify` reports only the enabled flag, the chat/peer id, and a `hasToken` boolean:

```
GET /api/trade/notify
→ {
    "telegram": { "enabled": true, "chatId": "<chat-id>", "hasToken": true },
    "vk":       { "enabled": false, "peerId": "", "hasToken": false }
  }
```

A channel only fires when it is enabled **and** both its token and its target id (Telegram `chatId` / VK `peerId`) are non-empty. To verify a channel end-to-end, send a test message:

```
POST /api/trade/notify/test
→ { "ok": true, "message": "Sent" }
```

Telegram messages are sent via the Bot API (`api.telegram.org/bot<token>/sendMessage`, HTML parse mode); VK via `api.vk.com/method/messages.send` (API version `5.199`, HTML stripped). Delivery failures are settled independently and do not crash the caller.

## At-rest encryption (AES-256-GCM)

Sensitive settings are encrypted with **AES-256-GCM** using a key derived by **scrypt**. The scheme lives entirely in `backend/src/trading/store.ts`.

**Key derivation.** On first run a random 32-byte value is generated, hex-encoded, and written to `backend/data/.secret` with mode `0600`. The actual 32-byte AES key is derived from that seed via `scryptSync` (with a fixed salt) and never leaves memory:

```ts
function loadOrCreateSecret(): Buffer {
  if (existsSync(secretPath)) {
    return scryptSync(readFileSync(secretPath, "utf8"), "marketforge", 32);
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return scryptSync(secret, "marketforge", 32);
}
```

**Encryption.** Each value gets a fresh random 12-byte IV. The stored payload is `iv.tag.ciphertext`, each part base64-encoded and dot-joined, with the GCM authentication tag verified on decrypt:

```ts
function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}
```

**Consequences to understand:**

- The `.secret` file is the root of trust. Anyone who can read it (and the `trading.db`) can decrypt your stored API keys and tokens — keep both out of backups you would not trust with plaintext credentials, and never commit them.
- **Losing `.secret` makes existing encrypted values undecryptable.** If you delete or replace it, previously stored exchange keys and notification tokens can no longer be read and must be re-entered.
- The encryption key is derived per-installation; `.secret` is not portable to another machine unless you copy it alongside the database.

## Production deployment

In production the frontend is compiled to static assets and served by the backend itself — there is no separate web server for the SPA. The relevant serving code in `backend/src/server.ts`:

```ts
const frontendDist = path.resolve(__dirname, "../../frontend/dist");
app.use(express.static(frontendDist));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(frontendDist, "index.html"));
});
```

`express.static` serves the built assets, and the catch-all route returns `index.html` for client-side routing. This means a single process on a single port (default `4180`) serves both the API/WebSockets and the UI.

### Build and start

From the repository root, the workspace scripts (`package.json`) handle both packages:

```bash
# 1. Install dependencies (root + backend + frontend workspaces)
npm install

# 2. Build both workspaces:
#    backend → tsc → backend/dist
#    frontend → tsc -b && vite build → frontend/dist
npm run build

# 3. Start the backend, which also serves frontend/dist
npm start
```

| Script            | Runs                                                          |
| ----------------- | ------------------------------------------------------------ |
| `npm run build`   | `npm --workspaces run build` (backend `tsc`, frontend `vite build`). |
| `npm start`       | `npm --workspace backend run start` → `node dist/server.js`. |

The server binds to `HOST:PORT` and, on `SIGINT` / `SIGTERM`, stops Telegram control, shuts down active runtime subscriptions while preserving resumable desired bot state, and closes gracefully:

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    trading.telegramControl.stop();
    trading.engine.shutdown();
    server.close(() => process.exit(0));
  });
}
```

### Installable PWA and cache policy

The production build emits `manifest.webmanifest` and a generated `service-worker.js`. Supporting
browsers can install the self-hosted terminal when it is served from HTTPS; localhost is also a
secure development context. Registration is disabled in the Vite development server.

The service worker is deliberately a static, read-only application shell:

- navigations use network-first with the last verified shell as the offline fallback;
- initial entry JavaScript/CSS and reviewed root public assets are precached under a content-derived cache name;
- users may explicitly install or remove a separate same-build Strategy Studio/Blockly research cache; it contains static code/media only and never Trading View;
- `/api/*`, `/stream`, `/quotes`, `/orderbook`, `/trade-flow` and `/trade-stream` always use the network;
- POST requests, cross-origin responses and opaque responses are never cached;
- there is no background sync, request queue or automatic trading replay.

The Express server sends `no-cache` for `index.html`, the manifest and service worker, one-year
`immutable` caching for content-hashed `/assets/*` files, and revalidation for stable public names.
A reverse proxy must preserve these response headers and must not add an offline cache in front of
API or WebSocket routes. Offline installation proves only that the interface can open; it does not
claim current prices, authenticated access or available order execution.

The manifest exposes Chart and Strategy Studio shortcuts. `/?view=strategy` opens the local research
surface, while unknown values and `view=trade` fail closed to Chart. See
[Offline local research](OFFLINE_RESEARCH.md) for the exact boundary and verification evidence.

Installed Chromium-family desktop PWAs may also register three exact file handlers for `.pine`,
`.strategy` and `.saltanat-plugin`. Every handler routes to the Strategy Studio review flow; generic
JSON and trading actions are intentionally absent. This is feature-detected progressive enhancement,
so no server flag is needed and manual file inputs remain available. See
[PWA file handling](PWA_FILE_HANDLING.md).

The HTML also contains a localized pre-React recovery surface, so a missing or stale main module
does not produce a blank screen. **Refresh application files** unregisters only this application's
worker and deletes only `saltanat-shell-*` Cache Storage entries; it does not clear chart, strategy,
identity or trading data. See [Application startup recovery](STARTUP_RECOVERY.md).

### Example: run behind a process manager

Because `npm start` is a plain long-lived Node process, any supervisor works. For example, with a bound loopback host so a reverse proxy fronts it:

```bash
HOST=127.0.0.1 PORT=4180 npm start
```

Point your process manager (systemd, pm2, Docker, etc.) at this command, ensure `backend/data/` is on persistent storage, and restart on failure.

## Security hardening

The backend now defaults to the safe posture: it binds to `127.0.0.1`, the trading API requires an access token, CORS is an allowlist (foreign origins get no `Access-Control-Allow-Origin`), and the bundled SPA is served with CSP / browser hardening headers. Live trading is disarmed by default. Still, before putting this server on the public internet, work through the checklist below.

- [ ] **Terminate TLS at a reverse proxy.** Keep the app bound to loopback (`HOST=127.0.0.1`, the default) and place nginx / Caddy / Traefik in front to handle HTTPS and to proxy both HTTP (`/api/*`) and the WebSocket upgrades (`/stream`, `/trade-stream`). The app itself serves plain HTTP and intentionally does not send `upgrade-insecure-requests`, so direct `http://IP:4180` access remains usable for testing.
- [ ] **Restrict network exposure with a firewall.** Only expose the proxy's `443` (and optionally `80` for redirect). Do not expose the backend's `4180` directly; block it at the host firewall / security group.
- [ ] **Keep the access token secret.** The browser only uses it to create an HttpOnly session, but it is still the admin credential. Set a long random `AUTH_TOKEN` in production (don't rely on the auto-generated `backend/data/.authtoken` if you ship the data dir around), and never paste it into cross-origin sites. A defense-in-depth auth layer at the proxy is still welcome.
- [ ] **Use scoped tokens where possible.** Give observers `AUTH_READONLY_TOKEN`, paper operators `AUTH_PAPER_TRADE_TOKEN`, and reserve `AUTH_TOKEN` for admin operations such as keys, live arming, deletion, and notification config.
- [ ] **Set `COOKIE_SECURE=1` behind HTTPS.** Local plain HTTP cannot use Secure cookies, so this is operator-controlled. For a public TLS deployment, enable it.
- [ ] **Set `ALLOWED_ORIGINS` if the API is reached cross-origin.** Same-origin (the bundled SPA) needs nothing. Leave it unset for the default same-origin deployment.
- [ ] **Never commit `backend/data/`.** It contains `.secret` (the encryption key seed) and `trading.db` (encrypted API keys and tokens). It is gitignored — keep it that way, and treat backups of it as secret material.
- [ ] **Protect `.secret` file permissions.** It is written `0600`; ensure the deployment user owns it and no other account can read it.
- [ ] **Use exchange API keys with least privilege.** Prefer trade-only keys without withdrawal permission, and IP-allowlist them at the exchange where possible.
- [ ] **Keep secrets off disk in plaintext.** Do not stash API keys or notification tokens in `.env` files, shell history, or config files — enter them through the app so they are encrypted at rest.

## See also

- [Project README](../README.md)
- [Architecture](./ARCHITECTURE.md)
- [HTTP & WebSocket API](./API.md)
- [Trading engine](./TRADING.md)
- [Strategies](./STRATEGIES.md)
