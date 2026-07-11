# Shared UI components

This directory currently contains both reusable terminal components and large feature screens.

## Current responsibilities

- shell controls: `TopBar`, `CommandPalette`;
- market/chart UI: `Watchlist`, `ChartCanvas`, indicator and compare controls;
- strategy UI: `StrategyLab`, Pine import and backtest report;
- trading UI: `TradingView`.

## Dependency rules

- Reusable components receive typed props and callbacks.
- They do not own API credentials, persistence schemas or compiler internals.
- Feature-specific state should move to `features/<feature>/model` hooks.
- Use native semantic elements before custom ARIA widgets.

## Testing

Test keyboard behavior, accessible names, error states and focus restoration for every interactive overlay. Canvas behavior also requires renderer and browser tests.

## Planned moves

`StrategyLab`, `PineImportDialog`, `BacktestReport` and `TradingView` will move into feature-owned directories. This directory will then contain only genuinely shared UI.
