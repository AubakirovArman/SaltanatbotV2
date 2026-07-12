# Chart domain

The chart domain owns coordinate systems, viewport state, indicator calculations, drawings and Canvas rendering.

## Public surface

- `ChartEngine.ts`: current rendering facade.
- `types.ts`: chart render models.
- `viewport.ts` and `scales.ts`: coordinate transforms.
- `drawings.ts` and `objects/`: drawing behavior and hit testing.
- `renderers/`: primitive rendering layers.
- `useChartArtifactOverlay.ts`: cancellable artifact compilation, external-series loading, preview/backtest overlay state, input overrides and chart focus.
- `dirtyLayers.ts`: requestAnimationFrame invalidation scheduler with deterministic base-before-interaction ordering.
- `useChartRenderer.ts`: five-canvas ownership, ResizeObserver synchronization, render-plan reuse and dirty-pass invalidation.
- `renderers/chartChrome.ts`: axes, grid, last-price and crosshair chrome.
- `renderers/candles.ts`: solid and hollow candle bodies with DPR-safe pixel alignment.
- `renderers/lineArea.ts`: line, step-line and filled area primitives.
- `volumeProfile.ts` and `renderers/volumeProfile.ts`: visible-range volume-at-price calculation, POC/value-area selection and Canvas rendering.
- `orderBookHeatmap.ts`: screen-row aggregation, notional intensity and spread math for real depth frames.
- `../components/chartCanvas/OrderBookHeatmapLayer.tsx`: independently scheduled Canvas/WebSocket layer with 60-second history, stale detection and background-tab pausing.
- `tradeFootprint.ts`: pure candle/price-row aggregation and quote-notional delta math for real public prints.
- `footprintInsights.ts`: pure diagonal-imbalance, stacked-cluster and explicitly provisional absorption heuristics with documented thresholds.
- `microstructureAlerts.ts`: pure candidate rules and strict persisted-setting validation for stack, absorption, CVD and large-print alerts.
- `microstructureAlertStore.ts`: fail-soft browser-only persistence for validated alert preferences.
- `renderers/footprintInsights.ts`: Canvas outlines, stack brackets and `ABS?` markers; the synchronized semantic counts stay in DOM.
- `../components/chartCanvas/TradeFootprintLayer.tsx`: isolated Canvas/WebSocket footprint and cumulative-delta layer with bounded retention and off-screen suspension.
- `../components/chartCanvas/ChartPriceHud.tsx`: DOM current-price/countdown pill and crosshair OHLC HUD.
- `../components/ChartDataPanel.tsx`: bounded semantic tables for the focused OHLC candle, recent candles, strategy signals and executed trades.
- `drawingTemplates.ts`: validated local drawing-style templates consumed by
  the object tree; visibility, locking, undo and redo stay owned by `ChartCanvas`.
- Native indicators can use the price pane or an independent pane with
  left/right/hidden scale labels.
- `../i18n/chart.ts`: typed English/Russian chart-table messages, dynamic captions and domain terms.

## Invariants

- Candle time order is ascending.
- Time/price coordinate transforms remain reversible within rendering precision.
- Pointer-only behavior must have a documented keyboard or UI alternative.
- Canvas information remains available through real DOM; the canvas description points to the synchronized chart-data summary.
- The one-second candle countdown updates only its DOM overlay and never invalidates Canvas render passes.
- Volume Profile geometry is prepared with the viewport and remains unchanged during crosshair-only interaction paints.
- High-frequency depth updates paint only the heatmap Canvas; they do not enter `ChartCanvas` React state or invalidate candle/indicator passes.
- High-frequency public trades paint only the footprint Canvas; reconnects begin a new observation window instead of drawing invented history across a data gap.
- Footprint insight rows are screen-price buckets and may change with zoom. They use only the post-activation observation window and must remain labelled as heuristics rather than exchange-authored signals.
- Microstructure candidates deduplicate within one observation window, remain bounded in memory and never enter the durable price-alert, Telegram or order-execution paths.
- Crosshair/drawing redraws must not recompute unchanged indicators.
- Crosshair-only movement paints the transparent interaction canvas without clearing or repainting the base canvas.
- Primary-series, indicator and drawing/strategy passes use separate transparent canvases and reuse one prepared viewport/indicator plan.
- Renderers do not fetch data or write browser storage.
- Late artifact-overlay results for an obsolete market, timeframe or request never replace current chart state.

## Testing

Use pure tests for transforms and hit testing, recording-context tests for renderer commands, and a small Playwright screenshot suite across DPR, theme and representative datasets.

## Planned architecture

Split the engine into dirty render layers: axes/grid, primary series, indicators, drawings/strategy overlays and interaction/crosshair. Heavy calculations expose worker-compatible pure functions.
