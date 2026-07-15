# Migration notes

SaltanatbotV2 uses forward-only runtime migrations and versioned portable browser artifacts. Back up
runtime data before upgrading and never open a database with an older application after a forward
migration.

## Unreleased / schema baseline 4

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
