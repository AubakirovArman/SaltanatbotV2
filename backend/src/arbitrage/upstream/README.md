# Arbitrage upstream market data

This folder owns the shared public WebSocket feeds used by the arbitrage screener. Binance Spot
deliberately subscribes to `@ticker`, whose payload has venue event time plus current best bid/ask,
rather than the timestamp-less Spot `@bookTicker`; Binance Futures still uses `@bookTicker`.

- `binance.ts` parses timestamped Spot `ticker` and USD-M `bookTicker` streams.
- `bybit.ts` parses V5 spot/linear ticker streams and respects the 10-topic spot request limit.
- `socket.ts` centralizes heartbeat, bounded payloads and exponential reconnect.
- `index.ts` guarantees one process-wide upstream connection per exchange/market, shared by all
  connected browsers and persistent alert consumers.
- `l2/` owns the independent on-demand strict-book path. Binance Spot and USD-M bridge diff-depth
  against REST with their distinct sequence rules; Bybit Spot and Linear rebuild from the V5
  WebSocket snapshot/delta lifecycle. A gap or reconnect withdraws the previous book.
- `publicFeeds/` owns the isolated OKX/Gate/Hyperliquid/Deribit research layer. OKX, Gate and
  Deribit publish protocol-sequenced reconstructed books; Hyperliquid is explicitly retained as an
  atomic full-snapshot signal because `WsBook` has no continuity sequence. The bounded discovery
  bridge feeds route-family candidates but never invents account or horizon assumptions.
- `resourceGovernor/` owns named process-wide REST budgets, queue-free overload rejection,
  cooldown/circuit state and credential-free health counters. The basis REST scanner, depth REST
  fallback and generic public venue facade share these budgets; other public scanners can use the
  same boundary instead of multiplying concurrency per HTTP surface.

REST scanning remains the ticker bootstrap and bounded fallback. REST-only depth is explicitly
unverified and cannot make a depth result complete. No API key, private account channel or order
endpoint is used here.
