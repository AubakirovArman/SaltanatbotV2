# Migration notes

SaltanatbotV2 uses forward-only runtime migrations and versioned portable browser artifacts. Back up
runtime data before upgrading and never open a database with an older application after a forward
migration.

## Unreleased / PostgreSQL schema 8 and trading SQLite schema 8

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
- Trading SQLite schema v8 adds monotonic account and credential revisions plus a per-owner
  arm/disarm epoch. Migration always starts every owner disarmed and removes legacy boolean arm
  settings; it never deletes accounts, credentials, bots or journals.

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
- Chart workspace exports use schema 3 with SHA-256 verification, bounded revisions and a persisted
  visible-time-range link flag. Existing schema-1/2 local workspaces default that link on during
  boundary normalization and remain preserved by ID.
- Named chart workspaces now normalize to schema 7 and automatic chart sessions to version 5 so every
  pane carries a validated display time zone. Existing schema 1–6 workspaces and session versions 1–4
  retain browser-local labels; new panes default to exchange UTC. Unknown zones fail closed to UTC and
  no migration rewrites candle timestamps, session membership or strategy data.

For server data, follow [Backup and restore](BACKUP_RESTORE.md) before deployment. A breaking future
IR, API, storage or event-trace change must add a dated section here and executable backward-compatibility
coverage in the same change.
