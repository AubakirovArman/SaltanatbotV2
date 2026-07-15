# Gate public REST adapter

`GatePublicAdapter` is a credential-free Gate API v4 integration exposed by the bounded public
market-data facade. It deliberately has no `/api/instruments`, live-scanner, chart UI or
private-execution wiring.

## Implemented scope

- SPOT and USDT-settled perpetual instrument metadata;
- executable perpetual all/single top book and SPOT single-instrument top book with both prices and
  sizes;
- complete REST depth snapshots, bounded to 1–100 levels per side;
- current perpetual funding estimate, verified next schedule and bounded settled history;
- structured timeout, caller-cancellation, rate-limit, HTTP, exchange, validation and unsupported
  errors, with a 2 MiB response ceiling.

`adapter.ts` owns transport and endpoint routing, `normalize.ts` owns strict semantic conversion,
`types.ts` contains deliberately loose native response shapes, and `index.ts` is the local public
export. The adapter sends only anonymous `GET` requests with `Accept: application/json`; its
capability manifest keeps private execution, account data, borrowing and transfers false.

## Units and fail-closed rules

SPOT prices and quantities use quote/base units respectively. `precision` and `amount_precision`
become `10^-precision` price ticks and `10^-amount_precision` quantity steps. Null minimum values
become `0`, the shared contract's explicit marker for unknown—not proof that no limit exists.

USDT perpetual book/order sizes are contracts. `quanto_multiplier` is preserved as the effective
base-asset amount represented by one contract, `order_price_round` is the tick, and integer contract
products use a quantity step of one. Gate exposes whether decimal contract size is enabled but does
not expose a separate decimal quantity increment in the public contract schema. Such rows are
therefore quarantined instead of inventing a lot step. Perpetual `minimumNotional: 0` is likewise
unknown and must be resolved by an execution-grade rule source before order placement.

Only `direct` contracts from the `/futures/usdt/*` namespace are accepted. An optional
`settle_currency` must agree with USDT. Unknown status/direction, inconsistent base/quote, invalid
tick/lot/minimum, crossed top book, unsorted/crossed depth, missing sizes, sequence or schedule are
rejected. One-sided SPOT statuses are normalized as non-trading (`settling`) so generic execution
cannot treat them as fully tradable.

The filtered SPOT ticker includes `lowest_size`/`highest_size`, but the current unfiltered response
omits both fields. `tickers("spot")` is therefore explicitly unsupported: the adapter will neither
publish non-executable quotes nor fan out thousands of single-symbol calls. The coarse capability
manifest keeps `topBook: true` because SPOT single and perpetual all/single are implemented; callers
must respect the operation-level error.

## Time and funding

Order-book `update` is preserved as exchange time (milliseconds for SPOT, seconds converted to
milliseconds for perpetuals). Gate ticker and contract-funding responses do not include a source
timestamp, so `exchangeTs` explicitly falls back to local receipt time. Consumers that require
exchange-authored event time must not treat those two snapshots as timestamp-authoritative.

The current funding rate applies at `funding_next_apply`; the following settlement is derived only
when `funding_interval` is a positive whole-minute interval no longer than 24 hours. History rows
are settled values and keep their native timestamps. A current-contract failure rejects funding;
history-only failure preserves the current schedule and records a source error.

Recorded fixtures under `backend/tests/fixtures/gate` make no live calls. See the canonical
operational notes in [Gate public adapter](../../../../docs/GATE_PUBLIC_ADAPTER.md).

Official references: [Gate API v4 access and changelog](https://www.gate.com/docs/developers/apiv4/en/)
and [Gate perpetual futures API](https://www.gate.com/docs/developers/apiv4/en/futures/).
