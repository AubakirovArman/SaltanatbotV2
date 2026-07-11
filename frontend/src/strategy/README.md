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
- Artifact schema/version/hash changes require migration handling.

## Boundaries

- `pine/` parses and lowers Pine; it should not own React UI.
- Blockly definitions describe editing; compiler modules lower blocks to IR.
- Backtest accounting does not depend on Blockly.
- Storage and sharing are adapters around versioned artifacts.

## Testing

Every block needs compile and round-trip coverage. Every IR node needs frontend/backend parity fixtures. Backtest rules need boundary and invariant tests. See `docs/TESTING_STRATEGY.md`.

## Planned decomposition

Move IR/evaluator/TA to `packages/strategy-core`, Pine to `packages/pine-compiler`, and fills/accounting/metrics to `packages/backtest-core`.
