# Options parity research engine

This folder contains a transport-free European-options research simulator. It is intentionally disconnected from routes, accounts and execution.

## Supported candidates

- executable-side put-call parity deviations;
- conversion and reversal with a spot/underlying hedge;
- long and short boxes across two strikes;
- long and short synthetic forwards.

Every option pair must have exactly the same underlying, expiry, strike, strike asset, settlement asset and settlement process. A box may use two strikes, but both call/put pairs must still share underlying, expiry and settlement identity.

## Fail-closed inputs

The evaluator requires complete sorted bid/ask depth, native quantity steps, base-per-contract conversion, fresh timestamps, bounded inter-leg skew, explicit premium-to-valuation FX, explicit risk-free and dividend rates, fee models, European automatic-exercise/settlement assumptions, and verified margin capacity for every short option. Reversal additionally requires verified underlying borrow, margin capacity and an explicit borrow rate.

Two fee models are supported: notional bps and a per-base fee capped by a fraction of premium. The second form can represent venue option schedules such as Deribit's capped option fee without hard-coding a mutable exchange tariff.

## Output semantics

All output is labelled `edgeKind: "research-simulation"`, `simulationBasis: "visible-depth-taker"`, and `executable: false`. Conversion and box outcomes are labelled fixed only under the supplied hold-to-expiry and settlement assumptions. Put-call and synthetic-forward results explicitly state that they are parity diagnostics, not fixed profit without a hedge. Net edge bps use a named reference notional and are not presented as return on capital because portfolio margin is account-specific.
