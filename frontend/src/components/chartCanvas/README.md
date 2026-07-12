# Chart Canvas composition

This directory owns focused presentation and interaction helpers behind the stable
`../ChartCanvas.tsx` facade.

- `ChartDrawingToolbar.tsx` renders keyboard-addressable drawing tools.
- `ChartLegend.tsx` owns the visual symbol/OHLC/volume legend, keeping the Canvas coordinator below its enforced module budget.
- `QuickMeasureSummary.tsx` exposes the transient Shift-drag ruler as localized DOM output without announcing every pointer frame.
- `StrategyChip.tsx` owns the active strategy name, counts and compact settings/removal actions.
- `useLinkedTimeRange.ts` maps external UTC boundaries into local zoom/offset and suppresses republishing externally applied views, preventing multi-pane feedback loops.
- `usePersistentDrawings.ts` atomically changes pane/symbol drawing scopes and flushes the departing snapshot so rapid symbol changes cannot cross-contaminate storage.
- `PriceAxisControl.tsx` is the focusable semantic slider over the right axis; it contains wheel events and normalizes pointer/keyboard gestures to the bounded `priceZoom` model.
- `PriceRepresentationControl.tsx` owns labelled construction inputs and an atomic pane+symbol settings hook; scoped custom/storage events cannot mutate a sibling chart instance.
- `DrawingMenus.tsx` owns selected-object style and context controls.
- `ChartOverlays.tsx` owns accessible metric tables and artifact inputs.
- `drawingInteraction.ts` contains pure anchor, movement, legend and formatting helpers.
- `types.ts` is the public prop contract of the facade.
- `OrderBookHeatmapLayer.tsx` owns the isolated real-depth Canvas and lifecycle.
- `TradeFootprintLayer.tsx` owns the isolated public-print footprint/CVD/cluster Canvas, throttled semantic insight summary and visibility-aware stream suspension.
- `TradeFlowAlertCenter.tsx` owns the keyboard-operable bounded event feed and native disclosure settings; it is a sibling above the interaction Canvas so controls remain clickable without raising the render layer.
- `AnchoredVwapLegend.tsx` exposes every visible AVWAP's anchor, current value and deviation as ordinary localized DOM text.
- `SessionLiquidityLayer.tsx` owns accessible UTC/session and market-structure controls plus bounded semantic summaries; prepared sessions, FVGs, swings and breaks remain in dedicated Canvas passes.

Rendering and viewport state remain in `chart/`; these components must not recalculate indicators or
own market transport. Preserve Canvas DOM alternatives, localized labels and render-layer isolation.

For price-compressed representations, `useChartRenderer` returns the same prepared candle sequence used by Canvas so pointer snapping, the crosshair HUD and `ChartDataPanel` expose the transformed OHLC rather than unrelated source-bar indices.
