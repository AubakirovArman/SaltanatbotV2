# Chart domain

The chart domain owns coordinate systems, viewport state, indicator calculations, drawings and Canvas rendering.

## Public surface

- `ChartEngine.ts`: current rendering facade.
- `types.ts`: chart render models.
- `viewport.ts` and `scales.ts`: coordinate transforms.
- `drawings.ts` and `objects/`: drawing behavior and hit testing.
- `renderers/`: primitive rendering layers.
- `useChartArtifactOverlay.ts`: cancellable artifact compilation, external-series loading, preview/backtest overlay state, input overrides and chart focus.

## Invariants

- Candle time order is ascending.
- Time/price coordinate transforms remain reversible within rendering precision.
- Pointer-only behavior must have a documented keyboard or UI alternative.
- Crosshair/drawing redraws must not recompute unchanged indicators.
- Renderers do not fetch data or write browser storage.
- Late artifact-overlay results for an obsolete market, timeframe or request never replace current chart state.

## Testing

Use pure tests for transforms and hit testing, recording-context tests for renderer commands, and a small Playwright screenshot suite across DPR, theme and representative datasets.

## Planned architecture

Split the engine into dirty render layers: axes/grid, primary series, indicators, drawings/strategy overlays and interaction/crosshair. Heavy calculations expose worker-compatible pure functions.
