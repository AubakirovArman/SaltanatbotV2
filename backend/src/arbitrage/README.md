# Arbitrage research backend

This module owns the credential-free, read-only Binance/Bybit spot/perpetual research path. Nothing
in this folder submits orders or reads an exchange account.

- `service.ts` performs bounded REST discovery, normalizes four same/cross-venue routes and retains a
  maximum 30-second stale fallback when a refresh cannot rebuild any route. It never synthesizes a
  venue timestamp: both legs need venue-provided and local receipt times before a row is fresh;
  candidates without that evidence remain visibly `unverified` and rank below fresh rows.
- `upstream/` owns four shared direct public ticker sockets. Binance Spot uses the timestamped
  one-second ticker stream because Spot bookTicker has no event time; Futures uses bookTicker. A
  socket is healthy only after valid market data; silence triggers termination and jittered
  exponential reconnect.
- `stream.ts` combines REST discovery with live ticker updates, coalesces snapshots, rejects slow
  browser consumers and keeps feeds active without a browser only for enabled persistent alerts.
- `depth.ts` requests both public books through the bounded sequence-verified L2 hub, derives one
  matched base quantity, rounds to a common step and reports precision, dust, residual delta, VWAP
  and completeness. REST remains a research fallback, but missing either venue timestamp or either
  snapshot/delta continuity proof makes timing unverified and prevents a paper-complete result.
- `depthIdentity.ts` binds every depth result to both verified instrument IDs and the same native or
  reviewed economic identity used by the selected scanner route.
- `triangularDepth/` is the explicit second stage for one selected three-leg candidate. It obtains
  three sequence-reconstructed books from the bounded L2 hub, checks generation leases before and
  after simulation and exposes a public read-only proof with no credential/order surface.
- `fundingCurve/` builds bounded point-in-time public funding schedules and additive per-settlement
  stress scenarios. It accepts no notional, account state, credentials or order instruction and
  fails closed when the adapter cannot verify the discrete settlement interval.
- `sharedAbortableWork.ts` deduplicates identical upstream work with subscriber-aware cancellation
  and rejects excess unique depth requests instead of growing an unbounded queue.
- `history.ts` records at most 50 routes once per minute and prunes public research samples after
  seven days; `routes.ts` exposes bounded scan, depth and history endpoints.
- `lifecycle/` provides a pure scanner-agnostic `first-seen → confirmed → decaying → expired` reducer
  for basis, triangular, native-spread and pairwise candidates. It aggregates weakest-leg evidence,
  applies score hysteresis and freshness decay, deduplicates immutable observations and retains a
  bounded deterministic event history. Incomplete universes never prove absence or produce an
  actionable route. The module has no notification or order side effects and is not yet wired into
  the existing alert contract.
- `alerts.ts` / `alertRoutes.ts` persist authenticated notification-only rules. Crossing and cooldown
  state is isolated per rule + opportunity. A durable at-least-once outbox records queued, sending,
  retrying, delivered, failed and cancelled delivery states, uses bounded exponential backoff and
  resumes expired attempts after restart. It never invokes the trading engine.
- `researchAlerts/` owns generic economics/capital-aware policy evaluation and a durable
  cross-family notification outbox. Its protected policy/history routes are mounted below
  `/api/trade`; snapshots can enter only from server-owned adapters and cannot grant order
  permission.
- `types.ts` owns current two-venue response/domain contracts.
- `routeFamilies/` deterministically enumerates six research-only two-leg families over normalized
  instruments/books, requires exact capital/inventory/borrow/funding/convergence scopes and exposes
  no credential or order path.
- `paperMultiLeg/` converts evaluated route-family/N-leg results into short-lived paper-only plans.
  Its isolated bounded SQLite journal records deterministic partial fills, reverse-order
  compensation and restart recovery with idempotency/tamper checks. Its protected router is mounted
  below `/api/trade/paper-multi-leg`; it has no private adapter or live-order path.
- `optionsParityRoutes.ts` exposes the pure European options engine through one strict bounded POST
  contract. Expiry, settlement, premium FX, fees, capacity and borrow remain timestamped
  caller-supplied assumptions; the response is permanently read-only and non-executable.
- `telemetry/` owns protected GET-only Binance/Bybit account economics evidence: current signed fee
  rates/tier/conditional fee assets, borrow capacity/rate, transfer-network state and stablecoin FX
  provenance. It is registered after the trading session boundary, has its own governor/circuit and
  never promotes unknown commission assets or borrow recallability to executable evidence.

The executable comparison is **buy spot at ask** and **short linear perpetual at bid** on the same
or another supported venue. The gross result is entry basis, not locked profit. Funding, fees, borrow, transfer,
future exit basis and cross-venue timing remain assumptions. The current opportunity envelope
records per-leg exchange/receive time and suppresses stale or cross-leg-skewed rows. Those gates do
not make feeds atomic or prove full-book sequence continuity, so private execution remains outside
this module.

Funding projections never credit an unverified schedule. An unverified negative current rate is
charged as at least one settlement for every non-zero holding horizon, including when the next
settlement time is absent; this prevents unknown funding liability from increasing alert edge.

Canonical references: [taxonomy](../../../docs/ARBITRAGE_TAXONOMY.md),
[math](../../../docs/ARBITRAGE_MATH_AND_ASSUMPTIONS.md),
[account telemetry](../../../docs/ACCOUNT_TELEMETRY.md),
[market-data quality](../../../docs/MARKET_DATA_QUALITY.md) and
[test matrix](../../../docs/ARBITRAGE_TEST_MATRIX.md).
