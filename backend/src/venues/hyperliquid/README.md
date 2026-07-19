# Hyperliquid public adapter

This folder is a credential-free HyperCore market-data boundary. The transport can call only six
public `POST /info` request types: `metaAndAssetCtxs`, `spotMetaAndAssetCtxs`, `l2Book`,
`predictedFundings`, `fundingHistory` and `candleSnapshot`. There is no `/exchange` route, wallet, agent key, chain
signature, account address or HyperEVM/indexer client.

## Files

- `transport.ts` — public request allowlist, mainnet/testnet origin, timeout, cancellation, HTTP/error
  classification and response-size bound.
- `normalize.ts` — strict native identity, metadata, L2 book and funding normalization.
- `types.ts` — Hyperliquid-specific semantics layered over the shared public snapshot interfaces.
- `adapter.ts` — capability manifest and bounded public operations.
- `index.ts` — stable exports consumed by the bounded public market-data facade. The ordinary chart
  path reuses the transport for REST candle backfill and has separate public WebSocket connectors;
  private-execution wiring remains absent.

The chart source covers first/default-DEX perpetual last-trade candles, L2 and aggressor-side
trades. Paper robots can use those candles as simulated market input. This does not create a wallet
or turn on `/exchange` execution.

Spot identity uses the token ID plus network, not a UI-remapped ticker. The API `coin` is
`PURR/USDC` for PURR and `@{pairIndex}` for other spot pairs; the execution asset index is
`10000 + pairIndex`. Perp asset index is its position in the first-DEX metadata universe. Mainnet
and testnet identities never collide.

`szDecimals` defines the quantity step. `tickSize` is deliberately `0` (no universal static tick)
and the exact five-significant-figure/max-decimal rule is exposed in `priceRules`. Consumers must not
treat zero as “any price is valid”.

Executable bid/ask comes only from `l2Book`. Asset-context mid, mark and oracle values remain under
`referenceContext` with `executable: false`; `allMids` is not used because it can fall back to the
last trade for an empty book. REST books provide an exchange timestamp but no sequence, represented
explicitly as `sequence: 0` and `sequenceVerified: false`.

Every `l2Book` call names one coin. The adapter rejects bulk `tickers()` instead of turning one
public HTTP request into a many-book fan-out; callers use exact `ticker()`/`depth()` methods.

Perp `isDelisted` maps to a verified closed state. Spot metadata has no equivalent delist flag, so
universe membership is marked unverified. HIP-3 DEXs and outcome `#...` assets use different identity
models and are outside this first-DEX spot/perp adapter.

Funding uses the `HlPerp` entry from `predictedFundings` for the current estimate and exact next
settlement, plus bounded `fundingHistory`. The verified schedule is hourly. The prediction response
has no observation timestamp, so its timestamp source is explicitly local receive time.
