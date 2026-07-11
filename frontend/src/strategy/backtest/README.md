# Backtest feature modules

This folder contains browser-side adapters around the runtime-neutral `@saltanatbotv2/strategy-core` evaluator.

- `preview.ts` executes display statements and collects chart plots, markers, boxes, projections and metric tables.
- `broker.ts` owns slippage direction, protective-price resolution, sizing/margin guardrails and position hit/PnL primitives.
- `warmup.ts` performs exhaustive IR lookback analysis for the measured report window.
- Trading expression evaluation, mutable state, loops, operation budgets and intents belong to `strategy-core`.
- Historical fills, portfolio accounting and report assembly currently remain behind the stable `../backtest.ts` facade and are extracted incrementally.

Modules here must remain independent of React and Blockly. User-facing code should import the stable exports from `../backtest.ts` until the decomposition is complete.
