# Exchange adapters

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

Every adapter change requires fake-transport tests for success, definitive rejection, ambiguous failure, identity correlation and status normalization.
