# Configuration & deployment

SaltanatbotV2 is configured mostly at runtime through the app itself. PostgreSQL stores accounts,
revocable sessions, workspaces, research jobs and the R4 durable executor-command queue. SQLite
stores owner-scoped trading accounts, canonical paper portfolios, robots and journals plus
AES-256-GCM-encrypted per-account exchange credentials and owner-scoped
notification configuration. This split preserves existing trading state while keeping every
authenticated user's private trading surface separate.

## Environment variables

The backend first parses the process security boundary through
`backend/src/config/runtimeConfig.ts`, before identity/trading databases or listeners are opened.
Invalid, contradictory or incomplete values stop startup instead of silently falling back.
Variables outside that first slice are still owned by their feature modules and are listed below.

| Variable          | Default       | Purpose                                                                                 |
| ----------------- | ------------- | --------------------------------------------------------------------------------------- |
| `PORT`            | `4180`        | TCP port the HTTP + WebSocket server listens on.                                        |
| `HOST`            | `127.0.0.1`   | Interface the server binds to. Loopback by default (fail-safe). Set `0.0.0.0` to expose. |
| `FRONTEND_DIST_DIR` | repository `frontend/dist` | Optional normalized absolute path to the exact frontend release generation served by the API. Direct-host production should pin a protected release slot; Compose normally uses the immutable path baked into its image. |
| `AUTH_MODE` | `database` | `database` enables account login. `NODE_ENV` never changes this default. `legacy` requires an explicit value, except for the documented deprecated `DEMO_MODE=true` plus explicit `AUTH_TOKEN` compatibility path. |
| `AUTH_REGISTRATION_ENABLED` | `1` | Set `0` to hide/disable new registration after the next API restart. Existing users, pending requests and sessions are preserved. Registrations are pending until admin approval. |
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
| `READINESS_RATE_REFILL_PER_SECOND` / `READINESS_RATE_BURST` | `2` / `10` | Dedicated per-IP allowance for public `GET /api/ready`, separate from authentication/control buckets. Accepted ranges are 1–1000 and 1–10000. Excess receives `429 readiness_rate_limited` with `Retry-After`. |
| `READINESS_RATE_MAX_BUCKETS` | `4096` | Hard cap for process-local readiness IP buckets, accepted range 256–100000. An unseen source fails closed while the store is full and no idle entry can be pruned; `Retry-After` reports the remaining prune horizon. |
| `READINESS_RESULT_TTL_MS` | `1000` | Short process-wide cache for a completed readiness result, accepted range 100–10000 ms. Concurrent callers share the same in-flight PostgreSQL/heartbeat/filesystem probe; unexpected probe rejection is not cached. |
| `GLOBAL_ADMISSION_MAX_ACTIVE` | `128` | Process-wide active API-request ceiling, including the reserved control tail. |
| `GLOBAL_ADMISSION_RESERVED_CONTROL` | `16` | Slots retained for authentication, job cancellation and paper stop/kill controls. Must be lower than the total active limit. |
| `GLOBAL_ADMISSION_MAX_QUEUED` | `256` | Maximum ordinary API requests waiting before bounded work begins; overflow receives retryable HTTP 503. |
| `GLOBAL_ADMISSION_QUEUE_TIMEOUT_MS` | `2000` | Maximum ordinary admission wait before `global_admission_exhausted`; accepted range 100–30000 ms. |
| `TRADING_LEGACY_OWNER_USER_ID` | *(automatic)* | Admin UUID that receives pre-v6 SQLite trading rows. Required before the first v6 start when PostgreSQL contains multiple admins. |
| `TRADING_MAX_ACCOUNTS_PER_USER` | `8` | Hard per-owner cap for saved exchange accounts; excess existing rows are preserved. |
| `TRADING_MAX_BOTS_PER_USER` | `24` | Hard per-owner cap for saved robot configurations; excess existing rows are preserved. |
| `TRADING_MAX_RUNNING_PAPER_BOTS_PER_USER` | `4` | Concurrent paper-robot cap per owner in the single trading executor. |
| `TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER` | `2` | Reserved compatibility limit for a future separately reviewed live release; it cannot enable live work in this build. |
| `WORKSPACE_MAX_ACTIVE_PER_USER` | `25` | Maximum non-archived workspaces per owner. Archive remains available when this value is lowered below current usage. |
| `WORKSPACE_MAX_TOTAL_PER_USER` | `75` | Maximum active plus archived workspaces per owner, supported up to 3200 so the bounded browser pager can exhaust the collection. Permanent purge of an archived workspace is the owner recovery path. |
| `WORKSPACE_MAX_REVISIONS_PER_WORKSPACE` | `20` | Retained PostgreSQL content snapshots per workspace. Oldest snapshots are pruned in the same transaction as a successful save. |
| `WORKSPACE_MAX_DOCUMENT_BYTES` | `1048576` | Maximum compact UTF-8 JSON bytes for one persisted workspace payload; 1 MiB is also the supported maximum. PostgreSQL text expansion is separately bounded below the 4 MiB response ceiling. A compact request/import envelope may add at most a fixed 65536-byte transport overhead. |
| `WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER` | `67108864` | Maximum retained current plus revision payload bytes per owner; supported values are 8–64 MiB. Over-limit writes roll back without deleting an existing revision. |
| `COOKIE_SECURE`   | *(off)*       | Marks session cookies `Secure`; use only when the browser really reaches the app through HTTPS. It does not enable private/live execution. |
| `PUBLIC_ORIGIN` | *(unset)* | Optional exact canonical browser and WebSocket origin, without path/query/credentials. WebSocket `Origin` must match it or `ALLOWED_ORIGINS`; it does not enable private/live execution. |
| `DATABASE_URL` | *(unset)* | PostgreSQL URL. Takes precedence over individual `PG*` parameters and cannot be combined with `PGPASSWORD_FILE`. |
| `PGHOST` / `PGPORT` | `127.0.0.1` / `55434` | Isolated project PostgreSQL address. Compose uses `postgres:5432` internally. |
| `PGDATABASE` / `PGUSER` | `saltanatbotv2` | Dedicated database and role. |
| `PGPASSWORD_FILE` | *(unset)* | Preferred absolute regular file containing the database password for SaltanatbotV2. It is not libpq's `PGPASSFILE`; `pg_dump`, `pg_restore` and `psql` do not read this application-only format. |
| `PGPOOL_MAX` | `12` | Maximum PostgreSQL connections per API/worker process; accepted range 2–100. Readiness uses at most one at a time so the minimum retains one connection beside the probe. |
| `RESEARCH_WORKER_CONCURRENCY` | `2` | Concurrent bounded research jobs in the separate worker process; accepted range 1–4. |
| `RESEARCH_JOB_TIMEOUT_MS` | `120000` | Per-job wall-time limit; accepted range 5 seconds–15 minutes. |
| `RESEARCH_JOB_MEMORY_MB` | `512` | V8 old-generation limit for each research worker thread; accepted range 128–2048 MiB. |
| `RESEARCH_WORKER_METRICS_INTERVAL_MS` | `30000` | Aggregate queue-metrics log interval; accepted range 5 seconds–5 minutes. |
| `RESEARCH_WORKER_HEARTBEAT_INTERVAL_MS` | `15000` | Component-heartbeat interval written by the research worker; accepted range 5–60 seconds. |
| `RESEARCH_WORKER_HEARTBEAT_STALE_MS` | `90000` | API readiness fails when the required worker heartbeat is older than this; accepted range 10 seconds–15 minutes. |
| `RESEARCH_JOB_RETENTION_INTERVAL_MS` | `60000` | Bounded terminal-artifact retention interval; accepted range 1–60 minutes. |
| `RESEARCH_WORKER_SHUTDOWN_TIMEOUT_MS` | `20000` | Maximum graceful worker shutdown; keep below the supervisor stop grace period. |
| `OPERATIONS_DISK_PATH` | `backend/data` | Normalized absolute path checked by readiness for project runtime storage. Direct-host and container supervisors should set the actual persistent data path explicitly. |
| `OPERATIONS_RECOVERY_STATUS_FILE` | *(unset)* | Optional normalized absolute path to the owner-only receipt journal written by a successful `recovery:verify -- --status-file`. Keep it in separate persistent operations storage, never `backend/data`. Missing, malformed, oversized, unexpectedly linked or permission-unsafe files produce `lastVerifiedGeneration: null` and never affect readiness. |
| `OPERATIONS_DISK_SOFT_FREE_BYTES` / `OPERATIONS_DISK_HARD_FREE_BYTES` | `5368709120` / `2147483648` | Degraded and unready free-byte watermarks. The hard value must be lower than the soft value. |
| `OPERATIONS_DISK_SOFT_FREE_PERCENT` / `OPERATIONS_DISK_HARD_FREE_PERCENT` | `5` / `2` | Degraded and unready free-space percentage watermarks. The hard value must be lower than the soft value. |
| `RUNTIME_PROFILE` | `public-http-paper` | The only accepted value in this pre-HTTPS release. It permits public data, research, backtests and paper robots but forbids live configs, credential writes/decryption for use, signed REST and private WebSockets. `private-live` is rejected before database, filesystem or listener side effects, even when all future HTTPS prerequisites are supplied. |
| `DEMO_MODE`       | *(off)*       | Deprecated compatibility alias: `1`/`true` selects `public-http-paper`. Unknown values and conflicts stop startup. |
| `ENABLE_LIVE_SPOT` | *(off)* | Reserved for future design validation. `1`/`true` conflicts with the only runnable profile and stops this release at startup. |
| `ALLOWED_ORIGINS` | dev localhost | Comma-separated exact HTTP(S) CORS and WebSocket origins. When `PUBLIC_ORIGIN` is unset, public-paper WebSockets retain strictly parsed same-host access. An explicit empty value disables the development localhost defaults. |
| `TRUST_PROXY` | *(unset)* | Explicit Express trusted-proxy identity used for correct client IP/origin handling. It does not enable private/live execution; `true` remains rejected. |
| `ALLOW_INSECURE_TRADING_MUTATIONS` | *(off)* | Reserved unsafe override. The current release rejects startup when it is true. |
| `PAPER_MULTI_LEG_DB_PATH` | `backend/data/arbitrage-paper-multi-leg.sqlite` | Optional path for the bounded append-only multi-leg paper journal. Compose operators should leave the default inside `/app/backend/data`; any custom container path needs its own persistent mount and backup policy or it is lost when the container is recreated. |
| `ARBITRAGE_CONTINUOUS_ROUTES_FILE` | *(unset)* | Preferred absolute path to one bounded, regular, non-symlinked UTF-8 public-feed allowlist. Mutually exclusive with the inline JSON variable. |
| `ARBITRAGE_CONTINUOUS_ROUTES_JSON` | *(unset)* | Optional bounded public-feed allowlist for continuous multi-venue research discovery; exact reviewed identity and fee metadata only, never credentials. |

To run on a different application port after configuring PostgreSQL (paper/research only, safe default):

```bash
PORT=8080 HOST=127.0.0.1 AUTH_MODE=database RUNTIME_PROFILE=public-http-paper npm start
```

Create the first administrator once. The generated password is shown once and the first login forces
a password change:

```
npm --workspace backend run admin:bootstrap -- --login your-admin-login
```

Bootstrap is only for a database with no administrator. To recover an existing administrator, stop
this project's API and worker, take a verified backup, and run:

```bash
npm run admin:recover -- \
  --login your-admin-login \
  --confirm-login your-admin-login \
  --reason "Operator recovery after verified credential loss"
```

Recovery accepts no plaintext password from argv or the environment. It first verifies that every
checked-in PostgreSQL migration is already applied, without changing the schema. Only after a
successful transaction does it print the generated password; every existing session is revoked and
the next login must change that password. See [Self-hosting](./SELF_HOSTING.md) for Compose and
systemd stop/start procedures.

For temporary registration maintenance, set `AUTH_REGISTRATION_ENABLED=0` in the supervised API
environment and restart only that API process. Pending accounts are not deleted. Restore the value
to `1` and restart the same process when review capacity is available again.

If you bind to a non-loopback address during this HTTP phase, restrict access to a trusted private
network/VPN or a strict source-IP allowlist. HTTPS remains a separate future release (see
[Security hardening](#security-hardening)).

> **Database mode protects the application API and market WebSockets.** `POST /api/auth/login`
> creates an HttpOnly `sbv2_session` plus a readable SameSite CSRF cookie; unsafe requests must copy
> that CSRF value into `X-CSRF-Token`. `/trade-stream` additionally uses a short-lived, session-bound,
> one-time ticket. Trading resources and the private stream are owner-scoped. Exchange keys and
> notification tokens remain encrypted in SQLite, are never placed in PostgreSQL and are never
> returned to the browser.

The authentication and readiness limits are intentionally process-local because the supported deployment runs
one API/trading process. Login allowances are synchronously reserved in both the IP and normalized-
identity buckets before the first asynchronous password operation, so parallel bursts cannot pass
on stale failure counts. Capacity and internal failures roll back only their own reservation; a
successful login clears its identity bucket but preserves earlier attack history for its source IP.
All authentication buckets share one bounded store inside that process, while readiness uses a separate
bounded per-IP store plus one process-wide in-flight/short-TTL dependency result. Password hashing has a
separate global concurrency/queue gate. Do not add a second API replica and assume these limits or the
readiness cache are global; a future horizontally scaled API needs a shared external limiter in addition to the trading-
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

### Current pre-HTTPS execution boundary

This release has no operator procedure for enabling live trading. The process loader rejects
`RUNTIME_PROFILE=private-live` immediately in production, development and tests; Docker Compose
hard-codes `public-http-paper` and does not pass through live activators. `ENABLE_LIVE_SPOT=true`
also conflicts with the only runnable profile.

The repository retains future profile types, strict HTTPS-boundary validation and exchange-adapter
test fixtures so that the later security work can be reviewed without weakening today's release.
The execution authority is integrated with the durable prepared-step ledger in the future boundary:
reservation happens before handoff and consumption before a network callback. That foundation is
implemented and tested, but `createRuntimeExecutionAuthority` is intentionally not connected to
production routes or adapters. Those call sites use deny-only authorizers, so no current environment,
role, UI action, Telegram command or restart path can reach signed/private exchange I/O.

The manually triggered exchange-testnet smoke above is a maintainer-only, read-only validation tool.
It is not an application runtime profile and cannot arm orders.

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
| `backend/data/trading.db`  | SQLite database (`node:sqlite`) holding paper portfolios/ledgers, bots, fills, logs, and encrypted settings. |
| `backend/data/.trading-runtime-lock.sqlite` | Owner-only, user-data-free SQLite coordination file that enforces one trading backend process. It is not backed up. |
| `backend/data/arbitrage-paper-multi-leg.sqlite` | Bounded append-only deterministic multi-leg paper runs and restart-recovery journal. |

On a genuinely new installation, when `trading.db` does not exist, `initStore()` creates the data
directory and atomically publishes a new owner-only `.secret` before creating the database. An
existing `trading.db` always requires its existing `.secret`; startup never generates a replacement
or silently repairs insecure key permissions. The key must be a regular non-symlink file owned by
the service uid, with no group/other access, and contain 64 hexadecimal characters. One historical
trailing LF or CRLF remains compatible and is included in the exact legacy scrypt input rather than
trimmed. Before migrations or any other database write, startup opens the database read-only
(including committed WAL frames) and proves that the key authenticates every encrypted setting and
account credential. Missing, malformed, insecure or incorrect key material stops startup. A
process-lifetime exclusive lock is acquired before this sequence, and the database pathname/inode is
rechecked with non-following descriptors before and immediately after the writable SQLite open.
Another API/executor process fails startup; an OS process exit, including a crash, releases the lock.

Both are **gitignored and must never be committed.** The repository's `.gitignore` explicitly excludes `backend/data/`, `data/`, `*.secret`, `*.db`, and `*.sqlite*`.

Use the verified [backup and restore workflow](./BACKUP_RESTORE.md) before upgrades or deployment
changes. It includes the default multi-leg paper journal when present. A backup must keep
`trading.db` and `.secret` together and must be treated as secret data; a journal moved with
`PAPER_MULTI_LEG_DB_PATH` needs a separate operator backup policy.

Count encrypted rows without selecting ciphertext or opening `.secret`:

```bash
npm run data:inventory -- --data-dir backend/data
```

The backup verifier always requires `.secret`, validates its real type/owner/mode and proves that it
authenticates every encrypted row. It never prints key material, ciphertext or plaintext.

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
| `paper_events` | Append-only per-robot paper ledger, keyed by robot and ledger epoch in schema 9. |
| `paper_portfolios` / `paper_portfolio_epochs` | Owner-scoped portfolio metadata and immutable accounting epochs. |
| `paper_bot_allocations` | Exact fixed-micros capital reservation and release evidence for one robot revision. |
| `paper_portfolio_mutations` | Durable idempotency/request receipts for portfolio and robot commands. |
| `paper_bot_revision_evidence` / `paper_bot_tombstones` | Immutable configuration/deletion evidence retained independently of runtime status. |
| `paper_valuation_marks` | Current durable, source- and expiry-bound valuation evidence. |
| `paper_portfolio_events` / `paper_portfolio_projections` | Append-only lifecycle evidence and rebuildable versioned projection metadata. |
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
to receive the same venue/client identifier without journal collisions. Schema v8 adds monotonic
account/credential revisions and a per-owner authorization epoch. The R4 candidate's schema v9
adds canonical owner-scoped paper portfolios, ledger epochs, capital reservations, immutable
revision evidence, durable mutation receipts and valuation/projection evidence. Existing paper
event ledgers remain authoritative; snapshot-only legacy state is imported with explicit
`legacy-incomplete` evidence. See [Canonical paper portfolios](./PAPER_PORTFOLIOS.md).

## Dormant private-live credential contract

> **Not an operator procedure for this release.** `public-http-paper` rejects exchange-account and
> credential writes, rejects `private-live`, and stops startup when `ENABLE_LIVE_SPOT=true`.
> Do not enter exchange API keys in the current application. The examples below document retained
> future/private-live validation and storage contracts for security review only.

A future HTTPS/private-live release must never place exchange API keys in environment variables or
plaintext files. Its authenticated owner would first create exact account metadata and then submit
credentials for that account; no request field may select another user. The current server rejects
both requests before storing anything.

Future account-metadata contract (current release: `PAPER_ONLY_MODE`):

```
POST /api/trade/accounts
Content-Type: application/json

{ "label": "My Binance", "exchange": "binance", "ownership": "own", "enabled": true }
```

Future credential-store/rotation contract (current release: `PAPER_ONLY_MODE`):

```
PUT /api/trade/accounts/<account-id>/credentials
Content-Type: application/json

{ "apiKey": "<your-key>", "apiSecret": "<your-secret>" }
```

The retained implementation requires bounded values and uses AES-GCM authenticated context
containing the owner, account and exchange. Plaintext is never returned. If a future reviewed
runtime activates the contract, `GET /api/trade/accounts` exposes only
`credential.status` as `configured` or `missing`:

```
GET /api/trade/accounts
→ { "accounts": [{ "id": "…", "exchange": "binance", "credential": { "status": "configured" } }] }
```

The dormant contract blocks rotation while a bound robot is running and removal until every bot is
unbound/deleted. It remains unreachable in the current profile. The old `GET /api/trade/keys`
endpoint is only a tenant-scoped boolean compatibility view; no current endpoint can write a key.

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

**Key derivation and startup proof.** On a first run with no `trading.db`, a random 32-byte value is
hex-encoded and atomically published as `backend/data/.secret` with mode `0600`. The actual 32-byte
AES key is derived from the exact file value via `scryptSync` with the legacy fixed salt and never
leaves memory. Existing 64-hex files remain byte-for-byte compatible; a single historical trailing
LF/CRLF is preserved in the derivation rather than normalized.

```ts
const key = loadTradingMasterKey({ dataDirectory, databasePath, secretPath });
// Existing databases: read-only AEAD validation succeeds before migrations.
```

The loader refuses a missing key beside an existing database, symlinks/directories, malformed
content, a different file owner, group/other-readable permissions, invalid encryption flags and a key
that cannot authenticate existing ciphertext. It does not `chmod` or replace suspicious material.
Before key publication or migration, the store acquires an exclusive process-lifetime lock through
the owner-only `.trading-runtime-lock.sqlite` coordination database. A duplicate backend fails
startup, while a graceful stop or crash releases the OS lock without stale-lock recovery.

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
- **Losing `.secret` makes existing encrypted values undecryptable.** Startup now refuses to create a replacement beside that database. Restore the matching `trading.db` and `.secret` generation; without a trusted copy, the ciphertext cannot be recovered.
- The encryption key is derived per-installation; `.secret` is not portable to another machine unless you copy it alongside the database.
- No key fingerprint/schema metadata is written during this phase. That migration is deliberately deferred: any future metadata row must be created only after the existing ciphertext has authenticated under the supplied key, never as a write-before-proof shortcut.

## Production deployment

In production the frontend is compiled to static assets and served by the backend itself — there is no separate web server for the SPA. The backend resolves the path once from the frozen runtime configuration and validates the release before it opens databases or a network listener:

```ts
const runtimeConfig = initializeRuntimeConfig(process.env);
const frontendDistribution = validateFrontendDistribution(runtimeConfig.frontend.distDir);
installFrontendDistribution(app, frontendDistribution);
```

`express.static` serves the built assets, and the catch-all route returns the already validated
`index.html` for client-side routing. This means a single process on a single port (default `4180`)
serves both the API/WebSockets and the UI.

`FRONTEND_DIST_DIR` is optional for local development and source-checkout installs; its default is
the repository's `frontend/dist`. A direct-host production release should set it to the normalized
absolute path of one exact protected generation, for example
`/opt/saltanatbotv2/releases/2b0d86a/frontend/dist`. Do not point it at a moving `current` symlink.
The distribution directory, `index.html`, `service-worker.js` and every local script/link resource
referenced by `index.html` must be real rather than symlinked. Startup also bounds `index.html` to
1 MiB, the worker to 2 MiB, at most eight module entries, at most 64 referenced resources and each
referenced file to 32 MiB. Missing, empty, oversized, non-UTF-8 or external shell inputs fail closed
without echoing the configured filesystem path.

The protected slot is the release boundary: build and verify a candidate outside it, publish a
root-owned/read-only generation, then update `ExecStart` and `FRONTEND_DIST_DIR` to paths from that
same generation while the project API and worker are stopped. A later `npm run build` in the source
checkout can then update only the checkout's `frontend/dist`; it cannot replace the UI served by
the already running production API.

### Build and start

From the repository root, the workspace scripts (`package.json`) handle both packages:

```bash
# 1. Install dependencies (root + backend + frontend workspaces)
npm install

# 2. Build both workspaces:
#    backend → tsc → backend/dist
#    frontend → type-check → staged Vite build → PWA/budget checks → atomic frontend/dist publication
npm run build

# 3. Start the backend, which serves the configured frontend distribution
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

Because `npm start` is a plain long-lived Node process, any supervisor works. The current release
must be started in Research / Paper mode:

```bash
HOST=127.0.0.1 PORT=4180 AUTH_MODE=database \
FRONTEND_DIST_DIR=/opt/saltanatbotv2/releases/<commit>/frontend/dist \
RUNTIME_PROFILE=public-http-paper npm start
```

Point your direct-host process manager (systemd, pm2, etc.) at an exact protected release
generation, ensure `backend/data/` is on persistent storage, and restart on failure. A
self-contained Compose image normally leaves `FRONTEND_DIST_DIR` unset because `/app/frontend/dist`
already belongs to that immutable image generation.

## Security hardening

The backend defaults to a safe posture: it binds to `127.0.0.1`, database-mode APIs and WebSockets
require an active account, CORS is an allowlist, and the bundled SPA uses CSP/browser hardening
headers. Private/live exchange execution is unavailable in this release. Before exposing the
server, complete this checklist.

- [ ] **Treat HTTP as transport-insecure.** Until the separately planned HTTPS phase, keep the app on loopback, a trusted private network/VPN or a strict IP allowlist. Never reuse an important password on a public-HTTP test deployment.
- [ ] **Restrict network exposure with a firewall.** Do not expose port `4180` to the whole Internet. Permit only the intended private/VPN source addresses.
- [ ] **Protect account and database credentials.** Change the one-time administrator password,
  keep the PostgreSQL password file owner-only, review pending registrations, and disable departed
  users. Never expose a dump, cookie or CSRF value in logs/screenshots.
- [ ] **Verify tenant ownership when crossing trading schema v6/v9.** The R4 candidate's SQLite trading schema
  is v9. Create a paired PostgreSQL + SQLite recovery generation, keep
  `trading.db`/`.secret`, set `TRADING_LEGACY_OWNER_USER_ID` when multiple admins exist, and confirm
  that migrated robots and their deterministic paper portfolios appear only for the selected
  administrator. Persisted live flags remain inert.
- [ ] **Grant the minimum trading role.** New users start with no trading access. Use `read-only` or
  `paper-trade`; a `live-trade` role cannot override this release gate. Disabling/changing a user
  revokes sessions and stops that user's runtimes.
- [ ] **Keep the release profile literal.** Use `RUNTIME_PROFILE=public-http-paper`. This build
  rejects `private-live` even if future HTTPS-related settings are present.
- [ ] **Set `ALLOWED_ORIGINS` if the API is reached cross-origin.** Same-origin (the bundled SPA) needs nothing. Leave it unset for the default same-origin deployment.
- [ ] **Never commit `backend/data/`.** It contains `.secret` (the encryption key seed) and `trading.db` (encrypted API keys and tokens). It is gitignored — keep it that way, and treat backups of it as secret material.
- [ ] **Protect `.secret` file permissions.** It is written `0600`; ensure the deployment user owns it and no other account can read it.
- [ ] **Do not enter new exchange API keys in this phase.** The current runtime rejects credential writes and private exchange use. Existing encrypted records are preserved only for compatibility and backup.
- [ ] **Keep `ALLOW_INSECURE_TRADING_MUTATIONS` unset.** The current release rejects it when true.
- [ ] **Keep secrets off disk in plaintext.** Do not stash database passwords, notification tokens or dormant exchange material in `.env` files, shell history or source-controlled config.

## See also

- [Project README](../README.md)
- [Architecture](./ARCHITECTURE.md)
- [HTTP & WebSocket API](./API.md)
- [Trading engine](./TRADING.md)
- [Canonical paper portfolios](./PAPER_PORTFOLIOS.md)
- [Strategies](./STRATEGIES.md)
