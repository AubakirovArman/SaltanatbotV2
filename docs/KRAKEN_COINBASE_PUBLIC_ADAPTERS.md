# Kraken and Coinbase public adapters

Status: shared public adapter plus selected-instrument continuous backend slice, official
documentation reviewed 2026-07-14. The code is public/read-only and can feed the operator-allowlisted
research scanner; no account, execution or mainnet-readiness claim is made.

## Capability boundary

| Venue | Implemented | Explicitly unsupported |
| --- | --- | --- |
| Kraken | Spot metadata/bulk BBO/selected BBO/L2; inverse and linear perpetual/future metadata/BBO/L2; inverse perpetual current/predicted/settled funding | private API, account data, orders, borrow/transfers, options, `futures_vanilla` without proven quantity currency, linear current-funding conversion |
| Coinbase Exchange | Spot product metadata, selected-product L1 BBO and aggregated L2 | JWT/private API, orders/accounts, derivatives/funding, request-per-product bulk BBO |

Both capability manifests set `privateExecution`, `borrow` and `depositWithdrawal` to `false` and
provide a versioned `public-read-only` plugin descriptor. Constructors accept transport controls,
not credentials.

## Normalization decisions

Kraken Spot requests `assetVersion=1`, which makes response keys and asset fields use display names
such as `BTC/USD`, `BTC` and `USD`. Kraken's own specifications state that API `XBT` and UI `BTC`
refer to Bitcoin, so derivative metadata applies only that reviewed mapping while preserving native
symbols (`PI_XBTUSD`, `PF_XBTUSD`, `FI_*`, `FF_*`). Spot quantities are base units. Inverse books
are contracts whose `contractSize` is quote value and which settle in base; linear Multi-M books use
base units and `contractValueTradePrecision` for the step.

Coinbase book quantities and `base_increment` are base units; `quote_increment` is the price tick.
USD and USDC remain different quote/settlement identities. `fx_stablecoin` does not prove a 1:1
conversion, so no alias or `economicAssetId` is added.

Kraken REST books do not expose a continuity sequence, so `sequence: 0` is documented as an
unsequenced snapshot sentinel. Coinbase preserves its exchange sequence. Coinbase auction books
are rejected because the venue documents them as indicative and potentially crossed.

For continuous data, Kraken Spot v2 keeps the original JSON decimal lexemes, applies every update
in message order, truncates to the exact subscribed depth and verifies the official CRC32 over the
top ten levels. Its published ordinal is local to the connection generation, not a fabricated
venue sequence. Kraken Futures uses a separate `kraken-futures-seq` proof: `seq` must advance, but
the book remains a non-route-ready research signal because the official specification does not
promise contiguous per-product values.

Coinbase continuous data uses only the Advanced Trade public `level2` channel plus a separate
`heartbeats` subscription. A 2026-07-14 credential-free production observation showed that
`sequence_num` interleaves globally across L2, subscription acknowledgements, heartbeats and other
connection envelopes. The consumer therefore requires zero first and exact `prior + 1` on every
non-error envelope before dispatching or ignoring its channel. It independently requires a full
snapshot before updates, absolute quantities and contiguous heartbeat counters. A sequence-zero
snapshot is published as a research book but cannot become route-ready until a positive L2
publication. Snapshot envelope time is never compared with a delta's matching-engine `event_time`:
the official snapshot example uses epoch sentinels, and production can sequence a first delta event
before the snapshot envelope timestamp. Delta event-time monotonicity remains fail-closed from the
first delta onward. `market_trades` is never treated as a book. Coinbase documents that most public
`*-USDC` subscriptions return corresponding `*-USD` data, so those symbols fail closed except for
the documented `USDT-USDC` and `EURC-USDC` exceptions.

## Funding semantics

For inverse Kraken `PI_` perpetuals, the ticker's absolute current/predicted rate is converted to a
relative fraction with the index price. Historical points use the venue's explicit
`relativeFundingRate`. Positive rates retain the documented convention that longs pay shorts. The
hourly funding boundary is derived from Kraken's published schedule. A history failure does not
discard a valid current schedule; malformed or duplicate history points are quarantined.

Linear current funding remains unsupported because the common ticker field does not carry enough
unit metadata to prove the same conversion for every product type. This is deliberately narrower
than guessing.

## Resource and failure policy

- 8-second default timeout with caller abort propagation;
- 2 MiB Kraken and 4 MiB Coinbase default body bounds;
- 2 MiB default continuous WebSocket frame bound, isolated to 8 MiB for Coinbase's full initial L2;
- at most 60,000 Coinbase updates in one frame while retaining at most the configured 1,000 levels;
- queue-free default cap of eight concurrent requests per adapter instance;
- immediate structured `rate-limit` classification for local overload and HTTP 429;
- Kraken Spot depth 1–500, Kraken Futures/Coinbase output depth 1–500;
- source-level CPU bounds before normalization;
- empty, wholly malformed, crossed, locked, unsorted, identity-inconsistent and unsafe-timestamp
  responses fail closed;
- invalid list rows are quarantined only when at least one valid row remains.

## Evidence and remaining integration

`backend/tests/krakenPublicAdapter.test.ts` and `backend/tests/coinbasePublicAdapter.test.ts` cover
recorded fixtures, native units, exact identity, funding arithmetic, timestamps, cancellation,
timeouts, rate limits, exchange/HTTP failures, oversized streams, auction/crossed books and plugin
authority. `backend/tests/krakenCoinbaseContinuousProtocols.test.ts` adds checksum mismatch,
lossless decimals, globally interleaved L2/control/ignored/heartbeat sequence gaps, sequence-zero
route gating, snapshot-envelope/delta-event clock separation, reconnect generation, public-channel
identity and Futures proof-boundary coverage.
Fixtures document their official source pages under
`backend/tests/fixtures`.

The adapters are exported through the shared facade, registry and process governors, and the
continuous protocol factory accepts reviewed Kraken/Coinbase instruments. Both Spot feeds are now
targets in the daily/manual nine-target credential-free canary. The 2026-07-14 schema-v3 run passed
Coinbase and seven other venues; Kraken remained unreachable through this host's TLS path. Live
observations exposed Coinbase's real 4.8 MiB/43k-update snapshot and connection-global sequence
across L2/control/heartbeat envelopes; both now have deterministic bounds/regression coverage.
Remaining product work is successful scheduled Kraken evidence from an eligible network and proof
of linear Kraken current-funding units. One canary is not soak/readiness evidence, and none of these
steps enables private execution.

## Official sources

- Kraken Spot: [AssetPairs](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs),
  [Ticker](https://docs.kraken.com/api-reference/market-data/get-ticker-information),
  [Depth](https://docs.kraken.com/api-reference/market-data/get-order-book).
- Kraken Derivatives: [instruments](https://docs.kraken.com/api-reference/instrument-details/get-instruments),
  [tickers](https://docs.kraken.com/api-reference/market-data/get-tickers),
  [orderbook](https://docs.kraken.com/api-reference/market-data/get-orderbook),
  [historical funding](https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates),
  [inverse specifications](https://support.kraken.com/articles/360022835911-inverse-crypto-collateral-perpetual-contract-specifications-derivatives)
  and [linear Multi-M specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications).
- Coinbase Exchange: [public market-data boundary](https://docs.cdp.coinbase.com/exchange/introduction/welcome),
  [products](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-all-known-trading-pairs),
  [product book](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book)
  and [public REST limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits).
- Kraken continuous: [Spot v2 book](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book),
  [Spot checksum guide](https://docs.kraken.com/api/docs/guides/spot-ws-book-v2/) and
  [Futures book](https://docs.kraken.com/api/docs/futures-api/websocket/book/).
- Coinbase continuous: [WebSocket overview and sequences](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
  and [level2/heartbeat channels](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels).
