# Configuration & deployment

SaltanatbotV2 is configured almost entirely at runtime, through the app itself, rather than through configuration files. The backend reads only two environment variables (a listen port and host); everything sensitive — exchange API keys, Telegram/VK notification credentials — is entered in the UI, encrypted with AES-256-GCM, and persisted in a local SQLite database. This guide covers the environment variables, where runtime state lives, how to configure secrets through the app, the at-rest encryption scheme, a production deployment recipe, and a hardening checklist for exposing the server publicly.

## Environment variables

The backend reads exactly two environment variables in `backend/src/server.ts`:

| Variable | Default     | Purpose                                             |
| -------- | ----------- | --------------------------------------------------- |
| `PORT`   | `4180`      | TCP port the HTTP + WebSocket server listens on.    |
| `HOST`   | `0.0.0.0`   | Interface the server binds to (all interfaces).     |

The relevant code:

```ts
const port = Number(process.env.PORT ?? 4180);
const host = process.env.HOST ?? "0.0.0.0";
```

On startup the server logs its bind address:

```
SaltanatbotV2 backend listening on http://0.0.0.0:4180
```

To run on a different port:

```bash
PORT=8080 npm start
```

To bind only to loopback (recommended when a reverse proxy sits in front — see [Security hardening](#security-hardening)):

```bash
HOST=127.0.0.1 npm start
```

> **`.env.example` is optional; config is primarily runtime.** There is no required `.env` file. The two variables above are the only ones the backend consults, and both have sensible defaults. All secrets are configured in the UI and stored encrypted (see below), never in environment variables or plaintext files. The repository's `.gitignore` already ignores `.env` and `.env.*` (while allowing a committed `.env.example`), so you may add one for convenience, but it is not needed to run the app.

### Development ports

In development the Vite dev server (frontend) runs separately and proxies API and WebSocket traffic to the backend. From `frontend/vite.config.ts`:

| Service          | Port   | Notes                                              |
| ---------------- | ------ | -------------------------------------------------- |
| Backend (Express)| `4180` | HTTP `/api/*`, WebSockets `/stream`, `/trade-stream`. |
| Frontend (Vite)  | `4181` | `strictPort: false`, proxies `/api` and `/stream` to `127.0.0.1:4180`. |

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

### Database schema

`initStore()` creates the following tables:

| Table      | Holds                                                                 |
| ---------- | --------------------------------------------------------------------- |
| `bots`     | Bot configurations (JSON), keyed by `id`.                             |
| `fills`    | Trade journal / fill records per bot.                                 |
| `logs`     | Per-bot log lines (`info` / `warn` / `error`).                        |
| `settings` | Key/value store with an `encrypted` flag — exchange keys and notification config live here. |

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

The server binds to `HOST:PORT` and, on `SIGINT` / `SIGTERM`, stops all running bots and closes gracefully:

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    trading.engine.stopAll();
    server.close(() => process.exit(0));
  });
}
```

### Example: run behind a process manager

Because `npm start` is a plain long-lived Node process, any supervisor works. For example, with a bound loopback host so a reverse proxy fronts it:

```bash
HOST=127.0.0.1 PORT=4180 npm start
```

Point your process manager (systemd, pm2, Docker, etc.) at this command, ensure `backend/data/` is on persistent storage, and restart on failure.

## Security hardening

The backend defaults to `HOST=0.0.0.0` and enables permissive CORS (`app.use(cors())`), which is convenient for local development but **not** appropriate for direct public exposure. Before putting this server on the public internet, work through the checklist below.

- [ ] **Terminate TLS at a reverse proxy.** Run the app bound to loopback (`HOST=127.0.0.1`) and place nginx / Caddy / Traefik in front to handle HTTPS and to proxy both HTTP (`/api/*`) and the WebSocket upgrades (`/stream`, `/trade-stream`). The app itself serves plain HTTP.
- [ ] **Restrict network exposure with a firewall.** Only expose the proxy's `443` (and optionally `80` for redirect). Do not expose the backend's `4180` directly; block it at the host firewall / security group.
- [ ] **Add your own authentication at the proxy.** The API has no built-in auth — anyone who can reach it can create bots, submit exchange keys, and start trading. Put access control (mTLS, basic auth, an SSO gateway, or an allowlist) in front of it.
- [ ] **Tighten CORS for real origins.** The default `cors()` allows any origin. If the API is reachable cross-origin, restrict it to your known frontend origin(s).
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
