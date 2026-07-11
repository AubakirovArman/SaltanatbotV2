# Chart Canvas composition

This directory owns focused presentation and interaction helpers behind the stable
`../ChartCanvas.tsx` facade.

- `ChartDrawingToolbar.tsx` renders keyboard-addressable drawing tools.
- `DrawingMenus.tsx` owns selected-object style and context controls.
- `ChartOverlays.tsx` owns accessible metric tables and artifact inputs.
- `drawingInteraction.ts` contains pure anchor, movement, legend and formatting helpers.
- `types.ts` is the public prop contract of the facade.

Rendering and viewport state remain in `chart/`; these components must not recalculate indicators or
own market transport. Preserve Canvas DOM alternatives, localized labels and render-layer isolation.
