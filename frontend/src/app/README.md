# Application shell

This folder owns top-level browser-shell state that spans Chart, Strategy and Trade workspaces.

- `useAppShell.ts` owns persisted theme, locale, panels, exchange, named workspaces and compare-overlay configuration.
- `useAppCommands.ts` owns command construction, command-palette state and global keyboard shortcuts.
- `shortcuts.ts` supplies backward-compatible defaults for pane cycling (`Alt+K` / `Alt+J`) and maximize (`Alt+Enter`); the workspace consumes pane-local bindings only outside text editing and modal contexts.
- `chartSession.ts` owns the bounded v4 last-session snapshot for chart layout and pane configuration, including explicit chart-type links; it is separate from named workspace history, migrates v1–v3 independence and fails closed on corrupt/future data.
- `distinctMarkets.ts` deterministically keeps the primary market, prefers familiar available cross-exchange majors and fills from the live crypto catalog without duplicates.
- `shellStorage.ts` owns tolerant storage reads and legacy compare-overlay migration.

Feature execution, chart rendering, strategy artifacts and trading lifecycle must remain in their feature folders.
