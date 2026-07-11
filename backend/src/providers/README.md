# Market data providers

Providers normalize historical and live candles from Binance, Bybit and the deterministic synthetic source.

## Public API

`provider.ts` defines the provider contract. `router.ts` selects a provider, shares upstream subscriptions, caches windows and applies fallback policy.

## Invariants

- A complete `MarketKey` identifies venue, market type, price type, symbol and timeframe in trading contexts.
- Candles are ascending and normalized to the shared schema.
- Forming candles have `final: false` and are not persisted as closed history.
- Synthetic/fallback candles are visibly labeled and never used for live execution.
- A dynamic instrument without a valid seed price must not generate zero-valued fallback candles.
- One upstream stream may fan out to many subscribers and closes after the final listener leaves.

## Testing

Each provider needs REST normalization, WebSocket normalization, reconnect, timeout and rate-limit tests. The router needs cache, fallback, strict-mode and subscription fan-out coverage.
