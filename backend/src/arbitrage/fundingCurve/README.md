# Point-in-time funding curve

This folder exposes a credential-free, read-only research projection over the
normalized `PublicVenueAdapter.funding()` contract.

The service accepts at most eight explicitly selected perpetual instruments, a
bounded minute horizon and one to nine additive basis-point stress scenarios.
It emits current estimates, bounded history, verified discrete settlement
timestamps and rate-sum scenarios. Positive normalized rates mean longs pay
shorts. Rates are dimensionless decimals per settlement.

The curve deliberately does **not** calculate cash PnL. A valid cash projection
would also require an explicit position side, notional unit, reference-price
path and contract conversion. Those inputs are outside this public endpoint.
It never accepts credentials, account state or order instructions and every
response is `readOnly: true`, `researchOnly: true`, `executable: false`.

## Fail-closed rules

- only the exact `decimal-per-settlement` rate unit is accepted;
- only adapter-verified discrete schedules with a whole-minute interval are
  projected;
- the published `fundingTime`, `nextFundingTime` and interval must agree;
- stale, future-dated, malformed or identity-mismatched source observations are
  rejected per selection;
- a funding observation with a calibrated venue clock publishes its conservative
  corrected-local interval; a source that explicitly declares local receive time,
  or has no usable calibration, publishes a typed local-receipt fallback instead;
- comparing two or more successful venues is eligible only when every retained
  curve is calibrated and the worst possible corrected interval skew is within
  the request's `maxCrossVenueClockSkewMs`; otherwise `crossVenueClock` explains
  the fail-closed blocker and the browser does not calculate a funding gap;
- continuous/reference-horizon feeds such as the current Deribit adapter and
  inferred schedules such as the current dYdX adapter remain visible through
  their raw public funding endpoint, but are rejected by this discrete curve;
- a curve is capped at 512 settlement points, 500 history rows and 32 surfaced
  source errors.

The projection uses the current estimate at `fundingTime`, the optional next
estimate at `nextFundingTime`, then persists the latest point-in-time estimate.
This assumption is labelled in every projected settlement. Stress bumps are
not silently clamped to venue min/max bounds; the response counts boundary
violations instead.

## Current adapter scope

| Adapter | Funding surface used by the curve | Discrete projection status |
| --- | --- | --- |
| OKX | SWAP public current/history | accepted only when returned timestamps prove a whole-minute interval |
| Gate | USDT perpetual public current/history | accepted |
| Hyperliquid | perpetual prediction/history | accepted; local-receive timestamp provenance remains explicit |
| Kraken | inverse `PI_` perpetual current/history | accepted; other Kraken derivative funding scopes are not claimed |
| KuCoin | perpetual current/history | accepted |
| MEXC | perpetual current/history | accepted |
| Deribit | continuous accrual with an 8h reference rate | rejected as non-discrete |
| dYdX | next estimate with a locally inferred UTC-hour boundary | rejected as schedule-unverified |
| Coinbase | no normalized public perpetual funding capability | not called |

This list describes the adapters currently registered in
`publicVenueAdapters`; it is not a claim that every venue instrument or network
has been certified. The legacy Binance/Bybit scanner transports are outside
this unified adapter endpoint.

## Integration

Production injects the existing read-only venue-clock service; the handler itself
never probes a venue or performs clock I/O:

```ts
app.post(
  "/api/arbitrage/funding-curve",
  createFundingCurveHandler(
    new FundingCurveService(publicVenueAdapters, {
      clockCalibration: venueClockCalibration
    })
  )
);
```

The SDK method is `SaltanatArbitrageClient.fundingCurve(request, signal)`. The
request may set the bounded `maxCrossVenueClockSkewMs`; the HTTP boundary uses
`2000` when it is omitted.
