# Continuous public-feed fixtures

These deterministic JSON messages are schema fixtures adapted from the official public WebSocket
documentation for OKX `books`/`funding-rate`, Gate `spot.obu` and futures channels, Hyperliquid
`l2Book`/`activeAssetCtx`, and Deribit `book`/`ticker` subscriptions. They are deliberately small
and use synthetic prices and sequence IDs so tests can inject gaps and malformed updates without
depending on live market state.

They are protocol-conformance fixtures, not proof of current production connectivity. The optional
credential-free canary script is the separate, time-stamped connectivity check.

Kraken Spot fixtures follow the official v2 book/checksum algorithm and retain decimal strings;
Kraken Futures fixtures follow the separately versioned v1 `book` feed. Coinbase fixtures use the
Advanced Trade `level2` and `heartbeats` schemas—never `market_trades` as an order book—and start
the production-observed connection-global envelope sequence at zero.
