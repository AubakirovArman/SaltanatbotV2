# Runtime backup and restore

Audience: self-hosted operators
Last verified for accepted R4 deployment: 2026-07-17

Accepted R4 recovery evidence is bound to commit
`bb455facdfe5a1b3cabe15490c86c299ea684ee7`, GitHub Actions run `29560112312` (6/6 required jobs
successful), protected slot `r4c-schema12-bb455fa`, PostgreSQL schema 12 and trading SQLite schema
9. The paired pre-cutover backup, verify, isolated replacement restore/drill, post-migration backup
and rollback proof passed. Self-hosted operators must repeat these gates for their own exact build;
this evidence does not make a different installation recoverable.

R5.1 followed as an accepted and deployed recovery baseline. Production moved to PostgreSQL schema
13 from protected slot `r5a-schema13-66394fd` at commit `66394fd38765d8da36174411cecd95a33fda1ea0`.
Schema-13 alert inventory and restore coverage were proved for that exact release before cutover
([R5.1 evidence](./evidence/R5_1_OWNER_ALERTS.md)); it does not inherit the immutable R4 evidence
above. See [Owner-scoped server alerts](./ALERTS.md).

R5.2.1 is now the accepted and deployed recovery baseline. Production runs PostgreSQL schema 14 and
unchanged trading SQLite schema 9 from protected slot `r5b-schema14-20be5b1` at commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831`. The pre-upgrade schema-13 generation `281b88c8` and the
post-upgrade schema-14 generation `b18d3380` each passed a verified isolated replacement restore
drill for that exact release; the stopped rollback source `bee7eced` and the replacement-only
rollback pair are retained ([R5.2.1 evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md)). This
baseline does not inherit the immutable R4 or R5.1 evidence above. See
[On-demand technical screener](./SCREENER.md).

SaltanatbotV2 uses two independent persistence layers. PostgreSQL stores users, hashed passwords,
sessions, workspaces and research jobs. Trading state and encrypted credentials remain under
`backend/data/`. A complete recovery point needs a PostgreSQL dump plus an SQLite runtime backup;
`trading.db` and `.secret` must always stay together. The optional candle cache (`candles.db`) and
bounded multi-leg paper journal (`arbitrage-paper-multi-leg.sqlite`) are included at default paths.

> A runtime backup contains sensitive material. The database stores exchange credentials encrypted,
> but `.secret` is the root needed to decrypt them. Protect the backup as if it contained plaintext
> credentials. Never commit it, upload it to an untrusted cloud, or send it to a bug report.

## Preferred paired project recovery

Use the project recovery commands for a complete PostgreSQL + SQLite generation. They are the O1
recovery boundary; the lower-level `data:*` commands later in this document remain useful for
diagnostics and old named-volume procedures, but they do not create a paired recovery point.
This implementation accepts only the current `public-http-paper` release profile.

The backup command holds one read-only exported PostgreSQL snapshot through both `pg_dump` and the
online SQLite backup. The schema/count inventory and dump therefore share one PostgreSQL snapshot,
and every SQLite `ownerUserId` must exist in that same snapshot before publication. The complete
capture window must be no more than five minutes.

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 \
  /opt/saltanatbotv2-backups \
  /opt/saltanatbotv2/operations
sudo -u saltanatbotv2 -H -s
cd /opt/saltanatbotv2
umask 077
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
npm run recovery:backup -- \
  --output "/opt/saltanatbotv2-backups/$STAMP" \
  --data-dir "/opt/saltanatbotv2/backend/data"

RECOVERY_STATUS_FILE="/opt/saltanatbotv2/operations/recovery-status.json"
npm run recovery:verify -- "/opt/saltanatbotv2-backups/$STAMP" \
  --status-file "$RECOVERY_STATUS_FILE"
exit
```

Provision the two parent directories as root, but run both recovery commands from the shown
unprivileged `saltanatbotv2` shell. The output parent must already exist, be owned by that recovery
operator, have no group/world write bits and contain no symbolic-link path components. The
generation name itself must not exist.

The generation contains exactly:

- `postgres.dump`;
- `runtime/`, using the existing verified SQLite backup format;
- `recovery-manifest.json`, with SHA-256 checksums, capture timestamps, PostgreSQL migrations and
  aggregate PostgreSQL/SQLite counts.

For a schema-13 generation, the PostgreSQL inventory also includes counts for all ten alert tables:
rules, revisions, state, evaluation receipts, per-owner event counters, events, bindings, outbox,
deliveries and import receipts. Verification must reject a missing/present table set inconsistent
with the recorded schema version. Capturing those counts makes restore drift detectable; it does
not by itself accept R5.1 for production.

The generation directory is owner-only. Verification rejects extra files, symbolic links, changed
sizes/checksums, a corrupt PostgreSQL archive, an invalid SQLite backup, mismatched owner inventory
or a capture span above five minutes.

`--status-file` is optional and must be a normalized absolute path in an operator-owned,
non-group/world-writable directory. Only after the complete verification succeeds, the CLI
appends a newline-committed record to a bounded `0600` JSON receipt journal containing the receipt version, generation ID,
verification timestamp, release commit, schema version, capture span and the generation directory
basename. It contains no full path, database name or owner. A failed verification never creates or
replaces the receipt. Configure the API with the same path through
`OPERATIONS_RECOVERY_STATUS_FILE` and run verification as the same unprivileged operating-system
account as the API so the owner and trusted-parent checks agree. The example systemd unit reads this
exact `/opt/saltanatbotv2/operations/recovery-status.json` path and refuses to start unless the
operations directory is a real directory owned by the service user and group. The journal itself is
created exclusively as an owner-only file, kept open through a pinned descriptor, and accepted only
after its exact identity and bytes are durable. It must have exactly one hard link (`nlink=1`); any
hard-linked alias fails closed. An interrupted append is not repaired concurrently: the last
newline-committed receipt remains readable. After stopping every recovery writer, the operator may
inspect and truncate only the proven incomplete tail before the next publication; the permanent
lock file stays untouched. Invalid or missing evidence remains `null` in admin metrics and does not
affect `/api/ready`.

Writers serialize the complete inspect/append/file-fsync/directory-fsync/final-validation boundary
through a permanent empty `.recovery-status.lock`. That file must remain owned by
`saltanatbotv2`, mode `0600`, a regular non-symlink with `nlink=1`, in the same operations directory.
The writer opens and pins it with `O_NOFOLLOW`, validates root-owned non-writable
`/usr/bin/flock`, and retains an exclusive kernel lock until publication finishes. Install the
`util-linux` package if `/usr/bin/flock` is absent. Never unlink, rename, copy or hard-link the lock
file during repair or rotation. A crash releases the kernel lock automatically; the permanent inode
must remain in place, so there is no stale lock file to remove.

An interruption between the exclusive creation of the first journal and its durable complete
newline may instead leave an empty or partial single-link file. That is not an append tail: both the
writer and API reject it, and truncating it to zero does not repair it. Stop all recovery writers,
inspect the configured path, and require a regular non-symlink file owned by `saltanatbotv2`, mode
`0600`, with `nlink=1` under the exact trusted operations directory. Rename that exact file into an
owner-only quarantine directory on the same filesystem; do not blindly unlink, overwrite or copy
it, and leave `.recovery-status.lock` untouched. With the configured path absent, rerun the full
`recovery:verify -- --status-file` command and
confirm the new receipt and admin metric. If any identity or permission check is uncertain, leave
the file untouched and investigate.

A completely valid journal can also reach its 1 MiB bound. In that case the locked writer rejects
the next record before writing, while the API continues to expose the latest valid receipt. For a
planned rotation, stop every recovery writer and leave `.recovery-status.lock` untouched. Verify the
configured journal is the exact owner-only, mode-`0600`, `nlink=1` regular file under the trusted
operations directory, then rename that journal—not the lock—into an owner-only quarantine/archive
directory on the same filesystem. With `recovery-status.json` absent, rerun full verification to
create a fresh journal, confirm the admin metric and retain the archived journal according to the
site's backup policy. Never truncate or unlink a full valid journal in place.

> **Upgrade note for the former anchor prototype.** A journal with `nlink=2` and a matching
> `.recovery-status-anchor-*` name is no longer accepted. Stop all recovery writers, verify with
> `stat` that the configured receipt and exactly one anchor are owner-only names for the same inode,
> then rename both names (without copying or unlinking either one) into a separate owner-only
> quarantine directory on the same filesystem. If that identity cannot be proved, leave the files
> untouched and investigate. With the configured path absent, rerun the full
> `recovery:verify -- --status-file` command as `saltanatbotv2`; it creates a fresh single-link
> receipt. Confirm `nlink=1`, owner/group, mode `0600`, and the admin recovery metric before removing
> the quarantined prototype under the site's backup-retention policy.

The source connection is resolved from `RECOVERY_SOURCE_DATABASE_URL`, then `DATABASE_URL`, then
ordinary `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and password settings. The recovery wrapper can
read the application's owner-only `PGPASSWORD_FILE`; the raw `pg_dump`/`pg_restore` tools cannot.
The password path must be absolute and must not contain a symbolic link in any directory component.
Recovery accepts one exact numeric loopback endpoint shared by source and operator with
`sslmode=disable`; proxies, DNS names, remote endpoints and transport-negotiating SSL modes are
rejected. Matching-major raw `pg_dump` and `pg_restore` binaries must resolve to root-owned,
non-writable executables. The only accepted wrapper paths are this repository's bundled adapters,
supplied through `RECOVERY_PG_DUMP_BIN` and `RECOVERY_PG_RESTORE_BIN`.
Child connections receive `PGCONNECT_TIMEOUT=10`. Process deadlines default to five minutes for
`pg_dump`, ten minutes for restore and one minute for archive listing; installations may set
`RECOVERY_PG_DUMP_TIMEOUT_MS`, `RECOVERY_PG_RESTORE_TIMEOUT_MS` and
`RECOVERY_PG_RESTORE_LIST_TIMEOUT_MS` within the validated 50–3,600,000 ms range.

### Matching PostgreSQL tools from this project's Compose image

When the application uses the direct-host layout above but PostgreSQL runs through this project's
Compose service, the repository includes host-only adapters that use `pg_dump`/`pg_restore` from the
exact immutable image digest of that running service. This example still reads direct-host runtime
data from `/opt/saltanatbotv2/backend/data`; a fully containerized deployment stores runtime data in
the `saltanat-data` named volume and must first use the named-volume procedure later in this guide.
Use the adapters only from the real project root and always pass absolute paths:

```bash
cd /opt/saltanatbotv2
STAMP="<existing-generation-stamp>"
export RECOVERY_PG_DUMP_BIN="$PWD/scripts/recovery-pg-dump.mjs"
export RECOVERY_PG_RESTORE_BIN="$PWD/scripts/recovery-pg-restore.mjs"
npm run recovery:backup -- \
  --output "/opt/saltanatbotv2-backups/$STAMP" \
  --data-dir "/opt/saltanatbotv2/backend/data"
```

The adapters fail closed unless all of the following still match:

- root-owned local `/usr/bin/docker` and the local `/var/run/docker.sock`;
- this owner-controlled, non-group/world-writable checkout, its exact `docker-compose.yml`, default directory-derived Compose
  project name and the single healthy `<project>-postgres-1` service container;
- image `postgres:17.10-bookworm`, matching version-17 tools, exact image digest, project named
  volume and one `127.0.0.1:<published-port> -> 5432/tcp` binding;
- the effective `PGHOST`, `PGPORT`, database and application role used by recovery;
- the exact owner-only Compose password-secret bind source discovered from the running project
  container, whether it is inside or outside the checkout, without symlink components.

The adapter never executes a database tool directly in the long-running PostgreSQL container.
Instead it creates a unique, labeled, auto-removed helper from the same image digest, joins only the
exact database container's network namespace, uses a read-only root, drops all capabilities, enables
`no-new-privileges`, applies CPU/memory/PID limits and an internal hard deadline, and accepts only
the argument shapes emitted by this recovery CLI. Dump bytes stream to an exclusive owner-only host
file; restore bytes stream from a verified owner-only host file. The password is compared with the
Compose secret but never appears in Docker arguments, labels or inspectable helper environment.

Recovery core gives each helper a UUID and, after a timeout or signal, invokes identity-bound
cleanup. Cleanup refuses a same-name container with different labels, image/network identity or
secret mount, force-removes only the exact helper, then polls for stable absence longer than the
helper-create window. If cleanup cannot be proven, replacement PostgreSQL resources are retained
instead of racing a drop against a surviving restore. Do not invoke the adapters directly, override
the Compose project name, or repurpose their internal `--cleanup-run` protocol.

This adapter deliberately supports the Compose `POSTGRES_USER` and its reviewed Compose secret.
Install matching host binaries or add a separately reviewed secret boundary before using a distinct
recovery-operator role. It never accepts another Compose project, container, database family,
remote Docker daemon or non-loopback PostgreSQL port.

Restore needs an operator connection that may create a database and set the restored objects to the
application role. Configure `RECOVERY_OPERATOR_DATABASE_URL` pointing at a maintenance database
(normally `postgres`) or use `RECOVERY_OPERATOR_PGHOST`, `RECOVERY_OPERATOR_PGPORT`,
`RECOVERY_OPERATOR_PGUSER` and `RECOVERY_OPERATOR_PGPASSWORD[_FILE]`. Source and operator must still
select the same numeric loopback host/port and explicitly use
`RECOVERY_OPERATOR_PGSSLMODE=disable`.

Before creating a database, restore copies the manifest-bound dump and runtime files through
`O_NOFOLLOW` descriptors into a new owner-only staging generation, verifies that pinned copy, and
uses only the pinned paths. Use a dedicated recovery operator and do not run concurrent privileged
database create/drop/rename operations during recovery. Recovery create/drop operations serialize
cooperating runs with a maintenance-database advisory lock. Marker and database OID are checked
together with the restored inventory in one read-only transaction; PostgreSQL still cannot make
`DROP DATABASE` conditional on an OID, so a hostile or concurrent superuser remains outside the
tool's safety boundary.

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 /opt/saltanatbotv2-replacements
sudo -u saltanatbotv2 -H -s
cd /opt/saltanatbotv2
STAMP="<verified-generation-stamp>"
DBSTAMP="$(date -u +%Y%m%d_%H%M%S)"
npm run recovery:restore -- "/opt/saltanatbotv2-backups/$STAMP" \
  --target-database "saltanatbotv2_restore_$DBSTAMP" \
  --data-dir "/opt/saltanatbotv2-replacements/data-$STAMP" \
  --current-data-dir "/opt/saltanatbotv2/backend/data" \
  --target-owner "saltanatbotv2"
exit
```

The restore command is deliberately stricter than the low-level SQLite restore:

- the PostgreSQL target must not exist and must start with `<source_database>_restore_`;
- the data target parent must already exist, be operator-owned, not group/world writable and
  contain no symbolic-link path components;
- the data target must be absent or an empty owner-only directory owned by the recovery operator;
- the destination is claimed early with an owner-only nonce marker and remains at the same path
  during file publication; a concurrently substituted empty directory is preserved and refused;
- the current database/data directory, non-empty targets and symbolic links are refused;
- the newly created database receives an exact project-recovery ownership marker;
- PostgreSQL migrations/counts and SQLite counts/owner checksum must match the retained manifest;
- a failed restore removes only the exact marked replacement database and restores the data target
  to its original absent/empty state. If SQLite cleanup cannot be proven safe, its paired
  PostgreSQL replacement and pinned recovery input are retained instead of deleting only one half.

Successful restore only leaves verified replacement resources. It never changes systemd, Compose,
`PGDATABASE`, `FRONTEND_DIST_DIR` or the active runtime data path. Perform any later stopped-service
cutover as a separate reviewed operator action and retain the original database for rollback.

Use the drill command for a full disposable restore. It generates a `_drill_` database and temporary
data directory, verifies both, and drops/removes only resources carrying its exact marker:

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 /opt/saltanatbotv2-recovery-drills
sudo -u saltanatbotv2 -H -s
cd /opt/saltanatbotv2
STAMP="<verified-generation-stamp>"
npm run recovery:drill -- "/opt/saltanatbotv2-backups/$STAMP" \
  --temporary-root "/opt/saltanatbotv2-recovery-drills" \
  --current-data-dir "/opt/saltanatbotv2/backend/data"
exit
```

## Low-level SQLite online backup

The application may remain running while creating a backup. SQLite databases are copied through the
online backup API rather than with a raw filesystem copy, then checked with `PRAGMA quick_check`.

```bash
npm run data:backup -- --output ../saltanat-backups/2026-07-11
```

The output directory must not already exist and must be outside `backend/data/`. Its parent must
already exist, be operator-owned, non-group/world-writable and contain no symlink component. It
contains:

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

## Low-level PostgreSQL dump

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

### R4 PostgreSQL schema 12 / trading SQLite schema 9 upgrade and rollback

The accepted R4 release advances both persistence layers. PostgreSQL schema 12 adds the durable fenced
executor-command queue. Trading SQLite schema 9 adds canonical owner-scoped paper portfolios,
ledger epochs, capital reservations, terminal mutation receipts, immutable robot-revision evidence,
valuation marks and append-only portfolio events.

These are two independently transactional forward migrations, not one distributed transaction.
Before the first R4 start, create and verify one paired recovery generation with the workflow at the
top of this guide. Retain the pre-upgrade generation outside the mutable checkout/release tree and
record the exact release commit, database, data directory, Compose project or user units, and
loopback ports. A port or identity collision is a stop condition; do not terminate or reuse the
foreign resource.

For cutover, stop only this project's API and research worker, install the accepted exact release,
then start exactly one API instance. Do not run two executors against the same `trading.db`. Require
readiness to confirm the expected PostgreSQL migration checksum and paper-executor state, then
check login, owner isolation, migrated paper portfolios and one retried mutation with the same
idempotency key. Start the matching research worker only after those checks pass. Take and verify a
new paired generation after the migration.

The schema-12/schema-9 recovery format verifies the complete PostgreSQL
archive/migration chain, records `executorCommands`, and records bounded counts for all nine
canonical SQLite tables: `paper_portfolios`, `paper_portfolio_epochs`, `paper_bot_allocations`,
`paper_valuation_marks`, `paper_portfolio_mutations`, `paper_bot_revision_evidence`,
`paper_bot_tombstones`, `paper_portfolio_events` and `paper_portfolio_projections`. Verification and
replacement restore compare those counts with the manifest together with the checksummed SQLite
files/user versions. Automated inventory/validation coverage is implementation evidence, not
release acceptance. The isolated paired restore/rollback drill passed for the accepted production
release identified at the top of this document. Every future/self-hosted exact build remains
unaccepted for cutover until its own drill passes.

There is no in-place downgrade. An older binary must not open either advanced store. Rollback means
stopping this project's processes, verifying the retained pre-upgrade paired generation again,
restoring both halves into new replacement resources, and separately pointing only this project's
stopped services at the verified replacement database/data directory plus the matching protected
pre-R4 release. Retain the former resources until the rollback evidence and site retention policy
allow removal. Never drop the schema-12 table, delete command/receipt rows, decrement SQLite
`user_version` or splice old/new recovery halves.

If PostgreSQL reaches schema 12 but SQLite migration 9 fails, keep the application stopped. Preserve
the logs and both original stores, perform only read-only diagnosis, and restore the complete
pre-upgrade pair when rollback is chosen. The detailed lifecycle and operator checklist are in
[Canonical paper portfolios](PAPER_PORTFOLIOS.md#upgrade-to-postgresql-12-and-sqlite-9).

### R5.1 PostgreSQL schema 13 backup, cutover and rollback

This procedure was executed and accepted for the exact R5.1 release on 2026-07-17, and was
repeated the same day for the exact R5.2.1 release, whose migration advanced schema 13 to 14;
production now runs schema 14. It remains the required template for any future exact build.
The schema-13 checksum is
`1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02`; the schema-14
(`owner_screener_presets`) checksum is
`0d7f90cadfa230c7b20fcbe03d7432d71add45760c1a3379ee2362e206c102f3`.
The R5.2.1 rehearsal additionally ran an end-to-end screener proof on the isolated replacement
pair — a preset created and a run executed through a compute job against live Binance closed
candles, 30/30 symbols evaluated, 30 matched, 0 unavailable
([R5.2.1 evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md)).

Before cutover, stop this project's API and research worker and run the paired
`recovery:backup`/`recovery:verify` workflow at the top of this guide. Retain that schema-12
generation outside the mutable checkout. Restore it with `recovery:restore` or `recovery:drill`
into a new marker/OID-bound database name and a separate absent/empty runtime directory. Verify the
complete schema-12 migration chain, SQLite generation, row counts and owner-set digest. A restore
that targets the active database/data directory, uses `--clean`, reuses an unrelated database or
changes live service configuration is invalid.

For cutover, keep the worker stopped and start only the API from one protected candidate generation,
with `FRONTEND_DIST_DIR` from that same generation. The API applies schema 13 atomically under the
migration advisory lock. Verify the exact checksum, login/owner isolation, alert routes, readiness
and admin migration evidence; then stop and restart the API and require a migration no-op. Start the
matching research worker only after that proof. Verify its heartbeat and bounded public-REST alert
lane, create no exchange credential, and take a post-upgrade paired generation. Restore the
post-upgrade generation into another isolated replacement and verify all ten alert-table counts
before accepting R5.1.

Rollback is replacement-only. Stop both processes, re-verify the retained pre-upgrade generation,
restore PostgreSQL and runtime data into **new** replacement resources, and point only this project's
stopped services at those resources plus the protected R4 release. Keep the failed schema-13
database intact for diagnosis. Never drop alert tables/triggers/indexes, delete immutable
receipt/event history, splice pre/post-upgrade halves or decrement the migration version.

Backup and migration do not add transport encryption. During this pre-HTTPS phase, run the service
only on loopback, a trusted private network/VPN or an SSH tunnel; never transmit an account password
or session cookie over public HTTP. Alert evaluation uses public market REST and needs no exchange
key. See [Migration notes](./MIGRATIONS.md#accepted-r51-release-postgresql-schema-13).

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

## Low-level/manual restore

The paired `recovery:restore` workflow above is preferred. The commands below document the
individual building blocks and compatibility path for old generations.

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
directory, publishes only verified files and rolls back the previous files if publication fails.
Without `--force`, a non-empty runtime directory is never overwritten. Even with `--force`, direct
restore replaces only the known flat runtime-file allowlist and refuses an unmanaged entry instead
of recursively deleting it. A `.restore-manifest.json` record remains in the restored directory for
local provenance. The target parent must already exist, be operator-owned,
non-group/world-writable and contain no symlink component.

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
