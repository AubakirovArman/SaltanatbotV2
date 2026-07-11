# Trading domain

The trading domain owns bot lifecycle, strategy evaluation, risk checks, order execution, persistence, reconciliation and operator notifications.

## Current public surfaces

- `routes.ts`: authenticated HTTP/WS adapter.
- `engine.ts`: trading orchestration facade.
- `types.ts`: trading models.
- `exchange/`: paper, Binance and Bybit adapters.
- `strategy/`: temporary backend copy of IR/evaluator/TA.
- `store.ts`: SQLite persistence and encrypted settings.

## Safety invariants

- A bot processes market events serially and evaluates a closed bar at most once.
- Every order attempt has an idempotent client identifier and durable lifecycle events.
- Live entry is not considered protected until exchange-side protection is confirmed.
- Reconciliation completes before a resumed live bot can become running.
- Paper is the default; live requires explicit global and per-bot authorization.
- Incomplete spot inventory behavior remains feature-gated.
- Risk guards use confirmed fills and positions where available.

## Testing

Test every lifecycle transition, duplicate/out-of-order event, partial fill, protection rejection, timeout, restart phase and reconciliation mismatch. All exchange adapters must pass the same conformance suite.

## Planned decomposition

Split `engine.ts` into BotActor, lifecycle, market-event, strategy-runner, risk and reconciliation modules. Split order lifecycle/idempotency/protection from exchange adapters. Move shared IR/evaluator to `strategy-core`.
