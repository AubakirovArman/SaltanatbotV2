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
- `sessionLiquidity.ts` and `renderers/sessionLiquidity.ts`: pure UTC-session OHLCV/VWAP/deviation/sweep analysis and its Canvas primitives.
- `anchoredVwap.ts` and `renderers/anchoredVwap.ts`: fail-closed cumulative AVWAP study preparation and render-only band/line geometry.
- `marketSessions.ts` and `renderers/marketSessions.ts`: cached IANA-time-zone membership/range preparation and behind-price session-box rendering.
- `marketStructure.ts` and `renderers/marketStructure.ts`: closed-candle swing/BOS/CHOCH/FVG analysis with separately composed background and overlay passes.
- `confirmedCandles.ts`: canonical provisional-tail exclusion shared by confirmed price transforms and market-structure analysis.
- `priceRepresentation.ts`: one full-history preparation boundary for Heikin Ashi, Renko, Three Line Break, Kagi and Point & Figure, shared by Canvas and semantic/pointer consumers.
- `priceRepresentationSettings.ts` and `components/chartCanvas/PriceRepresentationControl.tsx`: clamped local persistence, pane/tab synchronization and a native accessible construction control for Renko/Kagi/P&F percentages, Line Break depth and P&F reversal boxes.
- `lineBreak.ts` and `renderers/lineBreak.ts`: confirmed close-only Three Line Break transformation, source-volume aggregation and body-only rendering.
- `renko.ts` and `renderers/renko.ts`: fixed seeded box construction, two-box reversals, actual close-wicks, source-volume allocation and render-only brick geometry.
- `kagi.ts` and `renderers/kagi.ts`: fixed seeded percentage reversals, compressed directional legs, aggregated source volume and shoulder/waist line geometry.
- `pointAndFigure.ts` and `renderers/pointAndFigure.ts`: fixed seeded boxes, alternating confirmed X/O columns, multi-box reversals, aggregated source volume and glyph-only geometry.
- `../components/chartCanvas/SessionLiquidityLayer.tsx`: independently scheduled session overlay, persisted semantic toggle and authoritative PDH/PDL daily-candle request.
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
- Session VWAP is a volume-weighted typical-price estimate from bars, not tick VWAP. A live tail cannot produce a confirmed previous-day liquidity sweep.
- Anchored VWAP never substitutes the earliest loaded candle for a missing saved anchor; it remains unavailable until history reaches that anchor.
- Regional session windows use candle-open membership and are limited to 1m–1h; they do not claim exchange-calendar or holiday awareness.
- Market structure never consumes the provisional tail: a swing waits for its full right-hand window, BOS/CHOCH requires a close through the confirmed level and an FVG requires three closed candles.
- Three Line Break ignores source High/Low, omits the provisional tail and requires a strict break of the latest three confirmed line ranges to reverse; native indicators use the transformed series while timestamped strategy overlays remain aligned to their source bars.
- Renko uses a close-only box fixed at 0.05% of the first loaded confirmed close and rounded to the instrument tick. New live bars cannot resize history; intentionally loading older history changes the source boundary and can reseed the representation.
- Renko reversal requires two boxes, projection bricks are omitted, multiple bricks may share one honest source timestamp and their allocated volumes sum to the contributing source volume. Its wicks use only discarded source closes.
- Kagi uses a close-only reversal fixed at 0.10% of the first loaded confirmed close. It extends only at new directional extremes, starts a new column at a confirmed reversal, aggregates skipped source volume and omits the provisional projection.
- The documented Renko `0.05%`, Kagi `0.10%` and Line Break `3` values are defaults. User changes are constrained to `0.01–10%` or `1–10` lines and rebuild the full loaded representation; source candles used by Strategy Lab/backtest remain unchanged.
- Point & Figure defaults to `0.10% × 3`; both box percentage and reversal count are constrained and persisted. The live source tail/projected column is omitted, and the fixed first-price seed avoids retroactive LTP resizing.
- `components/chartCanvas/useChartNavigation.ts` owns non-passive wheel containment and testable mouse/trackpad intent: vertical gestures zoom proportionally under the pointer, horizontal gestures pan, browser pinch is normalized and sub-threshold inertia is discarded.
- Heikin Ashi is seeded once from full loaded history before viewport slicing, so zoom and pan never change the same bar's transformed OHLC.
- Viewport time/index conversion maps every loaded timestamp exactly, interpolates inside irregular gaps and uses median duration only beyond loaded edges.
- Crosshair/drawing redraws must not recompute unchanged indicators.
- Crosshair-only movement paints the transparent interaction canvas without clearing or repainting the base canvas.
- Primary-series, indicator and drawing/strategy passes use separate transparent canvases and reuse one prepared viewport/indicator plan.
- Renderers do not fetch data or write browser storage.
- Late artifact-overlay results for an obsolete market, timeframe or request never replace current chart state.

## Testing

Use pure tests for transforms and hit testing, recording-context tests for renderer commands, and a small Playwright screenshot suite across DPR, theme and representative datasets.

## Planned architecture

Split the engine into dirty render layers: axes/grid, primary series, indicators, drawings/strategy overlays and interaction/crosshair. Heavy calculations expose worker-compatible pure functions.
