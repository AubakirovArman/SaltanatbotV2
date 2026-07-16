# Pre-HTTPS development roadmap

Russian detailed plan: [ru/PRE_HTTPS_ROADMAP.md](./ru/PRE_HTTPS_ROADMAP.md).

This roadmap covers the public Research / Paper phase of SaltanatbotV2. SSL/TLS,
HTTPS termination and live exchange execution are deliberately outside its
scope: no active release below contains certificate, domain, reverse-proxy TLS
or secure-cookie activation work. Until a separate future security release is
approved, every deployed instance must use
`RUNTIME_PROFILE=public-http-paper`.

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
10. UI releases include a streamed-data performance soak and retain at least
    10% headroom in the main and heavy asynchronous bundle budgets.
11. Observability, global admission limits, backup/restore and failure handling
    are introduced by the releases that create each workload. R11 integrates
    and proves them; it is not their first implementation.

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

Status: 1A-1E foundations are implemented and tested. Production private/live wiring is
intentionally absent: routes and adapters retain deny-only authorizers, and this build rejects
`private-live` before startup side effects. This is not a live-readiness claim.

### 1A. Typed immutable runtime configuration

- parse booleans, integers, URLs, origins, proxy trust and paths strictly;
- reject unknown values instead of silently clamping or falling back;
- load configuration before database, filesystem and listener side effects;
- redact secrets from diagnostics;
- retain `DEMO_MODE` only as a temporary deprecated alias;
- retain pure future `private-live` types and HTTPS-boundary validation without exposing an
  operator activation path; the current loader rejects that value unconditionally.

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
- reserve each exact step in the durable owner-scoped ledger before handoff and consume it before
  the network callback;
- revoke risk-increasing work after disarm, role revocation or account changes;
- restrict emergency permits to cancel and true reduce-only flattening.

Acceptance: forged, expired, reused, cross-owner or wrong-capability permits are
rejected with zero network calls. The foundation is integrated and tested, while production
routes/adapters deliberately remain disconnected and deny-only.

Future `private-live` security blockers:

- authorization revocation must either finish durable cancel/reduce-only de-risking first or hand
  it to a separately authenticated, owner-scoped system emergency principal;
- replay-key archive/partition lookup must preserve exact-step duplicate detection while ensuring
  that a lifetime owner cap can never exhaust emergency or reconciliation issuance.

These blockers do not affect the current `public-http-paper` release because `private-live` is
rejected before startup side effects and every production signed adapter remains deny-only. They
must be implemented and reviewed before any future live activation.

### 1E. Minimal worker and queue foundation

- move jobs out of request handlers into a bounded worker process;
- provide durable leases, idempotency keys, retry/backoff and crash recovery;
- enforce per-owner concurrency, timeout, CPU, memory and result-size quotas;
- add request/job correlation, queue depth, duration and failure counters;
- bound terminal artifacts by the first of 30 days, 200 jobs or 256 MiB per
  owner; retain at most 1,000 compact exact-request tombstones for 90 days;
- decide an ADR early: one PostgreSQL system of record, or a PostgreSQL outbox
  with formally specified reconciliation to legacy SQLite.

The accepted decision is [ADR 0001: execution authority and system of record](adr/0001-execution-authority-and-system-of-record.md).

Acceptance: a worker crash cannot stop login/chart traffic or lose a queued job,
and a retried job cannot publish a duplicate result.

## Status vocabulary for the remaining releases

Each release below separates six questions so that an existing partial feature
is not mistaken for completed product work:

- **Status** — delivered, active or planned.
- **Baseline** — behavior already present in the repository and backed by
  existing tests or operator evidence.
- **Remaining** — work that is not yet complete.
- **Dependencies** — contracts that must exist before implementation starts.
- **Evidence** — artifacts required for review.
- **Exit criteria** — the externally observable condition that closes the
  release.

## R2 — mobile chart, navigation and Strategy Studio

**Status:** active. The reported volume-profile, screener, price-axis and
half-width Strategy Studio defects are fixed. Mobile drawing tools, the touch
state machine, short landscape, coarse tablets, the automated viewport/browser
matrix and the threshold-enforced stream/render soak are now accepted. Manual
Android Opera and assistive-technology smoke checks remain, so R2 is still
`active`. The bundle checker enforces a mandatory 10% reserve against reviewed
round caps.

**Baseline:**

- the mobile shell uses compact primary navigation with contained labels;
- volume profile is opt-in through the common indicator flow, and both its
  settings and rendered profile can be removed without a blank overlay;
- indicator, comparison and profile controls reserve the price-axis safe area in
  single- and split-chart layouts, with coarse-pointer controls at least 44 px;
- the screener mode selector remains collapsed with contained/ellipsized labels
  through the 760 px mobile breakpoint;
- Strategy Studio library, editor and parameters use one full-width mobile pane
  with useful height rather than a clipped half-width desktop layout.
- every desktop drawing tool is available from a 44 px mobile control and
  searchable bottom sheet, with active tool, undo, redo, delete and object list;
- pan, long-press inspect, draw and pinch use an explicit touch state machine
  with pointer-cancel, lost-capture and orientation-reset handling;
- dense arbitrage results default to compact cards with an explicit full-table
  alternative.
- `ChartWorkspaceRuntime` owns high-frequency candle/compare/position/watchlist
  work and is mounted only in Monitoring, so market ticks do not own the
  application shell or hidden Strategy/Trading/Screener trees;
- hidden/maximized panes and closed markets panels disable their hooks and
  release sockets, timers and polling. The separate alert feed intentionally
  keeps quotes only for distinct untriggered/armed alert symbols and opens no
  socket when none are armed;
- same-timestamp forming-candle updates are coalesced to 250 ms and use an O(1)
  provisional tail over immutable structural history; copying the retained
  series is reserved for snapshots, new timestamps and history prepend;
- a synthetic desktop/mobile Chromium soak harness now records subscriptions,
  render scopes, candle-copy pressure, long tasks, event-loop delay, CDP
  heap/DOM counters and task duty, including a Monitoring → Strategy →
  Monitoring release/recovery phase;
- the authoritative 2026-07-16 pinned run passed both five-minute profiles
  without retry (`2/2` in `11.7 min`), with every strict summary check true.

**Remaining:**

- complete the manual Android Opera and VoiceOver/NVDA/TalkBack smoke record.

**Dependencies:** R1 runtime boundary and the existing chart/strategy state
contracts.

**Evidence:** 74 Chromium E2E journeys, 18 Firefox critical journeys, six
container visual snapshots, screenshots and geometry assertions at 320, 360,
390, 430, 600, 760, 761, 768, 1024 and 1440 CSS pixels, mobile landscape,
touch/keyboard journeys, `pointercancel`, 200% text and the accepted automated
stream/render artifact. The manual Opera/assistive-technology record remains.
See the exact metrics and SHA-256 values in the
[R2 stream/render soak evidence](evidence/R2_STREAM_RENDER_SOAK.md);
the authoritative commands are `npm run test:soak:container` for the full
pinned run and `npm run test:soak:quick:container` for non-acceptance wiring.

**Exit criteria:** the chart price, price axis, indicator controls, volume
profile, drawings and all Strategy Studio panels remain visible, dismissible and
operable at every accepted size, with no horizontal document overflow; the
full soak passes its documented thresholds; and the manual Android Opera and
VoiceOver/NVDA/TalkBack records are complete.

## R3 — administrator lifecycle, workspaces and first-run workflow

**Status:** planned hardening on top of a delivered authentication and workspace
baseline.

**Baseline:**

- PostgreSQL registration creates `pending` users; administrators can activate,
  disable and assign application/trading roles;
- the bootstrap administrator receives a one-time password and must change it;
- disablement and permission changes revoke sessions and owner-scoped private
  streams;
- administrators do not inherit access to another owner's workspace, journal,
  portfolio or Telegram binding;
- owner-scoped workspace CRUD, optimistic revision conflicts, rollback and at
  most 20 retained revisions are implemented; the HTTP document limit is 1 MiB.

**Remaining — administrator lifecycle:**

- present one auditable flow for pending review, role selection, activate,
  disable, reactivate and session revocation;
- require an explicit reason for privileged role changes and retain actor,
  target, before/after roles and time without logging passwords;
- prevent self-disable and accidental removal of the last active administrator;
- document bootstrap, mandatory password change, administrator recovery and
  registration maintenance mode;
- paginate and filter the user list, and prove that an administrator cannot use
  admin APIs to impersonate a tenant or read tenant-owned product data.

**Remaining — workspaces and onboarding:**

- persist layout, symbols, timeframes, timezone, indicators, drawings, panel
  state and selected strategy revision as one versioned owner document;
- add list, rename, duplicate, archive, import/export and explicit
  `Saved / Saving / Conflict / Failed` states;
- keep optimistic revision checks: a stale tab receives `409` with current
  metadata and must reload, keep a conflict copy or explicitly retry; silent
  last-write-wins is forbidden;
- enforce configurable initial quotas of 25 active workspaces, 75 total
  including archived workspaces, 20 revisions per workspace, 1 MiB per imported
  document and 64 MiB retained workspace payload per owner; over-limit writes
  fail without deleting existing revisions;
- add owner-scoped onboarding from goal selection to a first chart, backtest,
  research alert or paper robot, never requesting exchange keys;
- retain ordinary export over HTTP; install/update and offline-bundle actions
  appear only on localhost or a browser-reported secure context. No HTTPS work
  is part of this release.

**Dependencies:** R1, stable owner IDs and the current workspace schema/migration
path.

**Evidence:** two-owner and two-admin isolation tests; stale-tab conflict tests;
quota boundary tests; admin audit/session-revocation tests; fresh-account E2E;
export/import checksum tests; backup/restore of users and workspaces.

**Exit criteria:** an administrator can safely complete the full account
lifecycle, while a normal user can create, recover and resolve conflicts in a
useful workflow without any cross-tenant access or silent data loss.

## R4 — “Running” and the paper portfolio contract

**Status:** planned consolidation. A browser robot/portfolio center and
owner-scoped paper state exist, but they are not yet the complete durable
contract below.

**Baseline:**

- the UI has loading, error and empty states and groups available robot/account
  state by owner;
- bots, orders, fills, journal rows and portfolio reads are owner-filtered;
- missing margin or borrowing evidence is not synthesized.

**Remaining:**

- publish a versioned `paper-portfolio-v1` snapshot owned by the singleton
  trading executor and derived only from durable paper intents, orders, fills,
  fees, simulated funding and valuation marks;
- include `asOf`, valuation currency, evidence/freshness state, balance, reserved
  capital, equity, realized/unrealized PnL, exposure, drawdown, positions, open
  orders, robot summaries and last error;
- define simulated margin and borrowing explicitly; return `unavailable` when
  the paper model has no evidence instead of returning zero or reusing a real
  exchange value;
- version PnL, win-rate, profit-factor, expectancy and drawdown formulas and
  make every backfill idempotent;
- provide honest empty state, filters, sticky summary, mobile cards, desktop
  table/detail drawer, and confirmation-bound pause/resume/stop;
- bind every snapshot and mutation to owner, portfolio, bot revision and
  idempotency key so restart cannot duplicate fills, reservations or commands.

**Dependencies:** R1 execution ledger, R3 owner/workspace lifecycle and ADR 0001
authority boundaries.

**Evidence:** golden-ledger reconciliation; restart at each lifecycle boundary;
stale-mark/unavailable-state tests; concurrent command/idempotency tests;
cross-owner REST/WS tests; mobile and desktop E2E.

**Exit criteria:** totals before and after restart are identical, every value has
defined evidence and time, and no administrator or second tenant can read or
mutate the portfolio.

## R5 — alerts, technical screener MVP and notifications

**Status:** planned integration on top of existing research-alert and indicator
engines. The technical screener is intentionally moved earlier so it can feed
alerts before robot strategy expansion.

**Baseline:**

- research alerts already demonstrate a durable at-least-once outbox pattern;
- chart candle and indicator engines provide canonical values;
- read-only arbitrage research already exposes freshness and evidence states.

**Remaining — technical screener MVP:**

- screen a bounded universe for price, volume, change, RSI, SMA/EMA crosses,
  MACD and ATR using the same closed-candle engine as the chart;
- execute bounded server batches instead of one browser socket per symbol;
- store owner-scoped presets, pagination, sorting, run history and an
  `unavailable/stale` state that can never pass a filter as normal;
- open a result with the same symbol, timeframe and indicator context;
- defer funding, OI and ML filters until their data contracts are delivered.

**Remaining — alerts and delivery:**

- make PostgreSQL authoritative for multi-user alert policies, transitions,
  in-app history, Telegram bindings and the notification outbox, with an
  idempotent import from retained legacy alert rows as required by ADR 0001;
- evaluate price/indicator/drawing/screener and paper-robot health/drawdown
  events with provenance and closed-candle defaults;
- run evaluation and delivery outside the API request path with owner fairness,
  bounded leases, retry/backoff, dead-letter state and quotas;
- use a dedicated notification worker that never opens trading SQLite and never
  receives exchange credentials. Its provider credential comes from operator
  configuration, while owner/chat bindings stay in PostgreSQL;
- persist the outbox row before sending. A provider may accept a Telegram
  message before the worker records acknowledgement, so delivery is
  **at-least-once**, not exactly-once; every delivery carries a stable
  deduplication ID and duplicate possibility is documented;
- bind/revoke Telegram through owner-scoped one-use codes and limit commands to
  paper balance, reports, alerts and confirmation-bound pause/resume/stop;
- keep Web Push disabled because HTTPS is outside this roadmap.

**Dependencies:** R1 queue/ADR foundation, R3 ownership, R4 paper metrics and the
canonical candle/indicator engine.

**Evidence:** chart-versus-screener golden fixtures; browser-closed alert test;
worker crash before/after provider acceptance; Telegram 429/timeout/retry tests;
duplicate-ID evidence; owner quota and isolation tests; migration reconciliation.

**Exit criteria:** a saved screen can produce an owner-scoped alert with the
browser closed, restarts lose no durable transition, duplicates are bounded and
identifiable, and notification failure cannot stall login, charts or paper
execution.

## R6 — DCA paper robot

**Status:** planned.

**Baseline:** deterministic strategy/backtest and paper execution primitives are
available; no completed DCA product is claimed.

**Remaining:** base and safety orders, step/volume scales, bounded reserved
capital, TP/SL/trailing exit/cooldown, one lifecycle state machine shared by
replay and paper execution, pre-run maximum-capital/worst-case summary, and
idempotent recovery.

**Dependencies:** R4 portfolio/journal and R5 health alerts.

**Evidence:** deterministic path fixtures, gaps/partial fills/fees, restart at
every state, quota rejection and property tests for capital bounds.

**Exit criteria:** one price path produces the same replay and paper result,
instrument/capital limits cannot be exceeded, and restart creates no duplicate
order or reservation.

## R7 — Grid paper robot

**Status:** planned.

**Baseline:** generic paper lifecycle components exist; a completed Grid product
is not claimed.

**Remaining:** arithmetic/geometric levels, neutral/long/short paper modes,
inventory/capital/order-count limits, recenter and outside-range behavior,
preview on chart, fee/partial-fill/gap/restart handling, and separate grid versus
inventory PnL.

**Dependencies:** R4 portfolio/journal and R6 shared robot lifecycle lessons.

**Evidence:** bounded-level property tests, gap/cascade scenarios, partial-fill
fixtures, restart/recovery tests and mobile preview/management E2E.

**Exit criteria:** worst-case capital is visible before start, a gap cannot
create an unbounded cascade, and restart cannot duplicate levels or reserves.

## R8 — spread trading and market-inefficiency research (paper only)

**Status:** planned product integration on top of substantial read-only
arbitrage engines. Existing research rows are not a claim of executable trading.

**Baseline:** public spot/perpetual, cross-venue, native spread, triangular,
funding, options-parity and multi-leg research includes bounded economics and
freshness evidence; all routes remain read-only/non-executable.

**Remaining:**

- normalize executable bid/ask depth, fees, funding/borrow/transfer assumptions,
  timestamps, clock quality, freshness and exact venue/instrument identity;
- show gross spread, net forecast, executable paper size, confidence and every
  unavailable reason;
- create one durable paper intent group for all legs and model latency, partial
  fill, leg risk and unwind;
- enforce owner capital, venue, symbol and concurrency limits;
- feed the common portfolio, journal and alert contracts;
- keep the mobile mode/parameter surface collapsed by default.

**Dependencies:** R4 journal, R5 alerts, verified public depth/identity contracts
and the R1 execution ledger.

**Evidence:** stale/gap/clock-skew rejection, matched-depth fixtures, leg-failure
and unwind simulations, cost/PnL reconciliation and proof of zero private/signed
network calls.

**Exit criteria:** no row is labelled paper-executable without sufficient fresh
depth, and paper PnL accounts for every leg and declared modeled cost without
opening any live path.

## R9 — strategy generator and genetic optimizer

**Status:** planned server-grade evolution. A bounded browser parameter optimizer
and structural generator exist, but no complete owner-fair multi-market
evolution pipeline is claimed.

**Baseline:** validated Strategy IR, seeded parameter mutation/crossover and
deterministic structural candidate generation already have bounded browser-side
implementations.

**Remaining:**

- evolve only versioned Strategy IR, never arbitrary code;
- gate the first server evolutionary run on a canonical IR, versioned dataset
  contract and reproducible backtest engine;
- add bounded parameter/operator/indicator/timeframe/risk mutation, compatible
  subtree crossover and deterministic repair/rejection;
- persist seed, dataset/engine fingerprints and full candidate lineage;
- select a Pareto frontier over return, drawdown, stability, turnover and
  complexity, with mandatory walk-forward/out-of-sample evidence and leakage
  guards;
- support a shared multi-symbol paper capital pool with exposure/correlation
  limits;
- execute in owner-fair workers with population, generation, CPU, memory,
  timeout, cancellation and checkpoint quotas;
- keep any future AI assistant optional/BYO and subject to the same IR gates.

**Dependencies:** R1 workers, canonical IR/dataset/backtest contracts and R4
portfolio metrics.

**Evidence:** seed reproducibility, dataset immutability, leakage/lookahead
adversarial tests, quota/cancellation/restart tests and independent OOS reports.

**Exit criteria:** the same seed and dataset reproduce the same lineage and no
candidate can be promoted without OOS and overfit evidence.

## R10A — public derivatives/MTF, L2 corpus, storage and quality gates

**Status:** planned. The current administrator-only ML surface accepts bounded
uploaded/reconstructed snapshots in memory; there is no online collector or
durable model registry.

**Baseline:** existing public adapters can reconstruct selected sequence- or
checksum-verified books and the research API already fails closed on malformed
uploaded evidence.

**Remaining:**

- define a licensed venue/symbol schema for snapshots, deltas and trades,
  including native sequence/checksum, exchange/receive clocks, reconnect
  generation and explicit gap records;
- normalize public funding, open interest and liquidation feeds with exact
  contract/base/quote units, provenance, freshness and reconnect gaps; derive
  multi-timeframe inputs only from completed higher-timeframe candles without
  lookahead;
- partition and compress an append-only corpus with bounded hot/warm retention,
  checksums, replay manifests and deletion policy;
- cap source streams, bytes/day and disk watermark globally; reaching a
  watermark stops new capture before it threatens PostgreSQL, login or journals;
- complete at least four calendar weeks of capture per accepted scope, target at
  least 95% scheduled collector uptime and 99.9% schema-valid accepted events,
  and retain every missing interval as an explicit gap rather than fabricating
  continuity;
- include multiple documented volatility/liquidity regimes and a
  four-to-eight-week soak report. More CPU cannot replace elapsed market time.

**Dependencies:** R1 workers/storage policy, reviewed venue licences and stable
public L2 protocol adapters.

**Evidence:** byte/storage forecasts, replay digest equality, gap/reconnect
fixtures, disk-watermark drill, capture uptime/quality dashboard and retained
soak manifest.

**Exit criteria:** a retained window replays deterministically, every gap is
machine-visible, storage remains within configured bounds, and the corpus meets
the pre-registered duration/quality gates before model training starts.

## R10B — ML order-book behavior research

**Status:** planned after R10A; no production model claim exists.

**Baseline:** uploaded-session research already provides past-only features,
chronological splits and a bounded ridge baseline, but it is in-memory,
administrator-only and not an online signal.

**Remaining:**

- derive versioned imbalance, microprice, spread/depth slope, replenishment,
  add/cancel/trade intensity, absorption and sweep features;
- describe spoof-like/iceberg-like patterns only as probabilistic aggregate
  signals, never identified people or proven intent;
- register dataset, feature schema, label horizon, code revision and model
  artifact together;
- require rule/statistical baselines first, purged chronological
  train/validation/test splits, train-only normalization, calibration,
  precision/recall/false-positive reporting and drift monitoring;
- promote a model only if it beats the declared baseline on untouched test data,
  remains calibrated within pre-registered tolerance and passes leakage,
  replay, latency and resource budgets;
- abstain on stale, gapped, out-of-distribution or low-confidence evidence and
  expose a replayable evidence window in the UI.

**Dependencies:** accepted R10A corpus and model-governance/storage contracts.

**Evidence:** immutable model card, dataset/replay manifest, baseline comparison,
leakage tests, calibration/drift report, abstention fixtures and bounded
inference load test.

**Exit criteria:** every displayed signal resolves to one retained evidence
window and model version, bad data produces `abstain/unavailable`, and no signal
can start live execution.

## R11 — capacity and operational proof for about 100 active users

**Status:** planned validation; the large current host snapshot is not a
100-user guarantee.

R3-R10 incrementally deliver the workload caps, metrics, readiness, backup
evidence and load fixtures they need. R11 combines them into one reproducible
capacity and failure-recovery proof.

**Baseline:** API and worker PostgreSQL pools, authentication hashing, shared
market subscriptions, slow-client disconnects, owner-scoped job quotas,
retention and a separate bounded research worker are implemented. ADR 0001 keeps
one authoritative trading executor.

**Remaining:** implement the missing global admission caps, metrics and
dashboards; run the quantified workload, failure drills, backup/recovery targets
and second-API fencing prerequisites in
[Capacity plan for the first 100 users](CAPACITY_100_USERS.md).

**Dependencies:** all workloads selected for the capacity claim, stable schemas
and accepted ADR 0001 reconciliation.

**Evidence:** repeatable load-test configuration/results, p50/p95/p99 and
event-loop/queue/database/resource graphs, failure-drill reports, backup/restore
timings and at least 30% sustainable CPU, RAM and disk headroom.

**Exit criteria:** admitted load meets the documented SLOs, overload is rejected
with bounded backpressure, worker/provider/storage failures do not take down
login/chart traffic, and no second process can fork paper/trading state.

## R12 — documentation, reproducible self-hosting and release consolidation

**Status:** planned final pre-HTTPS consolidation. Existing documentation is a
strong baseline but must be revalidated against the completed releases.

**Baseline:** English, Russian and Kazakh operator/user documentation, generated
API references, verified runtime backup/restore, migrations, release packaging,
secret scan and rollback-drill tooling already exist.

**Remaining:**

- reconcile API, architecture, configuration, security, threat model,
  self-hosting, user guides and screenshots with the shipped contracts;
- document every quota, worker, retention policy, alert delivery duplicate
  boundary, L2/model gate, capacity result and recovery decision;
- run fresh-clone install → dedicated project PostgreSQL → bootstrap admin →
  mandatory password change → migrations → sample workspace/screener/backtest/
  paper robot → backup → isolated restore → upgrade;
- verify Docker Compose and direct-host paths without adding or touching another
  project's ports, databases, containers or services;
- publish a migration/rollback note and machine-readable evidence index for each
  release.

**Dependencies:** R2-R11 accepted.

**Evidence:** clean-host/fresh-clone transcript, link and generated-doc checks,
restored-data checksums, release archive/SBOM/provenance and rollback-drill
report.

**Exit criteria:** a new operator can reproduce the supported Research/Paper
system from the repository and recover it using only documented steps. SSL/TLS,
HTTPS and live activation remain absent and unclaimed.

## Release order, dependencies and estimates

These are estimates for the remaining delta, not calendar promises or a second
estimate of the delivered baseline. They include tests, documentation, review
and stabilization.

| Release | Scope | Dependency | Estimated person-weeks |
| --- | --- | --- | ---: |
| R1 | Safety, execution ledger, minimal workers and ADR | delivered Phase 0 | delivered foundation |
| R2 | Mobile chart/navigation/Strategy Studio | R1 | 2-3 |
| R3 | Admin lifecycle, workspaces and onboarding | R1-R2 | 3-5 |
| R4 | “Running” and paper portfolio/journal contract | R1-R3 | 3-5 |
| R5 | Alerts + technical screener MVP + notifications/Telegram | R3-R4 | 5-7 |
| R6 | DCA paper | R4-R5 | 3-4 |
| R7 | Grid paper | R4-R6 | 4-5 |
| R8 | Spread/inefficiency paper research | R4-R5 | 4-6 |
| R9 | Generator/genetic optimizer | R1 + canonical IR/dataset/backtest | 5-8 |
| R10A | Funding/OI/MTF + L2 capture/storage/quality | R1 + public data contracts | 3-5 plus 4-8 calendar weeks soak |
| R10B | ML baseline/model/UI | accepted R10A corpus | 5-8 |
| R11 | 100-user capacity and operational proof | accepted workload contracts | 5-9 |
| R12 | Documentation, fresh clone, recovery and release consolidation | R2-R11 | 2-4 |

R8, R9 and the R10A capture implementation may overlap after their shared
contracts stabilize, but one state machine or schema must not be changed by two
releases without an explicit integration migration.

The implementation remains useful to self-hosters at every release: default
configuration is safe, all required services are documented and no hosted-only
dependency is required for monitoring, research, backtests or paper trading.
There is no “temporarily enable live” or active SSL/HTTPS task in this roadmap.
