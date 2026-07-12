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
- `topbar/` owns extracted top-bar controls with self-contained keyboard contracts; layout actions remain callback-driven and do not reach into shell persistence.
- Embedded `ChartCanvas` instances use `compactChrome`; the primary exposes canonical indicator editing, while a maximized secondary exposes its linked or independent bounded override set. Local analysis remains available through the native `UTC · STRUCT` disclosure.
- Linked secondary compare overlays reuse the primary `CompareSeriesState`; only an independently edited pane owns a local refresh hook. Compare controls appear in maximized secondary panes and persist bounded configuration through `WorkspaceChart`.
- `useAppShell` owns the transient active pane so top-bar controls, command-palette actions and timeframe shortcuts target the focused chart. `MultiChartWorkspace` owns transient maximize state plus DOM focus routing for customizable previous/next-pane shortcuts. Hidden siblings stay mounted, preserving streams and view state; cycling a maximized chart pages the visible sibling and secondary charts switch back to full drawing and indicator chrome.
- The active secondary pane publishes its existing typed market-stream snapshot to the shell for watchlist, feed status, statistics and alert context. Inactive panes keep their chart-local streams mounted but do not trigger shell-wide snapshot updates.

## Dependency rules

- Reusable components receive typed props and callbacks.
- They do not own API credentials, persistence schemas or compiler internals.
- Feature-specific state should move to `features/<feature>/model` hooks.
- Use native semantic elements before custom ARIA widgets.

## Testing

Test keyboard behavior, accessible names, error states and focus restoration for every interactive overlay. Canvas behavior also requires renderer and browser tests.

## Planned moves

`StrategyLab`, `PineImportDialog`, `BacktestReport` and the remaining `TradingView` controller will move into feature-owned directories. Trading access and bot-creation panels already live under `trading/components/`.
