# Exchange adapters

`requestGuard.ts` is the shared signed-request safety boundary. HTTP 429/418 opens a bounded circuit
using `Retry-After`, preventing a bot from continuing to hammer an exchange. Binance `-1021` and
Bybit `10002` timestamp failures become explicit clock-skew errors instructing the operator to
synchronize the host before trading. Mutating calls are not automatically replayed.

This folder implements the `ExchangeAdapter` boundary for paper, Binance and Bybit execution.

## Modules

- `paper.ts`: deterministic local balance, position and resting-order simulator.
- `binance.ts`: Binance Spot and USDⓈ-M signed REST adapter.
- `bybit.ts`: Bybit v5 Spot and Linear signed REST adapter.
- `filters.ts`: venue filter loading, caching and deterministic tick/step rounding.
- `orderStatus.ts`: venue-status normalization into the durable journal state machine.
- `errors.ts`: explicit ambiguous transport-error classification.

## Safety rules

- Never blindly resubmit after a mutating network/5xx failure; return an ambiguous error so the journal becomes `unknown`.
- Treat definitive HTTP/API rejection as `rejected`.
- Require explicit exchange-side protection acknowledgement for protected live futures entries.
- Keep live spot fail-closed by default while inventory accounting remains experimental.
- Poll non-terminal live orders in bounded rotating batches when a private stream is unavailable.
- Prefer authenticated order/execution streams: Binance USDⓈ-M `ORDER_TRADE_UPDATE` with listenKey renewal, and Bybit v5 `order` + `execution` with HMAC auth and 20-second heartbeat.
- Reconcile through signed REST immediately on every private-stream disconnect/reconnect boundary before trusting subsequent events.

Every adapter change requires fake-transport tests for success, definitive rejection, ambiguous failure, identity correlation and status normalization.
