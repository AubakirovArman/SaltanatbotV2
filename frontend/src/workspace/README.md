# Workspace domain

This folder owns portable chart-workspace state. It does not render React UI.

`workspaces.ts` defines schema v3 for:

- one, vertical-split, horizontal-split and four-chart layouts;
- independently linked symbol, timeframe, crosshair and absolute visible-time-range settings;
- side-panel visibility, size and dock order;
- enabled indicators, exchange and theme;
- bounded immutable autosave revisions and rollback;
- SHA-256 verified `.saltanat-workspace.json` export/import.

Legacy localStorage snapshots are normalized at the boundary. Keep migrations in
`normalizeWorkspace`; UI components must not parse persisted JSON directly.

Tests live in `frontend/tests/workspaces.test.ts`.
