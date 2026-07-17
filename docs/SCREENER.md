# On-demand technical screener

Russian guide: [ru/SCREENER.md](./ru/SCREENER.md).
Kazakh guide: [kk/SCREENER.md](./kk/SCREENER.md).

This document describes the R5.2.1 technical screener introduced by PostgreSQL
schema 14. It is a research-only, on-demand indicator scan over the Binance
spot USDT universe. Every payload carries `researchOnly: true` and
`executionPermission: false`. It cannot place an order, borrow assets, change
margin, sign an exchange request or grant a trading role.

## R5.2.1 scope

R5.2.1 supports one screen shape:

- kind `technical` over public Binance spot markets, last price only;
- `5m`, `15m`, `1h`, `4h` and `1d` timeframes;
- a universe of 10 to 200 catalog USDT symbols, sorted ascending;
- 1 to 12 filters of seven kinds evaluated on closed candles only;
- deterministic sorting, at most 100 result rows;
- owner-scoped server presets with revisions and archive;
- bounded run history through the existing compute-job retention;
- click-to-chart carrying symbol, timeframe and indicator context.

Not in scope for R5.2.1: scheduled or continuously re-run screens, a
Bybit-primary universe and non-USDT quote assets. Promotion of a screen into a
server alert was also excluded here; it is delivered separately by R5.3a as
the alert rule kind `screener` — see
[Screener alerts (R5.3a)](./ALERTS.md). The
definition contract accepts only `exchange: "binance"`, `marketType: "spot"`
and `priceType: "last"` in this increment; the schema leaves room for later
exchanges without a version break.

The screener never reads an exchange credential. It uses one public 24-hour
ticker batch and strict public closed-candle reads, and rejects synthetic,
cached, private or unsigned substitute evidence.

## HTTP-only deployment boundary

The current pre-HTTPS release deliberately does not configure TLS. Login
passwords and session cookies must therefore travel only over a trusted local
network, a private VPN or an SSH tunnel. Do not expose this build as a general
Internet login service, and do not add exchange private keys to it. HTTPS is a
separate release gate.

## Data flow

```text
authenticated browser
  -> POST /api/jobs (kind screener, idempotent clientRequestId)
  -> durable owner-scoped compute job
  -> research worker lease
  -> one public 24h ticker batch + strict closed candles per symbol
  -> pure deterministic filter evaluation
  -> bounded serialized screener-run-result-v1
  -> GET /api/jobs/:id polling
  -> results table / chart handoff
```

A run is an ordinary compute job. The browser enqueues it with an idempotent
`clientRequestId` (8–128 characters), polls the job every 2 seconds with a
120-second client deadline, and requests a best-effort cancel when the owner
abandons the run. Identical pending payloads are deduplicated by the jobs
subsystem; one owner has at most five active and one running job.

## Definition reference

A `screener-definition-v1` document is parsed with exact keys; unknown fields
are rejected. It contains:

| Field | Meaning |
| --- | --- |
| `name` | 1–120 characters |
| `exchange`, `marketType`, `priceType` | `binance`, `spot`, `last` only |
| `timeframe` | `5m`, `15m`, `1h`, `4h` or `1d` |
| `universeLimit` | integer 10–200 |
| `sort` | key `quoteVolume24h`, `change24hPercent`, `lastClose`, `symbol`, `rsi` or `atrPercent`; direction `asc` or `desc` |
| `filters` | 1–12 filter objects |
| `researchOnly`, `executionPermission` | must be `true` / `false` |

Numeric thresholds are decimal strings with the same pattern the alert
contracts use; they are never silently rounded.

## Filter reference

| Kind | Parameters | Matches when |
| --- | --- | --- |
| `price` | `min?`, `max?` (at least one) | last close is inside the bounds |
| `quote-volume-24h` | `min` (USDT) | 24h quote volume ≥ `min` |
| `change-24h-percent` | `min?`, `max?` (−100…10000, at least one) | 24h change is inside the bounds |
| `rsi` | `period` 2–200, `condition` `above`/`below`, `value` 0–100 | RSI on closes satisfies the condition |
| `ma-cross` | `fastType`/`slowType` `ema`/`sma`, `fastPeriod` < `slowPeriod`, `state` | `fast-above`, `fast-below`, `crossed-up` or `crossed-down` |
| `macd` | `fast` < `slow`, `signal` | `histogram-above-zero`, `histogram-below-zero`, `crossed-up`, `crossed-down` |
| `atr-percent` | `period` 2–200, `condition`, `value` 0–1000 | ATR as a percent of last close satisfies the condition |

The last closed bar is the evaluation bar. Cross states compare exactly the
last two closed bars: `crossed-up` means the fast value was not above on the
previous closed bar and is above on the evaluation bar. Indicator math comes
from `@saltanatbotv2/strategy-core` (RSI, SMA, EMA, MACD, ATR) — the same
package family the chart uses, which is what makes chart parity provable.

## Closed candles and fail-closed unavailability

The screener evaluates only final candles. The forming tip is dropped, and the
remaining window must pass the same closed-candle validation the alert
evaluator uses: missing, forming, future, stale, discontinuous, oversized or
malformed windows fail closed.

A symbol whose evidence is incomplete becomes **unavailable, never zero**. An
indicator inside its warm-up window, a missing ticker row or an exhausted run
budget removes the symbol from evaluation with an explicit reason instead of
contributing a fabricated `0` to a filter. The result reports
`universe.requested/evaluated/matched/unavailable` counters and an
`unavailableReasons` map with exact reason strings, including:

| Reason | Meaning |
| --- | --- |
| `ticker-unavailable` | no valid public 24h ticker row for the symbol |
| `missing-candles` | the provider returned no closed candles |
| `indicator-warm-up` | not enough closed bars for a requested indicator |
| `run-budget-exhausted` | the 90-second run budget ended before this symbol |
| `upstream-unavailable` | a bounded public read failed |
| `row-out-of-range` | a matched value cannot be represented in the bounded contract |

If the single 24-hour ticker batch itself is unparseable, the whole run fails
closed rather than continuing on partial pricing evidence.

## Determinism and result shape

The result is a `screener-run-result-v1` document with the definition hash,
generation time, closed-bar time range and at most 100 rows. Rows are sorted
by the definition's sort key with undefined values last and an ascending
symbol tiebreak, so an identical universe with identical candles produces an
identical result. If more than 100 symbols match, the result sets
`rowsTruncated: true` instead of silently dropping evidence. Metric decimals
are formatted with `toFixed(8)` and trimmed trailing zeros.

## Ownership and authorization

Every preset read and write derives the owner from the authenticated database
session and additionally requires the `X-SBV2-Expected-User` header with that
same user ID. Mutations require the normal CSRF header. Repository
transactions re-check active user status, `must_change_password = false`, the
current authorization revision and actor-equals-owner, exactly like the alert
repository. Administrators do not receive a cross-owner preset read or
mutation path. Public projections never expose `owner_user_id`,
`authorization_revision` or `definition_hash`.

Preset creation is idempotent by `clientId`: repeating the same definition
returns the existing preset, while a different definition under the same
`clientId` is a `409` conflict. Updates and archive require the current
`expectedRevision` and advance the revision by one. A run that references a
`presetId` resolves it in the worker at execution time with the job owner;
a missing or archived preset fails the job with a typed message rather than
running a stale definition.

## API

All paths require database authentication, rate limiting and `Cache-Control:
no-store`. Screener runs deliberately have no dedicated run endpoint: they go
through the existing compute-job surface.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/screener/presets?limit=100` | List presets, non-archived first |
| `POST` | `/api/screener/presets` | Idempotently create a preset by `clientId` |
| `PUT` | `/api/screener/presets/:id` | Replace the definition using `expectedRevision` |
| `POST` | `/api/screener/presets/:id/archive` | Archive using `expectedRevision` |
| `POST` | `/api/jobs` | Enqueue a run: `{kind: "screener", clientRequestId, request}` |
| `GET` | `/api/jobs/:id` | Poll the run; the result is the `screener-run-result-v1` |
| `POST` | `/api/jobs/:id/cancel` | Best-effort run cancellation |

Screener request bodies are limited to 32,768 bytes, a stored definition to
16,384 bytes and a preset list page to 100 entries. Unknown fields and unknown
query parameters are rejected.

## Quotas and beta limits

| Boundary | Limit |
| --- | ---: |
| Active presets per owner | 40 |
| Globally active presets | 400 |
| Universe symbols per run | 200 |
| Filters per definition | 12 |
| Result rows per run | 100 |
| Concurrent candle reads per run | 6 |
| Run evidence budget | 90 s |
| Run wall-time (worker) | 120 s |
| Closed candles per symbol | warm-up + 3, clamped 50–600 |

Entering the globally active preset state is serialized by a dedicated
PostgreSQL advisory lock namespace distinct from the alert namespaces. These
are conservative beta limits; R11 must run the documented 100-user workload
before they are raised.

## Run history and retention

Run history is not a separate subsystem: it is the bounded compute-job
retention that already governs backtests. Full job artifacts are kept for 30
days, at most 200 full artifacts and 256 MiB per owner. Pruned runs keep an
auditable tombstone that answers HTTP `410` instead of pretending the result
never existed; tombstones are kept for 90 days, at most 1,000 per owner.

## Chart parity

Clicking a result row opens the chart with the same symbol, the same timeframe
and the indicator configurations derived from the definition's filters
(RSI, EMA/SMA overlays, MACD, ATR). Server and chart indicator values are held
to a golden parity fixture: on a fixed 300-candle series, the
`@saltanatbotv2/strategy-core` RSI/EMA/SMA/MACD/ATR outputs the screener uses
must equal the browser chart's indicator math wherever both are defined. A
screener match therefore corresponds to what the chart shows on closed bars;
the still-forming chart bar is not part of the screened evidence.

## PostgreSQL schema 14

Schema 14 adds one table, `screener_presets`, with owner-scoped uniqueness for
preset IDs and client IDs, a size-checked `jsonb` definition, a definition
hash, positive revisions and an archive timestamp. The migration is additive;
schema 13 files are untouched. Upgrade and rollback follow the same
backup-first, restore-into-replacement discipline documented for schema 13 —
never delete schema 14 rows or decrement `schema_migrations` to roll back.

See [MIGRATIONS.md](./MIGRATIONS.md), [BACKUP_RESTORE.md](./BACKUP_RESTORE.md)
and [RELEASING.md](./RELEASING.md).

## Verification

The release gate includes:

- strict contract generation checks for the screener schemas;
- exact-key API schema bounds and unknown-field rejection tests;
- per-filter engine tests including warm-up unavailability, two-closed-bar
  cross semantics, deterministic sort/truncation and the golden
  strategy-core/chart parity fixture;
- route tests for owner guard, error mapping, `no-store`, projection leaks and
  the 413 body limit;
- real unprivileged PostgreSQL schema-14 migration, two-owner isolation,
  quota, idempotency, revision-conflict and archive tests;
- worker executor tests for result shape, budget exhaustion and preset
  resolution failure;
- browser client, workspace and EN/RU/KK localization tests plus the
  end-to-end screen-to-chart journey with accessibility checks.

R5.2.1 is accepted and deployed: production runs PostgreSQL schema 14 from
protected slot `r5b-schema14-20be5b1` (commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831`, exact-SHA CI run `29584556266`,
6/6 jobs). The acceptance and cutover record is
[R5.2.1 evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md).

Screen-to-alert promotion is now delivered by R5.3a: the "Create alert from
this screen" action turns the current valid definition into a durable server
rule of kind `screener` that re-runs the screen at the timeframe cadence and
raises an on-change alert event when the matched symbol set changes, with
in-app delivery only until R5.3b. Semantics, unknown carry-over, the
availability floor, cooldown and the 5-per-owner/40-global quotas are
documented in [Screener alerts (R5.3a)](./ALERTS.md). R5.3a is in progress
and not yet accepted
([implementation status](./IMPLEMENTATION_STATUS.md)); scheduled screens and
a Bybit-primary universe remain future work.
