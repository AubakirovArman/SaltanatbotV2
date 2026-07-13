# Trading domain

The trading domain owns bot lifecycle, strategy evaluation, risk checks, order execution, persistence, reconciliation and operator notifications.

## Current public surfaces

- `routes.ts`: authenticated HTTP/WS adapter.
- `engine.ts`: trading orchestration facade.
- `engineRuntime.ts`: in-memory bot/runtime state contracts.
- `engineAdapters.ts`: exchange/paper adapter construction and market routing.
- `engineState.ts`: durable state, equity and evaluator-context helpers.
- `enginePortfolio.ts`: cross-bot account aggregation without double counting.
- `engineOrderCoordinator.ts`: private streams, polling fallback, idempotent execution ingestion and restart reconciliation.
- `engineRisk.ts`: pure position-sizing and stop/target resolution.
- `bybitUta.ts`: normalized Unified Trading Account collateral/debt snapshot, hard borrow guards and explicit borrow/repay/collateral mutations.
- `spotInventory.ts`: versioned bot-attributed live-spot inventory and close constraints.
- `orderLifecycle.ts`: durable intent/result/fill transitions around exchange I/O.
- `orderEventIngest.ts`: venue/client identity resolution and idempotent snapshot ingest shared by polling and private streams.
- `startupOrderReconciliation.ts`: sequential signed-status proof for every crash-left in-flight journal row.
- `exchange/privateOrderStreams.ts`: authenticated Binance/Bybit order and execution sockets, normalization, heartbeat, listenKey rotation and reconnect backoff.
- `types.ts`: trading models.
- `exchange/`: paper, Binance and Bybit adapters.
- `strategy/`: temporary backend copy of IR/evaluator/TA.
- `store.ts`: SQLite persistence and encrypted settings.
- `storeSchema.ts`: ordered forward-only SQLite migrations and supported schema version.
- `storeLifecycle.ts`: database-independent position-snapshot and strategy-run transitions.

## Safety invariants

- A bot processes market events serially and evaluates a closed bar at most once.
- Every order attempt has an idempotent client identifier and durable lifecycle events.
- An adapter transport failure is persisted as `unknown`, never silently left as `intent`.
- Known outcomes distinguish accepted, partial, filled, cancelled, replaced, expired and rejected states.
- Private executions retain venue execution IDs, incremental fill price/quantity,
  actual commission asset and realized PnL; reconnect replays are deduplicated
  before fill/accounting persistence.
- Signed requests reserve proactive weight headroom and reconcile local budgets
  from Binance/Bybit headers before reactive 429/418 circuits are needed.
- Stale candles are rejected before mutating runtime price; missing intervals are
  logged as explicit market-data gaps.
- Resting paper orders retain venue/client identity so later tick fills advance the original journal row.
- Live entry is not considered protected until exchange-side protection is confirmed.
- Protected entries record their execution lifecycle and available entry/SL/TP exchange identities.
- A rejected SL or TP triggers a best-effort emergency close and a failed execution result.
- Network/5xx failures during mutating exchange calls are classified as ambiguous and journaled `unknown`; definitive 4xx/API rejects remain `rejected`.
- Reconciliation completes before a resumed live bot can become running.
- `intent`, `unknown`, `accepted` and `partially_filled` rows must be proven by signed status or a matching open order; unproven and action-ambiguous outcomes pause the bot.
- Unresolved journal rows are matched by venue/client id; ambiguous absences pause trading for operator review.
- Live Binance/Bybit non-terminal orders use bounded, sequential signed-REST polling as a private-stream fallback.
- Connected private streams suppress periodic polling; disconnect and reconnect edges trigger an immediate signed-REST gap reconciliation.
- Replayed, duplicate, identity-conflicting and state-regressing exchange events never mutate a durable order.
- Paper is the default; live requires explicit global and per-bot authorization.
- Live spot remains explicitly feature-gated and uses confirmed bot-attributed inventory; account-wide balances never determine an automated bot close.
- Risk guards use confirmed fills and positions where available.
- Store startup migrates legacy schemas transactionally and refuses databases from a newer,
  unsupported application version.
- Schema v2 durably records orders, events, fills, current positions and logical strategy runs.

## Testing

Test every lifecycle transition, duplicate/out-of-order event, partial fill, protection rejection, timeout, restart phase and reconciliation mismatch. All exchange adapters must pass the same conformance suite.

## Decomposition boundary

`engine.ts` remains the sub-600-line public BotActor/lifecycle coordinator. Order recovery, adapter
selection, portfolio reads, durable runtime state and risk calculations are independent modules;
order lifecycle/idempotency/protection remain separate from exchange adapters. Shared IR/evaluation
already lives in `strategy-core` behind the backend facade.
