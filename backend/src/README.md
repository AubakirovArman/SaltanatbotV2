# Backend source

The backend composes public market data, authenticated trading APIs, WebSocket streams, persistence and execution adapters.

## Entry point

`server.ts` is the composition root. It should wire modules rather than accumulate domain behavior.

## Boundaries

- Public request/response contracts should move to `packages/contracts`.
- Trading domain logic must not depend on Express request objects.
- Market/exchange adapters implement explicit ports.
- SQLite access stays behind stores/repositories.
- Live trading paths fail closed and never consume synthetic fallback data.
- Public arbitrage discovery stays read-only and compares executable bid/ask prices rather than last trades.

## Invariants

- Loopback is the default bind.
- Trade mutations require role authorization and CSRF in browser sessions.
- API-key storage and risk-increasing live/account mutations require TLS, a direct loopback socket or the explicit development override; proxy headers are trusted only through `TRUST_PROXY`.
- WebSocket trade access uses short-lived one-use tickets.
- Secrets are encrypted at rest and redacted from audit data.
- Shutdown preserves resumable desired bot state and closes subscriptions.
- Non-paper bots require positive position/order/daily-loss/open-order caps and pass a server-side preflight immediately before live execution.

## Tests

Use pure unit tests, fake provider/exchange integration tests, API contract tests and recovery scenarios. Real testnet checks are opt-in release gates.
