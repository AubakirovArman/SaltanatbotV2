# Strategy UI components

Feature-owned Strategy Lab panels live here.

- `StrategyLibrary.tsx` owns artifact selection, reviewed file import/export, Pine import entry and the template gallery.
- `PwaFileLaunchDialog.tsx` shows the metadata-only installed-app launch boundary;
  `StrategyFileReviewDialog.tsx` confirms a parsed checksummed artifact before library mutation.
- `OptimizePanel.tsx` owns parameter-axis controls and optimizer/walk-forward result rendering.
- Panels receive the root `Locale` explicitly and resolve typed copy through `src/i18n/strategy.ts`; do not add hardcoded user-facing labels here.

The main Lab remains responsible for Blockly workspace orchestration until build, research and optimizer controllers are extracted.
