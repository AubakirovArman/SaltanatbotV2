# HTTP & WebSocket API reference

R4 API deployment evidence (accepted 2026-07-17): commit
`bb455facdfe5a1b3cabe15490c86c299ea684ee7`, GitHub Actions run `29560112312` with all 6 required
jobs successful, protected slot `r4c-schema12-bb455fa`, PostgreSQL schema 12 and trading SQLite
schema 9. Paired recovery evidence passed. This remains a pre-HTTPS, paper-only API; private/live
exchange execution is not enabled.

SaltanatbotV2 exposes an Express + WebSocket backend that serves market data (catalog, candles, sparklines), live public candle/quote/order-book/trade-flow/arbitrage streams, and a persisted paper-trading engine. Dormant private/live adapter contracts are retained for future work but are unreachable in the supported `public-http-paper` runtime. All HTTP endpoints return JSON, CORS is allowlist-based, and the generic application body limit is 1 MB; identity, onboarding and job routes apply their own bounded envelopes. By default the server listens on `http://127.0.0.1:4180` (override with the `PORT` and `HOST` environment variables). Market endpoints live under `/api/*`, trading endpoints under `/api/trade/*`, and six WebSocket endpoints are exposed at `/stream`, `/quotes`, `/orderbook`, `/trade-flow`, `/arbitrage-stream` and `/trade-stream`. Any unmatched non-API path falls through to the bundled frontend single-page app.

Market catalog, candle, sparkline and WebSocket payloads have canonical TypeScript contracts
plus fail-closed runtime parsers in `packages/contracts`. The frontend validates untrusted JSON at
the transport edge before updating state; malformed or unknown stream messages produce an explicit
connection error instead of being trusted through a type assertion.

The generated [API endpoint index](./API_ENDPOINTS.generated.md) is the route-presence contract and is checked against the Express sources in CI.

- Base URL (default): `http://localhost:4180`
- Content type: `application/json`
- Validation: public route inputs are bounded and validated at their transport boundary; most HTTP
  schemas use [zod](https://zod.dev), while shared response/stream contracts also have fail-closed
  runtime parsers. `/arbitrage-stream` accepts no query parameters. Invalid HTTP input normally
  returns `400`; invalid WebSocket input receives a typed error and closes.

## Account authentication

Database mode protects all application REST and WebSocket routes except `/api/health`, `/api/ready`
and the registration/login bootstrap surface. Static assets remain available so the SPA can render
the login screen. The curl/WebSocket examples below assume that the caller already has the session
cookie returned by login; browser WebSocket handshakes must also have a same-origin or explicitly
allowed `Origin`.

1. `POST /api/auth/register` with `{ "login", "password" }` returns `202`; the account is pending.
2. An administrator calls `POST /api/admin/users/:id/activate` (the bundled account panel does this).
3. `POST /api/auth/login` sets HttpOnly `sbv2_session` and readable SameSite `sbv2_csrf` cookies and
   returns the user plus CSRF value.
4. Unsafe requests copy the CSRF cookie into `X-CSRF-Token`.
5. Market WebSockets use the active same-origin session cookie. `/trade-stream` additionally requires
   a one-time ticket from `POST /api/trade/ws-ticket` as
   `sbv2.ticket.<base64url(ticket)>`.

Identity endpoints:

| Method/path | Access | Result |
| --- | --- | --- |
| `GET /api/auth/config` | Public | Auth mode and registration availability |
| `POST /api/auth/register` | Public, rate-limited | Pending account |
| `POST /api/auth/login` | Public, rate-limited | Active session; pending/disabled accounts fail |
| `GET /api/auth/me` | Session | Current user and permissions |
| `POST /api/auth/logout` | Session + CSRF | Revokes current session |
| `POST /api/auth/change-password` | Session + CSRF | Changes Argon2id hash and revokes all sessions |
| `GET /api/admin/users` | Admin | Users, optionally filtered by status |
| `POST /api/admin/users/:id/activate` | Admin + CSRF | Activates pending/disabled user |
| `POST /api/admin/users/:id/disable` | Admin + CSRF | Disables user and revokes sessions |
| `PATCH /api/admin/users/:id/permissions` | Admin + CSRF | Changes application/trading roles |
| `GET /api/admin/operations/metrics` | Admin | No-store process, PostgreSQL, admission and worker-health snapshot |

`appRole` is `user` or `admin`. `tradingRole` is `none`, `read-only`, `paper-trade` or
`live-trade`. New registrations always receive `user + none`; an administrator explicitly grants
the minimum required trading role. A grant changes authorization only: it does not give the admin
access to that user's trading data. Every database-auth trading request derives its owner from the
server-validated session, and trading resources/private events are filtered to that owner. Foreign
resource IDs return `404`, including when requested by another application administrator.

`AUTH_TRADING_ROLES_ENABLED=0` can temporarily disable effective non-admin trading roles during
maintenance. Permission changes and user disablement revoke sessions, disconnect the user's private
trading stream and stop that user's active robot runtimes.

Every auth state change enters PostgreSQL `audit_events`; every mutating trade call also enters the
caller's owner-scoped, redacted SQLite `audit_log`. Token/bearer login exists only in explicit
`AUTH_MODE=legacy` test or private-demo compatibility mode and is not a production API contract.

### Workspaces and research jobs

`/api/workspaces` is owner-scoped. Schema-v8 documents keep their workflow content revision
separate from the PostgreSQL wrapper `revision` used for optimistic concurrency. Create with
`{clientId,name,schemaVersion,payload}`; full updates, rename, archive, restore, rollback and purge
must carry the latest wrapper revision. Stale writes return `409` with current metadata and are
never overwritten automatically.

The workflow routes include:

- UUID-keyset `GET /api/workspaces?status=active|archived|all&cursor=<uuid>&limit=1..25`
  and `GET /api/workspaces/quota`;
- create, full update and `PATCH /:id/name`;
- duplicate, archive and restore;
- archived-only `DELETE /:id/permanent?revision=N`, which cascades retained revisions;
- SHA-256 export plus strict schema-v8/schema-v7 import;
- descending revision-keyset history
  (`GET /:id/revisions?cursor=<revision>&limit=1..10`) and same-schema rollback.

Every list/history response has explicit
`page={itemLimit,responseByteLimit,returnedItems,returnedPayloadBytes,responseBytes,hasMore,nextCursor}`.
The complete serialized response is capped at 4 MiB. PostgreSQL is queried metadata-first, so the
API process never materializes an unbounded payload set. Workspace list rows and quota come from one
read-only repeatable-read snapshot. Each subsequent keyset page has its own snapshot; UUID order is
independent of `updated_at`, and clients de-duplicate IDs while traversing concurrent changes.

Default owner quotas are 25 active workspaces, 75 total, 20 revisions, 1 MiB per persisted payload
and 64 MiB of retained current-plus-revision payload. Request/import envelopes receive a bounded
64 KiB protocol allowance, which permits a compact API export at the payload limit to be imported
again. Compact payloads are additionally checked against a conservative PostgreSQL `jsonb::text`
upper bound: separator spaces plus exact finite exponent-number expansion. Current and revision
rows have a 4 MiB-minus-64 KiB database constraint, reserving room for response metadata; the
retained quota must be at least 8 MiB for one current row and its first revision. Rejections use stable
`workspace_active_quota_exceeded`, `workspace_total_quota_exceeded`,
`workspace_storage_quota_exceeded`, `workspace_document_too_large` or
`workspace_database_document_too_large` or `workspace_envelope_too_large` codes. Their `quota`
object is durable committed usage; optional
`attempted` values describe only the rejected projection.
Archive and archived-only purge remain available after limits are lowered; restore remains
quota-enforced.

In database-auth mode every workspace request must also send
`X-SBV2-Expected-User: <current session user ID>`. The browser client captures this value when it
starts synchronization. If a shared cookie changes users in another tab, a missing or stale header
returns `409 workspace_owner_mismatch` before any workspace is read or written; refresh the session
and restart synchronization. Every mutation also fences the exact durable authorization revision.
Legacy-auth compatibility mode does not require the expected-owner header.

`POST /api/jobs` accepts a bounded, kind-discriminated research-job payload and returns `202` with
a durable job. Every request is validated through the central research-job registry
(`backend/src/jobs/registry.ts`), which registers four strict kinds: `kind: "backtest"` runs a
strategy over client-uploaded candles in the backtest worker thread, `kind: "screener"` runs an
on-demand technical scan in-process ([screener guide](SCREENER.md)), `kind: "multi-market-eval"`
runs the server multi-market strategy evaluation described below and `kind: "ga-evolution"` drives
the checkpointed server GA evolution described in the next subsection. Unknown kinds keep the same
hard-fail validation error as before the registry existed, and the pre-existing kinds keep
byte-identical request and response shapes. `GET /api/jobs`, `GET /api/jobs/metrics`,
`GET /api/jobs/:id` and `POST /api/jobs/:id/cancel` are owner-scoped and always return
`Cache-Control: private, no-store, max-age=0` with `Vary: Cookie`. States are
`queued/running/completed/failed/cancelled`. One user may have five active jobs and one running job;
identical payloads are deduplicated. A separate research worker claims jobs by lease and stores a
bounded result (for `backtest`: metrics, trades and a downsampled equity curve). After artifact
compaction, list responses expose `artifactsExpired: true`; `GET /api/jobs/:id` and an exact
`clientRequestId` retry return `410 job_artifacts_expired`. Reusing the same request ID with
different content remains `409 job_idempotency_conflict`, while a new request ID may rerun the same
content.

`kind: "multi-market-eval"` (part of the accepted R9.1 release — see the recorded
[R9.1 acceptance evidence](evidence/R9_1_SERVER_EVALUATION.md) — governed by
[ADR 0003](adr/0003-canonical-ir-dataset-backtest-contract.md)) evaluates one generated strategy
across one to six unique catalog markets that share a single timeframe. The strict body is
`{kind, ir, markets: [{symbol, timeframe}], lookbackBars (500..20000), split: {trainFraction
(0.5..0.9, default 0.7), embargoBars (0..500, default 8)}, seed, clientRequestId?}`. The IR must
pass the server `parseStrategyIR` trust boundary and every symbol must resolve to a real
exchange-routed catalog instrument. The research worker fetches real closed provider bars
in-process under a shared 90-second budget with bounded concurrency — synthetic fills are
forbidden, so a market that cannot supply enough real closed bars fails the job with an explicit
`multi_market_eval_*` error code instead of degrading. It then pins the data identity as a
`dataset-v1` descriptor with a canonical SHA-256 fingerprint, splits each market into train and
out-of-sample windows separated by the embargo gap (the test window starts strictly after
training), runs train and out-of-sample backtests per market through the existing backtest worker
thread and finishes with one shared capital-pool portfolio run over the out-of-sample windows. The
stored result (`schemaVersion: "multi-market-eval-v1"`, bounded at 256 KiB) records the engine
version, the dataset descriptor with its fingerprint, the seed and per-market
train/out-of-sample metric sections plus the portfolio section; identical (IR, dataset
fingerprint, config, engine version) inputs produce byte-identical results. The evaluation
universe is the currently listed public catalog only, so results carry survivorship bias and are
research evidence, not performance claims.

### Server GA evolution and promotion (R9.2, in progress — not accepted)

R9.2 is implemented on `main` but **not yet accepted or deployed**: production still runs the
accepted R9.1 slot `r9a-schema16-4f5bc64` on PostgreSQL schema 16, and this contract may change
until an acceptance record exists. The surface is authenticated, owner-scoped and research-only;
the public strategy gallery stays out of scope until R9.3.

`kind: "ga-evolution"` enqueues a durable, checkpointed genetic-algorithm run over the pure
generator primitives (the workspace package `@saltanatbotv2/strategy-generator`). The strict start
body is `{kind, mode: "start", config: {markets (1..4 unique catalog symbols), timeframe (shared
by every market), lookbackBars (500..20000), split: {trainFraction (0.5..0.9, default 0.7),
embargoBars (0..500, default 8)}, seed (0..4294967295), population (8..64), generations (1..16),
objectives?}, clientRequestId?}`; `{kind, mode: "resume", runId, clientRequestId?}` continues a
checkpointed run. `objectives` defaults to the canonical vector
`netProfitPct` (maximized), `maxDrawdownPct` (minimized), `sharpe` (maximized) and `complexity`
(minimized); at least two unique keys are required. On top of the ordinary research-job quota, at
most **one active GA run per owner** is admitted (`429 ga_run_active`); resuming a run that is not
checkpointed returns `409 ga_run_not_resumable` and an unknown or foreign run returns
`404 ga_run_not_found`.

The run fetches its dataset once through the same real-closed-bars discipline as
`multi-market-eval` and pins it with a `dataset-v1` fingerprint, then breeds one generation at a
time from the seeded package PRNG. Candidates are deduplicated by fingerprint and never
re-evaluated. Each new candidate receives per-market train and out-of-sample backtests in the
backtest worker thread plus one shared-capital out-of-sample portfolio run, an objective vector,
an `oos_report` (direction-adjusted train-vs-OOS gap per objective, OOS loss share, cross-market
dispersion and explicit `overfit`/`unstable` flags) and a cumulative Pareto rank (rank 0 = the
non-dominated frontier). Lineage rows (parents, mutation log, IR, metrics) and the resume
checkpoint commit atomically per generation, so cancellation between candidates completes the job
with a resumable `status: "checkpointed"` result instead of a failure. Resume refetches the market
data and verifies the pinned fingerprint; drifted history fails the run with `ga_dataset_drift` —
determinism is never silently violated. The stored result (`schemaVersion: "ga-evolution-v1"`,
bounded at 256 KiB) records the run ID, status, generations completed, dataset fingerprint,
engine and generator versions, seed, the top frontier entries and candidate counts. The same seed
and dataset produce identical results, including across checkpoint/resume.

The `/api/ga` router only reads and promotes — it never executes anything. Responses use
`Cache-Control: private, no-store` with `Vary: Cookie`, and request bodies are capped at 4 KiB
(`413 ga_envelope_too_large`).

| Method/path | Input | Result |
| --- | --- | --- |
| `GET /api/ga/runs?limit=1..50` | optional bounded limit | Recent runs: status (`running/checkpointed/completed/failed/cancelled`), config, seed, dataset fingerprint, generation progress |
| `GET /api/ga/runs/:id?generation=N&limit=1..100` | optional generation filter and page limit | Run detail with the Pareto frontier summary and one bounded candidate page |
| `GET /api/ga/runs/:id/candidates/:fingerprint` | none | Candidate IR, per-market train/OOS metrics, mutation log and the bounded ancestor lineage chain |
| `POST /api/ga/promote` | `{runId, fingerprint}` | Stamps `promoted_at` (idempotent) and returns the full `ga-artifact-v1` bundle |

Promotion targets the owner's **own** strategy library only. The server refuses a candidate
without an out-of-sample report (`409 ga_promotion_requires_oos`) or flagged overfit
(`409 ga_promotion_overfit`). The returned bundle carries the IR plus provenance: run ID,
fingerprint, generation, seed, dataset fingerprint, engine and generator versions, objectives,
Pareto rank, the OOS report and the lineage chain. Foreign or unknown candidates return
`404 ga_candidate_not_found`; the checkpoint (population genomes and RNG state) never leaves the
server.

### Onboarding

The schema-v11 onboarding API is authenticated and owner-scoped. Every request must carry
`X-SBV2-Expected-User: <current session user ID>` so a tab whose shared session cookie changed
cannot read or mutate the previous account's progress. Unsafe calls also require the normal CSRF
header. The server revalidates the durable authorization revision inside the mutation transaction.

| Method/path | Body | Result |
| --- | --- | --- |
| `GET /api/onboarding` | none | Current owner's state; a new account without a row receives virtual `not_started`, revision `0` |
| `PUT /api/onboarding/goal` | `{revision,goal}` | Selects `monitoring`, `price-alert`, `backtest` or `paper-robot` |
| `POST /api/onboarding/milestones` | `{revision,milestone}` | Records the matching first chart, alert, backtest or paper-bot milestone |
| `POST /api/onboarding/dismiss` | `{revision}` | Dismisses the current guide |
| `POST /api/onboarding/restart` | `{revision}` | Clears the goal and milestones for a fresh run |

All responses are `Cache-Control: no-store`. Mutations use optimistic revisions and return
`409 onboarding_conflict` with the current state after a stale write. If the account's durable
authorization changes between request authentication and the locked mutation,
`409 onboarding_authorization_changed` is returned; a missing or stale expected-owner header
returns `409 onboarding_owner_mismatch`. Onboarding bodies are capped at 16 KiB. Existing accounts
are seeded as dismissed by migration v11, so deploying onboarding does not interrupt established
users.

### Owner-scoped server alerts (R5.1 / schema 13)

The `/api/alerts` router is authenticated, owner-scoped, rate-limited and
research-only. Every request must send `X-SBV2-Expected-User` with the current
session user ID. `POST`, `PUT`, `DELETE` and action endpoints also require the
normal CSRF header. Responses use `Cache-Control: no-store`.

R5.1 accepts only `price-threshold` definitions with Binance/Bybit public last
price, a non-calendar timeframe from `1m` through `1w`, inclusive crossing and
`once-until-rearmed`. It accepts only `deliveryChannels: ["in-app"]`. Telegram,
order placement, borrowing, margin mutation, private streams and signed exchange
requests are unavailable.

| Method/path | Input | Result |
| --- | --- | --- |
| `GET /api/alerts?limit=200` | optional bounded limit | `alert-rule-list-v1`; all manageable non-archived rules precede archived history |
| `POST /api/alerts` | `{clientId,definition}` | Idempotently creates a rule; `201` |
| `GET /api/alerts/:id` | none | One public owner projection |
| `PUT /api/alerts/:id` | `{expectedRevision,definition}` | Immutable new revision |
| `POST /api/alerts/:id/archive` | `{expectedRevision}` | Archives the rule |
| `DELETE /api/alerts/:id` | `{expectedRevision}` | Archive-compatible alias |
| `POST /api/alerts/:id/rearm` | `{expectedRevision}` | Creates a freshly armed revision |
| `GET /api/alerts/events?limit=200&cursor=…` | optional owner-bound cursor and rule filter | `alert-event-page-v1` forward stream |
| `GET /api/alerts/outbox?limit=200` | optional bounded limit | Public in-app delivery evidence |

Create example:

```json
{
  "clientId": "browser-alert:8f2c17e5ad9b3c01",
  "definition": {
    "schemaVersion": "alert-rule-v1",
    "kind": "price-threshold",
    "name": "BTCUSDT above 65000",
    "enabled": true,
    "cooldownSeconds": 0,
    "deliveryChannels": ["in-app"],
    "exchange": "binance",
    "marketType": "spot",
    "priceType": "last",
    "symbol": "BTCUSDT",
    "timeframe": "1m",
    "direction": "above",
    "threshold": "65000",
    "crossing": "inclusive",
    "repeat": "once-until-rearmed",
    "researchOnly": true,
    "executionPermission": false
  }
}
```

The public rule record exposes `id`, `clientId`, revision, definition,
lifecycle, timestamps and bounded error state. It never exposes owner IDs,
authorization revisions, leases, credentials or destinations.

An event page always contains:

```ts
interface AlertEventPageV1 {
  schemaVersion: "alert-event-page-v1";
  events: AlertEventV1[];       // at most 200
  nextCursor: string;           // opaque and owner-bound
  hasMore: boolean;
  generatedAt: string;          // canonical UTC
  researchOnly: true;
  executionPermission: false;
}
```

When `hasMore` is true, clients must request the next page and durably process
every returned event before checkpointing the final cursor. The per-owner event
sequence is transactional, so a same-owner late commit cannot appear behind an
already visible watermark. A cursor from another owner returns
`400 invalid_alert_event_cursor`; a cursor ahead of a restored database returns
`409 alert_event_cursor_ahead`.

Stable mutation errors include `alert_owner_mismatch`,
`alert_authorization_changed`, `alert_not_found`,
`alert_revision_conflict`, `alert_idempotency_conflict`,
`alert_quota_exceeded`, `alert_capacity_exceeded`,
`unsupported_alert_kind` and `unsupported_alert_delivery_channel`. Request
bodies are capped at 65,536 bytes.

The server uses exact public closed candles and advances one durable state/bar
revision per completion. See [ALERTS.md](./ALERTS.md) for baseline/crossing
semantics, capacity, retention and schema-13 recovery.

### Readiness, metrics and global admission

`GET /api/health` is a public liveness probe. `GET /api/ready` is a public, no-store readiness
probe. Requests first cross ordinary global admission and then a dedicated bounded per-IP token
bucket (2 requests/second, burst 10 and 4,096 keys by default). The bucket rejects excess with
`429 readiness_rate_limited` and `Retry-After` without starting the handler. Accepted concurrent
callers share one process-wide PostgreSQL/heartbeat/filesystem evaluation; its completed result is
reused for the configured one-second TTL, so multi-source sequential polling within that API process
cannot multiply probes without bound. Unexpected evaluation rejection is not cached and the next request retries. This is
a short operational cache, not a long-lived availability assertion.

Once admitted and rate-limited, readiness returns `200` for `ready` or `degraded` and `503` for
`unready`; admission saturation may instead reject it with the stable
`503 global_admission_exhausted` envelope described below. Every readiness response, including
admission `503` and limiter `429`, is `Cache-Control: no-store`. The public body reports only
categorical status for migrations, PostgreSQL, the paper executor, research worker, filesystem and
admission. Exact migration versions/checksums, probe latency, heartbeat age/state, free bytes/
percentage and admission counts/saturation are administrator-only. The public body contains no
account payload, session, credential, strategy or order data.

`GET /api/admin/operations/metrics` is protected by the administrator router and returns
`Cache-Control: no-store`. It adds process-local API counters/latency buckets, PostgreSQL pool
counts, the complete admission snapshot, `readinessRateLimit` configuration/counters
(`refillPerSecond`, `burst`, `maxBuckets`, `buckets`, `allowed`, `rejected`) and the latest
research-worker heartbeat. The public readiness body does not expose limiter counters. When
`OPERATIONS_RECOVERY_STATUS_FILE` points to a valid owner-only receipt journal created by a successful
`recovery:verify`, `recovery.lastVerifiedGeneration` contains only the receipt version, generation
ID, verification time, release commit, schema version, capture span and source-generation basename.
It is `null` when the setting or valid receipt is absent and never changes readiness.

All `/api` requests first cross one process-wide admission controller. Only the cheap
`/api/health` liveness probe bypasses it. `/api/ready` performs PostgreSQL, heartbeat and filesystem
work, so it uses the bounded ordinary lane; under saturation its admission `503` is itself a valid
not-ready signal. Authentication, job cancellation, paper-bot stop and the kill command use the
reserved control lane. Ordinary work can use at most `maxActive - reservedControlSlots`, waits in
one bounded FIFO queue and fails with `503 global_admission_exhausted` plus `Retry-After` when the
queue is full or its timeout expires. Control requests do not wait behind ordinary work and fail
immediately if the total active limit is already exhausted. The readiness limiter has its own
bounded IP store, so probe traffic cannot consume authentication/control token buckets. When that
store is full, `Retry-After` covers the remaining idle-entry prune horizon rather than inviting an
impossible early retry. Readiness performs its two PostgreSQL checks sequentially; supported pools
have at least two connections, leaving one available for authentication/control during the bounded
probe.

## Shared types

### `Instrument`

Returned by `/api/catalog` and embedded in the `/api/candles` response.

| Field | Type | Notes |
| --- | --- | --- |
| `symbol` | `string` | e.g. `BTCUSDT` |
| `displayName` | `string` | e.g. `Bitcoin / Tether` |
| `assetClass` | `"crypto" \| "forex" \| "stock" \| "index"` | |
| `exchange` | `string` | Descriptive label, e.g. `Binance / Bybit` |
| `currency` | `string` | Quote currency, e.g. `USDT` |
| `provider` | `"binance" \| "synthetic"` | Data source used for the instrument |
| `basePrice` | `number` | Reference price used by the synthetic provider |
| `decimals` | `number` | Price precision |

### `Candle`

| Field | Type | Notes |
| --- | --- | --- |
| `time` | `number` | Bar open time (ms epoch) |
| `open` | `number` | |
| `high` | `number` | |
| `low` | `number` | |
| `close` | `number` | |
| `volume` | `number` | |
| `final` | `boolean` *(optional)* | Present when the bar is closed |
| `source` | `string` *(optional)* | Origin of the bar, e.g. `binance`, `bybit` |

### Timeframes

Valid values for any `timeframe` parameter:

```
1m  5m  15m  30m  1h  2h  4h  1d  1w  1M
```

### Chart types

Enumerated by `/api/catalog` (`chartTypes`):

```
candles  hollow  heikin  bars  line  step  area  baseline  renko  linebreak  kagi  pnf
```

---

## Market REST endpoints

### `GET /api/health`

Liveness probe. Takes no parameters.

**Response `200`**

```json
{
  "ok": true,
  "service": "saltanatbotv2-backend",
  "ts": 1751932800000
}
```

```bash
curl http://localhost:4180/api/health
```

---

### `GET /api/catalog`

Returns the full instrument catalog plus the supported timeframes and chart types. Takes no parameters.

**Response `200`** (`CatalogResponse`)

| Field | Type |
| --- | --- |
| `instruments` | `Instrument[]` |
| `timeframes` | `Timeframe[]` |
| `chartTypes` | `ChartType[]` |

```json
{
  "instruments": [
    {
      "symbol": "BTCUSDT",
      "displayName": "Bitcoin / Tether",
      "assetClass": "crypto",
      "exchange": "Binance / Bybit",
      "currency": "USDT",
      "provider": "binance",
      "basePrice": 64000,
      "decimals": 2
    }
  ],
  "timeframes": ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"],
  "chartTypes": ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"]
}
```

```bash
curl http://localhost:4180/api/catalog
```

---

### `GET /api/instruments` and `GET /api/venues`

`/api/instruments` returns the cached normalized registry assembled from Binance, Bybit and the
registered public venue adapters (currently OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase,
dYdX, KuCoin and MEXC). Optional filters are
`venue`, `marketType`, `symbol`, `assetId`, `status` and `limit` (`1..2000`). Only freshly verified
rows are returned by default; `includeStale=true` explicitly includes retained stale catalog rows.
Its response envelope is `updatedAt`, `checkedAt`, `stale`, `includeStale`, `total`, `truncated`,
`instruments`, `sourceErrors` and `sourceStates`. `/api/venues` returns `updatedAt`, `checkedAt`,
`stale`, `capabilities`, `sourceErrors` and `sourceStates`. Every source state contains `source`,
`status` (`fresh`, `stale-cache` or `quarantined`) and `checkedAt`, with optional `receivedAt`,
`ageMs` and `message`. Fresh and stale-cache states include coherent receipt age:
`receivedAt <= checkedAt` and `ageMs = checkedAt - receivedAt`. A fresh source can therefore have
non-zero age when an earlier concurrent request finishes before the final registry check; it has no
error message. Capability booleans are conservative public-discovery summaries and must never be
used to authorize an account mutation. Binance/Bybit additionally expose `scopes` records keyed by
`product + operation + status`: missing combinations are unsupported, `experimental` is not a
production-readiness claim, and `manual-only` cannot be invoked by a strategy. The current scoped
private paths are experimental Binance perpetual plus experimental Bybit spot/perpetual; Bybit UTA
borrow is manual-only. Deposit/withdrawal is unsupported. None of these records proves account
entitlement or regional eligibility.

### `GET /api/market-data/:venue/*`

The public adapter facade currently allowlists `okx`, `gate`, `hyperliquid`, `deribit`, `kraken`,
`coinbase`, `dydx`, `kucoin` and `mexc`. It never accepts credentials and every response
contains `readOnly: true`.

| Suffix | Required query | Result |
| --- | --- | --- |
| `/instruments` | `marketType`; optional `status`, `assetId`, `limit=1..5000` | normalized metadata plus rejected-row quarantine |
| `/tickers` | `marketType`; optional `limit=1..5000` | bounded executable top books; unsupported all-market feeds fail closed |
| `/ticker` | `marketType`, exact `instrumentId` | one executable top book |
| `/depth` | `marketType`, exact `instrumentId`; optional `limit=1..400` | complete REST/L2 snapshot with native quantity unit |
| `/funding` | `marketType=perpetual`, exact scope-matching `instrumentId`; optional `historyLimit=1..1000` | scope-preserving current estimate, verified schedule state and bounded history |

`GET /api/market-data/health/upstreams` is a separate `no-store`, read-only operational snapshot.
It returns each named public REST source's concurrency budget/usage, queue-free overload rejects,
circuit/cooldown state, success/failure/abort counters and aggregate latency. It contains no request
payloads, credentials, account state or order data.

Individual venues may enforce a smaller bound or reject a market type. Typed upstream failures map
to `400`, `429`, `499`, `502`, `503` or `504`; `499` means the caller disconnected/cancelled before the
adapter completed, `503` with `Retry-After` means the bounded process-wide upstream pool/source is
full or its failure circuit is cooling down,
and an unknown venue is `404`. Semantically identical in-flight requests share one upstream call
while each HTTP client retains independent cancellation. The funding facade currently supports
periodic funding only for the `perpetual` scope; spot, margin, dated future, option and native-spread
stable IDs fail before adapter I/O. The transport-safe public TypeScript client is in
`packages/arbitrage-sdk`.

dYdX is intentionally exposed only as Indexer research data: its books are marked
`canonical: false`, `executable: false` and `executionStatus: research-only`. Registration in the
shared catalog and public facade does not make an Indexer observation safe for route execution and
does not add wallet, signing, private account or order methods.

---

### `GET /api/arbitrage`

Returns credential-free Binance/Bybit same- and cross-venue spot/perpetual research candidates using
observed best ask/bid prices. Query parameters include `costBps` (`0..1000`), `minSpreadBps`,
`minCapacityUsd`, `sort` (`expected-profit`, `net-edge` or `capacity`) and `limit` (`1..2000`).
Filtering happens before truncation; the response discloses totals and source/freshness state. This
endpoint is read-only and never places orders. Every row declares `identityScope`: `venue-native`
for strictly matched same-venue registry instruments or `cross-venue-reviewed` for the current
BTC/ETH canonical allowlist. Per-leg exchange/receive timestamps remain independent. See the
[screener guide](ARBITRAGE_SCREENER.md).

Every row includes `spotReceivedAt` and `futuresReceivedAt`; `spotExchangeTs` and
`futuresExchangeTs` are omitted when the venue payload has no timestamp. The required
`spotExchangeTimestampVerified` and
`futuresExchangeTimestampVerified` booleans distinguish a real venue timestamp from a local receive
time. When both venue timestamps are present, `clockCorrection.modelVersion: "venue-clock-v1"`
contains each venue's calibrated offset/age interval plus conservative minimum/maximum possible
cross-leg skew. `quoteAgeMs` and `legSkewMs` are recomputed from the upper uncertainty bounds and
the immutable receive timeline; local receipt is never copied into a venue timestamp. A degraded,
expired or unavailable calibration makes the row `unverified`. Missing venue time leaves the row
visible as a lower-ranked `unverified` discovery candidate, but alerts, history and paper/live gates
reject it. The envelope also exposes `identityCoverage`: a complete proof requires fresh Binance
spot/derivatives/funding and Bybit spot/linear registry sources. Missing, cached or quarantined
identity sources fail lifecycle absence semantics closed.

```bash
curl 'http://localhost:4180/api/arbitrage?costBps=30&minSpreadBps=0&limit=50'
```

---

### `GET /api/arbitrage/depth`

Walks bounded public order-book levels for both selected legs. Required query parameters are
`symbol`, `spotExchange`/`futuresExchange` (`binance` or `bybit`, equal or different) and
`notionalUsd` (`10..1000000`). `direction=entry` is the default. `direction=exit` additionally
requires the exact open `quantity` and walks spot bids plus perpetual asks. The response reports one
matched base quantity, venue-step rounding, residual delta, independent per-book receive/exchange
timing, required reconstructed sequence provenance, per-leg VWAP/slippage, levels used, verified instrument
status/settlement/minimum-quantity/minimum-notional constraints and fail-closed completeness. It
never submits an order. `timing.exchangeTimestampsVerified` is true only when both books contain
venue-provided timestamps; `timing.sequenceContinuityVerified` is true only when both books passed
their venue-specific snapshot/delta lifecycle. Each leg exposes `source` and `sequenceVerified`.
Freshness and `receiveSkewMs` still use local receipt time. REST-only fallback books remain
`source: rest-snapshot`, unverified and cannot make `complete` true.

The response binds the calculation to `identityScope`, `assetId`, optional `economicAssetId`,
`spotInstrumentId` and `futuresInstrumentId`. It also exposes `quantityStepSource`,
`precisionVerified` and `constraints.{metadataVerified,minimumsSatisfied,verified,failures}`. The
public handler rejects missing or incoherent instrument metadata before requesting either book, so
a `200` response uses `quantityStepSource: "instrument"` with `precisionVerified: true`; venue
minimums may still make `constraints.minimumsSatisfied` and `complete` false. Browser entry and exit
requests additionally bind the symbol, venues, market types, sides, stable IDs and identity to the
selected route or open paper position. Shared book work is reference-counted: one disconnected
subscriber does not cancel another, the last subscriber does cancel upstream work, and excess
unique-book concurrency returns `503` with `Retry-After: 1`.

### `GET /api/arbitrage/history`

Returns the bounded SQLite series for one `routeId` such as `BTCUSDT:binance:bybit`. Optional
`hours` is `1..168` (default `24`) and `limit` is `1..1000` (default `500`). Samples are recorded at
most once per minute while the shared market feed is active and retained for seven days.

### `GET /api/arbitrage/clock-health`

Returns credential-free Binance, Bybit, OKX, Deribit, Kraken, Coinbase, Gate, KuCoin and MEXC
server-clock calibration health from their official public time routes. Each probe preserves the
full RTT-derived offset interval instead of assuming symmetric network latency. A source reports
`calibrated`, `degraded`, `expired` or `unavailable`, sample/consistency counts, sample expiry,
observed RTT, offset bounds/midpoint, uncertainty, rejected-probe count and a bounded diagnostic
message. The envelope is `stale` whenever any required source is not both reachable and calibrated.
Kraken and Coinbase expose one-second-resolution server timestamps, so a tight uncertainty policy
may correctly leave them degraded. Hyperliquid and dYdX are not assigned a synthesized venue clock.

Probe work is coalesced and responses are size/time bounded. Slow or malformed probes cannot replace
a valid sample, and local receive time is never presented as venue time. This endpoint is public,
read-only and contains no account data. The same calibrated intervals now drive basis ranking,
WebSocket refreshes, server alert freshness, continuous cross-venue entry economics and Funding
Curve cross-venue comparability. Any clock uncertainty outside policy fails closed; the feature
remains research-only and does not imply execution permission.

### `GET /api/arbitrage/lifecycle`

Returns the bounded, read-only lifecycle state for basis, triangular, native-spread and pairwise
research candidates. Optional filters are `universeId`, `routeId`, `kind`, `status`, `actionable`,
`routeOffset=0..100000`, `routeLimit=1..500`, `afterSequence` and `eventLimit=0..500`. Routes move
through `first-seen`, `confirmed`, `decaying` and `expired` with hysteresis, distinct-observation
confirmation, evidence freshness and complete-universe absence rules. Events are newest first and
can be read incrementally by sequence.

The response always fixes `schemaVersion: 1`, `readOnly: true` and
`executionPermission: false`. Basis coverage is actionable only when all four market-data sources
and the five-source instrument-identity proof are complete, non-stale and non-truncated. The
runtime is bounded in memory and exposes sanitized accepted/rejected snapshot diagnostics; it has
no credential, notification or order dependency.

### `GET /api/arbitrage/triangular`

Simulates bounded three-leg spot cycles on Binance or Bybit from one directional venue-wide REST
top-book level per market. It applies fee and step rounding after each leg and reports conserved
quantity, top-book capacity, dust, timestamps and `top-book-only`/`rest-snapshot` risk flags. The
underlying pure engine accepts multi-level depth, but this public route does not fetch it and makes no
full-depth execution claim. It is research-only and has no order path.

Query bounds are exact: `venue=binance|bybit` (default `binance`), `startAsset` is an uppercase
`2..20`-character asset ID (default `USDT`), `startQuantity=10..10000000` (default `1000`),
`takerFeeBps=0..1000` (default `10`), `minimumNetReturnBps=-1000..10000` (default `0`) and
`limit=1..250` (default `50`).

### `POST /api/arbitrage/triangular/verify-depth`

Performs the second stage for one selected Binance/Bybit spot triangle. The strict body contains
`venue`, `startAsset`, `startQuantity`, `takerFeeBps`, `minimumNetReturnBps` and exactly three
distinct `symbols` copied from a discovery row. The server obtains all three books from the bounded
on-demand L2 hub, requires snapshot/delta sequence reconstruction and a current connection-
generation lease, then re-runs fee, lot/minimum, multi-level depth, freshness and leg-skew checks.

The response fixes `schemaVersion: 1`, `readOnly: true`, `researchOnly: true`,
`executable: false`, `execution: "none"` and `marketDataMode: "sequence-verified-depth"`. It exposes
each book's symbol, sequence, connection generation, exchange/receive time and retained depth plus
either depth-verified simulations or explicit rejection evidence. A sequence-verified route is a
stronger paper-research candidate, not private-order permission or an atomic-fill guarantee. A
generation change during evaluation returns `409` and publishes no stale proof. Unknown/incomplete
metadata returns `422`; overload or unavailable streams return `503`. The public SDK method is
`verifyTriangularDepth()` and contains no credential or order API.

### `GET /api/arbitrage/native-spreads`

Returns read-only Bybit venue-native combination instruments and order books for `FundingRateArb`,
`CarryTrade`, `FutureSpread` and `PerpBasis`. Optional filters include contract/base coin, minimum
quantity, sort and bounded candidate/result limits. `executionModel` describes venue-matched
multi-leg semantics; it is not a promise of a fill and the endpoint cannot submit orders. Each row
retains the complete venue instrument contract (`status`, price/quantity bounds, tick/lot steps,
launch/delivery times and both typed legs) together with order-book provenance (`sequence`, exchange,
matching-engine and receive timestamps). Strict clients reject non-trading or duplicate-leg rows,
crossed/off-grid/out-of-bounds prices, capacity that is not the step-floored two-sided minimum,
incoherent age/count fields and any drift from the fixed read-only risk-flag set.

Exact optional query bounds are `contractType=FundingRateArb|CarryTrade|FutureSpread|PerpBasis`, an
uppercase `baseCoin` of `1..20` characters, `minimumQuantity=0..1000000000` (default `0`),
`sort=capacity|tightness|freshness` (default `capacity`), `maxCandidates=1..50` (default `20`) and
`limit=1..50` (default `20`). The response-level coverage disclosure is `venue`, `marketDataMode`,
`executionModel`, `readOnly`, `updatedAt`, `totalInstruments`, `eligibleInstruments`,
`scannedInstruments`, `healthyBooks`, `totalOpportunities`, `truncated`, `candidateTruncated`,
`sourceErrors` and `opportunities`.

### `POST /api/arbitrage/pairwise/evaluate`

Evaluates exactly two caller-supplied normalized instruments/books and one bounded route. Supported
families are prefunded spot-spot, perpetual-perpetual, reverse cash-and-carry, spot-dated-future,
perpetual-future, calendar spread and dated-futures spread. Required capital, inventory, borrow,
funding, convergence, delivery and timestamp
assumptions are explicit and fail closed. Each instrument must also include a lowercase
`economicAssetId` in `namespace:value` form and caller-supplied `economicIdentity` review metadata:
`status: "reviewed"`, non-empty source/version, `asOf` and `validUntil`. The two IDs must match
exactly. By default the review is usable only until the earlier of `validUntil` and
`asOf + 30 days`; `maxEconomicIdentityAgeMs` can tighten or relax that boundary within the bounded
request schema. Beyond-tolerance future, stale, expired, malformed, unreviewed and mismatched identities fail
closed. Successful provenance repeats the effective boundary and labels its authority
`caller-supplied`; syntax/freshness validation is not a server endorsement of the caller's review.
The response always contains `engine: "pairwise-v1"` and `executable: false`; this is a
deterministic research evaluator, not a live discovery/order API.

### `POST /api/arbitrage/options-parity/evaluate`

Runs the pure European options-parity evaluator over caller-supplied metadata and complete visible
depth. A request contains one complete call/put series, an optional complete second strike for box
spreads, one underlying instrument/book, target base quantity, optional `evaluatedAt`, and explicit
timestamped rates, settlement policy, premium FX, per-option/underlying fees, verified short-option
capacity and optional verified underlying borrow. Expiry is taken only from exact instrument
metadata. Settlement must be European, automatic and held to expiry; settlement and valuation
assets must currently be equal because settlement FX is not modelled.

The boundary accepts at most 400 levels per book side, eight entries per assumption map and 4–64
pairing iterations. Output is bounded to 16 candidates and 64 rejections. Unknown fields are
rejected, so credentials and order-shaped payloads are not part of the contract. Responses are
`no-store` and always fix `engine: "options-parity-v1"`, `readOnly: true`, `researchOnly: true`,
`edgeKind: "research-simulation"`, `executable: false` and `assumptionContract.execution: "none"`.
Supported research shapes are put-call parity, conversion, reversal, long/short box and synthetic
forward. The endpoint never reads an account or sends an order. See the
[Deribit/options research guide](DERIBIT_OPTIONS_RESEARCH.md) for exact units and assumptions.

### `POST /api/arbitrage/n-leg/evaluate`

Discovers and simulates simple four-to-eight-leg spot conversion cycles over caller-supplied exact
market metadata and complete sequence-verified depth snapshots. Accounting nodes are exact
`(venue, assetId, unitId)` tuples; each side declares its fee schedule, tier and fee asset. The
engine propagates conserved quantities through visible depth, lot/minimum rules and fees, retaining
rounding dust instead of counting it as profit.

The request is bounded to 80 markets/books, 200 levels per book side, 100 cycles and 100,000 graph
and depth-walk steps. Unknown fields, credentials, duplicate books and unverified/incomplete depth
fail closed. The response discloses graph work/truncation, metadata rejections, one outcome per
cycle, residuals, fee aggregates and ordered provenance. It is `no-store` and permanently fixes
`engine: "n-leg-v1"`, `readOnly: true`, `researchOnly: true`, `executable: false` and
`execution: "none"`. The generated SDK `nLeg()` method revalidates the envelope, identities,
quantity chain, timestamps, arithmetic and provenance. This endpoint neither discovers live venue
books nor submits a multi-order route.

### `GET /api/arbitrage/funding-curve/universe`

Returns the server-owned selection universe for Funding Curve. It intersects the current fresh,
verified, trading perpetual registry with the actual credential-free adapters implemented by
`FundingCurveService`; the browser does not infer support by joining `/api/instruments` and
`/api/venues`. The bounded response includes supported venues, source degradation, exact
instrument rows and the version/as-of/valid-until of the central reviewed economic-identity
catalog. Unsupported Binance/Bybit selections therefore cannot be offered merely because their
general venue manifests advertise funding.

The endpoint is public and `Cache-Control: public, max-age=60`, but permanently
`readOnly: true`, `researchOnly: true`, `executable: false`. Its Zod and generated SDK contracts
reject credentials, unknown fields, invalid counts, unsupported venue rows and an identity catalog
that is not valid at the registry snapshot time.

### `POST /api/arbitrage/funding-curve`

Builds a bounded point-in-time funding curve for one to eight explicitly selected perpetual
instruments through the credential-free public venue adapters. The request supplies a minute
horizon, a history bound, freshness/future-skew bounds, optional
`maxCrossVenueClockSkewMs=0..60000` (default `2000`) and one to nine additive per-settlement stress
scenarios. The response exposes verified discrete settlements, current/next estimates, normalized
history, source provenance and per-scenario cumulative rates.

Each successful curve labels freshness as either a calibrated corrected-local venue-time interval
or an explicit non-comparable local-receipt fallback. The top-level `crossVenueClock` is eligible
only when every curve from two or more successful venues is calibrated and their worst possible
interval skew is within the requested limit. Otherwise it reports `clock-not-calibrated` or
`skew-exceeded`; strict SDK arithmetic validation and the browser both fail closed on that blocker.

The contract is permanently `readOnly: true`, `researchOnly: true`, `executable: false`. It accepts
no notional, balances, keys or order fields and does not turn cumulative rates into P&L without an
explicit price/capital path. Unverified intervals, stale/future observations and identity/unit
mismatches are returned as fail-closed per-instrument rejections. Current exact projection scope is
limited to public adapters that provide a verified discrete schedule; continuous or inferred
schedule boundaries remain rejected.

### `POST /api/arbitrage/route-families/evaluate`

Deterministically discovers compatible ordered routes and evaluates exact caller-scoped assumptions
for `cross-venue-spot-spot`, `reverse-cash-and-carry`, `perpetual-perpetual-funding`,
`spot-dated-future`, `calendar-spread` and `perpetual-future`. It accepts at most 120 normalized
instruments, 120 books, 500 assumption scopes and `maxRoutes=1..500` (default `200`) inside the
global 1 MiB JSON body limit. Candidate generation requires exact reviewed economic identity,
common quote/settlement assets and a supported base-equivalent quantity model.

Every route needs an exact `(family, longInstrumentId, shortInstrumentId)` scope. Capital,
inventory, borrow and funding are keyed by exact instrument ID; convergence, rebalance and delivery
are route-scoped. Missing or duplicate assumptions fail closed. No wildcard/default assumptions,
credentials or order fields are accepted. The response contains `engine: "route-families-v1"`,
`executionStatus: "research-only"`, `executable: false`, deterministic candidates, evaluated
opportunities, rejections, rejected instruments, total compatible count and honest truncation.

### `GET /api/arbitrage/route-families/live`

Returns the process-owned continuous public-feed discovery snapshot selected by the operator through
exactly one of `ARBITRAGE_CONTINUOUS_ROUTES_FILE` or `ARBITRAGE_CONTINUOUS_ROUTES_JSON`. The file
form requires an absolute path and the bounded loader rejects symlinks, non-regular/oversized files,
malformed UTF-8 and simultaneous inline configuration. Operator rows must exactly match the central
reviewed economic-identity catalog; configuration cannot create or override an asset equivalence.
The checked-in `config/continuous-routes.research.json` is an implemented reviewed allowlist, but it
is not loaded automatically: its presence and deterministic loader tests do not prove that a running
deployment activated subscriptions. The endpoint is public, read-only and `Cache-Control: no-store`;
there is deliberately no browser mutation endpoint. When the allowlist is absent it returns
`state: "disabled"`, empty active/source arrays and starts no upstream subscriptions.

The envelope fixes `schemaVersion: 1`, `engine: "continuous-route-runtime-v1"`,
`configurationSource: "operator-environment"`, `executionStatus: "research-only"`,
`readOnly: true` and `executable: false`. It reports configured/active IDs, failed-closed instruments,
source connection state, sequence-ready books, top books, funding observations and compatible route
families. Hyperliquid atomic block snapshots remain visible research evidence but never enter the
sequence-ready book set. Candidates do not include account capital, borrow, transfer, convergence or
order feasibility and are not execution signals.

Cross-venue `market-only` economics require calibrated corrected-local intervals for both public
book sources. Missing, degraded, expired, future, stale or worst-case-skewed clock evidence produces
a typed market-data blocker and no economics row. Same-venue evaluation may use an explicitly
labelled local-receipt fallback, which is never advertised as cross-venue comparable. The generated
SDK recomputes the interval arithmetic and rejects forged clock provenance.

Continuous discovery proves a hard input bound of 24 instruments, enumerates the complete compatible
ordered universe (at most `24 × 23 = 552` rows), evaluates every row, and only then publishes up to
500 results. Useful rows rank by fee-adjusted entry quote-value difference, then basis, visible
capacity, continuity quality and freshness. The summary distinguishes complete-universe evaluated
counts from bounded published counts, so publication truncation cannot silently hide a better route
or masquerade as complete evaluation.

The generated public SDK exposes this endpoint as `continuousRoutes()`. Its parser validates the
safety envelope, allowlist/active identity, candidate references, sequence provenance and bounded
arrays, then returns a top-book/source-health view rather than transferring full depth to callers.

### `GET /api/arbitrage/continuous-feed-health`

Returns the bounded no-store `continuous-feed-health-v1` snapshot from the shared continuous public-
feed hub. The envelope fixes `readOnly: true`, `dataScope: "public-market-data"`,
`credentialsRequired: false`, `secretsIncluded: false`, `executionStatus: "not-supported"` and
`executable: false`. It reports aggregate `idle`, `healthy`, `degraded` or `unhealthy` state and at
most 128 operator-configured sources with feed state, reconnect generation/count, latest receive,
available book/top-book/funding evidence and protocol continuity.

`bookContinuityReady` means only that a live book has a fresh sequence/checksum proof from the
current connection generation. It does not mean a compatible route exists and proves no fees,
balances, borrow, transfer, private account, simultaneous fill or execution permission. With no
activated allowlist the valid response is `idle` with no sources; that is observability, not evidence
that the checked-in allowlist is running.

The generated public SDK exposes `continuousFeedHealth()` and strictly recomputes aggregate counts,
health, freshness, generation and continuity relationships. The Live routes browser view polls both
continuous endpoints every five seconds only while visible and renders the diagnostics in EN/RU/KK.
Those engine/runtime/browser and deterministic contract layers remain separate from the dated
credential-free public canary, authenticated private evidence, soak and production readiness.

### `/api/trade/arbitrage-alerts`

Authenticated `paper-trade` operators can list (`GET`), create/update (`POST`) and delete
(`DELETE /:id`) persistent notification-only threshold rules. Rules include a net threshold,
minimum capacity, non-funding cost estimate, holding time, cooldown and enabled state. The `GET`
response keeps the existing `rules` array and adds a `deliveries` array with durable outbox status.
`GET /api/trade/arbitrage-alerts/deliveries?limit=100` returns the same bounded delivery view. Status
is one of `queued`, `sending`, `retrying`, `delivered`, `failed` or `cancelled`; failed attempts expose
their last error and next retry time. These endpoints never call an exchange order path.

### `/api/trade/arbitrage-alerts/research`

Authenticated `paper-trade` sessions can list, create/update and delete bounded notification-only
policies shared across basis, pairwise, triangular, native-spread, options-parity and N-leg research
families. Mutation requests pass the existing session CSRF and audit middleware. Policies require
minimum evidence quality, observation/economics/identity age, conservative net profit, net edge,
capacity, optional maximum risk capital and cooldown. `GET /deliveries?limit=1..500` exposes the
bounded durable outbox without notification payloads.

The runtime starts and stops with the server and fixes `researchOnly: true` and
`executionPermission: false`. It accepts snapshots only from server-owned adapters—there is no HTTP
ingest route. Current API mounting provides policy/outbox operation; each engine still needs a
point-in-time account-economics producer before that family can trigger a real notification. No
policy can place an exchange order.

---

### `GET /api/candles`

Fetches OHLCV candles for a single instrument.

**Query parameters**

| Param | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `symbol` | `string` | yes | — | min length 1; resolved case-insensitively against the catalog |
| `timeframe` | enum | no | `1m` | one of `1m,5m,15m,30m,1h,2h,4h,1d,1w,1M` |
| `limit` | integer | no | `320` | min `10`, max `1000` |
| `endTime` | integer | no | — | positive; ms epoch upper bound |
| `startTime` | integer | no | — | positive; ms epoch lower bound |
| `exchange` | enum | no | `binance` | `binance` or `bybit` |
| `marketType` | enum | no | `spot` | `spot`, `linear` or `inverse` |
| `priceType` | enum | no | `last` | `last`, `mark` or `index`; mark/index require a compatible derivatives market |

The `exchange` parameter selects which crypto exchange (Binance or Bybit) supplies the candles for crypto symbols.

**Response `200`**

| Field | Type | Notes |
| --- | --- | --- |
| `instrument` | `Instrument` | Resolved instrument |
| `candles` | `Candle[]` | Ordered oldest → newest |
| `provider` | `string` | `source` of the last candle, or the router's provider name as fallback |
| `hasMore` | `boolean` | `true` when `candles.length >= limit` (paging hint for older history) |

**Error responses**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": <flattened zod error> }` | Query failed validation |
| `404` | `{ "error": "Unknown symbol: <symbol>" }` | Symbol not in catalog |

```json
{
  "instrument": {
    "symbol": "BTCUSDT",
    "displayName": "Bitcoin / Tether",
    "assetClass": "crypto",
    "exchange": "Binance / Bybit",
    "currency": "USDT",
    "provider": "binance",
    "basePrice": 64000,
    "decimals": 2
  },
  "candles": [
    { "time": 1751932740000, "open": 64010.1, "high": 64080.0, "low": 63990.5, "close": 64050.2, "volume": 12.34, "final": true, "source": "binance" }
  ],
  "provider": "binance",
  "hasMore": true
}
```

```bash
curl "http://localhost:4180/api/candles?symbol=BTCUSDT&timeframe=1h&limit=500&exchange=bybit"
```

---

### `GET /api/sparklines`

Returns compact close-price series for one or more symbols, suitable for sparkline previews.

**Query parameters**

| Param | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `symbols` | `string` | yes | — | min length 1; comma-separated list, trimmed, blanks dropped, capped at 40 symbols |
| `timeframe` | enum | no | `1h` | one of `1m,5m,15m,30m,1h,2h,4h,1d,1w,1M` |
| `points` | integer | no | `32` | min `2`, max `120` |
| `exchange` | enum | no | `binance` | `binance` or `bybit` |

**Response `200`**

| Field | Type | Notes |
| --- | --- | --- |
| `timeframe` | `Timeframe` | Echoes the requested timeframe |
| `series` | `object` | Map of `symbol` → series entry or `null` |

Each series entry (when the symbol resolves and data is fetched) has:

| Field | Type | Notes |
| --- | --- | --- |
| `last` | `number \| null` | Last close, or `null` if no closes |
| `changePct` | `number` | Percent change from first to last close (`0` when it cannot be computed) |
| `points` | `number[]` | Close prices, oldest → newest |

Unknown symbols and fetch failures map to `null` for that symbol.

**Error responses**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": <flattened zod error> }` | Query failed validation |

```json
{
  "timeframe": "1h",
  "series": {
    "BTCUSDT": { "last": 64050.2, "changePct": 1.42, "points": [63120.0, 63500.5, 64050.2] },
    "ETHUSDT": { "last": 3520.7, "changePct": -0.31, "points": [3531.0, 3510.2, 3520.7] },
    "FOOUSDT": null
  }
}
```

```bash
curl "http://localhost:4180/api/sparklines?symbols=BTCUSDT,ETHUSDT&timeframe=1h&points=48"
```

---

## Market WebSocket: `/stream`

Streams an initial snapshot followed by live candle and status updates for a single instrument.
Connect with the same validated schema as `GET /api/candles`: `symbol`, `timeframe`, `limit`,
`endTime`, `startTime`, `exchange`, `marketType` and `priceType`. A venue may reject a derivative
combination it cannot stream (for example, a non-`last` WebSocket price type) instead of silently
substituting another series.

```
ws://localhost:4180/stream?symbol=BTCUSDT&timeframe=1m&exchange=binance
```

On connect the server:

1. Validates the query. On failure it sends an `error` message and closes.
2. Resolves the symbol. If unknown, it sends an `error` message and closes.
3. Sends a `snapshot` message with the initial candles.
4. Subscribes to the provider and streams `candle` and `status` messages until the socket closes.

All messages are JSON objects with a `type` discriminator and a `ts` (ms epoch) field.

### `snapshot`

| Field | Type |
| --- | --- |
| `type` | `"snapshot"` |
| `symbol` | `string` |
| `timeframe` | `Timeframe` |
| `candles` | `Candle[]` |
| `provider` | `string` |
| `ts` | `number` |

```json
{
  "type": "snapshot",
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "candles": [ { "time": 1751932740000, "open": 64010.1, "high": 64080.0, "low": 63990.5, "close": 64050.2, "volume": 12.34, "final": true, "source": "binance" } ],
  "provider": "binance",
  "ts": 1751932800000
}
```

### `candle`

Sent on each live candle update.

| Field | Type |
| --- | --- |
| `type` | `"candle"` |
| `symbol` | `string` |
| `timeframe` | `Timeframe` |
| `candle` | `Candle` |
| `provider` | `string` |
| `ts` | `number` |

```json
{
  "type": "candle",
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "candle": { "time": 1751932800000, "open": 64050.2, "high": 64075.0, "low": 64040.0, "close": 64068.9, "volume": 3.1, "final": false, "source": "binance" },
  "provider": "binance",
  "ts": 1751932803000
}
```

### `status`

Connection/health status. `status` is `fallback` when the underlying message contains `"Fallback"`, otherwise `connected`.

| Field | Type |
| --- | --- |
| `type` | `"status"` |
| `status` | `"connected" \| "fallback"` |
| `provider` | `string` |
| `message` | `string` |
| `ts` | `number` |

```json
{ "type": "status", "status": "connected", "provider": "binance", "message": "Live", "ts": 1751932803000 }
```

### `error`

| Field | Type |
| --- | --- |
| `type` | `"error"` |
| `message` | `string` |
| `ts` | `number` |

```json
{ "type": "error", "message": "Unknown symbol: FOOUSDT", "ts": 1751932800000 }
```

> Note: the `MarketStatus` type also defines `"error"` as a possible status value, but the `/stream` endpoint only emits `connected` or `fallback` in `status` messages.

---

## Aggregated quote WebSocket: `/quotes`

The watchlist uses one browser connection instead of opening one connection per symbol. Query parameters match `GET /api/sparklines`: `symbols` (comma-separated, deduplicated and capped at 40), `timeframe`, `points` and `exchange`.

```
ws://localhost:4180/quotes?symbols=BTCUSDT,ETHUSDT&timeframe=1m&points=32&exchange=binance
```

The first `quotes_snapshot` message contains a nullable series map. Each subsequent `quote` replaces one symbol's series. `SparklineSeries` contains `last`, `changePct` and bounded `points`. All variants are validated by `parseQuoteStreamMessage` from `@saltanatbotv2/contracts`; malformed input is rejected by the frontend and activates its batched REST polling fallback.

```json
{
  "type": "quotes_snapshot",
  "timeframe": "1m",
  "series": { "BTCUSDT": { "last": 64050.2, "changePct": 0.8, "points": [63540.1, 64050.2] } },
  "provider": "binance",
  "ts": 1751932800000
}
```

```json
{
  "type": "quote",
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "series": { "last": 64068.9, "changePct": 0.83, "points": [63540.1, 64068.9] },
  "provider": "binance",
  "ts": 1751932803000
}
```

---

## Public-market order-book WebSocket: `/orderbook`

Streams bounded real depth snapshots for a crypto symbol. Query parameters are `symbol` and `exchange=binance|bybit`.

```text
ws://localhost:4180/orderbook?symbol=BTCUSDT&exchange=binance
```

The backend shares one exchange upstream per `exchange:symbol` across all browser clients and publishes at most four snapshots per second. Binance uses its official top-20 partial depth feed. Bybit applies level-50 snapshot/delta messages to a local book and emits the nearest 20 rows per side. No synthetic depth is generated. At most 32 distinct upstream books may be active; a slow client is closed with code `1013` before its send buffer exceeds 256 KiB.

`orderbook_status` makes lifecycle state explicit:

```json
{
  "type": "orderbook_status",
  "symbol": "BTCUSDT",
  "exchange": "binance",
  "status": "connected",
  "message": "Binance top-20 depth connected",
  "ts": 1751932800000
}
```

An `orderbook` message is a complete browser-facing snapshot, not a delta. `bids` are best-first descending; `asks` are best-first ascending. Every tuple is `[price, size]` and both values are positive.

```json
{
  "type": "orderbook",
  "symbol": "BTCUSDT",
  "exchange": "binance",
  "bids": [[64008.83, 1.2058], [64008.82, 0.42]],
  "asks": [[64008.84, 2.06016], [64008.85, 0.19]],
  "sequence": 97300425191,
  "exchangeTs": 1751932800100,
  "ts": 1751932800120
}
```

All variants are bounded and validated by `parseOrderBookStreamMessage`. Status values are `connecting`, `connected`, `reconnecting`, `stale` and `error`. A generic typed `error` closes invalid or unsupported requests.

---

## Public-market trade-flow WebSocket: `/trade-flow`

Streams real public exchange prints for a crypto symbol. Query parameters are `symbol` and `exchange=binance|bybit`.

```text
ws://localhost:4180/trade-flow?symbol=BTCUSDT&exchange=binance
```

One exchange upstream is shared per `exchange:symbol`. Prints are microbatched for 100 ms and each browser message is capped at 500 trades; at most 32 distinct flows can be active. A client whose send buffer exceeds 512 KiB is closed with code `1013`. No API key, authenticated fill, synthetic print or reconstructed historical footprint enters this stream.

`trade_flow_status` exposes `connecting`, `connected`, `reconnecting`, `stale` and `error`. A `trade_flow` message carries the exchange-reported aggressor side:

```json
{
  "type": "trade_flow",
  "symbol": "BTCUSDT",
  "exchange": "binance",
  "trades": [
    { "id": "31245001", "price": 64008.84, "size": 0.125, "side": "buy", "exchangeTs": 1751932800100 }
  ],
  "ts": 1751932800120
}
```

For Binance, `m=true` means the buyer was the maker and is normalized to an aggressive `sell`. Bybit's `S` is already the taker side and maps directly. All variants are validated by `parseTradeFlowStreamMessage`; prices and sizes must be positive and a batch cannot exceed 500 trades. See the official [Binance aggregate trade stream](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#aggregate-trade-streams) and [Bybit public trade stream](https://bybit-exchange.github.io/docs/v5/websocket/public/trade).

---

## Trading REST endpoints

All trading endpoints are mounted under `/api/trade`. In database-auth mode, the authenticated
session is the owner boundary for bots, accounts, credentials, portfolio data, journals, logs,
audit rows, emergency state, notifications and private events. There is no `ownerUserId` request
parameter, and internal ownership fields are not serialized. A bot's `status` field in responses is
computed live from that owner's runtime (`running` when the engine reports it running, otherwise
`stopped`).

The current API is strictly Research / Paper. `RUNTIME_PROFILE=private-live`, credential writes,
signed REST, private exchange streams and all non-paper execution are unreachable;
`ENABLE_LIVE_SPOT=true` stops startup instead of enabling Bybit. The live lifecycle text below is a
dormant future/private-live engineering reference, not an operator activation path or a
mainnet-readiness claim.

All live `replace` and `turnover` commands are rejected until every child cancel/close/new action has
an independent durable lifecycle. Reservations also retain unaccounted partial fills from
cancelled/expired rows and conservatively retain legacy replaced entries. Futures preflight uses the
larger of exact-symbol venue gross position quantity and the durable fill-accounted shadow quantity.
When one venue order matches one local reservation, price and quantity use a conservative maximum;
identity conflicts fail closed. A terminal REST status without authenticated execution accounting
pauses the bot after polling/reconnect reconciliation.

### `/api/trade/paper-portfolios/*` (R4)

The accepted R4 canonical paper center uses PostgreSQL schema 12 for durable, authorization-fenced
commands and executor-owned SQLite schema 9 for portfolio/ledger evidence. This is the deployed
first-party contract for the exact release identified above.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/trade/paper-portfolios` | List the current owner's active and archived portfolios. |
| `GET` | `/api/trade/paper-portfolios/:portfolioId` | Return one `paper-portfolio-v1` projection. |
| `POST` | `/api/trade/paper-portfolios` | Create an owner-scoped USDT portfolio. |
| `PATCH` | `/api/trade/paper-portfolios/:portfolioId` | Rename at an exact revision/epoch. |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/default` | Select the active default. |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/archive` | Archive with exact name/constant confirmation after allocations are released. |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/reset` | Close the current epoch and create the next after exact confirmation. |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/robots/:botId/actions` | Confirm `start`, `pause`, `resume` or `stop` for one robot revision. |

Every request requires `X-SBV2-Expected-User` equal to the current session user captured by the
client before the operation. Mutations additionally require the normal session CSRF header and a
stable `Idempotency-Key` of at most 160 safe characters. Existing-resource bodies carry
`expectedPortfolioRevision` and `expectedLedgerEpoch`; robot actions also carry
`expectedBotRevision` and `confirm: true`. Portfolio reset/archive requires the exact current name
plus its typed confirmation constant. Responses are `Cache-Control: no-store`.

Money is canonical positive USDT text with exactly six fractional digits. A create body is
`{ "name": "Research", "initialCapital": "100000.000000", "currency": "USDT" }`.
Retry the same logical mutation with the same key and identical body. A conflicting reuse is
`409 idempotency_conflict`; `503 command_pending` means the durable command has not reached a
terminal state within the synchronous wait and must be retried with that same key. Stale owner,
portfolio, epoch or robot revision is a refresh-required conflict, never last-write-wins.

Snapshots carry fixed-decimal values and evidence-aware fields. Stale/unavailable marks remain
typed states. Borrowing is explicitly unavailable; no real exchange balance, debt or margin is
read. Portfolio detail embeds a bounded `paper-robot-journal-v1` per robot: an explicitly
current-epoch realized-cash curve (at most 256 points plus an evidence-backed current-equity point),
at most 50 newest fills and 100 newest event metadata rows. It does not claim historical
mark-to-market equity and omits event payload/idempotency fields. See
[Canonical paper portfolios](./PAPER_PORTFOLIOS.md) for lifecycle and recovery details.

### `/api/trade/paper-multi-leg/*`

This administrator-only singleton research surface runs deterministic failure/recovery scenarios for an
already validated two-leg route-family or four-to-eight-leg N-leg research plan. It is paper-only:
every successful envelope contains `safety.executionMode: "paper-only"`, `liveOrders: false`,
`privateRequests: false` and `credentialsAccepted: false`. The module imports no private exchange
adapter and is intentionally absent from the public arbitrage SDK.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/trade/paper-multi-leg/runs` | Validate and run one short-lived plan to a deterministic terminal state. Requires session CSRF and an `Idempotency-Key` header (`8..160` safe characters). |
| `GET` | `/api/trade/paper-multi-leg/runs?limit=50` | List up to 100 recent bounded summaries; never returns the idempotency key. |
| `GET` | `/api/trade/paper-multi-leg/runs/:runId` | Read the exact state and append-only event sequence for one run. |
| `GET` | `/api/trade/paper-multi-leg/recovery` | Read process restart-recovery state, recovered-run count and bounded timestamps. |

The `POST` body is exactly `{ "plan": PaperMultiLegPlan }`; unknown fields and credentials are
rejected and the parsed request is capped at 64 KiB. Plans use schema
`paper-multi-leg-plan-v1`, expire within five minutes, require source evidence no older than 60
seconds, and carry explicit original/compensation fill ratios rather than claiming exchange fills.
Execution stops on the first incomplete original leg and attempts reverse compensation in reverse
leg order. Terminal status is `completed`, `compensated`, `aborted-no-exposure`, or
`manual-review-required` with exact unresolved paper quantities.

All responses are `Cache-Control: no-store`. Reusing an idempotency key with the same plan returns
the existing run; reusing it with a different plan is `409`. Expired evidence is `410`, capacity is
`507`, malformed/unknown input is `400`, and an unknown run is `404`. The default journal is
`backend/data/arbitrage-paper-multi-leg.sqlite`; startup verifies hashes, contiguous sequence,
monotonic timestamps and every deterministic transition before completing unfinished runs.

### `BotConfig`

The core object accepted and returned by the bot endpoints.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | UUID; generated if omitted on create |
| `accountId` | `string` | Required for Binance/Bybit; must name the caller's enabled account. Paper receives a server-derived simulation account ID. |
| `name` | `string` | Falls back to `strategyName` then `"Bot"` |
| `strategyName` | `string` | Defaults to `"Strategy"` |
| `ir` | `StrategyIR` | Compiled strategy intermediate representation (required) |
| `symbol` | `string` | Upper-cased on save (required) |
| `timeframe` | `Timeframe` | Required |
| `exchange` | `"paper" \| "binance" \| "bybit"` | Defaults to `paper` |
| `market` | `"spot" \| "futures"` | Paper market type only in the current runtime; every Binance/Bybit bot is rejected by the Research/Paper boundary |
| `sizeMode` | `"quote" \| "base" \| "equity_pct" \| "risk_pct"` | Defaults to `quote` |
| `sizeValue` | `number` | Defaults to `100` |
| `leverage` | `number` | Floored at `1` |
| `maxPositionQuote` | `number` | Required and positive for live bots |
| `maxOrderQuote` | `number` | Required and positive for live bots; cannot exceed `maxPositionQuote` |
| `maxDailyLossQuote` | `number` | Required and positive for live bots |
| `maxOpenOrders` | `integer` | Required and positive for live bots |
| `notifyMarkers` | `boolean` | Defaults to `false` |
| `status` | `"stopped" \| "running" \| "error"` | Live-computed in responses |
| `createdAt` | `number` | ms epoch; preserved across updates |
| `updatedAt` | `number` | ms epoch |

---

### `GET /api/trade/bots`

Lists the current user's configured bots with live status. Another user's bots are never included.

**Response `200`**

```json
{ "bots": [ { "id": "…", "name": "Bot", "symbol": "BTCUSDT", "timeframe": "1m", "status": "stopped", "…": "…" } ] }
```

```bash
curl http://localhost:4180/api/trade/bots
```

---

### `POST /api/trade/bots`

Creates or updates one of the current user's bots. If `id` matches the caller's existing bot, its
`createdAt` is preserved. A foreign existing ID returns `404` rather than revealing ownership. A
live bot must include `accountId` for an enabled, exchange-matching account owned by the caller.

In database-auth mode, creating a paper bot is a create-only canonical portfolio command. The
server assigns a deterministic bot ID from the idempotency key, atomically reserves the requested
capital and stores immutable revision evidence. It requires `X-SBV2-Expected-User`, session CSRF,
`Idempotency-Key`, `paperPortfolioId`, canonical `paperAllocation`,
`expectedPortfolioRevision` and `expectedLedgerEpoch`. A bound paper robot cannot be edited through
this endpoint; create a new robot workflow instead. Legacy single-operator behavior remains a
compatibility path.

**Required body fields:** `symbol`, `timeframe`, `ir`. If any is missing the endpoint returns `400`.

| Body field | Type | Default |
| --- | --- | --- |
| `symbol` | `string` (required) | — |
| `timeframe` | `Timeframe` (required) | — |
| `ir` | `StrategyIR` (required) | — |
| `id` | `string` | new UUID |
| `name` | `string` | `strategyName` or `"Bot"` |
| `strategyName` | `string` | `"Strategy"` |
| `exchange` | `"paper" \| "binance" \| "bybit"` | `paper` |
| `accountId` | `string` | Required for Binance/Bybit; ignored/replaced for paper |
| `market` | `"spot" \| "futures"` | `futures`; only paper creation is accepted, and every Binance/Bybit execution request is rejected |
| `sizeMode` | `"quote" \| "base" \| "equity_pct" \| "risk_pct"` | `quote` |
| `sizeValue` | `number` | `100` |
| `leverage` | `number` | `1` (floored at 1) |
| `notifyMarkers` | `boolean` | `false` |
| `maxPositionQuote` | positive `number` | Required for live; omitted for paper |
| `maxOrderQuote` | positive `number` | Required for live; must not exceed position cap |
| `maxDailyLossQuote` | positive `number` | Required for live |
| `maxOpenOrders` | positive `integer` | Required for live |
| `paperPortfolioId` | `string` | Required for a new database-auth paper bot |
| `paperAllocation` | six-decimal positive USDT string | Required for a new database-auth paper bot |
| `expectedPortfolioRevision` | positive integer | Required for a new database-auth paper bot |
| `expectedLedgerEpoch` | positive integer | Required for a new database-auth paper bot |

**Response `200`**

```json
{ "bot": { "id": "…", "symbol": "BTCUSDT", "timeframe": "1m", "status": "stopped", "…": "…" } }
```

**Error `400`**

```json
{ "error": "symbol, timeframe and ir are required" }
```

```bash
curl -X POST http://localhost:4180/api/trade/bots \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","timeframe":"1m","ir":{},"exchange":"paper","sizeMode":"quote","sizeValue":100}'
```

The unauthenticated curl example above describes only the legacy local shape; it is not a valid
database-auth paper create. First-party clients must use the authenticated canonical fields and
headers described above.

---

### `DELETE /api/trade/bots/:id`

Stops the bot (if running) and deletes it.

In database-auth mode a canonical paper robot returns `409 PAPER_DELETE_COMMAND_REQUIRED` until a
flat release/delete workflow records immutable evidence. Active allocations are never deleted
through this compatibility route.

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -X DELETE http://localhost:4180/api/trade/bots/<bot-id>
```

---

### `POST /api/trade/bots/:id/start`

Starts the bot's strategy engine.

Only one live bot may own an exchange+symbol at a time, including across spot/futures. A request body
`override: true` cannot bypass this live collision; stop and reconcile the existing bot first.

**Response `200`**

```json
{ "ok": true, "bot": { "id": "…", "status": "running", "…": "…" } }
```

**Error responses**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{ "error": "Bot not found" }` | No bot with that id |
| `400` | `{ "error": "<reason>" }` | Validation/start failed, including disabled Binance live spot, an unarmed Bybit spot bot or another fail-closed readiness error |
| `426` | `{ "code": "SECURE_TRADING_ORIGIN_REQUIRED", "error": "…" }` | Live start was attempted over untrusted public HTTP |

```bash
curl -X POST http://localhost:4180/api/trade/bots/<bot-id>/start
```

---

### `POST /api/trade/bots/:id/stop`

Stops the bot's engine. Always returns success.

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -X POST http://localhost:4180/api/trade/bots/<bot-id>/stop
```

---

### `GET /api/trade/kill` and `POST /api/trade/kill`

The authenticated `live-trade` emergency endpoint persists an owner-scoped operation, blocks that
owner's new live orders, stops that owner's bot runtimes, cancels that owner's account orders and
reconciles their exchange state. It cannot enumerate or stop another tenant. `GET`
returns the current `idle`, `stopping`, `terminal` or `partial_failure` status.

```json
{
  "operationId": "b2188e5e-18b5-4e64-9c08-2376454bfaee",
  "flatten": false
}
```

`flatten` defaults to `false`, so positions stay open. Closing all futures positions additionally
requires `"confirmFlatten": "FLATTEN_ALL_LIVE_POSITIONS"`; closes are reduce-only market orders and
spot holdings are never sold. The response contains `botsStopped`, top-level `errors`, and one
account result per exchange/market with the initial and remaining orders/positions. A confirmed
result is `200` with `phase="terminal"` and `ok=true`; unresolved work is `207` with
`phase="partial_failure"` and `ok=false`. Reusing an `operationId` returns its stored result without
submitting the exchange actions twice. A different ID while an operation is running returns `409`,
and missing flatten confirmation returns `428`.

---

### `POST /api/trade/bots/:id/command`

Runs a manual command string against the bot's exchange adapter (e.g. an order instruction). Every
risk-increasing live command must contain an explicit positive base `qty`. Quote quantity,
`openpro`, `depopro` and other balance/percentage sizing remain available to paper/general command
resolution but cannot create live exposure. Risk-reducing close and cancel commands are exempt. Live
`replace` and `turnover` are rejected on every market until their child actions have independent
durable lifecycles.

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `command` | `string` | yes |

**Response `200`** — the engine's `ExecResult`:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | `boolean` | |
| `message` | `string` | |
| `fills` | `FillRecord[]` | |
| `order` | `OrderRecord` *(optional)* | |
| `orders` | `PendingOrder[]` *(optional)* | |
| `position` | `PositionState \| null` *(optional)* | |
| `account` | `AccountState` *(optional)* | |
| `data` | `unknown` *(optional)* | Free-form payload for `get`-style commands |

**Error `400`**

```json
{ "error": "command is required" }
```

```bash
curl -X POST http://localhost:4180/api/trade/bots/<bot-id>/command \
  -H "Content-Type: application/json" \
  -d '{"command":"action=openposition;mktype=futures;symbol=BTCUSDT;side=buy;type=market;qty=0.001"}'
```

---

### `GET /api/trade/bots/:id/fills`

Returns up to the 200 most recent fills for the bot.

**Response `200`** — `{ "fills": FillRecord[] }`

`FillRecord`:

| Field | Type |
| --- | --- |
| `id` | `string` |
| `botId` | `string` |
| `symbol` | `string` |
| `side` | `"buy" \| "sell"` |
| `qty` | `number` |
| `price` | `number` |
| `fee` | `number` |
| `realizedPnl` | `number` |
| `kind` | `"open" \| "close"` |
| `reason` | `string` |
| `ts` | `number` |

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/fills
```

---

### `GET /api/trade/bots/:id/logs`

Returns up to the 200 most recent log entries for the bot.

**Response `200`** — `{ "logs": [ … ] }`

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/logs
```

---

### `GET /api/trade/bots/:id/live`

Returns the bot's live account/position/price state from the engine, or `{ "price": 0 }` when no live state is available.

**Response `200`**

```json
{ "price": 64050.2 }
```

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/live
```

---

### `GET /api/trade/bots/:id/orders`

Returns the resting/open orders known to the engine for the bot.

**Response `200`** — `{ "orders": PendingOrder[] }`

`PendingOrder`:

| Field | Type |
| --- | --- |
| `id` | `string` |
| `clientId` | `string` *(optional)* |
| `symbol` | `string` |
| `side` | `"buy" \| "sell"` |
| `type` | `"market" \| "limit" \| "stop_market" \| "stop_limit" \| "tp_market" \| "tp_limit"` |
| `qty` | `number` |
| `price` | `number` *(optional)* |
| `trgPrice` | `number` *(optional)* |
| `reduceOnly` | `boolean` |
| `tif` | `"GTC" \| "IOC" \| "FOK"` |
| `createdAt` | `number` |

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/orders
```

---

### `GET /api/network-identity/registry`

Returns the bounded, server-owned `network-identity-registry-v1` snapshot. The
current reviewed allowlist contains exact Binance/Bybit identities for BTC and
ETH native mainnets plus official USDT/USDC Ethereum contracts. The envelope is
always `readOnly: true` and `executable: false`; `evaluatedAt` and `validity`
(`current`/`stale`, reason, aggregate `asOf`, `validUntil`, `remainingMs`) expose
whether every evidence row is valid at the server clock. No query parameters,
credentials, addresses or transfer operations are accepted.

The static snapshot deliberately has no `transferCapabilities`: dynamic deposit/withdraw status,
fees, limits and confirmation requirements must come from a future fresh capability source, and no
arrival observer exists. An identity row therefore does not prove a usable transfer route.

```bash
curl http://localhost:4180/api/network-identity/registry
```

### `POST /api/network-identity/preflight`

Runs a strict, read-only `network-transfer-compatibility-v1` evaluation against
one captured server snapshot. The body contains `schemaVersion`,
`registryVersion`, `routeId`, `assetId`, decimal `amount`, exact source/destination
venue network codes, and evidence/clock/arrival limits. It intentionally does
**not** accept `evaluatedAt`, registry data or mappings; evaluation time is pinned
to the server clock, so a caller cannot backdate a request into an expired review
window. Invalid bodies return `400`; valid but incompatible routes return `200`
with fail-closed reasons. Every result has `executable: false` and
`arrivalProofRequired: true`.

`maximumArrivalMs` is a caller requirement, not observed transfer telemetry. This endpoint neither
submits a withdrawal nor watches a chain/deposit account; until dynamic transfer capabilities and an
arrival observer are implemented, preflight proves only compatibility with the static reviewed
identity snapshot.

```bash
curl -X POST http://localhost:4180/api/network-identity/preflight \
  -H 'Content-Type: application/json' \
  -d '{"schemaVersion":1,"registryVersion":"network-identity-2026-07-14.v1","routeId":"route:binance-bybit-btc","assetId":"asset:bitcoin","amount":"1","source":{"venue":"binance","withdrawalNetworkCode":"BTC"},"destination":{"venue":"bybit","depositNetworkCode":"BTC"},"maximumEvidenceAgeMs":2592000000,"maximumFutureClockSkewMs":1000,"maximumArrivalMs":86400000}'
```

Both routes are available through the strict public arbitrage SDK as
`networkIdentityRegistry()` and `networkTransferPreflight()`.

---

### `/api/trade/accounts` and per-account credentials

Trading accounts are private resources owned by the authenticated user. `GET` requires any effective
trading role; create/update/delete and credential changes require `live-trade`, CSRF and a secure
localhost/HTTPS origin. Account responses contain metadata, bound bot IDs and credential status but
never API key material or `ownerUserId`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/trade/accounts` | List only the caller's accounts. |
| `GET` | `/api/trade/accounts/:id` | Read one owned account; foreign/unknown is `404`. |
| `POST` | `/api/trade/accounts` | Create `{ label, exchange, ownership?, enabled? }`. |
| `PATCH` | `/api/trade/accounts/:id` | Change `label`, `ownership` or `enabled`. |
| `DELETE` | `/api/trade/accounts/:id` | Delete unbound metadata after credentials are removed. |
| `PUT` | `/api/trade/accounts/:id/credentials` | Store or rotate `{ apiKey, apiSecret }` on this account. |
| `DELETE` | `/api/trade/accounts/:id/credentials` | Remove credentials after every bot is unbound/deleted. |

`exchange` is `binance` or `bybit`; `ownership` is `own` or `managed`. A representative response is:

```json
{
  "account": {
    "id": "f1ed5bf5-6dc8-4e0a-a51d-5795af08c4a8",
    "label": "My Bybit",
    "exchange": "bybit",
    "ownership": "own",
    "enabled": true,
    "credential": { "mode": "account_isolated", "status": "configured", "isolated": true },
    "status": "ready",
    "botIds": []
  }
}
```

Credential rotation is rejected while any bound robot is running. Disabling/deleting a bound
account and removing credentials from a bound account return `409`. Ciphertext is AES-256-GCM
authenticated against owner, account and exchange, so moving it to another tenant/account fails
decryption.

`GET /api/trade/keys` remains a tenant-scoped compatibility status and returns only exchange
booleans. `POST /api/trade/keys` is retired and returns `410` with
`code: "ACCOUNT_CREDENTIAL_ENDPOINT_REQUIRED"`.

---

### `GET /api/trade/account-telemetry`

Returns protected, read-only Binance/Bybit economics evidence for the current user's configured accounts:
signed Spot/perpetual fee rates, Binance USDⓈ-M tier/BNB-burn state, current borrow capacity/rate,
deposit/withdraw network state and public stablecoin-FX provenance. The route requires an
authenticated `live-trade` session, uses only accounts owned by that session, never accepts or
returns credentials, and sends
`Cache-Control: private, no-store`.

Bounded query parameters:

| Field | Default | Limit |
| --- | --- | --- |
| `venues` | `binance,bybit` | Binance and/or Bybit |
| `symbols` | `BTCUSDT,ETHUSDT` | 1–2 symbols |
| `assets` | `BTC,USDT,USDC` | 1–4 assets |
| `stableAssets` | `USDC` | 1–3 non-USDT assets |

The `readiness` object is deliberately fail-closed: future fee assets and non-recallable borrow are
not proven by these venue endpoints, so `feeAssets`, `borrowRecall` and `executable` remain false.
Evidence expires after 30 seconds and is never served from a stale-success fallback. See
[Account economics telemetry](ACCOUNT_TELEMETRY.md) for field semantics, limits and official venue
references.

```bash
curl 'http://localhost:4180/api/trade/account-telemetry?symbols=BTCUSDT,ETHUSDT&assets=BTC,USDT,USDC&stableAssets=USDC'
```

---

### `GET /api/trade/notify`

Returns the current user's notification configuration. Tokens are never returned in plaintext;
only a `hasToken` boolean is exposed, and another tenant's targets/tokens are never read.

**Response `200`**

```json
{
  "telegram": { "enabled": false, "chatId": "", "hasToken": false },
  "vk": { "enabled": false, "peerId": "", "hasToken": false }
}
```

```bash
curl http://localhost:4180/api/trade/notify
```

---

### `POST /api/trade/notify`

Updates only the current user's notification configuration. Any omitted field keeps its current
value; a blank `token` also keeps that user's existing token.

**Body** (`Partial<NotifyConfig>`)

| Field | Type |
| --- | --- |
| `telegram.enabled` | `boolean` |
| `telegram.token` | `string` |
| `telegram.chatId` | `string` |
| `vk.enabled` | `boolean` |
| `vk.token` | `string` |
| `vk.peerId` | `string` |

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -X POST http://localhost:4180/api/trade/notify \
  -H "Content-Type: application/json" \
  -d '{"telegram":{"enabled":true,"chatId":"123456","token":"<token>"}}'
```

---

### `POST /api/trade/notify/test`

Sends a test notification through the configured channels and returns the result.

**Response `200`** — result of the notification attempt.

```bash
curl -X POST http://localhost:4180/api/trade/notify/test
```

---

## Trading WebSocket: `/trade-stream`

An owner-partitioned WebSocket that pushes only the authenticated user's `TradeEvent` values. It
takes no query parameters and rejects token-in-URL auth. Browser clients first request a
short-lived, single-use ticket bound to the active database session and trading permission:

```
POST /api/trade/ws-ticket
X-CSRF-Token: <csrfToken>
Cookie: sbv2_session=...

→ { "ticket": "...", "expiresAt": 1751932800000 }
```

Then connect with a websocket subprotocol:

```
ws://localhost:4180/trade-stream
Sec-WebSocket-Protocol: sbv2.ticket.<base64url(ticket)>
```

Each message is a JSON-serialized `TradeEvent` produced by that owner's engine runtimes (fills,
order updates, log lines and status changes). Internal event and nested bot `ownerUserId` fields are
removed before serialization. An event without a resolved owner is dropped; a permission change or
account disable closes that owner's sockets. Token subprotocol and bearer fallbacks are disabled in
database mode.

---

## See also

- [Project README](../README.md)
- [Architecture overview](./ARCHITECTURE.md)
- [Trading engine guide](./TRADING.md)
- [Strategy reference](./STRATEGIES.md)
- [Configuration](./CONFIGURATION.md)
