# Market identity and catalog

This folder owns transport-neutral chart catalog data and the normalized instrument registry.

- `catalog.ts` is the user-facing chart catalog.
- `timeframes.ts` contains canonical timeframe and venue interval mappings.
- `dynamicCrypto.ts` refreshes public chart symbols without granting account authority.
- `instrumentRegistry.ts` caches venue metadata, filters and capability manifests by source.
- `instrumentRoutes.ts` exposes bounded read-only registry and capability snapshots. Instrument
  responses default to freshly verified rows; `includeStale=true` explicitly opts into retained
  catalog rows and always includes source receipt/check times and source errors.
- `economicAssetIdentity.ts` is the exact, versioned cross-venue economic-identity catalog. It
  maps only the explicitly reviewed BTC/ETH instrument IDs across native Binance/Bybit and the
  generic public venues; expiry-specific products, wrapped representations and unknown ticker
  strings remain unmapped. Registry assembly strips adapter-supplied identity assertions before
  applying this catalog, so a plugin cannot grant itself cross-venue identity authority.
- `networkIdentity/` separately owns exact chain/network-asset identity. Its server-owned atomic
  snapshot and public read-only API cover the reviewed Binance/Bybit BTC, ETH, Ethereum USDT and
  Ethereum USDC mappings only; public preflight uses server time and never accepts registry data,
  credentials, addresses or transfer authority from a caller.

The registry is metadata, not permission. Private execution must independently validate account
mode, current exchange filters, balances, risk limits and regional/product eligibility.
