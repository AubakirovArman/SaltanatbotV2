# Strategy event traces

SaltanatbotV2 emits a versioned, deterministic semantic trace for every evaluated candle. The canonical schema and normalizer live in `packages/strategy-core/trace.ts`.

## Version 1 compatibility

Each `StrategyBarTrace` contains:

- `v: 1`;
- zero-based `barIndex`;
- source candle `barTime`;
- an ordered list of semantic intent events.

V1 events cover entry, exit, stop, target, trail, size, alerts, markers and execution-budget exhaustion. Non-finite numeric values are normalized to `null`, so every trace is safe to serialize as JSON. Event order is semantic and stable rather than dependent on object property order.

The checked-in `frontend/tests/strategyEventTrace.golden.json` fixture preserves this semantic V1 projection for compatibility.

## Version 2

V2 retains V1 event meaning and ordering, then adds:

- statement-path explanations for evaluated conditions, values and loop bounds;
- expression kind, final result and evaluation count without evaluating an expression twice;
- `trueCount` for repeatedly evaluated boolean expressions;
- alphabetically ordered per-bar variable changes with before/after values;
- explicit truncation flags and 256-item per-bar bounds for explanations and variable changes.

Preview, historical backtest and the backend evaluator used by paper/live bots all receive the same complete V2 trace from the canonical evaluator. Cross-runtime tests compare the full explanation and variable-change payload bar-for-bar while also checking the V1 semantic golden.

## Versioning rules

- Do not change the meaning or ordering of an existing version.
- Additive optional metadata still requires compatibility tests.
- Breaking event changes require a new version and migration notes.
- Never include wall-clock timestamps, random identifiers, localized text or exchange secrets.
- Candle time/index, normalized numeric values and stable semantic identifiers are allowed.

## Remaining trace scope

Strategy V2 proves cross-runtime intent, explanation and variable-change parity. Historical execution additionally emits `BacktestExecutionTrace` v1 from `packages/backtest-core/executionTrace.ts`. Its stable events cover scheduled/dropped fills, rejected entries, position open/close transitions with equity, funding charges, warning codes and a final provenance snapshot. Preview cannot invent fill events, so layer-specific differences stay explicit rather than being forced into false equality.
