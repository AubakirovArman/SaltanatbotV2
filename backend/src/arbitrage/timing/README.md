# Venue clock calibration

This folder contains the pure time-correction boundary used by cross-venue research. A server-time
probe is represented by local send/receive timestamps plus the venue timestamp and its resolution.
The model keeps the full possible offset interval (`venue time - local time`); it does not assume
symmetric network latency.

The narrowest non-expired RTT interval is widened by an explicit oscillator-drift allowance. A
clock is calibrated only after enough compatible samples and only while uncertainty stays below
policy. Slow probes are rejected, storage is bounded and missing/expired/degraded calibration fails
closed for timestamp eligibility.

`assessExchangeTimestamp` returns an age interval rather than a single invented age.
`assessCrossVenueSkew` compares the corrected local-time intervals and uses the worst possible skew
for eligibility. These are market-data quality checks, not execution authorization.

`scanner.ts` is the shared read-only scanner boundary. Cross-venue callers require two calibrated
intervals and compare their worst possible skew. Same-venue and single-observation callers may opt
into an explicit `local-receipt-fallback`; a calibrated timestamp that is stale or possibly in the
future is never silently downgraded to receipt time.

`VenueClockCalibrationService` probes the credential-free Binance, Bybit, OKX, Deribit, Kraken,
Coinbase, Gate, KuCoin and MEXC server-time endpoints through the same bounded-response and
cancellation primitives as the scanner. Refresh work is coalesced, slow probes cannot replace a
good sample, and each source retains its own health/error state. The one-second Kraken and Coinbase
timestamps may remain degraded under a tighter uncertainty policy; the service reports that state
instead of claiming precision those endpoints do not provide. Hyperliquid and dYdX are not assigned
invented venue clocks, so cross-venue evaluation involving them remains blocked until a reviewed
clock source exists. The public health response is diagnostic only and contains no account data.
