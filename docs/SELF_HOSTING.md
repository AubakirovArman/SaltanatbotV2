# Self-hosting with account authentication

Audience: operators and people installing a fork
Last verified: 2026-07-15

SaltanatbotV2 remains self-hostable and does not require an OpenAI account, an OpenAI package, or
any project-owned cloud service. PostgreSQL stores users, browser sessions, named workspaces and
research jobs. The existing SQLite files continue to store legacy trading/bot state, encrypted
exchange settings, candles and paper journals; installation never converts or deletes them.

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
| `backend/data/trading.db` | legacy bots, orders, fills, logs, encrypted exchange/notification settings | `npm run data:backup` |
| `backend/data/.secret` | AES root secret for encrypted SQLite settings | `npm run data:backup` |
| `backend/data/candles.db` | optional candle cache | `npm run data:backup` |
| paper-journal SQLite files | paper multi-leg history | `npm run data:backup` at the default path |

The browser keeps an offline/local copy of chart preferences and exportable artifacts. Named
workspace sync is additive and owner-scoped; file export/import remains available so a fork is not
locked to one server.

## Current multi-user safety boundary

Activated users may use monitoring, charts, screeners, strategy research, workspaces and their own
research jobs. The existing Trade/Robots database remains administrator-only because its bots,
exchange credentials and event stream predate per-user ownership. Do not enable
`AUTH_ENABLE_SHARED_TRADING_ROLES` on a shared deployment. A safe future migration must add owner
IDs, filter every REST/WebSocket path, migrate credentials per account and assign legacy bots during
a maintenance window before a separate trading executor can be started.

## Updating a fork

1. Verify PostgreSQL and SQLite backups.
2. Pull or merge the desired commit.
3. Run `npm ci`, tests and `npm run build` (or rebuild the Compose image).
4. Restart one API instance; migrations run automatically.
5. Check `/api/ready`, pending jobs and current robots before rearming live trading.

Never start a second copy of the current trading backend against the same `trading.db`: both copies
could restore the same bot. Horizontal API replicas become safe only after the trading executor and
event fan-out are separated.
