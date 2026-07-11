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

Strategy V1 proves cross-runtime intent parity. Historical execution additionally emits `BacktestExecutionTrace` v1 from `packages/backtest-core/executionTrace.ts`. Its stable events cover scheduled/dropped fills, rejected entries, position open/close transitions with equity, funding charges, warning codes and a final provenance snapshot. Non-finite numbers normalize to `null`.

Expression explanations and compact variable-change events remain future trace scope. Preview cannot invent fill events, so layer-specific differences stay explicit rather than being forced into false equality.
