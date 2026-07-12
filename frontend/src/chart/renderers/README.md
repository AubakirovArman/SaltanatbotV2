# Chart renderers

Renderers translate prepared chart models into Canvas 2D drawing commands.

`footprintInsights.ts` paints precomputed imbalance outlines, boundary-aware stack brackets and offset `ABS?` markers. Detection thresholds remain in `../footprintInsights.ts`; this renderer contains no signal logic.

## Rules

- Renderers are deterministic for the same model, viewport and palette.
- They do not mutate application state, load data or calculate business indicators.
- Geometry preparation should be testable separately from Canvas calls.
- New renderers handle empty, NaN, clipped and extreme-value input safely.

## Adding a renderer

Define its typed input, isolate geometry, implement the drawing pass, add recording-context assertions and include one representative visual regression only when it adds distinct coverage.
