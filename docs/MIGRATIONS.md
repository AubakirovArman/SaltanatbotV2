# Migration notes

SaltanatbotV2 uses forward-only runtime migrations and versioned portable browser artifacts. Back up
runtime data before upgrading and never open a database with an older application after a forward
migration.

## Unreleased R4 candidate / PostgreSQL schema 12 and trading SQLite schema 9

- PostgreSQL schema v5 adds a monotonic `users.authorization_revision`. Every status, role,
  temporary-password or password mutation advances it; login timestamps do not. It is a durable
  execution-permit fence and contains no secret data.
- PostgreSQL schema v6 adds partial terminal-job indexes used by bounded 24-hour queue metrics. The
  metrics sample at most 10,000 recent terminal jobs instead of sorting the full lifetime history.
- PostgreSQL schema v7 adds a durable owner-scoped at-most-once dispatch/replay ledger. `intentId` is the stable unique
  identity of one signed step; entry, stop-loss and take-profit steps use different IDs while
  `operationId` groups them. A compact `(owner, intent, binding)` key is retained for the lifetime of
  the owner, so pruning cannot make an old step executable again. Ordinary work fails closed at
  240,000 keys per owner; reconciliation has the next 8,000-key/24-active tier, and emergency has a
  final isolated 2,000-key/8-active tier that reconciliation cannot consume. Reservation/status/
  revision details are retained for 30 days and at most 10,000 terminal rows per owner. Read-only
  telemetry is outside this mutation ledger. The schema stores no signed request payloads,
  credentials, signatures, sessions or permit tokens.
- PostgreSQL schema v8 adds exact per-owner research-artifact byte/count counters and bounded
  compaction metadata. Queued/running jobs are never compacted. Full terminal payload/result JSON
  is retained until the first of 30 days, 200 jobs or 256 MiB per owner; at most 50 rows change per
  pass under the enqueue advisory lock. A compact tombstone preserves exact-request idempotency and
  returns HTTP 410 for at most 90 days and 1,000 tombstones per owner. Content-only dedupe may run
  again after compaction; conflicting reuse of the same request ID remains HTTP 409.
- PostgreSQL schema v9 adds the administrator identity control plane: pending/active/disabled user
  lifecycle, application and trading roles, authorization revisions, temporary-password state,
  session revocation metadata and atomic administrator audit records. Retained non-administrator
  live roles are downgraded to paper and cannot be granted again in the pre-HTTPS release.
- PostgreSQL schema v10 adds reversible workspace archive metadata plus exact current/revision
  payload-byte counters. Trigger-maintained counters and owner/archive/revision indexes support
  count and retained-byte quotas without deleting existing data. After backfill, an explicit
  preflight fails closed if a legacy `jsonb::text` payload exceeds the 4 MiB-minus-64 KiB
  bounded-response payload allowance; current and revision tables retain that limit as CHECK
  constraints. Repair or export an oversized legacy row before retrying v10. The migration is
  transactional, but the chain remains forward-only: rollback means restoring the verified
  schema-v9 dump into a new replacement database, never dropping v10 objects or migration history
  in place. See [Workspace schema v10 upgrade and rollback](BACKUP_RESTORE.md#workspace-schema-v10-upgrade-and-rollback).
- PostgreSQL schema v11 adds `user_onboarding` and `runtime_component_heartbeats`. Onboarding is
  owner-keyed with optimistic revisions, one finite goal, first-use milestone timestamps and
  mutually exclusive completed/dismissed terminal state. Existing users are inserted as dismissed
  in the same transaction, while users created after the migration initially receive a virtual
  revision-0 `not_started` state until their first mutation. The heartbeat table currently accepts
  only the `research-worker` component and binds its generation, lifecycle state, release commit
  and database schema version to one current row. An onboarding row cascades when its owner is
  deleted; heartbeat startup replaces only that component's singleton row. Neither table stores
  credentials, sessions, strategies or exchange payloads.
- PostgreSQL schema v12 adds `executor_commands`, the durable bridge from an authenticated
  multi-user control plane to the singleton SQLite trading executor. A row binds the owner, actor,
  session hash, authorization revision/epoch, command/target, idempotency key, request hash and a
  bounded non-secret JSON payload. States are `queued`, `applying`, `applied` and `rejected`.
  Renewable lease token/generation fencing rejects stale acknowledgements; a partial unique index
  permits at most one applying command per owner. The default repository limits an owner to 256
  active rows and retains terminal rows for the first of 90 days or 10,000 rows, pruned in bounded
  batches. Payload/result/error bounds are 32 KiB, 16 KiB and 4,000 characters. The schema stores
  neither exchange credentials nor raw browser session tokens.
- Trading SQLite schema v8 adds monotonic account and credential revisions plus a per-owner
  arm/disarm epoch. Migration always starts every owner disarmed and removes legacy boolean arm
  settings; it never deletes accounts, credentials, bots or journals.
- Trading SQLite schema v9 adds owner-scoped paper portfolios and monotonic ledger epochs; fixed
  USDT-micros capital reservations; durable mutation receipts; immutable bot-revision evidence and
  deletion tombstones; durable valuation marks; append-only portfolio events; and versioned
  projection metadata. The `paper_events` key is rebuilt around `(botId, ledgerEpoch, sequence)` and
  rejects both update and delete. Each pre-v9 paper bot is backfilled into its own deterministic
  epoch-1 portfolio. Existing event ledgers are preserved. A snapshot/formula-only bot receives a
  deterministic initialization ledger and `legacy-incomplete` evidence instead of an invented
  complete history. The whole SQLite migration remains one transaction and rolls back on malformed
  legacy evidence or an ownership/identity conflict. Legacy token-mode deletion remains usable
  after the upgrade by atomically releasing only an exact flat, zero-open-order allocation before
  retaining its tombstone and journal; database-auth deletion still requires the fenced canonical
  workflow.

- Trading SQLite state is upgraded transactionally through ordered `schema_migrations`; a database
  declaring a newer unsupported version is rejected without mutation.
- Trading schema v2 adds durable `positions` and `strategy_runs` to the existing `orders`,
  `order_events` and `fills`. Bot status transitions maintain one active logical run, while runtime
  persistence updates the latest position/manual-action snapshot.
- Trading schema v3 adds `arbitrage_history` keyed by route and sample time, with route/time and
  retention indexes. The read-only recorder stores at most 50 ranked routes once per minute while
  its shared feed is active and prunes samples older than seven days. It contains public research
  observations, not orders, fills, account state or raw-tick provenance.
- Trading schema v4 adds `paper_events`, the append-only event source for paper accounts. Events are
  ordered by a per-bot contiguous sequence and may carry a unique idempotency key. SQLite rejects
  updates; explicit bot deletion may remove that bot's ledger. Startup replays the ledger first. If a
  bot has no events yet, its legacy `paper:<botId>` snapshot is imported once as initialization,
  cash/position/order/settings events and then persisted. Compatibility snapshots may continue to be
  written during this transition, but they are no longer authoritative after a ledger exists.
- Persistent server arbitrage alert rules migrate lazily from the v1 rule setting into one atomic v2
  state setting containing rules, per-opportunity crossing state and the durable delivery outbox.
  Pending and expired leased deliveries survive restart; terminal delivery history is bounded.
  Browser fee profiles, alert preferences and capped paper positions remain localStorage records;
  they are not migrated into the trading database and are not restored by a server-only database
  backup.
- Strategy/indicator artifacts stored in the browser migrate from implicit schema 1 to schema 2 by
  adding semantic version, bounded immutable history, parameters, dependencies and provenance.
- Legacy `.strategy` envelope v1 can be imported through an explicit unverified migration path. New
  exports are checksum-verified schema-v2 envelopes; import never silently downgrades them.
- Portable workspace exports currently carry the exact schema-v8 workspace document under a
  SHA-256-protected envelope. Schema v8 retains layout, per-pane market/timeframe/chart type and
  timezone, link settings, full indicators, comparisons, drawings, panels, mode and an exact
  strategy artifact revision/hash/parameter binding. Schema v7 is the only accepted portable legacy
  payload and is validated strictly before hydration to v8.
- Older schema 1–6 named workspaces remain eligible only for bounded browser-local normalization
  during one-time owner migration; they are not accepted as portable imports. Automatic chart
  sessions remain separately versioned. Unknown time zones fail closed to UTC, and normalization
  never rewrites candle timestamps, session membership or strategy artifacts.

The project recovery format inventories the complete contiguous PostgreSQL migration chain,
including the schema-v12 checksum, together with checksummed SQLite runtime files, their
`user_version` and bounded owner/count evidence. Verification is read-only. The R4 candidate
inventory now includes the PostgreSQL executor-command table and every schema-9 SQLite
paper-portfolio table in addition to the complete database archives. Restore always creates a
separately named PostgreSQL replacement database and a separate absent/empty runtime directory; it
does not change a service, Compose configuration, `PGDATABASE` or the active data path. The drill
performs the same restore and removes only the marker/OID-bound temporary database and the verified
tool-owned directory. R4 acceptance still requires that real isolated paired drill for the exact
candidate. This is replacement evidence, not an in-place down-migration or automatic cutover.

For server data, follow [Backup and restore](BACKUP_RESTORE.md) before deployment. A breaking future
IR, API, storage or event-trace change must add a dated section here and executable backward-compatibility
coverage in the same change.

The R4 chain is not an in-place two-store transaction. Take and verify one paired recovery
generation before the first schema-12/schema-9 start. If one store advances and startup then fails,
keep the application stopped and restore the complete verified pair into replacement resources;
never run an older binary against either advanced store or remove migration/ledger rows by hand.
See [Canonical paper portfolios](PAPER_PORTFOLIOS.md#upgrade-to-postgresql-12-and-sqlite-9) for the
operator sequence.
