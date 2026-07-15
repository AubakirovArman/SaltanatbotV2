# Backtest feature modules

This folder contains the browser preview and compatibility exports for the runtime-neutral strategy and backtest packages.

- `execution.ts` preserves the browser import path while re-exporting the canonical historical runner from `@saltanatbotv2/backtest-core`.
- `preview.ts` executes display statements and collects chart plots, markers, boxes, projections and metric tables.
- `broker.ts`, `warmup.ts`, `reporting.ts` and `portfolio.ts` preserve compatibility paths for their runtime-neutral `backtest-core` implementations.
- Trading expression evaluation, mutable state, loops, operation budgets and intents belong to `strategy-core`.
- Historical execution remains behind the stable `../backtest.ts` facade; the runner and report assembly both belong to `backtest-core` so browser workers and server workers execute the same code.
- Every assembled report includes chart and `request.security` requested/resolved/unresolved provenance from `backtest-core`; incomplete, synthetic, fallback, mixed or unknown inputs invalidate performance claims in the UI.

Modules here must remain independent of React and Blockly. User-facing code imports the stable exports from `../backtest.ts`; direct module imports are reserved for focused tests and internal composition.

Preview and execution expose the same StrategyBarTrace v2 intents, bounded statement explanations and variable diffs produced by `strategy-core`; historical fill/accounting events use the layer-specific BacktestExecutionTrace v1 contract.
