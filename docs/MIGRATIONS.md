# Migration notes

SaltanatbotV2 uses forward-only runtime migrations and versioned portable browser artifacts. Back up
runtime data before upgrading and never open a database with an older application after a forward
migration.

## Accepted R6 DCA paper robot release: no migration

The R6 shared paper execution contract and DCA robot release was accepted and deployed on
2026-07-18 from commit `e2411ab2f0b4540200089af8128304f71d3f73e0` after GitHub Actions run
`29633743310` completed all 6 required jobs successfully. It added no runtime migration:
PostgreSQL stays at schema 16 and the trading SQLite at schema 9. The paper fill behavior is
versioned — `single-position-v1` stays the byte-compatible default and the DCA-only
`averaging-v1` behavior is additive — and the cutover verified that every pre-R6 paper ledger
replays byte-identically. Production now runs protected slot `r6a-schema16-e2411ab`,
superseding `r5f-schema16-2ff6101` below. Paired recovery generations `440523a6` (pre-cutover)
and `65bb4359` (post-cutover, isolated drill passed) were verified
([R6 DCA paper robot evidence](./evidence/R6_DCA_PAPER_ROBOT.md)). Nothing in this note
replaces the accepted schema-16 migration record below.

## Accepted R5 chart research tools release: no migration

The R5 chart research tools release was accepted and deployed on 2026-07-18 from commit
`2ff6101b950b42a77c378233dabecf1a5ee76ce7` after GitHub Actions run `29629886774` completed all
6 required jobs successfully. It added no runtime migration: PostgreSQL stays at schema 16 and
the trading SQLite at schema 9, and the cutover restart verified a byte-identical migration
ledger. Production now runs protected slot `r5f-schema16-2ff6101`, superseding
`r5e-schema16-17e12f1` below; the browser workspace document gained additive schema v9 (v7/v8
documents stay valid unchanged, versions above 9 stay rejected). Paired recovery generations
`7a734401` (pre-cutover) and `83c4b37e` (post-cutover, isolated drill passed) were verified
([R5 chart research tools evidence](./evidence/R5_CHART_RESEARCH_TOOLS.md)). This release
completed R5. Nothing in this note replaces the accepted schema-16 migration record below.

## Accepted R5.3b-2 release: PostgreSQL schema 16

R5.3b-2 was accepted and deployed on 2026-07-18 from commit
`17e12f17933de5ffb047d63358a05fad8f0211f0` after GitHub Actions run `29625979877` completed all
6 required jobs successfully. Production now runs PostgreSQL schema 16 and unchanged trading
SQLite schema 9 from protected slot `r5e-schema16-17e12f1`
([R5.3b-2 evidence](./evidence/R5_3B2_TELEGRAM_COMMANDS.md)). The same three project-owned units
keep running; no bot token is provisioned on the production host, so the notification worker
still idles by design, and provisioning the token file later activates the Telegram command lane
together with delivery without a new release. Because production has no token, the end-to-end
command proof is the real-fenced-executor PostgreSQL integration suite: the full
`/pause` → `/confirm` → action → reply round trip, one durable command per `update_id`, and
fail-closed cross-owner/revoked/expired/stale-authorization fences. Nothing in this section
replaces, edits or extends the R5.3b-1, R5.2.1, R5.1 and R4 acceptance evidence below.

Schema 16 is one atomic, advisory-lock-protected PostgreSQL migration named
`telegram_command_bridge`. Its exact checksum is
`499297dca5cc11a4c84f4988d5c159dc71160b4a8acfe864cc3c04e15d163b8e`.
It adds `telegram_command_replies` (one pending reply per durable executor command with a
`replied_at` fence) and `telegram_confirmations` (hashed one-consume control tokens) with
owner/binding composite foreign keys and retention indexes. The migration is additive: it
creates only new objects and rewrites or drops nothing from schema 15; the frozen schema-12
`executor_commands` table needed no DDL.

The accepted cutover repeated the schema-15 discipline: pre-upgrade paired generation `3e4dc4f1`
(schema 15) with its isolated restore drill; then the isolated 15-to-16 rehearsal, in which the
candidate API migrated to schema 16 with the exact checksum, a restart reported a migration
no-op and both workers pulsed ready heartbeats at schema 16; then the stopped pre-cutover
rollback source `0898a08d` (schema 15); then post-upgrade paired generation `08b6defe`
(schema 16) with its own drill. The replacement-only rollback pair is retained. There is no
in-place downgrade: never delete schema-16 rows, drop the command-reply/confirmation tables or
decrement `schema_migrations` to roll back.

## Accepted R5.3b-1 release: PostgreSQL schema 15

R5.3b-1 was accepted and deployed on 2026-07-18 from commit
`cd34ec8d11810a652bf087718f498dcece3b75fa` after GitHub Actions run `29622330910` completed all
6 required jobs successfully. Production moved to PostgreSQL schema 15 and unchanged trading
SQLite schema 9 from protected slot `r5d-schema15-cd34ec8`
([R5.3b-1 evidence](./evidence/R5_3B1_TELEGRAM_DELIVERY.md)). The cutover brought production to
three project-owned units — the API, the research worker and the new
`saltanatbotv2-notification-worker.service`. No bot token is provisioned on the production host,
so the worker idles by design (`notification_worker_idle`, reason `token_absent`) with a healthy
heartbeat; readiness keeps the worker optional unless `OPERATIONS_REQUIRE_NOTIFICATION_WORKER`
is set, and provisioning the token file later activates delivery without a new release. Nothing
in this section replaces, edits or extends the R5.2.1, R5.1 and R4 acceptance evidence below.

Schema 15 is one atomic, advisory-lock-protected PostgreSQL migration named
`telegram_notification_ingress`. Its exact checksum is
`1265ad195e84411807c64b35330d611520a2caacc2cafe6cebce75626a7cec25`.
It adds the nullable `notification_bindings.recipient_chat_id` column, the hashed one-consume
`notification_binding_codes` table, the fenced single-consumer `telegram_ingress_consumers`
lease/cursor table and the normalized hashed-only `telegram_updates` dedup journal. The migration
is additive: it extends `notification_bindings` with one nullable column, creates only new
objects and rewrites or drops nothing from schema 14.

The accepted cutover repeated the schema-14 discipline: pre-upgrade paired generation `47645c55`
(schema 14) with its isolated restore drill; then the isolated 14-to-15 rehearsal, which included
the notification-worker idle boot proof and the binding-code smoke (three unique one-time codes
issued, a fourth request answering `429`, hashed-only storage verified); then post-upgrade paired
generation `ba4f9d40` (schema 15) with its own drill. The stopped rollback source `d86692ad` and
the replacement-only rollback pair are retained. There is no in-place downgrade: never delete
schema-15 rows, drop the binding-code/ingress tables or the `recipient_chat_id` column, or
decrement `schema_migrations` to roll back.

## Accepted R5.2.1 release: PostgreSQL schema 14

R5.2.1 was accepted and deployed on 2026-07-17 from commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831` after GitHub Actions run `29584556266` completed all
6 required jobs successfully. Production moved to PostgreSQL schema 14 and unchanged trading
SQLite schema 9 from protected slot `r5b-schema14-20be5b1`
([R5.2.1 evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md)). An earlier candidate revision
`d422100` failed exact-SHA CI run `29583889332` on migration-chain assertions and was fixed
forward to `20be5b1` before any production change. Nothing in this section replaces, edits or
extends the R5.1 and R4 acceptance evidence below.

Schema 14 is one atomic, advisory-lock-protected PostgreSQL migration named
`owner_screener_presets`. Its exact checksum is
`0d7f90cadfa230c7b20fcbe03d7432d71add45760c1a3379ee2362e206c102f3`.
It adds one table, `screener_presets`: owner-scoped unique preset and client IDs, a size-checked
`jsonb` definition, a definition hash, positive revisions and an archive timestamp. The migration
is additive and touches no schema-13 object. Screener runs are ordinary owner-scoped compute jobs
under the existing five-active-per-owner quota and 30-day/200-artifact/256 MiB retention; presets
are limited to 40 active per owner, 400 globally active and a universe of at most 200 symbols.
These are conservative beta limits, not R11 capacity evidence for 100 simultaneous users. See
[On-demand technical screener](./SCREENER.md).

The accepted cutover repeated the schema-13 discipline: pre-upgrade paired generation `281b88c8`
(schema 13) with its isolated restore drill, API-first migration with checksum verification and a
no-op restart, worker-second activation, then post-upgrade paired generation `b18d3380`
(schema 14) with its own drill. The rehearsal included an end-to-end screener proof on the
isolated replacement pair: a preset was created and a run executed through a compute job against
live Binance closed candles, evaluating 30/30 symbols with 30 matched and 0 unavailable. The
stopped rollback source `bee7eced` and the replacement-only rollback pair are retained. There is
no in-place downgrade: never delete schema-14 rows, drop the `screener_presets` table or
decrement `schema_migrations` to roll back.

## Accepted R5.1 release: PostgreSQL schema 13

R5.1 was accepted and deployed on 2026-07-17 from commit
`66394fd38765d8da36174411cecd95a33fda1ea0` after GitHub Actions run `29574600648` completed all
6 required jobs successfully. Production moved to PostgreSQL schema 13 and unchanged trading
SQLite schema 9 from protected slot `r5a-schema13-66394fd`
([R5.1 evidence](./evidence/R5_1_OWNER_ALERTS.md)).
Nothing in this section replaces, edits or extends the immutable R4 acceptance evidence below.

Schema 13 is one atomic, advisory-lock-protected PostgreSQL migration named
`durable_owner_alerts_and_notification_outbox`. Its exact checksum is
`1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02`.
It adds:

- `alert_rules` and immutable `alert_rule_revisions`;
- exact `alert_rule_states` plus revision-scoped immutable
  `alert_evaluation_receipts` containing before/after state fences and outcome hashes;
- transactional `alert_event_sequences` and immutable `alert_rule_events`, giving each owner a
  commit-serialized forward event stream without a global identity counter;
- `notification_bindings`, immutable `notification_outbox` and fenced
  `notification_deliveries` (R5.1 activates in-app delivery only);
- `alert_rule_import_receipts` for idempotent browser-rule adoption;
- composite owner foreign keys, quota/admission indexes, immutable-update triggers and bounded
  retention indexes.

The first price evaluation consumes the exact closed candle containing the durable database arming
time and establishes a baseline; it cannot trigger. Later completions consume exactly one cursor
bar and one state revision, and only an exact durable `false -> true` crossing can create an event.
Threshold declarations use exact decimal comparison instead of rounding the threshold into a
JavaScript number. State, receipt, event, outbox and in-app delivery commit atomically behind owner,
authorization, lease and state-revision fences. The evaluator reads only credential-free public
Binance/Bybit REST candles. It has no private provider, cache/synthetic fallback, order, borrow,
margin or secret path. See [Owner-scoped server alerts](./ALERTS.md).

The beta limits are fixed in code: 100 active and 200 non-archived rules per owner, 400 total
rule/history rows per owner, 480 globally active rules, at most 500 claims, four concurrent public
scopes, 16 unique reads and eight reads per provider per sweep, and one candle per read. Receipts
retain two days; events, outbox, terminal deliveries, old state/revisions and archived rules use the
documented 30-day boundary. These are conservative admission controls, not R11 evidence for 100
simultaneous users.

### Schema 12 to 13 upgrade gate

1. Build and verify the exact candidate while the accepted R4 services keep running.
2. Stop this project's research worker and API. Create and verify a paired schema-12 project
   recovery generation.
3. Restore that generation into a separately named, marker/OID-bound PostgreSQL database and a
   separate absent/empty runtime directory. Complete the isolated restore/drill without changing
   `PGDATABASE`, Compose, systemd or the active runtime path.
4. Keep the worker stopped. Start only the exact candidate API and let it migrate schema 12 to 13.
   Verify the migration name/checksum, login, owner isolation, alert API, readiness and absence of
   secret-bearing alert columns.
5. Stop and restart the candidate API. The second start must report a migration no-op and the same
   schema/checksum.
6. Start the matching research worker only after API verification. Check its heartbeat, bounded
   public-read/claim metrics and one owner-scoped in-app alert.
7. Create and verify a post-upgrade paired generation, restore it into new isolated resources and
   repeat the drill before accepting or announcing R5.1.

There is no in-place downgrade. Do not delete schema-13 data, drop its tables/triggers/indexes,
rewrite immutable receipt/event rows or decrement `schema_migrations`. Rollback means stopping both
project processes, re-verifying the pre-upgrade paired generation, restoring both halves into **new**
replacement resources, and pointing only the stopped project services at those verified resources
plus the protected R4 release. Preserve the failed schema-13 database as incident evidence.

Schema 13 does not provide HTTPS. Until a separate TLS release is implemented and reviewed, account
passwords and session cookies must remain on loopback, a trusted VPN/private network or an SSH
tunnel. Do not expose the login service over public HTTP and do not add exchange keys for alerts.

## Accepted R4 release / PostgreSQL schema 12 and trading SQLite schema 9

R4 was accepted and deployed on 2026-07-17 from commit
`bb455facdfe5a1b3cabe15490c86c299ea684ee7` after GitHub Actions run `29560112312` completed all
6 required jobs successfully. The protected production slot is `r4c-schema12-bb455fa`; production
now runs PostgreSQL schema 12 and trading SQLite schema 9. The exact-release paired
backup/verify/isolated-restore/drill evidence and post-migration recovery generation passed. This
acceptance does not add HTTPS or enable private/live execution.

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
`user_version` and bounded owner/count evidence. Verification is read-only. The accepted R4
inventory includes the PostgreSQL executor-command table and every schema-9 SQLite
paper-portfolio table in addition to the complete database archives. Restore always creates a
separately named PostgreSQL replacement database and a separate absent/empty runtime directory; it
does not change a service, Compose configuration, `PGDATABASE` or the active data path. The drill
performs the same restore and removes only the marker/OID-bound temporary database and the verified
tool-owned directory. That real isolated paired drill passed for the accepted exact R4 release;
every future self-hosted upgrade must produce equivalent evidence for its own exact build. This is
replacement evidence, not an in-place down-migration or automatic cutover.

For server data, follow [Backup and restore](BACKUP_RESTORE.md) before deployment. A breaking future
IR, API, storage or event-trace change must add a dated section here and executable backward-compatibility
coverage in the same change.

The R4 chain is not an in-place two-store transaction. Take and verify one paired recovery
generation before the first schema-12/schema-9 start. If one store advances and startup then fails,
keep the application stopped and restore the complete verified pair into replacement resources;
never run an older binary against either advanced store or remove migration/ledger rows by hand.
See [Canonical paper portfolios](PAPER_PORTFOLIOS.md#upgrade-to-postgresql-12-and-sqlite-9) for the
operator sequence.
