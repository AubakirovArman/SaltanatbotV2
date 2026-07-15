# Deribit public data and options-parity research

Status: current public adapter registered under `/api/market-data/deribit/*`; the pure parity engine
is exposed through the bounded `/api/arbitrage/options-parity/evaluate` HTTP route and public
TypeScript SDK, plus an EN/RU/KK browser scenario lab. Trading and private Deribit access are not
implemented.

## Public adapter

`backend/src/venues/deribit` provides a credential-free JSON-RPC adapter for futures, perpetuals and options. Its allowlist contains only instrument discovery, ticker/top book, order-book depth and perpetual funding history. The capability manifest always reports `privateExecution: false`.

Deribit exposes no bounded bulk executable-ticker method. Consequently `tickers()` is explicitly
unsupported; clients select one exact instrument and call `ticker()` or `depth()`. This prevents a
single anonymous HTTP request from creating an unbounded per-option JSON-RPC fan-out.

The transport checks HTTP and JSON-RPC independently: response size, timeout/caller abort, version `2.0`, exact request id, exactly one of `result`/`error`, known Deribit timing extensions, exchange errors and endpoint payload types. Unknown or contradictory envelopes are rejected.

Deribit quantity semantics are preserved instead of guessed:

- perpetual and inverse-future `amount` is quote/USD quantity;
- option and linear-future `amount` is base-asset quantity;
- `contract_size` is separate multiplier metadata;
- `qty_tick_size` is preferred as the native amount step, with an explicitly labelled `min_trade_amount` fallback;
- option premium asset, settlement asset, expiry, strike, call/put, European exercise and the linear future-then-immediate-cash settlement process remain explicit.

Deribit funding accrues continuously. The adapter exposes `funding_8h` as a reference estimate and hourly history, but deliberately keeps `scheduleVerified: false`: the eight-hour horizon is not represented as a fabricated discrete payment time.

## Options-parity engine

`backend/src/arbitrage/engines/optionsParity` is a pure research simulator for:

- put-call parity deviations;
- conversion and reversal;
- long/short boxes;
- long/short synthetic forwards.

It accepts only European call/put pairs with identical underlying, expiry, strike, strike asset, settlement asset and settlement process. A box uses two different strikes but otherwise requires identical expiry/settlement identity.

Candidate sizing walks executable bid/ask depth and rounds all legs to one base-equivalent quantity using native steps and explicit base-per-contract multipliers. Fees, premium FX, continuously compounded risk-free/dividend rates, exercise and delivery assumptions are caller-supplied and timestamped. Settlement cash flows are accepted only when `settlementAsset === valuationAsset`: the engine deliberately fails closed instead of silently applying a missing expiry FX conversion. Every short option requires verified availability and margin capacity; reversal also requires verified underlying borrow, capacity and borrow rate.

All candidates are permanently labelled `research-simulation`, `visible-depth-taker`, and `executable: false`. Fixed-payoff labels apply only under the supplied hold-to-expiry and settlement assumptions. Results do not claim risk-free profit, capital return or live executability.

## Public HTTP and SDK boundary

`POST /api/arbitrage/options-parity/evaluate` accepts one complete primary call/put series, an
optional complete second strike for boxes, one underlying book, a target base quantity and explicit
timestamped assumptions. Each book side is limited to 400 levels, assumption maps to eight entries,
pairing to 4–64 iterations, candidates to 16 and rejections to 64. Unknown fields—including API
keys, secrets and order-shaped data—are rejected by strict schemas. The response is `no-store` and
fixes `readOnly: true`, `researchOnly: true`, `executable: false` and `execution: "none"`.

The response repeats the caller-supplied assumption contract: exact instrument expiry; European,
automatic, hold-to-expiry cash-equivalent settlement; no settlement FX unless settlement and
valuation assets are equal; explicit premium FX; and explicit option/underlying fees. The SDK
`optionsParity()` method exposes the same request types and a strict runtime parser. It rejects
unknown fields, forged executable flags, invalid strategy/leg shapes, inconsistent PnL/fees/edge,
stale timestamp arithmetic and changed assumption-policy constants. Neither surface fetches account
data, accepts credentials or constructs orders.

## Browser scenario lab

**Screener → Options parity** exposes a lazily loaded scenario form for one European call/put pair
and its underlying. The user supplies exact top-book prices, strike, expiry horizon, base quantity,
short capacity, risk-free/dividend/borrow rates and fee assumptions. The browser builds the same
strict public request, labels every input as caller-supplied rather than live venue/account evidence,
and renders candidate economics, visible-depth legs and rejected shapes. It never stores the
scenario as an account entitlement and contains no order action. Component tests and Chromium E2E
cover request construction, crossed-book rejection, localized output and the real pure HTTP route.

## Verification

Recorded fixtures cover inverse BTC options, multiplier-based linear USDC options, inverse perpetuals, ticker/depth, continuous funding history and JSON-RPC exchange errors. Focused tests cover units, settlement metadata and settlement-FX rejection, id/envelope validation, timeout/abort, depth walking, fee caps, conversion/reversal/box/synthetic candidates, fail-closed stale/skewed/missing-leg cases, strict HTTP bounds and adversarial SDK response parsing.

Official sources used: [JSON-RPC protocol](https://docs.deribit.com/articles/json-rpc-overview), [errors](https://docs.deribit.com/articles/errors), [instruments](https://docs.deribit.com/api-reference/market-data/public-get_instruments), [ticker](https://docs.deribit.com/api-reference/market-data/public-ticker), [order book](https://docs.deribit.com/api-reference/market-data/public-get_order_book), [funding history](https://docs.deribit.com/api-reference/market-data/public-get_funding_rate_history), [inverse options](https://support.deribit.com/hc/en-us/articles/31424939096093-Inverse-Options), and [linear USDC options](https://support.deribit.com/hc/en-us/articles/31424932728093-Linear-USDC-Options).
