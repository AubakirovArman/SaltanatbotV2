# Pre-HTTPS development roadmap

Russian detailed plan: [ru/PRE_HTTPS_ROADMAP.md](./ru/PRE_HTTPS_ROADMAP.md).

This roadmap covers the public Research / Paper phase of SaltanatbotV2. HTTPS
termination and live exchange execution are deliberately outside its scope.
Until a separate HTTPS security review is complete, every deployed instance must
use `RUNTIME_PROFILE=public-http-paper`.

> Important: HTTP does not protect passwords or session cookies from network
> interception. Before HTTPS, expose the instance only through a private
> network/VPN/IP allowlist, or use unique disposable test passwords. The runtime
> profile prevents real orders; it does not encrypt transport.

## Non-negotiable boundary

The public HTTP deployment may provide:

- registration, administrator activation and tenant-isolated sessions;
- public market data, charts, indicators and research workspaces;
- deterministic backtests, optimizers and paper robots;
- screeners and research alerts;
- in-app and Telegram notifications that do not expose exchange secrets.

The delivered baseline already includes PostgreSQL authentication, registration,
administrator activation and owner-scoped sessions. An administrator may manage
activation and roles, but does not automatically receive access to a tenant's
workspaces, journal, paper portfolio or Telegram binding.

It must not provide:

- exchange API-key entry or rotation;
- signed REST requests or private WebSocket streams;
- live orders, borrowing, collateral changes or account telemetry;
- a UI-only override that can bypass the backend execution boundary.

Roles never override the runtime profile. Existing accounts, encrypted values,
robots and audit history are preserved, but private exchange data stays dormant.

## Delivery rules for every phase

Each phase is shipped independently and must include:

1. A verified backup before a schema or runtime-data migration.
2. Owner-scoped access and tenant-isolation tests for every tenant-owned row;
   shared public market-data/cache/reference rows remain safely reusable.
3. RU, EN and KK interface text where the change is user-facing.
4. Unit and integration tests, Chromium E2E, Firefox critical journeys and
   container-based visual regression where UI changes are involved.
5. Type, lint, documentation, bundle, PWA and source-architecture checks.
6. A safe rollback path and no destructive cleanup of user records.
7. A self-hosting documentation update for new configuration or services.
8. No new listener, database or container outside this project's declared
   resources.
9. A fresh-clone smoke covers install, project-owned PostgreSQL/admin bootstrap,
   mandatory password change, migrations, health, a sample paper run, backup,
   restore and upgrade; it preflights port collisions and never mutates another
   project's database, container or service.

## Phase 0 — enforce Research / Paper mode

Status: delivered.

Scope:

- load one immutable, fail-closed runtime profile before databases or listeners;
- reject live robot creation, start, resume, commands and boot recovery;
- reject credential writes, signed telemetry, UTA access and private streams;
- guard the last signed network boundary as defense in depth;
- disarm persisted live flags without deleting tenant data;
- expose a stable `PAPER_ONLY_MODE` API error;
- show a compact Research / Paper badge and only Paper in robot creation;
- keep existing live robots inert and remove private controls from the public UI.

Acceptance:

- HTTP, Telegram, boot recovery and direct engine calls cannot start live work;
- no exchange credential is decrypted for use in paper-only mode;
- public data, monitoring, backtests, research and paper robots still work;
- conflicting or malformed execution-profile settings stop startup.

## Phase 1 — harden the execution foundation

Order: typed configuration, master-key fail-stop, strict instrument rules, then
execution capabilities and permits. None of these changes enables live trading.

Status: 1A-1C are implemented in this release; 1D-1E remain planned. The runtime
therefore stays `public-http-paper` and this is not a live-readiness claim.

### 1A. Typed immutable runtime configuration

- parse booleans, integers, URLs, origins, proxy trust and paths strictly;
- reject unknown values instead of silently clamping or falling back;
- load configuration before database, filesystem and listener side effects;
- redact secrets from diagnostics;
- retain `DEMO_MODE` only as a temporary deprecated alias;
- define future `private-live` prerequisites without activating that profile.

Acceptance: invalid configuration fails before startup side effects and the
resolved object cannot change when `process.env` changes later.

### 1B. Fail-stop master key

- atomically create a key only for a genuinely new trading data store;
- fail if an existing `trading.db` has no valid `.secret`;
- reject symlinks, directories, wrong ownership and permissive key modes;
- preserve compatibility with the existing key format;
- require the key in every backup that contains encrypted records;
- provide explicit, guarded recovery tooling instead of silent regeneration.

Acceptance: a missing or wrong key never mutates the database, never creates a
replacement automatically and produces an actionable startup error.

### 1C. Verified instrument rules

- require an exact native-symbol match and trading status;
- validate complete market/limit quantity, price and notional rules;
- use bounded-freshness caching and exact decimal arithmetic;
- quantize and validate entry, stop-loss and every take-profit child before the
  first exchange mutation;
- persist the rules fingerprint and prepared wire values with durable intent;
- permit cancel without filters, but never guess reduce-only order formatting.

Acceptance: missing, stale, partial or invalid rules cause zero signed exchange
requests; precision is preserved beyond eight decimal places.

### 1D. Adapter capabilities and one-use execution permits

- separate public reads, private reads, entry, protection, reduce-only close,
  cancel, leverage/margin changes and UTA debt actions;
- bind a short-lived opaque permit to owner, account, credential revision, bot or
  emergency operation, symbol, action, risk effect and durable intent;
- validate before adapter execution and consume immediately before signed I/O;
- revoke risk-increasing work after disarm, role revocation or account changes;
- restrict emergency permits to cancel and true reduce-only flattening.

Acceptance: forged, expired, reused, cross-owner or wrong-capability permits are
rejected with zero network calls.

### 1E. Minimal worker and queue foundation

- move jobs out of request handlers into a bounded worker process;
- provide durable leases, idempotency keys, retry/backoff and crash recovery;
- enforce per-owner concurrency, timeout, CPU, memory and result-size quotas;
- add request/job correlation, queue depth, duration and failure counters;
- decide an ADR early: one PostgreSQL system of record, or a PostgreSQL outbox
  with formally specified reconciliation to legacy SQLite.

Acceptance: a worker crash cannot stop login/chart traffic or lose a queued job,
and a retried job cannot publish a duplicate result.

## Phase 2 — mobile chart foundation

- replace the hidden mobile drawing rail with a 44 px Tools control and bottom
  sheet containing every desktop drawing tool;
- expose active tool, undo, redo, delete and object list near the chart;
- add a gesture state machine for pan, long-press inspect/crosshair, draw and
  pinch, including `pointercancel` recovery;
- add `viewport-fit=cover` and safe-area padding;
- enforce usable touch targets without visually bloating icons;
- prevent indicator chips, comparison controls, timezone and the price axis from
  covering one another;
- make the volume-profile panel fully dismissible and open it from the shared
  indicator menu instead of pinning it over the chart;
- collapse the large mobile screener options behind one Parameters control;
- make Strategy Studio use the full mobile viewport instead of rendering only
  half of the editor;
- use compact cards for dense mobile tables with an optional full-table view.

Acceptance matrix: 360x800, 390x844, 430x932, mobile landscape, 768x1024,
1024x768 and 1440x900, plus keyboard operation and 200% text size.

## Phase 3 — PWA and first-run onboarding

- persist owner-scoped workspaces containing layout, symbols, timeframes,
  timezone, indicators, drawings, panels and selected strategy revisions;
- provide autosave state, list/rename/duplicate/archive, import/export and
  conflict-safe restoration across tabs;
- add 192 and 512 icons, a maskable icon and Apple touch icon;
- strengthen the PWA CI check for required icon purposes and sizes;
- implement install/update UX only when browser capability and secure context
  exist; a public IP over HTTP must not show a dead install action;
- offer the offline research bundle only on localhost or in a secure context;
  public HTTP retains ordinary file export without promising PWA/offline;
- store owner-scoped onboarding progress;
- guide a new user from goal selection to a first chart, research alert,
  backtest or paper robot without requesting exchange keys;
- link the relevant self-hosting and user documentation from each empty state.

## Phase 4 — durable server-side alerts

- extend the existing research-alert outbox rather than create another delivery
  system;
- support price thresholds/crosses, RSI/MACD/EMA conditions, drawing-line
  crosses and paper-robot health/drawdown events;
- evaluate closed candles by default and retain data provenance/freshness;
- use durable leases, retries, backoff and deduplication keys;
- deliver to in-app history and Telegram before HTTPS; Web Push stays disabled;
- enforce owner quotas and bounded multi-timeframe work.

Saved technical-screen results become alert sources only after Phase 12 ships;
Phase 4 itself covers the existing research rules and the conditions above.

Acceptance: alerts run with the browser closed, survive restart, do not duplicate
one transition and never expose another tenant's rule or delivery.

## Phase 5 — paper-robot analytics and Telegram companion

- derive realized/unrealized PnL, paper balance/equity/margin, fees, simulated
  funding, win rate, profit factor, expectancy, drawdown and exposure from
  durable fills and snapshots;
- version metric formulas and backfill idempotently;
- build a running-robots overview and detailed journal/equity screen, using
  mobile cards and a sticky summary;
- bind/revoke Telegram chats through owner-scoped one-use codes, and add paper
  balance, daily, performance, trades, alerts, pause and report commands;
- keep all Telegram mutations paper-only and confirmation-bound.

Acceptance: totals reconcile with golden ledgers and do not reset or double after
restart; incomplete evidence is labelled unavailable rather than shown as zero.

## Phase 6 — DCA paper robot

- base and safety orders, step/volume scales and bounded reserved capital;
- take profit, stop loss, trailing exit and cooldown;
- one explicit lifecycle state machine shared by replay and paper execution;
- pre-run maximum-capital and worst-case summary;
- deterministic restart and idempotent event recovery.

Acceptance: limits and verified instrument rules cannot be exceeded, and the same
price path produces the same replay and paper result.

## Phase 7 — Grid paper robot

- arithmetic and geometric grids with explicit bounds and level count;
- neutral/long/short paper modes, inventory and capital limits;
- recenter, outside-range pause and stop conditions;
- fee, partial-fill, gap and restart handling without duplicate orders;
- separate realized grid PnL, inventory PnL and drawdown.

Acceptance: a gap cannot create an unbounded cascade and restart cannot duplicate
levels or reservations.

## Phase 8 — spread trading and inefficiency research (paper only)

- normalize executable bid/ask depth, fees, funding assumptions, timestamps,
  clock quality, freshness and venue identity;
- cover spot/perpetual, cross-venue, native spread, triangular, funding and
  separately labelled options-parity research;
- show gross spread, net forecast, executable size, evidence quality and every
  reason that makes an opportunity unavailable;
- model both legs, partial fills, latency, leg risk and unwind through one
  durable paper intent group;
- enforce per-owner capital, venue, symbol and concurrency limits;
- keep the large mobile parameter surface collapsed behind one control.

Acceptance: stale or insufficient depth is never presented as executable, paper
PnL accounts for both legs and modeled costs, and no live order path is enabled.

## Phase 9 — strategy generator and genetic optimizer

- evolve only validated, versioned Strategy IR rather than arbitrary code;
- keep the deterministic algorithmic generator independent of OpenAI or any
  hosted model; a future optional BYO assistant must pass the same IR gates;
- provide bounded parameter/operator/indicator/timeframe/risk mutations and
  compatible subtree crossover with deterministic repair or rejection;
- use seeded randomness and persist dataset, engine, seed and candidate lineage;
- select by a multi-objective Pareto frontier including return, drawdown,
  stability, turnover and complexity instead of one opaque score;
- require walk-forward and out-of-sample evidence with leakage/lookahead guards;
- support a multi-symbol shared capital pool with exposure/correlation limits;
- run in owner-fair workers with CPU, memory, population, generation and timeout
  quotas, cancellation and checkpoints.

The first evolutionary run is gated on a canonical Strategy IR, versioned
dataset contract and reproducible backtest engine.

Acceptance: the same seed and dataset reproduce the same candidates, and a
candidate cannot be promoted without out-of-sample and overfit evidence.

## Phase 10 — ML order-book behaviour research

### 10A. Corpus capture

- record bounded sequence-aware L2 snapshots/deltas and trades with gap and
  reconnect boundaries;
- define venue licensing, retention, compression, quality and replay contracts;
- run a separate four-to-eight-calendar-week capture soak across representative
  market regimes; more CPU cannot substitute for elapsed market data.

### 10B. Features, baseline and model

- derive imbalance, microprice, spread/depth slope, replenish, add/cancel/trade
  intensity, absorption and sweep features;
- describe spoof-like and iceberg-like patterns as probabilistic research
  signals, never as identified people or proven intent;
- establish rule/statistical baselines before complex models and version every
  feature schema, model and dataset fingerprint;
- use time-split validation, calibration, drift detection, precision/recall and
  an explicit abstain state for low-quality data;
- expose confidence, data quality and a replayable evidence window in the UI.

Acceptance: stale/gapped data cannot produce a normal signal and every result is
reproducible from a retained evidence window and model version.

## Phase 11 — funding, open interest, liquidations and MTF indicators

- normalize venue identity, contracts/base/quote units, exchange and receive
  timestamps, provenance, freshness and reconnect gaps;
- begin with public Binance and Bybit data and add venues only through conformance
  fixtures;
- provide funding history/countdown, OI change and filtered liquidation layers;
- let chart indicators select a source timeframe using only completed higher-timeframe
  candles, with no lookahead;
- bound retention, downsample history and move expensive series off the UI thread.

## Phase 12 — technical market screener

- screen a bounded universe by price/volume/change, RSI, moving-average crosses,
  MACD, ATR, market structure and later funding/OI;
- reuse the canonical candle and indicator engines;
- execute bounded server batches instead of one socket per pair;
- persist owner-scoped presets, sorting and pagination;
- open a result on the same chart symbol, timeframe and indicator context;
- allow a saved screen to become a durable alert.

Acceptance: screener values match the chart, stale or missing data cannot pass a
filter as normal and tenant presets remain isolated.

## Phase 13 — scaling and operational consolidation

- execute the Phase 1E ADR: one transactional system of record, or the specified
  PostgreSQL outbox and reconciliation with the legacy store;
- separate API and bounded research/backtest workers with per-owner queues,
  concurrency, timeout and memory quotas;
- add structured logs, request/job correlation, metrics and health signals;
- consolidate resilient public WebSocket primitives;
- enable WAL/busy timeout and bounded retention for remaining SQLite stores;
- add PostgreSQL-backed integration tests, coverage reporting and failure drills;
- validate a 100-active-user mix of charts, alerts, screeners, paper robots,
  backtests, optimizer and ML work;
- initial SLOs: ordinary API p95 at most 400 ms, internal chart delivery p95 at
  most 500 ms after ingest, application error rate below 1% excluding upstream,
  and event-loop-lag p95 at most 50 ms;
- target p95 queue wait of at most 5 seconds for interactive jobs and 30 seconds
  for heavy jobs, with explicit configurable CPU/memory/time limits;
- retain at least 30% sustainable CPU, RAM and disk headroom after the load run.

Acceptance: worker failure cannot take down login/chart traffic, duplicate jobs
remain idempotent, queues apply backpressure and an additional API instance does
not corrupt or fork trading state.

## Release grouping and estimates

These are engineering estimates, not calendar promises. They include tests,
documentation, review and stabilization.

| Release | Scope | Dependency | Estimated person-weeks |
| --- | --- | --- | ---: |
| R1 | Phase 1: safety, minimal workers and ADR | delivered Phase 0 | 1-3 |
| R2 | Phases 2-3: mobile, navigation, workspace, PWA/onboarding | R1 | 3-5 |
| R3 | Phases 4-5: alerts, running robots, analytics and Telegram | R1-R2 | 5-7 |
| R4 | Phase 6: DCA paper | R3 | 3-4 |
| R5 | Phase 7: Grid paper | R3-R4 | 4-5 |
| R6 | Phase 8: spread/inefficiency paper research | R3 | 4-6 |
| R7 | Phase 9: generator and genetic optimizer | R1 + canonical IR/backtest | 5-8 |
| R8 | Phase 10A: L2 capture/storage/quality | R1 + data contracts | 3-5 + 4-8 calendar weeks soak |
| R9 | Phase 10B: ML baseline/model/UI | R8 corpus | 5-8 |
| R10 | Phase 11: derivatives data and MTF | normalized data | 5-7 |
| R11 | Phase 12: technical screener | alerts + canonical indicators | 4-6 |
| R12 | Phase 13: consolidation and capacity proof | ADR + all workloads | 5-9 |

The implementation remains useful to self-hosters at every release: default
configuration is safe, all required services are documented and no hosted-only
dependency is required for monitoring, research, backtests or paper trading.
