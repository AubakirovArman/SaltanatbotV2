# Strategy domain

This directory owns strategy artifacts, Blockly definitions, compilation, research and the browser-side strategy runtime.

## Current public flows

```text
Blockly XML -> compileArtifact -> StrategyIR -> preview/backtest/optimizer
Pine source -> pine converter -> Blockly XML -> same flow
```

## Invariants

- No `eval`, `new Function` or arbitrary script execution.
- Unknown IR nodes fail closed.
- Backtest assumptions are explicit and reproducible.
- Frontend and backend interpretation must stay identical until they are replaced by canonical `strategy-core`.
- Display-only IR nodes (`plot`, drawings, projections and metrics) never create trading intents.
- Artifact schema/version/hash changes require migration handling.

## Boundaries

- `pine/` parses and lowers Pine; it should not own React UI.
- Blockly definitions describe editing; compiler modules lower blocks to IR.
- Backtest accounting does not depend on Blockly.
- `previewTables.ts` owns display-metric collection and table shaping; the broker loop must not depend on presentation models.
- `backtestTypes.ts` is the stable public contract; `backtestMetrics.ts` owns analytics derived from trades and equity.
- `candleHistory.ts` owns bounded, de-duplicated backward pagination shared by backtests, optimization and `request.security` loading.
- Storage and sharing are adapters around versioned artifacts.
- `components/StrategyLibrary.tsx` owns artifact browsing/import/export and template/Pine entry flows.
- `components/OptimizePanel.tsx` owns optimizer controls/results; `optimization/model.ts` owns sweep-state construction.
- `components/StrategyExecutionPanel.tsx` owns backtest configuration, execution actions, diagnostics and report/preview presentation.

## Testing

Every block needs compile and round-trip coverage. Every IR node needs frontend/backend parity fixtures. Backtest rules need boundary and invariant tests. See `docs/TESTING_STRATEGY.md`.

IR v4 adds explicit future projection zones and accessible metric tables. Both round-trip through Blockly and validate on the backend, while only the browser preview renders them.

## Planned decomposition

Move IR/evaluator/TA to `packages/strategy-core`, Pine to `packages/pine-compiler`, and fills/accounting/metrics to `packages/backtest-core`.
