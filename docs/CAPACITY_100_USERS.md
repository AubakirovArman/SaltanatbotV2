# Capacity plan for the first 100 active users

Audience: self-hosted operators and maintainers

Last measured: 2026-07-16

Status: baseline measured; the first process-wide API admission/readiness slice
is implemented, while the quantified 100-user proof and the remaining
cross-workload caps are still planned.

This plan covers the `public-http-paper` Research / Paper release. SSL/TLS,
HTTPS termination and live exchange execution are explicitly outside its active
scope. Before HTTPS, expose the HTTP endpoint only through a private
network/VPN/IP allowlist and use passwords that are not reused elsewhere.

The practical target is a bounded modular monolith, not a ChatGPT-scale
microservice fleet. One API process serves the SPA, authenticated REST and
shared public market WebSockets. PostgreSQL owns identity, workspaces, durable
authorization, research jobs and future multi-user alert/outbox records. One
singleton trading executor owns the protected SQLite trading/paper state under
[ADR 0001](adr/0001-execution-authority-and-system-of-record.md). CPU-heavy
research executes in a separate bounded worker.

```text
Private/VPN/IP-allowlisted HTTP endpoint
                    |
        single Web/API process
        |          |           \
        |          |            shared public market WebSockets
        |          |
        |          +---- singleton trading executor
        |                         |
        |                 protected trading SQLite
        |
PostgreSQL: identity + authorization + workspaces + durable jobs
        |
research worker supervisor (implemented)
        |
bounded backtest worker threads

PostgreSQL alert/outbox -> dedicated notification worker (planned in R5)
```

The diagram intentionally has no active TLS reverse-proxy layer. A later HTTPS
release may add one, but it is not a dependency or deliverable here.

## Capacity release contract

**Status:** planned validation on top of a measured and bounded single-process
baseline.

**Baseline:** the limits in the next section are implemented; the host snapshot
is observation only and is not capacity evidence.

**Remaining:** measure and tune the initial API governor, implement the
WebSocket/robot/alert/screener caps below, run the exact workload, meet the
recovery targets and pass every failure drill.

**Dependencies:** accepted ADR 0001, stable R2-R10 workload contracts, paired
PostgreSQL/SQLite backup generations and one fenced trading executor.

**Evidence:** versioned load source, metrics, fairness report, drill artifacts
and measured backup/restore timings.

**Exit criteria:** the final section's acceptance statement passes without
lowering safety boundaries or adding an unfenced API/executor process.

## Current host snapshot

The shared host measured during this implementation had:

| Resource | Measured state |
| --- | --- |
| Logical CPU | 192 |
| CPU | roughly 85–90% idle during inspection |
| RAM | 2.0 TiB total; about 1.3 TiB available |
| Root disk | 7.8 TiB total; about 6.0 TiB available (20% used) |
| Production API | about 343 MiB resident after restart; about 414 MiB observed peak |
| Research worker | about 18 MiB resident while idle |
| Swap | 8 GiB allocated and mostly/full, but no active swap-in/out or memory/I/O pressure was observed |

Full swap alone is not evidence of current memory exhaustion: the kernel may
retain old cold pages there. The zero swap-in/out and pressure readings showed no
active memory contention at the time. These figures are a point-in-time
observation on a shared machine, not reserved capacity, proof of 100-user
comfort or an SLA.

## Implemented baseline protections

- PostgreSQL connection pools are bounded and have
  connection/query/transaction timeouts. Current Compose defaults allocate 12
  API connections and 4 research-worker connections.
- Authentication endpoints pass through the general request governor and have
  independent failed-login buckets by client IP and normalized login.
  Registration counts successful attempts too. Both stores have a hard
  4,096-entry default.
- One process-wide API admission controller permits at most 128 active requests
  in total. Ordinary work may use 112 slots; 16 remain available for
  authentication, research-job cancellation and paper stop/kill controls.
  Up to 256 ordinary requests may wait for two seconds before a stable
  retryable HTTP 503. Admission runs before large request-body parsing.
- `/api/ready` verifies the migration checksum, PostgreSQL, the paper executor,
  research-worker heartbeat, disk watermarks and admission saturation. The
  public route has a separate per-IP 2 requests/second token bucket with burst
  10 and at most 4,096 keys. All accepted overlap shares one dependency scan;
  a completed result is reused for one second, bounding PostgreSQL/heartbeat/
  filesystem probe rate even across many source IPs. Its two PostgreSQL checks
  are sequential and the supported pool minimum is two, preserving one
  connection beside a readiness scan. The public body is categorical; bounded
  API/pool/admission/worker/readiness-limiter measurements are administrator
  only.
- Argon2id is globally limited to two active operations plus 32 queued requests
  by default; overflow fails with a generic retryable response. Each active
  default hash uses about 64 MiB plus library overhead.
- Identical candle requests are coalesced. Distinct upstream market requests are
  limited to 24 active plus 128 queued operations.
- Slow quote, candle, order-book and trade-flow WebSocket clients are
  disconnected once their buffered output exceeds the bounded policy; the
  current common threshold is 512 KiB per client.
- Research jobs are owner-scoped, durable, deduplicated and claimed with
  `FOR UPDATE SKIP LOCKED` leases. One owner may have at most five
  queued/running jobs and one running job.
- The research worker starts with two active tasks, a 120-second wall timeout
  and a 512 MiB old-generation limit per task. Accepted configured concurrency
  is deliberately limited to 1–4.
- Trading state is owner-scoped. Current per-owner defaults are eight saved
  exchange accounts, 24 saved robots and four concurrently running paper
  robots. The configured live limit is compatibility-only and cannot activate
  live work in `public-http-paper`.
- Disabling a user or changing trading permission revokes sessions, disconnects
  that user's owner-scoped streams and quiesces only that user's runtimes.
- Terminal job artifacts are bounded by the first of 30 days, 200 jobs or
  256 MiB per owner. Compact exact-request tombstones are bounded by 90 days and
  1,000 per owner; retention changes at most 50 rows per pass.
- Compose currently caps the API at 4 CPU/4 GiB, PostgreSQL at 2 CPU/2 GiB and
  the research service at 2 CPU/2 GiB. These are conservative defaults, not a
  measured final allocation.

## Global admission caps and remaining work

Per-owner limits alone are insufficient: 100 owners can each remain below their
quota while exhausting one process. The first API cap is now implemented; the
remaining rows must be delivered by their owning releases and integrated in
R11 before the project claims a comfortable 100-active-user envelope. These
are starting limits for the acceptance test and may be changed only from
measured evidence.

| Resource | Initial global cap | Per-owner cap | Overload behavior | Current status |
| --- | ---: | ---: | --- | --- |
| API work admitted concurrently | 128 total, including 16 reserved control slots | 8 target | ordinary work waits up to 2 seconds, then HTTP 503; controls never wait behind the ordinary queue | implemented; load tuning pending |
| API wait queue | 256 ordinary requests | included above | reject overflow with `global_admission_exhausted`; only cheap health bypasses, readiness is bounded | implemented |
| Readiness dependency scan | 1 in flight; completed result retained 1 second; 1 PG query at a time | 2 requests/second/IP, burst 10 | excess source receives `429 readiness_rate_limited`; a full 4,096-key store returns the remaining prune horizon; all admitted callers share one scan | implemented |
| Browser market WebSockets | 300 connections | 4 | close/reject with retryable `1013/429`; never grow buffers | global admission planned; slow-client bound exists |
| PostgreSQL application connections | 20 total: API 12 + research 4 + notification 4 | n/a | fail readiness before exhausting operator reserve | API/research 16 exist; notification 4 planned |
| PostgreSQL `max_connections` deployment floor | 40 | n/a | retain at least 20 connections for migration, backup and operator recovery | deployment validation planned |
| Running paper robots | 100 | 4 | reject new start; existing robots remain controllable | per-owner cap exists; global cap planned |
| Outstanding research jobs | 200 | 5, with 1 running | reject submission with retry hint; never enqueue without bound | per-owner cap exists; global cap planned |
| Research execution | 2 active tasks initially | 1 | fair queueing; tune only after profiling | implemented |
| Technical screener runs | 4 active; 250 symbols per preset | 1 active | queue fairly or reject; minimum scheduled interval 60 seconds | R5 planned |
| Enabled alert rules | 5,000 | 100 | reject new rule; existing rules continue | R5 planned |
| Alert evaluation batch | 500 rules/tick | bounded by owner fairness | carry remaining work to next lease; expose age | R5 planned |
| Telegram deliveries | lower of provider budget or 20 sends/second | 2 sends/second | token-bucket delay, retry/backoff and dead-letter state | R5 planned |
| Workspaces | 75 total, 25 active and 64 MiB retained payload per owner | same | reject create/import; preserve existing revisions | per-owner quotas plus 4 MiB metadata-first keyset responses implemented; global admission/load proof remains R11 |
| L2 capture scopes | 24 selected scopes | operator-governed owner access | stop new capture when disk free space falls below 30% | R10A planned |

All caps must be configuration-validated, visible in metrics and applied before
allocating large request bodies, worker threads, WebSocket buffers or result
artifacts. Admin role must not bypass a resource cap; an operator maintenance
override must be explicit, audited and short-lived.

## Quantified 100-user workload

The acceptance scenario uses exactly 100 authenticated browser sessions after a
15-minute ramp. It runs for two hours at steady load, adds a 15-minute burst,
then observes 30 minutes of recovery. The same seed, symbols, strategy inputs and
arrival schedule must be reusable across releases.

| Concurrent slice | Workload |
| --- | --- |
| 70 monitoring users | 1–3 chart panes each, 40 distinct shared market scopes in total, timeframe/symbol change every 60–180 seconds |
| 15 screener users | bounded manual technical-screen refresh every 15 seconds; ten saved screens also run once per minute |
| 10 automation users | inspect Strategy Studio and submit a combined burst of 40 backtest/optimizer jobs in 60 seconds; only admitted worker slots execute |
| 5 admin/onboarding users | user list/filter, pending activation, role change, workspace creation/import and password/login flows |
| Paper execution background | 60 running paper robots across 30 owners, with the test allowed to rise to but never exceed the 100-robot global cap |
| Alerts | 2,000 enabled rules in the normal mix, exercised again at the 5,000-rule cap |
| Notifications | 10 deliveries/second sustained for one minute and a 100-row burst, including Telegram timeout/429 injection |
| Public L2/ML scope | up to 24 capture scopes plus bounded inference replay after R10A/R10B; no unbounded venue-wide subscriptions |
| Login churn | 20 normal login attempts/minute plus a separately labelled failed-login burst that must trigger rate limits |

The mix intentionally combines interactive and background work. A chart-only
test cannot prove that optimizers, screeners, alerts, paper robots and
notifications coexist safely.

## Service-level acceptance objectives

These objectives apply only below the admitted global caps and exclude measured
upstream-exchange outages:

- ordinary authenticated API reads: p95 at most 400 ms and p99 at most 1 s;
- login/password mutations: p95 at most 800 ms while Argon2 admission remains
  bounded;
- job submission: p95 below 1 second;
- internal chart update delivery after ingest: p95 at most 500 ms;
- application error rate below 1%;
- Node event-loop lag p95 at most 50 ms;
- interactive queue wait p95 at most 5 seconds and admitted heavy-job queue wait
  p95 at most 30 seconds; rejected work is not hidden as latency;
- market freshness normally below 1 second and explicitly degraded when the
  source violates its contract;
- PostgreSQL pool wait p95 below 50 ms with zero connection exhaustion;
- after the steady and burst phases, at least 30% sustainable CPU, available RAM
  and disk headroom remains;
- killing or exhausting a worker/provider must not restart or starve the API,
  login flow, chart delivery or singleton paper executor.

The test must publish p50/p95/p99, throughput, rejection count, event-loop lag,
RSS/heap, WebSocket count/buffer disconnects, PostgreSQL pool wait/slow queries,
queue depth/oldest age, worker duration/OOM/cancel, stream freshness, disk growth
and owner-fairness distribution.

## Recovery objectives

The repository already provides verified PostgreSQL dump plus online SQLite
backup/restore tooling. The following RPO/RTO values are release-exit targets,
not claims about the current manual backup schedule.

| Data class | Target RPO | Target RTO | Required mechanism |
| --- | ---: | ---: | --- |
| PostgreSQL identity, authorization, workspaces, jobs, alert/outbox | 15 minutes | 60 minutes | scheduled dump/WAL policy, verified off-process copy and isolated restore drill |
| Protected SQLite paper/trading state and matching `.secret` | 15 minutes | 60 minutes | scheduled online backup, `quick_check`, SHA-256 manifest and matching-key verification |
| Cross-store recovery generation | PostgreSQL and SQLite capture times no more than 5 minutes apart | included above | paired generation manifest plus ADR reconciliation after restore |
| L2 corpus and model registry after R10 | 1 hour | 4 hours | partition checkpoints, checksums, bounded replay and model/dataset manifests |
| Rebuildable candle/public market cache | no durability promise | 30 minutes to repopulate accepted hot scopes | discard/rebuild without blocking tenant state |
| Release binary/configuration | release artifact is immutable | 30 minutes | verified archive, configuration backup and atomic rollback drill |

Restoring an at-least-once notification outbox may redeliver a provider-accepted
message whose acknowledgement was not retained. The stable delivery
deduplication ID must survive backup/restore; the documentation must describe
possible duplicates rather than promise exactly-once delivery.

## Mandatory failure drills

Each drill produces timestamps, correlation IDs, before/after counts and a
machine-readable result. Passing unit tests alone is insufficient.

| Injected failure | Required observation |
| --- | --- |
| Kill a research worker during a job | lease expires/requeues once; no duplicate published result; API latency remains within objective |
| OOM/timeout one worker thread | only that job fails/retries within policy; worker supervisor and API remain healthy |
| Stop PostgreSQL | readiness becomes false; authenticated mutations fail closed; no SQLite or owner-state corruption |
| Hold/exhaust PostgreSQL pool | admission rejects bounded work; cheap health and the operator control reserve remain available; readiness coalesces to one scan/short cached result, frequent sources receive 429, and saturation may return admission 503 instead of adding unbounded probes |
| Kill/restart the API with paper robots active | one singleton executor recovers idempotently; no duplicate fill, order, reservation or event |
| Remove/wrong-mode the SQLite master key in an isolated copy | startup fails before mutation and does not create a replacement key |
| Inject SQLite lock/corruption in an isolated copy | executor fails closed; verified restore meets the stated RTO |
| Fill the data filesystem through the soft watermark | L2 capture and new heavy artifacts stop first; login/chart/journal writes retain reserved space |
| Break or gap an upstream market WebSocket | evidence becomes stale/unavailable; screener, alert and ML paths do not treat the gap as normal data |
| Telegram timeout, `429`, and accepted-before-ack crash | bounded retry/backoff; stable dedupe ID; at-least-once duplicate is visible and no event is silently lost |
| Exceed API/WS/job/robot/alert global caps | fair `429/503/1013` backpressure; memory and queue length remain bounded |
| Restore paired PostgreSQL/SQLite generation | owner counts, workspaces, jobs, paper totals and command reconciliation match the retained manifest |

## Prerequisites for a second API process

Starting another copy of the current API for “scaling” is unsafe even in paper
mode: tenant isolation prevents cross-user reads, but the protected SQLite
executor and bot recovery remain singleton state. A second stateless API process
is allowed only after all of the following are implemented and tested:

1. Extract the trading/paper executor into one separately supervised singleton
   service. Stateless API processes must not open trading SQLite, decrypt its
   root key or resume bots.
2. Acquire an exclusive durable lease with a monotonic fencing token. Every
   command, recovery pass, journal append and event includes that token; a stale
   executor is rejected even if its process is still alive.
3. Put one durable PostgreSQL command ID before every cross-store mutation, then
   apply and acknowledge it idempotently under ADR 0001. Direct dual writes stay
   forbidden.
4. Fence owner authorization epoch, account/credential revision, bot revision
   and arm epoch at final consume. A load balancer or API replica may not become
   execution authority.
5. Publish executor events through a bounded cross-process fan-out with replay
   cursor and owner filter; API-local memory is not the source of truth.
6. Share only PostgreSQL-backed sessions, CSRF/WS tickets and rate/admission
   state needed for consistent policy. No replica-local counter may permit a
   global cap to be exceeded.
7. Prove failover by killing the lease holder, delaying the stale process and
   starting a replacement. The stale holder must produce zero accepted commands
   after fencing, and the replacement must not duplicate recovery.
8. Repeat the full two-tenant REST/WS isolation suite, migration-count tests,
   load scenario and paired backup/restore drill with two API replicas.

Until that evidence exists, scaling means tuning the one API, PostgreSQL pools
and bounded worker services—not cloning the API.

## Evidence and exit criteria

**Evidence required:**

- versioned load-test source and exact environment/configuration;
- dashboards or exported metrics for every objective and global cap;
- per-owner fairness report showing that one optimizer/screener owner cannot
  starve another;
- all failure-drill reports;
- paired backup/restore manifests and measured RPO/RTO;
- proof that `RUNTIME_PROFILE=public-http-paper` remained active and that no
  private/signed exchange request occurred.

**Exit criteria:** the exact 100-session mix completes steady, burst and recovery
phases within the documented SLOs and global caps; every injected failure is
bounded and recoverable; at least 30% sustainable resource headroom remains; and
the result is reproducible by a self-hosted operator. If any condition fails,
the supported active-user number or feature concurrency is lowered instead of
publishing an unsupported 100-user claim.
