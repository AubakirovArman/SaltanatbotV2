# Shared UI components

This directory currently contains both reusable terminal components and large feature screens.

## Current responsibilities

- shell controls: `TopBar`, `CommandPalette`;
- market/chart UI: `Watchlist`, `ChartCanvas`, `MultiChartWorkspace`,
  `DrawingObjectsPanel`, indicator and compare controls;
- shell accessibility: `PanelResizeHandle`, `ShortcutSettingsDialog` and the
  semantic `ChartDataPanel` fallback;
- strategy UI: `StrategyLab`, Pine import and backtest report;
- trading UI: `TradingView`.
- `chartCanvas/` owns focused drawing controls, overlays, pure interaction helpers and the stable facade prop contract.
- Embedded `ChartCanvas` instances use `compactChrome`; only the primary pane exposes global indicator editing, while local analysis remains available through the native `UTC · STRUCT` disclosure.

## Dependency rules

- Reusable components receive typed props and callbacks.
- They do not own API credentials, persistence schemas or compiler internals.
- Feature-specific state should move to `features/<feature>/model` hooks.
- Use native semantic elements before custom ARIA widgets.

## Testing

Test keyboard behavior, accessible names, error states and focus restoration for every interactive overlay. Canvas behavior also requires renderer and browser tests.

## Planned moves

`StrategyLab`, `PineImportDialog`, `BacktestReport` and the remaining `TradingView` controller will move into feature-owned directories. Trading access and bot-creation panels already live under `trading/components/`.
