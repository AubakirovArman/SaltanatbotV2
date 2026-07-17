# Self-hosting with account authentication

Audience: operators and people installing a fork
Last verified for accepted R4 deployment: 2026-07-17

Accepted production evidence: commit `bb455facdfe5a1b3cabe15490c86c299ea684ee7`, GitHub Actions
run `29560112312` with all 6 required jobs successful, protected slot
`r4c-schema12-bb455fa`, PostgreSQL schema 12 and trading SQLite schema 9. The exact-release paired
backup/verify/isolated-restore/drill and post-migration recovery evidence passed.

R5.1 is an implementation candidate and is not deployed on the accepted production installation.
Its repository migration advances PostgreSQL from schema 12 to 13 for owner-scoped server alerts;
production remains schema 12 until an exact candidate completes the backup, isolated-restore and
cutover procedure below. The accepted R4 evidence is immutable and is not evidence for R5.1. See
[Owner-scoped server alerts](./ALERTS.md).

SaltanatbotV2 remains self-hostable and does not require an OpenAI account, an OpenAI package, or
any project-owned cloud service. PostgreSQL stores users, browser sessions, named workspaces,
research jobs and the R4 durable executor-command queue. SQLite stores owner-partitioned trading
accounts, canonical paper portfolios, robots, journals and encrypted
per-account exchange credentials, plus candles and paper journals. Forward migrations preserve
existing records; make a verified backup before every upgrade.

The accepted R4 release advances PostgreSQL to schema 12 and trading SQLite to schema 9. Its paper
portfolio lifecycle, two-store authority boundary and exact upgrade/rollback checklist are in
[Canonical paper portfolios](./PAPER_PORTFOLIOS.md). A fork or later release must still pass its own
exact-build recovery and cutover gates; it cannot inherit the production evidence above.

The only runnable execution boundary in this pre-HTTPS release is
`RUNTIME_PROFILE=public-http-paper`. It keeps monitoring, public
market data, screeners, backtests and paper robots available, while the backend rejects live robot
configuration/start/resume, credential writes and every signed REST/private WebSocket request with
stable code `PAPER_ONLY_MODE`. It also clears persisted live-arm flags at startup without deleting
bots, accounts, credentials or audit history. `private-live` remains a future typed design but this
build rejects it even when all future HTTPS prerequisites are supplied.

Runtime security settings are parsed once into a frozen typed snapshot before databases, runtime
files or network listeners are initialized. Unknown booleans, malformed ports/origins/proxy ranges
and every attempt to select `private-live` stop startup. There is no `NODE_ENV=test`, development or
Docker bypass for these production invariants. Compose hard-codes the paper profile and does not
pass live activators into the application container.

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
- health: `/api/health` is cheap process liveness; `/api/ready` verifies the
  schema checksum, PostgreSQL, paper executor, research-worker heartbeat,
  runtime-data disk watermarks and global admission pressure.

The plain-HTTP address above is for loopback/local use only. Never submit an account password over
public `http://IP:4180`: HTTP does not encrypt it in transit. HTTPS deployment is explicitly
deferred from the current work. Until that separate phase is implemented and reviewed, remote test
access must stay behind a trusted private network/VPN and a strict source-IP allowlist, using unique
passwords that are not reused elsewhere.

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
terminal scrollback if other people can read it. Concurrent bootstrap attempts are serialized in
PostgreSQL and only one can succeed; every later attempt fails closed. Use bootstrap only to create
the first administrator. It is not a password-reset command.

Registration is intentionally simple: a person chooses a login and password, receives a pending
status, and cannot create a session until an administrator activates the account. The account menu
contains the pending-user list for administrators. Disabling an account or changing its permissions
revokes its active sessions. An administrator cannot disable or demote the last active administrator,
including when two administrators try to remove each other concurrently.

### Registration maintenance mode

Set `AUTH_REGISTRATION_ENABLED=0` and restart only this project's API process to temporarily close
new registration. Existing users, pending requests, sessions and data are preserved; administrators
can still review existing pending accounts. The value is read at process start, so changing a shell
or `.env` file without restarting the API has no effect. Set it back to `1` and restart the same API
process to reopen registration. The research worker and PostgreSQL do not need to be recreated for
this setting.

### Recover an existing administrator password

Recovery is an exceptional operator procedure, not an authentication endpoint. First stop this
project's API and research worker so an already connected browser or WebSocket cannot outlive the
database revocation. Take the matching PostgreSQL and runtime-data backups, and use the recovery CLI
from the exact release whose checked-in PostgreSQL schema is already applied. The CLI deliberately
does not run migrations.

For Compose:

```bash
docker compose stop saltanatbotv2 research-worker
docker compose run --rm --no-deps saltanatbotv2 \
  node backend/dist/cli/recoverAdmin.js \
  --login your-admin-login \
  --confirm-login your-admin-login \
  --reason "Operator recovery after verified credential loss"
docker compose up -d saltanatbotv2 research-worker
```

`--confirm-login` must exactly match `--login`, and a reason is mandatory for the audit record.
There is no password argument or password environment variable. After the transaction succeeds,
the command revokes every session, marks the account for mandatory password change and prints one
generated password once. It prints no password on failure. If the output is lost, run the guarded
procedure again rather than placing a password in shell history.

Authentication and public-readiness abuse protection are enabled without extra services: failed login attempts are
limited independently by client IP and normalized login, every registration attempt consumes the
per-IP allowance even when it succeeds, and Argon2id has a bounded global worker/queue gate. The
in-process limiter stores are capped at 4,096 keys by default, which leaves ample headroom for
the first 100 users while preventing attacker-controlled map growth. See
[Configuration](./CONFIGURATION.md) for tuning variables. Readiness has its own IP store and
allowance; accepted overlap shares one dependency evaluation and its result for a one-second TTL.
If a trusted private-network proxy is
already present, set `TRUST_PROXY` only to that exact proxy; otherwise all clients can appear as one
IP and share its allowance. This does not add transport encryption or enable private/live trading.

## Direct host installation

Prerequisites: Node.js 24+, npm, PostgreSQL 17 client/server tools and systemd. The examples below
assume a fresh checkout at `/opt/saltanatbotv2` and a dedicated unprivileged operating-system user
named `saltanatbotv2`. Change all matching paths consistently if your layout differs.

### Create a separate PostgreSQL cluster

Do not reuse, stop, reconfigure or migrate an unrelated PostgreSQL instance. Pick a free loopback
port first. The application default is `55434` specifically to avoid common `5432` installations:

```bash
PG_MAJOR=17
PG_CLUSTER=saltanatbotv2
PGPORT=55434

if ss -H -ltn "sport = :$PGPORT" | grep -q .; then
  echo "Port $PGPORT is already in use; choose another port and stop here."
  exit 1
fi
if sudo pg_lsclusters --no-header | awk '{print $1 ":" $2}' \
  | grep -qx "$PG_MAJOR:$PG_CLUSTER"; then
  echo "PostgreSQL cluster $PG_MAJOR/$PG_CLUSTER already exists; inspect it and stop here."
  exit 1
fi
```

On Debian/Ubuntu, create a new named cluster rather than changing the default cluster. This command
only creates `17/saltanatbotv2`; it contains no `DROP`, restore or data-directory reuse:

```bash
sudo pg_createcluster --port "$PGPORT" --start \
  "$PG_MAJOR" "$PG_CLUSTER" -- --auth-local=peer --auth-host=scram-sha-256

sudo -u postgres psql --port "$PGPORT" --dbname postgres \
  --tuples-only --no-align --command="SHOW listen_addresses"
```

The last command must report only `localhost`/loopback. If it reports a wildcard or public address,
stop this new cluster and correct its own configuration before continuing. Other distributions
should use their supported equivalent to create a new named cluster with its own data directory,
the selected free port, loopback-only listening and SCRAM host authentication.

Create a service account, one non-superuser PostgreSQL role and one database. These commands fail if
the names already exist; they do not alter or delete the existing object:

```bash
sudo useradd --system --home-dir /var/lib/saltanatbotv2 --create-home \
  --shell /usr/sbin/nologin saltanatbotv2

sudo -u postgres createuser --port "$PGPORT" --pwprompt --login \
  --no-superuser --no-createdb --no-createrole --no-replication saltanatbotv2
sudo -u postgres createdb --port "$PGPORT" \
  --owner=saltanatbotv2 saltanatbotv2
sudo -u postgres psql --port "$PGPORT" --dbname postgres \
  --set=ON_ERROR_STOP=1 \
  --command='REVOKE ALL ON DATABASE saltanatbotv2 FROM PUBLIC'
```

The `createuser --pwprompt` step asks twice for a unique password without echoing it and sends a
SCRAM verifier rather than putting the plaintext in shell history. Enter that same password into
the application's hidden prompt:

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 \
  /etc/saltanatbotv2
sudo -u saltanatbotv2 bash -c \
  'umask 077; read -rsp "Repeat PostgreSQL password for the app: " password; echo; printf "%s\n" "$password" > /etc/saltanatbotv2/postgres_password; unset password'
sudo stat -c '%U:%G %a %n' /etc/saltanatbotv2/postgres_password
```

The final line must show `saltanatbotv2:saltanatbotv2 600`. Stop and correct the file owner/mode if
it does not. `PGPASSWORD_FILE` must be an absolute path to a regular file. The application removes
only one final line ending and never logs the password. Do not also set `PGPASSWORD` or
`DATABASE_URL`.

### Build and supervise exactly two Node processes

From the repository root:

```bash
npm ci
npm run check
npm run build
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 \
  /opt/saltanatbotv2/backend/data \
  /opt/saltanatbotv2/operations
```

For a direct-host production cutover, do not keep serving the mutable checkout output. Package the
verified backend and frontend into one exact release directory, make that generation read-only to
the service account, and set the API environment to its normalized absolute frontend path:

```text
FRONTEND_DIST_DIR=/opt/saltanatbotv2/releases/<commit>/frontend/dist
```

Use the same `<commit>` generation in the API `ExecStart`. Do not use a moving `current` symlink and
do not run a build inside the active protected slot. The API checks the real `index.html`,
`service-worker.js` and every local script/link resource referenced by the shell before opening its
listener; a missing, symlinked, empty or oversized generation stops startup. The default repository
`frontend/dist` remains useful for local source-checkout runs, while a later local build cannot alter
an API pinned to the separate protected slot. The Compose image already contains one
self-consistent immutable generation and normally leaves this variable unset.

The production application has exactly two independently supervised Node processes:

1. `saltanatbotv2.service` serves the built frontend, API, public WebSockets and the single
   owner-partitioned paper runtime on port `4180`;
2. `saltanatbotv2-research-worker.service` claims bounded PostgreSQL research jobs and, in the R5.1
   candidate, evaluates owner alerts from credential-free public REST candles. It opens no HTTP
   port and receives no exchange secrets.

Do not also run `npm start`, `npm run dev`, PM2, another container or a second API unit against the
same `backend/data/trading.db`. PostgreSQL is supervised separately by the operating system and is
not a third application process.

Install the reviewed examples, adjusting all occurrences of `/opt/saltanatbotv2`, `PGPORT` or the
service account first when your layout differs:

```bash
sudo install -o root -g root -m 0644 \
  deploy/systemd/saltanatbotv2.service.example \
  /etc/systemd/system/saltanatbotv2.service
sudo install -o root -g root -m 0644 \
  deploy/systemd/saltanatbotv2-research-worker.service.example \
  /etc/systemd/system/saltanatbotv2-research-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now \
  saltanatbotv2.service saltanatbotv2-research-worker.service
```

The API example is available at
[`deploy/systemd/saltanatbotv2.service.example`](../deploy/systemd/saltanatbotv2.service.example);
the worker example is at
[`deploy/systemd/saltanatbotv2-research-worker.service.example`](../deploy/systemd/saltanatbotv2-research-worker.service.example).
Both run as the unprivileged service user, drop Linux capabilities, make the checkout read-only,
limit resources and hard-pin `RUNTIME_PROFILE=public-http-paper`. Only the API receives write access
to `backend/data`; the worker receives PostgreSQL configuration only.

Check both units and database readiness:

```bash
systemctl --no-pager --full status \
  saltanatbotv2.service saltanatbotv2-research-worker.service
curl --fail --silent http://127.0.0.1:4180/api/health
curl --fail --silent http://127.0.0.1:4180/api/ready
```

Once admitted and inside its dedicated IP allowance, `/api/ready` returns HTTP 503 for a hard dependency failure, HTTP 200 with
`status: "degraded"` for a soft disk/admission watermark, and HTTP 200 with
`status: "ready"` otherwise. If the bounded ordinary admission lane is exhausted, the probe instead
receives `503 global_admission_exhausted`. A source above the default 2 requests/second with burst
10 instead receives `429 readiness_rate_limited` and `Retry-After`. Accepted concurrent callers
share one dependency evaluation, and the completed result is reused for one second; do not poll
more frequently merely to bypass that bound. Together these controls prevent readiness polling from
consuming the control reserve or creating unbounded PostgreSQL/filesystem work. When the IP store is
full, `Retry-After` reports the remaining idle-key prune horizon. The two PostgreSQL checks run
sequentially, and `PGPOOL_MAX` must be at least 2. Public readiness exposes only categorical
component states—no exact database latency, migration/checksum, worker age/state, disk capacity or
admission load. An authenticated administrator can inspect the
bounded latency/status buckets, pool/admission/readiness-limiter counters and worker freshness at
`/api/admin/operations/metrics`; ordinary users cannot access that endpoint. If
`OPERATIONS_RECOVERY_STATUS_FILE` names a valid receipt published by successful
`recovery:verify -- --status-file`, the same admin-only response also shows its
bounded generation evidence. Missing or invalid evidence reports `null` and
never makes readiness fail.

Keep that receipt under the separate owner-only `operations/` directory, never
inside `backend/data/`: runtime restore intentionally manages the latter and
must not preserve stale recovery evidence. Compose leaves the setting empty by
default; operators who enable it must add a separate persistent read-only mount
for the API and run verification as the same numeric OS user.

Create the first administrator once, under the same service account and database settings. The
generated application password is printed once and must be changed at first login:

```bash
sudo -u saltanatbotv2 env \
  AUTH_MODE=database RUNTIME_PROFILE=public-http-paper \
  PGHOST=127.0.0.1 PGPORT=55434 \
  PGDATABASE=saltanatbotv2 PGUSER=saltanatbotv2 \
  PGPASSWORD_FILE=/etc/saltanatbotv2/postgres_password \
  /usr/bin/node /opt/saltanatbotv2/backend/dist/cli/bootstrapAdmin.js \
  --login your-admin-login
```

For guarded recovery on a direct systemd installation, stop only the two SaltanatbotV2 units and
run the recovery command with the same database environment. The checked-in schema must already
match; this command never upgrades it:

```bash
sudo systemctl stop \
  saltanatbotv2.service saltanatbotv2-research-worker.service
sudo -u saltanatbotv2 env \
  AUTH_MODE=database RUNTIME_PROFILE=public-http-paper \
  PGHOST=127.0.0.1 PGPORT=55434 \
  PGDATABASE=saltanatbotv2 PGUSER=saltanatbotv2 \
  PGPASSWORD_FILE=/etc/saltanatbotv2/postgres_password \
  /usr/bin/node /opt/saltanatbotv2/backend/dist/cli/recoverAdmin.js \
  --login your-admin-login \
  --confirm-login your-admin-login \
  --reason "Operator recovery after verified credential loss"
sudo systemctl start \
  saltanatbotv2.service saltanatbotv2-research-worker.service
```

If you selected another PostgreSQL port, use the same value in both units and the bootstrap command.
The API accepts durable research jobs, while the worker claims and executes them. Running only the
API leaves jobs safely queued but does not process them.

For a non-systemd smoke test only, export the same values and run the two commands in separate
terminals:

```bash
export AUTH_MODE=database
export RUNTIME_PROFILE=public-http-paper
export PGHOST=127.0.0.1
export PGPORT=55434
export PGDATABASE=saltanatbotv2
export PGUSER=saltanatbotv2
export PGPASSWORD_FILE=/etc/saltanatbotv2/postgres_password

npm start
npm --workspace backend run worker:start
```

Stop those terminals before enabling the systemd units.

The worker opens no HTTP port and must use the same isolated PostgreSQL database as the API.
`RESEARCH_WORKER_CONCURRENCY`, `RESEARCH_JOB_TIMEOUT_MS` and `RESEARCH_JOB_MEMORY_MB` bound each
process. `RESEARCH_WORKER_HEARTBEAT_INTERVAL_MS` defaults to 15 seconds; the API treats a heartbeat
older than `RESEARCH_WORKER_HEARTBEAT_STALE_MS` (90 seconds by default) as unready.
`RESEARCH_JOB_RETENTION_INTERVAL_MS` controls the bounded retention pass (60 seconds by default,
accepted range 60 seconds to one hour). `RESEARCH_WORKER_SHUTDOWN_TIMEOUT_MS` must remain below the
supervisor stop timeout so a stuck database call cannot prevent lease recovery.
Authenticated users can inspect only their own bounded queue metrics at `/api/jobs/metrics`; worker
logs contain aggregate counts and durations, never job payloads, account credentials or owner
identifiers.

Queued and running jobs are never compacted. Terminal payload/result artifacts are compacted when
the first owner-scoped limit is reached: 30 days, 200 full terminal jobs, or 256 MiB of recorded
payload/result JSON. Each pass changes at most 50 rows while holding the same owner advisory lock as
enqueue/idempotency. Compact metadata tombstones retain the job ID, terminal status,
`clientRequestId` and content digest for at most 90 days and 1,000 tombstones per owner. During that
window an exact retry returns HTTP 410 instead of running twice, while a reused request ID with
different content remains HTTP 409. A new request ID may rerun the same content after its full
artifact was compacted. The 90-day idempotency horizon is an upper bound: a tenant producing more
than 1,000 tombstones reaches the count cap first; after tombstone removal, old IDs return 404 and
may be submitted again.

The app also accepts `DATABASE_URL`, but not together with `PGPASSWORD_FILE`. Database migrations are
checksum-verified, run in one transaction and take a PostgreSQL advisory lock, so two starting
processes cannot apply a migration concurrently. `PGPASSWORD_FILE` is an application setting, not a
libpq setting: PostgreSQL command-line tools use an owner-only `PGPASSFILE`, `PGPASSWORD`, or their
interactive password prompt. Never assume `pg_dump` or `pg_restore` reads the application's raw
password file. The repository's `recovery:*` wrapper validates and reads that owner-only file itself
before launching the PostgreSQL tool without printing the password.

## What persists where

| Storage | Data | Backup tool |
| --- | --- | --- |
| PostgreSQL | users, hashed passwords, authorization revisions, sessions, WS tickets, auth audit, workspaces/revisions, research jobs and, after schema 13, owner alert rules/state/receipts/events/outbox | paired `npm run recovery:backup` / `recovery:restore`; raw `pg_dump` / `pg_restore` remain low-level tools |
| `backend/data/trading.db` | owner-scoped trading accounts, bots, orders, fills, logs, audit rows and encrypted account credentials/notifications | same paired recovery generation; `npm run data:backup` remains the low-level SQLite-only tool |
| `backend/data/.secret` | AES root secret for encrypted SQLite settings | same verified runtime backup |
| `backend/data/candles.db` | optional candle cache | same verified runtime backup |
| paper-journal SQLite files | paper multi-leg history | same backup at the default path; separately back up a custom path |

The browser keeps an offline/local copy of chart preferences and exportable artifacts. In database
authentication mode, named workspaces, chart sessions and drawings, alerts, watchlists, shortcuts,
strategy/indicator libraries and parameter overrides, plugin trust, the paper-arbitrage ledger, and
saved trading commands use a separate browser-storage namespace for each user ID. Plugin signing
identities are also separate IndexedDB records; the old shared legacy private key is deliberately
not assigned to any database-auth account. Pre-authentication non-key browser data can be claimed
once by the first authenticated user in that browser profile. Web Locks provide the primary
origin-wide exclusion; browsers without Web Locks use an IndexedDB atomic add-if-absent owner
claim. If neither safe primitive is available, migration fails closed and leaves legacy data
unclaimed instead of guessing an owner. Later users never inherit claimed data. After upgrading a
shared installation, use a current browser and sign in with the intended legacy-data owner first.
File export/import remains available so a fork is not locked to one server.

This browser namespace prevents accidental disclosure when accounts take turns in the same browser,
but it is not an operating-system security boundary: someone with access to the same browser profile
and its developer tools can inspect local storage. Use separate OS/browser profiles on an untrusted
shared device and clear site data before handing the profile to another person.

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

The SQLite master key is fail-stop. Only a new installation with no `trading.db` may atomically
create `.secret`. For an existing database, a missing, malformed, symlinked/directory, foreign-owned,
group/other-readable or cryptographically incorrect key stops startup before migrations or other
database writes. Startup validates all encrypted settings and account credentials through a
read-only connection that observes committed WAL data. It never replaces the key or silently fixes
its permissions. Startup also holds an exclusive owner-only SQLite coordination lock for the process
lifetime and rechecks the `trading.db` inode before the writable open; a second backend fails closed,
and a crash releases the OS lock. Use `npm run data:inventory -- --data-dir backend/data` for
count-only encrypted-row evidence and restore `trading.db` together with its matching `.secret`.

Trading-role assignment is enabled by default after the owner migration. Set
`AUTH_TRADING_ROLES_ENABLED=0` only as a maintenance kill switch for non-admin trading access;
changing or removing a user's permission revokes sessions, disconnects private streams and stops
that user's running robots.

Roles do not override the runtime profile. Even an administrator with `live-trade` receives
`PAPER_ONLY_MODE` while `public-http-paper` is active; the interface hides API-key, live-arm, private
telemetry and UTA controls and labels the workspace `Research / Paper`.

The API also applies hard, owner-local quotas before allocating trading control-plane resources:

| Environment variable | Default | What it limits |
| --- | ---: | --- |
| `TRADING_MAX_ACCOUNTS_PER_USER` | 8 | saved exchange accounts |
| `TRADING_MAX_BOTS_PER_USER` | 24 | saved robot configurations |
| `TRADING_MAX_RUNNING_PAPER_BOTS_PER_USER` | 4 | concurrently running paper robots |
| `TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER` | 2 | concurrently running live robots |
| `WORKSPACE_MAX_ACTIVE_PER_USER` | 25 | active saved workspaces |
| `WORKSPACE_MAX_TOTAL_PER_USER` | 75 | active plus archived workspaces |
| `WORKSPACE_MAX_REVISIONS_PER_WORKSPACE` | 20 | retained content snapshots for one workspace |
| `WORKSPACE_MAX_DOCUMENT_BYTES` | 1048576 | one persisted workspace payload; compact request/import envelopes have a fixed additional 65536-byte transport allowance |
| `WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER` | 67108864 | current plus revision payload bytes for one owner |

These are conservative per-owner defaults, not an integrated proof for 100 simultaneous users;
global admission and load evidence remain R11 work. Workspace list/history pages are metadata-first,
keyset-paginated and capped at 4 MiB including response wrappers. Supported operator maxima are
3200 total workspaces, 100 revisions, a 1 MiB compact document and 64 MiB retained payload; the
browser independently bounds page count and aggregate bytes. A limit must be a positive integer;
invalid configuration stops startup. Lowering a limit never
deletes data: excess existing accounts, robots and workspaces remain readable. Workspace archive
and archived-only permanent purge stay available so an owner can recover quota; restore is
quota-enforced. Permanent purge is destructive and cascades retained revisions, so recovery
requires the matching PostgreSQL backup. New over-limit create/start/restore operations return
HTTP `429` with stable quota codes.

Compose reads these values from the deployment `.env` and passes them to the web service. A direct
systemd installation should set them in a project-service drop-in before `daemon-reload`; the
research worker does not need workspace limits. Raise limits only after measuring event-loop lag,
exchange connections, memory and API latency. The current executor is single-process; do not run
two API replicas against the same trading SQLite database.

Per-user Telegram/VK notifications are outbound-only in database auth mode. Inbound Telegram bot
commands remain available only in explicit legacy single-operator mode until the poller can bind a
chat to a durable user and verify the current trading role on every command.

### Canonical paper portfolios in R4

With database authentication, paper-portfolio mutations no longer write directly from an HTTP
handler into ad hoc bot state. The browser supplies the expected owner, current portfolio/robot
revisions and a stable idempotency key. PostgreSQL schema 12 durably queues that command and fences
it to the active session authorization revision/epoch. The single trading executor applies it to
SQLite schema 9 and records a terminal receipt with the same portfolio mutation.

Run exactly one API/executor against one `backend/data/trading.db`. A second API replica is not a
capacity upgrade and must fail closed on the SQLite runtime lock. The research worker has no need
for `backend/data` access. Do not add a third service, listener or database for R4, and do not reuse
another project's PostgreSQL database, volume, port or runtime directory.

The browser's **Running / Paper portfolios** center creates and selects portfolios, reserves
capital while creating a robot, and provides confirmed start/pause/resume/stop. Archive requires no
active allocations. Reset closes the current ledger epoch, retains all prior evidence and requires
explicit robot rebind. No part of this workflow asks for an exchange key.

### Upgrading a pre-tenant or pre-portfolio trading database

R4's SQLite trading schema is v9. The migration that crosses v6 transactionally assigns every
pre-v6 trading row to one administrator, re-encrypts each
legacy `keys:binance`/`keys:bybit` value for its concrete migrated account and clears the old
server-wide live arm. Nothing is assigned to newly registered users. Before the first v6 start:

1. Stop the application and run both the PostgreSQL and verified runtime-data backups. Compose
   operators must use the [named-volume procedure](./BACKUP_RESTORE.md#docker-compose-named-volume),
   because `backend/data` is not stored in the source checkout.
2. Ensure the intended owner already exists in PostgreSQL with `appRole=admin`.
3. If there is more than one administrator, set `TRADING_LEGACY_OWNER_USER_ID` to the intended
   administrator UUID. Startup deliberately refuses an ambiguous migration.
4. Start exactly one API process, inspect the migration log and verify the old robots under that
   administrator. When crossing v9, also verify that each legacy paper robot appears in its own
   deterministic epoch-1 portfolio and that incomplete legacy evidence is labelled rather than
   synthesized. The current profile keeps all live state inert.

With exactly one administrator the server selects that account automatically. On a brand-new empty
installation `TRADING_LEGACY_OWNER_USER_ID` is unnecessary.

### R5.1 schema 13 candidate cutover

This is a future candidate procedure, not a statement that production has already moved beyond
schema 12. The schema-13 checksum is
`1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02`.

1. Build and test the exact R5.1 commit without changing the running release.
2. Stop this project's API and research worker. Create and verify one paired project-recovery
   generation from schema 12, then restore it into a new marked PostgreSQL database and a separate
   absent/empty runtime directory. Complete the isolated drill before cutover.
3. Keep the worker stopped. Point only the API launcher and `FRONTEND_DIST_DIR` at the same protected
   candidate generation, start the API and let its advisory-locked migration apply schema 13.
4. Verify login, owner isolation, `/api/ready`, admin migration evidence and the exact checksum.
   Stop and restart the API once; the second startup must be a migration no-op.
5. Start the matching research worker only after the API checks pass. Verify its heartbeat, bounded
   alert-lane metrics and one owner-scoped in-app alert without adding an exchange credential.
6. Create and verify a post-upgrade paired generation and repeat the isolated restore check before
   accepting the release.

Do not downgrade the active database, decrement `schema_migrations`, delete schema-13 tables or
remove immutable alert rows to recover. If rollback is selected, stop both processes, restore the
pre-upgrade pair into **new** replacement resources, verify them, and point only the stopped project
services at that pair plus the protected R4 release. Preserve the failed schema-13 database as
incident evidence. Full details are in [Migration notes](./MIGRATIONS.md) and
[Backup and restore](./BACKUP_RESTORE.md).

This procedure does not add TLS. Until a separate HTTPS release is implemented and reviewed, keep
login and alert traffic on loopback, a trusted VPN/private network or an SSH tunnel. Never expose
account passwords or session cookies over public HTTP, and never add exchange keys for alerts.

## Updating a fork

1. Create and verify one paired PostgreSQL + SQLite recovery generation. For R4, use
   the [schema-12/schema-9 checklist](./BACKUP_RESTORE.md).
2. Pull or merge the desired commit.
3. Run `npm ci`, tests and `npm run build` (or rebuild the Compose image).
4. Stop only this project's API/worker for cutover, then start one API instance; migrations run
   automatically. When first crossing trading schema v6, follow the legacy-owner procedure above;
   when crossing PostgreSQL schema 13, follow the API-first R5.1 procedure above.
   Never run an older binary after PostgreSQL 12 or SQLite 9 has been applied.
5. Check `/api/ready`, pending jobs, per-user account visibility, current robots and the
   `public-http-paper` runtime state. For R4 also check the paper executor, migrated portfolio list
   and one same-key idempotent retry before starting the matching research worker.

Never start a second copy of the current trading backend against the same `trading.db`: both copies
could restore the same bot. Horizontal API replicas become safe only after the trading executor and
event fan-out are separated.
