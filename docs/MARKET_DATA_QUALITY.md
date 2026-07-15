# Arbitrage market-data quality

Status: canonical quality policy, reviewed 2026-07-14.

An arbitrage calculation combines independent feeds. A valid number is not enough: every leg must
be recent, ordered, attributable and comparable. This document defines the evidence required before
an opportunity can move from discovery to alert, paper or private execution.

## Current baseline

The shipped Binance/Bybit screener:

- bootstraps common routes through bounded public REST calls;
- uses one shared direct public WebSocket per venue/market while clients or persistent alerts need it;
- subscribes only to discovered common symbols;
- accepts a source as healthy only after a valid market-data event;
- uses a silence watchdog and jittered exponential reconnect;
- refreshes REST discovery every 30 seconds;
- coalesces browser snapshots and disconnects slow consumers;
- records per-leg exchange and local receive timestamps, calculates age and cross-leg skew, and
  labels rows outside the current 10-second age / 3-second skew gates as degraded discovery
  candidates while alerts, history and paper/live actions suppress them;
- publishes a route only after both legs have exact normalized instrument identity from the current
  verified registry snapshot; verified lot/minimum metadata is mandatory for depth/paper analysis,
  while an unverified funding schedule never earns credit and an adverse current rate incurs at
  least one debit settlement for every non-zero holding horizon;
- requires a reviewed cross-venue economic-asset identity; the initial allowlist contains BTC and
  ETH only, and every other same-ticker candidate fails closed until its mapping is reviewed;
- permits broader same-venue routes only when both legs share one venue-native registry identity
  and compatible quote, settlement, contract-direction, multiplier and quantity semantics;
- exposes source failures and a bounded stale REST fallback;
- rejects invalid bid/ask/size values and implausible absolute basis above 20%;
- reconstructs on-demand Binance/Bybit depth behind a bounded shared hub, publishes only after the
  venue-specific snapshot bridge, and invalidates the previous book on gap/reconnect.

This is a research baseline, not cross-leg simultaneity. Per-leg timestamps and gates reduce stale
mixes but cannot make independent venue messages atomic. Top-book discovery streams do not prove a
locally reconstructed full-book sequence. The separate depth path now proves each individual
book's configured sequence lifecycle, but the two legs are still asynchronous and browser paper
therefore remains a research feature.

## Canonical quote envelope

Every normalized quote/book update should carry:

```text
venue
market type
instrument ID + native symbol
bid/ask or depth levels
exchange timestamp
local receivedAt
sequence/update ID
snapshot/delta flag
connection generation
source transport
normalizer version
```

Derived values:

```text
receiveAgeMs = now - receivedAt
exchangeAgeMs = now - exchangeTimestamp
ageMs = max(receiveAgeMs, exchangeAgeMs)
transportLagMs = receivedAt - exchangeTimestamp
crossLegSkewMs = max(abs(receivedAt A - receivedAt B), abs(exchangeTimestamp A - exchangeTimestamp B))
```

An exchange timestamp can be absent or coarse; that limitation must be explicit. Local wall clocks
must be monitored because signed private requests and cross-host comparisons are sensitive to drift.
The basis wire therefore carries `spotExchangeTimestampVerified` and
`futuresExchangeTimestampVerified` separately. When venue time is absent, `exchangeTs` is omitted and
the route is `unverified`; a local receive time is never copied into that field. Freshness and
cross-leg skew use both venue and original local `receivedAt` timelines. Neither is refreshed on
cache reuse.

Binance Spot REST `bookTicker` is one current example: it has bid/ask and an update ID but no venue
timestamp. It may seed an `unverified` discovery candidate; the timestamped one-second Spot
`ticker` stream can promote that route to `fresh`. The REST depth fallback likewise remains
display-only; the on-demand timestamped sequence-reconstructed path is required for a complete
paper analysis.

The independent `venue-clock-v1` calibration model records public server-time probes as offset
intervals: `serverTime - localReceivedAt - resolution` through
`serverTime - localSentAt + resolution`. It retains bounded samples, rejects excessive RTT, widens
the selected interval by an explicit drift allowance and requires multiple compatible samples
before declaring a source calibrated. `GET /api/arbitrage/clock-health`, the public SDK and the
EN/RU/KK basis UI expose Binance, Bybit, OKX, Deribit, Kraken and Coinbase public-clock health; Gate's documented
server-time route requires authentication and Hyperliquid has no equivalent public clock probe, so
neither is synthesized. The pure timestamp assessor returns corrected age and worst-case
cross-venue skew intervals. Binance/Bybit basis REST ranking, stream refresh and alert gates now use
those conservative upper bounds; other engines remain raw-timeline or explicitly unverified until
their venue source identity is wired to calibration.

Kraken and the credential-free Coinbase time response publish second-resolution values. Their
calibration therefore preserves a full one-second resolution interval and normally remains
`degraded/uncertainty-too-high` under the stricter 250 ms policy; the service does not invent
millisecond precision to make the health indicator green.

Clock contracts: [OKX public time](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-system-time),
[Deribit `public/get_time`](https://docs.deribit.com/api-reference/supporting/public-get_time),
[Kraken server time](https://docs.kraken.com/api-reference/market-data/get-server-time),
[Coinbase public time](https://docs.cdp.coinbase.com/coinbase-business/track-apis/time),
[Gate server time/authentication boundary](https://www.gate.com/en-us/docs/developers/apiv4/), and
[Hyperliquid WebSocket book timestamps](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions).

## Quality gates

| Gate | Publish discovery row | Alert | Paper entry | Private execution |
| --- | --- | --- | --- | --- |
| finite positive bid/ask/size | required | required | required | required |
| instrument identity and contract metadata | required | required | required | required |
| both sources healthy after valid data | required | required | required | required |
| maximum quote age | show failed reason or suppress | fail closed | fail closed | fail closed |
| maximum cross-leg skew | show failed reason or suppress | fail closed | fail closed | fail closed |
| venue timestamps on both legs | required for `fresh` | fail closed | fail closed | required |
| sequence/checksum continuity | quality flag for top book; required for reconstructed delta depth | required when reconstructed depth affects rule | required on both reconstructed books; REST fallback fails closed | required for reconstructed delta depth |
| sufficient executable depth | optional estimate | required when rule has notional | required | required |
| lot/min-notional metadata | current registry identity for discovery; exact values before depth | required when rule has notional | required before book fetch | required |
| funding/borrow schedule provenance | no unverified credit; at least one unverified adverse debit | same conservative debit | funding is appended only as a confirmed manual settlement | required when the strategy depends on it |

The current browser paper gate requires two sequence-reconstructed books, venue timestamps on both
books, current independent local receive times, verified instrument steps/minimums, matched
quantity and request-bound identity. The selected Binance/Bybit feeds do not publish a checksum, so
their continuity proof is sequence-based rather than checksum-based. Funding enters the paper ledger only
as a settlement manually confirmed from venue/account history; the current ticker estimate is never
silently booked as realized funding.

Thresholds are versioned configuration, not hidden constants. A default suitable for one feed must
not silently apply to another feed with different cadence.

## Order-book lifecycle

For delta feeds the adapter must:

1. establish a connection generation;
2. obtain the required REST or WebSocket snapshot;
3. buffer deltas while the snapshot is in flight;
4. apply only continuous sequence ranges;
5. verify checksum when the venue supplies one;
6. reject duplicate, regressing and out-of-order updates;
7. mark the book unusable and resnapshot after a gap;
8. stop publishing after silence or subscription failure.

Top-book ticker feeds may not require local reconstruction, but the adapter must still preserve
exchange ordering metadata when available.

## Health state machine

```text
idle -> connecting -> awaiting-data -> healthy
                  \-> degraded -> reconnecting
healthy -> silent/gap/checksum-failed -> degraded -> resyncing -> healthy
```

TCP/WebSocket `open` is never `healthy`. Subscription acknowledgement alone is also insufficient
unless the venue defines it as a data snapshot. Reconnect backoff includes jitter, is bounded and
does not replay private mutations.

## Cross-leg snapshot policy

Depth analysis requests the two reconstructed books concurrently and preserves each accepted
delta's venue timestamp plus its own local receive time. If synchronization cannot complete, its
REST fallback remains explicitly unverified. The aggregate response reports per-book age,
receive-time skew, exchange-time skew when both are known, the effective leg skew and a quality
state. Cache hits recompute age from those original receive timestamps; the cache cannot make an old
book look newly captured. Browser paper entry/exit accepts only `quality: fresh`, both venue
timestamps, `sequenceContinuityVerified: true`, verified venue lot steps, sufficient matched depth
and zero residual directional exposure.

## Observability and retention

Safe operational metrics contain no credentials:

- connection generation and reconnect count;
- valid/invalid event counts;
- quote age and cross-leg skew percentiles;
- sequence gaps, checksum failures and resnapshot count;
- source subscription count and rate-limit state;
- rows suppressed by each quality gate;
- browser backpressure disconnects.

The seven-day opportunity history is a sampled research series, not raw quote provenance. The
offline schema-v4 replay envelope now stores adapter/version metadata, registry/cost-model binding,
exact accepted input/evidence digests and point-in-time constraint epochs separately. Deterministic
fixtures cover basis plus point-in-time triangular, pairwise, native-spread, options and N-leg
evaluation, but they are not a live historical dataset. A production data lake still needs durable
capture, object integrity, catalog/retention and reproducible ingestion evidence.

## Current limitations that must stay visible

- Quotes from separate venues are not atomic.
- Missing venue time remains explicit and blocks fresh/paper classification; it is never replaced by
  local receive time.
- The current browser stream sends full snapshots rather than sequenced deltas.
- The current route list and history are capped; absence from a response is not proof that no route
  exists.
- Exchange maintenance, ticker collisions, redenominations and symbol reuse can defeat string-only
  matching; exact instrument IDs plus the registry's reviewed economic-asset identity are the
  canonical boundary. Unknown economic identities fail closed rather than matching by ticker.
- Cross-venue discovery currently joins exact native symbols and has reviewed mappings for BTC/ETH
  only. Supporting aliases or token migrations requires a versioned, provenance-backed identity
  catalog keyed by exact venue instruments; automatic ticker proposals must never activate a route.

See [Adapter contract](EXCHANGE_ADAPTER_CONTRACT.md) and [Test matrix](ARBITRAGE_TEST_MATRIX.md).
