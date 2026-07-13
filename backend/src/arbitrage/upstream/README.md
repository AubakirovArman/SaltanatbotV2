# Arbitrage upstream market data

This folder owns the shared public WebSocket feeds used by the arbitrage screener.

- `binance.ts` parses and subscribes to individual spot and USD-M `bookTicker` streams.
- `bybit.ts` parses V5 spot/linear ticker streams and respects the 10-topic spot request limit.
- `socket.ts` centralizes heartbeat, bounded payloads and exponential reconnect.
- `index.ts` guarantees one connection per exchange/market for every connected browser.

REST scanning remains the bootstrap and bounded fallback. No API key, private account channel or
order endpoint is used here.
