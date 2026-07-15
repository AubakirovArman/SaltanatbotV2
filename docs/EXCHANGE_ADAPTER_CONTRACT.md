# Exchange adapter contract

Status: target canonical contract, reviewed 2026-07-14.

This contract is the boundary for adding a venue without leaking venue-specific symbols, account
modes or WebSocket behavior into scanner engines. It describes required behavior; an item is not
shipped merely because it appears here. Current implementation status is recorded in
[Venue capabilities](VENUE_CAPABILITIES.md).

## Separation of authority

Each venue integration is split into independently constructible capabilities:

1. **Public metadata** — instruments, filters, contract and settlement rules.
2. **Public market data** — ticker, top book, depth, trades, mark/index and funding.
3. **Private read** — account, positions, fee tier, borrow and transfer state.
4. **Private mutation** — orders, leverage, borrow/repay and transfer.

Installing or enabling levels 1–2 must not create credentials or expose levels 3–4. Arbitrage
discovery accepts only levels 1–2. Paper simulation consumes normalized public events and never calls
a private adapter.

## Instrument metadata

The adapter must map every native symbol to a stable normalized record containing:

```text
venue + venueSymbol
baseAsset + quoteAsset + settleAsset
marketType (spot/margin/perpetual/future/option/spread)
linear/inverse + contractMultiplier
tickSize + quantityStep + minimumQuantity + minimumNotional
status
fundingInterval and next settlement where applicable
expiry + strike + optionType where applicable
```

Unsupported or unknown fields remain absent and block dependent functionality. A regex on `*USDT`
is not an identity proof. Asset aliases, multipliers and redenominations require explicit mapping.

## Public adapter behavior

A public adapter provides bounded operations conceptually equivalent to:

```ts
interface PublicVenueAdapter {
  capabilities(): VenueCapabilityManifest;
  instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot>;
  tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot>;
  ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook>;
  depth(request: DepthRequest, signal?: AbortSignal): Promise<PublicDepthSnapshot>;
  funding(instrumentId: string, options?: FundingOptions): Promise<PublicFundingSchedule>;
}
```

The HTTP facade requires an explicit scope for every operation. Its funding route currently accepts
only `marketType=perpetual`, validates that a stable ID carries the same scope before stripping the
venue prefix, and returns that scope in the response. Spot, margin, dated-future, option and native
spread IDs are not interchangeable even when their native symbol text happens to look alike.

This REST snapshot boundary is implemented by the isolated OKX, Gate.io, Hyperliquid and Deribit
adapters. Capability is operation-specific: Hyperliquid and Deribit intentionally reject bulk
`tickers()` rather than fan out hundreds of requests, while exact `ticker()` and bounded `depth()`
remain available. Streaming adds a separate interface because acknowledgement, heartbeat, sequence
and reconstruction state do not fit a one-shot snapshot contract. In both cases the following
behavior is mandatory:

- caller cancellation and finite timeout;
- explicit rate-limit classification and bounded concurrency;
- process-wide coalescing of identical unauthenticated reads and overload rejection instead of an unbounded queue;
- runtime validation before normalization;
- exchange timestamp, local receive time and ordering metadata preservation;
- subscription acknowledgement/heartbeat semantics specific to the venue;
- jittered reconnect with no unbounded queue;
- gap/checksum recovery before a reconstructed book is healthy;
- bounded payload and subscription counts;
- structured errors that never include credentials or full signed URLs.

## Private adapter behavior

Private adapters implement the execution-core lifecycle and additionally declare account modes,
position modes, supported order/protection types and idempotency behavior. Mutating requests require:

- explicit live arming and scoped authorization;
- stable client order IDs and durable intent before network I/O;
- no blind retry after an ambiguous timeout;
- acknowledgement/fill reconciliation through private stream plus bounded polling;
- venue filters and worst-case risk preflight;
- audit-safe request/result summaries;
- no withdrawal permission requirement.

Borrow, repay, leverage and collateral switches are separate mutation capabilities. A trading adapter
cannot infer them from `privateExecution: true`.

`/api/venues` therefore uses product-scoped operation records for Binance/Bybit. Missing
`product + operation` pairs are unsupported; `experimental` and `manual-only` remain `false` in the
legacy summary booleans. Engines must select a concrete scoped operation and still pass the normal
server authorization/risk gates.

## Capability manifest

The manifest is versioned and fail-closed. It includes:

- market/product support;
- public data channels and their sequence/checksum requirements;
- private read/mutation capabilities;
- demo/testnet support and differences from production;
- subscription/rate limits;
- supported account/position modes;
- adapter version and last official-doc review date.

Engines select adapters by capability. They must not select a venue because its name appears in a
hard-coded union alone.

## Implemented public plugin boundary

The backend now exposes contract `public-venue-adapter 1.0.x` from
`backend/src/venues/conformance`. A plugin is a compile-time descriptor with an exact venue,
semantic `adapterVersion`, compatible `contractVersion`, `officialDocsReviewedAt`, operation/market
coverage, hard result limits and a zero-argument adapter factory. Its authority literal is always
`public-read-only`; runtime registration rejects private execution, borrow, deposit/withdrawal and
non-public capability scopes. Plugin IDs and venues are unique, and the factory's venue and full
capability value must exactly match its descriptor.

Compatibility is fail-closed: this runtime accepts `>=1.0.0 <1.1.0`, rejects malformed versions,
future review dates and reviews older than the configured certification window. A minor contract
upgrade therefore requires an explicit runtime review instead of optimistic loading. Adding a
plugin does not alter the server allowlist automatically.

The deterministic fake venue certifies nine advertised operation/market scopes with five scenarios
each: normalized success, caller cancellation, timeout, rate limit and generic HTTP failure. The
immutable report is capped at 128 cases. Success validates bounded JSON, stable instrument IDs,
finite positive book values, strict depth sorting, crossed-book rejection, quantity units,
timestamps, funding history and exact error classification. The fake venue is a CI harness, not a
live-exchange certification.

## Normalization invariants

- Prices and quantities are finite, positive decimal values after normalization.
- Bid is never greater than ask without an explicit crossed-book error.
- Quantity units are documented as base asset, quote value or contracts.
- Inverse contracts retain multiplier/settlement semantics; they are not treated as linear units.
- Funding rates have a declared interval, timestamp and sign convention.
- Sequence IDs never regress within one connection generation.
- Normalized events are immutable and JSON-safe.
- Unknown enum values fail validation instead of silently mapping to spot/linear defaults.

## Conformance gate

A candidate venue becomes `Current public` only after:

- recorded REST and WebSocket fixtures for happy/error variants;
- instrument/filter normalization tests;
- silent socket, heartbeat, reconnect, duplicate, gap and out-of-order tests;
- rate-limit and timeout tests;
- cross-adapter identity collision fixtures;
- depth/rounding/min-notional property tests;
- one public canary that uses no credentials;
- documentation and EN/RU/KK user-facing status updates.

The current OKX, Gate.io, Hyperliquid and Deribit milestones satisfy operation-specific recorded REST
portions only. They must not be described as streaming scanner integrations until socket fixtures,
gap recovery and a credential-free public canary satisfy the remaining gate. See the corresponding
adapter documents and [Venue capabilities](VENUE_CAPABILITIES.md).

The plugin harness is one reusable part of this gate. Each real venue still needs its own reviewed
descriptor, operation fixtures and certification report; the passing synthetic fake report is not
substituted for those proofs.

Private execution requires its own lifecycle, ambiguity, recovery and authorization gate. Public
conformance is never evidence of private safety.
