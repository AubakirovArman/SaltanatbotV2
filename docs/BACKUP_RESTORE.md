# Runtime backup and restore

Audience: self-hosted operators
Last verified: 2026-07-11

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

All copied files and the manifest are written with owner-only `0600` permissions; the backup
directory is created as `0700`.

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
`PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD_FILE` used by the service. Verify it without changing
the live database:

```bash
pg_restore --list ../saltanat-backups/2026-07-15.postgres.dump >/dev/null
```

Keep the PostgreSQL dump and SQLite backup generation together. They are not a transaction across
both engines, so record the time and stop all research/job mutations when an exact coordinated
recovery point is required. Live trading must remain disarmed during a full recovery.

For a non-default Docker volume mount or a recovery drill, specify the source explicitly:

```bash
npm run data:backup -- --data-dir /srv/saltanat/data --output /srv/backups/saltanat-001
```

If `PAPER_MULTI_LEG_DB_PATH` points outside that data directory, the backup command cannot discover
it; include that custom SQLite file in a separate trusted online-backup policy. In Compose, such a
path also needs an explicit persistent volume/bind mount; otherwise container recreation deletes it.

## Verify a backup

Verification detects missing/unmanifested files, symlinks, size/checksum changes, unsupported format
versions and SQLite corruption.

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
5. Keep live trading disarmed until reconciliation and exchange state have been checked.

```bash
npm run data:verify -- ../saltanat-backups/2026-07-11
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

Example PostgreSQL restore into a prepared empty database:

```bash
pg_restore --exit-on-error --clean --if-exists \
  --host 127.0.0.1 --port 55434 --username saltanatbotv2 \
  --dbname saltanatbotv2 ../saltanat-backups/2026-07-15.postgres.dump
```

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
