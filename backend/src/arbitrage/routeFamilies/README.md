# Deterministic two-leg route-family discovery

This module discovers and evaluates six research-only route families over the existing normalized
pairwise instrument and book contracts. It is transport-free and has no account, credential or
order dependency. `POST /api/arbitrage/route-families/evaluate` is a bounded facade over the same
pure functions; every envelope and opportunity says `executable: false`.

## Families and direction

| Family | Generated ordered legs | Required exact inputs |
| --- | --- | --- |
| `cross-venue-spot-spot` | long/buy spot, short/sell spot on another venue; both directions | verified quote capital on the buy venue, verified base inventory on the sell venue, rebalance cost |
| `reverse-cash-and-carry` | long perpetual, short borrowed spot | verified borrow availability/APR through exit, perpetual funding through exit, convergence/exit fees |
| `perpetual-perpetual-funding` | long one perpetual, short another; both directions | both funding schedules through exit, convergence/exit fees |
| `spot-dated-future` | long spot, short dated future | verified quote capital, convergence, close-before-expiry delivery model |
| `calendar-spread` | long one dated future, short another on the same venue; both directions | convergence plus close-before-expiry or exact near-settlement/far-roll model |
| `perpetual-future` | one perpetual and one dated future; both directions | perpetual funding, convergence and close-before-expiry model |

Discovery only enumerates statically compatible ordered pairs. It requires an exact reviewed
`economicAssetId`, common base/quote/settlement assets and a linear base-equivalent quantity model.
Same ticker text is ignored. Inverse, quanto, unknown-unit, unknown-filter and settlement-FX routes
are excluded or rejected fail closed.

Materialization never invents economics. A caller supplies an exact `(family, longInstrumentId,
shortInstrumentId)` scope with requested quantity and route assumptions, plus instrument-keyed
capital, inventory, borrow and funding records. Missing or duplicate records are rejected; a venue
capability flag is never account availability. Funding is an aggregate signed rate for the full
declared horizon, and convergence remains a scenario rather than a promised outcome.

## Bounds and determinism

The HTTP boundary accepts at most 120 instruments/books, 500 exact scopes and 500 evaluated
candidates inside the server-wide 1 MiB JSON limit. The pure discovery function accepts at most
500 instruments and returns at most 500 candidates. Candidate order is fixed by family then ordered
instrument IDs; route IDs are a SHA-256-derived identity of that exact tuple. Truncation reports the
full compatible count and never relabels omitted routes as evaluated.

`pairwiseInstrumentFromRegistry` and `pairwiseBookFromPublicDepth` bridge the shared registry/public
adapter contracts without synthesizing identity, fees, quantity units or timestamps. Unknown
minimum filters and non-base contract multipliers fail closed. A REST snapshot may be used for
bounded research, remains flagged `rest-snapshot`, and does not become a sequence-reconstructed
live book.

The continuous public-feed bridge in `upstream/publicFeeds/` adds selected OKX, Gate and Deribit
sequence-proven WebSocket books to the same discovery model. Hyperliquid block snapshots remain
top-book research signals and are not relabeled as sequence-verified. Stream funding is kept as a
point-in-time observation and never substituted for this engine's explicit full-horizon assumption.

The result is a projected research simulation under caller-supplied assumptions. It does not model
atomicity, private balances, derivative margin/liquidation, transfer availability, recalls, partial
multi-leg recovery or regional eligibility and must never be described as guaranteed.
