# Application shell

This folder owns top-level browser-shell state that spans Chart, Strategy and Trade workspaces.

- `useAppShell.ts` owns persisted theme, locale, panels, exchange, named workspaces and compare-overlay configuration.
- `useAppCommands.ts` owns command construction, command-palette state and global keyboard shortcuts.
- `shellStorage.ts` owns tolerant storage reads and legacy compare-overlay migration.

Feature execution, chart rendering, strategy artifacts and trading lifecycle must remain in their feature folders.
