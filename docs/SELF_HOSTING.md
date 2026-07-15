# Self-hosting with account authentication

Audience: operators and people installing a fork
Last verified: 2026-07-15

SaltanatbotV2 remains self-hostable and does not require an OpenAI account, an OpenAI package, or
any project-owned cloud service. PostgreSQL stores users, browser sessions, named workspaces and
research jobs. SQLite stores owner-partitioned trading accounts, robots, journals and encrypted
per-account exchange credentials, plus candles and paper journals. Forward migrations preserve
existing records; make a verified backup before every upgrade.

At startup the trading store enforces mode `0700` on `backend/data/` and `0600` on both
`trading.db` and its `.secret`, including files created by older versions with broader modes.

## Docker Compose installation

Prerequisites: Docker Engine with the Compose plugin.

```bash
git clone https://github.com/AubakirovArman/SaltanatbotV2.git
cd SaltanatbotV2
mkdir -p .secrets
umask 077
openssl rand -base64 48 > .secrets/postgres_password
docker compose up -d --build
```

The default endpoints are:

- web application: `http://127.0.0.1:4180` when the app port is bound locally;
- project PostgreSQL: `127.0.0.1:55434` on the host and `postgres:5432` inside Compose;
- health: `/api/health` (process) and `/api/ready` (process plus database).

The plain-HTTP address above is for loopback/local use only. Never submit an account password over
public `http://IP:4180`: HTTP does not encrypt it in transit. For remote users, keep the application
bound to loopback, terminate TLS at a reverse proxy, set `TRUST_PROXY` to that proxy only and enable
`COOKIE_SECURE=1`. The proxy must forward WebSocket upgrades as well as normal HTTP requests.

The database mapping is loopback-only. If `55434` is already occupied, set a different free host
port without changing the container network:

```bash
POSTGRES_HOST_PORT=55435 docker compose up -d
```

Create the first administrator once:

```bash
docker compose exec saltanatbotv2 \
  node backend/dist/cli/bootstrapAdmin.js --login your-admin-login
```

The command prints one generated password once. It is not written to the repository or stored in
plaintext in PostgreSQL. Sign in with it, change it immediately when prompted, then delete the
terminal scrollback if other people can read it. A second bootstrap attempt fails closed.

Registration is intentionally simple: a person chooses a login and password, receives a pending
status, and cannot create a session until an administrator activates the account. The account menu
contains the pending-user list for administrators. Disabling an account or changing its permissions
revokes its active sessions.

## Direct host installation

Prerequisites: Node.js 24+, npm, and an isolated PostgreSQL database/user. PostgreSQL may run on any
free port; the project default is `127.0.0.1:55434` specifically to avoid common `5432` installations.

```bash
npm ci
npm run build

export AUTH_MODE=database
export PGHOST=127.0.0.1
export PGPORT=55434
export PGDATABASE=saltanatbotv2
export PGUSER=saltanatbotv2
export PGPASSWORD_FILE=/absolute/private/path/postgres_password

npm --workspace backend run admin:bootstrap -- --login your-admin-login
npm start
```

`PGPASSWORD_FILE` must be an absolute path to a regular file. Keep it owner-readable only. The app
also accepts `DATABASE_URL`, but not together with `PGPASSWORD_FILE`. Database migrations are
checksum-verified, run in one transaction and take a PostgreSQL advisory lock, so two starting
processes cannot apply a migration concurrently.

## What persists where

| Storage | Data | Backup tool |
| --- | --- | --- |
| PostgreSQL | users, hashed passwords, sessions, WS tickets, auth audit, workspaces/revisions, research jobs | `pg_dump` / `pg_restore` |
| `backend/data/trading.db` | owner-scoped trading accounts, bots, orders, fills, logs, audit rows and encrypted account credentials/notifications | `npm run data:backup` |
| `backend/data/.secret` | AES root secret for encrypted SQLite settings | `npm run data:backup` |
| `backend/data/candles.db` | optional candle cache | `npm run data:backup` |
| paper-journal SQLite files | paper multi-leg history | `npm run data:backup` at the default path |

The browser keeps an offline/local copy of chart preferences and exportable artifacts. Named
workspace sync is additive and owner-scoped; file export/import remains available so a fork is not
locked to one server.

## Multi-user trading boundary

Each authenticated user is a separate trading tenant. The server derives the tenant ID from the
validated session; request bodies and query parameters cannot select another owner. Accounts,
credentials, bots, fills, orders, logs, audit rows, portfolio state, emergency state, notifications
and `/trade-stream` events are filtered by that owner. A guessed foreign resource ID returns `404`.
Application administrators can activate users and assign `read-only`, `paper-trade` or `live-trade`
access, but the admin API does not expose another user's trading resources or exchange secrets.

Exchange credentials belong to one concrete trading account. They are encrypted with AES-256-GCM
and account/owner-specific authenticated context, are never returned to the browser, and cannot be
rotated while a bound robot is running. This is logical application isolation inside one deployment,
not a claim that the machine's root operator cannot read process memory or the SQLite root secret.
Protect `trading.db` and `.secret` as if they contained plaintext credentials.

Trading-role assignment is enabled by default after the owner migration. Set
`AUTH_TRADING_ROLES_ENABLED=0` only as a maintenance kill switch for non-admin trading access;
changing or removing a user's permission revokes sessions, disconnects private streams and stops
that user's running robots.

Per-user Telegram/VK notifications are outbound-only in database auth mode. Inbound Telegram bot
commands remain available only in explicit legacy single-operator mode until the poller can bind a
chat to a durable user and verify the current trading role on every command.

### Upgrading a pre-tenant trading database

Schema v6 transactionally assigns every pre-v6 trading row to one administrator, re-encrypts each
legacy `keys:binance`/`keys:bybit` value for its concrete migrated account and clears the old
server-wide live arm. Nothing is assigned to newly registered users. Before the first v6 start:

1. Stop the application and run both the PostgreSQL and `npm run data:backup` backups.
2. Ensure the intended owner already exists in PostgreSQL with `appRole=admin`.
3. If there is more than one administrator, set `TRADING_LEGACY_OWNER_USER_ID` to the intended
   administrator UUID. Startup deliberately refuses an ambiguous migration.
4. Start exactly one API process, inspect the migration log and verify the old robots under that
   administrator before manually rearming live trading.

With exactly one administrator the server selects that account automatically. On a brand-new empty
installation `TRADING_LEGACY_OWNER_USER_ID` is unnecessary.

## Updating a fork

1. Verify PostgreSQL and SQLite backups.
2. Pull or merge the desired commit.
3. Run `npm ci`, tests and `npm run build` (or rebuild the Compose image).
4. Restart one API instance; migrations run automatically. For the first schema-v6 upgrade, follow
   the legacy-owner procedure above.
5. Check `/api/ready`, pending jobs, per-user account visibility and current robots before rearming
   live trading.

Never start a second copy of the current trading backend against the same `trading.db`: both copies
could restore the same bot. Horizontal API replicas become safe only after the trading executor and
event fan-out are separated.
