# Runtime backup and restore

Audience: self-hosted operators
Last verified: 2026-07-16

SaltanatbotV2 uses two independent persistence layers. PostgreSQL stores users, hashed passwords,
sessions, workspaces and research jobs. Trading state and encrypted credentials remain under
`backend/data/`. A complete recovery point needs a PostgreSQL dump plus an SQLite runtime backup;
`trading.db` and `.secret` must always stay together. The optional candle cache (`candles.db`) and
bounded multi-leg paper journal (`arbitrage-paper-multi-leg.sqlite`) are included at default paths.

> A runtime backup contains sensitive material. The database stores exchange credentials encrypted,
> but `.secret` is the root needed to decrypt them. Protect the backup as if it contained plaintext
> credentials. Never commit it, upload it to an untrusted cloud, or send it to a bug report.

## Create an online backup

The application may remain running while creating a backup. SQLite databases are copied through the
online backup API rather than with a raw filesystem copy, then checked with `PRAGMA quick_check`.

```bash
npm run data:backup -- --output ../saltanat-backups/2026-07-11
```

The output directory must not already exist and must be outside `backend/data/`. It contains:

- `trading.db` (required);
- `candles.db` (when present);
- `arbitrage-paper-multi-leg.sqlite` (when present at the default data path);
- `.secret`;
- `backup-manifest.json` with format version, sizes and SHA-256 checksums.

Database entries also record SQLite `user_version`, allowing verification to detect unexpected
schema-version drift in addition to byte-level changes.

Before backup or recovery work, an operator can obtain a count-only inventory. It opens
`trading.db` read-only, includes committed WAL rows, does not select ciphertext and does not open the
master key:

```bash
npm run data:inventory -- --data-dir backend/data
```

All copied files and the manifest are written with owner-only `0600` permissions; the backup
directory is created as `0700`. Verification rejects a key that is a symlink/non-file, is not owned
by the backup directory owner, or has permissions other than `0600`/read-only `0400`.

`.trading-runtime-lock.sqlite` is process-coordination metadata only. It contains no user data, is
never copied into a backup, produces no retained WAL/journal sidecars, and is safely recreated after
a directory-swap restore. An in-place restore preserves it as an unrelated owner-only file; the API
must be stopped, so no process may hold the lock during restore.

An old `.authtoken` remains accepted when verifying/restoring a pre-account-auth backup, but new
backups no longer copy it. Delete the retired file after confirming database account login works.

### Docker Compose named volume

The Compose deployment keeps `backend/data` in the `saltanat-data` named volume, not in the source
checkout. Run the backup utility inside the application container, then copy the already verified
directory to trusted host storage:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p ../saltanat-backups
docker compose exec saltanatbotv2 \
  npm run data:backup -- --output "/tmp/$STAMP"
docker compose cp \
  "saltanatbotv2:/tmp/$STAMP" "../saltanat-backups/$STAMP"
```

The backup command verifies the archive before it returns. To verify the host copy through the same
runtime image without mounting the live data volume as a source, run:

```bash
BACKUP_DIR="$(realpath "../saltanat-backups/$STAMP")"
docker compose run --rm --no-deps --user root \
  -v "$BACKUP_DIR:/restore:ro" \
  saltanatbotv2 node scripts/runtime-data.mjs verify /restore
```

For a Compose restore, stop both data-using services and restore through a one-off container that
has the same named volume. The final `chown` returns the restored files to the unprivileged runtime
user:

```bash
docker compose stop saltanatbotv2 research-worker
BACKUP_DIR="$(realpath ../saltanat-backups/2026-07-15T120000Z)"
docker compose run --rm --no-deps --user root \
  -v "$BACKUP_DIR:/restore:ro" \
  saltanatbotv2 sh -lc \
  'node scripts/runtime-data.mjs verify /restore &&
   node scripts/runtime-data.mjs restore /restore --data-dir /app/backend/data --force --in-place &&
   for file in trading.db candles.db arbitrage-paper-multi-leg.sqlite .secret .authtoken .restore-manifest.json; do
     [ ! -e "/app/backend/data/$file" ] || chown node:node "/app/backend/data/$file";
   done'
docker compose up -d saltanatbotv2 research-worker
```

Restore PostgreSQL from its matching dump before starting the services. Do not use raw `docker cp`
against live SQLite files; the online backup API is what makes the runtime archive consistent.
`--in-place` is required for the named-volume mountpoint: it verifies and stages the replacement
inside that volume, publishes only the allowlisted runtime files, preserves unrelated files, and
rolls the previous generation back if publication or post-restore verification fails.

## Back up PostgreSQL

Create a custom-format dump near the SQLite backup. For Compose:

```bash
umask 077
docker compose exec -T postgres \
  pg_dump -U saltanatbotv2 -d saltanatbotv2 --format=custom \
  > ../saltanat-backups/2026-07-15.postgres.dump
```

For a direct installation, run the matching `pg_dump` major version with the same `PGHOST`,
`PGPORT`, `PGDATABASE` and `PGUSER` used by the service. `PGPASSWORD_FILE` is understood only by
SaltanatbotV2; libpq tools do not read that raw-password format. Let the tool prompt securely, use
an owner-only libpq `PGPASSFILE`, or provide credentials through another reviewed libpq mechanism.
Verify the dump without changing the live database:

```bash
pg_restore --list ../saltanat-backups/2026-07-15.postgres.dump >/dev/null
```

Keep the PostgreSQL dump and SQLite backup generation together. They are not a transaction across
both engines, so record the time and stop all research/job mutations when an exact coordinated
recovery point is required. Live trading must remain disarmed during a full recovery.

### Workspace schema v10 upgrade and rollback

Database migration v10 is additive: it adds archive metadata, exact payload-byte accounting,
bounded-workspace indexes and payload-byte maintenance triggers. Existing workspace JSON and
revision rows are retained and backfilled. A preflight aborts the transaction if an existing
`jsonb::text` payload exceeds 4 MiB minus the 64 KiB response-envelope reserve; inspect and repair
that legacy row before retrying instead of deploying a workspace that bounded pages cannot read.
Take and verify the PostgreSQL custom-format dump before starting the first v10 API process;
startup applies the migration atomically.

If the project units were deliberately pinned to a schema-v9 safety launcher during review, keep
both units stopped after the backup, switch both effective `ExecStart` values to the verified
schema-v10 candidate launcher, run `systemctl --user daemon-reload`, and confirm the resolved
commands with `systemctl --user show ... -p ExecStart` before starting anything. Start only the API,
verify schema 10 plus health/readiness/auth/workspaces, and start the research worker afterward.
Leaving the v9 safety override active would republish v9 code and prevent the intended cutover.

The candidate API launcher must also export `FRONTEND_DIST_DIR` as the normalized absolute
`frontend/dist` inside that same protected candidate release. Do not rely on the repository default
or a moving symlink during a production cutover: a later local frontend build could otherwise
replace the UI independently of the reviewed backend. Startup validates the release shell and
module entry files before the listener opens. Record the exact backend command, frontend directory
and release checksum together in the cutover evidence.

The migration chain is forward-only. An older v9 binary correctly refuses a database whose schema
history already contains v10. Do not drop v10 columns, triggers or migration history in place.
Rollback means stopping this project's API and worker, restoring the matching pre-upgrade dump into
a new replacement database, verifying it, then changing only this project's `PGDATABASE` during
the stopped-service cutover. Switch both the backend launcher and `FRONTEND_DIST_DIR` to the same
verified rollback release generation before starting the API. Workspaces created after that dump
are not present in the replacement; export any required workspace files before the rollback window
closes.

Permanent workspace purge is deliberately owner-scoped and archived-only, but it deletes that
workspace and cascades its retained revisions. Recovery after a successful purge requires a
PostgreSQL backup; ordinary archive remains reversible.

For a non-default Docker volume mount or a recovery drill, specify the source explicitly:

```bash
npm run data:backup -- --data-dir /srv/saltanat/data --output /srv/backups/saltanat-001
```

If `PAPER_MULTI_LEG_DB_PATH` points outside that data directory, the backup command cannot discover
it; include that custom SQLite file in a separate trusted online-backup policy. In Compose, such a
path also needs an explicit persistent volume/bind mount; otherwise container recreation deletes it.

## Verify a backup

Verification detects missing/unmanifested files, symlinks, size/checksum changes, unsupported format
versions and SQLite corruption. Every `trading.db`, including an empty one, requires `.secret`.
Verification derives the key in memory and authenticates every encrypted setting/account credential;
a well-formed but unrelated key is rejected. Neither the key, ciphertext nor plaintext is printed.

```bash
npm run data:verify -- ../saltanat-backups/2026-07-11
```

Run verification immediately after copying a backup to another disk and before deleting an older
known-good snapshot.

## Restore

1. Stop the API and research worker. Restore must never run against an active server.
2. Verify both the PostgreSQL dump and SQLite backup.
3. Restore PostgreSQL into an empty replacement database, then restore the SQLite directory with the
   explicit replacement flag.
4. Start one API instance in paper mode and inspect users, workspaces, jobs, bots and journals.
5. Confirm the restored server reports `public-http-paper`. This release has no live reactivation
   step; dormant encrypted exchange state remains preserved but unreachable.

```bash
npm run data:verify -- ../saltanat-backups/2026-07-11
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

Example PostgreSQL restore into a newly created empty replacement database:

```bash
createdb --host 127.0.0.1 --port 55434 --username postgres \
  --owner saltanatbotv2 saltanatbotv2_restore_20260715
pg_restore --exit-on-error --no-owner --no-privileges \
  --host 127.0.0.1 --port 55434 --username saltanatbotv2 \
  --dbname saltanatbotv2_restore_20260715 \
  ../saltanat-backups/2026-07-15.postgres.dump
```

Use the project PostgreSQL operator role appropriate to your installation for `createdb`; it may
have a different name than `postgres`. Never add `--clean` to this recovery path and never target
the current `saltanatbotv2` database. Verify the replacement first, then change only this project's
`PGDATABASE` setting during a stopped-service cutover. Retain the original database for rollback
until the recovery has passed its acceptance window.

Restore validates the complete backup before touching the target, builds a verified staging
directory, atomically swaps it into place and rolls back the previous directory if the swap fails.
Without `--force`, a non-empty runtime directory is never overwritten. A `.restore-manifest.json`
record remains in the restored directory for local provenance.

To rehearse recovery without touching real state:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

## Recovery policy

- Keep at least two verified generations on separate trusted storage.
- Take a backup before upgrading, changing deployment paths or modifying credentials.
- Test restore periodically into an isolated directory or host.
- Backups are not encrypted by this tool. Use trusted encrypted storage at the filesystem/device
  layer and keep its recovery key separate.
- Restoring local state does not prove the current exchange state. Orders and positions must still
  be reconciled after startup.
