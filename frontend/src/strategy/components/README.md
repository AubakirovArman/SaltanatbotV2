# Strategy UI components

Feature-owned Strategy Lab panels live here.

- `StrategyLibrary.tsx` owns artifact selection, file import/export, Pine import entry and the template gallery.
- `OptimizePanel.tsx` owns parameter-axis controls and optimizer/walk-forward result rendering.
- Panels receive the root `Locale` explicitly and resolve typed copy through `src/i18n/strategy.ts`; do not add hardcoded user-facing labels here.

The main Lab remains responsible for Blockly workspace orchestration until build, research and optimizer controllers are extracted.
