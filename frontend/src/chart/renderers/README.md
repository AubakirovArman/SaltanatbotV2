# Chart renderers

Renderers translate prepared chart models into Canvas 2D drawing commands.

`footprintInsights.ts` paints precomputed imbalance outlines, boundary-aware stack brackets and offset `ABS?` markers. Detection thresholds remain in `../footprintInsights.ts`; this renderer contains no signal logic.

`anchoredVwap.ts` receives already prepared cumulative points from `../anchoredVwap.ts`; it only paints the anchor guide, value area, deviation lines and latest label.

`marketSessions.ts` paints already grouped regional high/low ranges before the primary price series. Time-zone conversion and DST rules remain in `../marketSessions.ts`.

`marketStructure.ts` has two explicit entry points: FVG rectangles paint behind price, while confirmed swing and BOS/CHOCH marks paint in the overlay. Detection remains in `../marketStructure.ts`.

`lineBreak.ts` paints prepared close-to-close bodies only. Reversal rules, live-tail exclusion and source-volume aggregation remain in `../lineBreak.ts`.

`renko.ts` paints prepared synthetic brick bodies plus actual-close wicks. Box sizing, two-box reversal, volume allocation and confirmation rules remain in `../renko.ts`.

`kagi.ts` paints prepared directional legs, horizontal shoulder/waist turns and confirmed endpoints. Reversal sizing, close confirmation and source-volume aggregation remain in `../kagi.ts`.

`pointAndFigure.ts` paints X diagonals and O circles for each prepared box. Fixed box construction, alternating columns, reversal confirmation and volume aggregation remain in `../pointAndFigure.ts`.

## Rules

- Renderers are deterministic for the same model, viewport and palette.
- They do not mutate application state, load data or calculate business indicators.
- Geometry preparation should be testable separately from Canvas calls.
- New renderers handle empty, NaN, clipped and extreme-value input safely.

## Adding a renderer

Define its typed input, isolate geometry, implement the drawing pass, add recording-context assertions and include one representative visual regression only when it adds distinct coverage.
