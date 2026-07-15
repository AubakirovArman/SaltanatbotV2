# Trading domain

The trading domain owns bot lifecycle, strategy evaluation, risk checks, order execution, persistence, reconciliation and operator notifications.

## Current public surfaces

- `routes.ts`: authenticated HTTP/WS adapter.
- `engine.ts`: trading orchestration facade.
- `engineRuntime.ts`: in-memory bot/runtime state contracts.
- `engineAdapters.ts`: exchange/paper adapter construction and market routing.
- `tradingAccounts.ts`: public account capability truth and fail-closed bot binding checks.
- `tradingAccountStore.ts`: owner-scoped account metadata and encrypted per-account credential access.
- `credentialCrypto.ts`: AES-256-GCM envelope used by the tenant credential store.
- `ownership.ts`: authenticated owner resolution and namespaced settings.
- `tradeStreamHub.ts`: owner-partitioned private WebSocket fan-out.
- `engineTenantRuntime.ts`: owner-aware runtime/event/emergency partition inside the shared scheduler.
- `engineState.ts`: durable state, equity and evaluator-context helpers.
- `paperLedger.ts`: paper event contracts and deterministic replay reducer.
- `paperLedgerController.ts`: transition-to-event accounting, verified funding and atomic in-memory commit boundary.
- `paperLedgerStore.ts`: transactional, idempotent SQLite append/read operations.
- `paperRecovery.ts`: ledger-first startup with one-time legacy snapshot import.
- `enginePortfolio.ts`: cross-bot account aggregation without double counting.
- `engineOrderCoordinator.ts`: private streams, polling fallback, idempotent execution ingestion and restart reconciliation.
- `engineStopCoordinator.ts`: quiesce-and-drain shutdown across feeds, commands, events and exchange-order locks.
- `botRouteIdentity.ts`: runtime-first route authorization that prevents a persisted-mode downgrade while a bot is running.
- `engineRisk.ts`: pure position-sizing and stop/target resolution.
- `liveRisk.ts`: mandatory live-readiness limits and the final order/position/open-order preflight.
- `liveRiskReservations.ts`: bounded durable reservations that remain active until venue executions
  have been committed to local accounting.
- `emergencyStop.ts`: durable account-level stop/cancel/optional reduce-only flatten reconciliation and live-order gate.
- `emergencyStopRoutes.ts`: emergency HTTP validation, explicit flatten confirmation and re-arm policy.
- `bybitUta.ts`: normalized Unified Trading Account collateral/debt snapshot, hard borrow guards and explicit borrow/repay/collateral mutations.
- `../arbitrage/telemetry/`: live-trade-session, GET-only account economics telemetry. It reads only
  the caller's selected encrypted account credentials, exposes no credential material and remains separate from every order,
  borrow, repayment and transfer mutation.
- `../arbitrage/paperMultiLeg/`: authenticated `paper-trade`-role deterministic multi-leg plan,
  compensation, append-only journal and restart-recovery surface; it has no private exchange client.
- `spotInventory.ts`: versioned bot-attributed live-spot inventory and close constraints.
- `orderLifecycle.ts`: durable intent/result/fill transitions around exchange I/O.
- `orderEventIngest.ts`: venue/client identity resolution and idempotent snapshot ingest shared by polling and private streams.
- `startupOrderReconciliation.ts`: sequential signed-status proof for every crash-left in-flight journal row.
- `exchange/privateOrderStreams.ts`: authenticated Binance USDⓈ-M and Bybit v5 order/execution
  sockets, normalization, heartbeat, listenKey rotation and reconnect backoff. Bybit covers enabled
  spot/linear bots; the Binance stream is futures-only.
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
- Paper balance, position, orders and settings recover from contiguous append-only events; exact
  redelivery is a no-op and conflicting identity/sequence data fails closed.
- Paper funding requires a verified venue settlement and unique settlement ID; missing or estimated
  funding data never changes cash.
- Live entry is not considered protected until exchange-side protection is confirmed.
- Protected entries record their execution lifecycle and available entry/SL/TP exchange identities.
- If SL/TP setup fails after the venue accepted the entry, the entry remains accepted: managed state
  and its durable reservation are retained and the bot pauses. A best-effort reduce-only emergency
  close uses a distinct `…-safety` client identity and requires its own venue order ID; acceptance or
  failure is reported separately until authenticated executions account for both orders.
- Network/5xx failures and unreadable, truncated, malformed or identity-free HTTP 2xx responses during mutating exchange calls are classified as ambiguous and journaled `unknown`; definitive 4xx/API rejects remain `rejected`.
- Reconciliation completes before a resumed live bot can become running.
- The in-memory runtime configuration owns authorization while a bot is running; its persisted ID cannot be rewritten to downgrade the required role. Safe stop/delete quiesces feeds and drains command, event and order critical sections.
- `intent`, `unknown`, `accepted` and `partially_filled` rows must be proven by signed status or a matching open order; unproven and action-ambiguous outcomes pause the bot.
- Unresolved journal rows are matched by venue/client id; ambiguous absences pause trading for operator review.
- Live Binance/Bybit non-terminal orders use bounded, sequential signed-REST polling as a private-stream fallback.
- Connected private streams suppress periodic polling; disconnect and reconnect edges trigger an immediate signed-REST gap reconciliation.
- Replayed, duplicate, identity-conflicting and state-regressing exchange events never mutate a durable order.
- Paper is the default; live requires an owner-scoped arm plus explicit per-bot authorization.
- The authenticated session is the only source of trading ownership. Request fields cannot select
  another tenant, and foreign bot/account/order IDs fail as not found even for an application admin.
- Trading-account metadata is durable and owner-scoped. Every enabled Binance/Bybit account may
  hold its own AES-256-GCM credential envelope; its authenticated-data context binds owner, account
  and exchange, and no secret is serialized into an HTTP or WebSocket response.
- Account create/update/delete and credential rotation require `live-trade` access plus a secure
  trading origin. Running/bound robots block unsafe credential/account changes, while emergency
  cancellation remains available for disabled metadata.
- Bot lists, fills, logs, journals, audit rows, portfolio snapshots, emergency state, notifications
  and private trade events are owner-filtered. Permission changes revoke sessions, close that
  owner's private sockets and quiesce only that owner's runtimes.
- Database-auth notification channels are outbound-only. The inbound Telegram command poller stays
  disabled outside explicit legacy single-operator mode so it cannot bypass durable tenant roles.
- Emergency intent is persisted before exchange I/O; new live orders stay blocked until every requested account action is reconciled, and partial failures can never re-arm live trading.
- Every live bot has positive position, order, daily-loss and open-order caps; missing legacy caps block start/resume, and exits/cancels remain available.
- Live preflight binds every command to the bot's exact symbol/market, re-reads the venue price,
  reserves existing non-reduce orders and serializes preflight plus submit by
  account+market+symbol. Live starts are separately serialized by account+symbol so concurrent
  starts cannot race collision/reconciliation. Futures leverage must be acknowledged or exactly
  reconciled before an entry can reach the order endpoint.
- Every risk-increasing live order must contain an explicit positive base `qty`; quote/deposit and
  balance-percentage quantity forms cannot create live exposure.
- Durable risk reservations include accepted, partially filled and venue-filled-but-not-accounted
  journal rows. Cancelled/expired rows retain only their unaccounted partial fill; legacy replaced
  rows retain their entry quantity until accounting proves it. Spot sells reserve attributed quantity
  independently of spot-buy exposure.
- Futures preflight uses the larger of exact-symbol venue gross positions and the durable
  fill-accounted gross-exposure ledger, closing the interval where `positions()` lags a fill.
- A matched venue/local order contributes maximum quantity and price, not a duplicate sum or a
  trusted single copy. Multiple/duplicate identity matches, side conflicts and reduce-only conflicts
  fail closed.
- Binance live spot is disabled until authenticated spot execution accounting exists. Bybit spot
  remains experimental behind `ENABLE_LIVE_SPOT`, uses v5 order+execution accounting and confirmed
  bot-attributed inventory; account-wide balances never determine an automated bot close.
- Live `replace` and `turnover` are disabled for every market until each child cancel/close/new action
  has an independent durable lifecycle.
- One live bot owns an account+symbol across spot/futures; a live collision can never be bypassed by
  the start `override`.
- A terminal status obtained through REST polling/reconnect does not prove execution accounting. Any
  terminal unaccounted quantity pauses the bot for operator reconciliation.
- An accepted live close without an authenticated accounted fill leaves managed-position state
  intact and pauses the bot; an order acknowledgement alone never marks the position flat.
- Risk guards use confirmed fills and positions where available.
- Store startup migrates legacy schemas transactionally and refuses databases from a newer,
  unsupported application version.
- Schema v2 durably records orders, events, fills, current positions and logical strategy runs;
  schema v4 adds the paper event source; schema v5 adds account metadata and backfills legacy bot
  bindings; schema v6 assigns legacy rows to one explicit administrator and transactionally moves
  legacy exchange keys into owner/account-bound credential envelopes while disarming live trading.

## Testing

Test every lifecycle transition, duplicate/out-of-order event, partial fill, protection rejection, timeout, restart phase and reconciliation mismatch. All exchange adapters must pass the same conformance suite.

These deterministic gates do not establish mainnet readiness. The funded 7–14-day Binance/Bybit soak
is explicitly excluded from the current verified scope.

## Decomposition boundary

`engine.ts` remains the sub-600-line public BotActor/lifecycle coordinator. Order recovery, adapter
selection, portfolio reads, durable runtime state and risk calculations are independent modules;
order lifecycle/idempotency/protection remain separate from exchange adapters. Shared IR/evaluation
already lives in `strategy-core` behind the backend facade.
