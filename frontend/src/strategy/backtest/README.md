# Backtest feature modules

This folder contains browser-side adapters around the runtime-neutral `@saltanatbotv2/strategy-core` evaluator.

- `execution.ts` orchestrates historical signal timing, fills, position lifecycle, funding and report assembly.
- `preview.ts` executes display statements and collects chart plots, markers, boxes, projections and metric tables.
- `broker.ts` owns slippage direction, protective-price resolution, sizing/margin guardrails and position hit/PnL primitives.
- `warmup.ts` performs exhaustive IR lookback analysis for the measured report window.
- `reporting.ts` builds evaluator context and bounded deterministic variable traces.
- `portfolio.ts` owns pure position opening/closing accounting and emitted trade records.
- Trading expression evaluation, mutable state, loops, operation budgets and intents belong to `strategy-core`.
- Historical fills, portfolio accounting and report assembly currently remain behind the stable `../backtest.ts` facade and are extracted incrementally.

Modules here must remain independent of React and Blockly. User-facing code imports the stable exports from `../backtest.ts`; direct module imports are reserved for focused tests and internal composition.

Preview and execution results expose the same StrategyBarTrace v1 intent events produced by `strategy-core`; fill/accounting trace extensions remain layer-specific roadmap work.
