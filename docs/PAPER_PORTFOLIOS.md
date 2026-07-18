# Canonical paper portfolios (R4)

Audience: self-hosted operators, maintainers and API integrators
Status: accepted and deployed on 2026-07-17

Accepted production evidence: commit `bb455facdfe5a1b3cabe15490c86c299ea684ee7`, GitHub Actions
run `29560112312` with all 6 required jobs successful, protected slot
`r4c-schema12-bb455fa`, PostgreSQL schema 12 and trading SQLite schema 9. The paired
backup/verify/isolated-restore/drill evidence and post-migration recovery generation were accepted
for this exact release.

Russian version: [ru/PAPER_PORTFOLIOS.md](./ru/PAPER_PORTFOLIOS.md).

This guide describes the pre-HTTPS paper-portfolio boundary introduced by the accepted R4 release. It is
available only with `RUNTIME_PROFILE=public-http-paper`. It does not configure TLS, accept exchange
API keys, open private exchange streams, place live orders, borrow assets or mutate real margin.

> Plain HTTP does not protect account passwords or session cookies in transit. Keep an HTTP
> installation on loopback or behind a trusted private network/VPN and a strict source-IP
> allowlist. The paper-only profile prevents live execution; it does not encrypt transport.

## What is canonical

A paper portfolio belongs to exactly one authenticated user. Its current snapshot is
`paper-portfolio-v1`, and its accounting formulas are `paper-metrics-v1`. The snapshot is built by
the singleton trading executor from the executor-owned SQLite store, not from browser state and not
from a real exchange balance.

The model binds all of the following identities:

- owner user;
- portfolio and optimistic portfolio revision;
- monotonic ledger epoch;
- robot and immutable robot revision;
- fixed six-decimal USDT capital reservation;
- mutation ID, idempotency key and request hash;
- durable paper-ledger events and time-bounded valuation marks.

Values derived from a current market mark include their evidence state and observation time. A
missing or expired mark is reported as `unavailable` or `stale`; it is never converted to a false
zero. Borrowing is explicitly `unavailable` in `paper-portfolio-v1`. Margin is a paper-model value,
not exchange account telemetry.

## Storage and execution authority

R4 intentionally uses two stores with one fenced bridge:

| Store | Authority | R4 schema |
| --- | --- | --- |
| PostgreSQL | authenticated owner/session, authorization revision and epoch, durable executor command queue | 12 |
| `backend/data/trading.db` | paper portfolios, epochs, reservations, robot revisions, orders/fills/events, valuation marks, projections and terminal mutation receipts | SQLite 9 |

The browser submits a command to PostgreSQL. The command contains normalized paper configuration,
owner and target identities, an idempotency key and hashes; validation rejects secret-bearing JSON
keys. The singleton executor claims one command per owner under a renewable lease, rechecks the
exact active session and current authorization revision/epoch, then applies the command to SQLite.
Only the current lease token and generation can acknowledge the PostgreSQL row.

SQLite records the terminal mutation receipt in the same transaction as the portfolio mutation.
If the process stops after SQLite commits but before PostgreSQL receives the acknowledgement, the
next reclaimed claim checks only the exact owner, command ID, idempotency key and request hash and
acknowledges the existing receipt before reauthorization. This exception can only reconcile an
already-applied receipt: when no exact receipt exists, current authorization remains mandatory and
no mutation runs. Reusing the same idempotency key with a different validated request is a conflict,
not a second command. At startup, persisted robots finish recovery before the executor may claim
queued actions and before the HTTP listener opens.

This bridge is not permission to run multiple API/executor replicas. Run exactly one API process
against a given `trading.db`. The research worker uses PostgreSQL and must not open the trading
SQLite store. Shutdown first rejects new executor work, then drains or aborts the active callback.
If a callback ignores abort and remains active, shutdown fails closed and refuses to stop the
engine or close SQLite underneath it.

## Portfolio lifecycle

An owner with the `paper-trade` application role can:

1. Create an active USDT paper portfolio with positive initial capital.
2. Select one active portfolio as the default.
3. Rename a portfolio using its current revision and ledger epoch.
4. Reserve capital atomically while creating a paper robot.
5. Start, pause, resume and stop that exact robot revision through the durable command queue.
6. Archive a portfolio only after active robot allocations have been released.
7. Reset a flat portfolio with an exact name confirmation.

Reset closes the current epoch and starts the next epoch. It does not delete the old epoch, robot
revision evidence, orders, fills or events. Robots from the old epoch must be rebound explicitly;
the server does not silently attach an old revision to new capital.

The executor-side delete primitive for a released/closed paper robot retains an immutable tombstone
and its journal evidence; the database-auth compatibility HTTP delete remains blocked until that
canonical flat-release workflow is exposed end to end. In legacy token mode only, `DELETE` may
atomically release and delete an upgraded paper robot when replay of its exact ledger proves an
initialized flat position, zero open orders and representable fixed-micro capital; otherwise it
returns a conflict and changes nothing. Runtime status changes do not create a new strategy revision
or rewrite immutable revision evidence.

Every legacy paper bot found while crossing SQLite schema 9 receives its own deterministic
portfolio and epoch 1. Existing event ledgers remain the accounting source. If only a legacy
snapshot/formula is available, migration creates a deterministic initialization ledger and marks
the epoch `legacy-incomplete`; later projections must preserve that evidence limitation.

## Browser workflow

Open **Trading → Running / Paper portfolios** after an administrator activates the account and
grants paper-trading access. The center provides:

- an honest empty state when there is no paper portfolio or robot;
- portfolio create, rename, default, archive and reset actions;
- a collapsible sticky summary on small screens;
- mobile robot cards and a desktop table/detail view;
- status and symbol filters;
- balance, available/reserved capital, realized result and evidence-aware equity, exposure and
  unrealized result;
- confirmed start, pause, resume and stop actions.

Robot creation requires an active portfolio and a positive allocation that does not exceed its
unallocated cash. A robot bound to a portfolio has immutable portfolio/allocation fields; create a
new revision/workflow instead of editing those fields behind the ledger.

Each robot detail returned by R4 includes a bounded `paper-robot-journal-v1`. Its curve
is explicitly `current-epoch-realized-cash`, not an invented historical mark-to-market equity
series. It contains at most 256 oldest-first downsampled cash points and, only when current durable
valuation evidence is available, one final current-equity point. The journal also returns at most
50 newest fills and 100 newest event metadata rows with `truncated` flags. Event payloads,
idempotency keys and command fields are not exposed by this read model.

## DCA paper robots (R6, in progress)

R6 status: implemented on `main`, **not accepted and not deployed**. The accepted production
evidence above still describes R4; the R6 release gate in [RELEASING.md](./RELEASING.md) —
exact-commit CI, protected slot, paired recovery rehearsal and cutover — has not run yet. R6
changes no PostgreSQL or SQLite schema: DCA robots ride the existing paper event types and
settings snapshots, and every pre-R6 ledger replays byte-identically.

A paper robot config gains an optional behavior discriminator `kind: "strategy" | "dca"`. An
absent `kind` still means "strategy", so historical robots and old create payloads are unchanged.
A DCA robot carries no strategy IR; instead it embeds versioned `dca-params-v1` parameters. Like
every robot in `public-http-paper`, it is research-only simulation: no exchange credentials, no
private requests, no live orders.

### Parameters (`dca-params-v1`)

| Field | Bounds | Meaning |
| --- | --- | --- |
| `direction` | `long` \| `short` | cycle side; shorts are fully mirrored |
| `baseOrderQuote` | > 0 | first (base) market order size, quote currency |
| `safetyOrderQuote` | > 0 | first safety order size, quote currency |
| `maxSafetyOrders` | integer 0..25 | safety orders per cycle; 0 disables averaging adds |
| `priceDeviationPct` | > 0, ≤ 50 | distance of safety order 1 from the cycle entry, percent |
| `stepScale` | 0.1..5 | deviation multiplier for each subsequent safety order |
| `volumeScale` | 0.1..5 | size multiplier for each subsequent safety order |
| `takeProfitPct` | > 0, ≤ 100 | take-profit distance from the average entry, percent |
| `stopLossPct` | optional, > 0, ≤ 100 | stop-loss distance from the average entry, percent |
| `trailingTakeProfitPct` | optional, > 0, ≤ `takeProfitPct` | trailing distance once TP threshold prints |
| `cooldownSeconds` | integer 0..86400 | pause after a completed cycle before re-entry |
| `maxCycleDurationHours` | optional, integer 1..720 | cycle age limit; exceeding it closes at market and stops |

The shared parser (`packages/contracts/dca.ts`) is exact and fail-closed: unknown or missing
fields are rejected, and the payload must carry the literal `researchOnly: true` and
`executionPermission: false` safety envelope. Quote sizes are additionally capped at the fixed
paper-money range.

### Worst-case capital

```text
worstCase = (base + Σ_{i=1..maxSafetyOrders} safety · volumeScale^(i-1)) · (1 + feePct/100)
```

rounded **up** to six decimals so the reservation is always conservative. The browser create form
and the server run the same shared function. `paper-robot.create` fails with
`WORST_CASE_EXCEEDS_ALLOCATION` when the worst case exceeds the requested six-decimal allocation;
the form shows the same value live against available capital and blocks submission, and the robot
detail repeats it inside the parameters disclosure.

### Shared paper fill model (`paper-fill-model-v1`)

The versioned constant `PAPER_FILL_MODEL_V1 = { feePct: 0.05, slipPct: 0.02 }`
(`packages/execution-core/fillModel.ts`) is the single fee/slippage parity source consumed by the
paper engine adapter, the backtest defaults and the DCA worst-case math. Changing the numbers is a
new version, never an in-place edit.

### Averaging fill behavior (`averaging-v1`)

The paper adapter's position transition is versioned per robot:

- `single-position-v1` (default): the historical behavior, byte-compatible with every existing
  ledger. A triggered same-side resting order now produces an explicit `order_cancelled` event
  with a reason instead of silently vanishing.
- `averaging-v1` (DCA robots only): a same-side add merges into one position with
  `qty = q1 + q2` and a volume-weighted average entry; fees are charged exactly as today and the
  recorded position event reflects the merged state.

Ledger replay stays fail-closed: recorded fills are data, and the reducer validates that every
recorded position/cash/fee event is internally consistent. Single-position ledgers never contain
same-side add fills, so the extension is additive and old ledgers validate unchanged.

### Cycle state machine (`dca-state-v1`)

The DCA robot is a pure versioned transition function driven only by closed bars and observed
fills of its own orders. Phases: `idle → entering → position(soFilled=k) → exiting(reason) →
cooldown(until) → idle`; a `duration` exit terminates in `stopped` instead of cooldown. Rules:

- when idle and past cooldown, a closed bar starts a cycle with the base market order;
- after the base fill: a take-profit limit from the average entry plus safety order 1 at
  `entry · (1 ∓ deviation)`;
- after safety order `k` fills: cancel and re-place the take-profit from the new volume-weighted
  average entry, and place safety order `k+1` at the last safety price ∓ `deviation · stepScale^k`
  while `k < maxSafetyOrders`;
- take-profit fill completes the cycle: remaining orders are cancelled and cooldown starts;
- stop-loss (if set, from the average entry) closes on a bar cross; trailing take-profit arms at
  the take-profit threshold and only ever tightens;
- exceeding `maxCycleDurationHours` closes at market and stops the robot terminally.

Order quantities and limit prices are exact six-decimal values, so the machine's arithmetic
mirrors the recorded paper fills bit-for-bit and a take-profit closes the full position without
dust. A same-bar race where a safety order and the stale take-profit both fill leaves a remainder
that is flattened by an explicit `tp-remainder` market close — never dropped.

### Determinism, golden replay and restart

The golden-replay harness (`backend/src/trading/goldenReplay.ts`) drives the real engine order
path — paper adapter, order lifecycle and ledger controller — bar by bar over in-memory stores
with an injected clock and identities derived from `(botId, bar, ordinal)`. The determinism
criterion: the same candle path always produces a byte-identical ledger event stream, and
replaying that stream reproduces the final state.

Every machine transition consumes one deterministic idempotency key
`dca:<botId>:<cycle>:<ordinal>`, which is also the durable order `clientId`. The machine snapshot
is persisted through the existing settings event path under `dcaState:<botId>` with that same
key. On restart, ledger replay restores the paper account, the fail-closed snapshot parser
restores the machine state, journaled fills are reconciled back into the machine, and a missing
or ambiguous transition is re-executed safely because the adapter deduplicates commands by
`clientId`. A mangled snapshot fails recovery closed instead of resuming from guessed state.

The robot list labels DCA robots with a DCA strategy type, and the detail drawer adds an additive
optional `dca` runtime-metadata section (cycle phase, safety orders filled/total, average entry,
next safety price, take-profit target, cooldown) derived from the same durable snapshot; old
clients ignore the extra field.

## HTTP contract for first-party clients

The canonical routes are below. Reads require the normal authenticated trading boundary; mutations
also require its CSRF protection. All responses send `Cache-Control: no-store`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/trade/paper-portfolios` | list the authenticated owner's active and archived portfolios |
| `GET` | `/api/trade/paper-portfolios/:portfolioId` | read one canonical projection |
| `POST` | `/api/trade/paper-portfolios` | create a portfolio |
| `PATCH` | `/api/trade/paper-portfolios/:portfolioId` | rename a portfolio |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/default` | select the default portfolio |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/archive` | archive after exact confirmation |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/reset` | create the next ledger epoch after exact confirmation |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/robots/:botId/actions` | start, pause, resume or stop one revision |

Every request carries `X-SBV2-Expected-User` equal to the user captured when the operation began.
Every mutation also carries a stable `Idempotency-Key`; a retry after timeout must reuse that exact
key and identical body. Existing-resource mutations send the latest portfolio revision and ledger
epoch; robot actions also send the exact bot revision. A `409` conflict means the client must
refresh rather than overwrite newer state. A `503 command_pending` means the command is durable but
did not reach a terminal state within the synchronous wait; retry it with the same key.

Money in this API is canonical USDT text with exactly six fractional digits, for example
`"10000.000000"`. Clients must not round through a binary floating-point value before sending it.

## Fresh installation

Follow [Self-hosting with account authentication](./SELF_HOSTING.md). A fresh clone starts one
project-owned PostgreSQL service and one project-owned SQLite data directory; application startup
applies the checked-in PostgreSQL and SQLite migrations automatically. Do not run migration SQL by
hand.

Before starting, verify that the selected application and PostgreSQL ports are free. The documented
defaults are `127.0.0.1:4180` and `127.0.0.1:55434`. If a port is occupied, choose a different
loopback port for this project. Never stop a foreign process, reuse an
unrelated PostgreSQL cluster/database or point `backend/data` at another installation.

After startup:

1. Confirm `/api/health` and `/api/ready` for this instance.
2. Bootstrap the first administrator using the documented one-time command.
3. Change the generated password immediately.
4. Activate a test user and grant only the required paper role.
5. Create a paper portfolio and one paper robot; no exchange credential is required.
6. Create and verify a paired recovery generation before the instance contains irreplaceable work.

## Upgrade to PostgreSQL 12 and SQLite 9

The migration chain is forward-only. PostgreSQL 12 adds the durable executor queue; SQLite 9 adds
the canonical portfolio, epoch, reservation, receipt, revision-evidence, valuation and projection
tables while rebuilding the paper event key around `ledgerEpoch`.

The accepted production deployment followed this sequence; self-hosted upgrades must follow it for
their own exact release:

1. Confirm the exact checkout/release, database name, loopback port, service units or Compose
   project, and runtime data directory all belong to this installation.
2. Create and verify one paired PostgreSQL + SQLite recovery generation by following
   [Runtime backup and restore](./BACKUP_RESTORE.md). Retain it outside the mutable release tree.
3. Stop only this project's API and research worker before cutover. Do not stop PostgreSQL or
   services belonging to another project.
4. Install/build the accepted exact release using the existing self-host procedure.
5. Start exactly one API instance. Startup applies each PostgreSQL migration transactionally under
   the migration lock and each SQLite migration transactionally under the singleton runtime lock.
6. Require readiness to report the expected schema/checksum and paper executor state. Check login,
   owner isolation, the migrated legacy portfolio list and one idempotent paper mutation.
7. Start the matching research worker only after the API/schema check passes.
8. Create and verify a new paired recovery generation for the migrated state.

Do not deploy an older binary after either store has moved forward. Do not remove migration rows,
drop R4 tables, rewrite a ledger epoch or clear a queue to make readiness green.

If startup applies PostgreSQL 12 but fails before SQLite 9 completes, keep the application stopped.
Preserve logs and the untouched pre-upgrade recovery generation. Investigate with read-only checks
or restore the complete pair; do not attempt a partial down-migration of one store.

## Backup, restore and rollback

The required recovery unit is one verified generation containing both stores. A PostgreSQL-only
dump loses the SQLite portfolio ledger and receipts. An SQLite-only archive loses authenticated
ownership, authorization fences and queued PostgreSQL commands. Mixing independently captured
halves can replay an already applied mutation or detach evidence from its owner.

Use the project `recovery:backup`, `recovery:verify`, `recovery:restore` and `recovery:drill`
workflows exactly as documented in [Runtime backup and restore](./BACKUP_RESTORE.md). Restore creates
a separately named project-owned PostgreSQL database and a separate absent/empty runtime directory;
it does not switch systemd, Compose, `PGDATABASE`, `FRONTEND_DIST_DIR` or the active data path.

Rollback from R4 means:

1. Stop only this project's API and research worker.
2. Verify the retained pre-upgrade paired generation again.
3. Restore both halves into new replacement resources.
4. Verify the restored schema versions, owner inventory, `executor_commands` count, every
   schema-9 canonical paper-table count and SQLite integrity.
5. Point only this project's stopped services at the verified replacement database, data directory
   and matching protected pre-R4 release.
6. Start one API, verify authentication/readiness/paper state, then start its research worker.
7. Retain the former resources until the rollback evidence and retention policy allow removal.

There is no in-place schema downgrade. Commands, portfolios and events created after the selected
backup are not present after rollback; export any user artifacts that must survive before choosing
that recovery point.

## Operator invariants

- Keep `RUNTIME_PROFILE=public-http-paper` literal.
- Keep PostgreSQL loopback-only and use a unique project database/role/port.
- Run one paper executor per `trading.db`.
- Keep `trading.db` and `.secret` together; treat their backup as sensitive.
- Never edit portfolio totals, receipts, revisions or ledger events directly.
- Never copy a live SQLite file with ordinary filesystem tools; use the online backup workflow.
- Never restore over the active database or data directory.
- Never use broad process kills, Docker prune/down, root-systemd changes or database drop commands
  to resolve a project-local upgrade problem.
- HTTPS and live/private exchange execution remain separate future work.
