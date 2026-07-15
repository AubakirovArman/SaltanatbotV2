# Kraken public adapter

This folder is a credential-free REST adapter for Kraken Spot and Kraken Derivatives. It does not
accept API keys, JWTs, account identifiers or order requests.

## Modules

- `adapter.ts` implements the normalized `PublicVenueAdapter` boundary.
- `transport.ts` owns origin validation, finite timeout, caller cancellation, bounded response
  bodies and queue-free per-instance concurrency rejection.
- `normalizeSpot.ts` handles `assetVersion=1` Spot metadata, bulk/selected BBO and L2 snapshots.
- `normalizeFutures.ts` handles inverse Coin-M and linear Multi-M metadata/BBO/depth plus inverse
  perpetual funding.
- `plugin.ts` is the versioned public-read-only capability descriptor.
- `types.ts` and `validation.ts` isolate untrusted upstream shapes and fail-closed primitives.

## Identity and units

- Spot uses Kraken's documented `assetVersion=1` display keys, such as `BTC/USD`. This avoids
  legacy `X`/`Z` prefixes while retaining the native pair as the stable ID.
- Derivative stable IDs retain the native symbol (`PI_XBTUSD`, `PF_XBTUSD`, `FI_*`, `FF_*`). The
  documented Kraken equivalence maps API `XBT` to canonical `BTC`; no other economic alias is
  inferred.
- `PI_`/`FI_` inverse books are in contracts. `contractSize` is quote-value per contract and PnL
  settles in the base asset.
- `PF_`/`FF_` linear Multi-M books are in base units. `contractValueTradePrecision` defines the
  base quantity step. Linear settlement stays in the documented quote currency.
- `futures_vanilla` rows are quarantined until their quantity currency can be proven from the row,
  instead of guessing from a symbol.

## Time, depth and funding

Kraken Spot Ticker has no exchange timestamp, so its BBO explicitly uses receipt time. Spot Depth
uses the newest level timestamp. Kraken Futures uses the envelope `serverTime`. Neither REST book
publishes a replay sequence; normalized `sequence: 0` is therefore an honest unsequenced sentinel,
not continuity proof.

Funding is enabled only for inverse `PI_` perpetuals. Kraken publishes absolute and relative rate
semantics: current/predicted absolute inverse rates are multiplied by the index price, while
history consumes `relativeFundingRate` directly. The documented hourly schedule is represented,
and history failure is isolated from the current schedule. Linear funding remains unsupported until
the current ticker unit can be normalized without inference.

## Resource limits

- default timeout: 8 seconds;
- default body cap: 2 MiB;
- default per-instance in-flight cap: 8, with immediate structured `rate-limit` failure;
- Spot output depth: 1–500 levels per side;
- Futures output depth: 1–500 from a source capped at 10,000 levels per side;
- funding history output: 1–100 points.

Recorded fixtures and failure tests live in `backend/tests/fixtures/kraken` and
`backend/tests/krakenPublicAdapter.test.ts`. The adapter is registered in the shared public facade.
Selected-instrument continuous protocols live under `arbitrage/upstream/publicFeeds`: Spot v2 uses
lossless decimal CRC32 verification, while Futures v1 is kept under a separate non-gap-free
sequence proof. Neither protocol adds credentials, account access or execution.
