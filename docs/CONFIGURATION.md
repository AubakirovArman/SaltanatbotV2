# Configuration & deployment

SaltanatbotV2 is configured mostly at runtime through the app itself. PostgreSQL stores accounts,
revocable sessions, workspaces and research jobs. SQLite stores owner-scoped trading accounts,
robots and journals plus AES-256-GCM-encrypted per-account exchange credentials and owner-scoped
notification configuration. This split preserves existing trading state while keeping every
authenticated user's private trading surface separate.

## Environment variables

The backend reads these environment variables in `backend/src/server.ts` / `backend/src/auth.ts`:

| Variable          | Default       | Purpose                                                                                 |
| ----------------- | ------------- | --------------------------------------------------------------------------------------- |
| `PORT`            | `4180`        | TCP port the HTTP + WebSocket server listens on.                                        |
| `HOST`            | `127.0.0.1`   | Interface the server binds to. Loopback by default (fail-safe). Set `0.0.0.0` to expose. |
| `AUTH_MODE` | `database` | `database` enables account login. `legacy` is an explicit compatibility mode for hermetic tests/private demos only. |
| `AUTH_REGISTRATION_ENABLED` | `1` | Set `0` to hide/disable new registration. Registrations are pending until admin approval. |
| `AUTH_SESSION_TTL_MS` | `43200000` | HttpOnly browser session TTL (default 12 hours). |
| `AUTH_WS_TICKET_TTL_MS` | `30000` | One-time `/trade-stream` ticket TTL. |
| `AUTH_TRADING_ROLES_ENABLED` | `1` | Allows non-admin trading-role grants. Set `0` only as a maintenance switch; owner isolation remains enforced. |
| `AUTH_LOGIN_RATE_WINDOW_MS` / `AUTH_LOGIN_RATE_BLOCK_MS` | `900000` / `900000` | Window and block duration for independent failed-login buckets. |
| `AUTH_LOGIN_IP_MAX_FAILURES` | `30` | Concurrent login allowances per client IP in the login window. Allowances are reserved before password hashing; credential failures remain counted. A successful login refunds only its own reservation and does not erase earlier failures from that IP. |
| `AUTH_LOGIN_IDENTITY_MAX_FAILURES` | `10` | Concurrent login allowances per normalized login across all client IPs. Allowances are reserved before password hashing; credential failures remain counted. A valid login clears this identity bucket. Capacity and internal failures refund their reservation. |
| `AUTH_REGISTER_RATE_WINDOW_MS` / `AUTH_REGISTER_RATE_BLOCK_MS` | `3600000` / `3600000` | Window and block duration for registration attempts. |
| `AUTH_REGISTER_IP_MAX_ATTEMPTS` | `5` | Registration attempts per client IP and window. Valid, invalid, successful and failed attempts all count. |
| `AUTH_RATE_LIMIT_MAX_ENTRIES` | `4096` | Hard cap for the process-local store shared by login and registration limiters. New keys fail closed while a full store has no expired entry. |
| `AUTH_PASSWORD_HASH_CONCURRENCY` | `2` | Maximum concurrent Argon2id operations. Each default operation uses about 64 MiB plus library overhead. |
| `AUTH_PASSWORD_HASH_QUEUE` | `32` | Maximum requests waiting for Argon2id; overflow receives a generic retryable `503` instead of an unbounded queue. |
| `API_RATE_REFILL_PER_SECOND` / `API_RATE_BURST` | `20` / `240` | General shared API token-bucket refill and burst. Mutations cost four tokens. |
| `API_RATE_MAX_BUCKETS` | `4096` | Hard cap for general per-account/per-IP API buckets. |
| `TRADING_LEGACY_OWNER_USER_ID` | *(automatic)* | Admin UUID that receives pre-v6 SQLite trading rows. Required before the first v6 start when PostgreSQL contains multiple admins. |
| `TRADING_MAX_ACCOUNTS_PER_USER` | `8` | Hard per-owner cap for saved exchange accounts; excess existing rows are preserved. |
| `TRADING_MAX_BOTS_PER_USER` | `24` | Hard per-owner cap for saved robot configurations; excess existing rows are preserved. |
| `TRADING_MAX_RUNNING_PAPER_BOTS_PER_USER` | `4` | Concurrent paper-robot cap per owner in the single trading executor. |
| `TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER` | `2` | Concurrent live-robot cap per owner in the single trading executor. |
| `COOKIE_SECURE`   | *(off)*       | Set to `1` behind HTTPS so session cookies are marked `Secure`. |
| `DATABASE_URL` | *(unset)* | PostgreSQL URL. Takes precedence over individual `PG*` parameters and cannot be combined with `PGPASSWORD_FILE`. |
| `PGHOST` / `PGPORT` | `127.0.0.1` / `55434` | Isolated project PostgreSQL address. Compose uses `postgres:5432` internally. |
| `PGDATABASE` / `PGUSER` | `saltanatbotv2` | Dedicated database and role. |
| `PGPASSWORD_FILE` | *(unset)* | Preferred absolute regular file containing the database password. |
| `PGPOOL_MAX` | `12` | Maximum API PostgreSQL connections. |
| `DEMO_MODE`       | *(off)*       | `1`/`true` disables exchange keys and live trading — paper only. For public demos.       |
| `ENABLE_LIVE_SPOT` | *(off)* | `1`/`true` permits experimental Bybit spot after the normal live gates. It does not enable Binance spot, which remains disabled until authenticated spot execution accounting exists. |
| `ALLOWED_ORIGINS` | dev localhost | Comma-separated HTTP CORS and WebSocket `Origin` allowlist for cross-origin browser access. Same-origin always works. |
| `TRUST_PROXY` | *(unset)* | Explicit Express trusted-proxy IP/CIDR/name list (for example `loopback`). Only trusted proxies may establish HTTPS through `X-Forwarded-Proto`. |
| `ALLOW_INSECURE_TRADING_MUTATIONS` | *(off)* | Dangerous development override for key storage and live/account mutations over public HTTP. Never enable on a public or production host. |
| `PAPER_MULTI_LEG_DB_PATH` | `backend/data/arbitrage-paper-multi-leg.sqlite` | Optional path for the bounded append-only multi-leg paper journal. Compose operators should leave the default inside `/app/backend/data`; any custom container path needs its own persistent mount and backup policy or it is lost when the container is recreated. |
| `ARBITRAGE_CONTINUOUS_ROUTES_FILE` | *(unset)* | Preferred absolute path to one bounded, regular, non-symlinked UTF-8 public-feed allowlist. Mutually exclusive with the inline JSON variable. |
| `ARBITRAGE_CONTINUOUS_ROUTES_JSON` | *(unset)* | Optional bounded public-feed allowlist for continuous multi-venue research discovery; exact reviewed identity and fee metadata only, never credentials. |

To run on a different application port after configuring PostgreSQL:

```bash
PORT=8080 HOST=127.0.0.1 AUTH_MODE=database npm start
```

Create the first administrator once. The generated password is shown once and the first login forces
a password change:

```
npm --workspace backend run admin:bootstrap -- --login your-admin-login
```

If you bind to a non-loopback address, the server prints a warning to put it behind a reverse proxy with TLS (see [Security hardening](#security-hardening)).

> **Database mode protects the application API and market WebSockets.** `POST /api/auth/login`
> creates an HttpOnly `sbv2_session` plus a readable SameSite CSRF cookie; unsafe requests must copy
> that CSRF value into `X-CSRF-Token`. `/trade-stream` additionally uses a short-lived, session-bound,
> one-time ticket. Trading resources and the private stream are owner-scoped. Exchange keys and
> notification tokens remain encrypted in SQLite, are never placed in PostgreSQL and are never
> returned to the browser.

The authentication limits are intentionally process-local because the supported deployment runs
one API/trading process. Login allowances are synchronously reserved in both the IP and normalized-
identity buckets before the first asynchronous password operation, so parallel bursts cannot pass
on stale failure counts. Capacity and internal failures roll back only their own reservation; a
successful login clears its identity bucket but preserves earlier attack history for its source IP.
All authentication buckets share one bounded store inside that process, and password hashing has a
separate global concurrency/queue gate. Do not add a second API replica and assume these limits are
global; a future horizontally scaled API needs a shared external limiter in addition to the trading-
executor lease/fencing work. Behind a reverse proxy, configure `TRUST_PROXY` narrowly so `request.ip`
is the real client address rather than the proxy address.

> **`.env` and `.secrets/` are git-ignored.** Database passwords, dumps and runtime data must never
> be committed. See [Self-hosting](./SELF_HOSTING.md) for Docker and direct-host recipes.

### Continuous multi-venue research allowlist

Set exactly one of `ARBITRAGE_CONTINUOUS_ROUTES_FILE` or
`ARBITRAGE_CONTINUOUS_ROUTES_JSON` to activate selected public WebSocket books for the read-only
route-family workspace. With neither value, the runtime is `disabled` and opens no subscriptions.
The preferred file form keeps a reviewed allowlist in version control without a large shell-escaped
environment value. It requires an absolute path to a regular, non-symlinked, valid UTF-8 file. Both
forms accept the same strict JSON array of at most 24 rows and 64 KiB. Every `instrumentId` must be
present in the current verified instrument registry; the browser can observe the resulting
configuration but cannot change it.

The Compose service mounts this repository's `config/` directory read-only at `/app/config`, so its
file value should normally be `/app/config/continuous-routes.research.json`. A direct-host service
may use any suitable absolute path readable by the service account.

```bash
ARBITRAGE_CONTINUOUS_ROUTES_FILE=/opt/saltanatbotv2/config/continuous-routes.research.json
```

```json
[
  {
    "instrumentId": "okx:spot:BTC-USDT",
    "economicAssetId": "crypto:bitcoin",
    "takerFeeBps": 10,
    "economicIdentity": {
      "status": "reviewed",
      "source": "docs/VENUE_CAPABILITIES.md official venue references and normalized instrument fixtures",
      "version": "2026-07-14.v1",
      "asOf": 1783987200000,
      "validUntil": 1791763200000
    }
  }
]
```

Identity fields must exactly match the server's central reviewed catalog, already be valid, expire
within 90 days of `asOf`, and be renewed in code through explicit review. Environment values cannot
create or override an economic-asset equivalence. Unknown fields, duplicate instruments, stale or
mismatched reviews and unsupported venue/market combinations fail closed. `takerFeeBps` is
operator-reviewed research metadata, not an account fee tier. Do not put API
keys, wallet material, account balances or order data in either source. The resulting candidates are
always `research-only`, `executable: false`; the setting cannot arm trading.

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

Live trading (Binance/Bybit) is **disarmed by default**. Binance live spot cannot be armed until an
authenticated spot execution-accounting path exists. Bybit spot is experimental, additionally
requires `ENABLE_LIVE_SPOT`, and uses the v5 `order` + `execution` topics. Even with valid API keys, an
eligible live bot will not start until you:

1. Open the app through HTTPS or a direct localhost connection.
2. Configure positive per-bot caps for maximum position, maximum order, daily loss and open orders (plus maximum leverage).
3. Enable **Arm live trading** in the Trade → Settings panel (persisted server-side), and
4. Confirm the live-start prompt on the bot (`confirmLive`).

The same secure-origin gate protects exchange-key storage, live bot creation/start/resume/manual commands and Bybit UTA borrow/repay/collateral mutations. Paper bot creation and operation remain available over HTTP. Existing live bots without all required caps fail closed at start and automatic resume.

Every risk-increasing live order must reach preflight with an explicit positive base `qty`; quote,
deposit and balance-percentage sizing cannot create live exposure. The durable journal continues to
reserve capacity for accepted, partially filled and venue-filled-but-not-accounted orders. Spot sells
separately reserve attributed inventory. Cancelled/expired rows retain any unaccounted partial fill;
legacy replaced rows remain conservative until their execution is accounted. Live `replace` and
`turnover` are disabled on every market until their child actions have independent durable lifecycles.

Futures preflight compares exact-symbol venue gross positions with the durable fill-accounted shadow
quantity and uses the larger value. A matched venue/local order uses maximum quantity/price, while an
identity conflict fails closed. A second live bot on the same exchange+symbol is rejected even across
spot/futures and cannot be forced through with `override`. If REST polling or reconnect reconciliation
observes a terminal order without authenticated execution accounting, the bot is paused.

Live starts are serialized by exchange+symbol, so concurrent start requests cannot race the collision
or reconciliation gates. If protection fails after an entry was accepted, that entry stays accepted,
managed and reserved; the bot pauses while a distinct reduce-only `…-safety` close reports its own
venue order ID or an explicit failure. A live close acknowledgement also leaves managed state intact
and pauses the bot until its authenticated execution is committed to accounting.

The **kill switch** (Trade → Settings) stops every running bot and disarms live trading instantly. `DEMO_MODE=1` forces paper-only regardless of these settings.

Live execution remains experimental. The funded 7–14-day Binance/Bybit exchange soak is explicitly
excluded from the current verified scope, so none of these configuration gates constitute a
mainnet-readiness claim.

### Development ports

In development the Vite dev server (frontend) runs separately and proxies API and WebSocket traffic to the backend. From `frontend/vite.config.ts`:

| Service          | Port   | Notes                                              |
| ---------------- | ------ | -------------------------------------------------- |
| Backend (Express)| `4181` | Root `npm run dev` sets `PORT=4181`; serves HTTP `/api/*` and WebSockets. |
| Frontend (Vite)  | `4180` | Proxies `/api` and all six WebSockets (`/stream`, `/quotes`, `/orderbook`, `/trade-flow`, `/arbitrage-stream`, `/trade-stream`) to `127.0.0.1:4181`. |

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
| `backend/data/arbitrage-paper-multi-leg.sqlite` | Bounded append-only deterministic multi-leg paper runs and restart-recovery journal. |

Both are **created automatically at runtime** the first time the store initializes. `initStore()`
creates the data directory when needed, enforces mode `0700` on it and `0600` on `trading.db` and
`.secret`, generates the secret if absent, and runs the schema migrations. You do not create these
by hand.

Both are **gitignored and must never be committed.** The repository's `.gitignore` explicitly excludes `backend/data/`, `data/`, `*.secret`, `*.db`, and `*.sqlite*`.

Use the verified [backup and restore workflow](./BACKUP_RESTORE.md) before upgrades or deployment
changes. It includes the default multi-leg paper journal when present. A backup must keep
`trading.db` and `.secret` together and must be treated as secret data; a journal moved with
`PAPER_MULTI_LEG_DB_PATH` needs a separate operator backup policy.

### Database schema

`initStore()` creates the following tables:

| Table      | Holds                                                                 |
| ---------- | --------------------------------------------------------------------- |
| `bots`     | Bot configurations (JSON) with a mandatory server-owned `ownerUserId`. |
| `trading_accounts` | Owner-scoped Binance/Bybit account metadata; secrets are not stored in this table. |
| `trading_account_credentials` | One authenticated ciphertext per `(ownerUserId, accountId)`. |
| `fills`    | Trade journal / fill records per bot.                                 |
| `logs`     | Per-bot log lines (`info` / `warn` / `error`).                        |
| `orders`   | Durable order-intent/result journal keyed by `clientOrderId` / exchange order id. |
| `order_events` | Per-order lifecycle events, including intent, result, fill, and reconciliation records. |
| `audit_log` | Owner-scoped mutating trade API calls with actor, role, status, target and redacted request data. |
| `settings` | Internal state and encrypted owner-scoped notification configuration; new exchange credentials do not live here. |
| `schema_migrations` | Applied forward migration versions, names and timestamps. |

The trading database uses SQLite `PRAGMA user_version`. Startup upgrades an older/unversioned schema
inside one transaction and preserves existing records. If the database was created by a newer
application schema, startup fails closed instead of attempting to run against unknown columns or
semantics. Schema v6 assigns legacy bots/accounts/audit rows to exactly one administrator,
re-encrypts old exchange keys into `trading_account_credentials`, deletes the old key rows only
after successful re-encryption, and clears the former server-wide live arm. Create and verify a
backup before upgrading. If multiple administrators exist, set `TRADING_LEGACY_OWNER_USER_ID`
before that first v6 start or migration fails closed. Schema v7 then changes fill, order and order
event identity to `(botId, id)`, preserving every existing row while allowing independent tenants
to receive the same venue/client identifier without journal collisions.

## Configuring exchange API keys

Exchange API keys are **never** placed in environment variables or plaintext files. A user first
creates a Binance or Bybit account in Trade → Accounts, then submits credentials for that exact
account. The server takes ownership only from the authenticated session; no request field can select
another user.

Create account metadata (requires `live-trade`, CSRF and a secure trading origin):

```
POST /api/trade/accounts
Content-Type: application/json

{ "label": "My Binance", "exchange": "binance", "ownership": "own", "enabled": true }
```

Store or rotate that account's credentials:

```
PUT /api/trade/accounts/<account-id>/credentials
Content-Type: application/json

{ "apiKey": "<your-key>", "apiSecret": "<your-secret>" }
```

Both values are required and bounded. Keys are encrypted in `trading_account_credentials` with
AES-GCM authenticated context containing the owner, account and exchange. Plaintext is never
returned. `GET /api/trade/accounts` reports only `credential.status` as `configured` or `missing`:

```
GET /api/trade/accounts
→ { "accounts": [{ "id": "…", "exchange": "binance", "credential": { "status": "configured" } }] }
```

Rotation is blocked while a bound robot is running. Credential removal is blocked until every bot
is unbound/deleted. `DELETE /api/trade/accounts/:id/credentials` removes only the current user's
credentials. The old `GET /api/trade/keys` endpoint is a tenant-scoped boolean compatibility view;
`POST /api/trade/keys` returns `410 ACCOUNT_CREDENTIAL_ENDPOINT_REQUIRED`.

## Configuring Telegram / VK notifications

Telegram notifications can be configured in the web application. VK notification configuration is
currently API-only. Each configuration is stored encrypted under its owner's namespaced setting and
is disabled by default. From `backend/src/trading/notifications.ts`:

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

This is persisted under `owner:<authenticated-user-id>:notify`. As with exchange keys, tokens are
never returned in plaintext — `GET /api/trade/notify` reports only the enabled flag, target id and a
`hasToken` boolean for the current user:

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

In database/multi-user auth mode these channels are outbound-only. The existing Telegram command
poller is a single-operator control plane and is therefore enabled only in explicit legacy auth
mode; it must not bypass a user's durable trading role. A future tenant-aware poller must bind each
chat to an application user and re-check that user's current role for every command.

## At-rest encryption (AES-256-GCM)

Sensitive settings are encrypted with **AES-256-GCM** using a key derived by **scrypt**. The
envelope implementation lives in `backend/src/trading/credentialCrypto.ts`; the store supplies the
installation key and per-record context.

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

**Encryption.** Each value gets a fresh random 12-byte IV. The stored payload is
`iv.tag.ciphertext`, each part base64-encoded and dot-joined, with the GCM authentication tag
verified on decrypt. Account credentials also authenticate an unambiguous JSON tuple containing
the schema label, owner UUID, account UUID and exchange:

```ts
credentialAad(ownerUserId, accountId, exchange)
// JSON.stringify(["trading-credentials", 1, ownerUserId, accountId, exchange])
```

Copying a valid ciphertext to another owner, account or exchange therefore fails authentication
instead of decrypting under the wrong tenant.

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
#    frontend → type-check → staged Vite build → PWA/budget checks → atomic frontend/dist publication
npm run build

# 3. Start the backend, which also serves frontend/dist
npm start
```

| Script            | Runs                                                          |
| ----------------- | ------------------------------------------------------------ |
| `npm run build`   | Workspace builds; frontend Vite output is verified in staging before atomic live publication. |
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

The build does not empty the `frontend/dist` directory served by a running backend. It copies a
verified candidate with per-file temporary renames, atomically swaps `index.html`, and publishes the
new `service-worker.js` last. The active and immediately previous generation are the only retained
sets; PWA/performance checks and release packaging read only the active generation manifest.

The service worker is deliberately a static, read-only application shell:

- navigations use network-first with the last verified shell as the offline fallback;
- initial entry JavaScript/CSS and reviewed root public assets are precached under a content-derived cache name;
- users may explicitly install or remove a separate same-build Strategy Studio/Blockly research cache; it contains static code/media only and never Trading View;
- `/api/*`, `/stream`, `/quotes`, `/orderbook`, `/trade-flow` and `/trade-stream` always use the network;
- all POST requests except the exact file-only `/share-target` hand-off remain network-only;
- `/share-target` is parsed locally by the worker into bounded expiring IndexedDB state and returns a
  303 shell redirect; it is never cached, forwarded, background-synced or replayed;
- cross-origin and opaque responses are never cached;
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
[PWA file opening and sharing](PWA_FILE_HANDLING.md).

The same manifest exposes one file-only Web Share Target at `/share-target`. It accepts no title,
text or URL, uses ten-file and 1/2/5 MB per-format limits, caps accepted bytes at 10 MB and retains at
most five opaque batches for 24 hours. The root shell reads only metadata until consent; Cancel or
successful hand-off deletes the record. This is a browser-local PWA action, not an Express API route.

The HTML also contains a localized pre-React recovery surface, so a missing or stale main module
does not produce a blank screen. **Refresh application files** unregisters only this application's
worker and deletes only `saltanat-shell-*` Cache Storage entries; it does not clear chart, strategy,
identity or trading data. See [Application startup recovery](STARTUP_RECOVERY.md).

### Example: run behind a process manager

Because `npm start` is a plain long-lived Node process, any supervisor works. For example, with a bound loopback host and an HTTPS reverse proxy on the same machine:

```bash
HOST=127.0.0.1 PORT=4180 TRUST_PROXY=loopback COOKIE_SECURE=1 npm start
```

The proxy must replace `X-Forwarded-Proto` with `$scheme`. Leaving `TRUST_PROXY` unset makes Express ignore that header, while `TRUST_PROXY=true` trusts every immediate peer and is therefore discouraged. Prefer an exact proxy address/CIDR or the `loopback` preset.

Point your process manager (systemd, pm2, Docker, etc.) at this command, ensure `backend/data/` is on persistent storage, and restart on failure.

## Security hardening

The backend defaults to a safe posture: it binds to `127.0.0.1`, database-mode APIs and WebSockets
require an active account, CORS is an allowlist, and the bundled SPA uses CSP/browser hardening
headers. Live trading is disarmed by default. Before exposing the server, complete this checklist.

- [ ] **Terminate TLS at a reverse proxy.** Keep the app bound to loopback (`HOST=127.0.0.1`, the default), set `TRUST_PROXY` to that proxy only, and place nginx / Caddy / Traefik in front to handle HTTPS and all HTTP/WebSocket routes. Never enter an account password over public HTTP; key storage and risk-increasing live mutations also return `426 SECURE_TRADING_ORIGIN_REQUIRED` without a trustworthy origin.
- [ ] **Restrict network exposure with a firewall.** Only expose the proxy's `443` (and optionally `80` for redirect). Do not expose the backend's `4180` directly; block it at the host firewall / security group.
- [ ] **Protect account and database credentials.** Change the one-time administrator password,
  keep the PostgreSQL password file owner-only, review pending registrations, and disable departed
  users. Never expose a dump, cookie or CSRF value in logs/screenshots.
- [ ] **Verify tenant ownership after the first schema-v6 upgrade.** Back up PostgreSQL plus
  `trading.db`/`.secret`, set `TRADING_LEGACY_OWNER_USER_ID` when multiple admins exist, and confirm
  that migrated robots appear only for the selected administrator. Live trading is disarmed by the
  migration and must be rearmed manually.
- [ ] **Grant the minimum trading role.** New users start with no trading access. Use `read-only` or
  `paper-trade` unless live exchange access is actually required; disabling/changing a user revokes
  sessions and stops that user's runtimes.
- [ ] **Set `COOKIE_SECURE=1` behind HTTPS.** Local plain HTTP cannot use Secure cookies, so this is operator-controlled. For a public TLS deployment, enable it.
- [ ] **Set `ALLOWED_ORIGINS` if the API is reached cross-origin.** Same-origin (the bundled SPA) needs nothing. Leave it unset for the default same-origin deployment.
- [ ] **Never commit `backend/data/`.** It contains `.secret` (the encryption key seed) and `trading.db` (encrypted API keys and tokens). It is gitignored — keep it that way, and treat backups of it as secret material.
- [ ] **Protect `.secret` file permissions.** It is written `0600`; ensure the deployment user owns it and no other account can read it.
- [ ] **Use exchange API keys with least privilege.** Prefer trade-only keys without withdrawal permission, and IP-allowlist them at the exchange where possible.
- [ ] **Keep `ALLOW_INSECURE_TRADING_MUTATIONS` unset.** The override exists only for disposable development environments where TLS cannot be used.
- [ ] **Keep secrets off disk in plaintext.** Do not stash API keys or notification tokens in `.env` files, shell history, or config files — enter them through the app so they are encrypted at rest.

## See also

- [Project README](../README.md)
- [Architecture](./ARCHITECTURE.md)
- [HTTP & WebSocket API](./API.md)
- [Trading engine](./TRADING.md)
- [Strategies](./STRATEGIES.md)
