# Intra-exchange triangular arbitrage engine

This directory contains a transport-free spot conversion engine exposed through the read-only
`GET /api/arbitrage/triangular` research route and browser mode. The service supplies validated
metadata and bounded public books; the pure engine returns three-leg opportunities and has no order
path.

## Model

Every spot market creates two directed graph edges:

- `BASE -> QUOTE` sells base into bids;
- `QUOTE -> BASE` buys base from asks.

`buildTriangularGraph()` precomputes all three-market cycles anchored in assets
listed in `startQuantities`. It rejects incomplete metadata instead of applying
fee, lot-size or minimum-notional defaults. The incremental engine indexes each
market to its cycles, so `updateBook(market)` reevaluates only cycles containing
that market.

Execution walks visible depth and propagates the output of one leg into the
next. Base order quantities are floored to the venue lot step. Minimum quantity
and notional apply after rounding. Fees are charged in each leg's output asset;
this explicit conservative assumption is reported as a risk flag. Unconverted
input is retained as per-asset dust but is not credited to cycle return.

If the requested size exceeds a later leg's depth, bounded search reduces the
whole route to a start size all three legs can execute. This avoids creating
unhedged intermediate inventory by partially filling only the constrained leg.

## Data-quality boundary

Sequence-verified depth evaluation fails closed when:

- required metadata or a book is missing;
- a book is partial, crossed, unsorted or contains invalid levels;
- a venue timestamp is absent, exchange/receive timestamps are stale, too far apart or implausibly future;
- a snapshot has no verified positive sequence;
- quantity, notional or visible-depth constraints cannot be satisfied.

WebSocket adapters must publish `sequenceVerified: true` only after snapshot bridging and
sequence-gap checks. `complete: true` by itself only describes the supplied payload and is not
sequence evidence. Open socket state alone is not sufficient.

The public REST scanner is deliberately a different mode. Venue-wide ticker responses contain one
top-book level and do not prove book sequence continuity. They are evaluated only as
`rest-top-book` / `rest-snapshot` research rows with `sequenceVerified: false`,
`edgeKind: non-executable-candidate` and matching risk flags. Binance REST ticker rows without a
venue timestamp keep `exchangeTs` absent; local `receivedAt` is never relabelled as venue time.

## Minimal usage

```ts
const engine = new TriangularArbitrageEngine(markets, {
  startQuantities: { USDT: 1_000 },
  maxQuoteAgeMs: 1_500,
  maxLegSkewMs: 200,
  minNetReturnBps: 5
});

engine.updateBook(btcUsdtBook);
engine.updateBook(ethBtcBook);
const delta = engine.updateBook(ethUsdtBook);
const current = engine.opportunities();
```

`delta.evaluatedCycleIds` makes the incremental boundary observable. The
opportunity contract includes all legs, gross/net return, requested and
executable start size, end size, limiting depth, per-leg timestamps, dust and
risk flags. Only the strict engine fed sequence-verified depth is labelled
`executable-sequential` (still not guaranteed or atomic). The public REST route can never receive
that label.
