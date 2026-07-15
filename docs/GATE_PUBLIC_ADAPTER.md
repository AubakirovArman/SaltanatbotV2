# Gate public REST adapter

Status: current credential-free adapter exposed through `/api/market-data/gate/*`, reviewed against
Gate API v4 and public responses on 2026-07-14. It is not part of `/api/instruments`, the live
scanner/chart UI or private trading.

## Safety boundary and endpoints

The adapter accepts no credentials and makes public read-only `GET` requests only.

| Normalized operation | Gate API v4 endpoint | Scope |
| --- | --- | --- |
| Instruments | `GET /api/v4/spot/currency_pairs` | SPOT |
| Instruments | `GET /api/v4/futures/usdt/contracts` | direct USDT perpetual |
| Single executable top book | `GET /api/v4/spot/tickers?currency_pair=...` | SPOT |
| All/single executable top book | `GET /api/v4/futures/usdt/tickers` | USDT perpetual |
| Complete bounded depth | `GET /api/v4/spot/order_book` | SPOT, 1–100 levels |
| Complete bounded depth | `GET /api/v4/futures/usdt/order_book` | USDT perpetual, 1–100 levels |
| Current funding and schedule | `GET /api/v4/futures/usdt/contracts/{contract}` | USDT perpetual |
| Settled funding history | `GET /api/v4/futures/usdt/funding_rate` | USDT perpetual, 1–100 rows |

Gate added `lowest_size` and `highest_size` to SPOT tickers in API v4.84. The filtered single-pair
response currently returns them, while the unfiltered all-pairs response omits them. The adapter
therefore supports executable SPOT `ticker()` but returns `unsupported` for SPOT `tickers()`; it
does not publish non-executable quotes or create a roughly 2,000-request fan-out. Perpetual
all/single tickers both include sizes. Any missing/zero size is rejected rather than presented as
actionable liquidity. The shared capability manifest is coarse and keeps `topBook: true`; consumers
must still handle this operation-level SPOT limitation.

The default origin is `https://api.gateio.ws`. A test or regional deployment can inject another
HTTP(S) origin, but credentials, path, query and fragment in `baseUrl` are rejected. No API-key,
signature, account, order, borrow or transfer headers/code exist in the adapter.

## Instrument normalization

### SPOT

- native `id` remains `venueSymbol`, with base/quote consistency checked;
- price tick is `10^-precision`; base quantity step is `10^-amount_precision`;
- `min_base_amount` becomes minimum quantity and `min_quote_amount` becomes minimum notional;
- a null minimum becomes `0`, which means unknown in the shared registry contract;
- `tradable` maps to trading, `untradable` to closed, and one-sided `buyable`/`sellable` to a
  non-trading state so a generic executor cannot assume both sides are permitted.

### USDT perpetual

- only `direct` contracts from the `usdt` settlement namespace are accepted as linear;
- optional `settle_currency`, if returned, must equal `USDT`;
- quantities are contracts, while `quanto_multiplier` records base units represented by one
  contract and is retained as both `contractMultiplier` and native `contractValue`;
- `order_price_round` is the tick, `order_size_min` is the minimum contract quantity;
- integer-sized contracts have `quantityStep: 1`;
- `minimumNotional: 0` means the public contract response did not establish an execution-grade
  notional floor.

Gate's public contract schema says `enable_decimal=true` permits a decimal `size`, but it does not
publish a separate decimal quantity increment. Guessing from the minimum or multiplier could admit
invalid orders, so those instrument rows are quarantined until Gate exposes an authoritative lot
step or a separate execution-rules source is added.

Current `status` and `in_delisting` are both checked. Prelaunch, delisting, delisted and circuit
breaker states are never defaulted to trading. Unknown enum values, direction, settlement, tick,
lot, minimum or asset structure fail closed.

## Market data and time semantics

Ticker rows must contain finite positive bid/ask prices and sizes with `bid < ask`. Volume fields
retain native quantity semantics: base quantity on SPOT and contract quantity on perpetuals, plus
quote-currency volume when supplied.

Depth requests force `interval=0` and `with_id=true`. Both non-empty sides, sorting, non-crossing,
positive levels, a safe sequence ID and the requested maximum level count are validated. SPOT
`update` is already milliseconds; perpetual `update` is seconds and is converted to milliseconds.

Gate ticker rows and the single-contract funding response contain no exchange-authored response
timestamp. Their normalized `exchangeTs` is therefore the local `receivedAt` fallback. This is
explicitly less authoritative than order-book `update`; latency-sensitive consumers must preserve
that distinction and must not infer clock quality that Gate did not provide.

## Funding semantics

`funding_rate` is the current estimate for the settlement at `funding_next_apply`. The next schedule
point is computed by adding `funding_interval` only when the interval is a positive whole number of
minutes no longer than 24 hours; otherwise the current result is rejected as unverifiable.
Deprecated `funding_rate_indicative`, when present, is retained as the next estimate rather than
silently replacing the current rate.

Historical `{t, r}` rows are settled funding points; `r` is retained as both displayed and realized
rate and the rows are sorted chronologically. Failure of current contract metadata rejects the
funding request. A history-only transport or validation failure preserves current funding and is
reported in `sourceErrors`.

## Transport and validation guarantees

- finite timeout and caller `AbortSignal` propagation on every request;
- separate `timeout`, `cancelled`, `rate-limit`, `http`, `exchange`, `validation` and `unsupported`
  error kinds;
- Gate `{label,message,detail}` error parsing and HTTP 429 classification;
- 2 MiB ceiling checked from `Content-Length` and actual UTF-8 body size;
- successful direct array/object shape validation;
- row quarantine only when at least one valid row remains; empty or wholly invalid snapshots fail;
- capability manifest advertises SPOT, perpetual, top book, depth and funding only, with
  `privateExecution: false`.

Recorded public fixtures cover metadata, SPOT single and perpetual all/single top book, both depth shapes, current/history
funding, malformed/crossed data, unknown lot rules, error envelopes, payload limits, timeout and
cancellation without live network access.

## Deferred deliberately

- normalized `/api/instruments` inclusion, live scanner/WebSocket aggregation and chart UI;
- WebSocket diff books, checksum/gap recovery and reconnect state machine;
- margin, delivery futures, options, public trades and native spreads;
- account reads, borrowing, transfers and private execution;
- regional eligibility policy and a production public-data canary.

Official sources: [Gate API v4 general/access/changelog](https://www.gate.com/docs/developers/apiv4/en/),
[Gate perpetual futures API](https://www.gate.com/docs/developers/apiv4/en/futures/), and the
[official Gate API v4 SDK repository](https://github.com/gateio/gateapi-nodejs).
