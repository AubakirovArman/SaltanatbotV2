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

## Screener alerts (R5.3a)

R5.3a adds a second server-evaluated rule kind, `screener`, which promotes a
[technical screen](./SCREENER.md) into a durable on-change alert. The
increment is accepted and deployed with no schema migration; the acceptance
and cutover record is
[R5.3a evidence](./evidence/R5_3A_SCREENER_ALERTS.md).
Like every alert, it is notification-only research: `researchOnly: true`,
`executionPermission: false`, and it cannot place an order.

A screener rule embeds a full `screener-definition-v1` document by value. The
embedded screen is immutable with the rule revision; editing the rule creates
a new revision with its own definition. There is no new PostgreSQL schema: the
rule, its durable state and its receipts fit the existing schema-14 alert
tables.

### On-change semantics

The worker evaluates the embedded screen on closed candles only and compares
the full matched symbol set (before result truncation) with the durable
previous set:

- the first evaluation initializes the baseline without triggering;
- a trigger requires the effective matched set to differ from the previous
  set;
- entering and leaving symbols are listed in the event summary, capped at 12
  symbols in text;
- the notification envelope title is `Screen match changed: <name>`; the body
  lists entered/left symbols and the matched count;
- after a trigger the rule **stays active** and keeps evaluating; no rearm is
  needed. `POST /api/alerts/:id/rearm` stays price-only and answers `409
  alert_rearm_unsupported` for a screener rule.

Unavailable symbols are **unknown, not departed**: a previous member that is
unavailable this run stays a member, and a previous non-member stays a
non-member. If more than 30% of the requested universe is unavailable, the
evaluation defers without advancing state (`screener-availability-floor`).

`cooldownSeconds` (0–86 400; the browser promotion default is 3600) sets
`cooldown_until` at each trigger. During cooldown an observed change defers
without advancing state, so the change still fires after the cooldown passes
instead of being silently swallowed.

### Cadence, worker lane and delivery

Evaluation cadence derives from the screen's timeframe (`5m` → 300 s, `15m` →
900 s, `1h` → 3600 s, `4h` → 14 400 s, `1d` → 86 400 s), clamped to
300–86 400 seconds. The research worker admits at most one screener-alert
evaluation per sweep under a 300-second lease with a 90-second
market-evidence budget, and reports a dedicated screener-alert lane metrics
block. Completion writes the immutable receipt (producer
`screener-alert-worker`), the event, the outbox row and the pre-delivered
in-app row in one transaction; the transition key deduplicates replays.

In the R5.3a release delivery was `in-app` only, and a screener rule that
requested `telegram` was rejected with a clear `400` exactly like any other
unsupported delivery channel. The accepted R5.3b-1 release below widens that
gate: `telegram` is now an accepted delivery channel for both price-threshold
and screener rules.

### Screener-alert quotas

| Boundary | Limit |
| --- | ---: |
| Enabled screener rules per owner | 5 |
| Globally active screener rules | 40 |

Screener rules also count toward the shared R5.1 caps (100/200/480); both
limits apply. Exceeding them maps to `429 screener_alert_quota_exceeded` and
`429 screener_alert_capacity_exhausted`.

## Telegram delivery and chat binding (R5.3b-1)

R5.3b-1 adds a separate notification worker that delivers alert notifications
to Telegram and binds one private chat to one owner through one-consume codes.
The increment is **accepted and deployed**: production runs PostgreSQL
schema 15 from protected slot `r5d-schema15-cd34ec8`, and a notification is
delivered to `telegram` whenever the owner holds an active binding; the
acceptance and cutover record is
[R5.3b-1 evidence](./evidence/R5_3B1_TELEGRAM_DELIVERY.md).
Like every alert feature it is notification-only research: the worker opens no
HTTP listener, never opens the trading SQLite, and cannot place an order.
Inbound bot commands beyond `/start`, `/bind` and the static fallback reply
are the in-progress increment described in
[Telegram paper commands (R5.3b-2)](#telegram-paper-commands-r53b-2-in-progress).

### Binding lifecycle

1. The owner requests a one-consume code
   (`POST /api/alerts/bindings/codes`). The raw 26-character base32 code is
   returned exactly once with its expiry; only its SHA-256 hash is stored and
   the code is never logged. Codes expire after 10 minutes; at most 3
   unconsumed codes may be outstanding per owner
   (`429 binding_code_quota_exceeded`) and at most 10 codes may be created per
   owner per 10 minutes (`429 binding_code_rate_limited`).
2. The owner sends `/start <code>` or `/bind <code>` to the operator's bot in
   a **private** chat. The worker consumes the code under a row lock and
   activates the binding in the same transaction. Consumption is one-shot: an
   unknown, expired or already consumed code receives a static failure reply
   and counts against the per-chat attempt limit.
3. An owner holds at most one active binding. Consuming a new code while one
   is active revokes the old binding and activates the new one in one
   transaction.
4. `POST /api/alerts/bindings/:id/revoke` with `{"expectedRevision": n}`
   revokes the binding and cancels its queued/retrying Telegram deliveries in
   the same transaction. A stale revision answers
   `409 binding_revision_conflict`.

`GET /api/alerts/bindings` lists the owner's bindings with an 8-character
hashed recipient handle, status, revision and timestamps. Responses,
projections and logs never contain a raw chat id, a raw code or the bot
token. The binding row itself stores the chat id (required to send) and its
SHA-256 fingerprint; neither leaves the server. Binding routes run under the
same session/CSRF/`X-SBV2-Expected-User` stack as `/api/alerts`, return
`Cache-Control: no-store` and bound request bodies at 4,096 bytes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/alerts/bindings` | List the owner's bindings (hashed handles only) |
| `POST` | `/api/alerts/bindings/codes` | Create a one-consume code; the raw code is returned once |
| `POST` | `/api/alerts/bindings/:id/revoke` | Revoke with `expectedRevision`; cancels pending deliveries |

### Delivery semantics

When a rule's delivery channels include `telegram` and the owner holds an
active binding at completion time, the completion transaction inserts a
queued Telegram delivery beside the pre-delivered in-app row. Without an
active binding the Telegram delivery is skipped silently (a counter only) and
the in-app row still delivers. The worker claims due rows through the
existing lease fence (`FOR UPDATE SKIP LOCKED`, one sending row per owner),
re-proves the exact binding revision immediately before each send, and sends
plain text with **no parse mode**: the envelope title and body plus a
"SaltanatbotV2 research/paper notification" footer. Outcomes are `delivered`
(provider message id receipt), `retrying` (backoff 30 s × 2^attempt capped at
15 minutes) or `dead_letter`; a revoked binding cancels the row as
`binding_revoked`.

External delivery is **at-least-once**: a crash between the Telegram send and
the durable acknowledgement can repeat a message after the lease expires.
Retries reuse the same deduplication key, and deliveries remain unique per
(owner, channel, deduplication key).

### Worker, ingress and privacy

The worker is a third, optional supervised process (see
[Self-hosting](./SELF_HOSTING.md)). It reads the bot token only from the
owner-only file named by `TELEGRAM_BOT_TOKEN_FILE`, validated like the
trading master key (regular non-symlinked file, service-uid owner, mode
`0600`/`0400`). A missing or invalid token file leaves the worker idling with
a live heartbeat — it rechecks every minute and never crash-loops — and API
readiness on hosts without the worker is unaffected unless
`OPERATIONS_REQUIRE_NOTIFICATION_WORKER=1`. The token never appears in logs,
metrics or errors; everywhere else the bot is identified by the SHA-256
fingerprint of its token. The worker never runs migrations: on a schema
version mismatch it idles and reports instead of writing.

Inbound updates use egress-only `getUpdates` long polling — no webhook and no
new listener. A fenced single-consumer lease (60 s, monotonic generation on
takeover) keeps exactly one poller per bot, and the durable
`(bot, update_id)` cursor advances in the same transaction as the batch
outcomes, so a replayed batch is a no-op. Only private-chat text messages are
parsed; group chats and non-message updates are recorded as ignored, and any
other private message receives the static "commands arrive in R5.3b-2"
reply. Stored ingress rows are normalized only — hashed chat fingerprint,
kind and outcome — never message text or raw chat ids.

### Telegram limits

| Boundary | Limit |
| --- | ---: |
| Outstanding unconsumed codes per owner | 3 |
| Code creation per owner | 10 / 10 min |
| Code TTL | 10 min |
| Active bindings per owner | 1 |
| Sends, whole bot | 25 / s |
| Sends per chat | 1 / s |
| Sends per owner | 10 / min |
| Handled commands per chat | 6 / min |
| Binding-code attempts per chat | 5 / 10 min |

Administrators do not bypass these limits. Telegram `429 retry_after` answers
defer the send with a capped backoff.

### PostgreSQL schema 15 (candidate)

Migration 15 `telegram_notification_ingress` is additive: it adds
`notification_bindings.recipient_chat_id`, the hashed one-consume
`notification_binding_codes` table, the fenced `telegram_ingress_consumers`
lease/cursor row and the normalized `telegram_updates` dedup journal. The
migration runs only in the API process under the existing checksum-locked
advisory-locked chain; acceptance follows the same backup/isolated-restore/
cutover procedure as schema 13 and 14.

## Telegram paper commands (R5.3b-2, in progress)

R5.3b-2 extends the bound private chat with read commands and a fenced
two-step control flow for paper robots. The increment is **in progress and
not accepted**: candidate migration 16 `telegram_command_bridge` adds the
`telegram_command_replies` and `telegram_confirmations` tables, and no
production cutover has happened. The worker still opens no HTTP listener and
never opens the trading SQLite: every paper answer is produced by one durable
executor command applied by the existing API-process fenced executor.
Everything stays paper-only research — no command can reach live trading —
and administrators bypass none of the limits below.

Every command works only in a private chat holding an active binding. The
worker resolves the single active binding by the hashed chat fingerprint (a
chat actively bound by two different owners is refused as ambiguous),
re-checks `users.status = 'active'` and reads the owner's current
authorization revision; any failure receives a static fail-closed reply that
leaks no tenant data. The existing per-chat command budget (6/min) applies.

| Command | Answer |
| --- | --- |
| `/help` | Static command reference |
| `/balance` | Default-portfolio snapshot: available/reserved capital, evidence-aware equity (an honest `unavailable`, never zero), realized PnL and up to 20 robots with 8-character handles |
| `/daily` | Realized PnL for the current UTC day |
| `/profit` | Total realized PnL |
| `/performance` | Per-robot realized PnL with bounded win/loss counts |
| `/trades <robot>` | Last ≤10 fills of one robot by its 8-character handle |
| `/alerts` | Direct PostgreSQL read: ≤10 enabled rules and ≤5 recent events |
| `/pause`, `/resume`, `/stop <robot>` | Two-step fenced control (below) |
| `/confirm <token>` | Consume a one-use confirmation token |

### Two durable phases

Phase A runs inside the same ingress batch transaction that journals the
update: a paper command enqueues exactly one durable executor command with
idempotency key `telegram:<botFingerprint>:<updateId>` plus a pending row in
`telegram_command_replies`. The `(owner, idempotency key)` uniqueness makes a
replayed or crash-redelivered update settle on the same single durable
command before and after a restart or takeover. The frozen `executor_commands`
table receives no DDL: Telegram provenance is the payload `origin` marker
plus the idempotency-key prefix, telegram-origin commands carry a
deterministic synthetic session digest with authorization epoch 0, and the
executor re-proves the durable authorization revision at apply time. The
ingress cursor never waits on the executor.

Phase B is a bounded replies lane beside the delivery lane
(`NOTIFICATION_REPLIES_POLL_INTERVAL_MS`). It joins pending reply rows to
their executor commands; a terminal `applied`/`rejected` command is formatted
(rejections map to safe error codes only) and a non-terminal command older
than 10 minutes receives one "timed out" reply. The binding (active, same
revision, chat still present) and the active owner are re-proven inside the
settle transaction before **every** send; a revoked binding suppresses the
reply entirely. `replied_at` is settled durably before the external send, so
each reply is **at-most-once**: a crash between the fence and the send drops
that one message instead of ever duplicating it — for a pending control
command the unsent token simply expires and the command can be repeated.
Replies share the delivery lane's global/per-chat/per-owner send buckets.

The two read kinds `paper-portfolio.snapshot` and `paper-robot.trades` are
strictly read-only and run through the same lease/fence path as every other
executor command; `/balance`, `/daily`, `/profit` and `/performance` are all
formatted from one snapshot result.

### Two-step control and confirmation tokens

1. `/pause <robot>` (or `/resume`, `/stop`) enqueues a confirm-target
   snapshot command in Phase A.
2. On its terminal result the replies lane resolves the 8-character handle
   against the owner's robots — no match replies with the available handles,
   two or more matches are refused as ambiguous — and mints a one-use
   confirmation: a 16-character base32 token stored only as its SHA-256 hash
   beside the pinned binding tuple, chat fingerprint, authorization revision
   and the portfolio/ledger/robot revisions observed at issue time. The raw
   token exists exactly once, inside the reply; it expires after 120 seconds
   and at most 3 unconsumed confirmations may be outstanding per owner.
3. `/confirm <token>` hashes the token and locks the unconsumed, unexpired
   row (`FOR UPDATE`) inside Phase A, then re-proves the chat fingerprint,
   owner, exact binding id and revision, and the same authorization revision.
   Any mismatch is one uniform rejection that does **not** consume the token.
   Consumption and the durable `paper-robot.action` command commit in one
   transaction; the executor then applies the action under the pinned
   optimistic fences. Invalid tokens burn the same per-chat attempt budget as
   binding codes.
4. The replies lane answers the terminal action command with the applied
   outcome or a safely worded rejection.

### Command limits and retention

| Boundary | Limit |
| --- | ---: |
| Confirmation token TTL | 120 s |
| Unconsumed confirmations per owner | 3 |
| Confirmation/binding-code attempts per chat | 5 / 10 min |
| Handled commands per chat | 6 / min |
| Robots per snapshot reply | 20 |
| Fills per `/trades` reply | 10 |
| Rules / events per `/alerts` reply | 10 / 5 |
| Reply timeout for a non-terminal command | 10 min |

Retention deletes consumed or expired confirmations after 2 days and replied
reply rows after 7 days through the same bounded `SKIP LOCKED` stages as the
other alert history; a reply row also follows its executor command through
`ON DELETE CASCADE`, so executor-command retention cannot orphan it.

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

R5.2.1 adds the separate [on-demand technical screener](./SCREENER.md); it
runs screens on demand, and R5.3a promotes a screen into the `screener` rule
kind described above. The separate notification worker and Telegram
binding/revoke/delivery flow are the accepted R5.3b-1 release described
in [Telegram delivery and chat binding](#telegram-delivery-and-chat-binding-r53b-1);
the richer inbound bot commands are the in-progress R5.3b-2 increment
described in
[Telegram paper commands](#telegram-paper-commands-r53b-2-in-progress).
