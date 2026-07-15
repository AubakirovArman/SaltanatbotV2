# Sequence-verified arbitrage L2

This directory is the credential-free, public market-data boundary for reconstructed arbitrage
books. It does not submit orders and is deliberately separate from private execution adapters.

## Guarantees

- A published book always starts from an authoritative snapshot and has
  `sequenceVerified: true` as a literal contract.
- Any detected gap, malformed depth message, crossed/locked book, buffer overflow, socket close or
  reconnect immediately invalidates the previous book. It is never reused during resynchronization.
- Price maps, bootstrap events, payload bytes, active books and waiting callers all have hard bounds.
- `exchangeTs` is venue-provided. Binance Spot uses diff-event `E`; Binance USD-M and Bybit prefer
  matching-engine `T` / `cts` and otherwise retain the venue event time with explicit provenance.
- A reconnect creates a new generation and aborts an in-flight snapshot from the old socket.
- Live books are not copied into the REST depth cache. The depth service checks the hub's
  generation/sequence lease immediately before releasing a two-leg result, so an intervening gap
  fails the request instead of serving the prior generation.

## Venue protocols

Binance Spot opens the diff-depth stream before requesting the REST snapshot. Buffered events at or
below `lastUpdateId` are discarded, the first retained event must cover `lastUpdateId + 1`, and a
later `U > localUpdateId + 1` is a gap.

Binance USD-M Futures uses its distinct rule: the first event must cover the REST
`lastUpdateId`; after that every event must have `pu === previous u`. Spot and Futures are not
handled by one guessed successor rule.

Bybit Spot and Linear use the V5 WebSocket snapshot sent after subscription, then absolute-quantity
deltas. A new snapshot replaces the complete local book. Per-book `u` must be contiguous and the
cross-product `seq` must advance, but is not required to increment by one. Bybit REST `u` only maps
to the 1000-level stream, so this bounded level-200 feed does not pretend that an independently
fetched REST level-200 snapshot can bridge it.

The hub is on-demand and bounded. It retains an idle feed only briefly so depth requests close in
time can share the same reconstruction.

Official protocol references:

- [Binance Spot diff-depth and local-book procedure](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- [Binance USD-M local-book procedure](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)
- [Bybit V5 WebSocket orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook)
- [Bybit V5 REST orderbook mapping](https://bybit-exchange.github.io/docs/v5/market/orderbook)
