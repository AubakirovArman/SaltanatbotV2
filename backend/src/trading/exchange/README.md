# Exchange adapters

`requestGuard.ts` is the shared signed-request safety boundary. HTTP 429/418 opens a bounded circuit
using `Retry-After`, preventing a bot from continuing to hammer an exchange. Binance `-1021` and
Bybit `10002` timestamp failures become explicit clock-skew errors instructing the operator to
synchronize the host before trading. Mutating calls are not automatically replayed.

This folder implements the `ExchangeAdapter` boundary for paper, Binance and Bybit execution.

## Modules

- `paper.ts`: deterministic local balance, position and resting-order simulator backed by the paper ledger.
- `paperExecution.ts`: verified executable-quote/liquidity checks and explicit slippage fallback.
- `binance.ts`: Binance Spot and USDⓈ-M signed REST code; the live Spot path is disabled until
  authenticated spot execution accounting exists, while USDⓈ-M remains experimental.
- `bybit.ts`: Bybit v5 Spot and Linear signed REST adapter.
- `bybitClient.ts`: shared Bybit v5 signing, transport ambiguity and request-budget boundary used by execution and UTA account services.
- `filters.ts`: venue filter loading, caching and deterministic tick/step rounding.
- `orderStatus.ts`: venue-status normalization into the durable journal state machine.
- `errors.ts`: explicit ambiguous transport-error classification.

## Safety rules

- Never blindly resubmit after a mutating network/5xx failure; return an ambiguous error so the journal becomes `unknown`.
- Treat definitive HTTP/API rejection as `rejected`.
- Require explicit exchange-side protection acknowledgement for protected live futures entries.
- When protection fails after an accepted entry, preserve the accepted entry outcome and reservation,
  pause automation, and report the best-effort reduce-only safety close independently. The safety
  close has a distinct `…-safety` client ID and must return its own venue order ID; a missing ID or
  rejection is an explicit failure, never a successful entry rollback.
- Preserve Binance entry/SL/TP order IDs; preserve the Bybit entry ID and typed position-level
  `trading-stop` acknowledgement because that endpoint exposes no individual SL/TP IDs.
- Disable Binance live spot until authenticated spot execution accounting exists. Keep Bybit spot
  experimental behind `ENABLE_LIVE_SPOT`; engine closes use confirmed bot-attributed inventory rather
  than account-wide balances.
- Require an explicit positive base `qty` on every risk-increasing live order. Keep durable
  reservations for accepted, partially filled and venue-filled-but-not-accounted journal rows;
  cancelled/expired rows retain unaccounted partial fills and legacy replaced rows stay conservative.
  Reserve attributed spot quantity for pending sells.
- Reject live `replace` and `turnover` on every market until each child cancel/close/new action has an
  independent durable lifecycle.
- Reconcile matching venue/local orders with maximum quantity/price and fail closed on identity, side
  or reduce-only conflicts. Futures risk also keeps a durable gross-exposure shadow while venue
  `positions()` can lag.
- Poll non-terminal live orders in bounded rotating batches when a private stream is unavailable.
- Prefer authenticated order/execution streams: Binance USDⓈ-M `ORDER_TRADE_UPDATE` with listenKey
  renewal, and Bybit v5 `order` + `execution` for enabled spot/linear bots with HMAC auth and a
  20-second heartbeat. Never treat the Binance futures stream as spot accounting.
- Reconcile through signed REST immediately on every private-stream disconnect/reconnect boundary before trusting subsequent events.
- Pause the bot when REST polling or reconnect reconciliation reports a terminal status without the
  authenticated execution required to release its durable reservation.
- Keep managed-position state when a live close is merely accepted, and pause until its authenticated
  execution is committed; only an accounted fill may clear the local position.
- Paper exits use verified executable price/capacity when supplied; insufficient verified liquidity
  leaves exposure unchanged. Funding is applied only from a verified settlement event.

Every adapter change requires fake-transport tests for success, definitive rejection, ambiguous failure, identity correlation and status normalization.
