# Hyperliquid public adapter

Status: current credential-free adapter exposed through `/api/market-data/hyperliquid/*`, reviewed
against the official API on 2026-07-14. It is not part of `/api/instruments`, the live scanner/chart
UI or private execution.

## Authority boundary

The adapter performs credential-free `POST https://api.hyperliquid.xyz/info` calls (or the official
testnet origin). Its transport allowlists only:

- `metaAndAssetCtxs` and `spotMetaAndAssetCtxs`;
- `l2Book`;
- `predictedFundings` and `fundingHistory`.

It cannot call `/exchange`, accept a wallet/agent key, sign a chain action, query a user account or
touch HyperEVM/indexer/S3 data. The manifest sets private execution, borrow, transfers and account
authority to `false`. Wallet custody, chain signing and execution require a completely separate
security review.

## Identity and products

The current scope is spot plus the first/default perpetual DEX. HIP-3 builder DEXs and outcome
`#...` assets are different identity domains and are rejected/ignored rather than guessed.

For perps, `assetIndex` is the row position in the metadata universe. For spot, token index, token ID
and pair index remain separate: `assetIndex = 10000 + pairIndex`. `PURR/USDC` keeps its native coin;
other pairs use `@{pairIndex}` exactly as required by the API. Stable spot identity includes the
network and 16-byte token ID, so a UI remap such as UBTC → BTC cannot silently merge assets. The
official docs warn that mainnet and testnet asset IDs differ; normalized IDs therefore include the
network.

Perp `isDelisted: true` maps to `closed` with a verified delist state. Spot metadata does not publish
the same flag; an entry present in the spot universe is usable for discovery, but its delist state is
marked unverified. Outcome contexts returned alongside spot contexts are not interpreted as spot.

## Precision and settlement

Size is in coin/base units. `quantityStep = 10^-szDecimals`. Hyperliquid does not have one static
price tick valid at all price magnitudes: prices allow at most five significant figures and at most
`6 - szDecimals` decimals for perps or `8 - szDecimals` for spot; integer prices remain valid. The
shared `tickSize` is therefore `0` (unknown/dynamic), and the verified rule is carried in
`priceRules`. Zero must never be interpreted as disabled price validation.

Perps represent one unit of underlying and settle PnL in USDC against a USD reference. They are
marked `quanto` in the generic contract to avoid pretending that reference denomination and
settlement currency are identical. The public minimum notional is normalized as 10; spot uses 10
units of its quote token.

## Executable prices and references

Only `l2Book` produces executable top-of-book and depth. `allMids` is deliberately excluded because
the official API may substitute the last trade when a book is empty. Mark, oracle and asset-context
mid prices are exposed only under `referenceContext` with `executable: false`:

- oracle is a validator-produced external spot reference used by funding;
- mark is a robust risk/liquidation/unrealized-PnL reference;
- mid is a reference context field, not proof of two executable sides.

REST `l2Book` returns at most 20 levels per side and an exchange timestamp, but no sequence/checksum.
The normalized snapshot says `sequenceVerified: false`; it cannot be used as a gap-checked stream.
Crossed, locked, empty-sided, unsorted, oversized or mismatched books fail closed. All-book loading
uses bounded concurrency, a configurable maximum instrument count (350 by default), and explicit
per-instrument rejection records for partial failures.

## Funding semantics

For first-DEX perps, the current estimate is the `HlPerp` entry in `predictedFundings`; it provides
the exact next settlement time. Official funding documentation verifies an hourly, asset-independent
interval and a ±4%/hour cap. Settled points come from `fundingHistory`, bounded to 500 rows. A failed
current prediction rejects the result; a history-only failure preserves the current schedule and is
reported in `sourceErrors`.

The prediction response has no server observation timestamp. `exchangeTs` therefore equals local
receive time and `timestampSource` is explicitly `local-receive`; it must not be treated as a chain
block timestamp. Asset-context `funding` remains a separately labelled reference and is not silently
substituted for the predicted schedule.

## Validation and operational limits

Every request has caller cancellation, a finite timeout, bounded response size, strict JSON/schema
checks and structured timeout/rate-limit/HTTP/exchange/validation errors. The transport sends only
`Content-Type`/`Accept`, never authorization. Recorded tests cover network-separated identity,
dynamic precision, delisting, sparse spot contexts, executable books, partial failures, funding,
timeouts, cancellation, rate limits and malformed data.

Hyperliquid exposes no single bounded bulk executable-book method: every `l2Book` request names one
coin. The adapter therefore rejects `tickers()` as `unsupported` and accepts only caller-selected
exact `ticker()`/`depth()` requests. This prevents one anonymous facade call from amplifying into
hundreds of upstream requests. A future all-market feed requires a separately rate-limited,
validated WebSocket aggregator.

Official references:

- [API and mainnet/testnet origins](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [Info endpoint and L2 book](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Spot metadata](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)
- [Perpetual metadata and funding history](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)
- [Tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)
- [Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)
- [Robust price indices](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/robust-price-indices)
- [Rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
