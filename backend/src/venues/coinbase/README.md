# Coinbase Exchange public adapter

This folder implements the public Coinbase **Exchange** market-data API for Spot products. It does
not use the Advanced Trade brokerage endpoint, JWT, API key, profile or private execution method.

## Modules

- `adapter.ts` provides Spot instruments, selected-product L1 and bounded aggregated L2.
- `transport.ts` validates the origin, enforces timeout/cancellation/body/concurrency bounds and
  classifies HTTP 429 without a local queue.
- `normalize.ts` validates product identity, native base sizes, strict order and timestamps.
- `plugin.ts` advertises only the implemented public-read-only operations.
- `types.ts` and `validation.ts` isolate untrusted upstream data.

## Identity and units

Coinbase product IDs are stable native IDs such as `BTC-USD`. Book size and `base_increment` are in
the base asset. `quote_increment` is the price tick, and `min_market_funds` is retained as the
documented notional minimum. Because Coinbase no longer documents `base_min_size`, normalized
`minimumQuantity` is zero rather than pretending the increment is a minimum.

USD and USDC are never aliased. Even when `fx_stablecoin` is true, `BTC-USD` and `BTC-USDC` remain
separate quote/settlement identities and receive no `economicAssetId` without a reviewed mapping.

## Books and limits

`ticker()` uses the public level-1 aggregated book because the ticker endpoint omits bid/ask sizes.
`depth()` uses the recommended aggregated level 2 and returns at most 500 validated levels per side.
The upstream response is still fully bounded (4 MiB and 20,000 source levels per side) because the
Coinbase L2 endpoint is not paginated and returns the entire book. Venue sequence and ISO book time
are preserved. Auction-mode, locked, crossed or unsorted books fail closed because auction quotes
are indicative rather than executable.

Coinbase has no bounded bulk BBO endpoint in this API, so `tickers()` is explicitly unsupported;
the adapter never fans out one request per product. Funding and derivatives are also unsupported.

Default timeout is 8 seconds and the default per-instance in-flight cap is 8 with immediate
structured `rate-limit` failure. Fixtures and failure tests live in
`backend/tests/fixtures/coinbase` and `backend/tests/coinbasePublicAdapter.test.ts`. The adapter is
registered in the shared public facade. Selected-instrument continuous research uses the public
Advanced Trade `level2` plus `heartbeats` channels, never `market_trades`; most `*-USDC` public
subscriptions are rejected because Coinbase documents that they return the corresponding `*-USD`
data. No JWT or private endpoint is added.
