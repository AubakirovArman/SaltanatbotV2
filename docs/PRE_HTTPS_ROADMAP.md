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
| D2 | open | Canonical Strategy IR, dataset schema/fingerprint/split and deterministic backtest-engine versions for R9 | R9 technical owner + architecture maintainer | before the R9.1 schema/job API and first server evolutionary run | server GA/generator stays disabled; only the current browser research baseline remains available, with promotion/gallery forbidden |
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

**Status:** R3.1 and R3.2 are delivered and deployed. Production runs schema 10
from the protected exact-commit release slot; R3.3 with its required O1 slice is
the next increment.

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
and [R3.2 workspace workflow](./evidence/R3_2_WORKSPACE_WORKFLOW.md).

**Active — R3.3 onboarding:** implementation and targeted isolated verification
are in progress. The full build/browser/recovery gate, production cutover and
release evidence are not yet complete.

- add owner-scoped onboarding from goal selection to a first chart, backtest,
  research alert or paper robot, never requesting exchange keys;
- provide 192×192, 512×512, maskable and Apple Touch icons and enforce the
  manifest contract in CI;
- retain ordinary export over HTTP; install/update and offline-bundle actions
  appear only on localhost or a browser-reported secure context. No HTTPS work
  is part of this release.

### R3.3 + O1 executable implementation order

R3.3 is accepted as one compatible increment, implemented internally in this
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

**Dependencies:** backend R3 work may begin after R1 with stable owner IDs and
the current workspace migration path; publishing R3 also requires the remaining
R2 evidence to be closed.

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

**Status:** planned consolidation. A browser robot/portfolio center and
owner-scoped paper state exist, but they are not yet the complete durable
contract below.

**Baseline:**

- the UI has loading, error and empty states and groups available robot/account
  state by owner;
- bots, orders, fills, journal rows and portfolio reads are owner-filtered;
- missing margin or borrowing evidence is not synthesized.

**Remaining:**

- implement the complete owner-scoped paper-portfolio lifecycle: create, select
  a default, rename and archive; reset requires explicit confirmation, starts a
  new versioned ledger epoch and never erases the prior journal or evidence;
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

**Remaining — research chart tools:**

- add text notes with data-space anchors and owner-scoped workspace persistence;
- add parallel channels as one movable, measurable drawing object;
- use one canonical horizontal/trend/channel geometry contract for canvas,
  workspace import/export and server alert evaluation;
- expose the complete set through the common mobile drawing sheet rather than a
  reduced mobile-only catalog.

**Remaining — alerts and delivery:**

- make PostgreSQL authoritative for multi-user alert policies, transitions,
  in-app history, Telegram bindings and the notification outbox, with an
  idempotent import from retained legacy alert rows as required by ADR 0001;
- evaluate price/indicator/drawing/screener and paper-robot health/drawdown
  events with provenance and closed-candle defaults;
- run evaluation and delivery outside the API request path with owner fairness,
  bounded leases, retry/backoff, dead-letter state and quotas;
- use a dedicated project-owned notification service that never opens trading
  SQLite and never receives exchange credentials. Its delivery lane reads only
  the PostgreSQL outbox and minimal owner/chat scope; its ingress lane writes
  only normalized Telegram updates and durable command records to PostgreSQL.
  The provider credential comes from a protected operator environment file;
- implement HTTPS-independent inbound Telegram handling with outbound
  `getUpdates` long polling. Webhooks, public callbacks and a new listener are
  forbidden, so SaltanatbotV2 needs neither a domain nor HTTPS for this path;
- allow exactly one active consumer for each bot-identity revision. A
  PostgreSQL lease plus monotonic fencing token prevents a stale worker from
  advancing the cursor or issuing commands after lease loss;
- persist a unique `(botRevision, update_id)`, durable cursor and command
  idempotency key before any mutating command, and advance the cursor only after
  a durable outcome. A pre-commit crash safely replays the update; a post-commit
  refetch is a no-op and cannot repeat a paper mutation;
- at final consume, revalidate the active binding revision, owner status and
  authorization epoch, portfolio/bot ownership and confirmation. Unbound,
  revoked and cross-owner updates fail closed without exposing tenant data and
  emit a structured audit event/counter;
- enforce global, per-chat and per-owner ingress rates, bounded update/command
  sizes, a command allowlist, failed binding/confirmation-attempt limits and
  retry/backoff for Telegram timeout/`429`; administrator role does not bypass
  these controls;
- persist the outbox row before sending. A provider may accept a Telegram
  message before the worker records acknowledgement, so delivery is
  **at-least-once**, not exactly-once; every delivery carries a stable
  deduplication ID and duplicate possibility is documented;
- bind/revoke Telegram through owner-scoped, cryptographically random,
  high-entropy codes stored only as hashes, with a short TTL, one consume and a
  bounded attempt count; never place them in URLs, logs or metrics;
- limit commands to paper balance, reports, alerts and pause/resume/stop. Each
  state-changing confirmation is a separate high-entropy one-use token bound to
  owner, chat, action, portfolio/bot revision and authorization epoch, with a
  short TTL and final-consume validation; expose paper-only `/balance`,
  `/daily`, `/profit`, `/performance`, `/trades` and `/alerts`;
- keep Web Push disabled because HTTPS is outside this roadmap.

**Dependencies:** R1 queue/ADR foundation, R3 ownership, R4 paper metrics and the
canonical candle/indicator engine.

**Evidence:** chart-versus-screener golden fixtures; browser-closed alert test;
worker crash before/after provider acceptance; Telegram timeout/429/retry and
long-poll lease-takeover tests; duplicate, replayed and out-of-order updates;
crashes before/after cursor persistence; expired/brute-forced/replayed codes;
revoke races and cross-owner commands; duplicate-ID evidence; owner quota and
isolation tests; migration reconciliation.

**Exit criteria:** a saved screen can produce an owner-scoped alert with the
browser closed, restarts lose no durable transition, duplicates are bounded and
identifiable, each Telegram `update_id` creates at most one durable paper
mutation across restart or consumer takeover, and notification failure cannot
stall login, charts or paper execution.

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
- close decision D2 before the R9.1 schema/job API or first server evolutionary
  run by fixing the canonical IR, versioned dataset contract and reproducible
  backtest-engine versions;
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
retention and a separate bounded research worker are implemented. ADR 0001 keeps
one authoritative trading executor.

**Remaining:** tune the implemented process-wide API admission slice from load
evidence; add the missing WebSocket, robot, job, alert, screener and L2 global
caps plus their metrics and dashboards; run the quantified workload, failure
drills, backup/recovery targets and second-API fencing prerequisites in
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
| R3 | R3.1 and R3.2 deployed on schema 10; onboarding remains | R1-R2 | R3.3 plus its O1 slice |
| O1 | Operational hardening increments | starts in R3 and ships with each new workload | included in R3-R10 estimates |
| R4 | “Running” and paper portfolio/journal contract | R1-R3 | 3-5 |
| R5 | Alerts + technical screener MVP + notifications/Telegram | R3-R4 | 5-7 |
| R6 | DCA paper | R4-R5 | 3-4 |
| R7 | Grid paper | R4-R6 | 4-5 |
| R8 | Spread/inefficiency paper research | R4-R5 | 4-6 |
| R9 | Generator/genetic optimizer | R1 + R4 portfolio metrics + canonical IR/dataset/backtest | 5-8 |
| R10A | Funding/OI/MTF + L2 capture/storage/quality | R1 + public data contracts | 3-5 plus 4-8 calendar weeks soak |
| R10B | ML baseline/model/UI | accepted R10A corpus | 5-8 |
| R11 | 100-user capacity and operational proof | accepted workload contracts | 5-9 |
| R12 | Documentation, fresh clone, recovery and release consolidation | R2-R11 | 2-4 |

### Immediate execution queue

1. Close the remaining R2 manual evidence with a real Android Opera smoke and
   VoiceOver/NVDA/TalkBack record. This is a verification item, not permission
   to mix later release code into the current increment.
2. Finish the active R3.3 + O1 implementation in isolation: merge the recovery
   hardening, run the complete PostgreSQL integration matrix, build outside the
   production checkout, and pass Chromium, Firefox, visual, PWA, bundle,
   architecture and documentation gates. Reconcile the generated API index and
   all schema/configuration/security docs with the protected onboarding and
   operations routes; add the promised documentation links and next actions to
   the accepted empty-state journeys.
3. Before any production mutation, record the exact project/service/container/
   port/database/data-directory identity, create a paired schema-10
   PostgreSQL/SQLite generation, verify it and complete a replacement-only
   restore drill using proven matching `pg_dump`/`pg_restore` tooling. Persist
   and expose the last verified generation only after successful verification,
   never as an unverified placeholder. Any identity mismatch or
   foreign-resource collision stops the release.
4. Commit the accepted increment to `main`, verify GitHub Actions, package one
   protected exact-commit release, migrate only the project database to schema
   11, restart only the project API/worker, switch only the protected frontend
   slot and run owner/onboarding/readiness/backup smoke checks on port 4180.
5. Start R4 only after R3.3 evidence and production smoke are accepted. The
   “Running” UI must consume the canonical paper portfolio/ledger contract
   rather than introduce another authoritative browser or database state.

Acceptance, publication to `main` and production cutover of the remaining work
are strictly sequential: R3.3 with its O1 slice → R4 → R5 → R6 → R7 →
R8 → R9 → R10A → R10B → R11 → R12. Parallel work is allowed only inside the
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
