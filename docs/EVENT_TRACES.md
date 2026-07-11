# Strategy event traces

SaltanatbotV2 emits a versioned, deterministic semantic trace for every evaluated candle. The canonical schema and normalizer live in `packages/strategy-core/trace.ts`.

## Version 1

Each `StrategyBarTrace` contains:

- `v: 1`;
- zero-based `barIndex`;
- source candle `barTime`;
- an ordered list of semantic intent events.

V1 events cover entry, exit, stop, target, trail, size, alerts, markers and execution-budget exhaustion. Non-finite numeric values are normalized to `null`, so every trace is safe to serialize as JSON. Event order is semantic and stable rather than dependent on object property order.

Preview, historical backtest and the backend evaluator used by paper/live bots all receive traces from the same `traceBarIntents()` normalizer. The checked-in `frontend/tests/strategyEventTrace.golden.json` fixture must match every path bar-for-bar.

## Versioning rules

- Do not change the meaning or ordering of an existing version.
- Additive optional metadata still requires compatibility tests.
- Breaking event changes require a new version and migration notes.
- Never include wall-clock timestamps, random identifiers, localized text or exchange secrets.
- Candle time/index, normalized numeric values and stable semantic identifiers are allowed.

## Remaining trace scope

V1 proves cross-runtime intent parity. A later trace version must add declared layer-specific events for expression explanations, variable changes, fill decisions, position/equity transitions, data provenance and warnings. Preview cannot invent fill events, so layer-specific differences must be explicit rather than forced into false equality.
