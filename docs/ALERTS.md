# Owner-scoped server alerts

Russian guide: [ru/ALERTS.md](./ru/ALERTS.md).
Kazakh guide: [kk/ALERTS.md](./kk/ALERTS.md).

This document describes the R5.1 alert control plane introduced by PostgreSQL
schema 13. It is a notification-only research subsystem. It cannot place an
order, borrow assets, change margin, sign an exchange request or grant a trading
role.

## R5.1 scope

R5.1 supports one server-evaluated rule:

- `price-threshold`;
- Binance or Bybit public market data;
- `spot`, `linear` or `inverse` market identity;
- last price only;
- `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d` and `1w`;
- inclusive `above` or `below` comparison;
- one trigger until an explicit rearm;
- durable in-app history.

Calendar-month (`1M`) candles are excluded because a fixed millisecond interval
cannot represent a calendar month. Telegram is also excluded from R5.1. Its
schema placeholders do not make Telegram available: bindings, provider
acknowledgements and retry delivery belong to R5.3.

R5.1 never reads an exchange credential. The evaluator uses direct public REST
candle endpoints and rejects synthetic, cached, private or unsigned substitute
evidence.

## HTTP-only deployment boundary

The current pre-HTTPS release deliberately does not configure TLS. Login
passwords and session cookies must therefore travel only over a trusted local
network, a private VPN or an SSH tunnel. Do not expose this build as a general
Internet login service, and do not add exchange private keys to it. HTTPS is a
separate release gate.

## Data flow

```text
authenticated browser
  -> durable local intent
  -> owner-scoped /api/alerts mutation
  -> PostgreSQL rule + immutable revision
  -> research worker lease
  -> exact public closed candle
  -> fenced state revision + immutable receipt
  -> event + notification outbox + in-app delivery
  -> owner-forward event cursor
  -> browser history/toast
```

The browser persists an idempotent client ID before creating a server rule. The
server first records a disabled draft. Only after the browser has durably
suspended its browser evaluator does reconciliation enable the server
revision. This ordering prevents the browser and server from evaluating the
same retained rule at the same time.

## Closed-candle semantics

The server evaluates only final candles. An alert may therefore remain armed
until the selected candle closes.

The first exact candle containing the durable arming time establishes the
predicate baseline. It cannot be forged into a trigger. A notification requires
a later durable `false -> true` transition. Every completion advances exactly
one bar and exactly one state revision. If the worker was stopped, it retrieves
the historical arming candle and catches up one closed bar at a time without
skipping the cursor.

Threshold strings are compared with the shortest exact decimal representation
of the observed JavaScript market price. A higher-precision threshold is not
rounded onto the observed double. For example, an observed `64703.52` is below
`64703.520000000001`.

Missing, forming, future, stale, discontinuous, oversized or malformed candle
windows fail closed. A healthy not-yet-closed candle is deferred to its expected
close rather than recorded as an evaluation error.

## Ownership and authorization

Every API read and write derives the owner from the authenticated database
session. The client must also send `X-SBV2-Expected-User` with that same user ID.
This catches an in-place account change before local state is synchronized into
another tenant.

Mutation requests additionally require the normal CSRF header. Repository
transactions re-check:

- active user status;
- `must_change_password = false`;
- the current authorization revision;
- actor equals owner;
- expected rule revision;
- lease owner, token, generation and expiry for worker completions.

Administrators do not receive a cross-owner alert read or mutation path. Alert
documents and public projections contain no destination, credential, password,
lease token or authorization revision.

## Lifecycle and browser recovery

The visible lifecycle is:

1. **queued** — the owner-local intent is durable and awaiting synchronization;
2. **synchronizing** — the disabled server draft exists and the browser copy is
   inert;
3. **armed** — the server owns evaluation;
4. **triggered** — the first proved crossing was committed and the rule is
   disabled until rearm;
5. **stale/error** — evidence was rejected; no notification or trade is inferred;
6. **archived** — the rule is no longer evaluated and will leave bounded history
   through retention.

Deletion uses an inert local tombstone. If deletion races with create, the
returned disabled draft is archived before it can reappear. If browser storage
fails after a server archive, the local record remains suspended instead of
being re-armed by a reload.

Same-owner tabs merge owner-local Lamport revisions through `storage` events
and `BroadcastChannel`. The price feed also rereads the durable snapshot before
each browser transition, which is the final fence against a stale in-memory
copy.

## API

All paths require database authentication, rate limiting and `Cache-Control:
no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/alerts?limit=200` | List manageable rules, non-archived first |
| `POST` | `/api/alerts` | Idempotently create a rule by `clientId` |
| `GET` | `/api/alerts/:id` | Read one owner rule |
| `PUT` | `/api/alerts/:id` | Replace definition using `expectedRevision` |
| `POST` | `/api/alerts/:id/archive` | Archive using `expectedRevision` |
| `DELETE` | `/api/alerts/:id` | Archive-compatible alias |
| `POST` | `/api/alerts/:id/rearm` | Create a new armed revision |
| `GET` | `/api/alerts/events?limit=200&cursor=…` | Read the durable forward event stream |
| `GET` | `/api/alerts/outbox?limit=200` | Read in-app delivery evidence |

The event response is `alert-event-page-v1` and always includes an opaque,
owner-bound `nextCursor`, `hasMore`, `generatedAt` and at most 200 events. A
client must drain every `hasMore=true` page before advancing its durable
watermark. A cursor from another owner is rejected. A cursor ahead of a restored
database returns `alert_event_cursor_ahead` and must be re-baselined.

Request bodies are limited to 65,536 bytes. Unknown fields, unsupported
delivery channels, non-canonical envelopes and result limits above 200 are
rejected.

## At-least-once in-app delivery

Each owner has a transactional event counter. The insert trigger serializes
same-owner sequence assignment, so a later transaction cannot commit a visible
sequence ahead of an earlier uncommitted owner event. Different owners do not
share that lock.

The browser publishes a new cursor page before saving the cursor checkpoint. A
crash can therefore repeat a toast, but it cannot acknowledge an unseen toast.
This is intentional at-least-once behavior. Event IDs and transition keys make
retries deduplicable.

For the `in-app` channel, `delivered` means “durably available in the
application”, not “the human read this toast”. The R5.1 UI uses that wording.
Telegram provider acknowledgement has different semantics and is not active
yet.

Durable cursor storage is owner-scoped. If local storage is unavailable, the UI
shows synchronization failure and leaves the cursor unadvanced; retries may
repeat a notification.

## Quotas and admission

R5.1 uses conservative beta limits:

| Boundary | Limit |
| --- | ---: |
| Active rules per owner | 100 |
| Non-archived rules per owner | 200 |
| Total rule/history rows per owner | 400 |
| Globally active rules | 480 |
| Rules claimed per sweep | default 100, hard maximum 500 |
| Concurrent public scopes | 4 |
| Unique public reads per sweep | 16 |
| Unique reads per provider per sweep | 8 |
| Initial/continuation candles per read | 1 |

Entering the globally active state is serialized by a dedicated PostgreSQL
advisory transaction lock. The 480-rule ceiling corresponds to eight unique
one-minute evaluations per second in the worst single-provider case. Equal
scope/cursor reads are coalesced. Provider admission cannot starve the other
provider; a saturated provider rule is released with a bounded retry.

R11 must run and pass the documented 100-user workload before these beta limits
are raised or described as a 100-user service-level guarantee.

## Retention and metrics

The research worker runs alert compaction through the existing retention timer:

- immutable evaluation receipts: 2 days;
- events, outbox, terminal deliveries, old states and old revisions: 30 days;
- archived rules: 30 days after dependencies are removed.

One run uses a non-blocking advisory lock, `SKIP LOCKED`, a default 1,000-row
batch, a 6,000-row ceiling and a 2-second time budget. Children are deleted
before immutable parents.

Structured worker logs expose active, due, leased, archived and errored rules,
oldest due age, recent evaluations/triggers, read/coalescing counts, admission
deferrals and scheduler failures. Logs contain no owner IDs, destinations or
secrets.

## PostgreSQL schema 13

Schema 13 adds:

- `alert_rules`;
- `alert_rule_revisions`;
- `alert_rule_states`;
- `alert_evaluation_receipts`;
- `alert_event_sequences`;
- `alert_rule_events`;
- `notification_bindings`;
- `notification_outbox`;
- `notification_deliveries`;
- `alert_rule_import_receipts`.

Revision, receipt, event and outbox rows reject updates. Composite owner foreign
keys prevent cross-tenant graph edges. Retention can delete immutable history in
declared dependency order.

## Upgrade and rollback

Before upgrading schema 12:

1. build and test the exact commit;
2. stop the research worker;
3. create and verify a paired project backup;
4. restore that backup into an isolated marked database and run a drill;
5. stop the API;
6. start the exact API release and allow the checksum-locked schema 13 migration;
7. verify health, readiness, owner isolation and a migration no-op restart;
8. start the research worker and inspect its alert-lane metrics;
9. create a post-upgrade backup and repeat the isolated restore check.

Never delete schema 13 rows or decrement `schema_migrations` to roll back.
Restore the pre-upgrade PostgreSQL backup into a new project-marked replacement
database, restore the paired runtime data, and start the protected R4 release
slot. Keep the failed schema 13 database as incident evidence.

See [MIGRATIONS.md](./MIGRATIONS.md),
[BACKUP_RESTORE.md](./BACKUP_RESTORE.md),
[STARTUP_RECOVERY.md](./STARTUP_RECOVERY.md) and
[RELEASING.md](./RELEASING.md).

## Verification

The release gate includes:

- strict contract generation checks;
- route/auth/CSRF/owner-change tests;
- real unprivileged PostgreSQL migration, repository, capacity, retention and
  forward-cursor tests;
- forged trigger, skipped cursor, stale revision, duplicate receipt and
  cross-revision replay tests;
- browser storage failure, create/delete race, multi-tab convergence and
  first-poll notification tests;
- browser-closed worker restart/dedup acceptance;
- desktop/mobile accessibility and visual regression;
- exact-commit GitHub CI and backup/restore/rollback evidence.

R5.2 will add the technical screener producer. R5.3 will add the separate
notification worker and Telegram binding/revoke/delivery flow.
