# Capacity plan for the first 100 users

Audience: self-hosted operators
Last measured: 2026-07-15

The practical target is a bounded modular monolith, not a ChatGPT-scale microservice fleet. One
light API process serves the SPA, authenticated REST and shared market WebSockets. PostgreSQL owns
identity, workspaces and the durable research queue. CPU-heavy backtests run in a separate worker
process and then in a memory-limited worker thread. The legacy trading engine remains in the API
process until an explicit ownership migration and executor split can be performed safely.

```text
TLS reverse proxy
        |
Web/API + shared market WebSockets ---- legacy trading engine (admin only)
        |
PostgreSQL: identity + workspaces + durable jobs
        |
research worker supervisor
        |
bounded backtest worker threads
```

## Current host snapshot

The shared host measured during this implementation had:

| Resource | Measured state |
| --- | --- |
| Logical CPU | 192 |
| CPU | roughly 85–90% idle during inspection |
| RAM | 2.0 TiB total; about 1.3 TiB available |
| Root disk | 7.8 TiB total; about 6.0 TiB available (20% used) |
| Production API | about 338 MiB resident; about 414 MiB observed peak |
| Swap | 8 GiB allocated and full, but `si=0`, `so=0` and memory/I/O pressure averages were zero |

Full swap alone is not evidence of current memory exhaustion: the kernel may retain old cold pages
there. The zero swap-in/out and pressure readings showed no active memory contention at the time.
These figures are a point-in-time observation on a shared machine, not reserved capacity or an SLA.

## Protections implemented

- PostgreSQL connection pools are bounded and have connection/query/transaction timeouts.
- Authentication endpoints have stricter per-IP/login limits; the authenticated API uses a token
  bucket with a higher cost for mutations.
- Identical candle requests are coalesced and distinct upstream requests are limited to 24 active
  plus 128 queued operations.
- Slow quote, candle, order-book and trade-flow WebSocket clients are disconnected when their send
  buffer becomes unsafe.
- Research jobs are owner-scoped, deduplicated, durable and claimed with
  `FOR UPDATE SKIP LOCKED` leases.
- A user may have at most five queued/running jobs and only one running job.
- The supplied worker starts at two concurrent tasks, a 120-second wall timeout and 512 MiB old-gen
  limit per task. Compose caps the API at 4 CPU/4 GiB, PostgreSQL at 2 CPU/2 GiB and the research
  service at 2 CPU/2 GiB; operators should tune these after measuring their own workloads.
- Completed backtest results keep metrics, trades and bounded/downsampled curves rather than an
  unbounded execution trace.

## Why this should be comfortable for about 100 people

Charts and live data mostly share upstream subscriptions and do not require one exchange socket per
viewer. Fast local browser backtests consume the viewer's CPU. Heavy server jobs are accepted in
under a request, queued and isolated from the Node API event loop. Consequently, ten people starting
optimizers together increase queue time without freezing login, charts or trading.

Initial operational objectives:

- API p95 below 300 ms outside upstream-exchange outages;
- chart changes remain responsive while research jobs run;
- job submission below one second;
- market display age normally below one second;
- a worker timeout/OOM does not restart the API or trading engine;
- database wait, queue age and disk space are visible to the operator.

Run a load test against the actual reverse proxy and market mix before promising 100 concurrent
users. Monitor API p50/p95/p99, event-loop lag, RSS/heap, WebSocket count/buffers, PostgreSQL pool
wait, slow queries, queue depth/oldest age, worker duration/OOM/cancel rates, exchange stream age and
backup success.

## Scaling order

1. Add metrics dashboards and a repeatable 100-session load scenario.
2. Tune the existing API, database pool and two research slots from measured results.
3. Extract per-user trading ownership and credentials; migrate legacy bots offline with counts and
   hashes, retaining read-only SQLite rollback data.
4. Make a single durable trading executor the only process allowed to resume bots or use exchange
   credentials. Use leases/fencing and idempotent client order IDs.
5. Only then add a second stateless API process and cross-process event fan-out.
6. Add Redis/object storage only when PostgreSQL queue/result size or fan-out measurements justify it.

Starting another copy of the present API for “scaling” is explicitly unsafe because the current
SQLite trading engine can resume the same bots twice.
