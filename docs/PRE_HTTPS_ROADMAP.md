# Pre-HTTPS development roadmap

Russian detailed plan: [ru/PRE_HTTPS_ROADMAP.md](./ru/PRE_HTTPS_ROADMAP.md).

This roadmap covers the public Research / Paper phase of SaltanatbotV2. SSL/TLS,
HTTPS termination and live exchange execution are deliberately outside its
scope: no active release below contains certificate, domain, reverse-proxy TLS
or secure-cookie activation work. Until a separate future security release is
approved, every deployed instance must use
`RUNTIME_PROFILE=public-http-paper`.

No R0-R12 release depends on a domain, certificate, reverse proxy or TLS. That
boundary changes only if the project owner separately initiates and approves a
new HTTPS/security roadmap.

Current production status is the accepted R9.2 release (server GA evolution
with lineage, Pareto ranking and OOS promotion) on PostgreSQL schema 17 and
unchanged trading SQLite schema 10, deployed through the additive
`ga_evolution_lineage` 16→17 migration from protected slot
`r9b-schema17-3ed6af1` at commit
`3ed6af138f197ee985bd8ac998ab58cc8769b83c`. The acceptance record is
[R9.2 GA evolution](./evidence/R9_2_GA_EVOLUTION.md); with it R9.2 is
complete, R9 itself remains in progress and the next pending increment is
R9.3.

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
- in-app notifications that do not expose exchange secrets; the accepted
  R5.3b-1 release adds Telegram delivery and owner-scoped chat binding, and
  the accepted R5.3b-2 release adds paper-only inbound Telegram commands over
  the fenced executor.

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
   Coverage is measured and retained as a release artifact: after recording an
   honest baseline, new modules and changed authorization, worker, paper-ledger
   and notification paths may not reduce line/branch/function coverage and
   require direct failure-path tests. A high aggregate percentage alone is not
   sufficient evidence.
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
12. Test accounts are created through bootstrap/admin APIs in an isolated
    project-owned database. Direct SQL role assignment in a running environment
    is not an accepted audit or E2E setup procedure.
13. Accepted decision D1 applies to `main`: the documented owner-only exception
    permits direct publication only after exact-worktree local gates and a
    remote-head recheck, with mandatory GitHub Actions verification for the
    exact pushed SHA. Production cutover before green is forbidden; the full
    contract is [ADR 0002](adr/0002-owner-only-direct-main-release-gate.md).
14. Every accepted release installs from a fresh clone without a mandatory
    hosted-only dependency. External providers are optional, disabled by default
    and documented as BYO; Monitoring, Research, Backtest and Paper workflows
    remain self-hosted.
15. Before any mutating release command, evidence records the exact project
    root, user-systemd units, Compose project/container, listener ports,
    database names and data directories. Identity mismatch or a port collision
    stops the operation. Kill-by-port, broad `pkill`, global Docker prune/down,
    root-systemd changes, `DROP/ALTER` against another database and reuse of
    another project's volumes are forbidden. A collision uses another free
    project-owned port; the foreign process is never stopped.

## Central decision log

An open decision may not be hidden inside implementation work. Its owner records
the selected option and evidence in an ADR or issue before the stated gate. While
the status remains `open`, the fail-closed fallback applies; it cannot waive a
dependency or enable HTTPS/live execution.

| ID | Status | Decision | Owner | Decide-by gate | Fail-closed fallback |
| --- | --- | --- | --- | --- | --- |
| D1 | decided | [ADR 0002: owner-only direct-main release gate](adr/0002-owner-only-direct-main-release-gate.md) — direct push only after exact-worktree local gates, remote-head/fast-forward recheck and no force | project owner + release maintainer | accepted 2026-07-17; applies to R3.3 and every direct-main release | production cutover stays blocked until Actions for the exact SHA are green; failure uses a gated fix-forward or new `git revert`, and a required-check ruleset supersedes this ADR |
| D2 | decided | [ADR 0003: canonical IR, dataset and backtest contract](adr/0003-canonical-ir-dataset-backtest-contract.md) — canonical Strategy IR `IR_VERSION 4` with a pinned checksum guard in `npm run check`, the versioned `dataset-v1` fingerprint/embargo time-split contract and the deterministic engine version `backtest-core-v1` | R9 technical owner + architecture maintainer | accepted 2026-07-18; closed before the R9.1 schema/job API and first server evolutionary run as required | server GA/generator surfaces are now permitted; promotion and the gallery stay forbidden until R9.2/R9.3 deliver their gates |
| D3 | open | Exact licensed R10A scope: venues, native symbols/markets, source terms, hot/warm retention, downsampling and deletion policy | project owner + market-data/ML maintainer | before R10A.2 online ingest and the corpus soak start | online collection stays disabled; only bounded uploads/read-only adapters for documented permitted sources remain, and R10B is blocked |

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
- apply the accepted ADR: PostgreSQL owns identity, sessions, workspaces, jobs
  and tenant alert/outbox data, while a fenced executor owns protected legacy
  execution data with durable command IDs and idempotent acknowledgements.

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

**Status:** delivered and deployed in R3 on schema 11. R3.1, R3.2 and R3.3 with
its required O1 slice remain accepted historical increments. Production later
advanced through the accepted R4 schema-12/schema-9, R5.1 schema-13, R5.2.1
schema-14, R5.3a schema-14, R5.3b-1 schema-15, R5.3b-2 schema-16, R5 chart
research tools, R6 DCA paper robot, R7 grid paper robot, R8 multi-leg paper
intents and R9.1 server multi-market evaluation releases and now runs the
accepted R9.2 server GA evolution release on schema 17 and trading SQLite
schema 10.

**Baseline:**

- PostgreSQL registration creates `pending` users; administrators can activate,
  disable and assign application/trading roles;
- the bootstrap administrator receives a one-time password and must change it;
- atomic lifecycle and permission changes require a reason and expected
  authorization revision, retain before/after audit state, and revoke sessions
  and owner-scoped application event streams; these are not exchange-private
  WebSocket streams;
- users and administrators can list/revoke opaque public session IDs; current
  session revocation clears cookies and reconciles the UI;
- guarded administrator recovery verifies the exact checked-in schema, never
  runs migrations and requires a password change after recovery;
- schema v9 downgrades retained non-administrator live roles to paper, revokes
  affected sessions/tickets and prevents the role from being re-granted;
- administrators do not inherit access to another owner's workspace, journal,
  portfolio or Telegram binding;
- owner-scoped workspace CRUD, archive/restore/purge, strict import/export,
  optimistic conflicts, server rollback and configurable count/byte quotas are
  implemented;
- the schema-v8 browser document retains layout, per-pane market/timezone,
  indicators, drawings, panels, mode and an exact strategy revision/hash
  binding; synchronization exposes explicit saved/offline/conflict/quota/error
  states without silent last-write-wins.

Evidence:
[R3.1 identity control-plane acceptance](./evidence/R3_1_IDENTITY_CONTROL_PLANE.md)
and [R3.2 workspace workflow](./evidence/R3_2_WORKSPACE_WORKFLOW.md), plus
[R3.3 onboarding and operations](./evidence/R3_3_ONBOARDING_OPERATIONS.md).

**Delivered — R3.3 onboarding:** the complete build, browser, PostgreSQL,
recovery, CI and production cutover gates are recorded in the R3.3 evidence.

- owner-scoped onboarding now connects goal selection to a first chart,
  backtest, research alert or paper robot without requesting exchange keys;
- 192×192, 512×512, maskable and Apple Touch icons are enforced by the
  manifest CI contract;
- ordinary export remains available over HTTP, while install/update and
  offline-bundle actions appear only on localhost or a browser-reported secure
  context. No HTTPS work is part of this release.

### R3.3 + O1 executable implementation order

R3.3 was accepted as one compatible increment and executed internally in this
order:

1. **Configuration and schema 11.**
   - parse new limits, watermarks and TTL values strictly before database,
     filesystem or listener side effects;
   - add an owner-scoped onboarding row with one finite goal, milestone
     timestamps, derived status and an optimistic revision;
   - add a bounded component-heartbeat table containing only the required
     research worker generation, status, schema/release version and last
     heartbeat;
   - preserve existing workspaces and avoid forcing established users through
     a misleading first-run flow.
2. **Owner-scoped onboarding API.**
   - `GET /api/onboarding` reads only the authenticated principal;
   - `PUT /api/onboarding/goal` selects a finite goal, while
     `POST /api/onboarding/milestones`, `/dismiss` and `/restart` advance the
     same revisioned owner state;
   - stale writes receive stable `409 onboarding_conflict`;
   - responses use `Cache-Control: no-store`, a strict body limit and
     no credential, account or private-exchange fields.
3. **First useful journey.**
   - choose Monitoring, Price alert, Backtest or Paper robot;
   - create the existing server-synchronized workspace template;
   - expose one next action in every empty state;
   - support RU/EN/KK, keyboard use, 200% text and a mobile bottom sheet;
   - reload restores the workspace and resumes an incomplete onboarding step.
4. **HTTP-safe PWA boundary.**
   - a single capability check permits Service Worker, install/update and the
     offline bundle only in a browser secure context or on
     localhost/loopback;
   - `http://public-ip:4180` has no PWA launcher and registers no Service
     Worker, while ordinary workspace/strategy/report import and export remain
     available;
   - show install only after a real `beforeinstallprompt`; never use
     `skipWaiting`, and explain that all tabs must be closed for a waiting
     update;
   - require distinct 192, 512, maskable 512 and Apple 180 icons and keep
     `/arbitrage-stream` plus every runtime transport path network-only;
   - bound `navigator.serviceWorker.ready` with a timeout and hide PWA-specific
     recovery controls on public HTTP.
5. **First global admission controller.**
   - initial evidence-driven defaults are 128 total active API requests, of
     which 16 are reserved for control traffic; ordinary work may use 112
     active slots plus a queue of 256 and a two-second wait;
   - admission runs before large body parsers, including research job payloads;
   - cheap health remains outside admission; dependency-heavy readiness crosses
     the bounded ordinary lane and reports admission saturation as not-ready,
     while login/session/password, job cancellation and pause/stop controls for
     existing paper work retain reserved capacity outside the heavy queue;
   - readiness then crosses a separate bounded per-IP bucket; accepted overlap
     shares one process-wide dependency scan and its completed result for a
     short typed TTL, so many sources cannot multiply PostgreSQL/statfs work;
   - migration and heartbeat probes are sequential, the supported API pool
     minimum is two, and a full IP store reports its real prune horizon;
   - overflow returns stable `503 global_admission_exhausted` with
     `Retry-After`, and capacity is released on finish, close, abort and
     exception;
   - defaults are configurable and reviewed from load evidence, but ambiguous
     environment values cannot disable the controller.
6. **Readiness and minimum operational telemetry.**
   - keep `/api/health` as a cheap liveness endpoint;
   - make `/api/ready` versioned and cover migration checksum,
     PostgreSQL/pool, the singleton paper executor, worker heartbeat
     freshness, disk soft/hard watermarks and admission saturation;
   - expose readiness-limiter bounds/counters only in admin metrics; never in
     the public readiness response;
   - return `503 unready` for hard failures, `200 degraded` for soft
     watermark/saturation and `200 ready` otherwise;
   - expose only categorical component states publicly—no database name/path,
     PID, owner identifier, migration/checksum, latency, heartbeat age, disk
     capacity, admission counts or secret;
   - add admin-only fixed latency/status buckets, pool/admission metrics,
     queue/worker freshness, executor state, disk and the last verified
     recovery generation.
7. **Paired PostgreSQL + SQLite recovery generation.**
   - provide operator-only `backup/verify/restore/drill` commands and no HTTP
     restore endpoint;
   - bind one PostgreSQL custom dump and the existing verified SQLite runtime
     backup in a manifest with checksums, schema versions, release commit,
     capture interval and aggregate counts;
   - restore only into a new empty project-owned PostgreSQL database and a new
     absent/empty data directory;
   - reject the current target, non-empty targets, symlinks, a corrupted half
     of the generation or excessive capture skew;
   - never change systemd/Compose, `PGDATABASE` or runtime paths and never
     delete source or foreign resources.
8. **Acceptance and publication.**
   - two-owner isolation, stale revision and four fresh-account journeys;
   - a real insecure-origin browser test proves PWA controls are absent while
     ordinary export still works;
   - readiness failure matrix, public DTO redaction, no-store admission
     rejection, sequential two-connection pool reserve,
     single-flight/TTL expiry/error-retry and bounded per-IP store/prune-horizon
     tests, admission saturation/abort tests and worker heartbeat recovery;
   - corruption tests for each backup half and an isolated replacement restore
     drill;
   - record schema checksum, backup hashes, failure matrix and explicit
     `public-http-paper` proof in human-readable and machine-readable evidence;
   - after green local gates, update self-hosting/rollback documentation,
     commit to `main`, verify GitHub Actions and cut over only project-owned
     services.

**Dependencies:** backend R3 work began after R1 with stable owner IDs and the
workspace migration path. Its automated R2 browser, accessibility, visual and
soak gates passed before R3 publication. The still-open manual Android Opera and
assistive-technology matrix continues as a separate R2 record and does not
retroactively invalidate the deployed R3 release.

**Evidence:** two-owner and two-admin isolation tests; stale-tab conflict tests;
quota boundary tests; admin audit/session-revocation tests; fresh-account E2E;
export/import checksum tests; backup/restore of users and workspaces.

**Exit criteria:** an administrator can safely complete the full account
lifecycle, while a normal user can create, recover and resolve conflicts in a
useful workflow without any cross-tenant access or silent data loss.

### Cross-cutting O1 operational package starting in R3

This package is delivered in compatible increments by the release that creates
each workload rather than being postponed until R11:

- enable WAL, `busy_timeout`, integrity checks and bounded retention for
  project-owned SQLite stores;
- add structured logs and metrics for API latency, PostgreSQL pools, queues,
  workers, paper execution, WebSockets, market freshness, filesystem and
  backups;
- expand readiness to cover migration state, PostgreSQL, the singleton
  executor, required workers and a hard disk watermark;
- add global admission limits above owner quotas while keeping health, login and
  control of already-running work outside heavy queues;
- create paired PostgreSQL/SQLite backup generations with a manifest,
  checksums and restore into a new replacement database/data directory only;
- converge public market sockets on one transport with fan-out,
  reconnect/gap handling and slow-client backpressure;
- require every intentionally suppressed error in auth, paper execution,
  workers, notifications and market adapters to emit a structured log/counter
  and enter a defined degraded or fail-closed state;
- add bounded HTTP compression for JSON and textual static assets with measured
  wire-size/CPU benefit, excluding WebSocket, streaming and already-compressed
  files;
- publish a compatibility note and machine-readable evidence for every schema
  release.

**O1 acceptance:** every new workload has a limit, metric, readiness/degraded
state, backup scope and failure test before its owning release is accepted.

## R4 — “Running” and the paper portfolio contract

**Status:** delivered, accepted and deployed on PostgreSQL schema 12 and
trading SQLite schema 9 from protected slot `r4c-schema12-bb455fa` at commit
`bb455facdfe5a1b3cabe15490c86c299ea684ee7`; exact-SHA GitHub Actions run
`29560112312` passed all 6/6 jobs. Production has since advanced through the
accepted R5.1, R5.2.1, R5.3a, R5.3b-1, R5.3b-2, R5 chart research tools,
R6 DCA paper robot, R7 grid paper robot, R8 multi-leg paper intents and R9.1
server multi-market evaluation releases to the accepted R9.2 server GA
evolution release on schema 17 and trading SQLite schema 10; the runtime
remains `public-http-paper`.
Operator details are in
[Canonical paper portfolios](./PAPER_PORTFOLIOS.md).

**Baseline:**

- PostgreSQL schema 12 contains a bounded durable executor-command queue with
  owner/session authorization fences, leases and idempotent terminal outcomes;
- trading SQLite schema 9 contains owner-scoped portfolios, monotonic ledger
  epochs, capital reservations, mutation receipts, immutable robot-revision
  evidence, valuation marks and append-only portfolio events;
- the `paper-portfolio-v1`/`paper-metrics-v1` projection derives fixed-decimal
  balances and evidence-aware metrics from durable ledgers and marks;
- create/default/rename/archive/reset and robot create/control commands cross
  the same fenced bridge; reset preserves prior epochs and requires rebind;
- the UI has honest loading/error/empty states, a collapsible sticky summary,
  mobile cards, desktop table/detail, filters and confirmed controls;
- robot detail includes a bounded realized-cash curve, evidence-aware
  performance/risk metrics, recent fills and recent ledger events without
  inventing missing mark history;
- missing or stale valuation, margin or borrowing evidence is not synthesized.

**Acceptance evidence:**

- journal/curve, golden-ledger, restart-boundary, stale-mark,
  concurrent-command and two-owner authorization verification passed;
- the isolated paired restore/migration/rollback drill verified
  `executor_commands` and every schema-9 canonical paper-portfolio table;
- backend/frontend, migration, browser, accessibility, visual, documentation
  and protected production-smoke gates passed;
- exact-SHA Actions were green before the protected slot cutover, and only the
  declared project resources changed under ADR 0002.

**Dependencies:** R1 execution ledger, R3 owner/workspace lifecycle and ADR 0001
authority boundaries.

**Evidence:** golden-ledger reconciliation; restart at each lifecycle boundary;
stale-mark/unavailable-state tests; concurrent command/idempotency tests;
cross-owner REST/WS tests; mobile and desktop E2E. The accepted release record is
[R4 canonical paper portfolios](./evidence/R4_PAPER_PORTFOLIOS.md).

**Exit criteria:** totals before and after restart are identical, every value has
defined evidence and time, and no administrator or second tenant can read or
mutate the portfolio.

## R5 — alerts, technical screener MVP and notifications

**Status:** complete. R5.1, the R5.2.1 technical screener MVP, the R5.3a
saved-screen→server-alert promotion, the R5.3b-1 Telegram delivery worker
with chat binding, the R5.3b-2 Telegram paper commands and the chart research
tools (text notes and the parallel channel) are all accepted and deployed:
the completed R5 release shipped on PostgreSQL schema 16 and unchanged
trading SQLite schema 9 from protected slot `r5f-schema16-2ff6101` at commit
`2ff6101b950b42a77c378233dabecf1a5ee76ce7`; exact-SHA GitHub Actions run
`29629886774` passed all 6/6 jobs. Production has since advanced through the
accepted R6 DCA paper robot, R7 grid paper robot, R8 multi-leg paper intents
and R9.1 server multi-market evaluation releases to the accepted R9.2 server
GA evolution release on schema 17 and trading SQLite schema 10, and the
runtime remains `public-http-paper` on port 4180. R5.1 was previously deployed
from protected slot `r5a-schema13-66394fd` at commit
`66394fd38765d8da36174411cecd95a33fda1ea0` with exact-SHA run
`29574600648` (6/6 jobs), R5.2.1 from protected slot
`r5b-schema14-20be5b1` at commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831` with exact-SHA run `29584556266`
(6/6 jobs), R5.3a from protected slot `r5c-schema14-86712ba` at commit
`86712bac3293ac8d746b638218eb66995d8e5edb` with exact-SHA run `29590401183`
(6/6 jobs), R5.3b-1 from protected slot `r5d-schema15-cd34ec8` at commit
`cd34ec8d11810a652bf087718f498dcece3b75fa` with exact-SHA run `29622330910`
(6/6 jobs), and R5.3b-2 from protected slot `r5e-schema16-17e12f1` at commit
`17e12f17933de5ffb047d63358a05fad8f0211f0` with exact-SHA run `29625979877`
(6/6 jobs). The accepted release records are
[R5.1 owner alerts](./evidence/R5_1_OWNER_ALERTS.md),
[R5.2.1 technical screener](./evidence/R5_2_1_TECHNICAL_SCREENER.md),
[R5.3a screener alerts](./evidence/R5_3A_SCREENER_ALERTS.md),
[R5.3b-1 Telegram delivery](./evidence/R5_3B1_TELEGRAM_DELIVERY.md),
[R5.3b-2 Telegram commands](./evidence/R5_3B2_TELEGRAM_COMMANDS.md) and
[R5 chart research tools](./evidence/R5_CHART_RESEARCH_TOOLS.md). No R5 work
remains. The technical screener was intentionally delivered before robot
strategy expansion so it can feed later alerts.

**Baseline:**

- older account-aware arbitrage research alerts demonstrate a separate bounded
  policy/outbox pattern, but their engine-owned candidate/economics producers
  remain disconnected; they are not the generic R5.1 price-alert control plane;
- chart candle and indicator engines provide canonical values;
- read-only arbitrage research already exposes freshness and evidence states.

**R5.1 accepted release — generic owner price alerts:**

- PostgreSQL schema 13 owns owner-scoped rules, immutable revisions, state,
  evaluation receipts, forward-sequenced events, in-app outbox evidence and
  bounded retention; production completed the verified 12→13 migration;
- the only server-evaluated kind is `price-threshold` over public Binance/Bybit
  last-price closed candles. It is notification-only, reads no credential and
  cannot place an order, borrow, change margin or grant a trading role;
- beta limits are 100 active and 200 non-archived rules per owner, 400 total
  retained rule/history rows per owner and 480 globally active rules;
- a sweep claims default 100/hard maximum 500 rules, with four concurrent public
  reads, 16 unique reads per sweep and eight per provider. Equal scope/cursor
  reads coalesce and one saturated provider cannot starve the other;
- evaluation receipts retain for 2 days; events, in-app outbox, terminal
  delivery evidence, old states/revisions and archived rules retain for 30 days
  under child-first bounded compaction;
- `alert-event-page-v1` is an owner-bound forward cursor. The browser publishes
  before checkpointing, so delivery is intentionally at-least-once: a toast may
  repeat, but an unseen event is not acknowledged;
- same-owner tabs converge through owner-local revisions, `storage` events and
  `BroadcastChannel`; local-storage failure and create/delete races fail closed;
- acceptance passed the exact upgrade/recovery, browser-closed, multi-tab,
  forward-cursor, desktop/mobile accessibility and visual gates.

Canonical details: [Owner-scoped server alerts](./ALERTS.md),
[Russian](./ru/ALERTS.md) and [Kazakh](./kk/ALERTS.md).

**R5.2.1 accepted release — technical screener MVP:**

- screens a bounded universe of at most 200 symbols for price, volume, change,
  RSI, SMA/EMA crosses, MACD and ATR using the same closed-candle engine as
  the chart;
- executes bounded server batches instead of one browser socket per symbol;
- stores owner-scoped presets, pagination, sorting, run history and an
  `unavailable/stale` state that can never pass a filter as normal;
- opens a result with the same symbol, timeframe and indicator context;
- PostgreSQL schema 14 adds the owner-scoped preset tables; runs execute as
  compute jobs under the existing five-active-per-owner quota and the
  30-day/200-job/256 MiB retention bound;
- beta limits are 40 presets per owner and 400 presets globally; none of these
  caps is R11 capacity evidence;
- funding, OI and ML filters stay deferred until their data contracts are
  delivered; at R5.2.1 acceptance the saved-screen→server-alert promotion was
  still pending and rule kind `screener` was a reserved placeholder, since
  delivered by the accepted R5.3a release below.

**R5.3a accepted release — saved-screen→server-alert promotion:**

- alert rule kind `screener` is runtime support: a rule embeds the full
  `screener-definition-v1` by value, immutable per rule revision, and the
  research worker re-evaluates it at the screen's timeframe cadence
  (300-86 400 s) under a 300 s lease, at most one evaluation per sweep with
  the bounded 90 s market-data budget;
- transitions use match-set-changed semantics: the first evaluation
  initializes without triggering, unavailable symbols carry over as unknown
  rather than departed, more than 30% unavailable universe defers the
  evaluation and cooldown defers without advancing state; the rule stays
  active after a trigger (`repeat: "on-change"`; rearm answers
  `409 alert_rearm_unsupported`);
- completion writes the `triggered` event, the outbox row and the
  pre-delivered in-app delivery in one transaction keyed by the sha256
  transition key, under receipts producer `screener-alert-worker`;
- screener rules carry their own caps — 5 enabled per owner and 40 active
  globally — inside the shared alert quotas, and `telegram` delivery on a
  screener rule was rejected with `400 unsupported_alert_delivery_channel`
  until the accepted R5.3b-1 release below delivered the channel;
- the Screener workspace promotes the current screen via "Create alert from
  this screen"; screener rules list in the alerts panel without ever opening
  price-quote subscriptions;
- the release added no migration — schema 14 and trading SQLite schema 9 are
  unchanged — and the total-JS bundle cap moved 960→984 KiB under the
  reviewed-cap pattern with the mandatory 10% reserve intact.

**Chart research tools accepted release — text notes and the parallel
channel:**

- text notes carry data-space anchors and owner-scoped workspace persistence,
  and the parallel channel is one movable, measurable drawing object;
- one canonical geometry contract in `packages/contracts/chartGeometry` is
  shared by the canvas, the store, workspace validation and the backend v9
  schema for horizontal/trend/channel geometry;
- workspace schema v9 is additive over the untouched v8 document: v7/v8
  documents stay byte-for-byte valid and the backend accepts revisions 7|8|9;
- the complete 21-tool catalog (previously 19) is exposed through the common
  mobile drawing sheet rather than a reduced mobile-only catalog, and the
  visual baseline was regenerated;
- the release added no migration — PostgreSQL schema 16 and trading SQLite
  schema 9 are unchanged.

**R5.3b-1 accepted release — Telegram delivery worker and chat binding:**

- the implemented evaluation lanes stay outside the API request path; the
  separate delivery worker adds retry/backoff and dead-letter behavior and
  neither worker has trading authority;
- a dedicated project-owned notification service never opens trading SQLite
  and never receives exchange credentials. Its delivery lane reads only the
  PostgreSQL outbox and minimal owner/chat scope; its ingress lane writes only
  normalized Telegram updates to PostgreSQL. The provider credential comes
  from a protected operator environment file; no bot token is provisioned on
  the production host, so the worker idles by design
  (`notification_worker_idle` reason `token_absent`) with a healthy heartbeat,
  readiness treats it as optional unless
  `OPERATIONS_REQUIRE_NOTIFICATION_WORKER` is set, and provisioning the token
  file later activates delivery without a release;
- inbound Telegram handling is HTTPS-independent outbound `getUpdates` long
  polling. Webhooks, public callbacks and a new listener remain forbidden, so
  SaltanatbotV2 needs neither a domain nor HTTPS for this path;
- exactly one active consumer runs for each bot-identity revision. A
  PostgreSQL lease plus monotonic fencing token prevents a stale worker from
  advancing the cursor after lease loss;
- a unique `(botRevision, update_id)` and a durable fenced forward-only cursor
  advanced only after a durable outcome make a pre-commit crash safely replay
  the update, while a post-commit refetch is a no-op;
- global, per-chat and per-owner ingress rates, bounded update sizes, failed
  binding-attempt limits and retry/backoff for Telegram timeout/`429` are
  enforced; administrator role does not bypass these controls;
- the outbox row persists before sending. A provider may accept a Telegram
  message before the worker records acknowledgement, so delivery is
  **at-least-once**, not exactly-once; every delivery carries a stable
  deduplication ID and duplicate possibility is documented;
- Telegram bind/revoke uses owner-scoped, cryptographically random,
  high-entropy codes stored only as hashes, with a short TTL, one consume and
  a bounded attempt count; they never appear in URLs, logs or metrics.

**R5.3b-2 accepted release — Telegram paper commands:**

- the accepted alert baseline still extends beyond the delivered
  price-threshold and screener kinds only after canonical indicator/drawing
  and paper-robot health/drawdown evidence contracts exist; no schema
  placeholder is runtime support;
- any required idempotent legacy import must still not merge account-aware
  arbitrage policy state into generic owner price-alert state;
- commands are limited to paper balance, reports, alerts and
  pause/resume/stop. Each state-changing confirmation is a separate
  high-entropy one-use token bound to owner, chat, action, portfolio/bot
  revision and authorization epoch, with a short TTL and final-consume
  validation; the release exposes paper-only `/balance`, `/daily`, `/profit`,
  `/performance`, `/trades` and `/alerts`, and routes the paper `/pause`,
  `/resume` and `/stop` mutations through the fenced executor with a durable
  command idempotency key persisted before any mutating command;
- at final consume, the worker revalidates the active binding revision, owner
  status and authorization epoch, portfolio/bot ownership and confirmation.
  Unbound, revoked and cross-owner commands fail closed without exposing
  tenant data and emit a structured audit event/counter; a command allowlist,
  bounded command sizes and failed confirmation-attempt limits complete the
  ingress controls;
- PostgreSQL schema 16 (migration 16 `telegram_command_bridge`) adds the
  confirmation and command-bridge tables; without a provisioned bot token the
  notification worker still idles by design, and provisioning the token file
  later activates commands without a release;
- Web Push stays disabled because HTTPS is outside this roadmap.

**Dependencies:** R1 queue/ADR foundation, R3 ownership, R4 paper metrics and the
canonical candle/indicator engine.

**R5.1 acceptance evidence:** schema 12→13/checksum/no-op migration, real
unprivileged PostgreSQL ownership/quota/capacity/retention/forward-cursor tests,
closed-candle restart/dedupe, forged/stale evidence rejection, local-storage
failure, create/delete race, multi-tab convergence and desktop/mobile
accessibility/visual checks. These gates passed; the accepted release record is
[R5.1 owner alerts](./evidence/R5_1_OWNER_ALERTS.md).

**R5.2.1 acceptance evidence:** the schema 13→14 migration, chart/screener
parity and the rehearsal end-to-end screener proof on the isolated replacement
pair — preset created, run executed via compute job against live Binance
closed candles, 30/30 evaluated, 30 matched, 0 unavailable — passed before
cutover. The recovery chronology retained the pre-upgrade schema-13 generation
`281b88c8` with its drill, stopped rollback source `bee7eced`, the
post-upgrade schema-14 generation `b18d3380` with its drill and the
replacement-only rollback pair. An earlier revision `d422100` failed CI run
`29583889332` on migration-chain assertions and was fixed forward to release
commit `20be5b1` before any production change. The accepted release record is
[R5.2.1 technical screener](./evidence/R5_2_1_TECHNICAL_SCREENER.md).

**R5.3a acceptance evidence:** the no-migration release passed the
exact-worktree gates, the new evaluator/routes/runner suites, the twice-run
real-PostgreSQL screener-alert integration suite and the container browser
gates before cutover; the production worker journal shows the screener alert
lane running (`evaluationsPerSweep` 1, 0 failures) and the recovery chronology
retained the verified pre-cutover generation `dd5c0827` and post-cutover
generation `3632bd9f` with its passed isolated drill. The accepted release
record is [R5.3a screener alerts](./evidence/R5_3A_SCREENER_ALERTS.md).

**R5.3b-1 acceptance evidence:** the isolated 14→15 migration rehearsal with
the exact migration-15 checksum, the notification-worker idle boot proof and
the one-consume hashed binding-code smoke (three unique one-time codes, fourth
request `429`, hashed-only storage), the real-PostgreSQL delivery
claim/retry/backoff/dead-letter/cancelled-on-revoke, lease-takeover and
crash-before/after-cursor suites and the container browser gates passed before
cutover. The recovery chronology retained the pre-upgrade schema-14 generation
`47645c55` with its drill, stopped rollback source `d86692ad`, the
post-upgrade schema-15 generation `ba4f9d40` with its drill and the
replacement-only rollback pair. The accepted release record is
[R5.3b-1 Telegram delivery](./evidence/R5_3B1_TELEGRAM_DELIVERY.md).

**R5.3b-2 acceptance evidence:** the isolated 15→16 migration rehearsal with
the exact migration-16 checksum and a restart migration no-op with both
workers ready at schema 16, and the real-fenced-executor PostgreSQL command
integration suite — the full /pause→/confirm→action→reply round trip;
expired/brute-forced/replayed confirmation tokens; duplicate, replayed and
out-of-order command updates; revoke races and cross-owner commands failing
closed; and each command `update_id` creating at most one durable paper
mutation across restart or consumer takeover — passed before cutover. The
recovery chronology retained the pre-upgrade schema-15 generation `3e4dc4f1`
with its drill, stopped rollback source `0898a08d`, the post-upgrade
schema-16 generation `08b6defe` with its drill and the replacement-only
rollback pair. The accepted release record is
[R5.3b-2 Telegram commands](./evidence/R5_3B2_TELEGRAM_COMMANDS.md).

**Chart research tools acceptance evidence:** the no-migration release passed
the exact-worktree gates and the container browser gates before cutover; the
new axe accessibility audit found two WCAG AA contrast defects that were
fixed before acceptance, and the recovery chronology retained the verified
pre-cutover generation `7a734401` and post-cutover generation `83c4b37e`
with its passed isolated drill. The accepted release record is
[R5 chart research tools](./evidence/R5_CHART_RESEARCH_TOOLS.md).

**Complete R5 exit criteria (met):** the R5.1, R5.2.1, R5.3a, R5.3b-1,
R5.3b-2 and chart research tool releases have passed acceptance, and a saved
screen produces an owner-scoped alert with the browser closed; restarts lose
no durable transition; duplicates are bounded and identifiable; each R5.3b-2
Telegram `update_id` creates at most one durable paper mutation across
restart or consumer takeover, as proven by the accepted integration suite;
notification failure cannot stall login, charts or paper execution. With the
chart research tools (text notes and the parallel channel) accepted, R5 is
closed.

## R6 — DCA paper robot

**Status:** delivered, accepted and deployed with no migration on unchanged
PostgreSQL schema 16 and trading SQLite schema 9 from protected slot
`r6a-schema16-e2411ab` at commit
`e2411ab2f0b4540200089af8128304f71d3f73e0`; exact-SHA GitHub Actions run
`29633743310` passed all 6/6 jobs. Production has since advanced through the
accepted R7 grid paper robot, R8 multi-leg paper intents and R9.1 server
multi-market evaluation releases to the accepted R9.2 server GA evolution
release on schema 17 and trading SQLite schema 10, and the runtime remains
`public-http-paper` on port 4180 across the three systemd units.

**Delivered — the shared paper execution contract and the DCA robot:**

- `paper-fill-model-v1` is the single fill/fee/slippage parity source shared
  by replay and paper execution;
- versioned fill behaviors: the `single-position-v1` default stays
  byte-compatible and adds an explicit conflict cancel, and `averaging-v1`
  supports DCA safety-order averaging;
- `dca-params-v1`/`dca-state-v1` cover base and safety orders, step/volume
  scales, TP/SL/trailing exit, cooldown and one lifecycle state machine
  shared by replay and paper execution;
- worst-case reserved capital is enforced server-side with a live pre-run
  preview;
- every lifecycle transition carries its own idempotency key, and the
  goldenReplay harness is reusable for R7.

**Dependencies:** R4 portfolio/journal and R5 health alerts.

**Acceptance evidence:** the determinism criterion passed — the golden replay
is byte-identical across two runs, a mid-cycle restart reproduces the
identical result, replay equals the final durable state and the worst-case
capital bound was never exceeded. One pre-acceptance defect (read-model DCA
metadata field names) was fixed before acceptance, and the recovery
chronology retained pre-cutover generation `440523a6` and post-cutover
generation `65bb4359` with its passed drill. The accepted release record is
[R6 DCA paper robot](./evidence/R6_DCA_PAPER_ROBOT.md).

**Exit criteria (met):** one price path produces the same replay and paper
result, instrument/capital limits cannot be exceeded, and restart creates no
duplicate order or reservation.

## R7 — Grid paper robot

**Status:** delivered, accepted and deployed with no migration on unchanged
PostgreSQL schema 16 and trading SQLite schema 9 from protected slot
`r7a-schema16-baf4217` at commit
`baf42178d33043fde0965d008aee9f09462df699`; exact-SHA GitHub Actions run
`29636312303` passed all 6/6 jobs. Production has since advanced through the
accepted R8 multi-leg paper intents release, which migrated trading SQLite
to schema 10 on unchanged PostgreSQL schema 16, and the accepted R9.1 server
multi-market evaluation release to the accepted R9.2 server GA evolution
release on PostgreSQL schema 17, and the runtime remains `public-http-paper`
on port 4180 across the three systemd units.

**Delivered — the grid robot on the shared execution contract:**

- `grid-params-v1` covers arithmetic/geometric level ladders (2-50 levels),
  neutral/long/short modes, an outside-range pause or stop action, an
  optional stop-loss and cycle cap, with one shared deterministic
  level-price helper and the worst-case math
  `gridLevels · orderQuote · (1 + feePct/100)` used by the machine, the
  server and the UI preview alike;
- the pure `grid-state-v1` machine carries the idempotency key
  `grid:<botId>:<epochCycle>:<ordinal>` (also the order clientId) on every
  transition, settles gap batches in one consolidated placement round and
  recovers from restart through a journal-deduplicated resume that never
  re-places an existing clientId;
- fills reuse the R6 `averaging-v1` behavior, and robot kind `grid` is
  additive — legacy create payloads hash identically;
- the worst-case bound is enforced server-side
  (`WORST_CASE_EXCEEDS_ALLOCATION`) with a live preview and a pre-start
  level-price preview list, and realized grid PnL is separated from
  evidence-aware inventory PnL in en/ru/kk.

**Dependencies:** R4 portfolio/journal and R6 shared robot lifecycle lessons.

**Acceptance evidence:** the release criterion passed by golden replay on the
real adapter/ledger path — a four-level gap bar settled in a single
consolidated placement round with a contiguous, duplicate-free clientId set,
so a price gap never creates a cascade; a mid-cycle restart reproduced the
identical clientId set, events and terminal state as the uninterrupted run,
so restart never duplicates levels or reserves; the double drive is
byte-identical, replay equals the final durable state and the worst-case
capital bound was never exceeded and is previewed before confirmation. One
pre-acceptance defect (the browser read-model parser rejected negative
short-inventory quantities) was fixed before acceptance, and the recovery
chronology retained pre-cutover generation `0ee96dbe` and post-cutover
generation `cb3702ac` with its passed drill. The accepted release record is
[R7 grid paper robot](./evidence/R7_GRID_PAPER_ROBOT.md).

**Exit criteria (met):** worst-case capital is visible before start, a gap
cannot create an unbounded cascade, and restart cannot duplicate levels or
reserves.

## R8 — spread trading and market-inefficiency research (paper only)

**Status:** delivered, accepted and deployed on unchanged PostgreSQL schema 16
and trading SQLite schema 10 — the first SQLite migration since R4, additive
migration `owner_scoped_paper_multi_leg` 9→10 (SQL SHA-256
`34584a750937468d065d90b0af09a074a541da29ba1e7a38f2c5278cc6e9890d`) — from
protected slot `r8a-schema16-69621f8` at commit
`69621f8107a713031f768320e9dc496010234100`; exact-SHA GitHub Actions run
`29639908389` passed all 6/6 jobs. Production has since advanced through the
accepted R9.1 server multi-market evaluation release to the accepted R9.2
server GA evolution release, which migrated PostgreSQL to schema 17, and the
runtime remains `public-http-paper` on port 4180 across the three systemd
units.

**Delivered — owner-scoped multi-leg paper intents on the common capital
plane:**

- the fenced executor gains additive command kinds `paper-multi-leg.submit`
  and `paper-multi-leg.kill-switch` (legacy request hashes byte-identical);
  submit builds the plan through the existing fail-closed research builders
  (research-simulation only, `executable === false` enforced, per-leg evidence
  mandatory), enforces the shared freshness gate (≤60 s source age, ≤5 min
  plan lifetime) and the per-owner (3) / per-portfolio (2) active-intent
  limits, and reserves the deterministic worst case
  `Σ plannedQuantity·referencePrice·(1 + 2·feeBps/10000)` (ceil to six
  decimals) against the portfolio's available capital;
- the pure deterministic engine runs to terminal inside the fenced apply with
  every transition durably journaled under `mleg:<intentId>:<sequence>`; leg
  risk, partial fills and reverse-order compensation (unwind) follow the
  proven engine semantics, restart recovery replays to the identical terminal
  state, and the guarded running→terminal flip releases the single capital
  reservation exactly once;
- combined paper PnL includes both legs and every modeled cost, and residual
  exposure is always listed explicitly instead of being silently priced;
- the portfolio read model exposes a browser-shaped `multiLeg` section and
  subtracts running reservations from available capital; opportunity research
  gains the "Run paper multi-leg" flow with a live worst-case preview, the
  Robots portfolio center renders the intents section and the owner-level
  paper kill switch fails closed, in en/ru/kk;
- the legacy isolated arbitrage paperMultiLeg module is byte-identical — its
  pure engine/schema/builders are reused, not forked.

**Dependencies:** R4 journal, R5 alerts, verified public depth/identity contracts
and the R1 execution ledger.

**Acceptance evidence:** the R8.1 normalization/freshness/depth/economics
baseline was already delivered pre-R8 by the read-only research builders and
was reused unchanged, so this release closed R8.2, and its release criterion
passed — a partially driven run recovered on a fresh service instance reached
a journal byte-equal to the uninterrupted pure-engine run, with an identical
terminal state, no duplicate sequences and the capital reservation released
exactly once; combined paper PnL includes both legs and all modeled costs
with residual exposure explicit; and no opportunity is executable without
sufficient fresh depth behind the freshness gates (research-simulation only).
The paired migration rehearsal (`scripts/rehearse-trading-migration.mjs`)
migrated a copy of the production `trading.db` 9→10 applying exactly
`owner_scoped_paper_multi_leg`, and the recovery chronology retained the
pre-cutover generation `ddf80eba` (verified at SQLite 9) and the post-cutover
generation `7ac9a851` with its passed isolated drill; rollback remains
replacement-only with slot `r7a-schema16-baf4217` retained. The accepted
release record is
[R8 multi-leg paper intents](./evidence/R8_MULTI_LEG_PAPER_INTENTS.md).

**Exit criteria (met):** no row is labelled paper-executable without sufficient
fresh depth, and paper PnL accounts for every leg and declared modeled cost
without opening any live path.

## R9 — strategy generator and genetic optimizer

**Status:** active. The R9.1 and R9.2 increments are delivered, accepted and
deployed. R9.1 shipped with no migration on unchanged PostgreSQL schema 16
and trading SQLite schema 10 from protected slot `r9a-schema16-4f5bc64` at
commit `4f5bc64e9dfb35d379a55690755a76f7594b226d`; exact-SHA GitHub Actions
run `29643197555` passed all 6/6 jobs. Production has since advanced to the
accepted R9.2 server GA evolution release on PostgreSQL schema 17 and
unchanged trading SQLite schema 10 from protected slot
`r9b-schema17-3ed6af1` at commit
`3ed6af138f197ee985bd8ac998ab58cc8769b83c`; exact-SHA GitHub Actions run
`29647276230` passed all 6/6 jobs and the runtime remains
`public-http-paper` on port 4180 across the three systemd units. R9.3 (the
versioned strategy gallery) remains, so R9 as a whole is still in progress
and no public strategy gallery is claimed.

**Baseline:** validated Strategy IR, seeded parameter mutation/crossover and
deterministic structural candidate generation already have bounded browser-side
implementations; the accepted R9.1 and R9.2 releases below add the D2
contracts, the server evaluation path they gate and the server evolution
pipeline with lineage, Pareto/OOS promotion and checkpoint/resume.

**R9.1 accepted release — the D2 ADR, generic job registry and server
multi-market evaluation:**

- decision D2 is closed by
  [ADR 0003: canonical IR, dataset and backtest contract](adr/0003-canonical-ir-dataset-backtest-contract.md)
  (Accepted 2026-07-18), before the R9.1 job API as this roadmap required:
  the canonical Strategy IR is `IR_VERSION 4` with the pinned checksum guard
  `scripts/check-strategy-core-ir.mjs` wired into `npm run check` and
  `parseStrategyIR` as the sole trust boundary for inbound IR; the versioned
  `dataset-v1` contract fixes a canonical serialization with a SHA-256
  fingerprint and a time-ordered train/test split with an embargo gap — never
  random, never lookahead, with the survivorship limitation recorded — and
  every server evaluation is stamped with the deterministic engine version
  `BACKTEST_ENGINE_VERSION = "backtest-core-v1"`;
- the generic research job-kind registry dispatches kind-discriminated
  definitions over in-process and worker-thread lanes; the two pre-existing
  job kinds (screener and backtest) re-registered byte-identically and
  unknown kinds still hard-fail;
- job kind `multi-market-eval` performs server-owned candle evaluation: real
  closed bars only from the public provider under the 90 s screener budget
  with explicit fail-closed reasons, 1-6 markets on one timeframe,
  500-20 000 lookback bars and the embargo split; per-market train/OOS
  backtests run through the existing worker-thread protocol, an
  out-of-sample shared capital-pool portfolio section comes from the R4
  portfolio allocator, and the bounded (≤256 KiB) deterministic
  `multi-market-eval-v1` result carries the dataset fingerprint, engine
  version and seed;
- the strategy generator panel gains the "Evaluate on server" flow feeding
  the pure ranker, whose section flips from unavailable to a ranked list
  with a provenance line (engine version, seed, dataset fingerprint), in
  en/ru/kk.

**R9.1 acceptance evidence:** the release criterion passed — the same dataset
driven twice through the full evaluation path produced byte-identical result
JSON (golden dataset fingerprint `d076618630cf5842…`), and the tested
embargo/no-lookahead split laws prove no leakage; one pre-acceptance fix maps
the JSONB-nulled infinite profit factor to NaN so the ranker's finite-metrics
gate fails that window closed. The recovery chronology retained the verified
pre-cutover generation `92026f70` and post-cutover generation `e894eede` with
its passed isolated drill; rollback remains replacement-only with slot
`r8a-schema16-69621f8` retained. The accepted release record is
[R9.1 server evaluation](./evidence/R9_1_SERVER_EVALUATION.md).

**R9.2 accepted release — server GA evolution with lineage, Pareto ranking
and OOS promotion:**

- the pure structural generator now lives in the
  `@saltanatbotv2/strategy-generator` workspace package (zero IO, guarded
  generated artifacts, a frontend re-export shim), so the server breeds
  candidates from the same primitives as the browser and evolves only
  versioned Strategy IR, never arbitrary code;
- job kind `ga-evolution` rides the R9.1 registry and the durable owner-fair
  queue with a bounded config (1-4 markets on one timeframe, 500-20 000
  lookback bars, population 8-64, generations 1-16, seed 0..2³²−1); the
  dataset is fetched once per run under the real-bars discipline and pinned
  by its `dataset-v1` fingerprint, train/OOS evaluation is
  fingerprint-deduplicated through worker-thread backtests, and every
  generation persists lineage rows (parents, mutation log, IR, metrics,
  objectives), non-dominated Pareto ranks over out-of-sample objectives and
  an atomic checkpoint (population + RNG state), so cancellation yields a
  durable resumable `checkpointed` run;
- PostgreSQL migration 17 `ga_evolution_lineage` (SQL SHA-256
  `4169ec0148c63415abe913195d34b03fa603039d0fe7defabfe76a89f7a61a73`) is
  additive only: owner-scoped `ga_runs` and `ga_candidates` with a
  single-active-run partial unique index, bounded checkpoint storage and a
  promotion-requires-OOS CHECK;
- promotion refuses a candidate without a clean out-of-sample report at both
  the repository and SQL CHECK layers and refuses flagged overfit candidates
  (`ga_promotion_overfit`); a clean candidate promotes into the owner's own
  strategy library carrying full provenance (seed, dataset fingerprint,
  engine and generator versions, lineage chain, OOS report), and the public
  gallery remains forbidden until R9.3;
- owner-scoped `/api/ga` routes expose runs, the frontier, candidate lineage
  chains and promotion, and the strategy studio's server evolution section
  (start/cancel/resume, frontier with explicit overfit and unstable flags,
  lineage drawer, promote-to-library) ships in en/ru/kk; the reviewed
  total-JS budget moved 1 008 → 1 032 KiB under the documented cap pattern.

**R9.2 acceptance evidence:** the seeded-reproducibility release criterion
passed — two identical runs (same seed, same dataset) produced a
byte-identical result and row-identical lineage; a run cancelled after
generation 1 resumed on a fresh instance to a byte-identical final state
with equal candidate row sets and zero re-evaluation across the checkpoint
boundary; a resume whose refetched market data no longer reproduces the
pinned dataset fingerprint fails explicitly with `ga_dataset_drift`; and
fingerprint dedup guarantees a genome is never evaluated twice. The paired
rehearsal migrated a restored copy of the production data 16→17 applying
exactly `ga_evolution_lineage`, and the recovery chronology retained the
verified schema-16 generations `c9fbff05` (pre-migration) and `35d3b199`
(pre-cutover at the green SHA) plus the post-cutover schema-17 generation
`fb95a706` with its passed isolated drill; rollback remains replacement-only
with slot `r9a-schema16-4f5bc64` retained. The accepted release record is
[R9.2 GA evolution](./evidence/R9_2_GA_EVOLUTION.md).

**Remaining (R9.3):**

- publish strategies only as explicit immutable versioned artifacts with
  provenance, moderated visibility, revocation and a safe import that creates
  a recipient-owned copy (the safe strategy gallery below);
- keep any future AI assistant optional/BYO and subject to the same IR gates.

**Dependencies:** R1 workers, canonical IR/dataset/backtest contracts and R4
portfolio metrics.

**Evidence:** seed reproducibility, dataset immutability, leakage/lookahead
adversarial tests, quota/cancellation/restart tests and independent OOS reports.

**Exit criteria:** the same seed and dataset reproduce the same lineage and no
candidate can be promoted without OOS and overfit evidence.

**R9.3 — safe strategy gallery:** publish only an explicit immutable versioned
artifact with provenance, private/unlisted/public visibility,
moderation/revocation and a safe import that creates a recipient-owned copy.
Cards expose dataset/engine fingerprints, out-of-sample metrics, drawdown and
limitations without leaking workspace or owner-private data. Import never
starts a robot and always requires validation, backtest and explicit paper
activation.

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
- close decision D3 before online ingest by fixing the exact venues/native
  symbols, source permissions, retention/downsampling and deletion policy;
- normalize public funding, open interest and liquidation feeds with exact
  contract/base/quote units, provenance, freshness and reconnect gaps; derive
  multi-timeframe inputs only from completed higher-timeframe candles without
  lookahead, and let the user select and see the source timeframe for
  EMA/SMA/RSI and other supported indicators;
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
retention and separate bounded research and notification workers are
implemented. The accepted R5.1 release also implements its 100/200/400/480
rule limits, 4/16/8 scheduler admission and 2/30-day retention, the accepted
R5.2.1 release adds its 40-per-owner/400-global screener preset caps,
≤200-symbol universe and bounded compute-job runs, the accepted R5.3a release
adds its 5-per-owner/40-global screener-rule caps, and the accepted R5.3b-1
release adds its bounded Telegram delivery, ingress-rate and binding-attempt
caps, but none has integrated 100-user evidence. ADR 0001 keeps one
authoritative trading executor.

**Remaining:** tune the implemented process-wide API admission slice from load
evidence; validate the deployed alert, screener-preset and Telegram delivery
caps and add the missing WebSocket, robot, job and L2 global caps plus their
metrics and dashboards; run the quantified workload, failure drills,
backup/recovery targets and second-API fencing prerequisites in
[Capacity plan for the first 100 users](CAPACITY_100_USERS.md).

**Dependencies:** all workloads selected for the capacity claim, stable schemas,
the accepted ADR 0001 decision and completed implementation/reconciliation
evidence.

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
| R3 | administrator lifecycle, server workspaces and onboarding/PWA boundary | R1-R2 | delivered on schema 11 |
| O1 | Operational hardening increments | starts in R3 and ships with each new workload | included in R3-R10 estimates |
| R4 | “Running” and paper portfolio/journal contract | R1-R3 | delivered |
| R5 | R5.1 generic price alerts, R5.2.1 technical screener MVP, R5.3a saved-screen→alert promotion, R5.3b-1 Telegram delivery/chat binding, R5.3b-2 Telegram paper commands and the chart research tools (text notes and parallel channel) all accepted | R3-R4 | delivered |
| R6 | Shared paper execution contract and DCA paper robot accepted | R4-R5 | delivered |
| R7 | Grid paper robot on the shared execution contract accepted | R4-R6 | delivered |
| R8 | Owner-scoped multi-leg paper intents on the common capital plane accepted | R4-R5 | delivered |
| R9 | Generator/genetic optimizer — R9.1 (D2 ADR, job registry, server multi-market evaluation) and R9.2 (server GA evolution with lineage, Pareto/OOS promotion, checkpoint/resume) accepted; the R9.3 gallery remains | R1 + R4 portfolio metrics + canonical IR/dataset/backtest (D2 closed by ADR 0003) | 5-8 |
| R10A | Funding/OI/MTF + L2 capture/storage/quality | R1 + public data contracts | 3-5 plus 4-8 calendar weeks soak |
| R10B | ML baseline/model/UI | accepted R10A corpus | 5-8 |
| R11 | 100-user capacity and operational proof | accepted workload contracts | 5-9 |
| R12 | Documentation, fresh clone, recovery and release consolidation | R2-R11 | 2-4 |

### Immediate execution queue

1. Keep the accepted R4 schema-12/schema-9 release and its checksummed recovery
   evidence immutable; R5 must reuse its owner, paper-ledger and operational
   boundaries rather than create a second system of record.
2. The R5.1 review is complete: its schema-13 upgrade, owner isolation,
   forward-cursor, multi-tab, mobile and recovery gates passed, and the
   exact-SHA acceptance and cutover evidence is recorded in
   [R5.1 owner alerts](./evidence/R5_1_OWNER_ALERTS.md).
3. The R5.2.1 technical-screener review is complete: its schema-14 upgrade,
   chart/screener parity, isolated rehearsal and recovery gates passed, and
   the exact-SHA acceptance and cutover evidence is recorded in
   [R5.2.1 technical screener](./evidence/R5_2_1_TECHNICAL_SCREENER.md).
4. The R5.3a saved-screen→server-alert promotion review is complete: its
   no-migration runtime, transition-semantics, quota, browser and recovery
   gates passed, and the exact-SHA acceptance and cutover evidence is recorded
   in [R5.3a screener alerts](./evidence/R5_3A_SCREENER_ALERTS.md).
5. The R5.3b-1 Telegram delivery and chat binding review is complete: its
   schema-15 migration, idle-boot, binding-code, delivery-lane and recovery
   gates passed, and the exact-SHA acceptance and cutover evidence is recorded
   in [R5.3b-1 Telegram delivery](./evidence/R5_3B1_TELEGRAM_DELIVERY.md).
6. The R5.3b-2 Telegram command review is complete: its schema-16 migration,
   fenced-executor command, confirmation-token and recovery gates passed, and
   the exact-SHA acceptance and cutover evidence is recorded in
   [R5.3b-2 Telegram commands](./evidence/R5_3B2_TELEGRAM_COMMANDS.md).
7. The R5 chart research tools review is complete: the text notes and the
   parallel channel shipped on the canonical geometry contract, their
   no-migration, browser, accessibility and recovery gates passed, and the
   exact-SHA acceptance and cutover evidence is recorded in
   [R5 chart research tools](./evidence/R5_CHART_RESEARCH_TOOLS.md); the
   complete R5 release gate is closed.
8. The R6 review is complete: the shared paper execution contract and the
   DCA paper robot shipped without a migration, their golden-replay
   determinism, worst-case capital, restart and recovery gates passed, and
   the exact-SHA acceptance and cutover evidence is recorded in
   [R6 DCA paper robot](./evidence/R6_DCA_PAPER_ROBOT.md).
9. The R7 review is complete: the grid paper robot shipped without a
   migration on the shared execution contract, its consolidated-gap,
   restart-no-duplicate, worst-case capital and recovery gates passed, and
   the exact-SHA acceptance and cutover evidence is recorded in
   [R7 grid paper robot](./evidence/R7_GRID_PAPER_ROBOT.md).
10. The R8 review is complete: the owner-scoped multi-leg paper intents
    shipped on the common capital plane with the additive trading SQLite
    9→10 migration, their restart-replay, worst-case reservation, freshness
    and recovery gates passed, and the exact-SHA acceptance and cutover
    evidence is recorded in
    [R8 multi-leg paper intents](./evidence/R8_MULTI_LEG_PAPER_INTENTS.md).
11. The R9.1 review is complete: decision D2 was closed by
    [ADR 0003](adr/0003-canonical-ir-dataset-backtest-contract.md) before the
    job API, the generic research job registry and the server multi-market
    evaluation shipped without a migration, their byte-identical determinism,
    embargo/no-lookahead and recovery gates passed, and the exact-SHA
    acceptance and cutover evidence is recorded in
    [R9.1 server evaluation](./evidence/R9_1_SERVER_EVALUATION.md).
12. The R9.2 review is complete: the server GA evolution pipeline (lineage,
    Pareto/OOS promotion and checkpoint/resume) shipped with the additive
    PostgreSQL 16→17 `ga_evolution_lineage` migration, its seeded
    byte-identical reproducibility, checkpoint/resume, dataset-drift,
    promotion-gate and recovery gates passed, and the exact-SHA acceptance
    and cutover evidence is recorded in
    [R9.2 GA evolution](./evidence/R9_2_GA_EVOLUTION.md).
13. R9.3 — the versioned strategy gallery with provenance, safe import and
    revocation inside the still-open R9 — is the next pending increment;
    keep code for releases after the current pending increment out of `main`
    and production until it is accepted.

Acceptance, publication to `main` and production cutover of the remaining work
are strictly sequential from the next pending increment: R9.3 →
R10A → R10B → R11 →
R12. Parallel work is allowed only inside the
current increment after its contracts are fixed. Code or migrations for a later
release do not enter `main` or production before the preceding release is
accepted. The R10A calendar soak may continue in the background only as evidence;
R10B does not start or pass until the corpus gate.

The implementation remains useful to self-hosters at every release: default
configuration is safe, all required services are documented and no hosted-only
dependency is required for monitoring, research, backtests or paper trading.
There is no “temporarily enable live” or active SSL/HTTPS task in this roadmap.

## Reference boundary outside the backlog: a possible future HTTPS/security roadmap

The following conditions are not tasks, dependencies or blockers for R0-R12.
Only a separately initiated and owner-approved roadmap may add TLS termination,
domains, HSTS, secure cookies, exchange API-key entry, private exchange streams,
signed REST conformance, testnet soak or any discussion of mainnet execution.
