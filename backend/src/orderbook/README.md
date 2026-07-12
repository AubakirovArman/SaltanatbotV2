# Public order-book domain

This folder owns public Binance/Bybit depth ingestion and the shared browser-facing snapshot stream.

- `binance.ts` consumes Binance Spot top-20 partial depth snapshots at 100 ms.
- `bybit.ts` applies Bybit V5 level-50 snapshots/deltas to `localBook.ts`, then emits the top 20 rows.
- `hub.ts` shares one upstream per exchange/symbol, caps browser publication at four snapshots per second and closes the upstream after the last listener leaves.
- `types.ts` contains connector boundaries and strict raw-level parsing.

Invariants:

- No synthetic order book is ever generated.
- A Bybit delta is never exposed before a complete snapshot.
- A replacement snapshot resets all prior Bybit levels.
- Zero-sized delta rows remove levels and never cross the public contract.
- Browser messages are bounded to 20 bids and 20 asks.
- Active upstream books are capped globally and slow browser clients are disconnected before their send buffer grows without bound.
- Reconnect/stale/error states remain explicit; stale liquidity must not be presented as live.
